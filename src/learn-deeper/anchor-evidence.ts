import { langOf } from "../file-index/classify.js";
import { globPrefix, globToRegExp } from "../file-index/glob.js";
import { hasSecret } from "../knowledge/gates.js";
import type { ProposedCheck } from "../knowledge/gate.js";
import { readGitHub, readGitLab } from "../repo-start/recipes/ci.js";
import { readNode, scriptCommand } from "../repo-start/recipes/node.js";
import { makeTargets, readCargo, readGradle, readPython } from "../repo-start/recipes/other.js";
import { pointer, record, RepoFiles } from "../repo-start/recipes/source.js";
import type { AnchorDraft } from "./anchors.js";
import { repoPath, type PinnedTree } from "./git.js";

export const MAX_SCOPE_FILES = 12;
const MAX_SYMBOLS = 6;
const identifier = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,5}$/u;
const prose = /\.(?:mdx?|rst|adoc|asciidoc|txt)$/iu;
const nonCode = /(?:^|\/)(?:readme|license|changelog|copying|notice)$|\.(?:png|jpe?g|gif|webp|ico|svg|pdf|zip|woff2?|lock)$/iu;

export function codePath(path: string): boolean {
  return repoPath(path) && !prose.test(path) && !nonCode.test(path) && !hasSecret(path);
}

export function scopePattern(scope: string): { glob: string; match: RegExp } | undefined {
  const glob = scope.endsWith("/") ? scope + "**" : scope;
  if (!/[a-z\d]/iu.test(globPrefix(glob)) || !/^[a-z0-9_./@?*,-]+$/iu.test(glob)
    || !repoPath(glob.replace(/[?*]/gu, "_")) || hasSecret(glob)) return undefined;
  return { glob, match: globToRegExp(glob) };
}

/** A prose mention must have token boundaries; for example build matches neither rebuild nor build-all. */
function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^$(){}|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![\\w./-])${escaped}(?![\\w/-]|\\.[\\w/])`, "u").test(text);
}

function markedSymbols(text: string): string[] {
  const names = [
    ...[...text.matchAll(/\x60([^\x60\r\n]{2,80})\x60/gu)].map(match => match[1]!.trim().replace(/\(\)$/u, "")),
    ...[...text.matchAll(/\b([A-Za-z_][\w.]{1,79})\s*\(\)/gu)].map(match => match[1]!),
    ...[...text.matchAll(/\b(?:function|class|method|symbol)\s+([A-Za-z_][\w.]{1,79})/gu)].map(match => match[1]!),
    ...[...text.matchAll(/(?<![\w./-])(?:[a-z]+[A-Z][\w$]*|[a-z][a-z\d]*_[a-z\d_]+)(?![\w./-])/gu)].map(match => match[0]),
  ];
  return names.filter(name => name.length <= 80 && identifier.test(name) && !hasSecret(name));
}

type Scope = { glob: string; files: string[] };
export interface AnchorEvidence {
  docs: string[];
  scopes: Scope[];
  quotedPaths: Set<string>;
  symbols: Array<{ name: string; quoted: boolean }>;
  cites: (name: string) => boolean;
  supports: (name: string) => boolean;
}

export function anchorEvidence(draft: AnchorDraft, tree: PinnedTree): AnchorEvidence {
  const docs = new Set<string>(), namedDocs = new Set<string>(), quotedPaths = new Set<string>();
  const scopes = new Map<string, Scope>();
  const quote = draft.citations.map(item => item.quote).join("\n");
  const bodies = [...new Set(draft.citations.map(item => item.source.text))].join("\n");
  const claim = draft.proposal.text + "\n" + (draft.proposal.oneLine ?? "");
  const cites = (name: string) => mentions(quote, name);
  const supports = (name: string) => cites(name) || (mentions(claim, name) && mentions(bodies, name));
  const add = (name: string, cited: boolean) => {
    const pattern = scopePattern(name.replace(/^\.\//u, "").replace(/[.,]+$/u, ""));
    if (!pattern) return;
    const { glob, match } = pattern;
    if (tree.has(glob) && prose.test(glob)) { namedDocs.add(glob); return; }
    if (scopes.size >= MAX_SCOPE_FILES && !scopes.has(glob)) return;
    const files = tree.has(glob) && codePath(glob) ? [glob] : [];
    if (!files.length && /[*?]/u.test(glob)) for (const path of tree.paths()) {
      if (codePath(path) && match.test(path)) files.push(path);
      if (files.length >= MAX_SCOPE_FILES) break;
    }
    if (!files.length) return;
    scopes.set(glob, { glob, files });
    if (cited) for (const file of files) quotedPaths.add(file);
  };

  for (const { source } of draft.citations) {
    if (source.kind === "docs" && tree.has(source.path)) docs.add(source.path);
    if (source.kind !== "review" || !source.writer) continue;
    if (source.path && tree.has(source.path)) add(source.path, true);
    for (const path of source.changedPaths ?? []) if (tree.has(path)) add(path, true);
  }
  for (const match of quote.matchAll(/[\w.@/*?-]+/gu)) add(match[0], true);
  // Broad source bodies can mention many unrelated files. Require the claim
  // to name a target again when it comes from outside the cited quote.
  for (const match of bodies.matchAll(/[\w.@/*?-]+/gu)) {
    const name = match[0].replace(/[.,]+$/u, "");
    if ((tree.has(name.replace(/^\.\//u, "")) || /[*?]|\/$/u.test(name)) && mentions(claim, name)) add(name, false);
  }
  const symbols = new Set(markedSymbols(quote));
  for (const symbol of markedSymbols(bodies)) if (supports(symbol)) symbols.add(symbol);
  for (const check of draft.proposal.checks ?? []) {
    if (check.kind === "symbol" && identifier.test(check.target.symbol) && supports(check.target.symbol)) symbols.add(check.target.symbol);
  }
  return { docs: [...(namedDocs.size ? namedDocs : docs)].slice(0, MAX_SCOPE_FILES), scopes: [...scopes.values()], quotedPaths, cites, supports,
    symbols: [...symbols].slice(0, MAX_SYMBOLS).map(name => ({ name, quoted: cites(name) })) };
}

type CommandCheck = Extract<ProposedCheck, { kind: "command" }>;
type DeclaredCommand = { check: CommandCheck; script?: string };
const scriptName = /^(?!-)[\w.@:/+-]{1,100}$/u;

export function declaredCommands(root: string): DeclaredCommand[] {
  const files = new RepoFiles(root);
  const node = readNode(files);
  const python = readPython(files), cargo = readCargo(files), gradle = readGradle(files);
  const commands = new Map<string, DeclaredCommand>();
  const add = (run: string, file: string, at: string, script?: string) => {
    if (commands.size >= 1024 || run.length > 512 || hasSecret(run) || /[\p{Cc}\p{Cf}]/u.test(run)) return;
    const check: CommandCheck = { kind: "command", role: "supporting", target: { run, file, pointer: at } };
    commands.set(JSON.stringify(check.target), { check, script });
  };
  for (const pkg of node.packages) {
    if (!node.manager) continue;
    const file = pkg.path ? pkg.path + "/package.json" : "package.json";
    const scripts = record(files.json(file)?.scripts);
    for (const [name, body] of Object.entries(scripts ?? {})) {
      if (!scriptName.test(name) || typeof body !== "string" || !body.trim()) continue;
      const at = pointer("scripts", name);
      add(scriptCommand(node.manager, name, pkg), file, at, name);
      // Lockfile-only manager selection may be absent in the bounded staging
      // tree. These aliases still target this exact declared root script.
      if (!pkg.path) {
        for (const manager of ["npm", "pnpm", "yarn", "bun"] as const) {
          if (manager !== node.manager) add(scriptCommand(manager, name, pkg), file, at);
        }
        if (["test", "start", "stop", "restart"].includes(name)) add("npm " + name, file, at);
        add("pnpm " + name, file, at);
        add("yarn " + name, file, at);
      }
    }
  }
  const make = ["Makefile", "makefile", "GNUmakefile"].find(file => files.isFile(file));
  if (make) for (const target of makeTargets(files.read(make) ?? "")) {
    if (/^[\w][\w./-]{0,100}$/u.test(target)) add("make " + target, make, pointer(target));
  }
  const packages = [...node.packages, ...python.packages, ...cargo.packages, ...gradle.packages];
  for (const recipe of [...python.found, ...cargo.found, ...gradle.found, ...readGitHub(files, packages), ...readGitLab(files, packages)]) {
    if (recipe.local !== "yes") continue;
    for (const { kind, target } of recipe.checks) {
      if (kind === "command" && typeof target.run === "string" && typeof target.file === "string" && typeof target.pointer === "string") {
        add(target.run, target.file, target.pointer);
      }
    }
  }
  return [...commands.values()];
}

export function codeSymbolFile(path: string): boolean { return codePath(path) && langOf(path) !== "other"; }
