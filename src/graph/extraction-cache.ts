// ============================================================================
// mex code-graph — incremental extraction (issue #209)
// ============================================================================
//
// Resolution stays a pure function of every file's extraction, so it cannot go
// stale; only extraction is incremental. Each file's pre-resolution extraction
// is cached, compressed, beside the graph it produced. A refresh re-extracts:
//   * a tree-sitter file only when its own bytes changed: its references are
//     resolved globally afterwards, so its dependents need nothing;
//   * a compiler file when its bytes changed, or when it can observe a changed
//     file through module resolution: the transitive reverse-import closure of
//     the changed files, the importers of deleted files, and the files whose
//     failed lookups name an added file.
// Everything the closure cannot see extracts the corpus in full: a changed
// declaration visible without an import (a script, a `.d.ts`, a global or
// module augmentation), any config byte, a changed non-corpus input, and the
// program-level checks the compiler performs itself.

import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import ts from "typescript";
import type { ImportBindingRecord, UnresolvedRefRecord } from "./db/store.js";
import { declaresGlobals, type CompilerFileCapture } from "./extraction/index.js";
import type { GraphEdge, GraphNode, Language } from "./types.js";

/** Bump whenever a cached payload's shape or meaning changes. */
const EXTRACTION_CACHE_FORMAT = 1;

/**
 * Above this many affected compiler files, and this share of them, extract in
 * full. Capture cost follows the affected set and reuse adds little, so even
 * a large affected set is cheaper incrementally: on Hono, an edit affecting
 * 118 of 384 files refreshed in 30 s where a full extraction took 60 s. Past
 * this share the saving is marginal, and a full extraction also refreshes
 * every cached capture.
 */
const AFFECTED_FILE_FLOOR = 100;
const AFFECTED_SHARE_LIMIT = 0.7;

/** A tree-sitter file's staged extraction, without its write times. */
export interface CachedTreeFile {
  language: Language;
  nodes: GraphNode[];
  edges: GraphEdge[];
  references: UnresolvedRefRecord[];
  imports: ImportBindingRecord[];
  errors?: Array<Record<string, unknown>>;
  parseStatus?: "ok" | "partial" | "failed";
  diagnosticCount?: number;
  missingCount?: number;
  errorCoverage?: number;
  extractorVersion?: string;
}

export type CachedExtraction =
  | { format: typeof EXTRACTION_CACHE_FORMAT; kind: "compiler"; capture: CompilerFileCapture }
  | { format: typeof EXTRACTION_CACHE_FORMAT; kind: "tree"; file: CachedTreeFile };

export function encodeCachedExtraction(
  entry: { kind: "compiler"; capture: CompilerFileCapture } | { kind: "tree"; file: CachedTreeFile },
): Buffer {
  return deflateRawSync(Buffer.from(JSON.stringify({ format: EXTRACTION_CACHE_FORMAT, ...entry }), "utf8"));
}

/** Null for a payload this build cannot read; the caller extracts in full. */
export function decodeCachedExtraction(payload: Uint8Array): CachedExtraction | null {
  try {
    const entry = JSON.parse(inflateRawSync(payload).toString("utf8")) as CachedExtraction;
    return entry.format === EXTRACTION_CACHE_FORMAT && (entry.kind === "compiler" || entry.kind === "tree")
      ? entry
      : null;
  } catch {
    return null;
  }
}

/**
 * Package metadata that neither module resolution nor the checker reads. A
 * release commit that bumps `version` must not discard every cached
 * extraction; every other field, including `name`, `main`, `types`,
 * `typesVersions`, `exports` and `imports`, still counts byte for byte.
 */
const PACKAGE_METADATA_FIELDS = new Set([
  "version", "description", "keywords", "author", "contributors", "maintainers", "license",
  "repository", "bugs", "homepage", "funding", "scripts", "engines", "publishConfig", "packageManager",
]);
/** Dependency maps: the checker reads installed packages, never these version ranges. */
const DEPENDENCY_MAPS = new Set(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]);

/**
 * What every cached extraction was produced under. The manifest covers the
 * engine versions, grammars and the resolution-relevant config projection;
 * the config sources are added nearly byte for byte, because a field outside
 * that projection may still steer module resolution for one importer. Only
 * package metadata is left out. Installed dependencies are compared through
 * each program's input state instead.
 */
export function extractionCacheIdentity(
  manifestHash: string,
  configSources: ReadonlyMap<string, string>,
): string {
  const hash = createHash("sha256").update(`format ${EXTRACTION_CACHE_FORMAT}\n${manifestHash}\n`);
  for (const [path, source] of [...configSources.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    const identity = path === "package.json" || path.endsWith("/package.json") ? packageIdentity(source) : source;
    hash.update(`${path}\0${createHash("sha256").update(identity).digest("hex")}\n`);
  }
  return hash.digest("hex");
}

function packageIdentity(source: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return source;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return source;
  const kept = Object.entries(parsed as Record<string, unknown>)
    .filter(([key]) => !PACKAGE_METADATA_FIELDS.has(key))
    .map(([key, value]): [string, unknown] => [key, DEPENDENCY_MAPS.has(key) && value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value).sort()
      : value])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `package-identity:${JSON.stringify(kept)}`;
}

export interface StoredExtraction {
  contentHash: string;
  payload: Uint8Array;
}

export interface IncrementalExtractionPlan {
  /** Previous captures of every compiler file still in the corpus. */
  captures: Map<string, CompilerFileCapture>;
  /** Compiler files to capture again. */
  affected: Set<string>;
  /** Unchanged tree-sitter files and their cached extraction. */
  trees: Map<string, CachedTreeFile>;
}

/**
 * Plan an incremental extraction, or return why the corpus must be extracted
 * in full. `current` maps every discovered file to its content hash;
 * `isCompilerFile` says which of them the compiler extracts; `readSource`
 * reads a changed compiler file so its new version can be checked for
 * declarations visible without an import.
 */
export function planIncrementalExtraction(
  stored: ReadonlyMap<string, StoredExtraction>,
  current: ReadonlyMap<string, string>,
  isCompilerFile: (path: string) => boolean,
  readSource: (path: string) => string,
): IncrementalExtractionPlan | { reason: string } {
  const captures = new Map<string, CompilerFileCapture>();
  const trees = new Map<string, CachedTreeFile>();
  const changed: string[] = [];
  const added = new Set<string>();
  for (const [path, contentHash] of current) {
    const entry = stored.get(path);
    if (!entry) {
      changed.push(path);
      added.add(path);
      continue;
    }
    const decoded = decodeCachedExtraction(entry.payload);
    if (!decoded) return { reason: "a cached extraction is unreadable" };
    if (decoded.kind === "compiler") {
      if (decoded.capture.globalScope && entry.contentHash !== contentHash) {
        return { reason: "a global declaration changed" };
      }
      captures.set(path, decoded.capture);
    } else if (entry.contentHash === contentHash) {
      trees.set(path, decoded.file);
    }
    if (entry.contentHash !== contentHash) changed.push(path);
  }
  const deleted = [...stored.keys()].filter((path) => !current.has(path));
  for (const path of deleted) {
    const decoded = decodeCachedExtraction(stored.get(path)!.payload);
    if (!decoded) return { reason: "a cached extraction is unreadable" };
    if (decoded.kind === "compiler" && decoded.capture.globalScope) return { reason: "a global declaration changed" };
  }
  for (const path of changed) {
    if (isCompilerFile(path) && declaresGlobalsWithoutBinding(path, readSource(path))) {
      return { reason: "a global declaration changed" };
    }
  }

  const deletedSet = new Set(deleted);
  const importers = new Map<string, string[]>();
  const seeds = new Set(changed.filter(isCompilerFile));
  for (const [path, capture] of captures) {
    for (const dependency of capture.dependencies) {
      const bucket = importers.get(dependency) ?? [];
      bucket.push(path);
      importers.set(dependency, bucket);
      if (deletedSet.has(dependency)) seeds.add(path);
    }
    if (capture.failedLookups.some((lookup) => added.has(lookup))) seeds.add(path);
  }
  const affected = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (affected.has(path)) continue;
    affected.add(path);
    for (const importer of importers.get(path) ?? []) if (!affected.has(importer)) queue.push(importer);
  }
  const compilerFiles = [...current.keys()].filter(isCompilerFile).length;
  if (affected.size > Math.max(AFFECTED_FILE_FLOOR, AFFECTED_SHARE_LIMIT * compilerFiles)) {
    return { reason: "the affected set exceeds 70% of compiler files" };
  }
  return { captures, affected, trees };
}

/**
 * The parser-only check for a changed compiler file: a declaration file, a
 * global or module augmentation, or a TypeScript script. A JavaScript file
 * without ES module syntax may be a CommonJS module or a script, which only
 * binding tells apart; the compiler checks those itself through each
 * program's global input state.
 */
function declaresGlobalsWithoutBinding(path: string, source: string): boolean {
  if (/\.d\.[cm]?ts$/iu.test(path)) return true;
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
  if (declaresGlobals(sourceFile)) return true;
  const isJavaScript = /\.[cm]?jsx?$/iu.test(path);
  const esModule = (sourceFile as ts.SourceFile & { externalModuleIndicator?: unknown }).externalModuleIndicator !== undefined;
  return !isJavaScript && !esModule;
}
