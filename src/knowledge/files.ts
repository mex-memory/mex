import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, mkdirSync, writeSync, linkSync, unlinkSync, renameSync, fsyncSync } from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { absolutePath, realPath } from "../record/project.js";
import { EntryIdSchema, KnowledgeError, KNOWLEDGE_LIMITS } from "./entry.js";

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
/** Refuse symlink/junction redirects below the already resolved MEX home. */
export function containedDirectory(home: string, parts: string[], create = false): string | undefined {
  if (parts.some(part => !/^[A-Za-z0-9._-]+$/u.test(part) || part === "." || part === "..")) throw new KnowledgeError("UNSAFE_STORE", "Invalid note directory component.");
  let current = home;
  const base = realPath(home);
  for (const part of parts) {
    current = join(current, part);
    if (create) { try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (missing(error) && !create) return undefined; throw error; }
    const actual = realPath(current), within = relative(base, actual);
    if (!stat.isDirectory() || stat.isSymbolicLink() || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)
      || actual !== absolutePath(current)) throw new KnowledgeError("UNSAFE_STORE", "Personal note storage contains a redirected directory.");
  }
  return current;
}
/** Exact regular-file read, bounded even if the file grows while it is open. */
export function readEntryFile(path: string): string | undefined {
  let fd: number;
  let expected;
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new KnowledgeError("UNSAFE_STORE", "A note must be a regular file.");
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    expected = stat;
  } catch (error) { if (missing(error)) return undefined; throw error; }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (before.dev !== expected.dev || before.ino !== expected.ino) throw new KnowledgeError("STORE_CHANGED", "A note changed while it was opened; retry the command.");
    if (!before.isFile()) throw new KnowledgeError("UNSAFE_STORE", "A note must be a regular file.");
    if (before.size > BigInt(KNOWLEDGE_LIMITS.entryBytes)) throw new KnowledgeError("ENTRY_TOO_LARGE", "Entry exceeds the file size limit.");
    const bytes = Buffer.alloc(KNOWLEDGE_LIMITS.entryBytes + 1);
    let length = 0, read: number;
    do { read = readSync(fd, bytes, length, bytes.length - length, null); length += read; } while (read > 0 && length < bytes.length);
    const after = fstatSync(fd, { bigint: true });
    if (length > KNOWLEDGE_LIMITS.entryBytes) throw new KnowledgeError("ENTRY_TOO_LARGE", "Entry exceeds the file size limit.");
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(length) !== after.size) {
      throw new KnowledgeError("STORE_CHANGED", "A note changed while it was read; retry the command.");
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)); }
    catch { throw new KnowledgeError("INVALID_ENTRY", "Entry is not valid UTF-8."); }
  } finally { closeSync(fd); }
}
/** Publish complete bytes without ever replacing an existing stable entry id. */
export function createEntryFile(directory: string, id: string, content: string): void {
  if (!EntryIdSchema.safeParse(id).success) throw new KnowledgeError("INVALID_ID", "Invalid entry id.");
  if (Buffer.byteLength(content, "utf8") > KNOWLEDGE_LIMITS.entryBytes) throw new KnowledgeError("ENTRY_TOO_LARGE", "Entry exceeds the file size limit.");
  const temporary = join(directory, `.entry-${randomBytes(12).toString("hex")}.tmp`);
  let fd: number | undefined;
  let owned: { dev: bigint; ino: bigint } | undefined;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    owned = fstatSync(fd, { bigint: true });
    const bytes = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new KnowledgeError("STORE_UNAVAILABLE", "The note could not be written completely.");
      offset += written;
    }
    const completed = fd; fd = undefined;
    closeSync(completed);
    linkSync(temporary, join(directory, `${id}.md`));
  } finally {
    // Cleanup must not turn a published note into a reported failure or hide
    // the original write/publication error. Never remove a replacement file.
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    if (owned) {
      try {
        const current = lstatSync(temporary, { bigint: true });
        if (current.isFile() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) unlinkSync(temporary);
      } catch { /* An owned staging file may remain; recall ignores it. */ }
    }
  }
}

/** Caller holds the local record's write transaction to serialize MEX editors. */
export function replaceEntryFile(directory: string, id: string, expected: string, content: string): void {
  if (!EntryIdSchema.safeParse(id).success) throw new KnowledgeError("INVALID_ID", "Invalid entry id.");
  if (Buffer.byteLength(content, "utf8") > KNOWLEDGE_LIMITS.entryBytes) throw new KnowledgeError("ENTRY_TOO_LARGE", "Entry exceeds the file size limit.");
  const target = join(directory, `${id}.md`);
  const temporary = join(directory, `.entry-${randomBytes(12).toString("hex")}.tmp`);
  let fd: number | undefined;
  let owned: { dev: bigint; ino: bigint } | undefined;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    owned = fstatSync(fd, { bigint: true });
    const bytes = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (count <= 0) throw new KnowledgeError("STORE_UNAVAILABLE", "The entry could not be written completely.");
      offset += count;
    }
    fsyncSync(fd);
    const completed = fd; fd = undefined; closeSync(completed);
    if (readEntryFile(target) !== expected) throw new KnowledgeError("STALE_ENTRY", "The entry changed; read it again before editing.");
    renameSync(temporary, target);
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve publication outcome */ } }
    if (owned) {
      try {
        const current = lstatSync(temporary, { bigint: true });
        if (current.isFile() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) unlinkSync(temporary);
      } catch { /* an owned staging file can remain, but is never an entry */ }
    }
  }
}
