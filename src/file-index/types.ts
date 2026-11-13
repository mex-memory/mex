/**
 * The file index: per-file facts that hooks read in well under a millisecond.
 * The contract is mex-design `oss/0.9/contracts/file-index.md`; this module is
 * the Node side (the indexer and one of the two readers). The Go reader in
 * `native/index` must give the same answers.
 */

export type Lang = "ts" | "tsx" | "js" | "py" | "rs" | "cs" | "other";

export type SymbolKind =
  | "function" | "class" | "method" | "property" | "interface" | "type" | "enum"
  | "namespace" | "const" | "variable" | "test" | "struct" | "trait" | "impl" | "module";

/** One symbol. Lines are 1-based and inclusive. `parent` is the index of the enclosing symbol. */
export interface OutlineItem {
  name: string;
  kind: SymbolKind;
  start: number;
  end: number;
  parent?: number;
}

export interface ImportItem { from: string; names: string[] }

/**
 * Everything the index knows about one file content, keyed by hash and language
 * (the extension decides the parser). The test flag depends on the path, so it
 * lives on the checkout's path row, not here.
 */
export interface FileRecord {
  hash: string;
  lang: Lang;
  outline: OutlineItem[];
  imports: ImportItem[];
  exports: string[];
  /** Identifiers this file defines, imports or exports. */
  names: string[];
  /** Literal pattern id → occurrences in the file. Zero counts are left out. */
  patterns: Record<string, number>;
  /** Approximate token count (4 characters per token). */
  tokens: number;
  lines: number;
  /** Set when the parser failed; the record still has hash, tokens and patterns. */
  parse_error?: string;
}

/** Why a file has no record. A path with no row at all isn't in the checkout. */
export type NotIndexedReason = "too big" | "binary" | "ignored" | "parse failed" | "unreadable" | "changed since the last parse";

/** Why a read has no answer: a reason for a listed file, or no listing at all. */
export type ReadMiss = NotIndexedReason | "not in the index" | "no index";

/** A literal `when:` pattern the index counts per file. Structural ones run on edits (delivery-03). */
export interface IndexPattern { id: string; match: "literal"; pattern: string }

/** Bump when extraction output changes, so stored records are rebuilt. */
export const EXTRACTOR_VERSION = 1;

/** Files larger than this are listed as `too big` and not read. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

export const CHARS_PER_TOKEN = 4;
