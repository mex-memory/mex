import { materializeOverlay } from "./overlay-materialize.js";
import { openRecord } from "../record/index.js";
import { recordBuildUsage } from "../record/build-usage.js";
import type { GraphCandidateUsage } from "./candidate-protocol.js";
import { acquireGraphWriter, adoptSiblingBase, assertGraphDirectory, cloneGraph, collectGraphGarbage, currentGraphPath, discardGraphTemporary, enforceIndexCap, finalizeGraph, graphLocation, graphStoragePathAllowed, verifiedGraphLocation, graphTemporary, publishGraph, publishGraphOverlay, publishGraphPointer, readGraphPointer, siblingBase, siblingBases, withGraphStorageContext, type GraphLocation } from "./storage.js";
import { overlayTooLarge, planOverlay, writeOverlay, type OverlayPlan } from "./overlay-write.js";
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
import { open as openFile } from "node:fs/promises";
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
import { DB_SCHEMA_VERSION, openGraphDatabase, upgradeGraphDatabase } from "./db/database.js";
import { openSqlite } from "./db/sqlite.js";
import { ENGINE_GRAPH_SCHEMA_VERSION, hasV5GraphSchema, inspectV5GraphInvariants, inspectV5GraphSchema, parseV5PublicId, v5Rows } from "./db/v5.js";
import { GraphStore } from "./db/store.js";
import { FingerprintStore, transferGroundingBaselines } from "./fingerprint-store.js";
import { installGraphViews, overlayBase } from "./overlay.js";
import { NativeGraphJobError, prepareNativeGraphBuild, type NativeGraphBuild, type NativeGraphFile, type NativeGraphRefresh } from "./native-build.js";
import { graphEngineBinary, type GraphEngineBuildMetadata } from "./native-engine.js";
import { auditRecordProvenInProcess, holdsAuditedBytes, recordAuditedDatabase } from "./audit-record.js";
import { recallDigest, rememberDigest, withSourceMemo } from "./source-memo.js";
import { createGraphEngine, deltaAuditScope, GraphSourceStagingError, refreshWouldPublishNothing, restoreGraphAliases, restoreOverlayAliases } from "./engine-impl.js";
import type { BuildResult, GraphEngine } from "./engine.js";
import {
  inspectGraphSidecars,
  inspectGraphStatus,
  quickCheck,
  type GraphMaintenanceInputs,
} from "./status.js";
import { GRAPH_SNAPSHOT_METADATA_KEY } from "./snapshot.js";
import { GraphCandidateProcessError, runGraphCandidateProcess, type GraphCandidateProcessOptions } from "./candidate-process.js";
import { flushGraphPhaseTimings, recordGraphPhase, timeGraphPhase, timeGraphPhaseAsync } from "./phase-timing.js";

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
  /** Publish a refresh as a new base even when an overlay would do (the writable grounding runtime). */
  publishAsBase?: boolean;
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
  /** Where the candidate process reports its usage for the usage log. */
  __usage?: { candidate?: GraphCandidateUsage };
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
  overlay?: { base: string; identity: DatabaseIdentity; counts: { nodes: number; edges: number }; files: number };
  assertInputsUnchanged?: () => void;
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
  if (mode !== "rebuild" && !existsSync(paths.database) && !siblingBase(paths.location)) {
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
  // The graph lives in the MEX home, not the checkout, so a graph writer no
  // longer writes ignore rules into the user's repository.
  const lock = acquireMaintenanceLock(paths, internalOptions);
  paths.writer = lock;
  if (mode !== "rebuild" && !existsSync(paths.database)) {
    try {
      adoptSiblingBase(paths.location);
      paths.database = currentGraphPath(projectRoot);
    } catch (error) { lock.release(); throw error; }
  }
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
        __usage: {},
      } as InternalMaintenanceOptions;
      await merged.__internal?.afterLockAcquired?.();
      assertMaintenanceDirectoryUnchanged(paths);
      // An interrupted earlier run cannot remove its own candidate (issue
      // #205). The lease is exclusive per project and is held here, so no
      // concurrent run can own one: any candidate still present is an orphan.
      sweepOrphanCandidates(paths);
      // One operation reads each unchanged source once; see source-memo.
      if (operation === "repair") return await withGraphStorageContext(() => withSourceMemo(() => repairGraphWithLease(paths, merged)));
      const meter = startUsageMeter();
      let outcome: GraphMaintenanceResult | undefined;
      try {
        outcome = operation === "refresh"
          ? await withGraphStorageContext(() => withSourceMemo(() => refreshGraphWithLease(paths, merged)))
          : await withGraphStorageContext(() => withSourceMemo(() => rebuildGraphWithLease(paths, merged)));
        return outcome;
      } finally {
        logGraphUsage(paths, operation === "rebuild" ? "build" : "refresh", meter, merged.__usage?.candidate, outcome);
      }
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
  if (status.status === "fresh" && !shouldRetryEngine(status)) {
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
    let sibling = false;
    try { sibling = status.status === "missing" && !!siblingBase(graphLocation(projectRoot)); } catch { /* no index folder */ }
    if (!sibling) return { ...await rebuildGraph(projectRoot, options), operation: "rebuild" };
  }
  return { ...await refreshGraph(projectRoot, options), operation: "refresh" };
}

function shouldRetryEngine(status: GraphStatus): boolean {
  return status.engineFallback !== undefined && graphEngineBinary() !== undefined;
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
  let native: NativeGraphBuild | undefined;
  try {
    assertNotAborted(options.signal);
    // The candidate mostly keeps the live graph's fingerprints; its audit
    // reuses their band hashes instead of deriving them again.
    const bandHashMemo = new Map<string, readonly string[]>();
    const statBeforeInspect = liveDatabaseStat(paths.database);
    const v5Pointer = process.env.MEX_GRAPH_STORAGE === "v5" && !options.__internal?.publishAsBase
      ? readGraphPointer(paths.location) : undefined;
    const v5Base = v5Pointer ? join(paths.location.directory, v5Pointer.base) : undefined;
    const v5Identity = v5Base ? captureDatabaseIdentity(v5Base) : undefined;
    native = await prepareNativeGraphBuild(paths.projectRoot, v5Base, paths.database);
    const priorStatus = await timeGraphPhaseAsync("envelope.inspect", () =>
      inspect(options, paths.projectRoot, paths.database, bandHashMemo, undefined, native?.observation));
    assertMaintenanceDirectoryUnchanged(paths);
    assertRefreshable(priorStatus);
    assertClearSidecars(paths.database);
    progress(options, "discover", "Inspecting the current graph snapshot and source corpus.");
    if (native || priorStatus.schemaVersion === ENGINE_GRAPH_SCHEMA_VERSION || shouldRetryEngine(priorStatus)) {
      const priorIdentity = captureDatabaseIdentity(paths.database);
      candidatePath = ownedPath(paths, "candidate", createToken(options));
      let patch: NativeGraphRefresh | undefined;
      let chosenBase: { name: string; identity: DatabaseIdentity } | undefined;
      let buildResult: BuildResult;
      try {
        if (native && priorStatus.schemaVersion === ENGINE_GRAPH_SCHEMA_VERSION && v5Base && v5Identity) {
          options.__internal?.beforeCandidateDatabaseOpen?.(candidatePath);
          assertMaintenanceDirectoryUnchanged(paths);
          revalidateLiveDatabase(v5Base, v5Identity);
          patch = await native.refresh(candidatePath, options, v5Base);
          if (patch) chosenBase = { name: basename(v5Base), identity: v5Identity };
          if (patch && overlayTooLarge(patch.shadowedFiles, patch.result.filesIndexed)) {
            cleanupOwnedDatabase(paths, candidatePath);
            patch = undefined;
            chosenBase = undefined;
            // A checkout returning from a large branch can share its sibling's
            // base again when that base admits a bounded overlay.
            for (const name of siblingBases(paths.location, basename(v5Base))) {
              assertNotAborted(options.signal);
              const path = join(paths.location.directory, name);
              const identity = captureDatabaseIdentity(path);
              revalidateLiveDatabase(path, identity);
              const attempt = await native.refresh(candidatePath, options, path);
              if (!attempt) continue;
              if (!overlayTooLarge(attempt.shadowedFiles, attempt.result.filesIndexed)) {
                patch = attempt;
                chosenBase = { name, identity };
                break;
              }
              cleanupOwnedDatabase(paths, candidatePath);
            }
          }
        }
        // A format switch, a legacy v5 base, and an oversized patch all start
        // from an empty candidate. The same captured inputs and facts cache apply.
        buildResult = patch?.result ?? await buildStandaloneCandidate(paths, candidatePath, options, native);
      } catch (error) {
        if (!native?.hasEcmaScript || !(error instanceof NativeGraphJobError)) throw error;
        patch = undefined;
        chosenBase = undefined;
        buildResult = await rebuildAfterEngineFailure(paths, candidatePath, options, error);
      }
      assertMaintenanceDirectoryUnchanged(paths);
      revalidateLiveDatabase(paths.database, priorIdentity);
      timeGraphPhase("native.continuity", () => restoreStandaloneContinuity(paths.database, candidatePath!, chosenBase?.name === v5Pointer?.base && !!patch));
      await options.__internal?.afterCandidateBuilt?.(candidatePath);
      progress(options, "validate", "Validating the refreshed graph candidate.");
      const candidate = await validateCandidate(options, paths, candidatePath, undefined, undefined, undefined, native?.observation);
      await options.__internal?.afterCandidateValidated?.(candidatePath, candidate.status);
      const published = await publishCandidate({
        paths, candidatePath, candidate, priorStatus, priorIdentity, retainRecovery: false, options,
        ...(native ? { assertInputsUnchanged: native.assertInputsUnchanged } : {}),
        ...(patch && chosenBase ? { overlay: {
          base: chosenBase.name, identity: chosenBase.identity, files: patch.shadowedFiles,
          counts: { nodes: buildResult.nodesCreated, edges: buildResult.edgesCreated },
        } } : {}),
      });
      candidatePath = null;
      return maintenanceResult(started, currentDate(options), {
        ...buildResult,
        refresh: {
          mode: patch ? "incremental" : "full", publication: patch ? "delta" : "full", filesChanged: priorStatus.changes.total,
          filesReextracted: patch?.filesReextracted ?? native?.filesReextracted ?? buildResult.filesIndexed,
          filesRewritten: patch?.shadowedFiles ?? buildResult.filesIndexed,
        },
      }, published);
    }

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
          && !auditRecordProvenInProcess(realpathSync.native(paths.database), statBefore!)) {
          const audited = captureDatabaseIdentity(paths.database);
          if (sameLiveDatabaseStat(statBeforeInspect, audited)) {
            recordAuditedDatabase(realpathSync.native(paths.database), audited.size, audited.digest);
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
    // A checkout reads its base plus its overlay; the refresh starts from the
    // base alone, so the result can be published as an overlay over that base.
    const pointer = readGraphPointer(paths.location);
    const startFrom = pointer?.overlay ? join(paths.location.directory, pointer.base) : paths.database;
    const startIdentity = startFrom === paths.database ? priorIdentity : captureDatabaseIdentity(startFrom);

    candidatePath = ownedPath(paths, "candidate", createToken(options));
    const copyPath = candidatePath;
    timeGraphPhase("envelope.copy", () => copyExactDatabase(paths, startFrom, copyPath, startIdentity, false));
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

    const publication = {
      paths,
      candidatePath: copyPath,
      candidate,
      priorStatus,
      priorIdentity,
      retainRecovery: false,
      options,
    };
    const published = (pointer && !options.__internal?.publishAsBase
      ? await timeGraphPhaseAsync("envelope.overlay", () => publishOverlay(publication, pointer.base))
      : undefined)
      ?? await timeGraphPhaseAsync("envelope.publish", () => publishCandidate(publication));
    candidatePath = null;
    const finished = currentDate(options);
    return maintenanceResult(started, finished, buildResult, published);
  } finally {
    native?.dispose();
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
  let native: NativeGraphBuild | undefined;
  try {
    assertNotAborted(options.signal);
    progress(options, "discover", "Inspecting graph recovery prerequisites.");
    native = await prepareNativeGraphBuild(paths.projectRoot);
    const priorStatus = await timeGraphPhaseAsync("envelope.inspect", () =>
      inspect(options, paths.projectRoot, paths.database, undefined, undefined, native?.observation));
    assertMaintenanceDirectoryUnchanged(paths);
    const databaseExists = existsSync(paths.database);
    if (databaseExists) assertClearSidecars(paths.database);
    const priorIdentity = databaseExists ? captureDatabaseIdentity(paths.database) : null;

    const cloneForContinuity = Boolean(!native && priorIdentity && shouldCloneForContinuity(priorStatus));
    let continuityFallback = false;
    candidatePath = ownedPath(paths, "candidate", createToken(options));
    if (priorIdentity && cloneForContinuity) {
      // Continuity needs the whole graph: an overlay alone holds only the
      // files it changed, so its base is copied and the overlay applied.
      const pointer = readGraphPointer(paths.location);
      if (pointer?.overlay && paths.database === join(paths.location.directory, pointer.overlay)) {
        const base = join(paths.location.directory, pointer.base);
        copyExactDatabase(paths, base, candidatePath, captureDatabaseIdentity(base), false);
        const clone = openSqlite(candidatePath);
        try { materializeOverlay(clone, paths.database); } finally { clone.close(); }
      } else {
        copyExactDatabase(paths, paths.database, candidatePath, priorIdentity, false);
      }
    }
    let buildResult: BuildResult;
    try {
      try {
        buildResult = await timeGraphPhaseAsync("envelope.build", () => buildStandaloneCandidate(paths, candidatePath!, options, native));
      } catch (error) {
        if (!native?.hasEcmaScript || !(error instanceof NativeGraphJobError)) throw error;
        buildResult = await rebuildAfterEngineFailure(paths, candidatePath!, options, error);
      }
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
    if (priorIdentity && !cloneForContinuity && (
      priorStatus.schemaVersion === DB_SCHEMA_VERSION || priorStatus.schemaVersion === ENGINE_GRAPH_SCHEMA_VERSION
    ) && (priorStatus.status === "fresh" || priorStatus.status === "stale" || priorStatus.status === "degraded")) {
      assertMaintenanceDirectoryUnchanged(paths);
      revalidateLiveDatabase(paths.database, priorIdentity);
      restoreStandaloneContinuity(paths.database, candidatePath);
    }
    await options.__internal?.afterCandidateBuilt?.(candidatePath);
    assertMaintenanceDirectoryUnchanged(paths);
    assertNotAborted(options.signal);

    progress(options, "validate", "Validating the isolated graph rebuild candidate.");
    const candidate = await timeGraphPhaseAsync("envelope.validate", () =>
      validateCandidate(options, paths, candidatePath!, undefined, undefined, undefined, native?.observation));
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
      ...(native ? { assertInputsUnchanged: native.assertInputsUnchanged } : {}),
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
    native?.dispose();
    if (candidatePath) cleanupOwnedDatabase(paths, candidatePath);
    flushGraphPhaseTimings("rebuild", paths.projectRoot);
  }
}

async function buildStandaloneCandidate(
  paths: MaintenancePaths,
  candidate: string,
  options: InternalMaintenanceOptions,
  native: NativeGraphBuild | undefined,
): Promise<BuildResult> {
  if (!native) return rebuildCandidate(paths, candidate, options);
  progress(options, "stage", "Building a schema v5 graph in a standalone candidate.");
  options.__internal?.beforeCandidateDatabaseOpen?.(candidate);
  assertMaintenanceDirectoryUnchanged(paths);
  assertNotAborted(options.signal);
  try {
    return await native.build(candidate, options);
  } catch (error) {
    assertNotAborted(options.signal);
    throw error;
  }
}

async function rebuildAfterEngineFailure(
  paths: MaintenancePaths, candidate: string, options: InternalMaintenanceOptions, error: NativeGraphJobError,
): Promise<BuildResult> {
  assertNotAborted(options.signal);
  cleanupOwnedDatabase(paths, candidate);
  return rebuildCandidate(paths, candidate, options, error.fallbackReason);
}

function restoreStandaloneContinuity(previous: string, candidate: string, delta = false): void {
  assertRegularNonSymlink(candidate, "graph candidate");
  assertClearSidecars(candidate);
  const source = openGraphDatabase(previous, { readOnly: true, immutable: true });
  try {
    const destination = openGraphDatabase(candidate, { allowV5ContinuityWrites: true });
    try {
      const sourceFingerprints = new FingerprintStore(source);
      const destinationFingerprints = new FingerprintStore(destination);
      const sourceStore = new GraphStore(source);
      const destinationStore = new GraphStore(destination);
      destination.transaction(() => {
        if (delta) {
          const paths = overlayShadowPaths(source, destination);
          const missing = overlayMissingNodeIds(source, destination, paths);
          if (missing.size) {
            const vanished = [...missing].flatMap(([path, ids]) => sourceStore.getNodesByFile(path)
              .filter(node => ids.has(parseV5PublicId(node.id)!.digest.toString("hex"))));
            restoreOverlayAliases(sourceStore, destinationStore, vanished, sourceFingerprints, destinationFingerprints);
          } else if (source.prepare("SELECT 1 FROM main.aliases LIMIT 1").get()) {
            for (const alias of sourceStore.getAllAliases()) {
              destinationStore.insertAlias(alias.aliasId, alias.canonicalNodeId, alias.matchMethod, alias.confidence);
            }
          }
        } else restoreGraphAliases(sourceStore, destinationStore, sourceFingerprints, destinationFingerprints);
        transferGroundingBaselines(source, destinationFingerprints);
      });
    } finally { destination.close(); }
  } finally { source.close(); }
}

function overlayShadowPaths(source: ReturnType<typeof openSqlite>, destination: ReturnType<typeof openSqlite>): string[] {
  const shadows = (db: typeof source) => overlayBase(db)
    ? db.prepare("SELECT path FROM main.shadow_files").all().map(row => (row as { path: string }).path) : [];
  return [...new Set([...shadows(source), ...shadows(destination)])];
}

function overlayMissingNodeIds(
  source: ReturnType<typeof openSqlite>, destination: ReturnType<typeof openSqlite>, paths: readonly string[],
): Map<string, Set<string>> {
  const missing = new Map<string, Set<string>>();
  if (paths.length === 0) return missing;
  const prior = source.prepare(`SELECT f.path, lower(hex(n.public_id)) AS id FROM ${v5Rows(source, "files")} f
    CROSS JOIN ${v5Rows(source, "nodes")} n ON n.file = f.id
    WHERE f.path IN (SELECT value FROM json_each(?))`).all(JSON.stringify(paths)) as Array<{ path: string; id: string }>;
  if (prior.length === 0) return missing;
  // A standalone prior can only lose identities on shadowed paths. Every
  // surviving node on those paths is physically present in the new patch.
  const retainedSide = overlayBase(source) ? v5Rows(destination, "nodes") : "main.nodes";
  const retained = destination.prepare(`SELECT lower(hex(public_id)) AS id FROM ${retainedSide}
    WHERE public_id IN (SELECT unhex(value) FROM json_each(?))`)
    .all(JSON.stringify(prior.map(row => row.id))) as Array<{ id: string }>;
  if (retained.length === prior.length) return missing;
  const available = new Set(retained.map(row => row.id));
  for (const { path, id } of prior) {
    if (available.has(id)) continue;
    const ids = missing.get(path) ?? new Set<string>();
    ids.add(id);
    missing.set(path, ids);
  }
  return missing;
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
    // The empty-hint sync path checks the exact corpus, manifest and branch
    // before deciding whether the graph needs to be restaged.
    return await engine.sync([]);
  } finally {
    engine.close();
  }
}

async function rebuildCandidate(
  paths: MaintenancePaths,
  candidatePath: string,
  options: InternalMaintenanceOptions,
  engineFallbackReason?: string,
): Promise<BuildResult> {
  progress(options, "stage", "Building the graph in an isolated same-directory candidate.");
  if (options.candidateExecution === "process") return runIsolatedCandidate(paths, candidatePath, "rebuild", options, engineFallbackReason);
  const engine = maintenanceEngine(paths, candidatePath, options, engineFallbackReason);
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
  engineFallbackReason?: string,
): Promise<BuildResult> {
  options.__internal?.beforeCandidateDatabaseOpen?.(candidatePath);
  assertMaintenanceDirectoryUnchanged(paths);
  assertNotAborted(options.signal);
  try {
    return await runGraphCandidateProcess({
      projectRoot: paths.projectRoot,
      candidatePath,
      operation,
      engineFallbackReason,
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
      onUsage: (usage) => { if (options.__usage) options.__usage.candidate = usage; },
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
  engineFallbackReason?: string,
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
      engineFallbackReason,
      afterSourcesStaged: check,
      afterExtraction: check,
      beforePublication: check,
    },
  } as Parameters<typeof createGraphEngine>[0]);
}

async function publishCandidate(input: CandidatePublicationInput): Promise<CandidatePublicationResult> {
  const { paths, options, candidate } = input;
  const revalidateBase = () => {
    if (input.overlay) revalidateLiveDatabase(join(paths.location.directory, input.overlay.base), input.overlay.identity);
  };
  assertMaintenanceDirectoryUnchanged(paths);
  assertNotAborted(options.signal);
  await options.__internal?.beforeLiveRevalidation?.();
  revalidateLiveDatabase(paths.database, input.priorIdentity);
  revalidateBase();
  if (currentGraphPath(paths.projectRoot) !== paths.database) throw new GraphMaintenanceError("GRAPH_MAINTENANCE_RACE", "The graph pointer changed during construction.");
  assertCandidateUnchanged(input.candidatePath, candidate);
  progress(options, "publish", "Publishing the validated graph pointer.");
  assertMaintenanceDirectoryUnchanged(paths);
  assertNotAborted(options.signal);
  if (input.assertInputsUnchanged) timeGraphPhase("native.verifyInputs", input.assertInputsUnchanged);
  revalidateLiveDatabase(paths.database, input.priorIdentity);
  revalidateBase();
  assertCandidateUnchanged(input.candidatePath, candidate);
  let counts = input.overlay?.counts;
  if (!counts) {
    const countsDb = openSqlite(input.candidatePath, { readOnly: true, immutable: true });
    try { counts = countsDb.prepare("SELECT (SELECT count(*) FROM nodes) nodes, (SELECT count(*) FROM edges) edges").get() as typeof counts; }
    finally { countsDb.close(); }
  }
  const data = {
    head: candidate.status.currentRepo.head, files: candidate.status.parseHealth.ok + candidate.status.parseHealth.partial + candidate.status.parseHealth.failed,
    nodes: counts!.nodes, edges: counts!.edges,
    build: { finishedAt: currentDate(options).toISOString(), ...(input.overlay ? { overlayFiles: input.overlay.files } : {}) },
  };
  const database = input.overlay
    ? publishGraphOverlay(paths.location, input.candidatePath, input.overlay.base, data)
    : publishGraph(paths.location, input.candidatePath, data);
  paths.database = database;
  recordAuditedDatabase(realpathSync.native(database), candidate.identity.size, candidate.identity.digest, input.overlay ? {
    canonicalDbPath: join(paths.location.directory, input.overlay.base),
    size: input.overlay.identity.size, digest: input.overlay.identity.digest,
  } : undefined);
  collectGraphGarbage(paths.location);
  enforceIndexCap(paths.location);
  await options.__internal?.afterPublish?.(database);
  return { status: candidate.status, diagnostics: candidate.status.diagnostics };
}

/**
 * Publish a refreshed candidate as this checkout's overlay over `base`, or
 * as the base alone when their files are equal. Undefined when an overlay
 * can't be trusted or the change is large; the caller then publishes the
 * candidate as a new base.
 */
async function publishOverlay(input: CandidatePublicationInput, base: string): Promise<CandidatePublicationResult | undefined> {
  const { paths, options, candidate } = input;
  assertMaintenanceDirectoryUnchanged(paths);
  assertNotAborted(options.signal);
  await options.__internal?.beforeLiveRevalidation?.();
  revalidateLiveDatabase(paths.database, input.priorIdentity);
  assertCandidateUnchanged(input.candidatePath, candidate);
  // The overlay goes over whichever base needs the fewest files: a worktree
  // that switches back to a branch near a sibling's base returns to sharing it
  // in place of keeping a base of its own.
  let chosen: { base: string; plan: OverlayPlan } | undefined;
  for (const option of [base, ...siblingBases(paths.location, base)]) {
    const plan = timeGraphPhase("overlay.plan", () => planOverlay(join(paths.location.directory, option), input.candidatePath));
    if ("reason" in plan || overlayTooLarge(plan.files.length, plan.total)) continue;
    if (!chosen || plan.files.length < chosen.plan.files.length) chosen = { base: option, plan };
  }
  if (!chosen) return undefined;
  ({ base } = chosen);
  const { plan } = chosen;
  const basePath = join(paths.location.directory, base);
  assertMaintenanceDirectoryUnchanged(paths);
  assertNotAborted(options.signal);
  revalidateLiveDatabase(paths.database, input.priorIdentity);
  if (currentGraphPath(paths.projectRoot) !== paths.database) throw new GraphMaintenanceError("GRAPH_MAINTENANCE_RACE", "The graph pointer changed during construction.");
  assertCandidateUnchanged(input.candidatePath, candidate);
  const countsDb = openSqlite(input.candidatePath, { readOnly: true, immutable: true });
  let counts: { nodes: number; edges: number };
  try { counts = countsDb.prepare("SELECT (SELECT count(*) FROM nodes) nodes, (SELECT count(*) FROM edges) edges").get() as typeof counts; } finally { countsDb.close(); }
  const data = {
    head: candidate.status.currentRepo.head, files: candidate.status.parseHealth.ok + candidate.status.parseHealth.partial + candidate.status.parseHealth.failed,
    ...counts, build: { finishedAt: currentDate(options).toISOString(), overlayFiles: plan.files.length },
  };
  progress(options, "publish", "Publishing the validated graph pointer.");
  if (plan.files.length === 0 && !plan.whole) {
    publishGraphPointer(paths.location, base, null, data);
    paths.database = basePath;
  } else {
    const overlay = graphTemporary(paths.location);
    try {
      const failed = timeGraphPhase("overlay.write", () => writeOverlay({ base: basePath, refreshed: input.candidatePath, target: overlay, root: paths.projectRoot, files: plan.files }));
      if (failed) return undefined;
      finalizeGraph(overlay);
      paths.database = publishGraphOverlay(paths.location, overlay, base, data);
    } finally { discardGraphTemporary(overlay); }
    // The candidate the overlay came from passed the full audit, and base plus
    // overlay reads exactly its rows: readers need not audit them again.
    const published = captureDatabaseIdentity(paths.database);
    recordAuditedDatabase(realpathSync.native(paths.database), published.size, published.digest);
  }
  // The refreshed candidate was only the means to the overlay.
  cleanupOwnedDatabase(paths, input.candidatePath);
  collectGraphGarbage(paths.location);
  enforceIndexCap(paths.location);
  await options.__internal?.afterPublish?.(paths.database);
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
    ...((build.engine ?? published.status.engineFallback) ? { engine: build.engine ?? published.status.engineFallback } : {}),
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

export interface WarmGraphArtifact {
  path: string;
  size: number;
  digest: string;
  assertCurrent(): void;
}

/** Bind a resident checkout once to the audited base and overlay byte identities. */
export function pinWarmGraphArtifact(path: string, base?: WarmGraphArtifact): WarmGraphArtifact {
  assertClearSidecars(path);
  const canonical = realpathSync.native(path);
  const before = lstatSync(path, { bigint: true });
  const stat = lstatSync(path);
  if (!before.isFile()) throw new Error("The published graph is not a regular file.");
  const identity = captureDatabaseIdentity(path);
  const artifact = holdWarmGraphArtifact(canonical, identity, before);
  if (!holdsAuditedBytes(canonical, stat, base?.path)) {
    const db = openSqlite(path, { readOnly: true, immutable: true });
    try {
      if (!hasV5GraphSchema(db) || overlayBase(db) !== (base && basename(base.path))) {
        throw new Error("The published graph has the wrong base or schema.");
      }
      installGraphViews(db, path);
      const problems = [...inspectV5GraphSchema(db), ...quickCheck(db), ...inspectV5GraphInvariants(db)];
      if (problems.length) throw new Error(`Invalid published graph: ${problems.join(", ")}.`);
    } finally { db.close(); }
    base?.assertCurrent();
  }
  artifact.assertCurrent();
  return artifact;
}

function holdWarmGraphArtifact(path: string, identity: DatabaseIdentity, stamp = lstatSync(path, { bigint: true })): WarmGraphArtifact {
  return {
    path, size: identity.size, digest: identity.digest,
    assertCurrent() {
      assertClearSidecars(path);
      const now = lstatSync(path, { bigint: true });
      if (!now.isFile() || now.ino !== stamp.ino || now.dev !== stamp.dev || now.size !== stamp.size
        || now.mtimeNs !== stamp.mtimeNs || now.ctimeNs !== stamp.ctimeNs
        || ((now.ino === 0n || now.ctimeNs % 1_000_000n === 0n) && captureDatabaseIdentityUntimed(path, undefined, false).digest !== identity.digest)) {
        throw new Error("The published graph changed since the resident engine opened it.");
      }
    },
  };
}

interface NativeWarmPublication {
  location: GraphLocation;
  base: WarmGraphArtifact;
  previous: WarmGraphArtifact;
  output: string;
  result: { files: number; nodes: number; edges: number; shadowedFiles?: number | null };
  expected: ReadonlyMap<string, NativeGraphFile>;
  requiredShadows: ReadonlySet<string>;
  metadata: GraphEngineBuildMetadata;
  assertCurrent(): void;
  verifyInputs(): Promise<boolean>;
}

/** Audit changed rows against the pinned base, then publish under the caller's writer lease. */
export async function publishNativeWarmOverlay(input: NativeWarmPublication): Promise<{
  artifact: WarmGraphArtifact; publishedAt: number;
} | undefined> {
  const { location, base, previous, output, result, expected, requiredShadows, metadata } = input;
  input.assertCurrent();
  timeGraphPhase("native.warm.continuity", () => restoreStandaloneContinuity(previous.path, output, true));
  assertClearSidecars(output);
  const identity = captureDatabaseIdentity(output);
  const validating = performance.now();
  const db = openSqlite(output, { readOnly: true, immutable: true });
  try {
    if (!hasV5GraphSchema(db) || overlayBase(db) !== basename(base.path)) throw new Error("The resident candidate has the wrong base or schema.");
    installGraphViews(db, output);
    const problems = [...inspectV5GraphSchema(db), ...quickCheck(db), ...inspectV5GraphInvariants(db)];
    if (problems.length) throw new Error(`Invalid resident graph candidate: ${problems.join(", ")}.`);

    const snapshot = db.prepare(`SELECT indexed_at AS indexedAt, indexed_branch AS indexedBranch,
      lower(hex(indexed_head)) AS head, compiler_version AS compilerVersion, extractor_version AS extractorVersion,
      resolver_version AS resolverVersion, lower(hex(grammar_hash)) AS grammarHash, lower(hex(config_hash)) AS configHash,
      lower(hex(manifest_hash)) AS manifestHash, lower(hex(corpus_digest)) AS sourceCorpusDigest,
      source_count AS sources FROM main.snapshot`).get() as Partial<GraphEngineBuildMetadata> & { head: string; sources: number };
    if (!snapshot || snapshot.sources !== expected.size || result.files !== expected.size || (snapshot.head || null) !== metadata.indexedHead
      || (["indexedAt", "indexedBranch", "compilerVersion", "extractorVersion", "resolverVersion", "grammarHash",
        "configHash", "manifestHash", "sourceCorpusDigest"] as const).some(key => snapshot[key] !== metadata[key])) {
      throw new Error("The resident graph candidate does not describe the observed checkout.");
    }
    const shadows = new Set<string>();
    const files = db.prepare(`SELECT s.path, lower(hex(f.content_hash)) AS hash, f.size, f.extractor_version AS extractor
      FROM main.shadow_files s LEFT JOIN main.files f USING(path)`).iterate() as Iterable<{
      path: string; hash: string; size: number | null; extractor: string | null;
    }>;
    for (const row of files) {
      const wanted = expected.get(row.path);
      if (wanted ? row.hash !== wanted.contentHash || row.size !== wanted.size || row.extractor !== wanted.extractorVersion : row.size !== null) {
        throw new Error("The resident overlay has an unexpected source row.");
      }
      shadows.add(row.path);
    }
    if (shadows.size !== result.shadowedFiles || [...requiredShadows].some(path => !shadows.has(path))) {
      throw new Error("The resident overlay omitted a changed source.");
    }
  } finally { db.close(); }
  recordGraphPhase("native.warm.validate", performance.now() - validating);
  revalidateLiveDatabase(output, identity);
  // The engine and the continuity writer both closed their transactions.
  // Flush the sidecar-free candidate while the engine proves source stamps.
  const synced = timeGraphPhaseAsync("native.warm.finalize", async () => {
    const handle = await openFile(output, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try { await handle.sync(); } finally { await handle.close(); }
  });
  const [verified, durable] = await Promise.allSettled([input.verifyInputs(), synced]);
  if (durable.status === "rejected") throw durable.reason;
  if (verified.status === "rejected") throw verified.reason;
  if (!verified.value) return undefined;
  input.assertCurrent();
  assertClearSidecars(output);
  revalidateLiveDatabase(output, identity);
  const file = timeGraphPhase("native.warm.publish", () => publishGraphOverlay(location, output, basename(base.path), {
    head: metadata.indexedHead, files: result.files, nodes: result.nodes, edges: result.edges,
    build: { finishedAt: new Date().toISOString(), overlayFiles: result.shadowedFiles },
  }));
  const publishedAt = performance.now();
  recordAuditedDatabase(realpathSync.native(file), identity.size, identity.digest, {
    canonicalDbPath: base.path, size: base.size, digest: base.digest,
  });
  return { artifact: holdWarmGraphArtifact(file, identity), publishedAt };
}

/**
 * Record a graph file this process wrote and checked as audited, so readers
 * need not audit it again. @internal
 */
export function recordWrittenGraphAudited(path: string): void {
  const identity = captureDatabaseIdentity(path);
  recordAuditedDatabase(realpathSync.native(path), identity.size, identity.digest);
}

function captureDatabaseIdentity(path: string): DatabaseIdentity {
  return timeGraphPhase("envelope.dbIdentityHash", () => captureDatabaseIdentityUntimed(path));
}

/**
 * The exact identity of the database at `path`. With `copyTo`, the same bytes
 * that are hashed are also written to that descriptor, so the copy is bound
 * to the digest in one read.
 */
function captureDatabaseIdentityUntimed(path: string, copyTo?: number, useMemo = true): DatabaseIdentity {
  assertRegularNonSymlink(path, "graph database");
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(fd);
    // Bytes this operation already hashed with the identity unchanged since.
    const remembered = useMemo && copyTo === undefined ? recallDigest(path, before) : undefined;
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
  maintenanceInputs?: GraphMaintenanceInputs,
): Promise<ValidatedCandidate> {
  assertMaintenanceDirectoryUnchanged(paths);
  finalizeGraph(candidatePath);
  assertClearSidecars(candidatePath);
  const identityBefore = captureDatabaseIdentity(candidatePath);
  const status = await inspect(options, paths.projectRoot, candidatePath, bandHashMemo, fingerprintScope, maintenanceInputs);
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
    if (hasV5GraphSchema(db)) installGraphViews(db, path);
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
  if ((status.schemaVersion !== DB_SCHEMA_VERSION && status.schemaVersion !== ENGINE_GRAPH_SCHEMA_VERSION)
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
  maintenanceInputs?: GraphMaintenanceInputs,
): Promise<GraphStatus> {
  return (options.__internal?.inspectStatus ?? inspectGraphStatus)({
    projectRoot,
    dbPath: database,
    ...(bandHashMemo ? { bandHashMemo } : {}),
    ...(fingerprintScope ? { fingerprintScope } : {}),
    ...(maintenanceInputs ? { maintenanceInputs } : {}),
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

interface UsageMeter { startedAt: number; cpu: NodeJS.CpuUsage }

function startUsageMeter(): UsageMeter {
  return { startedAt: performance.now(), cpu: process.cpuUsage() };
}

/**
 * One row of the usage log per build or refresh: wall time, CPU of this
 * process plus the candidate, and peak memory of both. Never fails the operation it measures.
 */
function logGraphUsage(
  paths: MaintenancePaths,
  kind: "build" | "refresh",
  meter: UsageMeter,
  candidate: GraphCandidateUsage | undefined,
  outcome: GraphMaintenanceResult | undefined,
): void {
  try {
    const cpu = process.cpuUsage(meter.cpu);
    const ownCpuMs = (cpu.user + cpu.system) / 1000;
    const unchanged = !!outcome && outcome.filesIndexed === 0 && outcome.nodesCreated === 0 && !candidate;
    const files = outcome?.refresh?.filesChanged ?? outcome?.filesIndexed ?? 0;
    const writer = openRecord({ busyTimeoutMs: 1000 });
    try {
      recordBuildUsage(writer.db, {
        projectId: paths.location.projectId,
        checkout: paths.location.root,
        kind,
        files,
        wallMs: performance.now() - meter.startedAt,
        cpuMs: ownCpuMs + (candidate?.cpuMs ?? 0),
        peakRssMb: candidate
          ? candidate.peakRssMb
          : process.memoryUsage().rss / 1024 ** 2,
        result: !outcome ? "failed" : unchanged ? "unchanged" : "ok",
      });
    } finally {
      writer.close();
    }
  } catch {
    // The usage log is a report; a locked or missing record never fails a build.
  }
}
