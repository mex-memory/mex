import { lstatSync, readdirSync, mkdirSync, renameSync, unlinkSync, rmdirSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import type { RecordWriter } from "../record/index.js";
import { realPath, absolutePath } from "../record/project.js";
import { containedDirectory, readBoundedTextFile, createEntryFile, personalReadGuard } from "./files.js";
import { parseEntry, KNOWLEDGE_LIMITS, KnowledgeError } from "./entry.js";

export interface NoteSnapshot { files: Map<string, string>; digest: string; }
const digest = (files: Map<string, string>) => createHash("sha256").update(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
const Manifest = z.object({ version: z.literal(1), id: z.string().regex(/^[a-f0-9]{24}$/u), before: z.string().regex(/^[a-f0-9]{64}$/u),
  after: z.string().regex(/^[a-f0-9]{64}$/u), hadNotes: z.boolean() }).strict();
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
function present(path: string): boolean { try { lstatSync(path); return true; } catch (e) { if (absent(e)) return false; throw e; } }
function directorySnapshot(path: string): NoteSnapshot {
  const files = new Map<string, string>();
  if (!present(path)) return { files, digest: digest(files) };
  const dir = lstatSync(path);
  if (!dir.isDirectory() || dir.isSymbolicLink() || realPath(path) !== absolutePath(path)) throw new KnowledgeError("UNSAFE_STORE", "Personal notes contain a redirected directory.");
  let bytes = 0;
  for (const name of readdirSync(path).sort()) {
    if (!/^mx_[a-z0-9]{6,64}\.md$/u.test(name)) throw new KnowledgeError("UNSAFE_STORE", "Personal notes contain an unexpected file; consolidation was withheld.");
    const raw = readBoundedTextFile(join(path, name), KNOWLEDGE_LIMITS.entryBytes);
    if (raw === undefined) throw new KnowledgeError("STORE_CHANGED", "Personal notes changed during consolidation.");
    if (parseEntry(raw).mex.id !== name.slice(0, -3)) throw new KnowledgeError("INVALID_ENTRY", "A personal note id differs from its filename.");
    files.set(name.slice(0, -3), raw); bytes += Buffer.byteLength(raw);
    if (files.size > KNOWLEDGE_LIMITS.entries || bytes > KNOWLEDGE_LIMITS.scanBytes) throw new KnowledgeError("STORE_LIMIT", "Personal notes exceed the consolidation limit.");
  }
  const after = lstatSync(path);
  if (after.dev !== dir.dev || after.ino !== dir.ino || realPath(path) !== absolutePath(path)) throw new KnowledgeError("STORE_CHANGED", "Personal note storage changed during consolidation.");
  return { files, digest: digest(files) };
}
export function snapshotNotes(writer: RecordWriter, project: string): NoteSnapshot {
  const parent = containedDirectory(writer.location.home, ["projects", project], true)!;
  const check = personalReadGuard(join(parent, "notes"));
  const snapshot = directorySnapshot(join(parent, "notes")); check(); return snapshot;
}
/** Read-only counterpart for previews; an absent project stays absent. */
export function readNotes(home: string, project: string): NoteSnapshot {
  const parent = containedDirectory(home, ["projects", project]);
  if (!parent) return { files: new Map(), digest: digest(new Map()) };
  const check = personalReadGuard(join(parent, "notes"));
  const snapshot = directorySnapshot(join(parent, "notes")); check(); return snapshot;
}
function syncDirectory(path: string): void {
  let fd: number | undefined;
  try { fd = openSync(path, "r"); fsyncSync(fd); }
  catch (error) {
    // Directory handles/fsync are unavailable on Windows and some filesystems.
    if (!["EINVAL", "ENOTSUP", "EISDIR", ...(process.platform === "win32" ? ["EPERM", "EACCES"] : [])].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function privateFile(parent: string, name: string, text: string): void {
  const tmp = join(parent, `.notes-${randomBytes(12).toString("hex")}.tmp`);
  writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
  const fd = openSync(tmp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, join(parent, name)); syncDirectory(parent);
}
/** Delete only a fully proved, flat copy owned by this publication. */
function removeCopy(path: string, expected: string): void {
  if (!present(path)) return;
  const files = directorySnapshot(path);
  if (files.digest !== expected) throw new KnowledgeError("STORE_CHANGED", "A saved note copy changed; it was kept for recovery.");
  for (const id of files.files.keys()) unlinkSync(join(path, `${id}.md`));
  rmdirSync(path);
}
function recoverLocked(writer: RecordWriter, project: string, parent: string): boolean {
  const raw = readBoundedTextFile(join(parent, "notes.pending"), 1024);
  if (raw === undefined) return false;
  let m: z.infer<typeof Manifest>;
  try { m = Manifest.parse(JSON.parse(raw)); } catch { throw new KnowledgeError("UNSAFE_STORE", "Personal note recovery metadata is invalid; notes were kept."); }
  const notes = join(parent, "notes"), stage = join(parent, `.notes-stage-${m.id}`), backup = join(parent, `.notes-backup-${m.id}`);
  const committed = writer.setting(project, "learning.publication") === m.id;
  if (committed) {
    if (directorySnapshot(notes).digest !== m.after) throw new KnowledgeError("STORE_CHANGED", "Published notes changed before recovery; saved copies were kept.");
  } else if (present(backup)) {
    if (directorySnapshot(backup).digest !== m.before) throw new KnowledgeError("STORE_CHANGED", "The previous notes changed; saved copies were kept.");
    if (present(notes)) {
      if (directorySnapshot(notes).digest !== m.after || present(stage)) throw new KnowledgeError("STORE_CHANGED", "Consolidation recovery found unexpected notes; saved copies were kept.");
      renameSync(notes, stage);
    }
    renameSync(backup, notes);
  } else if (m.hadNotes) {
    if (!present(notes) || directorySnapshot(notes).digest !== m.before) throw new KnowledgeError("STORE_CHANGED", "The previous notes could not be proved; saved copies were kept.");
  } else if (present(notes)) {
    if (directorySnapshot(notes).digest !== m.after || present(stage)) throw new KnowledgeError("STORE_CHANGED", "Consolidation recovery found unexpected notes; saved copies were kept.");
    renameSync(notes, stage);
  }
  // The revision remains changed after rollback, invalidating readers that
  // began before the swap. Ordinary readers never perform this recovery.
  unlinkSync(join(parent, "notes.pending")); syncDirectory(parent);
  // Once the canonical result is proved, cleanup cannot strand readers. An
  // interruption may leave a private saved copy; never delete an unproved copy.
  try { removeCopy(backup, m.before); removeCopy(stage, m.after); syncDirectory(parent); } catch { /* canonical notes are already complete */ }
  return true;
}
export function recoverNotes(writer: RecordWriter, project: string): boolean {
  const parent = containedDirectory(writer.location.home, ["projects", project], true)!;
  writer.db.exec("BEGIN IMMEDIATE");
  try { const recovered = recoverLocked(writer, project, parent); writer.db.exec("COMMIT"); return recovered; }
  catch (error) { writer.db.exec("ROLLBACK"); throw error; }
}
export interface PublishOptions {
  /** Called with the writer lock held, before any live file changes. */
  validate?: () => void;
  /** Internal fault injection for transaction/recovery tests. */
  step?: (phase: "prepared" | "backed-up" | "swapped" | "committed") => void;
}
/** Publish a complete copy. SQL metadata and the directory swap recover as one operation. */
export function publishNotes(writer: RecordWriter, project: string, before: NoteSnapshot, files: Map<string, string>,
  metadata: () => void, options: PublishOptions = {}): void {
  const parent = containedDirectory(writer.location.home, ["projects", project], true)!;
  const id = randomBytes(12).toString("hex"), stage = join(parent, `.notes-stage-${id}`), backup = join(parent, `.notes-backup-${id}`), notes = join(parent, "notes");
  // Staging never touches live notes. Validate every output before publication.
  mkdirSync(stage, { mode: 0o700 });
  let staged: NoteSnapshot;
  const copied = new Map<string, string>();
  try {
    for (const [key, raw] of files) { if (parseEntry(raw).mex.id !== key) throw new KnowledgeError("INVALID_ENTRY", "A consolidated note has an invalid id."); createEntryFile(stage, key, raw); copied.set(key, raw); }
    staged = directorySnapshot(stage);
    for (const name of readdirSync(stage)) { const fd = openSync(join(stage, name), "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
    syncDirectory(stage);
  } catch (error) { try { removeCopy(stage, digest(copied)); } catch { /* keep an unproved copy */ } throw error; }
  let committed = false, pending = false;
  try { writer.db.exec("BEGIN IMMEDIATE"); }
  catch (error) { removeCopy(stage, staged.digest); throw error; }
  try {
    recoverLocked(writer, project, parent);
    if (directorySnapshot(notes).digest !== before.digest) throw new KnowledgeError("STALE_ENTRY", "Personal notes changed; consolidation must read them again.");
    options.validate?.(); options.step?.("prepared");
    privateFile(parent, "notes.pending", JSON.stringify({ version: 1, id, before: before.digest, after: staged.digest, hadNotes: present(notes) })); pending = true;
    privateFile(parent, "notes.revision", id);
    if (present(notes)) renameSync(notes, backup);
    options.step?.("backed-up");
    renameSync(stage, notes); syncDirectory(parent); options.step?.("swapped");
    metadata();
    writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(project, "learning.publication", id);
    writer.db.exec("COMMIT"); committed = true;
  } catch (error) {
    writer.db.exec("ROLLBACK");
    if (pending) recoverNotes(writer, project);
    else removeCopy(stage, staged.digest);
    throw error;
  }
  if (committed) {
    // After COMMIT, cleanup failure cannot turn a successful publication into
    // a reported failure. The next background pass completes owned cleanup.
    try { options.step?.("committed"); recoverNotes(writer, project); } catch { /* pending marker withholds readers until recovery */ }
  }
}
