import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  Diagnostic,
} from "../team/contracts/shared.js";
import type {
  GraphMaintenanceOptions,
  GraphMaintenanceProgress,
  GraphRefreshResult,
  GraphStatus,
} from "../team/contracts/graph.js";
import { DB_SCHEMA_VERSION, upgradeGraphDatabase } from "./db/database.js";
import { openSqlite } from "./db/sqlite.js";
import { createGraphEngine, GraphSourceStagingError, refreshWouldPublishNothing } from "./engine-impl.js";
import type { BuildResult, GraphEngine } from "./engine.js";
import {
  inspectGraphSidecars,
  inspectGraphStatus,
} from "./status.js";
import { GRAPH_SNAPSHOT_METADATA_KEY } from "./snapshot.js";
import { tryEnsureSetupIgnoreProtection } from "../setup/ignore.js";
import { GraphCandidateProcessError, runGraphCandidateProcess, type GraphCandidateProcessOptions } from "./candidate-process.js";
import { flushGraphPhaseTimings, timeGraphPhase, timeGraphPhaseAsync } from "./phase-timing.js";

const LOCK_FILE = "graph.db.lock";
const LOCK_GATE_FILE = "graph.db.lock.gate";
const MAX_LOCK_BYTES = 4 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
const OWNED_DATABASE_PREFIXES = [
  "graph.db.candidate-",
  "graph.db.rollback-",
  "graph.db.recovery-",
] as const;

export type GraphMaintenanceErrorCode =
  | "GRAPH_INDEX_MISSING"
  | "GRAPH_INDEX_NOT_REFRESHABLE"
  | "GRAPH_INDEX_NOT_REPAIRABLE"
  | "GRAPH_MAINTENANCE_LOCKED"
  | "GRAPH_MAINTENANCE_GATE_STALE"
  | "GRAPH_MAINTENANCE_CANCELLED"
  | "GRAPH_MAINTENANCE_PATH_UNSAFE"
  | "GRAPH_MAINTENANCE_RACE"
  | "GRAPH_CANDIDATE_INVALID"
  | "GRAPH_PUBLICATION_FAILED";

/** Internal typed failure used by the CLI and the future GraphPort adapter. */
export class GraphMaintenanceError extends Error {
  override readonly name = "GraphMaintenanceError";

  constructor(
    readonly code: GraphMaintenanceErrorCode,
    message: string,
    readonly diagnostics: readonly Diagnostic[] = [],
    readonly recoveryPath?: string,
  ) {
    super(message);
  }
}

export interface GraphMaintenanceResult extends GraphRefreshResult {
  /** Retained only when an unsafe prior database was replaced successfully. */
  recoveryPath?: string;
  durationMs: number;
}

/** Result of an explicit storage repair; no source extraction is performed. */
export interface GraphRepairResult {
  state: "succeeded";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  diagnostics: readonly Diagnostic[];
  status: GraphStatus;
  fromSchemaVersion: number;
  toSchemaVersion: number;
  lineage: "v1" | "v2" | "main-v3" | "integration-v3" | "hybrid-v3" | "v4";
  upgraded: boolean;
  recoveredWalBytes: number;
}

interface MaintenancePaths {
  projectRoot: string;
  projectRootReal: string;
  mexDir: string;
  mexDirReal: string;
  mexDirDev: number;
  mexDirIno: number;
  database: string;
  lock: string;
  lockGate: string;
}

interface DatabaseIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  digest: string;
}

interface RepairSourceIdentity {
  database: DatabaseIdentity;
  wal: DatabaseIdentity | null;
  shm: DatabaseIdentity | null;
}

interface LiveShmSnapshot {
  livePath: string;
  backupPath: string | null;
  backupIdentity: DatabaseIdentity | null;
  databaseIdentity: DatabaseIdentity;
  restoreState: "pending" | "live_removed" | "backup_renamed" | "complete";
}

interface DetachedLiveSidecars {
  readonly entries: readonly {
    livePath: string;
    detachedPath: string;
    identity: DatabaseIdentity;
  }[];
}

interface StatIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface ValidatedCandidate {
  status: GraphStatus;
  identity: DatabaseIdentity;
}

interface LockOwner {
  pid: number;
  token: string;
  startedAt: string;
}

interface MaintenanceLock {
  owner: LockOwner;
  identity: StatIdentity;
  release(): void;
}

interface GraphMaintenanceInternalHooks {
  candidateProcess?: GraphCandidateProcessOptions["__internal"];
  token?: () => string;
  now?: () => Date;
  inspectStatus?: typeof inspectGraphStatus;
  afterLockAcquired?: () => void | Promise<void>;
  afterCandidateBuilt?: (candidatePath: string) => void | Promise<void>;
  afterCandidateValidated?: (candidatePath: string, status: GraphStatus) => void | Promise<void>;
  beforeRepairCandidateMaterialize?: (candidatePath: string) => void;
  afterRepairShmRemoved?: () => void;
  afterRepairShmRestored?: () => void;
  beforeRepairSidecarCleanup?: (path: string, index: number) => void;
  beforeLiveRevalidation?: () => void | Promise<void>;
  afterRollbackCreated?: (rollbackPath: string) => void | Promise<void>;
  afterPublish?: (databasePath: string) => void | Promise<void>;
  beforeRollbackRestore?: (rollbackPath: string, databasePath: string) => void | Promise<void>;
  beforeCandidateDatabaseOpen?: (candidatePath: string) => void;
  beforeDeadLockReclaim?: (lockPath: string) => void;
  afterLockGateAcquired?: (gatePath: string) => void;
}

/** Internal execution policy; the CLI retains its existing in-process default. */
export type GraphMaintenanceExecutionOptions = GraphMaintenanceOptions & {
  candidateExecution?: "process";
};

type InternalMaintenanceOptions = GraphMaintenanceExecutionOptions & {
  /** Deterministic fault/race seams. Deliberately absent from public declarations. */
  __internal?: GraphMaintenanceInternalHooks;
};

interface CandidatePublicationInput {
  paths: MaintenancePaths;
  candidatePath: string;
  candidate: ValidatedCandidate;
  priorStatus: GraphStatus;
  priorIdentity: DatabaseIdentity | null;
  retainRecovery: boolean;
  options: InternalMaintenanceOptions;
  assertStatus?: (status: GraphStatus) => void;
}

interface CandidatePublicationResult {
  status: GraphStatus;
  recoveryPath?: string;
  diagnostics: readonly Diagnostic[];
}

export type GraphMaintenanceLeaseMode = "refresh" | "rebuild" | "repair";

/**
 * Internal programmatic lease for workflows that must keep graph writes and
 * subsequent grounding-baseline writes under one cross-process owner token.
 * The lease is intentionally not exported from the package root.
 */
export interface GraphMaintenanceLease {
  readonly projectRoot: string;
  readonly databasePath: string;
  refresh(options?: GraphMaintenanceExecutionOptions): Promise<GraphMaintenanceResult>;
  rebuild(options?: GraphMaintenanceExecutionOptions): Promise<GraphMaintenanceResult>;
  repair(options?: GraphMaintenanceOptions): Promise<GraphRepairResult>;
  release(): void;
}

export function acquireGraphMaintenanceLease(
  projectRoot: string,
  mode: GraphMaintenanceLeaseMode = "refresh",
  options: GraphMaintenanceExecutionOptions = {},
): GraphMaintenanceLease {
  const internalOptions = options as InternalMaintenanceOptions;
  const paths = resolveMaintenancePaths(projectRoot, mode === "rebuild");
  assertMaintenanceDirectoryUnchanged(paths);
  if (mode !== "rebuild" && !existsSync(paths.database)) {
    throw new GraphMaintenanceError(
      "GRAPH_INDEX_MISSING",
      "The graph index does not exist. Run `mex graph rebuild` first.",
    );
  }

  // Every graph writer funnels through here, so this is the one place that can
  // guarantee a store is ignored by Git before it exists — including the runs
  // that never went through `mex setup` (issue #110). Deliberately after the
  // missing-index refusal, so a mistyped `refresh` in an unindexed checkout
  // leaves nothing behind.
  const protection = tryEnsureSetupIgnoreProtection(projectRoot);
  if (!protection.ok) {
    // Reported, never fatal: the store is still valid, the checkout is merely
    // unprotected. Emitted directly rather than through `progress` so it cannot
    // turn an already-cancelled signal into a throw before the lease exists.
    options.onProgress?.({
      phase: "discover",
      message: `Could not ignore local MEX data: ${protection.reason}`,
    });
  }
  const lock = acquireMaintenanceLock(paths, internalOptions);
  let released = false;
  let active = false;
  const run = async (
    operation: "refresh" | "rebuild" | "repair",
    operationOptions: GraphMaintenanceExecutionOptions,
  ): Promise<GraphMaintenanceResult | GraphRepairResult> => {
    if (released) throw new Error("The graph maintenance lease has already been released.");
    if (active) {
      throw new GraphMaintenanceError(
        "GRAPH_MAINTENANCE_LOCKED",
        "This graph maintenance lease already has an active operation.",
      );
    }
    active = true;
    try {
      const resolved = operationOptions as InternalMaintenanceOptions;
      // Wrapper callers pass the same options to acquisition and execution.
      // A manual lease may supply operation-local progress/cancellation while
      // retaining acquisition-time deterministic hooks.
      const merged = {
        ...operationOptions,
        candidateExecution: resolved.candidateExecution ?? internalOptions.candidateExecution,
        __internal: resolved.__internal ?? internalOptions.__internal,
      } as InternalMaintenanceOptions;
      await merged.__internal?.afterLockAcquired?.();
      assertMaintenanceDirectoryUnchanged(paths);
      if (operation === "refresh") return await refreshGraphWithLease(paths, merged);
      if (operation === "repair") return await repairGraphWithLease(paths, merged);
      return await rebuildGraphWithLease(paths, merged);
    } finally {
      active = false;
    }
  };
  return {
    projectRoot: paths.projectRoot,
    databasePath: paths.database,
    refresh: (operationOptions = {}) => run("refresh", operationOptions) as Promise<GraphMaintenanceResult>,
    rebuild: (operationOptions = {}) => run("rebuild", operationOptions) as Promise<GraphMaintenanceResult>,
    repair: (operationOptions = {}) => run("repair", operationOptions) as Promise<GraphRepairResult>,
    release: () => {
      if (released) return;
      if (active) throw new Error("Cannot release an active graph maintenance lease.");
      released = true;
      lock.release();
    },
  };
}

/** Explicit correctness-first refresh. Reads never call this function. */
export async function refreshGraph(
  projectRoot: string,
  options: GraphMaintenanceExecutionOptions = {},
): Promise<GraphMaintenanceResult> {
  const lease = acquireGraphMaintenanceLease(projectRoot, "refresh", options);
  try {
    return await lease.refresh(options);
  } finally {
    lease.release();
  }
}

/**
 * Recover a checkpoint-stranded or recognized older graph without touching
 * the live database in place. The live SQLite view is materialized into an
 * owned same-directory candidate, upgraded there, validated, and only then
 * published under the ordinary graph maintenance lock.
 */
export async function repairGraph(
  projectRoot: string,
  options: GraphMaintenanceOptions = {},
): Promise<GraphRepairResult> {
  const lease = acquireGraphMaintenanceLease(projectRoot, "repair", options);
  try {
    return await lease.repair(options);
  } finally {
    lease.release();
  }
}

async function repairGraphWithLease(
  paths: MaintenancePaths,
  options: InternalMaintenanceOptions,
): Promise<GraphRepairResult> {
  const started = currentDate(options);
  let candidatePath: string | null = null;
  let detachedSidecars: DetachedLiveSidecars | null = null;
  let liveShmSnapshot: LiveShmSnapshot | null = null;
  let liveShmExpected: DatabaseIdentity | null | undefined;
  let repairSource: RepairSourceIdentity | null = null;
  let livePublished = false;
  try {
    assertNotAborted(options.signal);
    progress(options, "discover", "Inspecting the graph database and recovery state.");
    const priorStatus = await inspect(options, paths.projectRoot, paths.database);
    assertMaintenanceDirectoryUnchanged(paths);
    assertRepairSourceSafe(priorStatus);

    candidatePath = ownedPath(paths, "candidate", createToken(options));
    progress(options, "stage", "Materializing the exact live SQLite view into an isolated candidate.");
    // Bind the complete recovery namespace before SQLite is allowed to read
    // it. A failed VACUUM can still touch SHM, so the outer recovery path must
    // never infer safety from the unchanged main database alone.
    repairSource = captureRepairSource(paths);
    liveShmExpected = repairSource.shm;
    liveShmSnapshot = preserveLiveShm(paths, options);
    const copied = materializeRepairCandidate(paths, candidatePath, repairSource, options);
    repairSource = copied.source;
    liveShmExpected = copied.source.shm;
    assertNotAborted(options.signal);

    let upgrade: ReturnType<typeof upgradeGraphDatabase>;
    try {
      upgrade = upgradeGraphDatabase(candidatePath);
    } catch {
      throw new GraphMaintenanceError(
        "GRAPH_INDEX_NOT_REPAIRABLE",
        "The graph schema lineage is ambiguous, malformed, or cannot be upgraded losslessly. Run `mex graph rebuild`.",
        priorStatus.diagnostics,
      );
    }
    if (upgrade.requiresRebuild) {
      throw new GraphMaintenanceError(
        "GRAPH_INDEX_NOT_REPAIRABLE",
        "The graph uses a lineage that cannot be upgraded losslessly. Run `mex graph rebuild`.",
        priorStatus.diagnostics,
      );
    }
    checkpointRepairCandidate(candidatePath);
    await options.__internal?.afterCandidateBuilt?.(candidatePath);
    assertMaintenanceDirectoryUnchanged(paths);
    assertNotAborted(options.signal);

    progress(options, "validate", "Validating the repaired graph candidate.");
    const candidate = await validateCandidate(
      options,
      paths,
      candidatePath,
      assertRepairPublishableCandidate,
    );
    await options.__internal?.afterCandidateValidated?.(candidatePath, candidate.status);
    assertMaintenanceDirectoryUnchanged(paths);

    // SQLite may update its ephemeral shared-memory header while reading the
    // stranded WAL. Restore the exact pre-repair SHM bytes (or prior absence)
    // before binding and detaching the publication namespace.
    restoreLiveShmSnapshot(paths, liveShmSnapshot, copied.source.shm, copied.source.database, options);
    liveShmSnapshot = null;
    liveShmExpected = undefined;
    // The candidate was built from this exact main-file/WAL view. Bind that
    // view again before detaching recovery sidecars from the publication name.
    revalidateRepairSource(paths, copied.source);
    detachedSidecars = detachLiveSidecars(paths, copied.source, options);
    const published = await publishCandidate({
      paths,
      candidatePath,
      candidate,
      priorStatus,
      priorIdentity: copied.source.database,
      retainRecovery: false,
      options,
      assertStatus: assertRepairPublishableCandidate,
    });
    livePublished = true;
    candidatePath = null;
    const cleanupDiagnostics = cleanupDetachedSidecars(paths, detachedSidecars, options);
    detachedSidecars = null;

    const finished = currentDate(options);
    return {
      state: "succeeded",
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: Math.max(0, finished.getTime() - started.getTime()),
      diagnostics: [...published.diagnostics, ...cleanupDiagnostics],
      status: published.status,
      fromSchemaVersion: upgrade.fromVersion,
      toSchemaVersion: upgrade.toVersion,
      lineage: upgrade.lineage,
      upgraded: upgrade.changed,
      recoveredWalBytes: copied.walBytes,
    };
  } catch (error) {
    if (detachedSidecars && !livePublished) {
      restoreDetachedSidecars(paths, detachedSidecars, repairSource?.database);
    } else if (liveShmSnapshot) {
      try {
        if (repairSource) revalidateRepairSource(paths, repairSource);
        restoreLiveShmSnapshot(
          paths,
          liveShmSnapshot,
          liveShmExpected,
          repairSource?.database ?? liveShmSnapshot.databaseIdentity,
          options,
        );
      } catch (restoreError) {
        if (liveShmSnapshot.backupPath && existsSync(liveShmSnapshot.backupPath)) {
          throw retainedRecoveryError(
            paths,
            [liveShmSnapshot.backupPath],
            "The live graph recovery namespace changed before its exact shared-memory snapshot could be restored.",
          );
        }
        throw restoreError;
      }
    }
    throw error;
  } finally {
    if (candidatePath) cleanupOwnedDatabase(paths, candidatePath);
  }
}

async function refreshGraphWithLease(
  paths: MaintenancePaths,
  options: InternalMaintenanceOptions,
): Promise<GraphMaintenanceResult> {
  const started = currentDate(options);
  let candidatePath: string | null = null;
  try {
    assertNotAborted(options.signal);
    // The candidate mostly keeps the live graph's fingerprints; its audit
    // reuses their band hashes instead of deriving them again.
    const bandHashMemo = new Map<string, readonly string[]>();
    const priorStatus = await timeGraphPhaseAsync("envelope.inspect", () =>
      inspect(options, paths.projectRoot, paths.database, bandHashMemo));
    assertMaintenanceDirectoryUnchanged(paths);
    assertRefreshable(priorStatus);
    assertClearSidecars(paths.database);
    progress(options, "discover", "Inspecting the current graph snapshot and source corpus.");

    // A refresh that would publish nothing, not even coverage or HEAD, needs
    // no candidate (issue #209): the live graph is already what a candidate
    // would become, and it is left byte-identical. Anything else, including a
    // coverage change, takes the normal validated publication.
    // An inspection that already saw a change settles it without a second
    // corpus walk; skipping the check only ever takes the normal path.
    const statBefore = liveDatabaseStat(paths.database);
    if (priorStatus.status === "fresh"
      && timeGraphPhase("envelope.noOpCheck", () => refreshWouldPublishNothing(paths.projectRoot, paths.database))) {
      assertMaintenanceDirectoryUnchanged(paths);
      assertClearSidecars(paths.database);
      if (sameLiveDatabaseStat(statBefore, liveDatabaseStat(paths.database))) {
        const finished = currentDate(options);
        return maintenanceResult(
          started,
          finished,
          { filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 },
          { status: priorStatus, diagnostics: priorStatus.diagnostics },
        );
      }
    }
    const priorIdentity = captureDatabaseIdentity(paths.database);

    candidatePath = ownedPath(paths, "candidate", createToken(options));
    const copyPath = candidatePath;
    timeGraphPhase("envelope.copy", () => copyExactDatabase(paths, paths.database, copyPath, priorIdentity));
    const buildResult = await timeGraphPhaseAsync("envelope.candidate", () =>
      refreshCandidate(paths, copyPath, options));
    await options.__internal?.afterCandidateBuilt?.(candidatePath);
    assertMaintenanceDirectoryUnchanged(paths);
    assertNotAborted(options.signal);

    progress(options, "validate", "Validating the refreshed graph candidate.");
    const candidate = await timeGraphPhaseAsync("envelope.validate", () =>
      validateCandidate(options, paths, copyPath, undefined, bandHashMemo));
    await options.__internal?.afterCandidateValidated?.(candidatePath, candidate.status);
    assertMaintenanceDirectoryUnchanged(paths);

    const published = await timeGraphPhaseAsync("envelope.publish", () => publishCandidate({
      paths,
      candidatePath: copyPath,
      candidate,
      priorStatus,
      priorIdentity,
      retainRecovery: false,
      options,
    }));
    candidatePath = null;
    const finished = currentDate(options);
    return maintenanceResult(started, finished, buildResult, published);
  } finally {
    if (candidatePath) cleanupOwnedDatabase(paths, candidatePath);
    flushGraphPhaseTimings("refresh");
  }
}

/** Explicit isolated rebuild for missing, incompatible, or corrupt indexes. */
export async function rebuildGraph(
  projectRoot: string,
  options: GraphMaintenanceExecutionOptions = {},
): Promise<GraphMaintenanceResult> {
  const lease = acquireGraphMaintenanceLease(projectRoot, "rebuild", options);
  try {
    return await lease.rebuild(options);
  } finally {
    lease.release();
  }
}

async function rebuildGraphWithLease(
  paths: MaintenancePaths,
  options: InternalMaintenanceOptions,
): Promise<GraphMaintenanceResult> {
  const started = currentDate(options);
  let candidatePath: string | null = null;
  try {
    assertNotAborted(options.signal);
    progress(options, "discover", "Inspecting graph recovery prerequisites.");
    const priorStatus = await inspect(options, paths.projectRoot, paths.database);
    assertMaintenanceDirectoryUnchanged(paths);
    const databaseExists = existsSync(paths.database);
    if (databaseExists) assertClearSidecars(paths.database);
    const priorIdentity = databaseExists ? captureDatabaseIdentity(paths.database) : null;

    const cloneForContinuity = Boolean(priorIdentity && shouldCloneForContinuity(priorStatus));
    let continuityFallback = false;
    candidatePath = ownedPath(paths, "candidate", createToken(options));
    if (priorIdentity && cloneForContinuity) {
      copyExactDatabase(paths, paths.database, candidatePath, priorIdentity);
    }
    let buildResult: BuildResult;
    try {
      buildResult = await rebuildCandidate(paths, candidatePath, options);
    } catch (error) {
      if (!cloneForContinuity || !isContinuityCloneCompatibilityFailure(error)) throw error;
      // An older database may be readable enough to identify its version yet
      // structurally unsafe to migrate. Discard only the isolated clone and
      // retry from an empty candidate; the exact live bytes remain untouched
      // and will be retained as recovery if publication succeeds.
      cleanupOwnedDatabase(paths, candidatePath);
      candidatePath = ownedPath(paths, "candidate", createToken(options));
      continuityFallback = true;
      buildResult = await rebuildCandidate(paths, candidatePath, options);
      if ((buildResult.health?.failed ?? 0) > 0) {
        cleanupOwnedDatabase(paths, candidatePath);
        candidatePath = null;
        throw new GraphSourceStagingError([{
          filePath: ".",
          operation: "parse",
          code: "GRAPH_SOURCE_PARSE_FAILED",
          message: "A fresh compatibility fallback encountered failed source parsing and was not published.",
        }]);
      }
    }
    await options.__internal?.afterCandidateBuilt?.(candidatePath);
    assertMaintenanceDirectoryUnchanged(paths);
    assertNotAborted(options.signal);

    progress(options, "validate", "Validating the isolated graph rebuild candidate.");
    const candidate = await validateCandidate(options, paths, candidatePath);
    await options.__internal?.afterCandidateValidated?.(candidatePath, candidate.status);
    assertMaintenanceDirectoryUnchanged(paths);

    const retainRecovery = priorStatus.status === "corrupt"
      || priorStatus.status === "rebuild_required";
    const publication = await publishCandidate({
      paths,
      candidatePath,
      candidate,
      priorStatus,
      priorIdentity,
      retainRecovery,
      options,
    });
    const published = continuityFallback
      ? {
          ...publication,
          diagnostics: [
            ...publication.diagnostics,
            {
              code: "GRAPH_INDEX_CONTINUITY_FALLBACK",
              severity: "info" as const,
              message: "The older graph index could not be migrated safely; mex rebuilt from a fresh candidate and retained the prior bytes for recovery.",
            },
          ],
        }
      : publication;
    candidatePath = null;
    const finished = currentDate(options);
    return maintenanceResult(started, finished, buildResult, published);
  } finally {
    if (candidatePath) cleanupOwnedDatabase(paths, candidatePath);
  }
}

async function refreshCandidate(
  paths: MaintenancePaths,
  candidatePath: string,
  options: InternalMaintenanceOptions,
): Promise<BuildResult> {
  progress(options, "stage", "Checking exact graph provenance and restaging the corpus when required.");
  if (options.candidateExecution === "process") return runIsolatedCandidate(paths, candidatePath, "refresh", options);
  const engine = maintenanceEngine(paths, candidatePath, options);
  try {
    // The empty-hint sync path performs the exact corpus, semantic-input,
    // manifest, and branch handshake. It no-ops only when all provenance still
    // matches; otherwise it securely restages the whole semantic corpus.
    return await engine.sync([]);
  } finally {
    engine.close();
  }
}

async function rebuildCandidate(
  paths: MaintenancePaths,
  candidatePath: string,
  options: InternalMaintenanceOptions,
): Promise<BuildResult> {
  progress(options, "stage", "Building the graph in an isolated same-directory candidate.");
  if (options.candidateExecution === "process") return runIsolatedCandidate(paths, candidatePath, "rebuild", options);
  const engine = maintenanceEngine(paths, candidatePath, options);
  try {
    return await engine.build(paths.projectRoot);
  } finally {
    engine.close();
  }
}

async function runIsolatedCandidate(
  paths: MaintenancePaths,
  candidatePath: string,
  operation: "refresh" | "rebuild",
  options: InternalMaintenanceOptions,
): Promise<BuildResult> {
  options.__internal?.beforeCandidateDatabaseOpen?.(candidatePath);
  assertMaintenanceDirectoryUnchanged(paths);
  assertNotAborted(options.signal);
  try {
    return await runGraphCandidateProcess({
      projectRoot: paths.projectRoot,
      candidatePath,
      operation,
      signal: options.signal,
      onProgress: (update) => {
        assertNotAborted(options.signal);
        options.onProgress?.({
          ...update,
          message: update.phase === "parse"
            ? "Extracting graph source files."
            : "Resolving references and writing the graph candidate.",
        });
      },
      __internal: options.__internal?.candidateProcess,
    });
  } catch (error) {
    if (error instanceof GraphCandidateProcessError) {
      if (error.category === "cancelled") throw new GraphMaintenanceError("GRAPH_MAINTENANCE_CANCELLED", error.message);
      if (error.category === "unsafe") throw new GraphMaintenanceError("GRAPH_MAINTENANCE_PATH_UNSAFE", error.message);
    }
    throw error;
  }
}

function materializeRepairCandidate(
  paths: MaintenancePaths,
  candidatePath: string,
  expectedSource: RepairSourceIdentity,
  options: InternalMaintenanceOptions,
): { source: RepairSourceIdentity; walBytes: number } {
  assertMaintenanceDirectoryUnchanged(paths);
  assertOwnedDatabasePath(candidatePath);
  if (existsSync(candidatePath)) {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_PATH_UNSAFE",
      `Refusing to overwrite an existing owned maintenance path (${basename(candidatePath)}).`,
    );
  }
  let before: RepairSourceIdentity;
  let db: ReturnType<typeof openSqlite> | null = null;
  try {
    options.__internal?.beforeRepairCandidateMaterialize?.(candidatePath);
    before = captureRepairSource(paths);
    if (!sameRepairSourceIncludingShm(expectedSource, before)) {
      throw new GraphMaintenanceError(
        "GRAPH_MAINTENANCE_RACE",
        "The live graph recovery namespace changed before candidate materialization.",
      );
    }
    // VACUUM INTO reads one coherent SQLite snapshot, including committed WAL
    // pages, while writing only the maintenance-owned candidate.
    db = openSqlite(paths.database, { readOnly: true });
    db.pragma("busy_timeout = 5000");
    db.prepare("VACUUM INTO ?").run(candidatePath);
  } catch (error) {
    cleanupOwnedDatabase(paths, candidatePath);
    if (error instanceof GraphMaintenanceError) throw error;
    throw new GraphMaintenanceError(
      "GRAPH_INDEX_NOT_REPAIRABLE",
      "The graph recovery state could not be materialized safely. Run `mex graph rebuild`.",
    );
  } finally {
    db?.close();
  }
  const after = captureRepairSource(paths);
  if (!sameRepairSource(before, after)) {
    cleanupOwnedDatabase(paths, candidatePath);
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_RACE",
      "The live graph or its WAL changed while the repair candidate was being materialized.",
    );
  }
  assertOwnedCopyUnchanged(candidatePath, captureDatabaseIdentity(candidatePath));
  fsyncFile(candidatePath);
  return { source: after, walBytes: after.wal?.size ?? 0 };
}

function checkpointRepairCandidate(candidatePath: string): void {
  let db: ReturnType<typeof openSqlite> | null = null;
  try {
    db = openSqlite(candidatePath);
    db.pragma("busy_timeout = 5000");
    db.pragma("wal_checkpoint(TRUNCATE)");
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check?: unknown }>;
    const failures = rows
      .map((row) => row.integrity_check)
      .filter((value): value is string => typeof value === "string" && value !== "ok");
    if (failures.length > 0) {
      throw new GraphMaintenanceError(
        "GRAPH_CANDIDATE_INVALID",
        `The repaired graph candidate failed SQLite integrity validation: ${failures.join("; ")}.`,
      );
    }
  } finally {
    db?.close();
  }
}

function preserveLiveShm(
  paths: MaintenancePaths,
  options: InternalMaintenanceOptions,
): LiveShmSnapshot {
  assertMaintenanceDirectoryUnchanged(paths);
  const databaseBefore = captureDatabaseIdentity(paths.database);
  const livePath = `${paths.database}-shm`;
  const stats = safeLstat(livePath);
  if (!stats) {
    return {
      livePath,
      backupPath: null,
      backupIdentity: null,
      databaseIdentity: databaseBefore,
      restoreState: "pending",
    };
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_PATH_UNSAFE",
      "The graph shared-memory sidecar is not a contained regular file.",
    );
  }
  const sourceIdentity = captureDatabaseIdentity(livePath);
  const base = ownedPath(paths, "recovery", createToken(options));
  const backupPath = `${base}.source-shm`;
  const backupIdentity = copyExactDatabase(paths, livePath, backupPath, sourceIdentity);
  const databaseAfter = captureDatabaseIdentity(paths.database);
  if (!sameDatabaseIdentity(databaseBefore, databaseAfter)) {
    cleanupOwnedDatabasePath(paths, backupPath);
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_RACE",
      "The live graph changed while its shared-memory recovery snapshot was captured.",
    );
  }
  return {
    livePath,
    backupPath,
    backupIdentity,
    databaseIdentity: databaseAfter,
    restoreState: "pending",
  };
}

function restoreLiveShmSnapshot(
  paths: MaintenancePaths,
  snapshot: LiveShmSnapshot,
  expectedCurrent?: DatabaseIdentity | null,
  expectedDatabase: DatabaseIdentity = snapshot.databaseIdentity,
  options?: InternalMaintenanceOptions,
): void {
  assertMaintenanceDirectoryUnchanged(paths);
  assertRepairBaseContents(paths, expectedDatabase, snapshot.backupPath ? [snapshot.backupPath] : []);
  if (snapshot.restoreState === "complete") return;

  if (snapshot.restoreState === "backup_renamed") {
    if (!snapshot.backupIdentity || !existsSync(snapshot.livePath)) {
      throw new GraphMaintenanceError(
        "GRAPH_PUBLICATION_FAILED",
        "The exact shared-memory recovery snapshot became unavailable during restoration.",
      );
    }
    const restored = captureDatabaseIdentity(snapshot.livePath);
    if (restored.size !== snapshot.backupIdentity.size
      || restored.digest !== snapshot.backupIdentity.digest) {
      throw new GraphMaintenanceError(
        "GRAPH_PUBLICATION_FAILED",
        "The restored shared-memory sidecar no longer matches its exact recovery bytes.",
      );
    }
    fsyncMaintenanceDirectory(paths);
    snapshot.restoreState = "complete";
    return;
  }

  if (snapshot.restoreState === "pending") {
    const current = safeLstat(snapshot.livePath);
    if (current) {
      if (!current.isFile() || current.isSymbolicLink()) {
        throw new GraphMaintenanceError(
          "GRAPH_MAINTENANCE_PATH_UNSAFE",
          "The graph shared-memory sidecar changed to an unsafe path during repair.",
        );
      }
      const currentIdentity = captureDatabaseIdentity(snapshot.livePath);
      if (expectedCurrent !== undefined
        && (expectedCurrent === null || !sameDatabaseIdentity(currentIdentity, expectedCurrent))) {
        throw new GraphMaintenanceError(
          "GRAPH_MAINTENANCE_RACE",
          "The graph shared-memory sidecar changed after candidate materialization.",
        );
      }
      unlinkSync(snapshot.livePath);
    } else if (expectedCurrent !== undefined && expectedCurrent !== null) {
      throw new GraphMaintenanceError(
        "GRAPH_MAINTENANCE_RACE",
        "The graph shared-memory sidecar disappeared after candidate materialization.",
      );
    }
    snapshot.restoreState = "live_removed";
    options?.__internal?.afterRepairShmRemoved?.();
  }

  if (snapshot.backupPath && snapshot.backupIdentity) {
    assertOwnedCopyUnchanged(snapshot.backupPath, snapshot.backupIdentity);
    if (existsSync(snapshot.livePath)) {
      throw new GraphMaintenanceError(
        "GRAPH_PUBLICATION_FAILED",
        "The graph shared-memory publication name was occupied during restoration.",
      );
    }
    renameSync(snapshot.backupPath, snapshot.livePath);
    snapshot.restoreState = "backup_renamed";
    options?.__internal?.afterRepairShmRestored?.();
  }
  fsyncMaintenanceDirectory(paths);
  snapshot.restoreState = "complete";
}

function captureRepairSource(paths: MaintenancePaths): RepairSourceIdentity {
  assertMaintenanceDirectoryUnchanged(paths);
  const journalPath = `${paths.database}-journal`;
  const journal = safeLstat(journalPath);
  if (journal) {
    if (!journal.isFile() || journal.isSymbolicLink() || journal.size !== 0) {
      throw new GraphMaintenanceError(
        "GRAPH_INDEX_NOT_REPAIRABLE",
        "A rollback journal is active; wait for its writer to finish or run `mex graph rebuild`.",
      );
    }
  }
  const walPath = `${paths.database}-wal`;
  const walStats = safeLstat(walPath);
  if (walStats && (!walStats.isFile() || walStats.isSymbolicLink())) {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_PATH_UNSAFE",
      "The graph WAL is not a contained regular file.",
    );
  }
  const shmPath = `${paths.database}-shm`;
  const shmStats = safeLstat(shmPath);
  if (shmStats && (!shmStats.isFile() || shmStats.isSymbolicLink())) {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_PATH_UNSAFE",
      "The graph shared-memory sidecar is not a contained regular file.",
    );
  }
  return {
    database: captureDatabaseIdentity(paths.database),
    wal: walStats && walStats.size > 0 ? captureDatabaseIdentity(walPath) : null,
    shm: shmStats ? captureDatabaseIdentity(shmPath) : null,
  };
}

function revalidateRepairSource(paths: MaintenancePaths, expected: RepairSourceIdentity): void {
  const current = captureRepairSource(paths);
  if (!sameRepairSource(current, expected)) {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_RACE",
      "The live graph or its WAL changed before repaired candidate publication.",
    );
  }
}

function sameRepairSource(left: RepairSourceIdentity, right: RepairSourceIdentity): boolean {
  return sameDatabaseIdentity(left.database, right.database)
    && (left.wal === null
      ? right.wal === null
      : right.wal !== null && sameDatabaseIdentity(left.wal, right.wal));
}

function sameRepairSourceIncludingShm(
  left: RepairSourceIdentity,
  right: RepairSourceIdentity,
): boolean {
  return sameRepairSource(left, right)
    && (left.shm === null
      ? right.shm === null
      : right.shm !== null && sameDatabaseIdentity(left.shm, right.shm));
}

function detachLiveSidecars(
  paths: MaintenancePaths,
  source: RepairSourceIdentity,
  options: InternalMaintenanceOptions,
): DetachedLiveSidecars {
  revalidateRepairSource(paths, source);
  const base = ownedPath(paths, "recovery", createToken(options));
  const entries: Array<{
    livePath: string;
    detachedPath: string;
    identity: DatabaseIdentity;
  }> = [];
  try {
    for (const suffix of ["-wal", "-shm", "-journal"] as const) {
      const livePath = `${paths.database}${suffix}`;
      const stats = safeLstat(livePath);
      if (!stats) continue;
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new GraphMaintenanceError(
          "GRAPH_MAINTENANCE_PATH_UNSAFE",
          `The graph recovery sidecar ${basename(livePath)} is not a regular file.`,
        );
      }
      const identity = captureDatabaseIdentity(livePath);
      if (suffix === "-wal" && identity.size > 0
        && (!source.wal || !sameDatabaseIdentity(identity, source.wal))) {
        throw new GraphMaintenanceError(
          "GRAPH_MAINTENANCE_RACE",
          "The graph WAL changed before repaired candidate publication.",
        );
      }
      const detachedPath = `${base}${suffix}`;
      if (existsSync(detachedPath)) {
        throw new GraphMaintenanceError(
          "GRAPH_MAINTENANCE_PATH_UNSAFE",
          `Refusing to overwrite an existing recovery path (${basename(detachedPath)}).`,
        );
      }
      assertMaintenanceDirectoryUnchanged(paths);
      renameSync(livePath, detachedPath);
      const detachedIdentity = captureDatabaseIdentity(detachedPath);
      entries.push({ livePath, detachedPath, identity: detachedIdentity });
      if (identity.dev !== detachedIdentity.dev
        || identity.ino !== detachedIdentity.ino
        || identity.size !== detachedIdentity.size
        || identity.digest !== detachedIdentity.digest) {
        throw new GraphMaintenanceError(
          "GRAPH_MAINTENANCE_RACE",
          `The graph recovery sidecar ${basename(livePath)} changed while it was detached.`,
        );
      }
    }
    revalidateLiveDatabase(paths.database, source.database);
    fsyncMaintenanceDirectory(paths);
    return { entries };
  } catch (error) {
    restoreDetachedSidecars(paths, { entries }, source.database);
    throw error;
  }
}

function restoreDetachedSidecars(
  paths: MaintenancePaths,
  detached: DetachedLiveSidecars,
  expectedDatabase: DatabaseIdentity | undefined,
): void {
  if (!expectedDatabase) {
    throw retainedSidecarRecoveryError(paths, detached, "The prior graph identity is unavailable.");
  }
  assertRepairBaseContents(
    paths,
    expectedDatabase,
    detached.entries.map((entry) => entry.detachedPath),
  );
  for (const entry of [...detached.entries].reverse()) {
    if (!existsSync(entry.detachedPath)) continue;
    assertOwnedCopyUnchanged(entry.detachedPath, entry.identity);
    if (existsSync(entry.livePath)) {
      throw new GraphMaintenanceError(
        "GRAPH_PUBLICATION_FAILED",
        `A graph recovery sidecar reappeared before rollback (${basename(entry.livePath)}); the exact prior sidecar remains at ${toRepoRelative(paths.projectRoot, entry.detachedPath)}.`,
      );
    }
    assertMaintenanceDirectoryUnchanged(paths);
    renameSync(entry.detachedPath, entry.livePath);
  }
  fsyncMaintenanceDirectory(paths);
}

function assertRepairBaseContents(
  paths: MaintenancePaths,
  expected: DatabaseIdentity,
  retainedPaths: readonly string[],
): void {
  let current: DatabaseIdentity;
  try {
    current = captureDatabaseIdentity(paths.database);
  } catch {
    throw retainedRecoveryError(paths, retainedPaths, "The live graph is unavailable.");
  }
  if (current.size !== expected.size || current.digest !== expected.digest) {
    throw retainedRecoveryError(
      paths,
      retainedPaths,
      "The live graph no longer matches the exact prior database.",
    );
  }
}

function retainedSidecarRecoveryError(
  paths: MaintenancePaths,
  detached: DetachedLiveSidecars,
  reason: string,
): GraphMaintenanceError {
  return retainedRecoveryError(paths, detached.entries.map((entry) => entry.detachedPath), reason);
}

function retainedRecoveryError(
  paths: MaintenancePaths,
  retainedPaths: readonly string[],
  reason: string,
): GraphMaintenanceError {
  const first = retainedPaths.find((path) => existsSync(path));
  const recoveryPath = first ? toRepoRelative(paths.projectRoot, first) : undefined;
  return new GraphMaintenanceError(
    "GRAPH_PUBLICATION_FAILED",
    `${reason} Exact prior recovery sidecars were not attached to it.`
      + (recoveryPath ? ` Recovery data remains at ${recoveryPath}.` : ""),
    recoveryPath
      ? [recoveryRetainedDiagnostic(
          recoveryPath,
          "Exact prior graph recovery sidecars were retained because the live graph identity changed.",
        )]
      : [],
    recoveryPath,
  );
}

function cleanupDetachedSidecars(
  paths: MaintenancePaths,
  detached: DetachedLiveSidecars,
  options: InternalMaintenanceOptions,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  detached.entries.forEach((entry, index) => {
    try {
      options.__internal?.beforeRepairSidecarCleanup?.(entry.detachedPath, index);
      if (!existsSync(entry.detachedPath)) return;
      assertOwnedCopyUnchanged(entry.detachedPath, entry.identity);
      assertMaintenanceDirectoryUnchanged(paths);
      unlinkSync(entry.detachedPath);
    } catch {
      diagnostics.push({
        code: "GRAPH_INDEX_RECOVERY_CLEANUP_INCOMPLETE",
        severity: "warning",
        message: "The repaired graph was published, but an exact prior recovery sidecar could not be removed automatically.",
        path: toRepoRelative(paths.projectRoot, entry.detachedPath),
      });
    }
  });
  try {
    fsyncMaintenanceDirectory(paths);
  } catch {
    diagnostics.push({
      code: "GRAPH_INDEX_RECOVERY_CLEANUP_INCOMPLETE",
      severity: "warning",
      message: "The repaired graph was published, but recovery cleanup durability could not be confirmed.",
    });
  }
  return diagnostics;
}

function maintenanceEngine(
  paths: MaintenancePaths,
  candidatePath: string,
  options: InternalMaintenanceOptions,
): GraphEngine {
  assertMaintenanceDirectoryUnchanged(paths);
  const check = () => {
    assertMaintenanceDirectoryUnchanged(paths);
    assertNotAborted(options.signal);
  };
  return createGraphEngine({
    rootDir: paths.projectRoot,
    dbPath: candidatePath,
    __internalGraphEngineHooks: {
      beforeDatabaseOpen: () => {
        options.__internal?.beforeCandidateDatabaseOpen?.(candidatePath);
        check();
      },
      afterSemanticInputsStaged: check,
      afterCompilerExtraction: check,
      beforePublication: check,
    },
  } as Parameters<typeof createGraphEngine>[0]);
}

async function publishCandidate(input: CandidatePublicationInput): Promise<CandidatePublicationResult> {
  const { paths, options } = input;
  let rollbackPath: string | null = null;
  let rollbackIdentity: DatabaseIdentity | null = null;
  let published = false;
  try {
    assertMaintenanceDirectoryUnchanged(paths);
    assertNotAborted(options.signal);
    await options.__internal?.beforeLiveRevalidation?.();
    assertMaintenanceDirectoryUnchanged(paths);
    revalidateLiveDatabase(paths.database, input.priorIdentity);
    assertClearSidecarsIfPresent(paths.database);
    assertCandidateUnchanged(input.candidatePath, input.candidate);

    if (input.priorIdentity) {
      rollbackPath = ownedPath(
        paths,
        "recovery",
        createToken(options),
      );
      rollbackIdentity = copyExactDatabase(paths, paths.database, rollbackPath, input.priorIdentity);
      await options.__internal?.afterRollbackCreated?.(rollbackPath);
      assertMaintenanceDirectoryUnchanged(paths);
      revalidateLiveDatabase(paths.database, input.priorIdentity);
      assertClearSidecars(paths.database);
      assertOwnedCopyUnchanged(rollbackPath, rollbackIdentity);
    }
    assertNotAborted(options.signal);
    assertCandidateUnchanged(input.candidatePath, input.candidate);
    cleanupCheckpointedOwnedSidecars(paths, input.candidatePath);
    assertMaintenanceDirectoryUnchanged(paths);
    fsyncFile(input.candidatePath);
    fsyncMaintenanceDirectory(paths);
    progress(options, "publish", "Publishing the validated graph candidate atomically.");
    // Progress callbacks are caller code and may take arbitrary time. Bind both
    // sides again at the final synchronous publication boundary.
    revalidateLiveDatabase(paths.database, input.priorIdentity);
    assertClearSidecarsIfPresent(paths.database);
    assertCandidateUnchanged(input.candidatePath, input.candidate);
    if (rollbackPath && rollbackIdentity) assertOwnedCopyUnchanged(rollbackPath, rollbackIdentity);
    assertMaintenanceDirectoryUnchanged(paths);
    renameSync(input.candidatePath, paths.database);
    published = true;
    fsyncMaintenanceDirectory(paths);
    await options.__internal?.afterPublish?.(paths.database);
    assertMaintenanceDirectoryUnchanged(paths);
    assertNotAborted(options.signal);

    // The published file must be the validated candidate itself: the same file
    // object holding the same bytes (issue #209). Its status is then exactly
    // the status validation inspected, so the full inspection is not repeated.
    assertClearSidecars(paths.database);
    if (!samePublishedDatabase(captureDatabaseIdentity(paths.database), input.candidate.identity)) {
      throw new GraphMaintenanceError(
        "GRAPH_CANDIDATE_INVALID",
        "The published graph is not the validated candidate.",
        input.candidate.status.diagnostics,
      );
    }
    assertMaintenanceDirectoryUnchanged(paths);
    const status = input.candidate.status;
    (input.assertStatus ?? assertPublishableCandidate)(status);
    const diagnostics: Diagnostic[] = [...status.diagnostics];
    let recoveryPath: string | undefined;
    if (rollbackPath && input.retainRecovery) {
      if (rollbackIdentity) assertOwnedCopyUnchanged(rollbackPath, rollbackIdentity);
      recoveryPath = toRepoRelative(paths.projectRoot, rollbackPath);
      diagnostics.push(recoveryRetainedDiagnostic(
        recoveryPath,
        "The replaced incompatible or corrupt graph database was retained as ignored local recovery data.",
      ));
      rollbackPath = null;
      rollbackIdentity = null;
    } else if (rollbackPath) {
      cleanupOwnedDatabase(paths, rollbackPath);
      rollbackPath = null;
      rollbackIdentity = null;
    }
    return { status, recoveryPath, diagnostics };
  } catch (error) {
    if (published && rollbackPath) {
      try {
        assertMaintenanceDirectoryUnchanged(paths);
        if (!existsSync(rollbackPath)) throw new Error("The rollback copy disappeared.");
        if (!rollbackIdentity) throw new Error("The rollback copy has no bound identity.");
        assertOwnedCopyUnchanged(rollbackPath, rollbackIdentity);
        assertPublishedCandidateOwnsLivePath(paths, input.candidate);
        await options.__internal?.beforeRollbackRestore?.(rollbackPath, paths.database);
        assertMaintenanceDirectoryUnchanged(paths);
        assertOwnedCopyUnchanged(rollbackPath, rollbackIdentity);
        assertPublishedCandidateOwnsLivePath(paths, input.candidate);
        renameSync(rollbackPath, paths.database);
        rollbackPath = null;
        rollbackIdentity = null;
        fsyncMaintenanceDirectory(paths);
      } catch {
        const retainedPath = rollbackPath && rollbackIdentity
          ? retainBoundRollbackCopy(paths, rollbackPath, rollbackIdentity)
          : undefined;
        // Never let the outer finally delete the only prior snapshot after a
        // restore failure. Even when directory safety prevents a trustworthy
        // path projection, leaving the copy untouched is safer than deletion.
        rollbackPath = null;
        rollbackIdentity = null;
        const diagnostics = retainedPath
          ? [
              ...input.candidate.status.diagnostics,
              recoveryRetainedDiagnostic(retainedPath, "Automatic rollback failed; the exact prior graph bytes were retained for manual recovery."),
            ]
          : input.candidate.status.diagnostics;
        throw new GraphMaintenanceError(
          "GRAPH_PUBLICATION_FAILED",
          "The graph candidate failed validation and automatic rollback could not be completed safely."
            + (retainedPath ? ` Exact prior bytes remain at ${retainedPath}.` : ""),
          diagnostics,
          retainedPath,
        );
      }
    } else if (published && input.priorIdentity === null) {
      // A failed first build has no prior file to rename back. Restore the
      // exact prior `missing` state, but only while the live path is still the
      // same file object that we published. If another writer replaced it, it
      // is safer to leave that path alone and report the failed rollback.
      try {
        restoreMissingDatabaseState(input);
      } catch {
        throw new GraphMaintenanceError(
          "GRAPH_PUBLICATION_FAILED",
          "The first graph candidate failed validation and the prior missing state could not be restored safely.",
          input.candidate.status.diagnostics,
        );
      }
    }
    if (error instanceof GraphMaintenanceError) throw error;
    throw new GraphMaintenanceError(
      published ? "GRAPH_PUBLICATION_FAILED" : "GRAPH_MAINTENANCE_RACE",
      published
        ? "The graph candidate could not be published safely."
        : "The live graph changed before candidate publication.",
      input.priorStatus.diagnostics,
    );
  } finally {
    if (rollbackPath) cleanupOwnedDatabase(paths, rollbackPath);
  }
}

function retainBoundRollbackCopy(
  paths: MaintenancePaths,
  rollbackPath: string,
  rollbackIdentity: DatabaseIdentity,
): string | undefined {
  try {
    assertMaintenanceDirectoryUnchanged(paths);
    assertOwnedCopyUnchanged(rollbackPath, rollbackIdentity);
    return toRepoRelative(paths.projectRoot, rollbackPath);
  } catch {
    return undefined;
  }
}

function recoveryRetainedDiagnostic(path: string, message: string): Diagnostic {
  return {
    code: "GRAPH_INDEX_RECOVERY_RETAINED",
    severity: "info",
    message,
    path,
  };
}

function assertPublishedCandidateOwnsLivePath(
  paths: MaintenancePaths,
  candidate: ValidatedCandidate,
): void {
  assertMaintenanceDirectoryUnchanged(paths);
  const active = safeLstat(paths.database);
  if (!active
    || !active.isFile()
    || active.isSymbolicLink()
    || active.dev !== candidate.identity.dev
    || active.ino !== candidate.identity.ino) {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_RACE",
      "The published candidate was replaced before rollback; the replacement live path was not overwritten.",
    );
  }
  assertClearSidecars(paths.database);
}

function restoreMissingDatabaseState(input: CandidatePublicationInput): void {
  const { paths, candidatePath, candidate } = input;
  assertMaintenanceDirectoryUnchanged(paths);
  if (!existsSync(paths.database)) {
    fsyncMaintenanceDirectory(paths);
    return;
  }
  const active = lstatSync(paths.database);
  if (!active.isFile()
    || active.isSymbolicLink()
    || active.dev !== candidate.identity.dev
    || active.ino !== candidate.identity.ino) {
    throw new GraphMaintenanceError(
      "GRAPH_PUBLICATION_FAILED",
      "The published graph path was replaced before the prior missing state could be restored.",
    );
  }
  assertClearSidecars(paths.database);
  if (existsSync(candidatePath)) {
    throw new GraphMaintenanceError(
      "GRAPH_PUBLICATION_FAILED",
      "The owned candidate path was unexpectedly occupied during missing-state restoration.",
    );
  }
  assertMaintenanceDirectoryUnchanged(paths);
  renameSync(paths.database, candidatePath);
  fsyncMaintenanceDirectory(paths);
}

function maintenanceResult(
  started: Date,
  finished: Date,
  build: BuildResult,
  published: CandidatePublicationResult,
): GraphMaintenanceResult {
  return {
    state: "succeeded",
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: Math.max(0, finished.getTime() - started.getTime()),
    diagnostics: published.diagnostics,
    status: published.status,
    filesIndexed: build.filesIndexed,
    nodesCreated: build.nodesCreated,
    edgesCreated: build.edgesCreated,
    ...(build.skipped && build.skipped.length > 0 ? { skipped: build.skipped } : {}),
    ...(build.declinedInputs && build.declinedInputs.length > 0
      ? { declinedInputs: build.declinedInputs }
      : {}),
    ...(build.refresh ? { refresh: build.refresh } : {}),
    ...(published.recoveryPath ? { recoveryPath: published.recoveryPath } : {}),
  };
}

function resolveMaintenancePaths(projectRoot: string, createMexDir: boolean): MaintenancePaths {
  const root = resolve(projectRoot);
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_PATH_UNSAFE",
      "The project root could not be resolved safely.",
    );
  }
  const mexDir = join(root, ".mex");
  if (!existsSync(mexDir)) {
    if (!createMexDir) {
      throw new GraphMaintenanceError(
        "GRAPH_INDEX_MISSING",
        "The graph index does not exist. Run `mex graph rebuild` first.",
      );
    }
    mkdirSync(mexDir, { recursive: true, mode: 0o700 });
  }
  const mexStats = lstatSync(mexDir);
  if (!mexStats.isDirectory() || mexStats.isSymbolicLink()) {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_PATH_UNSAFE",
      "The .mex maintenance directory must be a contained, non-symlink directory.",
    );
  }
  const mexReal = realpathSync(mexDir);
  if (!isContained(rootReal, mexReal)) {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_PATH_UNSAFE",
      "The .mex maintenance directory resolves outside the project root.",
    );
  }
  const database = join(mexDir, "graph.db");
  if (existsSync(database)) assertRegularNonSymlink(database, "graph database");
  return {
    projectRoot: root,
    projectRootReal: rootReal,
    mexDir,
    mexDirReal: mexReal,
    mexDirDev: mexStats.dev,
    mexDirIno: mexStats.ino,
    database,
    lock: join(mexDir, LOCK_FILE),
    lockGate: join(mexDir, LOCK_GATE_FILE),
  };
}

function acquireMaintenanceLock(
  paths: MaintenancePaths,
  options: InternalMaintenanceOptions,
): MaintenanceLock {
  const owner: LockOwner = {
    pid: process.pid,
    token: createToken(options),
    startedAt: currentDate(options).toISOString(),
  };
  const gate = acquireLockGate(paths, owner);
  try {
    options.__internal?.afterLockGateAcquired?.(paths.lockGate);
    assertMaintenanceDirectoryUnchanged(paths);
    assertLockOwned(paths.lockGate, gate.owner, gate.identity);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let fd: number | null = null;
      try {
        assertMaintenanceDirectoryUnchanged(paths);
        assertLockOwned(paths.lockGate, gate.owner, gate.identity);
        const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
        fd = openSync(
          paths.lock,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
          0o600,
        );
        writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
        const identity = captureLockIdentity(paths.lock);
        assertLockOwned(paths.lockGate, gate.owner, gate.identity);
        fsyncMaintenanceDirectory(paths);
        return {
          owner,
          identity,
          release: () => releaseMaintenanceLock(paths, owner, identity),
        };
      } catch (error) {
        if (fd !== null) closeSync(fd);
        if (errorCode(error) !== "EEXIST") throw error;
        if (attempt === 0 && reclaimDeadLock(paths, paths.lock, gate, options)) continue;
        throw new GraphMaintenanceError(
          "GRAPH_MAINTENANCE_LOCKED",
          "Another graph maintenance operation is already active for this project.",
        );
      }
    }
  } finally {
    gate.release();
  }
  throw new GraphMaintenanceError(
    "GRAPH_MAINTENANCE_LOCKED",
    "Another graph maintenance operation is already active for this project.",
  );
}

function acquireLockGate(paths: MaintenancePaths, owner: LockOwner): MaintenanceLock {
  assertMaintenanceDirectoryUnchanged(paths);
  let fd: number | null = null;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    fd = openSync(
      paths.lockGate,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    const identity = captureLockIdentity(paths.lockGate);
    fsyncMaintenanceDirectory(paths);
    return {
      owner,
      identity,
      release: () => releaseLockGate(paths, owner, identity),
    };
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (errorCode(error) === "EEXIST") {
      const existing = readLockOwner(paths.lockGate);
      if (!existing || !processIsAlive(existing.pid)) {
        const path = toRepoRelative(paths.projectRoot, paths.lockGate);
        const message = "A prior graph lock acquisition was interrupted and left its acquisition gate behind. Verify no mex process is running, remove the reported gate path, and retry.";
        throw new GraphMaintenanceError(
          "GRAPH_MAINTENANCE_GATE_STALE",
          `${message} Gate: ${path}.`,
          [{
            code: "GRAPH_MAINTENANCE_GATE_STALE",
            severity: "error",
            message,
            path,
          }],
        );
      }
      throw new GraphMaintenanceError(
        "GRAPH_MAINTENANCE_LOCKED",
        "Another graph maintenance lock acquisition is already in progress for this project.",
      );
    }
    throw error;
  }
}

function releaseLockGate(
  paths: MaintenancePaths,
  owner: LockOwner,
  identity: StatIdentity,
): void {
  try {
    assertMaintenanceDirectoryUnchanged(paths);
    assertLockOwned(paths.lockGate, owner, identity);
    unlinkSync(paths.lockGate);
    fsyncMaintenanceDirectory(paths);
  } catch {
    // A replaced directory or gate is never deleted through a stale owner.
  }
}

function reclaimDeadLock(
  paths: MaintenancePaths,
  lockPath: string,
  gate: MaintenanceLock,
  options: InternalMaintenanceOptions,
): boolean {
  assertMaintenanceDirectoryUnchanged(paths);
  const owner = readLockOwner(lockPath);
  if (!owner || processIsAlive(owner.pid)) return false;
  options.__internal?.beforeDeadLockReclaim?.(lockPath);
  assertMaintenanceDirectoryUnchanged(paths);
  const before = safeLstat(lockPath);
  if (!before || !before.isFile() || before.isSymbolicLink()) return false;
  const current = readLockOwner(lockPath);
  const after = safeLstat(lockPath);
  if (!current || current.token !== owner.token || !after || !sameStatIdentity(before, after)) return false;
  try {
    // Every cooperating creator holds lockGate from its O_EXCL lock creation
    // through this reclaim decision. The final token/inode check is therefore
    // a compare-and-delete with respect to concurrent MEX reclaimers/creators.
    assertMaintenanceDirectoryUnchanged(paths);
    assertLockOwned(paths.lockGate, gate.owner, gate.identity);
    unlinkSync(lockPath);
    fsyncMaintenanceDirectory(paths);
    return true;
  } catch (error) {
    if (error instanceof GraphMaintenanceError) throw error;
    return false;
  }
}

function releaseMaintenanceLock(
  paths: MaintenancePaths,
  owner: LockOwner,
  identity: StatIdentity,
): void {
  try {
    assertMaintenanceDirectoryUnchanged(paths);
    assertLockOwned(paths.lock, owner, identity);
    unlinkSync(paths.lock);
    fsyncMaintenanceDirectory(paths);
  } catch {
    // A lost or replaced owner token is safer to leave for explicit diagnosis.
  }
}

function readLockOwner(lockPath: string): LockOwner | null {
  let fd: number | null = null;
  try {
    const before = lstatSync(lockPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_LOCK_BYTES) return null;
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    fd = openSync(lockPath, constants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (!sameStatIdentity(before, opened)) return null;
    const raw = readFileSync(fd, "utf8");
    const after = fstatSync(fd);
    if (!sameStatIdentity(opened, after)) return null;
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (!Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0
      || typeof parsed.token !== "string" || !/^[a-f0-9]{32,128}$/u.test(parsed.token)
      || typeof parsed.startedAt !== "string" || !Number.isFinite(Date.parse(parsed.startedAt))) return null;
    return { pid: Number(parsed.pid), token: parsed.token, startedAt: parsed.startedAt };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function captureLockIdentity(lockPath: string): StatIdentity {
  const stats = lstatSync(lockPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_LOCK_BYTES) {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_PATH_UNSAFE",
      `The maintenance lock ${basename(lockPath)} is not a bounded regular file.`,
    );
  }
  return stats;
}

function assertLockOwned(
  lockPath: string,
  owner: LockOwner,
  identity: StatIdentity,
): void {
  const current = readLockOwner(lockPath);
  const stats = safeLstat(lockPath);
  if (!current
    || current.pid !== owner.pid
    || current.token !== owner.token
    || !stats
    || !sameStatIdentity(stats, identity)) {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_RACE",
      `The maintenance lock ${basename(lockPath)} changed ownership unexpectedly.`,
    );
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function captureDatabaseIdentity(path: string): DatabaseIdentity {
  return timeGraphPhase("envelope.dbIdentityHash", () => captureDatabaseIdentityUntimed(path));
}

/**
 * The exact identity of the database at `path`. With `copyTo`, the same bytes
 * that are hashed are also written to that descriptor, so the copy is bound
 * to the digest in one read.
 */
function captureDatabaseIdentityUntimed(path: string, copyTo?: number): DatabaseIdentity {
  assertRegularNonSymlink(path, "graph database");
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(fd);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let offset = 0;
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, offset);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
      if (copyTo !== undefined) {
        for (let written = 0; written < count;) {
          written += writeSync(copyTo, chunk, written, count - written, offset + written);
        }
      }
      offset += count;
    }
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (!sameStatIdentity(before, after)
      || !sameStatIdentity(after, pathAfter)
      || pathAfter.isSymbolicLink()) {
      throw new GraphMaintenanceError(
        "GRAPH_MAINTENANCE_RACE",
        "The graph database changed while its exact identity was captured.",
      );
    }
    return {
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      digest: hash.digest("hex"),
    };
  } finally {
    closeSync(fd);
  }
}

function copyExactDatabase(
  paths: MaintenancePaths,
  sourcePath: string,
  destinationPath: string,
  expected: DatabaseIdentity,
): DatabaseIdentity {
  assertMaintenanceDirectoryUnchanged(paths);
  assertOwnedDatabasePath(destinationPath);
  if (existsSync(destinationPath)) {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_PATH_UNSAFE",
      `Refusing to overwrite an existing owned maintenance path (${basename(destinationPath)}).`,
    );
  }
  assertMaintenanceDirectoryUnchanged(paths);
  // One read hashes the source and writes the copy: the source identity is
  // captured across the whole copy (stat stable from open to close), and the
  // copy is then read back and must carry the expected digest.
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const destination = openSync(
    destinationPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
    0o600,
  );
  let source: DatabaseIdentity;
  try {
    // Keep the source's permission bits, as a file copy would.
    fchmodSync(destination, lstatSync(sourcePath).mode & 0o777);
    source = timeGraphPhase("envelope.dbIdentityHash", () => captureDatabaseIdentityUntimed(sourcePath, destination));
  } catch (error) {
    closeSync(destination);
    cleanupOwnedDatabasePath(paths, destinationPath);
    throw error;
  }
  closeSync(destination);
  if (!sameDatabaseIdentity(source, expected)) {
    cleanupOwnedDatabasePath(paths, destinationPath);
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_RACE",
      "The live graph changed before it could be copied safely.",
    );
  }
  const copied = captureDatabaseIdentity(destinationPath);
  if (copied.digest !== expected.digest || copied.size !== expected.size) {
    cleanupOwnedDatabasePath(paths, destinationPath);
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_RACE",
      "The graph database changed while an exact maintenance copy was being created.",
    );
  }
  assertMaintenanceDirectoryUnchanged(paths);
  fsyncFile(destinationPath);
  return copied;
}

function assertOwnedCopyUnchanged(path: string, expected: DatabaseIdentity): void {
  assertOwnedDatabasePath(path);
  if (!existsSync(path) || !sameDatabaseIdentity(captureDatabaseIdentity(path), expected)) {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_RACE",
      `The owned maintenance copy ${basename(path)} changed after its exact bytes were bound.`,
    );
  }
}

function revalidateLiveDatabase(path: string, expected: DatabaseIdentity | null): void {
  if (expected === null) {
    if (existsSync(path)) {
      throw new GraphMaintenanceError(
        "GRAPH_MAINTENANCE_RACE",
        "A graph database appeared while an isolated rebuild was in progress.",
      );
    }
    return;
  }
  if (!existsSync(path) || !sameDatabaseIdentity(captureDatabaseIdentity(path), expected)) {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_RACE",
      "The live graph changed while an isolated candidate was being built.",
    );
  }
}

async function validateCandidate(
  options: InternalMaintenanceOptions,
  paths: MaintenancePaths,
  candidatePath: string,
  assertStatus: (status: GraphStatus) => void = assertPublishableCandidate,
  bandHashMemo?: Map<string, readonly string[]>,
): Promise<ValidatedCandidate> {
  assertMaintenanceDirectoryUnchanged(paths);
  assertClearSidecars(candidatePath);
  const identityBefore = captureDatabaseIdentity(candidatePath);
  const status = await inspect(options, paths.projectRoot, candidatePath, bandHashMemo);
  assertMaintenanceDirectoryUnchanged(paths);
  assertStatus(status);
  assertClearSidecars(candidatePath);
  // This pair of full-byte identities brackets both the complete inspection
  // and its snapshot read. Nested hashes around the same read add no evidence.
  assertSnapshotWithinIdentityCheck(candidatePath);
  const identityAfter = captureDatabaseIdentity(candidatePath);
  assertClearSidecars(candidatePath);
  if (!sameDatabaseIdentity(identityBefore, identityAfter)) {
    throw new GraphMaintenanceError(
      "GRAPH_CANDIDATE_INVALID",
      "The graph candidate changed while it was being validated.",
      status.diagnostics,
    );
  }
  return {
    status,
    identity: identityAfter,
  };
}

function assertCandidateUnchanged(candidatePath: string, candidate: ValidatedCandidate): void {
  if (!existsSync(candidatePath)) {
    throw new GraphMaintenanceError("GRAPH_MAINTENANCE_RACE", "The graph candidate disappeared before publication.");
  }
  assertClearSidecars(candidatePath);
  const identity = captureDatabaseIdentity(candidatePath);
  assertClearSidecars(candidatePath);
  // Exact whole-database byte equality includes the validated snapshot row.
  // Reopening SQLite and hashing the entire file twice again to compare that
  // one row cannot strengthen this identity-bound publication check.
  if (!sameDatabaseIdentity(identity, candidate.identity)) {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_RACE",
      "The graph candidate changed after validation and was not published.",
      candidate.status.diagnostics,
    );
  }
}

/** Called only inside validateCandidate's complete before/after byte binding. */
function assertSnapshotWithinIdentityCheck(path: string): void {
  assertClearSidecars(path);
  const db = openSqlite(path, { readOnly: true, immutable: true });
  try {
    const row = db.prepare(
      "SELECT value FROM project_metadata WHERE key = ?",
    ).get(GRAPH_SNAPSHOT_METADATA_KEY) as { value?: unknown } | undefined;
    if (typeof row?.value !== "string") {
      throw new GraphMaintenanceError(
        "GRAPH_CANDIDATE_INVALID",
        "The graph candidate is missing exact graph_snapshot_v1 provenance.",
      );
    }
  } finally {
    db.close();
  }
}

function shouldCloneForContinuity(status: GraphStatus): boolean {
  if (status.status === "fresh" || status.status === "stale" || status.status === "degraded") {
    return status.schemaVersion === DB_SCHEMA_VERSION;
  }
  return status.status === "rebuild_required"
    && status.schemaVersion !== null
    && status.schemaVersion <= DB_SCHEMA_VERSION;
}

function isContinuityCloneCompatibilityFailure(error: unknown): boolean {
  if (error instanceof GraphCandidateProcessError) return error.category === "compatibility";
  if (error instanceof GraphSourceStagingError || error instanceof GraphMaintenanceError) return false;
  const code = errorCode(error).toUpperCase();
  const name = error instanceof Error ? error.name : "";
  const message = errorMessage(error);
  return name === "GraphRebuildRequiredError"
    || ["ERR_SQLITE_CORRUPT", "ERR_SQLITE_NOTADB", "ERR_SQLITE_SCHEMA",
      "SQLITE_CORRUPT", "SQLITE_NOTADB", "SQLITE_SCHEMA"].includes(code)
    || /(?:database disk image is malformed|file is not a database|malformed database schema|no such (?:table|column)|duplicate column name|unsupported graph schema)/iu.test(message);
}

function assertRefreshable(status: GraphStatus): void {
  if (status.status === "missing") {
    throw new GraphMaintenanceError(
      "GRAPH_INDEX_MISSING",
      "The graph index does not exist. Run `mex graph rebuild` first.",
      status.diagnostics,
    );
  }
  const blockedCodes = new Set([
    "GRAPH_INDEX_CORRUPT",
    "GRAPH_INDEX_SCHEMA_INVALID",
    "GRAPH_INDEX_INVARIANT_FAILED",
    "GRAPH_INDEX_REBUILD_REQUIRED",
    "GRAPH_INDEX_SIDECAR_ACTIVE",
    "GRAPH_INDEX_SIDECAR_UNAVAILABLE",
    "GRAPH_INDEX_LOCKED",
    "GRAPH_INDEX_UNAVAILABLE",
    "GRAPH_INDEX_PATH_OUTSIDE_PROJECT",
    "GRAPH_INDEX_PATH_UNAVAILABLE",
    "GRAPH_SOURCE_INSPECTION_INCOMPLETE",
    "GRAPH_SEMANTIC_INPUT_INSPECTION_INCOMPLETE",
    "GRAPH_REPO_INSPECTION_INCOMPLETE",
    "GRAPH_MANIFEST_INSPECTION_FAILED",
    "GRAPH_STATUS_OBSERVATION_RACE",
  ]);
  if (status.schemaVersion !== DB_SCHEMA_VERSION
    || status.status === "corrupt"
    || status.status === "rebuild_required"
    || status.diagnostics.some((diagnostic) => blockedCodes.has(diagnostic.code))) {
    throw new GraphMaintenanceError(
      "GRAPH_INDEX_NOT_REFRESHABLE",
      "The current graph cannot be refreshed safely. Run `mex graph rebuild` after resolving its diagnostics.",
      status.diagnostics,
    );
  }
}

function assertRepairSourceSafe(status: GraphStatus): void {
  if (status.status === "missing") {
    throw new GraphMaintenanceError(
      "GRAPH_INDEX_MISSING",
      "The graph index does not exist. Run `mex graph rebuild` first.",
      status.diagnostics,
    );
  }
  const blockedCodes = new Set([
    "GRAPH_INDEX_CORRUPT",
    "GRAPH_INDEX_SCHEMA_INVALID",
    "GRAPH_INDEX_INVARIANT_FAILED",
    "GRAPH_INDEX_SIDECAR_UNAVAILABLE",
    "GRAPH_INDEX_UNAVAILABLE",
    "GRAPH_INDEX_PATH_OUTSIDE_PROJECT",
    "GRAPH_INDEX_PATH_UNAVAILABLE",
    "GRAPH_INDEX_CORPUS_LIMIT_EXCEEDED",
    "GRAPH_SOURCE_CORPUS_LIMIT_EXCEEDED",
    "GRAPH_SOURCE_INSPECTION_INCOMPLETE",
    "GRAPH_SEMANTIC_INPUT_INSPECTION_INCOMPLETE",
    "GRAPH_REPO_INSPECTION_INCOMPLETE",
    "GRAPH_MANIFEST_INSPECTION_FAILED",
    "GRAPH_STATUS_OBSERVATION_RACE",
  ]);
  if (status.status === "corrupt"
    || status.diagnostics.some((diagnostic) => blockedCodes.has(diagnostic.code))) {
    throw new GraphMaintenanceError(
      "GRAPH_INDEX_NOT_REPAIRABLE",
      "The current graph cannot be repaired losslessly. Run `mex graph rebuild` after resolving its diagnostics.",
      status.diagnostics,
    );
  }
}

function assertRepairPublishableCandidate(status: GraphStatus): void {
  if (status.status === "stale") return;
  assertPublishableCandidate(status);
}

/**
 * Diagnostics that describe a gap the build made deliberately and completely.
 *
 * A file the corpus policy declined to read, or one that parsed partially, is
 * a known hole in an otherwise complete candidate — the indexing, publication
 * and freshness paths all agree it is not in the corpus. Refusing to publish
 * over one of these throws away every other file's facts to punish a gap that
 * a rebuild would reproduce exactly, which leaves the repository with no graph
 * at all rather than a graph with a documented hole.
 *
 * Corpus-*wide* breaches and incomplete inspections are deliberately absent:
 * those mean the observation itself is untrustworthy, not that one file is
 * missing from a trustworthy one.
 */
const PUBLISHABLE_DEGRADED_CODES = new Set([
  "GRAPH_PARSE_DEGRADED",
  "GRAPH_INDEX_HEAD_CHANGED",
  // Added by the per-file skip path. Without it the publish gate discarded the
  // candidate that path exists to produce.
  "GRAPH_SOURCE_FILE_SKIPPED",
  // Bounded companion of the above: emitted when more files were skipped than
  // the diagnostic limit reports individually.
  "GRAPH_SOURCE_DIAGNOSTICS_TRUNCATED",
]);

function assertPublishableCandidate(status: GraphStatus): void {
  if (status.status === "fresh") return;
  const degradedOnlyByKnownGaps = status.status === "degraded"
    && status.changes.total === 0
    && !status.changes.branchChanged
    && !status.changes.manifestChanged
    && !status.changes.configChanged
    && !status.changes.grammarChanged
    && status.diagnostics.every((diagnostic) => (
      diagnostic.severity !== "error" && PUBLISHABLE_DEGRADED_CODES.has(diagnostic.code)
    ));
  if (degradedOnlyByKnownGaps) return;
  throw new GraphMaintenanceError(
    "GRAPH_CANDIDATE_INVALID",
    `The isolated graph candidate validated as ${status.status}; the live graph was not replaced.`,
    status.diagnostics,
  );
}

function assertClearSidecarsIfPresent(path: string): void {
  if (existsSync(path)) assertClearSidecars(path);
}

function assertClearSidecars(path: string): void {
  const probe = inspectGraphSidecars(path);
  if (probe.state === "clear") return;
  throw new GraphMaintenanceError(
    "GRAPH_MAINTENANCE_LOCKED",
    probe.state === "active"
      ? `SQLite recovery activity is active (${probe.paths.join(", ")}); graph maintenance was not started.`
      : `SQLite recovery state could not be verified (${probe.paths.join(", ")}); graph maintenance was not started.`,
  );
}

function progress(
  options: GraphMaintenanceOptions,
  phase: GraphMaintenanceProgress["phase"],
  message: string,
): void {
  assertNotAborted(options.signal);
  options.onProgress?.({ phase, message });
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new GraphMaintenanceError(
    "GRAPH_MAINTENANCE_CANCELLED",
    "Graph maintenance was cancelled before publication completed.",
  );
}

async function inspect(
  options: InternalMaintenanceOptions,
  projectRoot: string,
  database: string,
  bandHashMemo?: Map<string, readonly string[]>,
): Promise<GraphStatus> {
  return (options.__internal?.inspectStatus ?? inspectGraphStatus)({
    projectRoot,
    dbPath: database,
    ...(bandHashMemo ? { bandHashMemo } : {}),
  });
}

function currentDate(options: InternalMaintenanceOptions): Date {
  const date = options.__internal?.now?.() ?? new Date();
  if (Number.isNaN(date.getTime())) throw new TypeError("Graph maintenance requires a valid clock value.");
  return date;
}

function createToken(options: InternalMaintenanceOptions): string {
  const value = options.__internal?.token?.() ?? randomBytes(24).toString("hex");
  if (!/^[a-f0-9]{32,128}$/u.test(value)) {
    throw new TypeError("Graph maintenance tokens must be 32-128 lowercase hexadecimal characters.");
  }
  return value;
}

function ownedPath(paths: MaintenancePaths, kind: "candidate" | "rollback" | "recovery", token: string): string {
  assertMaintenanceDirectoryUnchanged(paths);
  const path = join(paths.mexDir, `graph.db.${kind}-${token}`);
  assertOwnedDatabasePath(path);
  return path;
}

function cleanupOwnedDatabase(paths: MaintenancePaths, path: string): void {
  assertMaintenanceDirectoryUnchanged(paths);
  if (dirname(path) !== paths.mexDir) return;
  cleanupOwnedDatabasePath(paths, path);
  cleanupDiscardedOwnedSidecars(paths, path);
}

function cleanupOwnedDatabasePath(paths: MaintenancePaths, path: string): void {
  assertMaintenanceDirectoryUnchanged(paths);
  assertOwnedDatabasePath(path);
  try {
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function cleanupCheckpointedOwnedSidecars(paths: MaintenancePaths, databasePath: string): void {
  assertMaintenanceDirectoryUnchanged(paths);
  if (dirname(databasePath) !== paths.mexDir) return;
  assertOwnedDatabasePath(databasePath);
  // Re-probe immediately before unlinking. A non-empty WAL/journal can contain
  // authoritative candidate data and must never be silently discarded or
  // separated from the main file selected for publication.
  const probe = inspectGraphSidecars(databasePath);
  if (probe.state !== "clear") {
    throw new GraphMaintenanceError(
      "GRAPH_CANDIDATE_INVALID",
      "The validated graph candidate acquired SQLite recovery state before publication.",
    );
  }
  for (const suffix of ["-wal", "-journal"] as const) {
    const path = `${databasePath}${suffix}`;
    try {
      const stats = lstatSync(path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== 0) {
        throw new GraphMaintenanceError(
          "GRAPH_CANDIDATE_INVALID",
          `The candidate sidecar ${basename(path)} was not a checkpointed empty regular file.`,
        );
      }
      assertMaintenanceDirectoryUnchanged(paths);
      unlinkSync(path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  // A shared-memory file contains no authoritative pages without a WAL. It is
  // still removed only after the WAL/journal probe above proved the closed
  // candidate checkpointed.
  const shmPath = `${databasePath}-shm`;
  try {
    const stats = lstatSync(shmPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new GraphMaintenanceError(
        "GRAPH_CANDIDATE_INVALID",
        `The candidate sidecar ${basename(shmPath)} is not a regular file.`,
      );
    }
    assertMaintenanceDirectoryUnchanged(paths);
    unlinkSync(shmPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/** Cleanup only after the owned candidate main file has been discarded. */
function cleanupDiscardedOwnedSidecars(paths: MaintenancePaths, databasePath: string): void {
  assertMaintenanceDirectoryUnchanged(paths);
  if (dirname(databasePath) !== paths.mexDir) return;
  assertOwnedDatabasePath(databasePath);
  for (const suffix of ["-wal", "-shm", "-journal"] as const) {
    try {
      assertMaintenanceDirectoryUnchanged(paths);
      unlinkSync(`${databasePath}${suffix}`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

function assertOwnedDatabasePath(path: string): void {
  if (!OWNED_DATABASE_PREFIXES.some((prefix) => basename(path).startsWith(prefix))) {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_PATH_UNSAFE",
      "Refusing to modify a path not owned by graph maintenance.",
    );
  }
}

function assertRegularNonSymlink(path: string, label: string): void {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_PATH_UNSAFE",
      `The ${label} must be a contained, non-symlink regular file.`,
    );
  }
}

function assertMaintenanceDirectoryUnchanged(paths: MaintenancePaths): void {
  let stats: Stats;
  let real: string;
  try {
    stats = lstatSync(paths.mexDir);
    real = realpathSync(paths.mexDir);
  } catch {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_PATH_UNSAFE",
      "The bound .mex maintenance directory became unavailable.",
    );
  }
  if (!stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.dev !== paths.mexDirDev
    || stats.ino !== paths.mexDirIno
    || real !== paths.mexDirReal
    || !isContained(paths.projectRootReal, real)) {
    throw new GraphMaintenanceError(
      "GRAPH_MAINTENANCE_PATH_UNSAFE",
      "The bound .mex maintenance directory changed or escaped the project; no further filesystem mutation was attempted.",
    );
  }
}

function fsyncMaintenanceDirectory(paths: MaintenancePaths): void {
  assertMaintenanceDirectoryUnchanged(paths);
  fsyncDirectory(paths.mexDir);
}

function fsyncFile(path: string): void {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  // Windows requires a write-capable handle for FlushFileBuffers. The
  // candidate and recovery files are maintenance-owned writable artifacts;
  // O_RDWR preserves no-follow binding while making fsync portable.
  const fd = openSync(path, constants.O_RDWR | noFollow);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    // Directory fsync is unsupported on some Node/OS combinations. File fsync
    // and atomic same-directory rename still provide the publication boundary.
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(errorCode(error))) throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function safeLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function sameStatIdentity(
  left: StatIdentity,
  right: StatIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

/**
 * A rename keeps the file object and its bytes; some platforms still move its
 * change time, which therefore does not take part.
 */
function samePublishedDatabase(published: DatabaseIdentity, validated: DatabaseIdentity): boolean {
  return published.dev === validated.dev
    && published.ino === validated.ino
    && published.size === validated.size
    && published.mtimeMs === validated.mtimeMs
    && published.digest === validated.digest;
}

/** A cheap file-object identity for the read-only no-op check. */
function liveDatabaseStat(path: string): Pick<DatabaseIdentity, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs"> | null {
  const stats = safeLstat(path);
  if (!stats || !stats.isFile() || stats.isSymbolicLink()) return null;
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}

function sameLiveDatabaseStat(
  left: ReturnType<typeof liveDatabaseStat>,
  right: ReturnType<typeof liveDatabaseStat>,
): boolean {
  return left !== null && right !== null
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameDatabaseIdentity(left: DatabaseIdentity, right: DatabaseIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.digest === right.digest;
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"));
}

function toRepoRelative(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
