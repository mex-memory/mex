import { execFile } from "node:child_process";
import { posix } from "node:path";
import { backgroundEnvironment } from "../filter/environment.js";
import { GENERATED_MARK, ruleFormat } from "../knowledge/rule-files.js";
import type { PinnedTree } from "./git.js";
import { excerpt, safePath, safeRaw } from "./harvest/evidence.js";
import type { GateRule } from "./norm-gate.js";

const MAX_NAMES = 8;
const MAX_NEEDLES = 512;
const MAX_SITES = 3;
const MAX_SITE_READS = 80;
const MAX_GLOB_CHECKS = 128_000;
const READ_CONCURRENCY = 6;

const MANIFEST = /^(?:package\.json|pnpm-workspace\.ya?ml|pyproject\.toml|setup\.(?:cfg|py)|requirements(?:[-.][\w-]+)?\.txt|pipfile|cargo\.toml|go\.(?:mod|work)|pom\.xml|(?:build|settings)\.gradle(?:\.kts)?|libs\.versions\.toml|gradle(?:-wrapper)?\.properties|gemfile|composer\.json|mix\.exs|deno\.jsonc?|makefile|gnumakefile|justfile|cmakelists\.txt|\.tool-versions|\.nvmrc|\.python-version|rust-toolchain(?:\.toml)?)$/iu;
const LOCK = /^(?:package-lock\.json|npm-shrinkwrap\.json|(?:yarn|bun|uv|poetry|pdm|pipfile|cargo|composer|deno|gemfile|mix)\.lock|bun\.lockb|pnpm-lock\.ya?ml|go\.(?:sum|work\.sum)|gradle\.lockfile)$/iu;
const CONFIG = /^(?:\.?(?:eslint|eslintrc|biome|prettier|prettierrc|ruff|flake8|black|isort|mypy|clippy|rustfmt|golangci|rubocop|stylelint|stylelintrc|pylint|pylintrc|oxlint|oxfmtrc)(?:[.-].*)?|(?:js|ts)config(?:[.-].+)?\.json|\.editorconfig|deny\.toml|tox\.ini|\.pre-commit-config\.ya?ml|\.?checkstyle(?:[.-].*)?|php(?:stan|cs|csfixer)[.-].*)$/iu;
const CI = /^\.github\/workflows\/[^/]+\.ya?ml$/iu;
const OUTPUT = /(?:^|\/)(?:build|dist|target|out|_build|generated|site)(?:\/|$)/iu;
const LIB_OUTPUT = /(?:["']?(?:outDir|outputDir|declarationDir|destinationDir)["']?\s*[:=]\s*["'](?:\.\/)?lib(?:[/"'])|(?:^|\s)(?:--out-?dir[= ]|--output[= ]|-o\s+)(?:\.\/)?lib(?:[/"'\s]|$))/iu;
const PATH_SUFFIX = /\.(?:[cm]?[jt]sx?|pyi?|rs|go|kt|kts|java|cs|cpp|cc|h|hpp|mdx?|rst|txt|toml|ya?ml|jsonc?|cfg|ini|xml|gradle|sh|ps1|rb|php|vue|svelte|css|scss|html|sql|snap|proto|lock|sum)$/iu;
const GLOB = /[*?\[]|\{[^{}]*,[^{}]*\}/u;
const PRIVATE_PATH = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|[^/]+\.(?:pem|key|p12|pfx))$/iu;

export interface EvidenceLine { line: number; text: string }
export interface EvidenceFile { path: string; lines: EvidenceLine[] }
type Status = "found" | "NOT FOUND" | "build output" | "unchecked";
interface NamedEvidence { name: string; status: Status; sites: EvidenceFile[] }

export interface GateEvidence {
  manifests: EvidenceFile[];
  configs: EvidenceFile[];
  workflows: EvidenceFile[];
  instructions: EvidenceFile[];
  earlier: { id: string; claim: string }[];
  drafts: { id: string; claim: string; scope: string[] }[];
  named: ReadonlyMap<string, NamedEvidence[]>;
  /** The agent defaults every agent here already gets, when the setting is on. */
  defaults?: readonly string[];
}

/**
 * Agent instruction files are what a learned rule must not repeat, so the gate reads them whole: a long AGENTS.md
 * keeps its key commands well past the first screen.
 */
const INSTRUCTION_LINES = 400, INSTRUCTION_BYTES = 24_000;

function instructionPath(path: string): boolean {
  return !!ruleFormat(path) || /^\.cursor\/rules\//iu.test(path)
    || /(?:^|\/)(?:agents(?:\.override)?|claude(?:\.local)?|gemini)\.md$|^\.github\/copilot-instructions\.md$/iu.test(path);
}

function linesOf(raw: string, instructions: boolean): string[] | undefined {
  const safe = safeRaw(raw);
  if (safe === undefined) return undefined;
  const lines = safe.split(/\r?\n/u);
  if (!instructions) return lines;
  if (lines.some(line => {
    const text = line.trimStart();
    return text.startsWith(GENERATED_MARK) && /^[\s-]/u.test(text.slice(GENERATED_MARK.length));
  })) return undefined;
  const starts = new Set<string>();
  return lines.map(line => {
    const before = starts.size;
    let marker = false;
    for (const match of line.matchAll(/<!--\s*((?:mex-agent:[\w-]+|mex:[\w-]+|mex-(?:anchor|setup|defaults))):(start|end)\s*-->/gu)) {
      marker = true;
      if (match[2] === "start") starts.add(match[1]);
      else starts.delete(match[1]);
    }
    return before || starts.size || marker ? "" : line;
  });
}

function cleanPath(name: string): string {
  return name.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/{2,}/gu, "/");
}

function branchNames(text: string): string[] {
  const prose = text.replace(/\x60/gu, "");
  return [...prose.matchAll(/\bbranch\s+(?:to\s+)?([\w./-]+)\b/gu), ...prose.matchAll(/\b([\w./-]+)\s+branch\b/gu)]
    .map(match => match[1].replace(/\.+$/u, ""))
    .filter(name => !/^(?:a|the|this|that|target|default|release|current|each|name)$/iu.test(name));
}

function namesOf(rule: GateRule, text: string, branches: string[]): string[] {
  const spans = [...text.matchAll(/\x60([^\x60\r\n]{1,180})\x60/gu)].map(match => match[1]);
  const prose = text.replace(/\x60[^\x60\r\n]*\x60/gu, " ");
  const paths = [...prose.matchAll(/(?:^|[\s("'=])((?:[\w.@*-]+[/\\])+[\w.@*?{},\[\]-]*|[\w.*?-]+\.[A-Za-z][\w.-]*)(?=[\s)"',;:]|$)/gu)]
    .map(match => match[1]).filter(name => /[/\\]/u.test(name) || PATH_SUFFIX.test(name));
  const commands = [...prose.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:-]+|\b(?:go|cargo|git|make|ruff|uv|pip|python3?)\s+[\w:-]+/gu)]
    .map(match => match[0]);
  const options = [...text.matchAll(/(?<![\w-])--[\w][\w-]*/gu)].map(match => match[0]);
  const words = [...prose.matchAll(/\bv?\d+(?:\.\d+){1,3}(?:-[\w.-]+)?\b|\b[a-z][a-z0-9]*[A-Z]\w*\b|\b[A-Z][a-z0-9]+[A-Z]\w*\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/gu)]
    .map(match => match[0]);
  const extracted = rule.names ?? [...spans, ...paths, ...options, ...commands, ...words, ...branches];
  const unique = new Map<string, string>();
  for (const value of [...extracted.slice(0, 40), ...rule.scope.slice(0, MAX_NAMES)]) {
    const name = value.trim().replace(/^['"]|['"]$/gu, "").replace(/[.,;:]+$/u, "").replace(/^(--[\w-]+)=\S+$/u, "$1");
    if (!name || name === "**" || name.length > 180 || /[\u0000-\u001f\u007f]/u.test(name) || safeRaw(name) !== name) continue;
    const key = cleanPath(name).toLowerCase();
    if (!unique.has(key)) unique.set(key, name);
  }
  return [...unique.values()].slice(0, MAX_NAMES);
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const byDepth = (a: string, b: string) => a.split("/").length - b.split("/").length || compare(a, b);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

function fileLines(lines: string[], indexes: Iterable<number>, take: number, width = 200): EvidenceLine[] {
  return [...new Set(indexes)].sort((a, b) => a - b).filter(i => lines[i]?.trim()).slice(0, take)
    .map(i => ({ line: i + 1, text: excerpt(lines[i]!.trim(), width) }));
}

function headerLines(lines: string[], count: number): EvidenceLine[] {
  return fileLines(lines, lines.keys(), count);
}

function manifestLines(path: string, lines: string[]): EvidenceLine[] {
  if (/(?:^|\/)(?:pyproject\.toml|setup\.cfg)$/iu.test(path)) {
    const selected: number[] = [];
    let toolLines = 0;
    for (const [i, line] of lines.entries()) {
      if (/^\s*\[/u.test(line)) {
        toolLines = /^\s*\[(?:tool\.)?(?:ruff|black|isort|mypy|flake8)(?:[.\]-])/iu.test(line) ? 6 : 0;
      }
      if (toolLines > 0 && line.trim()) {
        selected.push(i);
        toolLines--;
      } else if (/^\s*(?:requires-python|python_requires|version)\s*=/iu.test(line)) selected.push(i);
    }
    return selected.length ? fileLines(lines, selected, 32) : headerLines(lines, 32);
  }
  if (!/(?:^|\/)package\.json$/iu.test(path)) return headerLines(lines, 32);
  const selected: number[] = [];
  let inSection = false;
  for (const [i, line] of lines.entries()) {
    if (!inSection && /^\s*"(?:name|version|packageManager|engines|scripts|workspaces|main|module|types|files|eslintConfig|prettier)"\s*:/u.test(line)) {
      selected.push(i);
      inSection = /[{\[]\s*$/u.test(line);
    } else if (inSection) {
      selected.push(i);
      if (/^\s*[}\]],?\s*$/u.test(line)) inSection = false;
    }
  }
  return selected.length ? fileLines(lines, selected, 32, 420) : headerLines(lines, 16);
}

function workflowLines(lines: string[]): EvidenceLine[] {
  const selected: number[] = [];
  let runIndent: number | undefined;
  for (const [i, line] of lines.entries()) {
    const indent = line.length - line.trimStart().length;
    if (runIndent !== undefined && line.trim() && indent <= runIndent) runIndent = undefined;
    if (/^name\s*:/u.test(line) || /^(?:-\s*)?["']?run["']?\s*:/u.test(line.trimStart())) {
      selected.push(i);
      if (/:\s*[|>](?:[+-]\d?|\d[+-]?)?(?:\s+#.*)?\s*$/u.test(line)) runIndent = indent + (line.trimStart().startsWith("-") ? 2 : 0);
    } else if (runIndent !== undefined && line.trim()) selected.push(i);
  }
  return fileLines(lines, selected, 32, 240);
}

function packFiles(files: EvidenceFile[], budget: number): EvidenceFile[] {
  const packed: EvidenceFile[] = [];
  let remaining = budget;
  for (const [i, file] of files.entries()) {
    const lines: EvidenceLine[] = [];
    const label = bytes({ path: file.path, lines }) + 1;
    if (label > remaining) break;
    const share = Math.max(400, Math.floor(remaining / (files.length - i)));
    let used = label;
    for (const line of file.lines) {
      if (used + bytes(line) + 1 > Math.min(remaining, share)) break;
      lines.push(line);
      used += bytes(line) + 1;
    }
    packed.push({ path: file.path, lines });
    remaining -= used;
  }
  return packed;
}

interface Resolution { paths: string[]; status: Status }
function pathResolver(paths: string[], libOutputs: ReadonlySet<string>): (name: string) => Resolution | undefined {
  const entries = paths.map(path => ({ path, key: path.toLowerCase() }))
    .sort((a, b) => compare(a.key, b.key) || compare(a.path, b.path));
  const exactPaths = new Set(paths);
  const byBase = new Map<string, string[]>();
  for (const path of [...paths].sort(byDepth)) {
    const key = posix.basename(path).toLowerCase();
    const names = byBase.get(key) ?? [];
    if (names.length < MAX_SITES) names.push(path);
    byBase.set(key, names);
  }
  function lowerBound(key: string): number {
    let lo = 0, hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (entries[mid]!.key < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  const cache = new Map<string, Resolution | undefined>();
  let checks = 0;
  function resolve(name: string): Resolution | undefined {
    const value = cleanPath(name);
    if (/^(?:[a-z]+:|\/)|(?:^|\/)\.\.(?:\/|$)/iu.test(value)) return undefined;
    const base = value.replace(/\/$/u, "");
    const key = base.toLowerCase();
    const glob = GLOB.test(base);
    const hits: string[] = [];
    if (glob) {
      const prefix = key.slice(0, key.search(/[*?[{]/u));
      for (let i = lowerBound(prefix); i < entries.length && entries[i]!.key.startsWith(prefix); i++) {
        if (++checks > MAX_GLOB_CHECKS) return hits.length ? { paths: hits, status: "found" } : { paths: [], status: "unchecked" };
        const candidate = entries[i]!;
        if (posix.matchesGlob(candidate.key, key)) hits.push(candidate.path);
        if (hits.length === MAX_SITES) break;
      }
    } else {
      const exact = entries[lowerBound(key)];
      if (!value.endsWith("/") && exact?.key === key) hits.push(exactPaths.has(base) ? base : exact.path);
      if (!hits.length) {
        const prefix = key + "/";
        for (let i = lowerBound(prefix); i < entries.length && entries[i]!.key.startsWith(prefix); i++) {
          hits.push(entries[i]!.path);
          if (hits.length === MAX_SITES) break;
        }
      }
      if (!hits.length && !value.includes("/")) hits.push(...byBase.get(key) ?? []);
    }
    if (hits.length) return { paths: hits, status: "found" };
    if (/\s/u.test(value) || value.startsWith("-")) return undefined;
    if (OUTPUT.test(base) || [...libOutputs].some(path => key === path || key.startsWith(path + "/"))) return { paths: [], status: "build output" };
    if (glob || /^(?:\.\/|[\w.@-]+[/\\])/u.test(name) || PATH_SUFFIX.test(value)) return { paths: [], status: "NOT FOUND" };
    return undefined;
  }
  return name => {
    if (!cache.has(name)) cache.set(name, resolve(name));
    return cache.get(name);
  };
}

function needlesFor(name: string): string[] {
  const value = name.replace(/\(\)$/u, "").toLowerCase();
  if (/^--[\w][\w-]*$/u.test(value)) {
    const key = value.slice(2);
    return [value, '"' + key + '"', "'" + key + "'"];
  }
  if (/^v?\d+\.\d+/u.test(value)) return [...new Set([value.replace(/^v/u, ""), "v" + value.replace(/^v/u, "")])];
  return value ? [value] : [];
}

interface Match { path: string; line: number }
interface Lookup { hits: Map<string, Match[]>; complete: boolean }
/** Grep the commit once. Only file and line coordinates survive this pass. */
async function lookupNames(tree: PinnedTree, needles: readonly string[]): Promise<Lookup> {
  const hits = new Map<string, Match[]>();
  if (!needles.length) return { hits, complete: true };
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tree.head)) return { hits, complete: false };
  const { output, complete } = await new Promise<{ output: string; complete: boolean }>(resolve => {
    const git = execFile("git", ["grep", "-n", "-z", "-I", "-i", "-F", "--no-textconv", "--full-name",
      "--threads=2", "-f", "-", tree.head, "--", ":(exclude,glob)**/*.lock", ":(exclude,glob)**/*-lock.*",
      ":(exclude,glob)**/*.min.js"],
    { cwd: tree.root, encoding: "utf8", windowsHide: true, maxBuffer: 2 << 20, timeout: 10_000,
      env: { ...backgroundEnvironment(), GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" } },
    (error, output) => resolve({ output, complete: !error || error.code === 1 }));
    git.stdin?.on("error", () => { /* execFile reports exit status */ });
    git.stdin?.end(needles.join("\n") + "\n");
  });
  const prefix = tree.head + ":";
  for (const row of output.split("\n")) {
    if (!row.startsWith(prefix)) continue;
    const [path, line, text] = row.slice(prefix.length).split("\0", 3);
    if (!path || !line || !text || !tree.has(path) || !safePath(path) || PRIVATE_PATH.test(path)) continue;
    const folded = text.toLowerCase();
    for (const key of needles) {
      const sites = hits.get(key);
      if ((sites?.length ?? 0) >= 10 || !containsNeedle(folded, key) || sites?.some(site => site.path === path)) continue;
      if (sites) sites.push({ path, line: Number(line) });
      else hits.set(key, [{ path, line: Number(line) }]);
    }
  }
  return { hits, complete };
}

function containsNeedle(text: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return false;
    const end = at + needle.length;
    const edge = /^v?\d/u.test(needle) ? /[\w.-]/u : /[\p{L}\p{N}_$-]/u;
    if (needle.startsWith('"') || needle.startsWith("'") || (!edge.test(text[at - 1] ?? "") && !edge.test(text[end] ?? ""))) return true;
    from = end;
  }
}

function compactEntries<T>(entries: readonly T[], budget: number): T[] {
  const result: T[] = [];
  for (const entry of entries) {
    budget -= bytes(entry) + 1;
    if (budget < 0) break;
    result.push(entry);
  }
  return result;
}

async function readGroups<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += READ_CONCURRENCY) {
    results.push(...await Promise.all(items.slice(i, i + READ_CONCURRENCY).map(read)));
  }
  return results;
}

export async function collectGateEvidence(tree: PinnedTree, rules: readonly GateRule[],
  earlier: readonly { id: string; claim: string }[] = []): Promise<GateEvidence> {
  const paths = [...tree.paths()].filter(path => safePath(path) && !PRIVATE_PATH.test(path));
  const ranked = [...paths].sort(byDepth);
  const cache = new Map<string, Promise<string[] | undefined>>();
  const read = (path: string) => {
    if (!cache.has(path)) cache.set(path, tree.read(path).then(raw => raw === undefined ? undefined : linesOf(raw, instructionPath(path))));
    return cache.get(path)!;
  };
  const manifests = ranked.filter(path => MANIFEST.test(posix.basename(path))).slice(0, 12);
  const locks = ranked.filter(path => LOCK.test(posix.basename(path))).slice(0, 12);
  const configs = ranked.filter(path => CONFIG.test(posix.basename(path))).slice(0, 12);
  const workflows = ranked.filter(path => CI.test(path)).slice(0, 12);
  const instructions = ranked.filter(instructionPath).slice(0, 12);
  await readGroups([...new Set([...manifests, ...configs, ...workflows, ...instructions])], read);

  const manifestFiles = await Promise.all(manifests.map(async path => ({ path, lines: manifestLines(path, await read(path) ?? []) })));
  const configFiles = await Promise.all(configs.map(async path => ({ path, lines: headerLines(await read(path) ?? [], 32) })));
  const workflowFiles = await Promise.all(workflows.map(async path => ({ path, lines: workflowLines(await read(path) ?? []) })));
  const instructionFiles = (await Promise.all(instructions.map(async path => ({ path, lines: headerLines(await read(path) ?? [], INSTRUCTION_LINES) }))))
    .filter(file => file.lines.length);
  const libOutputs = new Set([...manifestFiles, ...configFiles, ...workflowFiles].flatMap(({ path, lines }) =>
    lines.some(({ text }) => LIB_OUTPUT.test(text)) ? [posix.join(CI.test(path) ? "." : posix.dirname(path), "lib").toLowerCase()] : []));
  const resolvePath = pathResolver(paths, libOutputs);
  const requests = rules.map(rule => {
    const text = excerpt(safeRaw(rule.text) ?? "", 4_096);
    const branches = branchNames(text);
    const names = namesOf(rule, text, branches).map(name => ({ name, resolved: branches.includes(name) ? undefined : resolvePath(name) }));
    return { id: rule.id, names };
  });
  const needles = new Set([...new Set(requests.flatMap(({ names }) => names.flatMap(({ name, resolved }) => resolved ? [] : needlesFor(name))))].slice(0, MAX_NEEDLES));
  const lookup = await lookupNames(tree, [...needles]);

  const matches = new Map<string, Match[]>();
  for (const { names } of requests) {
    for (const { name, resolved } of names) {
      if (matches.has(name)) continue;
      const sites = resolved ? resolved.paths.map(path => ({ path, line: 1 }))
        : needlesFor(name).flatMap(key => lookup.hits.get(key) ?? []);
      matches.set(name, sites);
    }
  }
  // Prefer the first hit for each term before adding more usage sites.
  const sitesToRead = new Set<string>();
  for (let i = 0; i < MAX_SITES && sitesToRead.size < MAX_SITE_READS; i++) {
    for (const sites of matches.values()) {
      const path = sites[i]?.path;
      if (path && !cache.has(path)) sitesToRead.add(path);
      if (sitesToRead.size >= MAX_SITE_READS) break;
    }
  }
  await readGroups([...sitesToRead], read);
  const named = new Map<string, NamedEvidence[]>();
  for (const { id, names } of requests) {
    const items: NamedEvidence[] = [];
    for (const { name, resolved } of names) {
      const sites: EvidenceFile[] = [];
      const keys = needlesFor(name);
      const candidates = matches.get(name) ?? [];
      for (const { path, line } of candidates) {
        if (sites.some(site => site.path === path)) continue;
        const lines = await cache.get(path);
        if (resolved) {
          if (!instructionPath(path) || lines?.some(value => value.trim())) sites.push({ path, lines: headerLines(lines ?? [], sites.length ? 1 : 4) });
        } else if (lines) {
          const match = (value: string) => {
            const folded = value.toLowerCase();
            return keys.some(needle => containsNeedle(folded, needle));
          };
          const at = match(lines[line - 1] ?? "") ? line - 1 : lines.findIndex(match);
          if (at >= 0) sites.push({ path, lines: fileLines(lines, sites.length ? [at] : [at - 1, at, at + 1], 3, 180) });
        }
        if (sites.length === MAX_SITES) break;
      }
      const checked = lookup.complete && keys.length && keys.every(key => needles.has(key)) && !candidates.length;
      items.push({ name, status: resolved?.status ?? (sites.length ? "found" : checked ? "NOT FOUND" : "unchecked"), sites });
    }
    named.set(id, items);
  }

  return {
    manifests: packFiles([...locks.map(path => ({ path, lines: [] })), ...manifestFiles], 3_400),
    configs: packFiles(configFiles, 3_200),
    workflows: packFiles(workflowFiles, 3_600),
    instructions: packFiles(instructionFiles, INSTRUCTION_BYTES),
    earlier: compactEntries(earlier.slice(0, 200).flatMap(({ id, claim }) => {
      const safe = safeRaw(claim);
      return safe === undefined ? [] : [{ id: excerpt(id, 120), claim: excerpt(safe, 420) }];
    }), 2_400),
    drafts: compactEntries(rules.slice(0, 200).flatMap(({ id, text, scope }) => {
      const safe = safeRaw(text);
      return safe === undefined ? [] : [{ id: excerpt(id, 120), claim: excerpt(safe, 260), scope: scope.slice(0, 3).map(path => excerpt(path, 120)) }];
    }), 3_000),
    named,
  };
}

export function repositoryEvidence(evidence: GateEvidence): string {
  const { manifests, configs, workflows, instructions } = evidence;
  return JSON.stringify({ manifests, configs, workflows, instructions });
}

/** Every line was read from a regular blob in the revision shown to the model. */
export function evidenceFiles(evidence: GateEvidence, id: string): EvidenceFile[] {
  return [...evidence.manifests, ...evidence.configs, ...evidence.workflows, ...evidence.instructions,
    ...(evidence.named.get(id) ?? []).flatMap(item => item.sites)];
}
