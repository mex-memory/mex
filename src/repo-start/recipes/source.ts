/**
 * Shared shapes and the bounded, read-only file access every recipe reader
 * uses. Nothing here runs a repository command or follows a link.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

export const PURPOSES = ["test", "build", "lint", "typecheck", "format"] as const;
export type Purpose = typeof PURPOSES[number];
export type Local = "yes" | "needs secrets" | "needs services" | "from CI config, not running";
export type PackageKind = "node" | "cargo" | "python" | "gradle" | "make";

export interface Origin { file: string; pointer: string; }
export interface PlannedCheck {
  kind: "key" | "command";
  role: "complete" | "supporting";
  target: { file: string; pointer: string; run?: string };
}
/** One reader's find, before CI and config finds are merged. */
export interface Found {
  purpose: Purpose;
  /** Package folder relative to the root; "" for the root. */
  package: string;
  command: string;
  origin: Origin;
  source: "config" | "ci";
  local: Local;
  checks: PlannedCheck[];
  /** What the command runs, so a CI step and a config entry for the same thing merge. */
  match?: string;
}
export interface Package { path: string; name: string; kind: PackageKind; }
export interface ReviewItem { kind: "two-lockfiles" | "two-test-commands"; paths: string[]; message: string; }

export const SCAN_LIMITS = Object.freeze({ files: 4000, fileBytes: 1 << 20, totalBytes: 32 << 20, directories: 20_000, depth: 6, recipes: 2000 });
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".mex", "target", "dist", "build", ".venv", "venv", "__pycache__", ".gradle"]);

/** A JSON Pointer token (RFC 6901). */
export function token(text: string): string { return text.replace(/~/gu, "~0").replace(/\//gu, "~1"); }
export function pointer(...parts: Array<string | number>): string { return parts.map(part => `/${token(String(part))}`).join(""); }

/** INI the way the evaluator reads it (tox.ini, setup.cfg, .properties). */
export function parseIni(text: string): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  let current: Record<string, unknown> = doc;
  let key = "";
  for (const raw of text.replace(/\r\n/gu, "\n").split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    if (key && (raw[0] === " " || raw[0] === "\t")) {
      const prev = typeof current[key] === "string" ? current[key] as string : "";
      current[key] = prev === "" ? trimmed : `${prev}\n${trimmed}`;
      continue;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const name = trimmed.slice(1, -1).trim();
      const existing = doc[name];
      current = existing && typeof existing === "object" ? existing as Record<string, unknown> : (doc[name] = {}) as Record<string, unknown>;
      key = "";
      continue;
    }
    const at = trimmed.search(/[=:]/u);
    if (at <= 0) { key = ""; continue; }
    key = trimmed.slice(0, at).trim();
    current[key] = trimmed.slice(at + 1).trim();
  }
  return doc;
}

/** Bounded reads relative to one checkout. Links and oversized files read as absent. */
export class RepoFiles {
  private files = 0;
  private bytes = 0;
  private directories = 0;
  private cache = new Map<string, string | undefined>();
  /** True once a bound was reached; the scan is then partial. */
  truncated = false;
  constructor(readonly root: string) {}

  private full(path: string): string { return path === "" ? this.root : join(this.root, ...path.split("/")); }

  isFile(path: string): boolean {
    try { const stat = lstatSync(this.full(path)); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
  }
  isDirectory(path: string): boolean {
    try { const stat = lstatSync(this.full(path)); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; }
  }

  read(path: string): string | undefined {
    if (this.cache.has(path)) return this.cache.get(path);
    let text: string | undefined;
    if (this.files >= SCAN_LIMITS.files || this.bytes >= SCAN_LIMITS.totalBytes) this.truncated = true;
    else {
      try {
        const stat = lstatSync(this.full(path));
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= SCAN_LIMITS.fileBytes) {
          text = readFileSync(this.full(path), "utf8");
          this.files++; this.bytes += stat.size;
        } else if (stat.isFile() && stat.size > SCAN_LIMITS.fileBytes) this.truncated = true;
      } catch { text = undefined; }
    }
    this.cache.set(path, text);
    return text;
  }

  /** Child directory names, without links or the folders MEX never scans. */
  directoriesIn(path: string): string[] {
    if (++this.directories > SCAN_LIMITS.directories) { this.truncated = true; return []; }
    try {
      return readdirSync(this.full(path), { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith("."))
        .map(entry => entry.name).sort();
    } catch { return []; }
  }
  filesIn(path: string): string[] {
    try {
      return readdirSync(this.full(path), { withFileTypes: true })
        .filter(entry => entry.isFile() && !entry.isSymbolicLink()).map(entry => entry.name).sort();
    } catch { return []; }
  }

  json(path: string): Record<string, unknown> | undefined {
    const text = this.read(path);
    if (text === undefined) return undefined;
    try { const value: unknown = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
    catch { return undefined; }
  }
  yaml(path: string): unknown {
    const text = this.read(path);
    if (text === undefined) return undefined;
    try { return parseYaml(text, { maxAliasCount: 100, uniqueKeys: false, prettyErrors: false }); } catch { return undefined; }
  }
  toml(path: string): Record<string, unknown> | undefined {
    const text = this.read(path);
    if (text === undefined) return undefined;
    try { return parseToml(text) as Record<string, unknown>; } catch { return undefined; }
  }
  ini(path: string): Record<string, unknown> | undefined {
    const text = this.read(path);
    return text === undefined ? undefined : parseIni(text);
  }

  /**
   * Folders matching a workspace glob: `*` is one level, `**` any depth up to
   * the scan's depth bound, other segments are literal or simple wildcards.
   */
  glob(pattern: string): string[] {
    const segments = pattern.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "").split("/").filter(part => part && part !== ".");
    const out = new Set<string>();
    const walk = (base: string, rest: string[], depth: number) => {
      if (depth > SCAN_LIMITS.depth) { this.truncated = true; return; }
      if (!rest.length) { out.add(base); return; }
      const [head, ...tail] = rest as [string, ...string[]];
      const join = (name: string) => base === "" ? name : `${base}/${name}`;
      if (head === "**") {
        walk(base, tail, depth);
        for (const name of this.directoriesIn(base)) walk(join(name), rest, depth + 1);
        return;
      }
      if (!/[*?[\]{}]/u.test(head)) { if (this.isDirectory(join(head))) walk(join(head), tail, depth + 1); return; }
      const matcher = new RegExp(`^${head.replace(/[.+^$()|\\]/gu, "\\$&").replace(/\*/gu, "[^/]*").replace(/\?/gu, "[^/]")}$`, "u");
      for (const name of this.directoriesIn(base)) if (matcher.test(name)) walk(join(name), tail, depth + 1);
    };
    if (segments.length) walk("", segments, 0);
    return [...out].sort();
  }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
