import { lstatSync, opendirSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDocument } from "yaml";
import { absolutePath, realPath } from "../record/project.js";
import { KnowledgeError, KNOWLEDGE_LIMITS } from "./contract.js";
import { readBoundedTextFile } from "./files.js";

export interface References {
  root: string; commands: Set<string>; links: Set<string>;
  /** Package-script names from the root package and its workspaces. */
  scripts: Set<string>;
  /** A discovery bound was reached; anything not collected stays unverified. */
  truncated: boolean;
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
const RUNNERS = /^(?:npm run|pnpm run|pnpm|yarn|yarn run|bun run|(?:pnpm|yarn)\s+(?:--filter|-F)[ =][\w@./*-]+(?:\s+run)?|yarn workspace [\w@./-]+(?:\s+run)?|npm run -w [\w@./-]+)\s+([^\s;&|<>$`]+)$/u;
class Full extends Error {}

/**
 * Repository-owned sources only. Learned entries cannot attest to themselves.
 *
 * Every bound is enforced, but a large repository is normal, so reaching one
 * stops discovery (in priority order: package scripts, CI, docs, root files)
 * and marks the result `truncated` instead of failing. An unfound command or
 * link is treated as unverified and removed, so truncation can only make the
 * gates stricter. Redirected or linked sources still fail.
 */
export function references(root: string): References {
  const result: References = { root, commands: new Set(), links: new Set(), scripts: new Set(), truncated: false };
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
      for (const [name, command] of Object.entries(scripts)) {
        if (result.scripts.size >= REFERENCE_LIMITS.scripts) full();
        result.scripts.add(name);
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
      const doc = parseDocument(pnpm, { uniqueKeys: true });
      const packages = doc.errors.length ? undefined : (doc.toJS({ maxAliasCount: 0 }) as { packages?: unknown } | null)?.packages;
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
  const walk = (path: string, kind: "docs" | "ci", depth = 0): void => {
    const children = safeDirectory(path);
    for (const child of children ?? []) {
      const name = path ? `${path}/${child.name}` : child.name;
      if (child.isSymbolicLink()) throw new KnowledgeError("UNSAFE_SOURCE", "Knowledge references may not follow links.");
      if (child.isDirectory()) { if (depth < REFERENCE_LIMITS.depth) walk(name, kind, depth + 1); continue; }
      if (!(kind === "ci" ? /\.ya?ml$/iu : /\.md$/iu).test(child.name)) continue;
      const text = read(name);
      if (!text) continue;
      if (kind === "docs") {
        for (const match of text.matchAll(/`([^`\n]+)`/gu)) addRuns(match[1]);
        for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)) addRuns(match[1]);
      } else {
        const doc = parseDocument(text, { uniqueKeys: true });
        if (doc.errors.length || doc.warnings.length) continue;
        const data = doc.toJS({ maxAliasCount: 0 });
        for (const job of Object.values(data?.jobs ?? {}) as Array<{ steps?: Array<{ run?: unknown }> }>) {
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
    walk(".github/workflows", "ci"); walk("docs", "docs");
    rootDocs();
  } catch (e) { if (!(e instanceof Full)) throw e; }
  return result;
}

export function commandExists(command: string, source: References): boolean {
  const trimmed = command.trim();
  if (source.commands.has(trimmed)) return true;
  if (/[;&|<>$`\r\n]/u.test(command)) return false;
  const runner = RUNNERS.exec(trimmed)?.[1] ?? /^npm (test|start|stop|restart)$/u.exec(trimmed)?.[1];
  if (runner !== undefined && source.scripts.has(runner)) return true;
  const script = /^(?:(?:node|python3?|bash|sh|pwsh)\s+)?((?:\.\/)?(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+\.(?:[cm]?js|py|sh|ps1))(?:\s+[^;&|<>$`\r\n]*)?$/u.exec(command.trim());
  return !!script && !!repoFile(source.root, script[1]);
}
