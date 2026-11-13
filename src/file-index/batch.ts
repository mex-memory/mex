import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { contentHash, isTestFile, langOf, looksBinary } from "./classify.js";
import { skippedByRule } from "./discover.js";
import { extractFile } from "./extract.js";
import { prepareTreeSitter } from "./parse-tree-sitter.js";
import { RecordSource, type PathRow } from "./store.js";
import { MAX_FILE_BYTES, type FileRecord, type IndexPattern, type Lang } from "./types.js";

/** Work for one batch. Everything is plain data so it can cross to a worker thread. */
export interface BatchInput {
  root: string;
  paths: string[];
  /** Previous rows for these paths; a matching size and mtime means unchanged. */
  previous: Record<string, Pick<PathRow, "size" | "mtime_ns" | "hash" | "lang" | "reason" | "is_test">>;
  /** Snapshot files whose records can be reused by content hash. */
  sources: string[];
  patterns: IndexPattern[];
  /** False when the previous records are stale (new patterns or extractor). */
  reuse: boolean;
}

export interface BatchRow extends PathRow {
  /** Set when this batch parsed the file; otherwise the record comes from `sources`. */
  record?: FileRecord;
}

export interface BatchOutput { rows: BatchRow[]; read: number; parsed: number; reused: number; unchanged: number }

let grammars: Promise<void> = Promise.resolve();

/** Load tree-sitter grammars only for the languages this batch has, one load at a time (web-tree-sitter can't load two at once). */
function prepareFor(paths: readonly string[]): Promise<void> {
  const langs = new Set<Lang>();
  for (const path of paths) {
    const lang = langOf(path);
    if (lang === "py" || lang === "rs" || lang === "cs") langs.add(lang);
  }
  grammars = grammars.then(() => prepareTreeSitter(langs));
  return grammars;
}

/** Stat every path; read, hash and parse only what changed. */
export async function processBatch(input: BatchInput): Promise<BatchOutput> {
  await prepareFor(input.paths);
  const source = input.reuse ? new RecordSource(input.sources) : undefined;
  const out: BatchOutput = { rows: [], read: 0, parsed: 0, reused: 0, unchanged: 0 };
  try {
    for (const path of input.paths) out.rows.push(processPath(input, path, source, out));
  } finally { source?.close(); }
  return out;
}

function processPath(input: BatchInput, path: string, source: RecordSource | undefined, out: BatchOutput): BatchRow {
  const lang: Lang = langOf(path);
  const empty: BatchRow = { path, hash: null, lang: null, is_test: isTestFile(path), size: 0, mtime_ns: "0", reason: null };
  if (skippedByRule(path)) return { ...empty, reason: "ignored" };
  let stat;
  try { stat = statSync(join(input.root, path), { bigint: true }); } catch { return { ...empty, reason: "unreadable" }; }
  if (!stat.isFile()) return { ...empty, reason: "unreadable" };
  const row: BatchRow = { ...empty, size: Number(stat.size), mtime_ns: stat.mtimeNs.toString() };
  if (stat.size > BigInt(MAX_FILE_BYTES)) return { ...row, reason: "too big" };
  const before = input.previous[path];
  if (input.reuse && before && before.size === row.size && before.mtime_ns === row.mtime_ns) {
    out.unchanged++;
    return { ...row, hash: before.hash, lang: before.lang, reason: before.reason, is_test: before.is_test };
  }
  let bytes: Buffer;
  try { bytes = readFileSync(join(input.root, path)); } catch { return { ...row, reason: "unreadable" }; }
  out.read++;
  row.size = bytes.length;
  if (looksBinary(bytes)) return { ...row, reason: "binary" };
  const hash = contentHash(bytes);
  const known = source?.get(hash, lang);
  if (known) {
    out.reused++;
    return { ...row, hash, lang, is_test: isTestFile(path, known.imports.map((item) => item.from)), reason: known.parse_error ? "parse failed" : null };
  }
  const extracted = extractFile(path, bytes, input.patterns);
  if ("reason" in extracted) return { ...row, reason: extracted.reason };
  out.parsed++;
  const record = extracted.record;
  return {
    ...row, hash: record.hash, lang: record.lang, record,
    is_test: isTestFile(path, record.imports.map((item) => item.from)),
    reason: record.parse_error ? "parse failed" : null,
  };
}

/** The record for a file's text, as a build would make it (tests and the edit replay). */
export async function recordFor(path: string, text: string, patterns: readonly IndexPattern[] = []): Promise<FileRecord | undefined> {
  await prepareFor([path]);
  const extracted = extractFile(path, Buffer.from(text, "utf8"), patterns);
  return "record" in extracted ? extracted.record : undefined;
}
