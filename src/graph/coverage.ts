import fs from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { SqliteDatabase } from "./db/sqlite.js";
import {
  GRAPH_COVERAGE_LIMITS, graphCorpusPolicyHash, OTHER_KNOWN_SOURCE_EXTENSIONS,
  unindexedExtensionHistogram, type GraphCoverageHistogram,
} from "./corpus-policy.js";
import { isSupportedSourceFile } from "./extraction/grammars.js";

export const GRAPH_COVERAGE_METADATA_KEY = "unindexed_source_coverage";
export const COVERAGE_CACHE_LIMITS = Object.freeze({ directories: 2048, entries: 100_000, bytes: 512 * 1024 });
export type CoverageCacheLimits = { directories: number; entries: number; bytes: number };
type DirectoryStamp = { path: string; stamp: string };
interface CoverageCache {
  version: 1;
  policy: string;
  histogram: GraphCoverageHistogram;
  /** Empty when the build could not afford to stamp the tree (too many directories or entries). */
  directories: DirectoryStamp[];
}

/**
 * A stored coverage observation.
 *
 * `verified` means every stamped directory still matches and the caller's graph
 * is current, so the counts are exact now. Otherwise the counts are exact as of
 * the last graph build only: callers say so rather than drop them, because an
 * unrelated directory change (an editor's atomic save, a new test file) says
 * nothing about which languages the repository contains.
 */
export interface GraphCoverageObservation {
  histogram: GraphCoverageHistogram;
  verified: boolean;
}

/** Stamp only what directory entry changes move. Capture-time containment is checked separately. */
function lstatStamp(absolute: string): string {
  const stats = fs.lstatSync(absolute, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Not a coverage directory");
  return [stats.dev, stats.ino, stats.mtimeNs, stats.ctimeNs].join(":");
}

function containedStamp(root: string, canonicalRoot: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(canonicalRoot, fs.realpathSync.native(absolute));
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("Outside coverage root");
  return lstatStamp(absolute);
}

function policy(root: string): string {
  return JSON.stringify([graphCorpusPolicyHash(root), [...OTHER_KNOWN_SOURCE_EXTENSIONS]
    .filter((extension) => !isSupportedSourceFile(`source${extension}`))]);
}

/**
 * Build-only observation. Directory entry changes invalidate verification without a read-time walk.
 *
 * Past the directory or entry budget the walk still finishes (the build's own
 * discovery has just walked the same tree) but stops stamping, so the counts
 * stay available as a last-build observation instead of disappearing on the
 * large repositories where they matter most.
 */
export function captureGraphCoverage(root: string, limits: CoverageCacheLimits = COVERAGE_CACHE_LIMITS): string {
  const directories = new Map<string, string>();
  let entries = 0;
  let failed = false;
  let stamping = true;
  let canonicalRoot: string;
  try { canonicalRoot = fs.realpathSync.native(root); } catch { return "null"; }
  const readdirSync: typeof fs.readdirSync = ((path: fs.PathLike, options: unknown) => {
    try {
      if (failed) throw new Error("Coverage observation already stopped");
      if (!(options as { withFileTypes?: boolean })?.withFileTypes) throw new Error("Unexpected directory options");
      if (!stamping) return fs.readdirSync(path, { withFileTypes: true });
      const rel = relative(resolve(root), String(path)).split("\\").join("/") || ".";
      if (!directories.has(rel) && directories.size >= limits.directories) {
        stamping = false;
        return fs.readdirSync(path, { withFileTypes: true });
      }
      const before = containedStamp(root, canonicalRoot, rel);
      // Glob requests Dirents. Stream the directory so even one huge directory
      // cannot allocate an unbounded readdir array before the limit is checked.
      const result: fs.Dirent[] = [];
      const directory = fs.opendirSync(path);
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (++entries > limits.entries) { stamping = false; break; }
          result.push(entry);
        }
      } finally { directory.closeSync(); }
      if (!stamping) return fs.readdirSync(path, { withFileTypes: true });
      if (before !== containedStamp(root, canonicalRoot, rel)) throw new Error("Directory changed");
      directories.set(rel, before);
      return result;
    } catch (error) {
      failed = true;
      throw error;
    }
  }) as typeof fs.readdirSync;
  try {
    const histogram = unindexedExtensionHistogram(root, GRAPH_COVERAGE_LIMITS, { ...fs, readdirSync });
    if (failed || (stamping && directories.size === 0)) return "null";
    const stamped = stamping ? [...directories].map(([path, stamp]) => ({ path, stamp })) : [];
    if (!stamped.every((entry) => containedStamp(root, canonicalRoot, entry.path) === entry.stamp)) return "null";
    const cache: CoverageCache = { version: 1, policy: policy(root), histogram, directories: stamped };
    const raw = JSON.stringify(cache);
    return Buffer.byteLength(raw) <= limits.bytes ? raw : JSON.stringify({ ...cache, directories: [] });
  } catch { return "null"; }
}

/** Legacy indexes have no coverage observation; distinguish them from an unreadable one. */
export function hasGraphCoverageCache(db: SqliteDatabase): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM project_metadata WHERE key = ?").get(GRAPH_COVERAGE_METADATA_KEY));
  } catch { return false; }
}

export interface ReadGraphCoverageOptions {
  /** The caller's own freshness observation; a stale graph never verifies. */
  graphCurrent: boolean;
  /**
   * `"when-reported"` skips directory stamps when the stored histogram is empty.
   * Nobody reports an empty histogram (a fully covered repository keeps its
   * prior output either way), so verifying it would only add filesystem work
   * to every read. The cost: an unsupported file added to a previously fully
   * covered repository stays silent until the next build, as it was before
   * coverage reporting existed.
   */
  verify: "always" | "when-reported";
}

/** No discovery, source reads, or writes. Malformed or foreign-policy metadata yields null (unknown). */
export function readGraphCoverageObservation(
  db: SqliteDatabase,
  root: string,
  options: ReadGraphCoverageOptions,
): GraphCoverageObservation | null {
  try {
    const row = db.prepare("SELECT value FROM project_metadata WHERE key = ? AND length(CAST(value AS BLOB)) <= ?")
      .get(GRAPH_COVERAGE_METADATA_KEY, COVERAGE_CACHE_LIMITS.bytes) as { value?: unknown } | undefined;
    if (typeof row?.value !== "string" || Buffer.byteLength(row.value) > COVERAGE_CACHE_LIMITS.bytes) return null;
    const cache = JSON.parse(row.value) as CoverageCache | null;
    if (!cache || cache.version !== 1 || cache.policy !== policy(root)
      || !Array.isArray(cache.directories) || cache.directories.length > COVERAGE_CACHE_LIMITS.directories) return null;
    const histogram = cache.histogram;
    if (!histogram || !Number.isSafeInteger(histogram.total) || histogram.total < 0
      || histogram.total > GRAPH_COVERAGE_LIMITS.maxUnindexedFiles || typeof histogram.truncated !== "boolean"
      || !Array.isArray(histogram.entries) || histogram.entries.length > GRAPH_COVERAGE_LIMITS.maxUnindexedEntries) return null;
    const extensions = new Set<string>();
    let sum = 0;
    for (const entry of histogram.entries) {
      if (!entry || !OTHER_KNOWN_SOURCE_EXTENSIONS.has(entry.extension) || extensions.has(entry.extension)
        || isSupportedSourceFile(`source${entry.extension}`) || !Number.isSafeInteger(entry.files) || entry.files <= 0) return null;
      extensions.add(entry.extension);
      sum += entry.files;
    }
    if (sum > histogram.total || (histogram.total > 0 && sum === 0)) return null;
    const paths = new Set<string>();
    for (const entry of cache.directories) {
      if (!entry || typeof entry.path !== "string" || entry.path.length > 4096
        || (entry.path !== "." && (!entry.path || entry.path.startsWith("/") || entry.path.includes("\\")
          || entry.path.includes(":") || entry.path.split("/").some((part) => !part || part === "." || part === "..")))
        || paths.has(entry.path) || typeof entry.stamp !== "string" || !/^\d+:\d+:\d+:\d+$/u.test(entry.stamp)) return null;
      paths.add(entry.path);
    }
    if (cache.directories.length > 0 && !paths.has(".")) return null;
    const empty = histogram.total === 0 && !histogram.truncated;
    if (!options.graphCurrent || cache.directories.length === 0 || (empty && options.verify === "when-reported")) {
      return { histogram, verified: false };
    }
    // Paths were validated as normalized and relative above, and containment
    // was proven when they were stamped at build time. A directory later
    // replaced by a link fails `lstatStamp`, and a changed ancestor fails its
    // own stamp, so reads need no realpath, which is most of the cost on Windows.
    for (const entry of cache.directories) {
      try {
        if (lstatStamp(resolve(root, entry.path)) !== entry.stamp) return { histogram, verified: false };
      } catch { return { histogram, verified: false }; }
    }
    return { histogram, verified: true };
  } catch { return null; }
}

/** Exact counts only: a stale graph, changed directories, or unreadable metadata yields null. */
export function readGraphCoverage(db: SqliteDatabase, root: string, fresh: boolean): GraphCoverageHistogram | null {
  const observation = readGraphCoverageObservation(db, root, { graphCurrent: fresh, verify: "always" });
  return observation?.verified ? observation.histogram : null;
}

/** Caller supplies its existing status observation; immutable open validates the store again. */
export async function readStoredGraphCoverage(
  root: string,
  graphCurrent: boolean,
): Promise<GraphCoverageObservation | null> {
  try {
    const { openImmutableGraphReadSessionSync } = await import("./read-session.js");
    const session = openImmutableGraphReadSessionSync(root, resolve(root, ".mex", "graph.db"));
    try {
      const coverage = readGraphCoverageObservation(session.db, root, { graphCurrent, verify: "always" });
      return session.validate().valid ? coverage : null;
    } finally { session.close(); }
  } catch { return null; }
}

/** True when an observation changes what a reader should conclude. */
export function coverageReportable(histogram: GraphCoverageHistogram): boolean {
  return histogram.total > 0 || histogram.truncated;
}

export function coverageFields(coverage: GraphCoverageObservation | null): Record<string, unknown> {
  if (!coverage || !coverageReportable(coverage.histogram)) return {};
  const { histogram } = coverage;
  return {
    unindexedSources: {
      total: histogram.total,
      byExtension: Object.fromEntries(histogram.entries.map((entry) => [entry.extension, entry.files])),
      truncated: histogram.truncated,
      ...(coverage.verified ? {} : { observedAt: "last-build" }),
    },
  };
}
