/**
 * The six reads of the file index (contract: file-index.md), in Node. The Go
 * reader in native/index answers the same way. A read never builds, repairs
 * or waits: with no index, or no row for a path, the answer says so and the
 * caller stays silent.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { absolutePath, realPath, shortHash } from "../record/project.js";
import { globPrefix, globToRegExp, normalizeGlob } from "./glob.js";
import { applyShifts, pendingShifts, shiftSpan, shiftedPathKeys } from "./shifts.js";
import { checkoutKey, indexDirectory, openSnapshot, parseRecord, readPointer, type Pointer } from "./store.js";
import type { FileRecord, Lang, NotIndexedReason, OutlineItem, ReadMiss, SymbolKind } from "./types.js";

export type Miss = { path: string; not_indexed: ReadMiss };
export interface OutlineAnswer { path: string; as_of: string; symbols: OutlineItem[]; /** Symbols left out because an edit touched their first or last line. */ dropped: number }
export interface FileInfoAnswer { path: string; lang: Lang; is_test: boolean; tokens: number; lines: number; hash: string }
export interface SymbolHit { path: string; start: number; end: number; kind: SymbolKind }
export interface CoverageAnswer { files: number; indexed: number; not_indexed: Partial<Record<NotIndexedReason, number>> }

interface PathRow { path: string; hash: string | null; lang: Lang | null; is_test: number; mtime_ns: string; reason: NotIndexedReason | null }

export interface OpenOptions { recordDirectory: string; projectId: string; checkout: string }

/** Open a checkout's index for reading, or undefined when it has none. */
export function openIndex(options: OpenOptions): IndexReader | undefined {
  let root: string;
  try { root = realPath(options.checkout); } catch { return undefined; }
  const key = checkoutKey(root);
  const directory = indexDirectory(options.recordDirectory, options.projectId);
  const pointer = readPointer(directory, key);
  if (!pointer) return undefined;
  try { return new IndexReader(openSnapshot(directory, pointer), pointer, directory, key, root); }
  catch { return undefined; }
}

export class IndexReader {
  private readonly pathRow: StatementSync;
  private readonly record: StatementSync;
  private readonly patternIds: Set<string>;

  constructor(private readonly db: DatabaseSync, readonly pointer: Pointer, private readonly directory: string, private readonly key: string, readonly root: string) {
    this.pathRow = db.prepare("SELECT path,hash,lang,is_test,mtime_ns,reason FROM paths WHERE path=?");
    this.record = db.prepare("SELECT data FROM main.records WHERE hash=?1 AND lang=?2 UNION ALL SELECT data FROM base.records WHERE hash=?1 AND lang=?2 LIMIT 1");
    const ids = db.prepare("SELECT value FROM meta WHERE key='pattern_ids'").get() as { value: string } | undefined;
    this.patternIds = new Set(ids ? JSON.parse(ids.value) as string[] : []);
  }

  get asOf(): string { return this.pointer.as_of; }
  close(): void { if (this.db.isOpen) this.db.close(); }

  /** A path relative to the checkout with `/`, or undefined when it is outside it. */
  relativePath(path: string): string | undefined {
    if (isAbsolute(path)) {
      // The file system's own spelling (git's), matched against the normalized root.
      let real: string;
      try { real = realpathSync.native(path); } catch { return undefined; }
      const prefix = this.root.endsWith(sep) ? this.root : this.root + sep;
      const normalized = absolutePath(real);
      if (normalized.length !== real.length || !normalized.startsWith(prefix)) return undefined;
      return real.slice(prefix.length).split(sep).join("/") || undefined;
    }
    const value = path.split("\\").join("/").replace(/^(\.\/)+/, "");
    return value || undefined;
  }

  private row(path: string): { rel: string; row: PathRow } | Miss {
    const rel = this.relativePath(path);
    if (!rel) return { path, not_indexed: "not in the index" };
    const row = this.pathRow.get(rel) as unknown as PathRow | undefined;
    if (!row) return { path: rel, not_indexed: "not in the index" };
    if (row.reason || !row.hash || !row.lang) return { path: rel, not_indexed: row.reason ?? "not in the index" };
    return { rel, row };
  }

  private fileRecord(row: PathRow): FileRecord | undefined {
    const found = this.record.get(row.hash!, row.lang!) as { data: string } | undefined;
    return found ? parseRecord(row.hash!, row.lang!, found.data) : undefined;
  }

  outline(path: string): OutlineAnswer | Miss {
    const found = this.row(path);
    if ("not_indexed" in found) return found;
    const record = this.fileRecord(found.row);
    if (!record) return { path: found.rel, not_indexed: "not in the index" };
    const shifted = applyShifts(record.outline, pendingShifts(this.directory, this.key, found.rel, found.row.mtime_ns));
    if (!shifted) return { path: found.rel, not_indexed: "changed since the last parse" };
    return { path: found.rel, as_of: this.asOf, symbols: shifted.outline, dropped: shifted.dropped };
  }

  fileInfo(path: string): FileInfoAnswer | Miss {
    const found = this.row(path);
    if ("not_indexed" in found) return found;
    const record = this.fileRecord(found.row);
    if (!record) return { path: found.rel, not_indexed: "not in the index" };
    return { path: found.rel, lang: record.lang, is_test: found.row.is_test === 1, tokens: record.tokens, lines: record.lines, hash: record.hash };
  }

  /** Every path in the checkout with this file name, indexed or not. */
  filesNamed(basename: string): string[] {
    return (this.db.prepare("SELECT path FROM paths WHERE name=? ORDER BY path").all(basename) as Array<{ path: string }>).map((row) => row.path);
  }

  /** Definitions with this name, with spans moved through pending edits. Callers check it is unique. */
  symbolsNamed(name: string): SymbolHit[] {
    const rows = this.db.prepare(`SELECT p.path, p.mtime_ns, s.kind, s.start, s.end FROM
      (SELECT hash,lang,kind,start,end FROM main.symbols WHERE name=?1 UNION ALL SELECT hash,lang,kind,start,end FROM base.symbols WHERE name=?1) s
      JOIN paths p ON p.hash=s.hash AND p.lang=s.lang WHERE p.reason IS NULL ORDER BY p.path, s.start, s.end, s.kind`).all(name) as Array<{ path: string; mtime_ns: string; kind: SymbolKind; start: number; end: number }>;
    const hits: SymbolHit[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const shifts = pendingShifts(this.directory, this.key, row.path, row.mtime_ns);
      if (shifts.some((shift) => shift.unknown)) continue;
      const span = shiftSpan(row.start, row.end, shifts);
      if (!span) continue;
      const [start, end] = span;
      const id = `${row.path}:${start}:${end}:${row.kind}`;
      if (seen.has(id)) continue;
      seen.add(id);
      hits.push({ path: row.path, start, end, kind: row.kind });
    }
    return hits;
  }

  private scoped(glob: string): PathRow[] {
    const prefix = globPrefix(glob);
    const pattern = globToRegExp(glob);
    const rows = (prefix
      ? this.db.prepare("SELECT path,hash,lang,is_test,mtime_ns,reason FROM paths WHERE path>=? AND path<? ORDER BY path").all(prefix, `${prefix}\u{10FFFF}`)
      : this.db.prepare("SELECT path,hash,lang,is_test,mtime_ns,reason FROM paths ORDER BY path").all()) as unknown as PathRow[];
    return rows.filter((row) => pattern.test(row.path));
  }

  /** Occurrences of each literal pattern over the files in scope. Ids the index doesn't count are left out. */
  patternCounts(scope: string, ids: readonly string[]): Record<string, number> {
    const wanted = [...new Set(ids)].filter((id) => this.patternIds.has(id)).sort();
    const counts: Record<string, number> = Object.fromEntries(wanted.map((id) => [id, 0]));
    if (wanted.length === 0) return counts;
    const files = new Map<string, number>();
    for (const row of this.scoped(scope)) {
      if (row.reason || !row.hash) continue;
      const key = `${row.hash}:${row.lang}`;
      files.set(key, (files.get(key) ?? 0) + 1);
    }
    const marks = wanted.map((_, index) => `?${index + 1}`).join(",");
    const rows = this.db.prepare(`SELECT hash,lang,pattern,count FROM main.counts WHERE pattern IN (${marks})
      UNION SELECT hash,lang,pattern,count FROM base.counts WHERE pattern IN (${marks})`).all(...wanted) as Array<{ hash: string; lang: string; pattern: string; count: number }>;
    for (const row of rows) {
      const times = files.get(`${row.hash}:${row.lang}`);
      if (times) counts[row.pattern] = counts[row.pattern]! + row.count * times;
    }
    return counts;
  }

  /** Indexed or not, with the reason, for one path or a glob. */
  coverage(pathOrGlob: string): CoverageAnswer {
    const literal = !/[*?{]/.test(pathOrGlob) && !pathOrGlob.endsWith("/");
    let rows: PathRow[];
    if (literal) {
      const rel = this.relativePath(pathOrGlob);
      const row = rel ? this.pathRow.get(rel) as unknown as PathRow | undefined : undefined;
      rows = row ? [row] : [];
    } else rows = this.scoped(normalizeGlob(pathOrGlob));
    const answer: CoverageAnswer = { files: rows.length, indexed: 0, not_indexed: {} };
    const shifted = shiftedPathKeys(this.directory, this.key);
    for (const row of rows) {
      let reason = row.reason;
      if (!reason && shifted.has(shortHash(row.path)) && pendingShifts(this.directory, this.key, row.path, row.mtime_ns).some((shift) => shift.unknown)) reason = "changed since the last parse";
      if (reason) answer.not_indexed[reason] = (answer.not_indexed[reason] ?? 0) + 1;
      else answer.indexed++;
    }
    return answer;
  }
}
