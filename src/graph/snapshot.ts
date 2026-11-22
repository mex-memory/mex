import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isGraphEngineFallbackReason } from "./engine-languages.js";
import type { GraphEngineFallback } from "./engine.js";
import type { GraphEngineRuntime } from "../team/contracts/graph.js";

export const GRAPH_SNAPSHOT_METADATA_KEY = "graph_snapshot_v1" as const;
export const GRAPH_SNAPSHOT_VERSION = 1 as const;

export type GraphSnapshotParseStatus = "ok" | "partial" | "failed";

export interface GraphSnapshotParseHealth {
  total: number;
  ok: number;
  partial: number;
  failed: number;
}

/** Canonical provenance for the last graph snapshot that completed publication. */
export interface GraphSnapshot {
  version: typeof GRAPH_SNAPSHOT_VERSION;
  indexedAt: string;
  lastSuccessfulIndexAt: string;
  indexedBranch: string | null;
  indexedHead: string | null;
  schemaVersion: number;
  extractorVersion: string;
  resolverVersion: string;
  grammarHash: string;
  configHash: string;
  manifestHash: string;
  sourceCorpusDigest: string;
  sourceCount: number;
  engineFallback?: GraphEngineFallback;
  engineRuntime?: GraphEngineRuntime;
  nativeEngineUnavailable?: string;
  parseHealth: GraphSnapshotParseHealth;
}

export interface GraphSnapshotSource {
  path: string;
  contentHash: string;
  parseStatus: GraphSnapshotParseStatus;
}

export interface GraphGitProvenance {
  branch: string | null;
  head: string | null;
  /** Git could not be read (a timeout or a missing executable): never evidence of a change. */
  unreadable?: true;
}

export interface CreateGraphSnapshotInput {
  indexedAt: string;
  git: GraphGitProvenance;
  schemaVersion: number;
  extractorVersion: string;
  resolverVersion: string;
  grammarHash: string;
  configHash: string;
  manifestHash: string;
  sources: readonly GraphSnapshotSource[];
  engineFallback?: GraphEngineFallback;
  engineRuntime?: GraphEngineRuntime;
  nativeEngineUnavailable?: string;
}

/** Hash only stable corpus identity: sorted repository path and exact content hash. */
export function computeSourceCorpusDigest(
  sources: readonly Pick<GraphSnapshotSource, "path" | "contentHash">[],
): string {
  const canonical = sources
    .map(({ path, contentHash }) => [path, contentHash] as const)
    .sort(([leftPath, leftHash], [rightPath, rightHash]) => (
      compareText(leftPath, rightPath) || compareText(leftHash, rightHash)
    ));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function createGraphSnapshot(input: CreateGraphSnapshotInput): GraphSnapshot {
  const parseHealth = countParseHealth(input.sources);
  return {
    version: GRAPH_SNAPSHOT_VERSION,
    indexedAt: input.indexedAt,
    lastSuccessfulIndexAt: input.indexedAt,
    indexedBranch: input.git.branch,
    indexedHead: input.git.head,
    schemaVersion: input.schemaVersion,
    extractorVersion: input.extractorVersion,
    resolverVersion: input.resolverVersion,
    grammarHash: input.grammarHash,
    configHash: input.configHash,
    manifestHash: input.manifestHash,
    sourceCorpusDigest: computeSourceCorpusDigest(input.sources),
    sourceCount: input.sources.length,
    ...(input.engineFallback ? { engineFallback: input.engineFallback } : {}),
    ...(input.engineRuntime ? { engineRuntime: input.engineRuntime } : {}),
    ...(input.nativeEngineUnavailable ? { nativeEngineUnavailable: input.nativeEngineUnavailable } : {}),
    parseHealth,
  };
}

/** Serialize in one fixed field order so the metadata value is canonical. */
export function serializeGraphSnapshot(snapshot: GraphSnapshot): string {
  return JSON.stringify({
    version: GRAPH_SNAPSHOT_VERSION,
    indexedAt: snapshot.indexedAt,
    lastSuccessfulIndexAt: snapshot.lastSuccessfulIndexAt,
    indexedBranch: snapshot.indexedBranch,
    indexedHead: snapshot.indexedHead,
    schemaVersion: snapshot.schemaVersion,
    extractorVersion: snapshot.extractorVersion,
    resolverVersion: snapshot.resolverVersion,
    grammarHash: snapshot.grammarHash,
    configHash: snapshot.configHash,
    manifestHash: snapshot.manifestHash,
    sourceCorpusDigest: snapshot.sourceCorpusDigest,
    sourceCount: snapshot.sourceCount,
    ...(snapshot.engineFallback ? { engineFallback: snapshot.engineFallback } : {}),
    ...(snapshot.engineRuntime ? { engineRuntime: snapshot.engineRuntime } : {}),
    ...(snapshot.nativeEngineUnavailable ? { nativeEngineUnavailable: snapshot.nativeEngineUnavailable } : {}),
    parseHealth: {
      total: snapshot.parseHealth.total,
      ok: snapshot.parseHealth.ok,
      partial: snapshot.parseHealth.partial,
      failed: snapshot.parseHealth.failed,
    },
  });
}

/** Parse persisted metadata defensively; malformed or unsupported snapshots are absent. */
export function parseGraphSnapshot(value: string | null | undefined): GraphSnapshot | null {
  if (value == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== GRAPH_SNAPSHOT_VERSION) return null;
  if (!isIsoTimestamp(parsed.indexedAt) || !isIsoTimestamp(parsed.lastSuccessfulIndexAt)) return null;
  if (!isNullableString(parsed.indexedBranch) || !isNullableString(parsed.indexedHead)) return null;
  if (!isNonNegativeInteger(parsed.schemaVersion)) return null;
  if (!isNonEmptyString(parsed.extractorVersion)
    || !isNonEmptyString(parsed.resolverVersion)) return null;
  if (!isDigest(parsed.grammarHash)
    || !isDigest(parsed.configHash)
    || !isDigest(parsed.manifestHash)
    || !isDigest(parsed.sourceCorpusDigest)) return null;
  if (!isNonNegativeInteger(parsed.sourceCount)
    || !isRecord(parsed.parseHealth)) return null;
  const engineFallback = parseEngineFallback(parsed.engineFallback);
  if (parsed.engineFallback !== undefined && !engineFallback) return null;
  const { engineRuntime, nativeEngineUnavailable } = parsed;
  if (engineRuntime != null && engineRuntime !== "native" && engineRuntime !== "wasi" && engineRuntime !== "node") return null;
  if (nativeEngineUnavailable != null && (engineRuntime !== "wasi" || !isGraphEngineFallbackReason(nativeEngineUnavailable))) return null;
  const { total, ok, partial, failed } = parsed.parseHealth;
  if (!isNonNegativeInteger(total)
    || !isNonNegativeInteger(ok)
    || !isNonNegativeInteger(partial)
    || !isNonNegativeInteger(failed)) return null;
  if (total !== parsed.sourceCount || ok + partial + failed !== total
    || (engineFallback && engineFallback.files + engineFallback.fallbackFiles > total)) return null;

  return {
    version: GRAPH_SNAPSHOT_VERSION,
    indexedAt: parsed.indexedAt,
    lastSuccessfulIndexAt: parsed.lastSuccessfulIndexAt,
    indexedBranch: parsed.indexedBranch,
    indexedHead: parsed.indexedHead,
    schemaVersion: parsed.schemaVersion,
    extractorVersion: parsed.extractorVersion,
    resolverVersion: parsed.resolverVersion,
    grammarHash: parsed.grammarHash,
    configHash: parsed.configHash,
    manifestHash: parsed.manifestHash,
    sourceCorpusDigest: parsed.sourceCorpusDigest,
    sourceCount: parsed.sourceCount,
    ...(engineFallback ? { engineFallback } : {}),
    ...(engineRuntime ? { engineRuntime } : {}),
    ...(typeof nativeEngineUnavailable === "string" ? { nativeEngineUnavailable } : {}),
    parseHealth: { total, ok, partial, failed },
  };
}

/**
 * Read branch and HEAD with `git symbolic-ref` and `git rev-parse`, which read
 * refs only: no tree scan, no index lock. A non-repository, an unborn HEAD or a
 * detached HEAD is the corresponding null provenance. A read that fails to
 * run at all (a timeout, a missing executable) is read once more; if it still
 * fails the result is marked `unreadable`, and callers must not compare it as
 * a branch or HEAD change.
 */
export function readGraphGitProvenance(rootDir: string): GraphGitProvenance {
  for (let attempt = 0; ; attempt++) {
    const provenance = readGitRefsOnce(rootDir);
    if (!provenance.unreadable || attempt >= 1) return provenance;
  }
}

/** True only when both reads succeeded and they differ. */
export function gitProvenanceChanged(before: GraphGitProvenance, after: GraphGitProvenance): boolean {
  if (before.unreadable || after.unreadable) return false;
  return before.branch !== after.branch || before.head !== after.head;
}

function runGit(rootDir: string, args: readonly string[]): { status: number | null; stdout: string } {
  const result = spawnSync("git", ["--no-optional-locks", "-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status === null) return { status: null, stdout: "" };
  return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout.trim() : "" };
}

function readGitRefsOnce(rootDir: string): GraphGitProvenance {
  // Exit 0: on a branch. Exit 1: detached. Anything else: not a repository.
  const symbolic = runGit(rootDir, ["symbolic-ref", "-q", "HEAD"]);
  if (symbolic.status === null) return { branch: null, head: null, unreadable: true };
  if (symbolic.status !== 0 && symbolic.status !== 1) return { branch: null, head: null };
  const branch = symbolic.status === 0 && symbolic.stdout.startsWith("refs/heads/")
    ? symbolic.stdout.slice("refs/heads/".length) || null
    : null;
  // Exit 0: a commit. Exit 1 with -q: an unborn HEAD.
  const commit = runGit(rootDir, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
  if (commit.status === null) return { branch: null, head: null, unreadable: true };
  const head = commit.status === 0 && /^[a-f0-9]{40,64}$/u.test(commit.stdout) ? commit.stdout : null;
  return { branch, head };
}

function countParseHealth(sources: readonly GraphSnapshotSource[]): GraphSnapshotParseHealth {
  let ok = 0;
  let partial = 0;
  let failed = 0;
  for (const source of sources) {
    if (source.parseStatus === "ok") ok += 1;
    else if (source.parseStatus === "partial") partial += 1;
    else failed += 1;
  }
  return { total: sources.length, ok, partial, failed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Locale-independent UTF-16 code-unit ordering, matching stable JS string identity. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function parseEngineFallback(value: unknown): GraphEngineFallback | undefined {
  if (!isRecord(value)) return undefined;
  const { languages, files, fallbackFiles, fellBack } = value;
  if (!Array.isArray(languages) || languages.length === 0 || languages.length > 5
    || languages.some(language => !["javascript", "typescript", "python", "rust", "csharp"].includes(language))
    || new Set(languages).size !== languages.length
    || !isNonNegativeInteger(files) || !isNonNegativeInteger(fallbackFiles) || fallbackFiles === 0
    || (fellBack !== undefined && !isGraphEngineFallbackReason(fellBack))) {
    return undefined;
  }
  return { languages, files, fallbackFiles, ...(fellBack === undefined ? {} : { fellBack }) };
}
