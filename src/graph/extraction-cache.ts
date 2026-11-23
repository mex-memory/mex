import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { ImportBindingRecord, UnresolvedRefRecord } from "./db/store.js";
import type { GraphEdge, GraphNode, Language } from "./types.js";

/** Bump whenever a cached payload's shape or meaning changes. */
const EXTRACTION_CACHE_FORMAT = 5;

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

export function encodeCachedExtraction(file: CachedTreeFile): Buffer {
  return deflateRawSync(Buffer.from(JSON.stringify({ format: EXTRACTION_CACHE_FORMAT, file }), "utf8"));
}

/** Null for a payload this build cannot read; the caller extracts in full. */
function decodeCachedExtraction(payload: Uint8Array): CachedTreeFile | null {
  try {
    const entry = JSON.parse(inflateRawSync(payload).toString("utf8")) as { format: number; file: CachedTreeFile };
    return entry.format === EXTRACTION_CACHE_FORMAT && entry.file ? entry.file : null;
  } catch {
    return null;
  }
}

/**
 * Package metadata that does not affect resolution. A
 * release commit that bumps `version` must not discard every cached
 * extraction; every other field, including `name`, `main`, `types`,
 * `typesVersions`, `exports` and `imports`, still counts byte for byte.
 */
const PACKAGE_METADATA_FIELDS = new Set([
  "version", "description", "keywords", "author", "contributors", "maintainers", "license",
  "repository", "bugs", "homepage", "funding", "scripts", "engines", "publishConfig", "packageManager",
]);
/** A dependency name can affect resolution, whereas its version cannot. */
const DEPENDENCY_MAPS = new Set(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]);

/**
 * What every cached extraction was produced under. The manifest covers the
 * engine versions, grammars and the resolution-relevant config projection;
 * the config sources are added nearly byte for byte, because a field outside
 * that projection may still steer module resolution for one importer. Only
 * package metadata is left out.
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
  trees: Map<string, CachedTreeFile>;
}

/** Reuse unchanged files before resolving the whole corpus against current inputs. */
export function planIncrementalExtraction(
  stored: ReadonlyMap<string, StoredExtraction>,
  current: ReadonlyMap<string, string>,
): IncrementalExtractionPlan | { reason: string } {
  const trees = new Map<string, CachedTreeFile>();
  for (const [path, contentHash] of current) {
    const entry = stored.get(path);
    if (!entry || entry.contentHash !== contentHash) continue;
    const file = decodeCachedExtraction(entry.payload);
    if (!file) return { reason: "a cached extraction is unreadable" };
    trees.set(path, file);
  }
  return { trees };
}
