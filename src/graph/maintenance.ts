import { acquireGraphWriter, assertGraphDirectory, cloneGraph, collectGraphGarbage, currentGraphPath, discardGraphTemporary, enforceIndexCap, finalizeGraph, graphLocation, graphStoragePathAllowed, verifiedGraphLocation, graphTemporary, publishGraph, withGraphStorageContext, type GraphLocation } from "./storage.js";
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
  readdirSync,
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
import { auditRecordProvenInProcess, recordAuditedDatabase } from "./audit-record.js";
import { recallDigest, rememberDigest, withSourceMemo } from "./source-memo.js";
import { createGraphEngine, deltaAuditScope, GraphSourceStagingError, refreshWouldPublishNothing } from "./engine-impl.js";
import type { BuildResult, GraphEngine } from "./engine.js";
import {
  inspectGraphSidecars,
  inspectGraphStatus,
} from "./status.js";
import { GRAPH_SNAPSHOT_METADATA_KEY } from "./snapshot.js";
import { tryEnsureSetupIgnoreProtection } from "../setup/ignore.js";
import { GraphCandidateProcessError, runGraphCandidateProcess, type GraphCandidateProcessOptions } from "./candidate-process.js";
import { flushGraphPhaseTimings, timeGraphPhase, timeGraphPhaseAsync } from "./phase-timing.js";

const HASH_CHUNK_BYTES = 1024 * 1024;

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
  location: GraphLocation;
  projectRootReal: string;
  mexDir: string;
  mexDirReal: string;
  mexDirDev: number;
  mexDirIno: number;
  database: string;
  lock: string;
  lockGate: string;
  writer?: { assertOwned(): void };
}

interface DatabaseIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  digest: string;
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
  paths.writer = lock;
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
      // An interrupted earlier run cannot remove its own candidate (issue
      // #205). The lease is exclusive per project and is held here, so no
      // concurrent run can own one: any candidate still present is an orphan.
      sweepOrphanCandidates(paths);
      // One operation reads each unchanged source once; see source-memo.
      if (operation === "refresh") return await withGraphStorageContext(() => withSourceMemo(() => refreshGraphWithLease(paths, merged)));
      if (operation === "repair") return await withGraphStorageContext(() => withSourceMemo(() => repairGraphWithLease(paths, merged)));
      return await withGraphStorageContext(() => withSourceMemo(() => rebuildGraphWithLease(paths, merged)));
    } finally {
      active = false;
    }
  };
  return {
    projectRoot: paths.projectRoot,
    get databasePath() { return paths.database; },
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

/** Explicit ensure operation shared by the graph CLI and resumable setup. */
export async function ensureGraphCurrent(
  projectRoot: string,
  options: GraphMaintenanceExecutionOptions & { force?: boolean } = {},
): Promise<GraphMaintenanceResult & { operation: "unchanged" | "refresh" | "rebuild" }> {
  const started = new Date();
  progress(options, "discover", "Checking graph freshness.");
  if (options.force) return { ...await rebuildGraph(projectRoot, options), operation: "rebuild" };
  const status = await inspectGraphStatus({ projectRoot });
  assertNotAborted(options.signal);
  if (status.status === "fresh") {
    return {
      ...maintenanceResult(started, new Date(), {
        filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0,
      }, { status, diagnostics: status.diagnostics }),
      operation: "unchanged",
    };
  }
  try {
    assertRefreshable(status);
  } catch (error) {
    if (!(error instanceof GraphMaintenanceError)) throw error;
    return { ...await rebuildGraph(projectRoot, options), operation: "rebuild" };
  }
  return { ...await refreshGraph(projectRoot, options), operation: "refresh" };
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

async function repairGraphWithLease(paths: MaintenancePaths, options: InternalMaintenanceOptions): Promise<GraphRepairResult> {
  const started = currentDate(options);
  const candidatePath = graphTemporary(paths.location);
  try {
    const prior = captureDatabaseIdentity(paths.database);
    cloneGraph(paths.database, candidatePath);
    const upgrade = upgradeGraphDatabase(candidatePath);
    if (upgrade.requiresRebuild) throw new GraphMaintenanceError("GRAPH_INDEX_NOT_REPAIRABLE", "Run `mex graph rebuild`.");
    finalizeGraph(candidatePath);
    const candidate = await validateCandidate(options, paths, candidatePath, assertRepairPublishableCandidate);
    const published = await publishCandidate({ paths, candidatePath, candidate, priorStatus: candidate.status, priorIdentity: prior, retainRecovery: false, options });
    return { state: "succeeded", startedAt: started.toISOString(), finishedAt: currentDate(options).toISOString(), durationMs: currentDate(options).getTime() - started.getTime(), diagnostics: published.diagnostics, status: published.status, fromSchemaVersion: upgrade.fromVersion, toSchemaVersion: upgrade.toVersion, lineage: upgrade.lineage, upgraded: upgrade.changed, recoveredWalBytes: 0 };
  } finally { discardGraphTemporary(candidatePath); }
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
    const statBeforeInspect = liveDatabaseStat(paths.database);
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
    // A degraded graph differs from a fresh one only by partially parsed
    // files, which unchanged sources would parse the same way again.
    const statBefore = liveDatabaseStat(paths.database);
    if ((priorStatus.status === "fresh" || priorStatus.status === "degraded")
      && timeGraphPhase("envelope.noOpCheck", () => refreshWouldPublishNothing(paths.projectRoot, paths.database, {
        sourcesInspected: !options.__internal?.inspectStatus && sameLiveDatabaseStat(statBeforeInspect, statBefore),
      }))) {
      assertMaintenanceDirectoryUnchanged(paths);
      assertClearSidecars(paths.database);
      if (sameLiveDatabaseStat(statBefore, liveDatabaseStat(paths.database))) {
        // The inspection audited these bytes in full, or proved them the
        // bytes of an earlier audit. Recording them spares the next
        // inspection that audit, as a publication's record does.
        if (!options.__internal?.inspectStatus && sameLiveDatabaseStat(statBeforeInspect, statBefore)
          && !auditRecordProvenInProcess(realpathSync(paths.database), statBefore!)) {
          const audited = captureDatabaseIdentity(paths.database);
          if (sameLiveDatabaseStat(statBeforeInspect, audited)) {
            recordAuditedDatabase(realpathSync(paths.database), audited.size, audited.digest);
          }
        }
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
    timeGraphPhase("envelope.copy", () => copyExactDatabase(paths, paths.database, copyPath, priorIdentity, false));
    const buildResult = await timeGraphPhaseAsync("envelope.candidate", () =>
      refreshCandidate(paths, copyPath, options));
    await options.__internal?.afterCandidateBuilt?.(candidatePath);
    assertMaintenanceDirectoryUnchanged(paths);
    assertNotAborted(options.signal);

    progress(options, "validate", "Validating the refreshed graph candidate.");
    // The copy holds exactly the bytes the inspection audited (or proved
    // audited), and a delta publication rewrote only the files it reports:
    // the fingerprint audit is change-sized. Anything else audits in full.
    const fingerprintScope = options.__internal?.inspectStatus ? undefined : deltaAuditScope(buildResult);
    const candidate = await timeGraphPhaseAsync("envelope.validate", () =>
      validateCandidate(options, paths, copyPath, undefined, bandHashMemo, fingerprintScope));
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
    flushGraphPhaseTimings("refresh", paths.projectRoot);
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
    const priorStatus = await timeGraphPhaseAsync("envelope.inspect", () =>
      inspect(options, paths.projectRoot, paths.database));
    assertMaintenanceDirectoryUnchanged(paths);
    const databaseExists = existsSync(paths.database);
    if (databaseExists) assertClearSidecars(paths.database);
    const priorIdentity = databaseExists ? captureDatabaseIdentity(paths.database) : null;

    const cloneForContinuity = Boolean(priorIdentity && shouldCloneForContinuity(priorStatus));
    let continuityFallback = false;
    candidatePath = ownedPath(paths, "candidate", createToken(options));
    if (priorIdentity && cloneForContinuity) {
      copyExactDatabase(paths, paths.database, candidatePath, priorIdentity, false);
    }
    let buildResult: BuildResult;
    try {
      buildResult = await timeGraphPhaseAsync("envelope.build", () => rebuildCandidate(paths, candidatePath!, options));
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
    const candidate = await timeGraphPhaseAsync("envelope.validate", () => validateCandidate(options, paths, candidatePath!));
    await options.__internal?.afterCandidateValidated?.(candidatePath, candidate.status);
    assertMaintenanceDirectoryUnchanged(paths);

    const retainRecovery = priorStatus.status === "corrupt"
      || priorStatus.status === "rebuild_required";
    const publication = await timeGraphPhaseAsync("envelope.publish", () => publishCandidate({
      paths,
      candidatePath: candidatePath!,
      candidate,
      priorStatus,
      priorIdentity,
      retainRecovery,
      options,
    }));
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
    flushGraphPhaseTimings("rebuild", paths.projectRoot);
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
  const { paths, options, candidate } = input;
  assertMaintenanceDirectoryUnchanged(paths);
  assertNotAborted(options.signal);
  await options.__internal?.beforeLiveRevalidation?.();
  revalidateLiveDatabase(paths.database, input.priorIdentity);
  if (currentGraphPath(paths.projectRoot) !== paths.database) throw new GraphMaintenanceError("GRAPH_MAINTENANCE_RACE", "The graph pointer changed during construction.");
  assertCandidateUnchanged(input.candidatePath, candidate);
  progress(options, "publish", "Publishing the validated graph pointer.");
  assertMaintenanceDirectoryUnchanged(paths);
  assertNotAborted(options.signal);
  revalidateLiveDatabase(paths.database, input.priorIdentity);
  assertCandidateUnchanged(input.candidatePath, candidate);
  const countsDb = openSqlite(input.candidatePath, { readOnly: true, immutable: true });
  let counts: { nodes: number; edges: number };
  try { counts = countsDb.prepare("SELECT (SELECT count(*) FROM nodes) nodes, (SELECT count(*) FROM edges) edges").get() as typeof counts; } finally { countsDb.close(); }
  const database = publishGraph(paths.location, input.candidatePath, {
    head: candidate.status.currentRepo.head, files: candidate.status.parseHealth.ok + candidate.status.parseHealth.partial + candidate.status.parseHealth.failed,
    ...counts, build: { finishedAt: currentDate(options).toISOString() },
  });
  paths.database = database;
  recordAuditedDatabase(realpathSync(database), candidate.identity.size, candidate.identity.digest);
  collectGraphGarbage(paths.location);
  enforceIndexCap(paths.location);
  await options.__internal?.afterPublish?.(database);
  return { status: candidate.status, diagnostics: candidate.status.diagnostics };
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
    ...(build.typescript ? { typescript: build.typescript } : {}),
    ...(build.refresh ? { refresh: build.refresh } : {}),
    ...(published.recoveryPath ? { recoveryPath: published.recoveryPath } : {}),
  };
}

function resolveMaintenancePaths(projectRoot: string, create: boolean): MaintenancePaths {
  const location = create ? verifiedGraphLocation(projectRoot) : graphLocation(projectRoot, { create });
  assertGraphDirectory(location.directory);
  if (!existsSync(location.directory)) {
    if (!create) throw new GraphMaintenanceError("GRAPH_INDEX_MISSING", "Run `mex graph rebuild` first.");
    mkdirSync(location.directory, { recursive: true, mode: 0o700 });
  }
  const stats = lstatSync(location.directory);
  return { projectRoot: resolve(projectRoot), projectRootReal: realpathSync(projectRoot), location,
    mexDir: location.directory, mexDirReal: realpathSync(location.directory), mexDirDev: stats.dev, mexDirIno: stats.ino,
    database: currentGraphPath(projectRoot), lock: join(location.directory, "graph.lock"), lockGate: "" };
}
function acquireMaintenanceLock(paths: MaintenancePaths, _options: InternalMaintenanceOptions): { assertOwned(): void; release(): void } {
  try { return acquireGraphWriter(paths.location); }
  catch (error) { throw new GraphMaintenanceError((error as { code?: string }).code === "GRAPH_MAINTENANCE_LOCKED" ? "GRAPH_MAINTENANCE_LOCKED" : "GRAPH_MAINTENANCE_PATH_UNSAFE", errorMessage(error)); }
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
    // Bytes this operation already hashed with the identity unchanged since.
    const remembered = copyTo === undefined ? recallDigest(path, before) : undefined;
    if (remembered !== undefined) {
      const pathNow = lstatSync(path);
      if (sameStatIdentity(before, pathNow) && !pathNow.isSymbolicLink()) {
        return {
          dev: before.dev,
          ino: before.ino,
          size: before.size,
          mtimeMs: before.mtimeMs,
          ctimeMs: before.ctimeMs,
          digest: remembered,
        };
      }
    }
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
    const digest = hash.digest("hex");
    rememberDigest(path, after, digest);
    return {
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      digest,
    };
  } finally {
    closeSync(fd);
  }
}

function copyExactDatabase(paths: MaintenancePaths, source: string, destination: string, expected: DatabaseIdentity, _durable = true): DatabaseIdentity {
  assertMaintenanceDirectoryUnchanged(paths);
  revalidateLiveDatabase(source, expected);
  cloneGraph(source, destination);
  revalidateLiveDatabase(source, expected);
  const copied = captureDatabaseIdentity(destination);
  if (copied.digest !== expected.digest || copied.size !== expected.size) throw new GraphMaintenanceError("GRAPH_MAINTENANCE_RACE", "The graph clone differs from its source.");
  return copied;
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
  fingerprintScope?: readonly string[],
): Promise<ValidatedCandidate> {
  assertMaintenanceDirectoryUnchanged(paths);
  finalizeGraph(candidatePath);
  assertClearSidecars(candidatePath);
  const identityBefore = captureDatabaseIdentity(candidatePath);
  const status = await inspect(options, paths.projectRoot, candidatePath, bandHashMemo, fingerprintScope);
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
  fingerprintScope?: readonly string[],
): Promise<GraphStatus> {
  return (options.__internal?.inspectStatus ?? inspectGraphStatus)({
    projectRoot,
    dbPath: database,
    ...(bandHashMemo ? { bandHashMemo } : {}),
    ...(fingerprintScope ? { fingerprintScope } : {}),
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

function ownedPath(paths: MaintenancePaths, _kind: "candidate" | "rollback" | "recovery", _token: string): string {
  assertMaintenanceDirectoryUnchanged(paths);
  return graphTemporary(paths.location);
}
function cleanupOwnedDatabase(paths: MaintenancePaths, file: string): void {
  assertMaintenanceDirectoryUnchanged(paths);
  discardGraphTemporary(file);
}
function sweepOrphanCandidates(paths: MaintenancePaths): void { collectGraphGarbage(paths.location); }
export interface OrphanGraphFiles { candidates: string[]; retained: string[]; maintenanceActive: boolean; }
export function inspectOrphanGraphFiles(projectRoot: string): OrphanGraphFiles {
  const location = graphLocation(projectRoot);
  collectGraphGarbage(location);
  return { candidates: [], retained: [], maintenanceActive: existsSync(join(location.directory, "graph.lock")) };
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
  paths.writer?.assertOwned();
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
    || !graphStoragePathAllowed(paths.projectRoot, join(real, "graph-missing.db"))) {
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
