/**
 * Writes the planned native files. MEX only writes and removes files it
 * generated and nobody edited since; local files are hidden through git's
 * exclude file. The coordinator defers background writes between sessions.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { containedDirectory, readBoundedTextFile } from "./files.js";
import { KnowledgeError } from "./contract.js";
import { realPath } from "../record/project.js";
import type { NativePlan, Sharing } from "./native-plan.js";
import { GENERATED_MARK } from "./rule-files.js";

/** What MEX generated, with the hash it wrote, so a person's edit is never overwritten or deleted. */
export interface NativeManifest { version: 1; files: Record<string, string>; }
export const SHARED_MANIFEST = ".mex/native.json";
export const LOCAL_MANIFEST = "native-local.json";
const EXCLUDE_START = "# mex: local rule files (generated, personal)";
const EXCLUDE_END = "# mex: end";

export interface NativeWrite {
  written: string[]; unchanged: string[]; removed: string[];
  /** Generated files a person edited: left alone. */
  kept: string[];
  notes: string[];
}

const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

function readManifest(path: string): NativeManifest {
  const text = readText(path);
  if (text === undefined) return { version: 1, files: {} };
  try {
    const parsed = JSON.parse(text) as NativeManifest;
    if (parsed.version !== 1 || !parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) throw new Error();
    for (const [name, wrote] of Object.entries(parsed.files)) {
      assertNativePath(name);
      if (typeof wrote !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(wrote)) throw new Error();
    }
    return parsed;
  } catch { throw new KnowledgeError("UNSAFE_NATIVE", "The generated-file manifest is invalid; its files were kept for review."); }
}

function assertNativePath(path: string): void {
  const parts = path.split("/");
  if (!parts.length || !parts.every(part => /^[A-Za-z0-9._-]+$/u.test(part) && part !== "." && part !== "..")
    || !(posix.basename(path) === "AGENTS.md" || /^\.claude\/rules\/mex[\w-]*\.md$/u.test(path))) {
    throw new KnowledgeError("UNSAFE_NATIVE", "A generated file has an unsafe path.");
  }
}

function writeAtomic(path: string, text: string): void {
  const temporary = join(dirname(path), `.${posix.basename(path.replace(/\\/gu, "/"))}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(temporary, text, { mode: 0o644 });
  renameSync(temporary, path);
}

/** Create the parent folders of a repo path, refusing links and junctions. */
function parentOf(root: string, path: string): string {
  const parts = path.split("/").slice(0, -1);
  return parts.length ? containedDirectory(root, parts, true)! : root;
}

function readText(path: string): string | undefined {
  return readBoundedTextFile(path, 1024 * 1024);
}

function existingParent(root: string, path: string): string | undefined {
  const parts = path.split("/").slice(0, -1);
  return parts.length ? containedDirectory(root, parts) : root;
}

function tracked(root: string, path: string): boolean {
  try {
    execFileSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", path], { stdio: "ignore", windowsHide: true });
    return true;
  } catch (error) { return (error as { status?: number }).status !== 1; }
}

/** git's per-clone exclude file (worktrees share it). */
export function excludeFile(root: string): string | undefined {
  try {
    const path = execFileSync("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
    return path ? (path.startsWith("/") || /^[A-Za-z]:/u.test(path) ? path : join(root, path)) : undefined;
  } catch { return undefined; }
}

/** Keep MEX's block in the exclude file listing exactly these paths. */
export function setExcluded(root: string, paths: string[]): boolean {
  const file = excludeFile(root);
  if (!file) return false;
  const current = readText(file) ?? "";
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`\\n?${escape(EXCLUDE_START)}\\n[\\s\\S]*?${escape(EXCLUDE_END)}\\n?`, "u");
  const without = current.replace(pattern, "\n").replace(/\n+$/u, "");
  const block = paths.length ? `${EXCLUDE_START}\n${[...paths].sort().map(p => `/${p}`).join("\n")}\n${EXCLUDE_END}\n` : "";
  const next = (without ? `${without}\n` : "") + (block ? `${without ? "\n" : ""}${block}` : "");
  if (next === current) return true;
  if (!existsSync(dirname(file))) return false;
  writeAtomic(file, next);
  return true;
}

export interface WriteOptions {
  root: string;
  /** Where the local manifest lives: the project's folder in the MEX home. */
  projectDirectory?: string;
}

/** Apply a plan. Shared files go to the working tree; local ones too, hidden from git. */
export function writeNative(plan: NativePlan, options: WriteOptions): NativeWrite {
  // A checkout root may use the OS's ordinary alias (/var on macOS). Resolve
  // that anchor once; containedDirectory still refuses redirected descendants.
  const root = realPath(options.root);
  const result: NativeWrite = { written: [], unchanged: [], removed: [], kept: [], notes: [...plan.notes] };
  const manifestPath: Record<Sharing, string | undefined> = {
    shared: join(root, SHARED_MANIFEST),
    local: options.projectDirectory ? join(options.projectDirectory, LOCAL_MANIFEST) : undefined,
  };
  for (const sharing of ["shared", "local"] as const) {
    const files = plan.files.filter(f => f.sharing === sharing);
    const manifestFile = manifestPath[sharing];
    if (!manifestFile) {
      if (files.length) result.notes.push("Local rule files need MEX set up on this machine; skipped.");
      continue;
    }
    const before: NativeManifest = sharing === "shared" && !existingParent(root, SHARED_MANIFEST) ? { version: 1, files: {} } : readManifest(manifestFile);
    // Preflight both planned output and old cleanup paths. A manifest never
    // authorizes following a link, traversing outside, or touching other files.
    for (const path of new Set([...Object.keys(before.files), ...files.map(f => f.path)])) {
      assertNativePath(path);
      if (existingParent(root, path)) readText(join(root, ...path.split("/")));
    }
    if (sharing === "local" && !setExcluded(root, [...new Set([...Object.keys(before.files), ...files.map(f => f.path)])])) {
      if (files.length) result.notes.push("Couldn't hide local rule files; personal files were not written.");
      continue;
    }
    const after: NativeManifest = { version: 1, files: {} };
    const planned = new Set(files.map(f => f.path));
    for (const file of files) {
      if (sharing === "local" && tracked(root, file.path)) {
        result.kept.push(file.path);
        result.notes.push(`${file.path} is tracked; personal rules were not written.`);
        continue;
      }
      const full = join(parentOf(root, file.path), posix.basename(file.path));
      const current = readText(full);
      if (current !== undefined && !current.includes(GENERATED_MARK)) { result.notes.push(`${file.path} is yours; not written.`); continue; }
      if (current !== undefined && current !== file.text && (!before.files[file.path] || hash(current) !== before.files[file.path])) {
        result.kept.push(file.path);
        if (before.files[file.path]) after.files[file.path] = before.files[file.path];
        continue;
      }
      if (current === file.text) result.unchanged.push(file.path);
      else { writeAtomic(full, file.text); result.written.push(file.path); }
      after.files[file.path] = hash(file.text);
    }
    for (const [path, wrote] of Object.entries(before.files)) {
      if (planned.has(path)) continue;
      if (sharing === "local" && tracked(root, path)) { result.kept.push(path); continue; }
      if (!existingParent(root, path)) continue;
      const full = join(root, ...path.split("/"));
      const current = readText(full);
      if (current === undefined) continue;
      if (hash(current) === wrote && current.includes(GENERATED_MARK)) { unlinkSync(full); result.removed.push(path); }
      else { result.kept.push(path); after.files[path] = wrote; }
    }
    const changed = JSON.stringify(before.files) !== JSON.stringify(after.files);
    if (changed || (!existsSync(manifestFile) && Object.keys(after.files).length)) {
      if (Object.keys(after.files).length || existsSync(manifestFile)) {
        if (sharing === "shared") parentOf(root, SHARED_MANIFEST);
        writeAtomic(manifestFile, `${JSON.stringify(after, null, 2)}\n`);
      }
    }
    if (sharing === "local" && !setExcluded(root, Object.keys(after.files))) {
      if (Object.keys(after.files).length) result.notes.push("Couldn't hide local rule files: no git exclude file here.");
    }
  }
  return result;
}
