/**
 * MEX's blocks in a repository's `info/exclude` file.
 *
 * Each block is named and fenced by its own marker lines, so several MEX
 * features can keep separate blocks in one file and remove only their own.
 * Every change is journaled in the record's `installs` table before the file
 * is written; `mex uninstall` reads the journal and restores the file byte for
 * byte, or, when the person has edited it since, removes only MEX's block.
 *
 * Bytes are handled as latin1 strings so any encoding round-trips unchanged.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RecordWriter } from "../record/index.js";

/** The block bare `mex` writes: local by default, except what `mex share` commits. */
export const REPO_START_BLOCK = "repo-start";
export const REPO_START_LINES: readonly string[] = [
  "/.mex/*",
  "!/.mex/learned/",
  "!/.mex/config.json",
  "!/.mex/sources.json",
  "!/.mex/native.json",
];

export const EXCLUDE_JOURNAL_PREFIX = "exclude-v1:";
const MAX_EXCLUDE_BYTES = 1 << 20;
const MAX_JOURNAL_ROWS = 4096;
const NAME = /^[a-z][a-z0-9-]{0,31}$/u;

export class ExcludeFileError extends Error {
  constructor(message: string) { super(message); this.name = "ExcludeFileError"; }
}

function markers(name: string): [string, string] {
  if (!NAME.test(name)) throw new ExcludeFileError(`Invalid exclude block name: ${name}`);
  return [`# mex: ${name} begin`, `# mex: ${name} end`];
}

export function blockText(name: string, lines: readonly string[]): string {
  const [begin, end] = markers(name);
  for (const line of lines) if (/[\r\n]/u.test(line) || line.startsWith("# mex:")) throw new ExcludeFileError("Invalid exclude line.");
  return `${begin}\n${lines.join("\n")}${lines.length ? "\n" : ""}${end}\n`;
}

/** The text of the file, or null when it doesn't exist. Refuses links and oversized files. */
export function readExclude(file: string): string | null {
  let stat;
  try { stat = lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ExcludeFileError(`Not a regular file: ${file}`);
  if (stat.size > MAX_EXCLUDE_BYTES) throw new ExcludeFileError(`The exclude file is larger than ${MAX_EXCLUDE_BYTES} bytes: ${file}`);
  return readFileSync(file, "latin1");
}

/** Character offsets of a named block, including its trailing newline. */
function findBlock(text: string, name: string): { start: number; end: number } | undefined {
  const [begin, end] = markers(name);
  let offset = 0;
  let start: number | undefined;
  for (const line of text.split("\n")) {
    const next = offset + line.length + 1;
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (start === undefined && bare === begin) start = offset;
    else if (start !== undefined && bare === end) return { start, end: Math.min(next, text.length) };
    offset = next;
  }
  return undefined;
}

export function hasBlock(text: string | null, name: string): boolean {
  return text !== null && findBlock(text, name) !== undefined;
}

/** The file with this block in place: replaced where it is, otherwise appended. */
export function withBlock(text: string | null, name: string, lines: readonly string[]): string {
  const block = blockText(name, lines);
  const base = text ?? "";
  const found = findBlock(base, name);
  if (found) return base.slice(0, found.start) + block + base.slice(found.end);
  return base + (base === "" || base.endsWith("\n") ? "" : "\n") + block;
}

export function withoutBlock(text: string, name: string): string {
  const found = findBlock(text, name);
  return found ? text.slice(0, found.start) + text.slice(found.end) : text;
}

/** Replace the file only if it still holds `expected`; null removes it. */
function writeExclude(file: string, expected: string | null, next: string | null): void {
  if (readExclude(file) !== expected) throw new ExcludeFileError(`The exclude file changed while MEX was writing it: ${file}`);
  if (next === null) { if (expected !== null) unlinkSync(file); return; }
  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.mex-exclude-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(temporary, next, { encoding: "latin1", flag: "wx" });
    if (readExclude(file) !== expected) throw new ExcludeFileError(`The exclude file changed while MEX was writing it: ${file}`);
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

interface JournalRow { id: number; path: string; key: string; old_value: string; new_value: string; }
const encode = (text: string | null) => JSON.stringify({ data: text === null ? null : Buffer.from(text, "latin1").toString("base64") });
function decode(value: string): string | null {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || !("data" in parsed)) throw new ExcludeFileError("Invalid exclude journal row.");
  const data = (parsed as { data: unknown }).data;
  if (data === null) return null;
  if (typeof data !== "string") throw new ExcludeFileError("Invalid exclude journal row.");
  return Buffer.from(data, "base64").toString("latin1");
}

export interface EnsureBlockResult { file: string; changed: boolean; }

/**
 * Put the named block in the file. The journal row is committed before the
 * write, so an interrupted run leaves either the old file or the new one, and
 * uninstall can undo either.
 */
export function ensureExcludeBlock(writer: RecordWriter, file: string, name: string, lines: readonly string[]): EnsureBlockResult {
  const before = readExclude(file);
  const after = withBlock(before, name, lines);
  if (after === before) return { file, changed: false };
  const count = Number((writer.db.prepare("SELECT count(*) AS n FROM installs WHERE key LIKE ?").get(`${EXCLUDE_JOURNAL_PREFIX}%`) as { n: number }).n);
  if (count >= MAX_JOURNAL_ROWS) throw new ExcludeFileError("The exclude-file journal is full; run `mex uninstall` before continuing.");
  const intent = writer.db.prepare("INSERT INTO installs(agent,path,key,old_value,new_value,ts) VALUES(?,?,?,?,?,?)")
    .run("mex", file, `${EXCLUDE_JOURNAL_PREFIX}${name}`, encode(before), encode(after), new Date().toISOString());
  try {
    writeExclude(file, before, after);
  } catch (error) {
    writer.db.prepare("UPDATE installs SET key=? WHERE id=?").run(`cancelled:${EXCLUDE_JOURNAL_PREFIX}${name}`, intent.lastInsertRowid);
    throw error;
  }
  return { file, changed: true };
}

function activeJournal(source: { prepare(sql: string): { all(...values: unknown[]): unknown[] } }): JournalRow[] {
  const rows = source.prepare("SELECT id,path,key,old_value,new_value FROM installs WHERE key LIKE ? ORDER BY id DESC LIMIT ?")
    .all(`${EXCLUDE_JOURNAL_PREFIX}%`, MAX_JOURNAL_ROWS + 1) as JournalRow[];
  if (rows.length > MAX_JOURNAL_ROWS) throw new ExcludeFileError("The exclude-file journal exceeds its bound.");
  return rows;
}

/** The exclude files uninstall would change, for its dry-run list. */
export function journaledExcludeFiles(reader: { all<T>(sql: string, ...values: (string | number)[]): T[] }): string[] {
  const rows = reader.all<{ path: string }>("SELECT DISTINCT path FROM installs WHERE key LIKE ? ORDER BY path LIMIT ?", `${EXCLUDE_JOURNAL_PREFIX}%`, MAX_JOURNAL_ROWS);
  return rows.map(row => row.path);
}

export interface RestoreResult { restored: string[]; conflicts: string[]; }

/**
 * Undo every journaled block, newest first. A file that still holds exactly
 * what MEX wrote gets its earlier bytes back; a file the person edited since
 * loses only MEX's block. A file with no block left is already restored.
 */
export function restoreExcludeBlocks(writer: RecordWriter): RestoreResult {
  const result: RestoreResult = { restored: [], conflicts: [] };
  const blocked = new Set<string>();
  for (const row of activeJournal(writer.db as never)) {
    if (blocked.has(row.path)) continue;
    const name = row.key.slice(EXCLUDE_JOURNAL_PREFIX.length);
    try {
      const before = decode(row.old_value), after = decode(row.new_value);
      const current = readExclude(row.path);
      if (current === after) writeExclude(row.path, current, before);
      else if (current !== null && current !== before && hasBlock(current, name)) writeExclude(row.path, current, withoutBlock(current, name));
      writer.db.prepare("UPDATE installs SET key=? WHERE id=?").run(`restored:${row.key}`, row.id);
      if (!result.restored.includes(row.path)) result.restored.push(row.path);
    } catch {
      blocked.add(row.path);
      result.conflicts.push(row.path);
    }
  }
  return result;
}
