/**
 * Writes the planned native files. MEX only writes and removes files it
 * generated and nobody edited since; local files are hidden through git's
 * exclude file. The coordinator defers background writes between sessions.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { containedDirectory, readBoundedTextFile } from "./files.js";
import { KnowledgeError } from "./contract.js";
import { realPath } from "../record/project.js";
import type { NativePlan, Sharing } from "./native-plan.js";
import { GENERATED_MARK } from "./rule-files.js";
import { changeNativeFile, EXCLUDE_END, EXCLUDE_START, journalOwnsNativeFile, nativeExcludeBlock } from "./native-journal.js";
import { readSnapshot, snapshotBytes } from "../install/files.js";
import type { RecordReader, RecordWriter } from "../record/index.js";

/** What MEX generated, with the hash it wrote, so a person's edit is never overwritten or deleted. */
export interface NativeManifest { version: 1; files: Record<string, string>; checkouts?: Record<string, Record<string, string>>; }
export const SHARED_MANIFEST = ".mex/native.json";
export const LOCAL_MANIFEST = "native-local.json";

export interface NativeWrite {
  written: string[]; unchanged: string[]; removed: string[];
  /** Generated files a person edited: left alone. */
  kept: string[];
  notes: string[];
}

const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

function parseManifest(text: string | undefined): NativeManifest {
  if (text === undefined) return { version: 1, files: {} };
  try {
    const parsed = JSON.parse(text) as NativeManifest;
    if (parsed.version !== 1 || !parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) throw new Error();
    if (parsed.checkouts && (typeof parsed.checkouts !== "object" || Array.isArray(parsed.checkouts) || Object.keys(parsed.checkouts).length > 256)) throw new Error();
    for (const files of [parsed.files, ...Object.values(parsed.checkouts ?? {})]) {
      if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error();
      for (const [name, wrote] of Object.entries(files)) {
        assertNativePath(name);
        if (typeof wrote !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(wrote)) throw new Error();
      }
    }
    return parsed;
  } catch { throw new KnowledgeError("UNSAFE_NATIVE", "The generated-file manifest is invalid; its files were kept for review."); }
}

function assertNativePath(path: string): void {
  const parts = path.split("/");
  if (!parts.length || !parts.every(part => /^[A-Za-z0-9._-]+$/u.test(part) && part !== "." && part !== "..")
    // The three forms native-plan writes: AGENTS.md, Claude Code's rules and Copilot's path-scoped instructions.
    || !(posix.basename(path) === "AGENTS.md" || /^\.claude\/rules\/mex[\w-]*\.md$/u.test(path) || /^\.github\/instructions\/mex[\w-]*\.instructions\.md$/u.test(path))) {
    throw new KnowledgeError("UNSAFE_NATIVE", "A generated file has an unsafe path.");
  }
}

function writeExact(writer: RecordWriter | undefined, path: string, before: string | undefined, after: string | undefined): void {
  const current = readSnapshot(path, 1024 * 1024);
  if (current.data !== (before === undefined ? null : Buffer.from(before).toString("base64"))) {
    throw new KnowledgeError("UNSAFE_NATIVE", "A generated file changed while MEX was rebuilding it.");
  }
  changeNativeFile(writer, path, current, { data: after === undefined ? null : Buffer.from(after).toString("base64"),
    mode: current.data === null ? 0o644 : current.mode });
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
export function setExcluded(root: string, paths: string[], writer?: RecordWriter): boolean {
  const file = excludeFile(root);
  if (!file) return false;
  const before = readSnapshot(file, 1024 * 1024);
  const current = snapshotBytes(before)?.toString("latin1") ?? "";
  const found = nativeExcludeBlock(current);
  const block = paths.length ? `${EXCLUDE_START}\n${[...paths].sort().map(p => `/${p}`).join("\n")}\n${EXCLUDE_END}\n` : "";
  const next = found ? current.slice(0, found.index) + block + current.slice(found.index + found[0].length)
    : current + (block && current && !current.endsWith("\n") ? "\n" : "") + block;
  if (next === current) return true;
  if (!existsSync(dirname(file))) return false;
  changeNativeFile(writer, file, before, { data: Buffer.from(next, "latin1").toString("base64"), mode: before.mode }, "exclude");
  return true;
}

export interface WriteOptions {
  root: string;
  /** Where the local manifest lives: the project's folder in the MEX home. */
  projectDirectory?: string;
  /** Write and clean up only these files; the others' manifest is left alone. */
  only?: Sharing;
  writer?: RecordWriter;
  siblingCheckouts?: readonly string[];
}

// Linked worktrees share Git's exclude file. Keep the paths still owned by the
// other checkout even when removing all local rules from this one.
function siblingExclusions(root: string, manifest: NativeManifest, checkouts: readonly string[]): string[] {
  const peers = checkouts.filter(checkout => Object.keys(manifest.checkouts?.[checkout] ?? {}).length);
  const exclude = peers.length ? excludeFile(root) : undefined;
  if (!exclude || !existsSync(exclude)) return [];
  const path = realPath(exclude);
  const others = new Set<string>();
  for (const checkout of peers) {
    try {
      const file = excludeFile(checkout);
      if (!file || realPath(file) !== path) continue;
      for (const name of Object.keys(manifest.checkouts![checkout])) others.add(name);
    } catch { /* the other checkout might have been removed */ }
  }
  return [...others];
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
  for (const sharing of options.only ? [options.only] : ["shared", "local"] as const) {
    const files = plan.files.filter(f => f.sharing === sharing);
    const manifestFile = manifestPath[sharing];
    if (!manifestFile) {
      if (files.length) result.notes.push("Local rule files need MEX set up on this machine; skipped.");
      continue;
    }
    const currentManifest = sharing === "shared" && !existingParent(root, SHARED_MANIFEST) ? undefined : readText(manifestFile);
    const manifest = parseManifest(currentManifest);
    const perCheckout = sharing === "local" && options.siblingCheckouts !== undefined;
    const before = perCheckout ? { files: manifest.checkouts?.[root] ?? manifest.files } : manifest;
    const elsewhere = perCheckout ? siblingExclusions(root, manifest, options.siblingCheckouts!) : [];
    // Preflight both planned output and old cleanup paths. A manifest never
    // authorizes following a link, traversing outside, or touching other files.
    for (const path of new Set([...Object.keys(before.files), ...files.map(f => f.path)])) {
      assertNativePath(path);
      if (existingParent(root, path)) readText(join(root, ...path.split("/")));
    }
    if (sharing === "local" && !setExcluded(root, [...new Set([...elsewhere, ...Object.keys(before.files), ...files.map(f => f.path)])], options.writer)) {
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
      if (current !== undefined && current !== file.text && hash(current) !== before.files[file.path]
        && !journalOwnsNativeFile(options.writer, full, current)) {
        result.kept.push(file.path);
        if (before.files[file.path]) after.files[file.path] = before.files[file.path];
        continue;
      }
      if (current === file.text) result.unchanged.push(file.path);
      else { writeExact(options.writer, full, current, file.text); result.written.push(file.path); }
      after.files[file.path] = hash(file.text);
    }
    for (const [path, wrote] of Object.entries(before.files)) {
      if (planned.has(path)) continue;
      if (sharing === "local" && tracked(root, path)) { result.kept.push(path); continue; }
      if (!existingParent(root, path)) continue;
      const full = join(root, ...path.split("/"));
      const current = readText(full);
      if (current === undefined) continue;
      if (hash(current) === wrote && current.includes(GENERATED_MARK)) { writeExact(options.writer, full, current, undefined); result.removed.push(path); }
      else { result.kept.push(path); after.files[path] = wrote; }
    }
    const changed = JSON.stringify(before.files) !== JSON.stringify(after.files);
    if (changed || currentManifest === undefined && Object.keys(after.files).length || perCheckout && !manifest.checkouts?.[root] && Object.keys(after.files).length) {
      if (sharing === "shared") parentOf(root, SHARED_MANIFEST);
      const next = perCheckout ? { ...manifest, checkouts: { ...manifest.checkouts, [root]: after.files } } : after;
      const text = `${JSON.stringify(next, null, 2)}\n`;
      if (Buffer.byteLength(text) > 128 * 1024) throw new KnowledgeError("STORE_LIMIT", "The generated-file manifest is full.");
      writeExact(options.writer, manifestFile, currentManifest, text);
    }
    if (sharing === "local" && !setExcluded(root, [...new Set([...elsewhere, ...Object.keys(after.files)])], options.writer)) {
      if (Object.keys(after.files).length) result.notes.push("Couldn't hide local rule files: no git exclude file here.");
    }
  }
  return result;
}

type LegacyCheckout = { path: string; project_id: string };
const legacyCheckouts = "SELECT path,project_id FROM checkouts ORDER BY path";

/** Before journaling existed, a manifest hash was the only proof of ownership. */
function legacyNativeFiles(home: string, checkouts: LegacyCheckout[], apply: boolean): { restored: string[]; conflicts: string[] } {
  const restored = new Set<string>(), conflicts = new Set<string>(), localManifests = new Map<string, boolean>();
  for (const { path: root, project_id: project } of checkouts) {
    if (!existsSync(root)) continue;
    let local: string | undefined;
    try {
      const dir = containedDirectory(home, ["projects", project]);
      if (dir) local = join(dir, LOCAL_MANIFEST);
    } catch { /* redirected project data is never read */ }
    for (const manifest of [join(root, SHARED_MANIFEST), local]) {
      if (!manifest) continue;
      try {
        if (realPath(root) !== root || manifest !== local && !existingParent(root, SHARED_MANIFEST)) continue;
        const content = readText(manifest);
        if (content === undefined || manifest !== local && tracked(root, SHARED_MANIFEST)) continue;
        const parsed = parseManifest(content);
        const files = manifest === local ? parsed.checkouts?.[root] ?? parsed.files : parsed.files;
        let kept = false;
        for (const [name, wrote] of Object.entries(files)) {
          if (!existingParent(root, name)) continue;
          const full = join(root, name);
          const current = readText(full);
          if (current === undefined) continue;
          if (tracked(root, name)) { kept = true; continue; }
          if (hash(current) !== wrote || !current.includes(GENERATED_MARK)) {
            kept = true; conflicts.add(full); continue;
          }
          if (apply) writeExact(undefined, full, current, undefined);
          restored.add(full);
        }
        if (manifest === local) {
          const exclude = excludeFile(root);
          if (!kept && exclude && nativeExcludeBlock(snapshotBytes(readSnapshot(exclude, 1024 * 1024))?.toString("latin1") ?? "")
            && (!apply || setExcluded(root, []))) restored.add(exclude);
          localManifests.set(manifest, kept || !!localManifests.get(manifest));
        } else if (!kept) {
          if (apply) writeExact(undefined, manifest, content, undefined);
          restored.add(manifest);
        }
      } catch { conflicts.add(manifest); }
    }
  }
  for (const [path, kept] of localManifests) {
    if (kept || conflicts.has(path)) continue;
    try {
      if (apply) writeExact(undefined, path, readText(path), undefined);
      restored.add(path);
    }
    catch { conflicts.add(path); }
  }
  return { restored: [...restored], conflicts: [...conflicts] };
}

export function restoreLegacyNativeFiles(writer: RecordWriter): { restored: string[]; conflicts: string[] } {
  return legacyNativeFiles(writer.location.home, writer.db.prepare(legacyCheckouts).all() as LegacyCheckout[], true);
}

export function previewLegacyNativeFiles(reader: RecordReader, home: string): string[] {
  const result = legacyNativeFiles(home, reader.all<LegacyCheckout>(legacyCheckouts), false);
  return [...new Set([...result.restored, ...result.conflicts])];
}
