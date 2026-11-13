/**
 * Storage for the file index, in `<record directory>/projects/<project-id>/index/`:
 *
 *   base-<stamp>.db         records shared by every checkout of the project, keyed by (hash, lang)
 *   c-<key>-<stamp>.db      one checkout: its path map, plus records the base doesn't have yet
 *   checkouts/<key>.json    pointer naming the checkout's current snapshot and base
 *   patterns.json           the literal patterns counted per file
 *   shifts/<key>/…          line shifts the hook writes after an edit (see shifts.ts)
 *
 * Snapshots are written once and never changed, so readers open them with
 * SQLite's `immutable` flag: no locks, no WAL, nothing to wait for. A refresh
 * writes a new file and then replaces the small pointer; renaming over a
 * database a reader has open fails on Windows, renaming over a pointer doesn't
 * need to wait long. Old snapshots are removed once nothing points at them.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { shortHash } from "../record/project.js";
import { patternId } from "./classify.js";
import type { FileRecord, IndexPattern, Lang, NotIndexedReason } from "./types.js";
import { EXTRACTOR_VERSION } from "./types.js";

export const STORE_VERSION = 1;

/** One row of a checkout's path map. `hash` and `lang` are null when `reason` is set. */
export interface PathRow {
  path: string;
  hash: string | null;
  lang: Lang | null;
  is_test: boolean;
  size: number;
  /** Modification time in nanoseconds, as a decimal string (bigger than a JS number). */
  mtime_ns: string;
  reason: NotIndexedReason | null;
}

export interface Pointer {
  version: number;
  root: string;
  snapshot: string;
  base: string;
  /** When the snapshot was written (ISO time). */
  as_of: string;
}

export function checkoutKey(realRoot: string): string { return shortHash(realRoot); }

export function indexDirectory(recordDirectory: string, projectId: string): string {
  return join(recordDirectory, "projects", projectId, "index");
}

let sqlite: typeof import("node:sqlite") | undefined;
function sqliteModule(): typeof import("node:sqlite") {
  if (sqlite) return sqlite;
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(message)) return;
    Reflect.apply(original, process, [warning, ...args]);
  }) as typeof process.emitWarning;
  try { sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite"); }
  finally { process.emitWarning = original; }
  return sqlite;
}

/** `file:` URI with SQLite's immutable flag: the reader takes no locks and never waits. */
export function immutableUri(file: string): string {
  return `${pathToFileURL(file).href}?immutable=1`;
}

export function openSnapshot(directory: string, pointer: Pointer): DatabaseSync {
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(immutableUri(join(directory, pointer.snapshot)), { readOnly: true });
  try {
    db.prepare("ATTACH DATABASE ? AS base").run(immutableUri(join(directory, pointer.base)));
  } catch (error) { db.close(); throw error; }
  return db;
}

// ── Pointers ──

export function pointerFile(directory: string, key: string): string { return join(directory, "checkouts", `${key}.json`); }

export function readPointer(directory: string, key: string): Pointer | undefined {
  try {
    const pointer = JSON.parse(readFileSync(pointerFile(directory, key), "utf8")) as Pointer;
    return pointer.version === STORE_VERSION ? pointer : undefined;
  } catch { return undefined; }
}

/** Write a small file through a rename. Readers hold the old one for microseconds, so a failed rename is retried briefly. */
export function writeAtomic(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  for (let attempt = 0; ; attempt++) {
    try { renameSync(temporary, file); return; } catch (error) {
      if (attempt >= 50) { try { unlinkSync(temporary); } catch { /* leave it */ } throw error; }
      const until = Date.now() + 2 + attempt;
      while (Date.now() < until) { /* a reader has the pointer open; it closes within microseconds */ }
    }
  }
}

export function writePointer(directory: string, key: string, pointer: Pointer): void {
  mkdirSync(join(directory, "checkouts"), { recursive: true, mode: 0o700 });
  writeAtomic(pointerFile(directory, key), `${JSON.stringify(pointer)}\n`);
}

/**
 * The hook finds a file's checkout and project without the database: for
 * each indexed checkout, `<record directory>/index-checkouts/<key>.json`
 * names them (native/index/shift FindCheckout reads it).
 */
export function writeLocator(recordDirectory: string, key: string, projectId: string, root: string): void {
  const directory = join(recordDirectory, "index-checkouts");
  const file = join(directory, `${key}.json`);
  const text = `${JSON.stringify({ version: STORE_VERSION, project_id: projectId, root })}\n`;
  try { if (readFileSync(file, "utf8") === text) return; } catch { /* not written yet */ }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeAtomic(file, text);
}

// ── Patterns ──

export function readPatterns(directory: string): IndexPattern[] {
  try {
    const list = JSON.parse(readFileSync(join(directory, "patterns.json"), "utf8")) as IndexPattern[];
    return list.filter((item) => item.match === "literal" && typeof item.pattern === "string" && item.id === patternId(item.pattern));
  } catch { return []; }
}

/** Replace the literal patterns counted per file. Returns true when the set changed (the next refresh recounts). */
export function writePatterns(directory: string, patterns: readonly IndexPattern[]): boolean {
  const unique = [...new Map(patterns.filter((item) => item.match === "literal" && item.pattern).map((item) => [item.id, item])).values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (patternsVersion(readPatterns(directory)) === patternsVersion(unique)) return false;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeAtomic(join(directory, "patterns.json"), `${JSON.stringify(unique, null, 2)}\n`);
  return true;
}

export function patternsVersion(patterns: readonly IndexPattern[]): string {
  return shortHash(patterns.map((item) => item.id).sort().join(","));
}

// ── Writing snapshots ──

const RECORD_TABLES = `
CREATE TABLE records(hash TEXT NOT NULL, lang TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(hash, lang)) WITHOUT ROWID;
CREATE TABLE symbols(name TEXT NOT NULL, hash TEXT NOT NULL, lang TEXT NOT NULL, ord INTEGER NOT NULL, kind TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, PRIMARY KEY(name, hash, lang, ord)) WITHOUT ROWID;
CREATE TABLE counts(hash TEXT NOT NULL, lang TEXT NOT NULL, pattern TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(hash, lang, pattern)) WITHOUT ROWID;
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;`;

const CHECKOUT_TABLES = `
CREATE TABLE paths(path TEXT PRIMARY KEY, hash TEXT, lang TEXT, is_test INTEGER NOT NULL, size INTEGER NOT NULL, mtime_ns TEXT NOT NULL, reason TEXT, name TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX paths_name ON paths(name);
CREATE INDEX paths_record ON paths(hash, lang);`;

function stamp(): string { return `${Date.now().toString(36)}${process.pid.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`; }

function createFile(file: string, schema: string): DatabaseSync {
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA page_size=4096;");
  db.exec(schema);
  return db;
}

/** Stored per record: everything but the key. */
function recordData(record: FileRecord): string {
  const { hash: _hash, lang: _lang, ...rest } = record;
  return JSON.stringify(rest);
}

export function parseRecord(hash: string, lang: Lang, data: string): FileRecord {
  return { hash, lang, ...(JSON.parse(data) as Omit<FileRecord, "hash" | "lang">) };
}

class RecordWriter {
  private readonly insertRecord;
  private readonly insertSymbol;
  private readonly insertCount;
  constructor(db: DatabaseSync) {
    this.insertRecord = db.prepare("INSERT OR IGNORE INTO records VALUES(?,?,?)");
    this.insertSymbol = db.prepare("INSERT OR IGNORE INTO symbols VALUES(?,?,?,?,?,?,?)");
    this.insertCount = db.prepare("INSERT OR IGNORE INTO counts VALUES(?,?,?,?)");
  }
  add(record: FileRecord): void {
    const result = this.insertRecord.run(record.hash, record.lang, recordData(record));
    if (Number(result.changes) === 0) return;
    record.outline.forEach((item, ord) => {
      if (item.kind !== "test") this.insertSymbol.run(item.name, record.hash, record.lang, ord, item.kind, item.start, item.end);
    });
    for (const [pattern, count] of Object.entries(record.patterns)) this.insertCount.run(record.hash, record.lang, pattern, count);
  }
}

function setMeta(db: DatabaseSync, values: Record<string, string>): void {
  const insert = db.prepare("INSERT OR REPLACE INTO meta VALUES(?,?)");
  for (const [key, value] of Object.entries(values)) insert.run(key, value);
}

/** Write a new base holding these records, plus every record of `copyFrom` when given. Returns its file name. */
export function writeBase(directory: string, records: Iterable<FileRecord>, patterns: readonly IndexPattern[], copyFrom?: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = `base-${stamp()}.db`;
  const temporary = join(directory, `${name}.tmp`);
  const db = createFile(temporary, RECORD_TABLES);
  try {
    if (copyFrom) db.prepare("ATTACH DATABASE ? AS old").run(immutableUri(join(directory, copyFrom)));
    db.exec("BEGIN");
    if (copyFrom) {
      for (const table of ["records", "symbols", "counts"]) db.exec(`INSERT OR IGNORE INTO main.${table} SELECT * FROM old.${table}`);
    }
    const writer = new RecordWriter(db);
    for (const record of records) writer.add(record);
    setMeta(db, { store_version: String(STORE_VERSION), extractor_version: String(EXTRACTOR_VERSION), patterns: patternsVersion(patterns), created_at: new Date().toISOString() });
    db.exec("COMMIT");
    if (copyFrom) db.exec("DETACH DATABASE old");
  } finally { db.close(); }
  renameSync(temporary, join(directory, name));
  writeAtomic(join(directory, "base.json"), `${JSON.stringify({ version: STORE_VERSION, base: name })}\n`);
  return name;
}

/** The project's current base, if it was written for these patterns and this extractor. */
export function currentBase(directory: string, patterns: readonly IndexPattern[]): string | undefined {
  let name: string;
  try {
    const value = JSON.parse(readFileSync(join(directory, "base.json"), "utf8")) as { version: number; base: string };
    if (value.version !== STORE_VERSION || !existsSync(join(directory, value.base))) return undefined;
    name = value.base;
  } catch { return undefined; }
  const { DatabaseSync } = sqliteModule();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(immutableUri(join(directory, name)), { readOnly: true });
    const meta = new Map((db.prepare("SELECT key,value FROM meta").all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
    return meta.get("patterns") === patternsVersion(patterns) && meta.get("extractor_version") === String(EXTRACTOR_VERSION) ? name : undefined;
  } catch { return undefined; }
  finally { db?.close(); }
}

/** How many records a base holds. */
export function baseSize(directory: string, base: string): number {
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(immutableUri(join(directory, base)), { readOnly: true });
  try { return Number((db.prepare("SELECT count(*) n FROM records").get() as { n: number }).n); }
  finally { db.close(); }
}

/** Current snapshot files of every checkout of the project, newest first. */
export function checkoutSnapshots(directory: string): string[] {
  let files: string[] = [];
  try { files = readdirSync(join(directory, "checkouts")).filter((file) => file.endsWith(".json")); } catch { return []; }
  const pointers: Pointer[] = [];
  for (const file of files) {
    try { pointers.push(JSON.parse(readFileSync(join(directory, "checkouts", file), "utf8")) as Pointer); } catch { /* skip */ }
  }
  return pointers.sort((a, b) => (a.as_of < b.as_of ? 1 : -1)).map((pointer) => pointer.snapshot);
}

/** Record keys every checkout's current snapshot uses, for compacting the base. */
export function liveRecordKeys(directory: string): Set<string> {
  const keys = new Set<string>();
  let files: string[] = [];
  try { files = readdirSync(join(directory, "checkouts")).filter((file) => file.endsWith(".json")); } catch { return keys; }
  const { DatabaseSync } = sqliteModule();
  for (const file of files) {
    let db: DatabaseSync | undefined;
    try {
      const pointer = JSON.parse(readFileSync(join(directory, "checkouts", file), "utf8")) as Pointer;
      db = new DatabaseSync(immutableUri(join(directory, pointer.snapshot)), { readOnly: true });
      for (const row of db.prepare("SELECT hash,lang FROM paths WHERE hash IS NOT NULL").all() as Array<{ hash: string; lang: string }>) keys.add(`${row.hash}:${row.lang}`);
    } catch { /* a missing snapshot keeps nothing alive */ }
    finally { db?.close(); }
  }
  return keys;
}

export interface CheckoutSnapshot {
  root: string;
  via: "git" | "walk";
  paths: readonly PathRow[];
  /** Records the base doesn't hold. */
  extras: Iterable<FileRecord>;
  base: string;
  patterns: readonly IndexPattern[];
}

/** Write a new checkout snapshot and point the checkout at it. */
export function writeCheckout(directory: string, key: string, snapshot: CheckoutSnapshot): Pointer {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = `c-${key}-${stamp()}.db`;
  const temporary = join(directory, `${name}.tmp`);
  const db = createFile(temporary, RECORD_TABLES + CHECKOUT_TABLES);
  const asOf = new Date().toISOString();
  try {
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO paths VALUES(?,?,?,?,?,?,?,?)");
    for (const row of snapshot.paths) {
      insert.run(row.path, row.hash, row.lang, row.is_test ? 1 : 0, row.size, row.mtime_ns, row.reason, row.path.slice(row.path.lastIndexOf("/") + 1));
    }
    const writer = new RecordWriter(db);
    for (const record of snapshot.extras) writer.add(record);
    setMeta(db, {
      store_version: String(STORE_VERSION), extractor_version: String(EXTRACTOR_VERSION), root: snapshot.root, via: snapshot.via,
      base: snapshot.base, patterns: patternsVersion(snapshot.patterns), pattern_ids: JSON.stringify(snapshot.patterns.map((item) => item.id)), as_of: asOf,
    });
    db.exec("COMMIT");
  } finally { db.close(); }
  renameSync(temporary, join(directory, name));
  const pointer: Pointer = { version: STORE_VERSION, root: snapshot.root, snapshot: name, base: snapshot.base, as_of: asOf };
  writePointer(directory, key, pointer);
  return pointer;
}

// ── Reading back for the indexer ──

/** The previous path map and the records it can reuse, read from the current snapshot. */
export function loadPrevious(directory: string, pointer: Pointer): { paths: Map<string, PathRow>; patterns: string; extractor: string } | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = openSnapshot(directory, pointer);
    const paths = new Map<string, PathRow>();
    for (const row of db.prepare("SELECT path,hash,lang,is_test,size,mtime_ns,reason FROM paths").all() as unknown as Array<Omit<PathRow, "is_test"> & { is_test: number }>) {
      paths.set(row.path, { ...row, is_test: row.is_test === 1 });
    }
    const meta = new Map((db.prepare("SELECT key,value FROM meta").all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
    return { paths, patterns: meta.get("patterns") ?? "", extractor: meta.get("extractor_version") ?? "" };
  } catch { return undefined; }
  finally { db?.close(); }
}

/** Reads records by key from a base and an old checkout snapshot, for reuse. */
export class RecordSource {
  private readonly dbs: DatabaseSync[] = [];
  private readonly queries: Array<ReturnType<DatabaseSync["prepare"]>> = [];
  constructor(files: readonly string[]) {
    const { DatabaseSync } = sqliteModule();
    for (const file of files) {
      if (!existsSync(file)) continue;
      try {
        const db = new DatabaseSync(immutableUri(file), { readOnly: true });
        this.dbs.push(db);
        this.queries.push(db.prepare("SELECT data FROM records WHERE hash=? AND lang=?"));
      } catch { /* unreadable snapshot: rebuild those records */ }
    }
  }
  get(hash: string, lang: Lang): FileRecord | undefined {
    for (const query of this.queries) {
      const row = query.get(hash, lang) as { data: string } | undefined;
      if (row) return parseRecord(hash, lang, row.data);
    }
    return undefined;
  }
  /** Whether the first source (the base) holds this record. */
  inFirst(hash: string, lang: Lang): boolean {
    return this.queries.length > 0 && this.queries[0]!.get(hash, lang) !== undefined;
  }
  close(): void { for (const db of this.dbs) db.close(); }
}

// ── Cleaning up ──

/** Remove snapshots no pointer names, once they are a minute old. Files a reader still has open are left for next time. */
export function collectGarbage(directory: string, now = Date.now()): number {
  let names: string[];
  try { names = readdirSync(directory); } catch { return 0; }
  const live = new Set<string>();
  try {
    for (const file of readdirSync(join(directory, "checkouts"))) {
      if (!file.endsWith(".json")) continue;
      try {
        const pointer = JSON.parse(readFileSync(join(directory, "checkouts", file), "utf8")) as Pointer;
        live.add(pointer.snapshot); live.add(pointer.base);
      } catch { /* a broken pointer protects nothing */ }
    }
  } catch { /* no checkouts yet */ }
  try { live.add((JSON.parse(readFileSync(join(directory, "base.json"), "utf8")) as { base: string }).base); } catch { /* no base yet */ }
  let removed = 0;
  for (const name of names) {
    if (!/^(base-|c-).*\.db(\.tmp)?$/.test(name) || live.has(name)) continue;
    const file = join(directory, name);
    try {
      if (now - statSync(file).mtimeMs < 60_000) continue;
      unlinkSync(file);
      removed++;
    } catch { /* open on Windows, or already gone */ }
  }
  return removed;
}
