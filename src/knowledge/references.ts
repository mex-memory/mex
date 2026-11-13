import { lstatSync, opendirSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDocument } from "yaml";
import { absolutePath, realPath } from "../record/project.js";
import { KnowledgeError, KNOWLEDGE_LIMITS } from "./contract.js";
import { readBoundedTextFile } from "./files.js";

export interface References { root: string; commands: Set<string>; links: Set<string>; }
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
export function references(root: string): References {
  const result: References = { root, commands: new Set(), links: new Set() };
  let entries = 0, visited = 0, bytes = 0;
  const childrenOf = (path: string) => {
    const children: import("node:fs").Dirent[] = [];
    const handle = opendirSync(path);
    try {
      let child;
      while ((child = handle.readSync())) {
        if (++visited > 4096) throw new KnowledgeError("GATE_LIMIT", "Knowledge reference discovery exceeds its path limit.");
        children.push(child);
      }
    } finally { handle.closeSync(); }
    return children;
  };
  const read = (path: string): string | undefined => {
    if (++entries > 1024) throw new KnowledgeError("GATE_LIMIT", "Knowledge reference discovery exceeds its file limit.");
    const file = repoFile(root, path);
    if (!file) return undefined;
    const text = readBoundedTextFile(file, 1024 * 1024)!;
    bytes += Buffer.byteLength(text);
    if (bytes > KNOWLEDGE_LIMITS.scanBytes) throw new KnowledgeError("GATE_LIMIT", "Knowledge references exceed their byte limit.");
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gu)) {
      result.links.add(match[0].replace(/[.,;)\]]+$/u, ""));
      if (result.links.size > 4096) throw new KnowledgeError("GATE_LIMIT", "Knowledge references exceed their link limit.");
    }
    return text;
  };
  const addRuns = (value: unknown): void => {
    if (typeof value !== "string") return;
    result.commands.add(value.trim());
    for (const line of value.split(/\r?\n/u)) if (line.trim()) result.commands.add(line.trim());
    if (result.commands.size > 4096) throw new KnowledgeError("GATE_LIMIT", "Knowledge references exceed their command limit.");
  };
  const packageFile = (path: string): Record<string, unknown> | undefined => {
    const text = read(path);
    if (text === undefined) return undefined;
    let data: Record<string, unknown>;
    try { data = JSON.parse(text); } catch { throw new KnowledgeError("INVALID_SOURCE", "A package-script source is not valid JSON."); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new KnowledgeError("INVALID_SOURCE", "A package-script source is invalid.");
    if (data.scripts && typeof data.scripts === "object" && !Array.isArray(data.scripts)) {
      for (const [name, command] of Object.entries(data.scripts)) {
        addRuns(command);
        for (const runner of ["npm run", "pnpm run", "pnpm", "yarn", "bun run"]) result.commands.add(`${runner} ${name}`);
        if (["test", "start", "stop", "restart"].includes(name)) result.commands.add(`npm ${name}`);
      }
    }
    return data;
  };
  const pkg = packageFile("package.json");
  const workspaces = Array.isArray(pkg?.workspaces) ? pkg.workspaces : [];
  for (const pattern of workspaces) {
    if (typeof pattern !== "string" || !/^[A-Za-z0-9_./-]+(?:\/\*)?$/u.test(pattern) || pattern.split("/").includes("..")) continue;
    if (!pattern.endsWith("/*")) { packageFile(`${pattern}/package.json`); continue; }
    const parent = pattern.slice(0, -2);
    const directory = join(root, parent);
    let children;
    try {
      if (lstatSync(directory).isSymbolicLink() || realPath(directory) !== absolutePath(directory)) throw new KnowledgeError("UNSAFE_SOURCE", "A workspace source is redirected.");
      children = childrenOf(directory);
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    if (children.length > 1024) throw new KnowledgeError("GATE_LIMIT", "Workspace discovery exceeds its directory limit.");
    for (const child of children) if (child.isDirectory() && !child.isSymbolicLink()) packageFile(`${parent}/${child.name}/package.json`);
  }
  const walk = (path: string, kind: "docs" | "ci", depth = 0): void => {
    const directory = join(root, path);
    let children;
    try {
      if (lstatSync(directory).isSymbolicLink() || realPath(directory) !== absolutePath(directory)) throw new KnowledgeError("UNSAFE_SOURCE", "A knowledge reference directory is redirected.");
      children = childrenOf(directory);
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    if (children.length + entries > 1024) throw new KnowledgeError("GATE_LIMIT", "Knowledge reference discovery exceeds its directory limit.");
    for (const child of children) {
      const name = path ? `${path}/${child.name}` : child.name;
      if (child.isSymbolicLink()) throw new KnowledgeError("UNSAFE_SOURCE", "Knowledge references may not follow links.");
      if (child.isDirectory() && depth < 8) { walk(name, kind, depth + 1); continue; }
      if (child.isDirectory()) throw new KnowledgeError("GATE_LIMIT", "Knowledge reference nesting exceeds its limit.");
      if (!(kind === "ci" ? /\.ya?ml$/iu : /\.md$/iu).test(child.name)) continue;
      const text = read(name);
      if (!text) continue;
      if (kind === "docs") {
        for (const match of text.matchAll(/`([^`\n]+)`/gu)) addRuns(match[1]);
        for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)) addRuns(match[1]);
      } else {
        const doc = parseDocument(text, { uniqueKeys: true });
        if (doc.errors.length || doc.warnings.length) throw new KnowledgeError("INVALID_SOURCE", "A CI knowledge reference is invalid YAML.");
        const data = doc.toJS({ maxAliasCount: 0 });
        for (const job of Object.values(data?.jobs ?? {}) as Array<{ steps?: Array<{ run?: unknown }> }>) {
          for (const step of job?.steps ?? []) addRuns(step?.run);
        }
      }
    }
  };
  walk(".github/workflows", "ci"); walk("docs", "docs");
  const rootFiles = childrenOf(root);
  if (rootFiles.length > 1024) throw new KnowledgeError("GATE_LIMIT", "Knowledge reference discovery exceeds its root limit.");
  for (const file of rootFiles) if (file.isFile() && /^(?:readme|contributing|agents|claude)(?:[._-][^/]*)?\.md$/iu.test(file.name)) {
    const text = read(relative(root, join(root, file.name)))!;
    for (const match of text.matchAll(/`([^`\n]+)`/gu)) addRuns(match[1]);
    for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)) addRuns(match[1]);
  }
  return result;
}

export function commandExists(command: string, source: References): boolean {
  if (source.commands.has(command.trim())) return true;
  if (/[;&|<>$`\r\n]/u.test(command)) return false;
  const script = /^(?:(?:node|python3?|bash|sh|pwsh)\s+)?((?:\.\/)?(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+\.(?:[cm]?js|py|sh|ps1))(?:\s+[^;&|<>$`\r\n]*)?$/u.exec(command.trim());
  return !!script && !!repoFile(source.root, script[1]);
}
