import { lstatSync, opendirSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDocument } from "yaml";
import { absolutePath, realPath } from "../record/project.js";
import { KnowledgeError, KNOWLEDGE_LIMITS } from "./contract.js";
import { readBoundedTextFile } from "./files.js";
import { readNode } from "../repo-start/recipes/node.js";
import { makeTargets, readCargo, readGradle, readPython } from "../repo-start/recipes/other.js";
import { RepoFiles } from "../repo-start/recipes/source.js";

export interface References {
  root: string; commands: Set<string>; links: Set<string>;
  /** Package-script names from the root package and its workspaces. */
  scripts: Set<string>;
  /** Script names per package, keyed by package folder ("" for the root) and by package name. */
  packageScripts: Map<string, Set<string>>;
  /** A discovery bound was reached; anything not collected stays unverified. */
  truncated: boolean;
  /** Repo files MEX only reads and could not parse. They do not abort the caller. */
  gaps: string[];
  /**
   * Exact commands the capture journal saw pass here. Only the producer gate
   * sets this, for fail-pass proposals, from their own journal evidence.
   */
  exact?: ReadonlySet<string>;
}
export function repoFile(root: string, path: string): string | undefined {
  if (!path || /[\\\x00-\x1f]/u.test(path) || /^(?:\/|[A-Za-z]:)/u.test(path)) return undefined;
  const parts = path.replace(/^\.\//u, "").split("/");
  if (parts.some(p => !p || p === "." || p === "..")) return undefined;
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    let stat;
    try { stat = lstatSync(current); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())
      || realPath(current) !== absolutePath(current)) throw new KnowledgeError("UNSAFE_SOURCE", "A knowledge reference contains a redirected or non-regular path.");
  }
  return current;
}

/** Repository-owned sources only. Learned entries cannot attest to themselves. */
/** Discovery bounds. Reaching one stops collecting; it never fails the caller. */
export const REFERENCE_LIMITS = { files: 1024, paths: 4096, commands: 4096, scripts: 4096, links: 4096, depth: 8 } as const;
/** Package-script runners that a script name may be written with. */
const RUNNERS = /^(?:npm run|pnpm run|pnpm|yarn|yarn run|bun run|(?:pnpm|yarn)\s+(?:--filter|-F)[ =][\w@./*-]+(?:\s+run)?|yarn workspace [\w@./-]+(?:\s+run)?)\s+([^\s;&|<>$`]+)$/u;
/** npm's workspace flag, before or after the script name: `npm run -w <pkg> <script>`, `npm run <script> --workspace <pkg>`. */
const NPM_WORKSPACE = /^npm run (?:(?:-w|--workspace)(?:=|\s+)([\w@./-]+)\s+([^\s;&|<>$`-][^\s;&|<>$`]*)|([^\s;&|<>$`-][^\s;&|<>$`]*)\s+(?:-w|--workspace)(?:=|\s+)([\w@./-]+))$/u;
class Full extends Error {}

/**
 * Repository-owned sources only. Learned entries cannot attest to themselves.
 *
 * Every bound is enforced, but a large repository is normal, so reaching one
 * stops discovery (in priority order: package scripts, CI, docs, root files)
 * and marks the result `truncated` instead of failing. An unfound command or
 * link is treated as unverified and removed, so truncation can only make the
 * gates stricter. A link under docs or CI is skipped with a gap; other
 * redirected or linked sources still fail.
 */
/** Anchors in a workflow or repo config are ordinary YAML. An alias bomb stops at this count. */
const REPO_YAML_ALIASES = 100;

function repoYaml(text: string): { value: unknown; unreadable: boolean } {
  try {
    const doc = parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length) return { value: undefined, unreadable: false };
    return { value: doc.toJS({ maxAliasCount: REPO_YAML_ALIASES }), unreadable: false };
  } catch { return { value: undefined, unreadable: true }; }
}

export function references(root: string): References {
  const result: References = { root, commands: new Set(), links: new Set(), scripts: new Set(), packageScripts: new Map(), truncated: false, gaps: [] };
  let entries = 0, visited = 0, bytes = 0;
  const full = (): never => { result.truncated = true; throw new Full(); };
  const childrenOf = (path: string) => {
    const children: import("node:fs").Dirent[] = [];
    const handle = opendirSync(path);
    try {
      let child;
      while ((child = handle.readSync())) {
        if (++visited > REFERENCE_LIMITS.paths) full();
        children.push(child);
      }
    } finally { handle.closeSync(); }
    return children;
  };
  const read = (path: string): string | undefined => {
    if (entries >= REFERENCE_LIMITS.files) full();
    const file = repoFile(root, path);
    if (!file) return undefined;
    entries++;
    const text = readBoundedTextFile(file, 1024 * 1024)!;
    if (bytes + Buffer.byteLength(text) > KNOWLEDGE_LIMITS.scanBytes) full();
    bytes += Buffer.byteLength(text);
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gu)) {
      if (result.links.size >= REFERENCE_LIMITS.links) full();
      result.links.add(match[0].replace(/[.,;)\]]+$/u, ""));
    }
    return text;
  };
  const addRuns = (value: unknown): void => {
    if (typeof value !== "string") return;
    for (const line of [value, ...value.split(/\r?\n/u)]) {
      if (!line.trim()) continue;
      if (result.commands.size >= REFERENCE_LIMITS.commands) full();
      result.commands.add(line.trim());
    }
  };
  // One malformed manifest or workflow only means its commands stay unverified.
  const packageFile = (path: string): Record<string, unknown> | undefined => {
    const text = read(path);
    if (text === undefined) return undefined;
    let data: unknown;
    try { data = JSON.parse(text); } catch { return undefined; }
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    const scripts = (data as Record<string, unknown>).scripts;
    if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
      const name = (data as Record<string, unknown>).name;
      const own = new Set<string>();
      for (const key of [path.replace(/\/?package\.json$/u, ""), typeof name === "string" ? name : undefined]) {
        if (key !== undefined && !result.packageScripts.has(key)) result.packageScripts.set(key, own);
      }
      for (const [name, command] of Object.entries(scripts)) {
        if (result.scripts.size >= REFERENCE_LIMITS.scripts) full();
        result.scripts.add(name);
        own.add(name);
        addRuns(command);
      }
    }
    return data as Record<string, unknown>;
  };
  const safeDirectory = (path: string) => {
    const directory = join(root, path);
    try {
      if (lstatSync(directory).isSymbolicLink() || realPath(directory) !== absolutePath(directory)) throw new KnowledgeError("UNSAFE_SOURCE", "A knowledge reference directory is redirected.");
      return childrenOf(directory);
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return undefined; throw e; }
  };
  const workspacePatterns = (pkg: Record<string, unknown> | undefined): string[] => {
    const declared = pkg?.workspaces;
    const listed = Array.isArray(declared) ? declared
      : declared && typeof declared === "object" && Array.isArray((declared as { packages?: unknown }).packages) ? (declared as { packages: unknown[] }).packages : [];
    const patterns = listed.filter((p): p is string => typeof p === "string");
    const pnpm = read("pnpm-workspace.yaml");
    if (pnpm !== undefined) {
      const parsed = repoYaml(pnpm);
      if (parsed.unreadable) result.gaps.push("pnpm-workspace.yaml could not be read.");
      const packages = (parsed.value as { packages?: unknown } | null)?.packages;
      if (Array.isArray(packages)) patterns.push(...packages.filter((p): p is string => typeof p === "string"));
    }
    return [...new Set(patterns)];
  };
  const workspaces = (pkg: Record<string, unknown> | undefined): void => {
    for (const pattern of workspacePatterns(pkg)) {
      // Plain folders and one trailing `*` level; exclusions and deeper globs are not followed.
      if (!/^[A-Za-z0-9_./-]+(?:\/\*)?$/u.test(pattern) || pattern.split("/").includes("..")) continue;
      if (!pattern.endsWith("/*")) { packageFile(`${pattern.replace(/^\.\//u, "")}/package.json`); continue; }
      const parent = pattern.slice(0, -2).replace(/^\.\//u, "");
      for (const child of safeDirectory(parent) ?? []) if (child.isDirectory() && !child.isSymbolicLink()) packageFile(`${parent}/${child.name}/package.json`);
    }
  };
  // A link committed under docs or CI is skipped, never followed or read, so
  // nothing outside the repository is reached through it. One gap says so.
  let linked = false;
  const skipLink = (): void => { if (!linked) { linked = true; result.gaps.push("Some linked files in docs or CI were skipped."); } };
  const linkedFolder = (path: string): boolean => {
    let current = root;
    for (const part of path.split("/")) {
      current = join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return false; throw e; }
    }
    return false;
  };
  const walk = (path: string, kind: "docs" | "ci", depth = 0): void => {
    if (depth === 0 && linkedFolder(path)) { skipLink(); return; }
    const children = safeDirectory(path);
    for (const child of children ?? []) {
      const name = path ? `${path}/${child.name}` : child.name;
      if (child.isSymbolicLink()) { skipLink(); continue; }
      if (child.isDirectory()) { if (depth < REFERENCE_LIMITS.depth) walk(name, kind, depth + 1); continue; }
      if (!(kind === "ci" ? /\.ya?ml$/iu : /\.md$/iu).test(child.name)) continue;
      const text = read(name);
      if (!text) continue;
      if (kind === "docs") {
        for (const match of text.matchAll(/`([^`\n]+)`/gu)) addRuns(match[1]);
        for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)) addRuns(match[1]);
      } else {
        const parsed = repoYaml(text);
        if (parsed.unreadable) { result.gaps.push(`${name} could not be read.`); continue; }
        const data = parsed.value as { jobs?: Record<string, { steps?: Array<{ run?: unknown }> }> } | null;
        for (const job of Object.values(data?.jobs ?? {})) {
          for (const step of job?.steps ?? []) addRuns(step?.run);
        }
      }
    }
  };
  const rootDocs = (): void => {
    for (const file of childrenOf(root)) if (file.isFile() && /^(?:readme|contributing|agents|claude)(?:[._-][^/]*)?\.md$/iu.test(file.name)) {
      const text = read(relative(root, join(root, file.name)));
      if (!text) continue;
      for (const match of text.matchAll(/`([^`\n]+)`/gu)) addRuns(match[1]);
      for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)) addRuns(match[1]);
    }
  };
  try {
    const pkg = packageFile("package.json");
    workspaces(pkg);
    // Use the same config readers as setup for exact workspace and non-Node
    // commands. These are local reads; no evaluator or repository command runs.
    const config = new RepoFiles(root);
    for (const found of [...readNode(config).found, ...readPython(config).found, ...readCargo(config).found, ...readGradle(config).found]) {
      if (repoFile(root, found.origin.file)) addRuns(found.command);
    }
    const makefile = ["Makefile", "makefile", "GNUmakefile"].find(file => config.isFile(file));
    if (makefile) for (const target of makeTargets(read(makefile) ?? "")) {
      if (/^[\w][\w./-]{0,100}$/u.test(target)) addRuns("make " + target);
    }
    if (config.truncated) result.truncated = true;
    walk(".github/workflows", "ci"); walk("docs", "docs");
    rootDocs();
  } catch (e) { if (!(e instanceof Full)) throw e; }
  return result;
}

export const ENV_ASSIGNMENTS = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=(?:[A-Za-z0-9_./,:@%+~=-]*|"[A-Za-z0-9_ ./,:@%+~=-]*"|'[A-Za-z0-9_ ./,:@%+~=-]*')[ \t]+)*`;

export function withoutEnvironment(command: string): string {
  return command.replace(new RegExp(`^${ENV_ASSIGNMENTS}`, "u"), "");
}

export function commandExists(command: string, source: References): boolean {
  const original = command.trim();
  if (source.commands.has(original) || source.exact?.has(original)) return true;
  if (/[;&|<>$`\r\n]/u.test(command)) return false;
  const trimmed = withoutEnvironment(original);
  if (source.commands.has(trimmed)) return true;
  const runner = RUNNERS.exec(trimmed)?.[1] ?? /^npm (test|start|stop|restart)$/u.exec(trimmed)?.[1];
  if (runner !== undefined && source.scripts.has(runner)) return true;
  const workspace = NPM_WORKSPACE.exec(trimmed);
  if (workspace) {
    const pkg = (workspace[1] ?? workspace[4])!.replace(/^\.\//u, "").replace(/\/+$/u, "");
    return !!source.packageScripts.get(pkg)?.has((workspace[2] ?? workspace[3])!);
  }
  const script = /^(?:(?:node|python3?|bash|sh|pwsh)\s+)?((?:\.\/)?(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+\.(?:[cm]?js|py|sh|ps1))(?:\s+[^;&|<>$`\r\n]*)?$/u.exec(trimmed);
  return !!script && !!repoFile(source.root, script[1]);
}
