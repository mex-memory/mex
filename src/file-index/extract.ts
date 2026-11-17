import { contentHash, countLiteral, langOf, lineStarts, looksBinary } from "./classify.js";
import { parseJs, type ParsedFile } from "./parse-js.js";
import { parseTreeSitter } from "./parse-tree-sitter.js";
import { CHARS_PER_TOKEN, MAX_FILE_BYTES, type FileRecord, type IndexPattern, type NotIndexedReason } from "./types.js";

export type Extracted = { record: FileRecord } | { reason: NotIndexedReason };

const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * One file's bytes to its record. `path` is relative to the checkout with `/`
 * separators and decides the language. Tree-sitter grammars must be loaded
 * first (prepareTreeSitter) for Python, Rust and C#.
 */
export function extractFile(path: string, bytes: Uint8Array, patterns: readonly IndexPattern[]): Extracted {
  if (bytes.length > MAX_FILE_BYTES) return { reason: "too big" };
  if (looksBinary(bytes)) return { reason: "binary" };
  const text = decoder.decode(bytes);
  const lang = langOf(path);
  let parsed: ParsedFile | null = null;
  if (lang === "ts" || lang === "tsx" || lang === "js") parsed = parseJs(path, text, lang);
  else if (lang === "py" || lang === "rs" || lang === "cs") parsed = parseTreeSitter(text, lang);
  return { record: buildRecord(bytes, text, lang, parsed, patterns) };
}

export function buildRecord(bytes: Uint8Array, text: string, lang: FileRecord["lang"], parsed: ParsedFile | null, patterns: readonly IndexPattern[]): FileRecord {
  const counts: Record<string, number> = {};
  for (const pattern of patterns) {
    const count = countLiteral(text, pattern.pattern);
    if (count > 0) counts[pattern.id] = count;
  }
  const outline = parsed?.outline ?? [];
  const imports = parsed?.imports ?? [];
  const exports = parsed?.exports ?? [];
  const names = new Set<string>();
  for (const item of outline) if (item.kind !== "test") names.add(item.name);
  for (const item of imports) for (const name of item.names) names.add(name);
  for (const name of exports) names.add(name);
  names.delete("*");
  names.delete("default");
  const record: FileRecord = {
    hash: contentHash(bytes),
    lang,
    outline,
    imports,
    exports,
    names: [...names].sort(),
    patterns: counts,
    tokens: Math.ceil(text.length / CHARS_PER_TOKEN),
    lines: text.length === 0 ? 0 : lineStarts(text).length - (text.endsWith("\n") ? 1 : 0),
  };
  if (parsed?.error) record.parse_error = parsed.error;
  else if (parsed === null && lang !== "other") record.parse_error = "no parser available";
  return record;
}
