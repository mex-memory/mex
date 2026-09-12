import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { isSameResolvedPath } from "../paths.js";
import { promisify } from "node:util";
import type {
  GraphParseHealth,
  GraphSourceChanges,
  GraphStatus,
  GraphStatusKind,
} from "../team/contracts/graph.js";
import type { Diagnostic, RepoState } from "../team/contracts/shared.js";
import { DB_SCHEMA_VERSION, detectGraphSchemaLineage } from "./db/database.js";
import { openSqlite, type SqliteDatabase } from "./db/sqlite.js";
import { BANDS, K } from "./config.js";
import {
  GRAPH_CORPUS_GLOB_OPTIONS,
  graphCorpusIgnoreGlobs,
  GRAPH_CORPUS_LIMITS,
  isPerFileCorpusLimitError,
  GRAPH_SUPPORTED_SOURCE_GLOB,
  GraphCorpusLimitError,
  addGraphCorpusBytes,
  addGraphSemanticInput,
  createGraphSemanticInputLedger,
  discoverBoundedGraphPaths,
} from "./corpus-policy.js";
import { graphManifest, graphManifestDiffersOnlyByConfig } from "./engine-impl.js";
import { isSupportedSourceFile } from "./extraction/grammars.js";
import { bandHashInts, decodeMinhash } from "./fingerprint.js";
import type { Fingerprint } from "./reconcile.js";
import {
  computeSourceCorpusDigest,
  GRAPH_SNAPSHOT_METADATA_KEY,
  parseGraphSnapshot,
  type GraphSnapshot,
  type GraphSnapshotSemanticInput,
} from "./snapshot.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_CHANGED_PATHS = 100;
const MAX_FRESH_OBSERVATION_ATTEMPTS = 2;
const MAX_SCHEMA_OBJECTS = 1_000;
const MAX_METADATA_VALUE_BYTES = 4_096;
const STATUS_METADATA_KEYS = Object.freeze([
  GRAPH_SNAPSHOT_METADATA_KEY,
  "compiler_version",
  "config_hash",
  "extractor_version",
  "grammar_hash",
  "manifest_hash",
  "rebuild_reason",
  "rebuild_required",
  "resolver_version",
] as const);
const REQUIRED_SCHEMA_OBJECTS = {
  table: [
    "_mex_grounded_source",
    "edges",
    "files",
    "import_bindings",
    "lsh_buckets",
    "node_aliases",
    "node_fingerprints",
    "nodes",
    "nodes_fts",
    "nodes_fts_config",
    "nodes_fts_data",
    "nodes_fts_docsize",
    "nodes_fts_idx",
    "project_metadata",
    "schema_versions",
    "source_chunks",
    "source_chunks_fts",
    "source_chunks_fts_config",
    "source_chunks_fts_data",
    "source_chunks_fts_docsize",
    "source_chunks_fts_idx",
    "unresolved_refs",
  ],
  trigger: ["nodes_ad", "nodes_ai", "nodes_au"],
  index: [
    "idx_aliases_canonical",
    "idx_edges_confidence",
    "idx_edges_kind",
    "idx_edges_provenance",
    "idx_edges_semantic_callsite",
    "idx_edges_source_kind",
    "idx_edges_target_kind",
    "idx_files_language",
    "idx_files_modified_at",
    "idx_grounded_node",
    "idx_grounded_subject",
    "idx_import_bindings_file",
    "idx_import_bindings_local",
    "idx_nodes_container_id",
    "idx_nodes_file_line",
    "idx_nodes_file_path",
    "idx_nodes_identity_key",
    "idx_nodes_kind",
    "idx_nodes_language",
    "idx_nodes_lower_name",
    "idx_nodes_name",
    "idx_nodes_qualified_name",
    "idx_source_chunks_file",
    "idx_unresolved_file_path",
    "idx_unresolved_from_name",
    "idx_unresolved_name",
    "idx_unresolved_status",
  ],
} as const;

const REQUIRED_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  schema_versions: ["version", "applied_at", "description"],
  nodes: [
    "id", "kind", "name", "qualified_name", "container_id", "identity_key",
    "file_path", "language", "start_line", "end_line", "start_column", "end_column",
    "docstring", "signature", "visibility", "is_exported", "is_async", "is_static",
    "is_abstract", "decorators", "type_parameters", "return_type", "body_hash", "updated_at",
  ],
  edges: [
    "id", "source", "target", "kind", "metadata", "line", "col", "provenance",
    "confidence", "resolution_method", "evidence",
  ],
  files: [
    "path", "content_hash", "language", "size", "modified_at", "indexed_at", "node_count",
    "errors", "parse_status", "diagnostic_count", "missing_count", "error_coverage", "extractor_version",
  ],
  unresolved_refs: [
    "id", "ref_key", "from_node_id", "reference_name", "reference_kind", "line", "col",
    "candidates", "file_path", "language", "receiver", "qualifier", "import_source",
    "metadata", "status", "target_id", "confidence", "resolver",
  ],
  import_bindings: [
    "binding_key", "file_path", "local_name", "imported_name", "module_specifier",
    "resolved_file_path", "target_id", "is_type_only", "metadata",
  ],
  node_aliases: ["alias_id", "canonical_node_id", "match_method", "confidence", "created_at"],
  source_chunks: [
    "id", "file_path", "start_line", "end_line", "content_hash", "path_terms",
    "identifier_terms", "comment_terms",
  ],
  source_chunks_fts: ["path_terms", "identifier_terms", "comment_terms", "source_text"],
  nodes_fts: ["id", "name", "qualified_name", "docstring", "signature"],
  nodes_fts_config: ["k", "v"],
  nodes_fts_data: ["id", "block"],
  nodes_fts_docsize: ["id", "sz"],
  nodes_fts_idx: ["segid", "term", "pgno"],
  project_metadata: ["key", "value", "updated_at"],
  node_fingerprints: ["ref", "node_id", "minhash", "neighbors", "token_count"],
  lsh_buckets: ["band", "band_hash", "ref"],
  _mex_grounded_source: [
    "subject_kind", "subject_id", "node_id", "source", "body_hash", "fingerprint", "scaffold_file",
  ],
  source_chunks_fts_config: ["k", "v"],
  source_chunks_fts_data: ["id", "block"],
  source_chunks_fts_docsize: ["id", "sz"],
  source_chunks_fts_idx: ["segid", "term", "pgno"],
};

export type GraphSidecarState = "clear" | "active" | "unavailable";

export interface GraphSidecarProbe {
  state: GraphSidecarState;
  /** Diagnostic-safe basenames; never absolute or caller-controlled paths. */
  paths: readonly string[];
}

/** Resolve a graph database to one canonical, repository-contained read path. */
export function resolveContainedGraphDatabasePath(
  projectRoot: string,
  dbPath: string,
): string | null {
  const root = resolve(projectRoot);
  const requested = isAbsolute(dbPath) ? resolve(dbPath) : resolve(root, dbPath);
  return resolveContainedDatabasePath(root, requested).database?.canonicalPath ?? null;
}

/** Probe SQLite recovery sidecars without opening or mutating the database. */
export function inspectGraphSidecars(dbPath: string): GraphSidecarProbe {
  const active: string[] = [];
  const unavailable: string[] = [];
  for (const sidecarPath of [`${dbPath}-journal`, `${dbPath}-wal`]) {
    const safePath = diagnosticBasename(sidecarPath);
    try {
      const stats = lstatSync(sidecarPath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        unavailable.push(safePath);
        continue;
      }
      try {
        accessSync(sidecarPath, constants.R_OK);
      } catch {
        unavailable.push(safePath);
        continue;
      }
      if (stats.size > 0) active.push(safePath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") unavailable.push(safePath);
    }
  }
  if (unavailable.length > 0) {
    return { state: "unavailable", paths: [...unavailable, ...active].sort(compareCodePoints) };
  }
  if (active.length > 0) return { state: "active", paths: active.sort(compareCodePoints) };
  return { state: "clear", paths: [] };
}

export interface InspectGraphStatusOptions {
  projectRoot: string;
  dbPath?: string;
  /** Fixed clock for deterministic callers and tests. */
  now?: Date | (() => Date);
  /** One shared cap across added, modified, deleted, and failed path lists. */
  maxChangedPaths?: number;
  /** @internal Deterministic observation-race seam for conformance tests. */
  internal?: {
    beforeFreshValidation?: (attempt: number) => void | Promise<void>;
    afterSourceRead?: (path: string, pass: "initial" | "validation") => void;
    afterSemanticInputRead?: (path: string, pass: "initial" | "validation") => void;
    beforeDatabaseResult?: (status: GraphStatusKind, attempt: number) => void;
  };
}

/** @internal Exact identity from one stable, fresh status inspection. */
export interface InternalGraphFreshObservationToken {
  readonly canonicalDbPath: string;
  readonly databaseIdentity: string;
  readonly snapshotRaw: string;
  readonly snapshotHash: string;
}

/** @internal Result consumed only by the read-only grounding handshake. */
export interface InternalGraphStatusInspection {
  readonly graphStatus: GraphStatus;
  readonly freshObservation: InternalGraphFreshObservationToken | null;
  /**
   * @internal Exact identity for a store that would read `fresh` if its config
   * inputs had not drifted.
   *
   * Optional so a caller-supplied status function, which cannot prove the
   * distinction, keeps abstaining. Present only alongside a `stale` status:
   * the store is bindable, but what it says about resolution is not current.
   */
  readonly degradedObservation?: InternalGraphDegradedObservation | null;
  /**
   * @internal True when config content drifted under an engine identity that
   * still reproduces — whether or not the store was servable.
   *
   * A refusal must name what is actually blocking it. Config drift is excused
   * by the read gate, so when something else blocks the same store, reporting
   * the config change as the reason sends a reader to revert an edit that was
   * never the problem.
   */
  readonly configDriftTolerated?: boolean;
}

interface FileRow {
  path: string;
  content_hash: string;
  parse_status: "ok" | "partial" | "failed";
  indexed_at: number;
}

interface MetadataValue {
  value: string;
  updatedAt: number;
}

interface LiveSources {
  hashes: Map<string, string>;
  discoveredPaths: Set<string>;
  complete: boolean;
  diagnostics: Diagnostic[];
}

interface LiveSemanticInputs {
  hashes: Map<string, string | null>;
  changedPaths: string[];
  unavailablePaths: string[];
  complete: boolean;
  diagnostics: Diagnostic[];
}

interface RepoObservation {
  state: RepoState;
  complete: boolean;
  diagnostics: Diagnostic[];
}

interface ContainedDatabasePath {
  requestedPath: string;
  canonicalPath: string;
  projectRootRealPath: string;
}

type ContainedDatabaseResult =
  | { database: ContainedDatabasePath; diagnostic?: never }
  | { database?: never; diagnostic: Diagnostic };

interface InspectionContext {
  options: InspectGraphStatusOptions;
  projectRoot: string;
  requestedDbPath: string;
  observedAt: string;
  maxChangedPaths: number;
}

/**
 * @internal A known, bounded way a bindable store falls short of `fresh`.
 *
 * `config-drift` — the compiler inputs that produced its resolution changed,
 * so what it says about resolved references may be out of date.
 * `parse-degraded` — some files parsed partially or not at all, so what it
 * holds is incomplete. Its facts are still true; there are simply fewer of
 * them than the repository contains.
 * `source-drift` — some indexed files no longer match the working tree, so
 * everything the store says about *those* files describes an older revision.
 * Facts about every other file are unaffected.
 *
 * They make different claims and are reported separately.
 */
export type GraphReadDegradation = "config-drift" | "parse-degraded" | "source-drift";

/** @internal Exact identity plus the reasons the store is not provably fresh. */
export interface InternalGraphDegradedObservation {
  readonly token: InternalGraphFreshObservationToken;
  readonly degradations: readonly GraphReadDegradation[];
  /**
   * Every repository path whose indexed facts no longer describe the working
   * tree, complete and sorted.
   *
   * Complete is the load-bearing word: a reader excludes these files and
   * answers from the rest, so a partial list would let it serve a fact about
   * a file that has moved on. The classification refuses whenever the change
   * list was truncated, which is what makes this exhaustive.
   */
  readonly driftedSources: readonly string[];
}

interface FreshObservation {
  repo: RepoObservation;
  live: LiveSources;
  semantic: LiveSemanticInputs;
  semanticInputs: readonly GraphSnapshotSemanticInput[];
  manifest: ReturnType<typeof graphManifest>;
  snapshotRaw: string;
  database: ContainedDatabasePath;
  databaseIdentity: string;
}

interface FreshValidation {
  stable: boolean;
  status: Extract<GraphStatusKind, "stale" | "degraded">;
  retryable: boolean;
  diagnostics: Diagnostic[];
  freshObservation?: InternalGraphFreshObservationToken;
}

interface InspectionAttempt {
  status: GraphStatus;
  retry: boolean;
  freshObservation?: InternalGraphFreshObservationToken;
  degradedObservation?: InternalGraphDegradedObservation;
  configDriftTolerated?: boolean;
}

interface ClassifiedError {
  status: Extract<GraphStatusKind, "degraded" | "corrupt">;
  diagnostic: Diagnostic;
}

class CorruptGraphIndexError extends Error {
  override readonly name = "CorruptGraphIndexError";
}

/**
 * Inspect graph freshness without creating, migrating, checkpointing, refreshing,
 * or rebuilding the graph. SQLite is opened with `immutable=1`: this deliberately
 * ignores an active WAL, which is reported as a transient degraded state instead
 * of risking creation or mutation of SQLite sidecars.
 */
export async function inspectGraphStatus(
  options: InspectGraphStatusOptions,
): Promise<GraphStatus> {
  return (await inspectGraphStatusWithFreshObservation(options)).graphStatus;
}

/**
 * @internal Inspect status and, only for the exact stable fresh attempt, return
 * the immutable database/snapshot identity needed to adopt read-only readers.
 */
export async function inspectGraphStatusWithFreshObservation(
  options: InspectGraphStatusOptions,
): Promise<InternalGraphStatusInspection> {
  const projectRoot = resolve(options.projectRoot);
  const requestedDbPath = options.dbPath
    ? (isAbsolute(options.dbPath) ? resolve(options.dbPath) : resolve(projectRoot, options.dbPath))
    : resolve(projectRoot, ".mex", "graph.db");
  const context: InspectionContext = {
    options,
    projectRoot,
    requestedDbPath,
    observedAt: resolveNow(options.now).toISOString(),
    maxChangedPaths: normalizeLimit(options.maxChangedPaths),
  };
  let lastAttempt: InspectionAttempt | null = null;
  for (let attempt = 0; attempt < MAX_FRESH_OBSERVATION_ATTEMPTS; attempt++) {
    const inspected = await inspectGraphStatusAttempt(context, attempt);
    lastAttempt = inspected;
    if (!inspected.retry) {
      return {
        graphStatus: inspected.status,
        freshObservation: inspected.freshObservation ?? null,
        degradedObservation: inspected.degradedObservation ?? null,
        configDriftTolerated: inspected.configDriftTolerated === true,
      };
    }
  }
  return {
    graphStatus: lastAttempt!.status,
    freshObservation: null,
    degradedObservation: null,
    configDriftTolerated: lastAttempt!.configDriftTolerated === true,
  };
}

async function inspectGraphStatusAttempt(
  context: InspectionContext,
  attempt: number,
): Promise<InspectionAttempt> {
  const { projectRoot, requestedDbPath, observedAt, maxChangedPaths } = context;
  const contained = resolveContainedDatabasePath(projectRoot, requestedDbPath);
  if (!contained.database) {
    const currentRepo = emptyRepoState(observedAt);
    return {
      retry: false,
      status: graphStatus({
        status: "degraded",
        observedAt,
        currentRepo,
        parseHealth: emptyParseHealth(),
        changes: emptySourceChanges(),
        diagnostics: [contained.diagnostic],
      }),
    };
  }
  const database = contained.database;
  const diagnostics: Diagnostic[] = [];
  const repo = await inspectRepoState(projectRoot, observedAt);
  const currentRepo = repo.state;
  diagnostics.push(...repo.diagnostics);
  const live = inspectLiveSources(
    projectRoot,
    database.projectRootRealPath,
    maxChangedPaths,
    (path) => context.options.internal?.afterSourceRead?.(path, "initial"),
  );
  diagnostics.push(...live.diagnostics);
  const manifest = inspectCurrentManifest(projectRoot, diagnostics);
  let buildPrerequisitesComplete = repo.complete && live.complete && manifest !== null;

  let fileStat: ReturnType<typeof statSync>;
  try {
    fileStat = statSync(database.canonicalPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      const changes = changesWithoutIndex(live, currentRepo, maxChangedPaths, true);
      diagnostics.push({
        code: "GRAPH_INDEX_MISSING",
        severity: "warning",
        message: "The local code-graph index does not exist.",
        remediation: [{
          label: "Build graph",
          ...(buildPrerequisitesComplete ? { command: "mex graph rebuild" } : {}),
        }],
      });
      return {
        retry: false,
        status: graphStatus({
          status: "missing",
          observedAt,
          currentRepo,
          parseHealth: emptyParseHealth(),
          changes,
          diagnostics,
        }),
      };
    }
    const classified = classifyDatabaseError(error, "inspect");
    diagnostics.push(classified.diagnostic);
    return {
      retry: false,
      status: graphStatus({
        status: classified.status,
        observedAt,
        currentRepo,
        parseHealth: emptyParseHealth(),
        changes: changesWithoutIndex(live, currentRepo, maxChangedPaths),
        diagnostics,
      }),
    };
  }
  if (!fileStat.isFile()) {
    diagnostics.push({
      code: "GRAPH_INDEX_INVALID_FILE",
      severity: "error",
      message: "The graph index path is not a regular file.",
    });
    return {
      retry: false,
      status: graphStatus({
        status: "corrupt",
        observedAt,
        currentRepo,
        parseHealth: emptyParseHealth(),
        changes: changesWithoutIndex(live, currentRepo, maxChangedPaths),
        diagnostics,
      }),
    };
  }
  if (!Number.isSafeInteger(fileStat.size)
    || fileStat.size < 0
    || fileStat.size > GRAPH_CORPUS_LIMITS.maxIndexBytes) {
    diagnostics.push({
      code: "GRAPH_INDEX_CORPUS_LIMIT_EXCEEDED",
      severity: "warning",
      message: "The disposable graph index exceeds MEX's bounded inspection policy.",
    });
    return {
      retry: false,
      status: graphStatus({
        status: "degraded",
        observedAt,
        currentRepo,
        parseHealth: emptyParseHealth(),
        changes: changesWithoutIndex(live, currentRepo, maxChangedPaths),
        diagnostics,
      }),
    };
  }

  const initialSidecars = inspectGraphSidecars(database.canonicalPath);
  if (initialSidecars.state !== "clear") {
    diagnostics.push(sidecarDiagnostic(initialSidecars));
    return {
      retry: false,
      status: graphStatus({
        status: "degraded",
        observedAt,
        currentRepo,
        parseHealth: emptyParseHealth(),
        changes: changesWithoutIndex(live, currentRepo, maxChangedPaths),
        diagnostics,
      }),
    };
  }

  let db: SqliteDatabase | null = null;
  const finishDatabaseResult = (status: GraphStatus): InspectionAttempt => {
    const recoverableStatus = status.status === "corrupt"
      && !status.diagnostics.some((diagnostic) => (
        diagnostic.remediation?.some((action) => isGraphMaintenanceCommand(action.command))
      ))
      ? {
          ...status,
          diagnostics: [
            ...status.diagnostics,
            rebuildDiagnostic("The contained graph index must be replaced by an isolated rebuild."),
          ],
        }
      : status;
    const safeStatus = buildPrerequisitesComplete
      ? recoverableStatus
      : suppressExecutableGraphRemediations(recoverableStatus);
    context.options.internal?.beforeDatabaseResult?.(safeStatus.status, attempt);
    return stabilizeDatabaseResult(
      projectRoot,
      requestedDbPath,
      database.canonicalPath,
      databaseFileIdentity(fileStat),
      attempt,
      safeStatus,
    );
  };
  try {
    db = openSqlite(database.canonicalPath, { readOnly: true, immutable: true });
    if (!tableExists(db, "schema_versions")) {
      const oversizedSchemaName = db.prepare(
        `SELECT 1 FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
           AND (typeof(name) <> 'text' OR length(CAST(name AS BLOB)) > 4096)
         LIMIT 1`,
      ).get();
      if (oversizedSchemaName) {
        throw new CorruptGraphIndexError("The graph schema contains an oversized object name.");
      }
      const existingObjects = db.prepare(
        `SELECT name FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%' ORDER BY name LIMIT ${MAX_SCHEMA_OBJECTS + 1}`,
      ).all() as Array<{ name?: unknown }>;
      if (existingObjects.length > MAX_SCHEMA_OBJECTS) {
        throw new CorruptGraphIndexError("The graph schema object inventory exceeds its safety bound.");
      }
      const partialSchema = existingObjects.some((row) => typeof row.name === "string");
      diagnostics.push(partialSchema
        ? {
            code: "GRAPH_INDEX_SCHEMA_INVALID",
            severity: "error",
            message: "The versionless graph database already contains incompatible schema objects; automatic in-place repair is unsafe.",
          }
        : rebuildDiagnostic("The empty graph database has no schema version."));
      return finishDatabaseResult(graphStatus({
          status: partialSchema ? "corrupt" : "rebuild_required",
          observedAt,
          currentRepo,
          parseHealth: emptyParseHealth(),
          changes: changesWithoutIndex(live, currentRepo, maxChangedPaths),
          diagnostics,
        }));
    }

    const schemaVersion = readSchemaVersion(db);
    if (schemaVersion === null) {
      diagnostics.push({
        code: "GRAPH_INDEX_SCHEMA_INVALID",
        severity: "error",
        message: "The graph schema version table is empty or contains an invalid version; automatic in-place repair is unsafe.",
      });
      return finishDatabaseResult(graphStatus({
          status: "corrupt",
          observedAt,
          currentRepo,
          schemaVersion,
          parseHealth: emptyParseHealth(),
          changes: changesWithoutIndex(live, currentRepo, maxChangedPaths),
          diagnostics,
        }));
    }
    if (schemaVersion !== DB_SCHEMA_VERSION) {
      if (schemaVersion > DB_SCHEMA_VERSION) {
        diagnostics.push(rebuildDiagnostic(
          `This mex build supports graph schema ${DB_SCHEMA_VERSION}, but the index uses ${schemaVersion}.`,
        ));
      } else try {
        const lineage = detectGraphSchemaLineage(db, schemaVersion);
        diagnostics.push(lineage === "v1"
          ? rebuildDiagnostic(
              `This mex build expects graph schema ${DB_SCHEMA_VERSION}; the index uses non-lossless schema v1.`,
            )
          : repairDiagnostic(
              `The ${lineage} graph can be upgraded losslessly to schema ${DB_SCHEMA_VERSION}.`,
            ));
      } catch (error) {
        diagnostics.push({
          code: "GRAPH_INDEX_SCHEMA_INVALID",
          severity: "error",
          message: `The older graph schema is partial or unsafe to migrate: ${errorMessage(error)}`,
        });
      }
      return finishDatabaseResult(graphStatus({
          status: diagnostics.at(-1)?.code === "GRAPH_INDEX_SCHEMA_INVALID" ? "corrupt" : "rebuild_required",
          observedAt,
          currentRepo,
          schemaVersion,
          parseHealth: emptyParseHealth(),
          changes: changesWithoutIndex(live, currentRepo, maxChangedPaths),
          diagnostics,
      }));
    }

    try {
      if (detectGraphSchemaLineage(db, schemaVersion) !== "v4") {
        throw new Error("unexpected current schema lineage");
      }
    } catch {
      diagnostics.push({
        code: "GRAPH_INDEX_SCHEMA_INVALID",
        severity: "error",
        message: "The current graph schema has incompatible column, key, or generated-table structure.",
      });
      return finishDatabaseResult(graphStatus({
        status: "corrupt",
        observedAt,
        currentRepo,
        schemaVersion,
        parseHealth: emptyParseHealth(),
        changes: changesWithoutIndex(live, currentRepo, maxChangedPaths),
        diagnostics,
      }));
    }

    const schemaFailures = inspectRequiredSchema(db);
    if (schemaFailures.length > 0) {
      diagnostics.push({
        code: "GRAPH_INDEX_SCHEMA_INVALID",
        severity: "error",
        message: `The current graph schema is missing required structure: ${schemaFailures.join("; ")}.`,
      });
      return finishDatabaseResult(graphStatus({
          status: "corrupt",
          observedAt,
          currentRepo,
          schemaVersion,
          parseHealth: emptyParseHealth(),
          changes: changesWithoutIndex(live, currentRepo, maxChangedPaths),
          diagnostics,
        }));
    }

    const integrity = quickCheck(db);
    if (integrity.length > 0) {
      diagnostics.push({
        code: "GRAPH_INDEX_CORRUPT",
        severity: "error",
        message: `SQLite quick-check failed: ${integrity.join("; ")}`,
      });
      return finishDatabaseResult(graphStatus({
          status: "corrupt",
          observedAt,
          currentRepo,
          schemaVersion,
          parseHealth: emptyParseHealth(),
          changes: changesWithoutIndex(live, currentRepo, maxChangedPaths),
          diagnostics,
        }));
    }

    const coreInvariantFailures = inspectCoreInvariants(db);
    if (coreInvariantFailures.length > 0) {
      diagnostics.push({
        code: "GRAPH_INDEX_INVARIANT_FAILED",
        severity: "error",
        message: `The graph violates persisted invariants: ${coreInvariantFailures.join("; ")}.`,
      });
      return finishDatabaseResult(graphStatus({
          status: "corrupt",
          observedAt,
          currentRepo,
          schemaVersion,
          parseHealth: emptyParseHealth(),
          changes: changesWithoutIndex(live, currentRepo, maxChangedPaths),
          diagnostics,
        }));
    }

    const metadata = readMetadata(db);
    const snapshotRaw = metadata.get(GRAPH_SNAPSHOT_METADATA_KEY)?.value;
    const snapshotResult = readSnapshot(snapshotRaw);
    if (snapshotResult.error) {
      diagnostics.push({
        code: "GRAPH_SNAPSHOT_INVALID",
        severity: "error",
        message: snapshotResult.error,
      });
      return finishDatabaseResult(graphStatus({
          status: "corrupt",
          observedAt,
          currentRepo,
          schemaVersion,
          parseHealth: emptyParseHealth(),
          changes: changesWithoutIndex(live, currentRepo, maxChangedPaths),
          diagnostics,
        }));
    }
    const snapshot = snapshotResult.snapshot;
    if (!snapshot) {
      diagnostics.push({
        code: "GRAPH_SNAPSHOT_LEGACY",
        severity: "warning",
        message: "The current-schema graph predates graph_snapshot_v1 and must be republished before freshness can be trusted.",
        remediation: [{ label: "Republish graph snapshot", command: "mex graph refresh" }],
      });
    } else if (snapshot.schemaVersion !== schemaVersion) {
      diagnostics.push({
        code: "GRAPH_SNAPSHOT_SCHEMA_MISMATCH",
        severity: "error",
        message: `Graph snapshot metadata records schema ${snapshot.schemaVersion}, but SQLite records ${schemaVersion}.`,
      });
      return finishDatabaseResult(graphStatus({
          status: "corrupt",
          observedAt,
          currentRepo,
          schemaVersion,
          parseHealth: emptyParseHealth(),
          changes: changesWithoutIndex(live, currentRepo, maxChangedPaths),
        diagnostics,
      }));
    }

    const semantic = snapshot
      ? inspectSemanticInputs(
          projectRoot,
          database.projectRootRealPath,
          snapshot.semanticInputs,
          maxChangedPaths,
          (path) => context.options.internal?.afterSemanticInputRead?.(path, "initial"),
        )
      : emptySemanticInputs();
    diagnostics.push(...semantic.diagnostics);
    buildPrerequisitesComplete = buildPrerequisitesComplete && semantic.complete;

    const files = readFiles(db);
    const parseHealth = summarizeParseHealth(files, maxChangedPaths);
    if (parseHealth.partial > 0 || parseHealth.failed > 0) {
      const failedPaths = parseHealth.failedPaths.length > 0
        ? ` Failed: ${parseHealth.failedPaths.join(", ")}${parseHealth.failedPathsTruncated ? ", …" : ""}.`
        : "";
      diagnostics.push({
        code: "GRAPH_PARSE_DEGRADED",
        severity: "warning",
        message: `The published graph contains ${parseHealth.partial} partially parsed and ${parseHealth.failed} failed source file(s).${failedPaths}`,
      });
    }
    if (snapshot && !snapshotMatchesStoredRows(snapshot, files, parseHealth)) {
      diagnostics.push({
        code: "GRAPH_SNAPSHOT_CONTENT_MISMATCH",
        severity: "error",
        message: "Graph snapshot source or parse-health totals disagree with the published SQLite rows.",
      });
      return finishDatabaseResult(graphStatus({
          status: "corrupt",
          observedAt,
          currentRepo,
          schemaVersion,
          parseHealth,
          changes: changesWithoutIndex(live, currentRepo, maxChangedPaths),
          diagnostics,
        }));
    }
    if (snapshot && repo.complete && snapshot.indexedHead !== currentRepo.head) {
      diagnostics.push({
        code: "GRAPH_INDEX_HEAD_CHANGED",
        severity: "info",
        message: "Repository HEAD differs from the commit recorded by the last successful graph snapshot.",
      });
    }
    const comparedSources = compareSources(
      files,
      live,
      snapshot,
      currentRepo,
      manifest,
      metadata,
      maxChangedPaths,
    );
    const semanticInputsChanged = !semantic.complete || semantic.changedPaths.length > 0;
    const sourceChanges = semanticInputsChanged
      ? {
          ...comparedSources,
          changes: { ...comparedSources.changes, configChanged: true },
        }
      : comparedSources;
    const rebuildRequired = metadata.get("rebuild_required")?.value === "1";
    if (rebuildRequired) {
      const reason = metadata.get("rebuild_reason")?.value;
      diagnostics.push(rebuildDiagnostic(
        reason ? `The graph requires a full rebuild (${reason}).` : "The graph requires a full rebuild.",
      ));
    }

    if (sourceChanges.digestChanged) {
      diagnostics.push({
        code: "GRAPH_SOURCE_CORPUS_MISMATCH",
        severity: "warning",
        message: "The current supported-source corpus does not match the successful graph snapshot.",
        remediation: [{ label: "Refresh graph", command: "mex graph refresh" }],
      });
    }
    if (semantic.changedPaths.length > 0) {
      diagnostics.push({
        code: "GRAPH_SEMANTIC_INPUTS_CHANGED",
        severity: "warning",
        message: "Compiler configuration inputs no longer match the successful graph snapshot.",
        ...(semantic.complete
          ? { remediation: [{ label: "Republish graph with current inputs", command: "mex graph refresh" }] }
          : {}),
      });
    }
    if (!semantic.complete) {
      diagnostics.push({
        code: "GRAPH_SEMANTIC_INPUT_INSPECTION_INCOMPLETE",
        severity: "warning",
        message: "Compiler configuration input inspection was incomplete; graph freshness cannot be trusted.",
      });
    }
    if (sourceChanges.changes.branchChanged) {
      diagnostics.push({
        code: "GRAPH_INDEX_BRANCH_CHANGED",
        severity: "warning",
        message: `The current branch (${currentRepo.branch ?? "detached"}) differs from the indexed branch (${snapshot?.indexedBranch ?? "unknown"}).`,
        remediation: [{ label: "Republish graph for this branch", command: "mex graph refresh" }],
      });
    }
    if (sourceChanges.changes.manifestChanged) {
      const changedInputs = [
        sourceChanges.changes.configChanged ? "configuration" : null,
        sourceChanges.changes.grammarChanged ? "grammar" : null,
      ].filter((value): value is string => value !== null);
      diagnostics.push({
        code: "GRAPH_BUILD_MANIFEST_CHANGED",
        severity: "warning",
        message: changedInputs.length > 0
          ? `Graph build inputs changed (${changedInputs.join(", ")}).`
          : "The graph build manifest or discovery policy changed.",
        remediation: [{ label: "Republish graph with current inputs", command: "mex graph refresh" }],
      });
    }
    if (!live.complete) {
      diagnostics.push({
        code: "GRAPH_SOURCE_INSPECTION_INCOMPLETE",
        severity: "warning",
        message: "Graph freshness could not be established because source inspection was incomplete.",
      });
    }
    if (!repo.complete) {
      diagnostics.push({
        code: "GRAPH_REPO_INSPECTION_INCOMPLETE",
        severity: "warning",
        message: "Graph freshness could not be established because repository state inspection was incomplete.",
      });
    }

    const freshnessUnproven = !live.complete
      || !semantic.complete
      || !repo.complete
      || manifest === null;
    const stale = sourceChanges.changes.total > 0
      || sourceChanges.changes.branchChanged
      || sourceChanges.changes.manifestChanged
      || sourceChanges.changes.configChanged
      || sourceChanges.digestChanged
      || freshnessUnproven;
    const parseDegraded = parseHealth.partial > 0 || parseHealth.failed > 0;
    const status: GraphStatusKind = rebuildRequired
      ? "rebuild_required"
      : !snapshot
        ? "stale"
      : stale
        ? "stale"
        : parseDegraded
          ? "degraded"
          : "fresh";

    const indexedAt = snapshot?.indexedAt ?? latestIndexedAt(files);
    const lastSuccessfulIndexAt = snapshot?.lastSuccessfulIndexAt
      ?? metadataTimestamp(metadata.get("manifest_hash"));
    const result = graphStatus({
      status,
      observedAt,
      currentRepo,
      lastSuccessfulIndexAt,
      indexedAt,
      indexedBranch: snapshot?.indexedBranch ?? null,
      indexedHead: snapshot?.indexedHead ?? null,
      schemaVersion,
      extractorVersion: snapshot?.extractorVersion ?? metadata.get("extractor_version")?.value ?? null,
      grammarVersion: snapshot?.grammarHash ?? metadata.get("grammar_hash")?.value ?? null,
      parseHealth,
      changes: sourceChanges.changes,
      diagnostics,
    });
    // A store whose only unproven input is config content is still an exact
    // description of the source it indexed. Bind it like a fresh one so a
    // reader can serve it labelled, and keep every other reason to distrust it
    // — engine identity, source drift, branch, corpus digest, parse health,
    // incomplete inspection — refusing exactly as before.
    // Config content is forgivable on its own whenever engine identity still
    // reproduces, independently of whether anything else also blocks the read.
    // A caller that must explain a refusal needs that separately: config is
    // then the input that was excused, never the reason.
    const configDriftTolerated = snapshot !== undefined
      && manifest !== null
      && sourceChanges.changes.configChanged
      && (snapshot.manifestHash === manifest.manifestHash
        || graphManifestDiffersOnlyByConfig(manifest, snapshot.manifestHash, snapshot.configHash));
    // Everything except the store's own completeness must still hold. A
    // corpus, branch, digest, grammar or engine-identity difference, an
    // unfinished inspection, or a demanded rebuild all refuse exactly as
    // before; the two entries below are the only shortfalls a bound read
    // tolerates, and each is reported to whatever serves it.
    // Drifted source is tolerable only while the complete list of drifted
    // paths is known: a reader excludes exactly those files and answers from
    // the rest, and a truncated list would let one through. The change-path
    // ceiling therefore doubles as the bound on how much drift can still be
    // served — past it, this is a stale index rather than a partial answer.
    const sourceDrifted = sourceChanges.changes.total > 0;
    const sourceDriftBounded = sourceDrifted && !sourceChanges.changes.truncated;
    const boundable = !rebuildRequired
      && !freshnessUnproven
      && !sourceChanges.changes.branchChanged
      && !sourceChanges.changes.grammarChanged
      && (configDriftTolerated || !sourceChanges.changes.configChanged)
      && (!sourceDrifted || sourceDriftBounded)
      && (!sourceChanges.digestChanged || sourceDriftBounded);
    const degradations: GraphReadDegradation[] = boundable
      ? [
          ...(sourceChanges.changes.configChanged ? ["config-drift" as const] : []),
          ...(parseDegraded ? ["parse-degraded" as const] : []),
          ...(sourceDrifted ? ["source-drift" as const] : []),
        ]
      : [];
    const driftedSources = sourceDriftBounded
      ? [...new Set([
          ...sourceChanges.changes.added,
          ...sourceChanges.changes.modified,
          ...sourceChanges.changes.deleted,
        ])].sort(compareCodePoints)
      : [];
    // `stale` and `degraded` are the only non-fresh kinds those shortfalls can
    // produce here; any other kind was returned long before this point.
    const bindable = status === "fresh"
      || (boundable && degradations.length > 0 && (status === "stale" || status === "degraded"));
    if (!bindable || !snapshot || !snapshotRaw || !manifest) {
      return { ...finishDatabaseResult(result), configDriftTolerated };
    }

    await context.options.internal?.beforeFreshValidation?.(attempt);
    const validation = await validateFreshObservation(context, {
      repo,
      live,
      semantic,
      semanticInputs: snapshot.semanticInputs,
      manifest,
      snapshotRaw,
      database,
      databaseIdentity: databaseFileIdentity(fileStat),
    }, degradations);
    if (validation.stable) {
      return {
        retry: false,
        status: result,
        configDriftTolerated,
        ...(degradations.length === 0
          ? { freshObservation: validation.freshObservation }
          : {
              degradedObservation: {
                token: validation.freshObservation!,
                degradations: Object.freeze([...degradations]),
                driftedSources: Object.freeze([...driftedSources]),
              },
            }),
      };
    }
    const unstable = {
      ...result,
      status: validation.status,
      diagnostics: [...result.diagnostics, ...validation.diagnostics],
    } satisfies GraphStatus;
    return {
      status: unstable,
      retry: validation.retryable && attempt + 1 < MAX_FRESH_OBSERVATION_ATTEMPTS,
    };
  } catch (error) {
    const classified = classifyDatabaseError(error, "read");
    diagnostics.push(classified.diagnostic);
    return finishDatabaseResult(graphStatus({
        status: classified.status,
        observedAt,
        currentRepo,
        parseHealth: emptyParseHealth(),
        changes: changesWithoutIndex(live, currentRepo, maxChangedPaths),
        diagnostics,
      }));
  } finally {
    db?.close();
  }
}

/** Canonical aggregate hash used by graph_snapshot_v1 writers and inspectors. */
export function graphSourceCorpusDigest(entries: Iterable<readonly [string, string]>): string {
  return computeSourceCorpusDigest(
    [...entries].map(([path, contentHash]) => ({ path, contentHash })),
  );
}

function graphStatus(input: {
  status: GraphStatusKind;
  observedAt: string;
  currentRepo: RepoState;
  lastSuccessfulIndexAt?: string | null;
  indexedAt?: string | null;
  indexedBranch?: string | null;
  indexedHead?: string | null;
  schemaVersion?: number | null;
  extractorVersion?: string | null;
  grammarVersion?: string | null;
  parseHealth: GraphParseHealth;
  changes: GraphSourceChanges;
  diagnostics: readonly Diagnostic[];
}): GraphStatus {
  return {
    status: input.status,
    observedAt: input.observedAt,
    currentRepo: input.currentRepo,
    lastSuccessfulIndexAt: input.lastSuccessfulIndexAt ?? null,
    indexedAt: input.indexedAt ?? null,
    indexedBranch: input.indexedBranch ?? null,
    indexedHead: input.indexedHead ?? null,
    schemaVersion: input.schemaVersion ?? null,
    extractorVersion: input.extractorVersion ?? null,
    grammarVersion: input.grammarVersion ?? null,
    parseHealth: input.parseHealth,
    changes: input.changes,
    diagnostics: input.diagnostics,
  };
}

function suppressExecutableGraphRemediations(status: GraphStatus): GraphStatus {
  return {
    ...status,
    diagnostics: status.diagnostics.map((diagnostic) => {
      if (!diagnostic.remediation?.some((action) => isGraphMaintenanceCommand(action.command))) {
        return diagnostic;
      }
      return {
        ...diagnostic,
        remediation: diagnostic.remediation.map((action) => {
          if (!isGraphMaintenanceCommand(action.command)) return action;
          const { command: _unsafeCommand, ...safeAction } = action;
          return safeAction;
        }),
      };
    }),
  };
}

function resolveContainedDatabasePath(
  projectRoot: string,
  requestedPath: string,
): ContainedDatabaseResult {
  if (!isPathContained(projectRoot, requestedPath)) {
    return { database: undefined, diagnostic: containmentDiagnostic("GRAPH_INDEX_PATH_OUTSIDE_PROJECT") };
  }
  let projectRootRealPath: string;
  try {
    projectRootRealPath = realpathSync(projectRoot);
  } catch {
    return {
      database: undefined,
      diagnostic: {
        code: "GRAPH_PROJECT_ROOT_UNAVAILABLE",
        severity: "warning",
        message: "The project root could not be resolved without following an unsafe path.",
      },
    };
  }

  let canonicalPath: string;
  try {
    const requestedStats = lstatSync(requestedPath);
    if (requestedStats.isSymbolicLink()) {
      try {
        canonicalPath = realpathSync(requestedPath);
      } catch {
        return {
          database: undefined,
          diagnostic: {
            code: "GRAPH_INDEX_PATH_UNAVAILABLE",
            severity: "warning",
            message: "The configured graph index symlink could not be resolved safely.",
          },
        };
      }
    } else {
      canonicalPath = realpathSync(requestedPath);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      return {
        database: undefined,
        diagnostic: {
          code: "GRAPH_INDEX_PATH_UNAVAILABLE",
          severity: "warning",
          message: "The configured graph index path could not be inspected safely.",
        },
      };
    }
    try {
      canonicalPath = canonicalizeMissingPath(requestedPath);
    } catch {
      return {
        database: undefined,
        diagnostic: {
          code: "GRAPH_INDEX_PATH_UNAVAILABLE",
          severity: "warning",
          message: "The configured graph index parent path could not be resolved safely.",
        },
      };
    }
  }
  if (!isPathContained(projectRootRealPath, canonicalPath)) {
    return { database: undefined, diagnostic: containmentDiagnostic("GRAPH_INDEX_PATH_OUTSIDE_PROJECT") };
  }
  return {
    database: {
      requestedPath,
      canonicalPath,
      projectRootRealPath,
    },
  };
}

function canonicalizeMissingPath(path: string): string {
  let ancestor = path;
  for (;;) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("No existing path ancestor");
    ancestor = parent;
    try {
      return resolve(realpathSync(ancestor), relative(ancestor, path));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

function containmentDiagnostic(code: string): Diagnostic {
  return {
    code,
    severity: "error",
    message: "The graph index resolves outside the project root; inspection was refused.",
  };
}

function isPathContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"));
}

function emptyRepoState(observedAt: string): RepoState {
  return { branch: null, head: null, dirty: false, observedAt };
}

function emptySourceChanges(): GraphSourceChanges {
  return {
    total: 0,
    added: [],
    modified: [],
    deleted: [],
    truncated: false,
    branchChanged: false,
    manifestChanged: false,
    configChanged: false,
    grammarChanged: false,
  };
}

function sidecarDiagnostic(probe: GraphSidecarProbe): Diagnostic {
  const paths = probe.paths.join(", ");
  const repairableWal = probe.state === "active"
    && probe.paths.length > 0
    && probe.paths.every((path) => path.endsWith("-wal"));
  return probe.state === "active"
    ? {
        code: "GRAPH_INDEX_SIDECAR_ACTIVE",
        severity: "warning",
        message: `Graph maintenance or recovery is active (${paths}); immutable inspection was skipped.`,
        remediation: repairableWal
          ? [{ label: "Repair a stranded graph WAL", command: "mex graph repair" }]
          : [{ label: "Retry after graph maintenance finishes" }],
      }
    : {
        code: "GRAPH_INDEX_SIDECAR_UNAVAILABLE",
        severity: "warning",
        message: `Graph recovery sidecars could not be inspected safely (${paths}); immutable inspection was skipped.`,
        remediation: [{ label: "Retry graph status after checking file permissions" }],
      };
}

function databaseFileIdentity(stats: NonNullable<ReturnType<typeof statSync>>): string {
  return JSON.stringify([stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs]);
}

function stabilizeDatabaseResult(
  projectRoot: string,
  requestedDbPath: string,
  dbPath: string,
  identityBefore: string,
  attempt: number,
  result: GraphStatus,
): InspectionAttempt {
  const sidecars = inspectGraphSidecars(dbPath);
  const resolvedPath = resolveContainedGraphDatabasePath(projectRoot, requestedDbPath);
  let identityAfter: string | null = null;
  try {
    identityAfter = databaseFileIdentity(statSync(dbPath));
  } catch {
    // A missing/replaced database is handled as an unstable observation below.
  }
  if (sidecars.state === "clear"
    && isSameResolvedPath(resolvedPath, dbPath)
    && identityAfter === identityBefore) {
    return { retry: false, status: result };
  }
  const diagnostics = [
    ...(sidecars.state === "clear" ? [] : [sidecarDiagnostic(sidecars)]),
    observationRaceDiagnostic([
      !isSameResolvedPath(resolvedPath, dbPath)
        ? "graph database path"
        : identityAfter === identityBefore
          ? "SQLite sidecars"
          : "graph database",
    ]),
  ];
  return {
    retry: attempt + 1 < MAX_FRESH_OBSERVATION_ATTEMPTS,
    status: {
      ...result,
      status: "degraded",
      diagnostics,
    },
  };
}

async function validateFreshObservation(
  context: InspectionContext,
  before: FreshObservation,
  degradations: readonly GraphReadDegradation[] = [],
): Promise<FreshValidation> {
  const firstSidecars = inspectGraphSidecars(before.database.canonicalPath);
  if (firstSidecars.state !== "clear") {
    return {
      stable: false,
      status: "degraded",
      retryable: false,
      diagnostics: [sidecarDiagnostic(firstSidecars), observationRaceDiagnostic(["SQLite sidecars"])],
    };
  }

  const contained = resolveContainedDatabasePath(context.projectRoot, context.requestedDbPath);
  if (!contained.database) {
    return {
      stable: false,
      status: "degraded",
      retryable: false,
      diagnostics: [contained.diagnostic, observationRaceDiagnostic(["database containment"])],
    };
  }
  if (contained.database.canonicalPath !== before.database.canonicalPath
    || contained.database.projectRootRealPath !== before.database.projectRootRealPath) {
    return unstableObservation("degraded", ["database path"]);
  }

  const repo = await inspectRepoState(context.projectRoot, context.observedAt);
  const live = inspectLiveSources(
    context.projectRoot,
    contained.database.projectRootRealPath,
    context.maxChangedPaths,
    (path) => context.options.internal?.afterSourceRead?.(path, "validation"),
  );
  const semantic = inspectSemanticInputs(
    context.projectRoot,
    contained.database.projectRootRealPath,
    before.semanticInputs,
    context.maxChangedPaths,
    (path) => context.options.internal?.afterSemanticInputRead?.(path, "validation"),
  );
  const manifestDiagnostics: Diagnostic[] = [];
  const manifest = inspectCurrentManifest(context.projectRoot, manifestDiagnostics);
  if (!repo.complete || !live.complete || !semantic.complete || manifest === null) {
    const status = !repo.complete ? "degraded" : "stale";
    return {
      stable: false,
      status,
      retryable: true,
      diagnostics: [
        ...repo.diagnostics,
        ...live.diagnostics,
        ...semantic.diagnostics,
        ...manifestDiagnostics,
        observationRaceDiagnostic(["freshness inputs"]),
      ],
    };
  }

  const preSnapshotSidecars = inspectGraphSidecars(contained.database.canonicalPath);
  if (preSnapshotSidecars.state !== "clear") {
    return {
      stable: false,
      status: "degraded",
      retryable: false,
      diagnostics: [sidecarDiagnostic(preSnapshotSidecars), observationRaceDiagnostic(["SQLite sidecars"])],
    };
  }

  let snapshotRaw: string;
  let identity: string;
  try {
    const snapshotIdentity = readSnapshotIdentity(contained.database.canonicalPath);
    snapshotRaw = snapshotIdentity.snapshotRaw;
    identity = snapshotIdentity.databaseIdentity;
  } catch {
    return {
      stable: false,
      status: "degraded",
      retryable: true,
      diagnostics: [{
        code: "GRAPH_STATUS_SNAPSHOT_RECHECK_FAILED",
        severity: "warning",
        message: "The graph snapshot could not be re-read safely during freshness validation.",
      }, observationRaceDiagnostic(["graph snapshot"])],
    };
  }

  const finalSidecars = inspectGraphSidecars(contained.database.canonicalPath);
  if (finalSidecars.state !== "clear") {
    return {
      stable: false,
      status: "degraded",
      retryable: false,
      diagnostics: [sidecarDiagnostic(finalSidecars), observationRaceDiagnostic(["SQLite sidecars"])],
    };
  }

  const finalContained = resolveContainedDatabasePath(
    context.projectRoot,
    context.requestedDbPath,
  );
  if (!finalContained.database) {
    return {
      stable: false,
      status: "degraded",
      retryable: false,
      diagnostics: [
        finalContained.diagnostic,
        observationRaceDiagnostic(["database containment"]),
      ],
    };
  }

  const changed: string[] = [];
  if (!sameRepoState(before.repo.state, repo.state)) changed.push("Git state");
  // Comparing the two observations to each other is the race check and always
  // applies; comparing either to the stored snapshot is the freshness question
  // the caller already answered.
  if (liveSourceIdentity(before.live) !== liveSourceIdentity(live)) changed.push("source corpus");
  // Two comparisons live here. Whether the two observations agree with each
  // other is a race check and always applies. Whether they agree with the
  // stored snapshot is a freshness check, already decided by the caller — for
  // a config-drifted read it is the very condition being served, so repeating
  // it here would report a race that did not happen.
  if (semanticInputIdentity(before.semantic) !== semanticInputIdentity(semantic)
    || (!degradations.includes("config-drift") && semantic.changedPaths.length > 0)) {
    changed.push("compiler semantic inputs");
  }
  if (!sameManifest(before.manifest, manifest)) changed.push("graph manifest");
  if (before.snapshotRaw !== snapshotRaw || before.databaseIdentity !== identity) changed.push("graph snapshot");
  if (finalContained.database.canonicalPath !== contained.database.canonicalPath
    || finalContained.database.projectRootRealPath !== contained.database.projectRootRealPath) {
    changed.push("database path");
  }
  if (changed.length === 0) {
    return {
      stable: true,
      status: "degraded",
      retryable: false,
      diagnostics: [],
      freshObservation: Object.freeze({
        canonicalDbPath: finalContained.database.canonicalPath,
        databaseIdentity: identity,
        snapshotRaw,
        snapshotHash: sha256(snapshotRaw),
      }),
    };
  }
  const unstable = unstableObservation(
    changed.some((entry) => entry === "graph snapshot") ? "degraded" : "stale",
    changed,
  );
  return {
    ...unstable,
    diagnostics: [...semantic.diagnostics, ...unstable.diagnostics],
  };
}

function readSnapshotIdentity(dbPath: string): { snapshotRaw: string; databaseIdentity: string } {
  const before = statSync(dbPath);
  if (!before.isFile()
    || !Number.isSafeInteger(before.size)
    || before.size < 0
    || before.size > GRAPH_CORPUS_LIMITS.maxIndexBytes) {
    throw new GraphCorpusLimitError("maxIndexBytes");
  }
  const db = openSqlite(dbPath, { readOnly: true, immutable: true });
  let snapshotRaw: string;
  try {
    const row = db.prepare(
      `SELECT CASE
         WHEN typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= ? THEN value
         ELSE NULL END AS value
       FROM project_metadata WHERE key = ?`,
    ).get(GRAPH_CORPUS_LIMITS.maxSnapshotMetadataBytes, GRAPH_SNAPSHOT_METADATA_KEY) as { value?: unknown } | undefined;
    if (typeof row?.value !== "string") throw new Error("Missing graph snapshot identity");
    snapshotRaw = row.value;
  } finally {
    db.close();
  }
  const after = statSync(dbPath);
  if (!after.isFile()
    || !Number.isSafeInteger(after.size)
    || after.size < 0
    || after.size > GRAPH_CORPUS_LIMITS.maxIndexBytes) {
    throw new GraphCorpusLimitError("maxIndexBytes");
  }
  if (databaseFileIdentity(before) !== databaseFileIdentity(after)) {
    throw new Error("The graph database changed while its snapshot identity was read.");
  }
  return { snapshotRaw, databaseIdentity: databaseFileIdentity(after) };
}

function unstableObservation(
  status: Extract<GraphStatusKind, "stale" | "degraded">,
  changed: string[],
): FreshValidation {
  return {
    stable: false,
    status,
    retryable: true,
    diagnostics: [observationRaceDiagnostic(changed)],
  };
}

function observationRaceDiagnostic(changed: string[]): Diagnostic {
  return {
    code: "GRAPH_STATUS_OBSERVATION_RACE",
    severity: "warning",
    message: `Graph freshness changed during inspection (${changed.sort(compareCodePoints).join(", ")}); no fresh result was emitted.`,
  };
}

function sameRepoState(left: RepoState, right: RepoState): boolean {
  return left.branch === right.branch && left.head === right.head && left.dirty === right.dirty;
}

function sameManifest(
  left: ReturnType<typeof graphManifest>,
  right: ReturnType<typeof graphManifest>,
): boolean {
  return left.manifestHash === right.manifestHash
    && left.configHash === right.configHash
    && left.grammarHash === right.grammarHash;
}

function liveSourceIdentity(live: LiveSources): string {
  return JSON.stringify([...live.hashes].sort(([left], [right]) => compareCodePoints(left, right)));
}

function semanticInputIdentity(semantic: LiveSemanticInputs): string {
  return JSON.stringify([
    [...semantic.hashes].sort(([left], [right]) => compareCodePoints(left, right)),
    semantic.changedPaths,
    semantic.unavailablePaths,
    semantic.complete,
  ]);
}

function emptySemanticInputs(): LiveSemanticInputs {
  return {
    hashes: new Map(),
    changedPaths: [],
    unavailablePaths: [],
    complete: true,
    diagnostics: [],
  };
}

function inspectSemanticInputs(
  projectRoot: string,
  projectRootRealPath: string,
  expected: readonly GraphSnapshotSemanticInput[],
  diagnosticLimit: number,
  afterRead?: (path: string) => void,
): LiveSemanticInputs {
  const hashes = new Map<string, string | null>();
  const changedPaths: string[] = [];
  const unavailablePaths: string[] = [];
  const diagnostics: Diagnostic[] = [];
  let complete = true;
  const semanticInputLedger = createGraphSemanticInputLedger();
  let omittedDiagnostics = 0;
  const report = (diagnostic: Diagnostic): void => {
    if (diagnostics.length < diagnosticLimit) diagnostics.push(diagnostic);
    else omittedDiagnostics += 1;
  };
  const reportCorpusLimit = (): void => {
    if (diagnostics.some((diagnostic) =>
      diagnostic.code === "GRAPH_SEMANTIC_INPUT_CORPUS_LIMIT_EXCEEDED")) return;
    diagnostics.push({
      code: "GRAPH_SEMANTIC_INPUT_CORPUS_LIMIT_EXCEEDED",
      severity: "warning",
      message: "The compiler semantic-input corpus exceeds MEX's bounded inspection policy.",
    });
  };

  for (const input of expected) {
    let contentHash: string | null | undefined;
    try {
      const content = readStableContainedUtf8File(
        projectRoot,
        projectRootRealPath,
        input.path,
        () => afterRead?.(input.path),
      );
      addGraphSemanticInput(
        semanticInputLedger,
        input.path,
        Buffer.byteLength(content, "utf8"),
      );
      contentHash = sha256(content);
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
        try {
          assertSecurelyContainedMissingPath(projectRoot, projectRootRealPath, input.path);
          addGraphSemanticInput(semanticInputLedger, input.path, null);
          contentHash = null;
        } catch (containmentError) {
          error = containmentError;
        }
      }
      if (contentHash === undefined) {
        complete = false;
        unavailablePaths.push(input.path);
        const outsideProject = errorCode(error) === "GRAPH_CONTAINED_FILE_OUTSIDE_PROJECT";
        const corpusLimit = error instanceof GraphCorpusLimitError;
        if (corpusLimit) reportCorpusLimit();
        else report({
          code: outsideProject
            ? "GRAPH_SEMANTIC_INPUT_PATH_OUTSIDE_PROJECT"
            : "GRAPH_SEMANTIC_INPUT_READ_FAILED",
          severity: "warning",
          message: outsideProject
            ? `Refused to inspect compiler semantic input ${input.path} because its resolved target escapes the project root.`
            : `Could not hash compiler semantic input ${input.path} safely.`,
          path: input.path,
        });
        if (corpusLimit) break;
        continue;
      }
    }
    hashes.set(input.path, contentHash);
    if (contentHash !== input.contentHash) {
      changedPaths.push(input.path);
      const change = input.contentHash === null
        ? "appeared"
        : contentHash === null
          ? "disappeared"
          : "changed";
      report({
        code: "GRAPH_SEMANTIC_INPUT_CHANGED",
        severity: "warning",
        message: `Compiler semantic input ${input.path} ${change} after graph publication.`,
        path: input.path,
      });
    }
  }
  if (omittedDiagnostics > 0) {
    diagnostics.push({
      code: "GRAPH_SEMANTIC_INPUT_DIAGNOSTICS_TRUNCATED",
      severity: "info",
      message: `${omittedDiagnostics} additional compiler semantic-input diagnostic(s) were omitted.`,
    });
  }
  return { hashes, changedPaths, unavailablePaths, complete, diagnostics };
}

function readStableContainedUtf8File(
  projectRoot: string,
  projectRootRealPath: string,
  path: string,
  afterRead?: () => void,
): string {
  const absolutePath = resolve(projectRoot, path);
  if (!isPathContained(projectRoot, absolutePath)) {
    throw containedFileError(
      "GRAPH_CONTAINED_FILE_OUTSIDE_PROJECT",
      "The repository-relative path escapes the project root.",
    );
  }
  const canonicalPath = realpathSync(absolutePath);
  if (!isPathContained(projectRootRealPath, canonicalPath)) {
    throw containedFileError(
      "GRAPH_CONTAINED_FILE_OUTSIDE_PROJECT",
      "The resolved file target escapes the project root.",
    );
  }
  const before = lstatSync(canonicalPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw containedFileError(
      "GRAPH_CONTAINED_FILE_INVALID",
      "The resolved path is not a stable regular file.",
    );
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const fd = openSync(canonicalPath, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || databaseFileIdentity(opened) !== databaseFileIdentity(before)) {
      throw containedFileError(
        "GRAPH_CONTAINED_FILE_CHANGED",
        "The resolved file changed before it could be read.",
      );
    }
    if (!Number.isSafeInteger(opened.size)
      || opened.size < 0
      || opened.size > GRAPH_CORPUS_LIMITS.maxSourceFileBytes) {
      throw new GraphCorpusLimitError("maxSourceFileBytes");
    }
    const content = readFileSync(fd, "utf8");
    afterRead?.();
    const after = fstatSync(fd);
    const resolvedAfter = realpathSync(absolutePath);
    const pathAfter = lstatSync(resolvedAfter);
    if (databaseFileIdentity(opened) !== databaseFileIdentity(after)
      || !isSameResolvedPath(resolvedAfter, canonicalPath)
      || !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || databaseFileIdentity(opened) !== databaseFileIdentity(pathAfter)) {
      throw containedFileError(
        "GRAPH_CONTAINED_FILE_CHANGED",
        "The repository path changed while it was being read.",
      );
    }
    return content;
  } finally {
    closeSync(fd);
  }
}

function assertSecurelyContainedMissingPath(
  projectRoot: string,
  projectRootRealPath: string,
  path: string,
): void {
  const absolutePath = resolve(projectRoot, path);
  if (!isPathContained(projectRoot, absolutePath)) {
    throw containedFileError(
      "GRAPH_CONTAINED_FILE_OUTSIDE_PROJECT",
      "The repository-relative path escapes the project root.",
    );
  }
  try {
    const exact = lstatSync(absolutePath);
    if (exact.isSymbolicLink()) {
      throw containedFileError(
        "GRAPH_CONTAINED_FILE_UNAVAILABLE",
        "A missing repository path is represented by an unresolved symlink.",
      );
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") throw error;
  }

  let ancestor = dirname(absolutePath);
  for (;;) {
    try {
      const canonicalAncestor = realpathSync(ancestor);
      if (!isPathContained(projectRootRealPath, canonicalAncestor)) {
        throw containedFileError(
          "GRAPH_CONTAINED_FILE_OUTSIDE_PROJECT",
          "The missing file's resolved ancestor escapes the project root.",
        );
      }
      return;
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") throw error;
      try {
        if (lstatSync(ancestor).isSymbolicLink()) {
          throw containedFileError(
            "GRAPH_CONTAINED_FILE_UNAVAILABLE",
            "A missing file's ancestor is an unresolved symlink.",
          );
        }
      } catch (lstatError) {
        if (errorCode(lstatError) !== "ENOENT" && errorCode(lstatError) !== "ENOTDIR") {
          throw lstatError;
        }
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw containedFileError(
          "GRAPH_CONTAINED_FILE_UNAVAILABLE",
          "No stable repository ancestor could be resolved.",
        );
      }
      ancestor = parent;
    }
  }
}

function containedFileError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function inspectLiveSources(
  projectRoot: string,
  projectRootRealPath: string,
  diagnosticLimit: number,
  afterSourceRead?: (path: string) => void,
): LiveSources {
  const diagnostics: Diagnostic[] = [];
  const hashes = new Map<string, string>();
  const discoveredPaths = new Set<string>();
  let omittedDiagnostics = 0;
  const reportPathDiagnostic = (diagnostic: Diagnostic): void => {
    if (diagnostics.length < diagnosticLimit) diagnostics.push(diagnostic);
    else omittedDiagnostics++;
  };
  const reportCorpusLimit = (): void => {
    if (diagnostics.some((diagnostic) =>
      diagnostic.code === "GRAPH_SOURCE_CORPUS_LIMIT_EXCEEDED")) return;
    diagnostics.push({
      code: "GRAPH_SOURCE_CORPUS_LIMIT_EXCEEDED",
      severity: "warning",
      message: "The supported source corpus exceeds MEX's bounded inspection policy.",
    });
  };
  let matches: string[];
  try {
    matches = discoverBoundedGraphPaths(GRAPH_SUPPORTED_SOURCE_GLOB, {
      ...GRAPH_CORPUS_GLOB_OPTIONS,
      cwd: projectRoot,
      ignore: graphCorpusIgnoreGlobs(projectRoot),
    }, GRAPH_CORPUS_LIMITS.maxSourceFiles)
      .map(toPosix)
      .filter(isSupportedSourceFile)
      .sort(compareCodePoints);
  } catch (error) {
    diagnostics.push({
      code: error instanceof GraphCorpusLimitError
        ? "GRAPH_SOURCE_CORPUS_LIMIT_EXCEEDED"
        : "GRAPH_SOURCE_DISCOVERY_FAILED",
      severity: "warning",
      message: error instanceof GraphCorpusLimitError
        ? "The supported source corpus exceeds MEX's bounded inspection policy."
        : `Could not discover supported source files: ${errorMessage(error)}`,
    });
    return { hashes, discoveredPaths, complete: false, diagnostics };
  }

  let complete = true;
  let sourceBytes = 0;
  for (const path of matches) {
    discoveredPaths.add(path);
    try {
      const content = readStableContainedUtf8File(
        projectRoot,
        projectRootRealPath,
        path,
        () => afterSourceRead?.(path),
      );
      sourceBytes = addGraphCorpusBytes(
        sourceBytes,
        Buffer.byteLength(content, "utf8"),
        "source",
      );
      hashes.set(path, sha256(content));
    } catch (error) {
      // A file the bounded policy will not read for its own size is skipped by
      // indexing too, so the corpus observation stays complete and the walk
      // continues. Only a corpus-wide breach makes the observation partial.
      if (isPerFileCorpusLimitError(error)) {
        discoveredPaths.delete(path);
        reportPathDiagnostic({
          code: "GRAPH_SOURCE_FILE_SKIPPED",
          severity: "warning",
          message: `Supported source file ${path} is not indexed: ${errorMessage(error)}`,
          path,
        });
        continue;
      }
      complete = false;
      const code = errorCode(error);
      const outsideProject = code === "GRAPH_CONTAINED_FILE_OUTSIDE_PROJECT";
      const invalidPath = code === "GRAPH_CONTAINED_FILE_INVALID";
      const corpusLimit = error instanceof GraphCorpusLimitError;
      if (corpusLimit) reportCorpusLimit();
      else reportPathDiagnostic({
        code: outsideProject
            ? "GRAPH_SOURCE_PATH_OUTSIDE_PROJECT"
            : invalidPath
              ? "GRAPH_SOURCE_PATH_INVALID"
              : "GRAPH_SOURCE_READ_FAILED",
        severity: "warning",
        message: outsideProject
            ? `Refused to inspect supported source path ${path} because its resolved target escapes the project root.`
            : invalidPath
              ? `Refused to inspect supported source path ${path} because it is not a regular file.`
              : `Could not hash supported source file ${path}: ${errorMessage(error)}`,
        path,
      });
      if (corpusLimit) break;
    }
  }
  if (omittedDiagnostics > 0) {
    diagnostics.push({
      code: "GRAPH_SOURCE_DIAGNOSTICS_TRUNCATED",
      severity: "info",
      message: `${omittedDiagnostics} additional source inspection diagnostic(s) were omitted.`,
    });
  }
  return { hashes, discoveredPaths, complete, diagnostics };
}

function compareSources(
  files: FileRow[],
  live: LiveSources,
  snapshot: GraphSnapshot | undefined,
  currentRepo: RepoState,
  manifest: ReturnType<typeof graphManifest> | null,
  metadata: Map<string, MetadataValue>,
  limit: number,
): { changes: GraphSourceChanges; digestChanged: boolean } {
  const indexed = new Map(files.map((file) => [file.path, file.content_hash]));
  const all: Array<{ path: string; kind: "added" | "modified" | "deleted" }> = [];
  for (const [path, contentHash] of live.hashes) {
    const stored = indexed.get(path);
    if (stored === undefined) all.push({ path, kind: "added" });
    else if (stored !== contentHash) all.push({ path, kind: "modified" });
  }
  if (live.complete) {
    for (const path of indexed.keys()) {
      if (!live.discoveredPaths.has(path)) all.push({ path, kind: "deleted" });
    }
  }
  all.sort((left, right) => compareCodePoints(left.path, right.path) || compareCodePoints(left.kind, right.kind));
  const visible = all.slice(0, limit);

  const storedManifest = snapshot?.manifestHash ?? metadata.get("manifest_hash")?.value;
  const storedConfig = snapshot?.configHash ?? metadata.get("config_hash")?.value;
  const storedGrammar = snapshot?.grammarHash ?? metadata.get("grammar_hash")?.value;
  const manifestChanged = manifest !== null && storedManifest !== undefined
    ? storedManifest !== manifest.manifestHash
    : false;
  const configChanged = manifest !== null && storedConfig !== undefined
    ? storedConfig !== manifest.configHash
    : false;
  const grammarChanged = manifest !== null && storedGrammar !== undefined
    ? storedGrammar !== manifest.grammarHash
    : false;
  const branchChanged = snapshot !== undefined
    ? snapshot.indexedBranch !== currentRepo.branch
    : false;
  const digestChanged = live.complete && snapshot !== undefined
    ? snapshot.sourceCount !== live.hashes.size
      || snapshot.sourceCorpusDigest !== graphSourceCorpusDigest(live.hashes)
    : false;
  return {
    changes: {
      total: all.length,
      added: visible.filter((entry) => entry.kind === "added").map((entry) => entry.path),
      modified: visible.filter((entry) => entry.kind === "modified").map((entry) => entry.path),
      deleted: visible.filter((entry) => entry.kind === "deleted").map((entry) => entry.path),
      truncated: all.length > visible.length,
      branchChanged,
      manifestChanged,
      configChanged,
      grammarChanged,
    },
    digestChanged,
  };
}

function changesWithoutIndex(
  live: LiveSources,
  _currentRepo: RepoState,
  limit: number,
  knownMissing = false,
): GraphSourceChanges {
  if (!knownMissing) return emptySourceChanges();
  const paths = [...live.hashes.keys()].sort(compareCodePoints);
  return {
    total: paths.length,
    added: paths.slice(0, limit),
    modified: [],
    deleted: [],
    truncated: paths.length > limit,
    branchChanged: false,
    manifestChanged: false,
    configChanged: false,
    grammarChanged: false,
  };
}

function summarizeParseHealth(files: FileRow[], limit: number): GraphParseHealth {
  const failed = files.filter((file) => file.parse_status === "failed")
    .map((file) => file.path)
    .sort(compareCodePoints);
  return {
    total: files.length,
    ok: files.filter((file) => file.parse_status === "ok").length,
    partial: files.filter((file) => file.parse_status === "partial").length,
    failed: failed.length,
    failedPaths: failed.slice(0, limit),
    failedPathsTruncated: failed.length > limit,
  };
}

function snapshotMatchesStoredRows(
  snapshot: GraphSnapshot,
  files: FileRow[],
  parseHealth: GraphParseHealth,
): boolean {
  return snapshot.sourceCount === parseHealth.total
    && snapshot.sourceCorpusDigest === graphSourceCorpusDigest(
      files.map((file) => [file.path, file.content_hash] as const),
    )
    && snapshot.parseHealth.total === parseHealth.total
    && snapshot.parseHealth.ok === parseHealth.ok
    && snapshot.parseHealth.partial === parseHealth.partial
    && snapshot.parseHealth.failed === parseHealth.failed;
}

function emptyParseHealth(): GraphParseHealth {
  return {
    total: 0,
    ok: 0,
    partial: 0,
    failed: 0,
    failedPaths: [],
    failedPathsTruncated: false,
  };
}

function readFiles(db: SqliteDatabase): FileRow[] {
  const oversized = db.prepare(
    `SELECT 1 FROM files
     WHERE typeof(path) <> 'text'
        OR length(CAST(path AS BLOB)) > 4096
        OR typeof(content_hash) <> 'text'
        OR length(CAST(content_hash AS BLOB)) <> 64
        OR typeof(parse_status) <> 'text'
        OR length(CAST(parse_status AS BLOB)) > 7
     LIMIT 1`,
  ).get();
  if (oversized) {
    throw new CorruptGraphIndexError("The graph files table contains an oversized or malformed field.");
  }
  const rows = db.prepare(
    `SELECT path, content_hash, parse_status, indexed_at FROM files
     ORDER BY path LIMIT ${GRAPH_CORPUS_LIMITS.maxSourceFiles + 1}`,
  ).all() as FileRow[];
  if (rows.length > GRAPH_CORPUS_LIMITS.maxSourceFiles) {
    throw new GraphCorpusLimitError("maxSourceFiles");
  }
  for (const row of rows) {
    if (!row.path
      || !/^[a-f0-9]{64}$/u.test(row.content_hash)
      || !["ok", "partial", "failed"].includes(row.parse_status)
      || !Number.isFinite(row.indexed_at)) {
      throw new CorruptGraphIndexError("The graph files table contains an invalid row.");
    }
  }
  return rows;
}

function inspectRequiredSchema(db: SqliteDatabase): string[] {
  const failures: string[] = [];
  const missingTables = new Set<string>();
  for (const [type, names] of Object.entries(REQUIRED_SCHEMA_OBJECTS)) {
    for (const name of names) {
      const row = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?",
      ).get(type, name);
      if (!row) {
        failures.push(`missing ${type} ${name}`);
        if (type === "table") missingTables.add(name);
      }
    }
  }
  // Missing FTS shadow tables can make even PRAGMA table_xinfo on the virtual
  // table fail with a generic SQL error. Report the precise missing objects
  // before attempting column-level validation.
  if ([...missingTables].some((name) => /_(?:fts)_(?:config|data|docsize|idx)$/u.test(name))) {
    return failures.sort(compareCodePoints);
  }
  for (const [table, requiredColumns] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new CorruptGraphIndexError("The required graph schema list contains an invalid identifier.");
    }
    if (missingTables.has(table)) continue;
    // table_xinfo includes generated columns such as schema-v4's scaffold_file
    // compatibility projection; table_info deliberately hides them.
    const rows = db.prepare(`PRAGMA table_xinfo("${table}")`).all() as Array<{ name?: unknown }>;
    const columns = new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === "string"));
    for (const column of requiredColumns) {
      if (!columns.has(column)) failures.push(`missing column ${table}.${column}`);
    }
  }
  return failures.sort(compareCodePoints);
}

function inspectCoreInvariants(db: SqliteDatabase): string[] {
  const checks: ReadonlyArray<readonly [string, string]> = [
    ["duplicate edge group(s)", `
      SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM edges
        GROUP BY source, target, kind, IFNULL(line, -1), IFNULL(col, -1)
        HAVING COUNT(*) > 1
      )
    `],
    ["dangling edge(s)", `
      SELECT COUNT(*) AS count FROM edges e
      LEFT JOIN nodes source_node ON source_node.id = e.source
      LEFT JOIN nodes target_node ON target_node.id = e.target
      WHERE source_node.id IS NULL OR target_node.id IS NULL
    `],
    ["node(s) without an owning file", `
      SELECT COUNT(*) AS count FROM nodes n
      LEFT JOIN files f ON f.path = n.file_path
      WHERE f.path IS NULL
    `],
    ["node(s) with a dangling container", `
      SELECT COUNT(*) AS count FROM nodes n
      LEFT JOIN nodes container ON container.id = n.container_id
      WHERE n.container_id IS NOT NULL AND container.id IS NULL
    `],
    ["file(s) with an incorrect node_count", `
      SELECT COUNT(*) AS count FROM files f
      LEFT JOIN (
        SELECT file_path, COUNT(*) AS actual_count FROM nodes GROUP BY file_path
      ) n ON n.file_path = f.path
      WHERE COALESCE(f.node_count, -1) <> COALESCE(n.actual_count, 0)
    `],
    ["source chunk(s) without an owning file", `
      SELECT COUNT(*) AS count FROM source_chunks c
      LEFT JOIN files f ON f.path = c.file_path
      WHERE f.path IS NULL
    `],
    ["alias(es) without a canonical node", `
      SELECT COUNT(*) AS count FROM node_aliases a
      LEFT JOIN nodes n ON n.id = a.canonical_node_id
      WHERE n.id IS NULL
    `],
    ["unresolved reference(s) without an owning node", `
      SELECT COUNT(*) AS count FROM unresolved_refs r
      LEFT JOIN nodes n ON n.id = r.from_node_id
      WHERE n.id IS NULL
    `],
    ["unresolved reference(s) with a dangling target", `
      SELECT COUNT(*) AS count FROM unresolved_refs r
      LEFT JOIN nodes n ON n.id = r.target_id
      WHERE r.target_id IS NOT NULL AND n.id IS NULL
    `],
    ["unresolved reference(s) without an owning file", `
      SELECT COUNT(*) AS count FROM unresolved_refs r
      LEFT JOIN files f ON f.path = r.file_path
      WHERE r.file_path <> '' AND f.path IS NULL
    `],
    ["import binding(s) without an owning file", `
      SELECT COUNT(*) AS count FROM import_bindings b
      LEFT JOIN files f ON f.path = b.file_path
      WHERE f.path IS NULL
    `],
    ["import binding(s) with a dangling target", `
      SELECT COUNT(*) AS count FROM import_bindings b
      LEFT JOIN nodes n ON n.id = b.target_id
      WHERE b.target_id IS NOT NULL AND n.id IS NULL
    `],
    // A bucket whose fingerprint has no node implies that fingerprint has no
    // node, which this check reports. A bucket with no fingerprint at all is
    // counted as a malformed owner by the ordered walk in
    // inspectFingerprintInvariants. Joining lsh_buckets here re-derived both
    // faults and was most of the audit's cost on a large store.
    ["fingerprint(s) without a node", `
      SELECT COUNT(*) AS count FROM node_fingerprints f
      LEFT JOIN nodes n ON n.id = f.node_id
      WHERE n.id IS NULL
    `],
    ["node(s) missing from full-text search", `
      SELECT COUNT(*) AS count FROM nodes n
      LEFT JOIN nodes_fts_docsize fts ON fts.id = n.rowid
      WHERE fts.id IS NULL
    `],
    ["orphan node full-text row(s)", `
      SELECT COUNT(*) AS count FROM nodes_fts_docsize fts
      LEFT JOIN nodes n ON n.rowid = fts.id
      WHERE n.rowid IS NULL
    `],
    ["source chunk(s) missing from full-text search", `
      SELECT COUNT(*) AS count FROM source_chunks c
      LEFT JOIN source_chunks_fts_docsize fts ON fts.id = c.id
      WHERE fts.id IS NULL
    `],
    ["orphan source-chunk full-text row(s)", `
      SELECT COUNT(*) AS count FROM source_chunks_fts_docsize fts
      LEFT JOIN source_chunks c ON c.id = fts.id
      WHERE c.id IS NULL
    `],
  ];
  const failures: string[] = [];
  for (const [label, sql] of checks) {
    const count = readCount(db, sql);
    if (count > 0) failures.push(`${count} ${label}`);
  }
  failures.push(...inspectFingerprintInvariants(db));
  return failures.sort(compareCodePoints);
}

interface StoredFingerprintRow {
  ref: unknown;
  node_id: unknown;
  minhash: unknown;
  neighbors: unknown;
  token_count: unknown;
}

interface StoredLshBucketRow {
  ref: unknown;
  band: unknown;
  band_hash: unknown;
}

/**
 * Validate the exact persisted shape consumed by FingerprintStore and the
 * reconciler. Iterating two independently ordered cursors avoids retaining the
 * repository's full fingerprint or LSH corpus in memory.
 */
function inspectFingerprintInvariants(db: SqliteDatabase): string[] {
  const oversizedFingerprint = db.prepare(
    `SELECT 1 FROM node_fingerprints
     WHERE typeof(node_id) <> 'text'
        OR length(CAST(node_id AS BLOB)) > 4096
        OR length(CAST(minhash AS BLOB)) > 4096
        OR typeof(neighbors) <> 'text'
        OR length(CAST(neighbors AS BLOB)) > ${GRAPH_CORPUS_LIMITS.maxSnapshotMetadataBytes}
     LIMIT 1`,
  ).get();
  const oversizedBucket = db.prepare(
    `SELECT 1 FROM lsh_buckets
     WHERE length(CAST(ref AS BLOB)) > 128
        OR length(CAST(band_hash AS BLOB)) > 128
     LIMIT 1`,
  ).get();
  if (oversizedFingerprint || oversizedBucket) {
    throw new CorruptGraphIndexError("Graph fingerprint state contains an oversized persisted value.");
  }
  let malformedFingerprints = 0;
  let malformedBucketOwners = 0;
  let missingBands = 0;
  let duplicateBuckets = 0;
  let outOfRangeBands = 0;
  let wrongBandHashes = 0;

  const bucketIterator = db.prepare(
    `SELECT CAST(ref AS TEXT) AS ref, band, CAST(band_hash AS TEXT) AS band_hash
     FROM lsh_buckets ORDER BY lsh_buckets.ref, band, band_hash`,
  ).iterate()[Symbol.iterator]() as IterableIterator<StoredLshBucketRow>;
  let bucketStep = bucketIterator.next();

  const advanceMalformedBucketOwners = (): void => {
    while (!bucketStep.done && typeof bucketStep.value.ref !== "string") {
      malformedBucketOwners += 1;
      bucketStep = bucketIterator.next();
    }
  };
  advanceMalformedBucketOwners();

  const fingerprints = db.prepare(
    `SELECT CAST(ref AS TEXT) AS ref, node_id, minhash, neighbors, token_count
     FROM node_fingerprints ORDER BY node_fingerprints.ref`,
  ).iterate() as IterableIterator<StoredFingerprintRow>;
  for (const row of fingerprints) {
    if (typeof row.ref !== "string" || typeof row.node_id !== "string") {
      malformedFingerprints += 1;
      continue;
    }
    const ref = BigInt(row.ref);
    while (!bucketStep.done
      && BigInt(bucketStep.value.ref as string) < ref) {
      malformedBucketOwners += 1;
      bucketStep = bucketIterator.next();
      advanceMalformedBucketOwners();
    }

    const fingerprint = decodeStoredFingerprint(row);
    if (!fingerprint) malformedFingerprints += 1;
    const expectedHashes = fingerprint ? bandHashInts(fingerprint).map(String) : null;
    const bandCounts = Array.from({ length: BANDS }, () => 0);
    while (!bucketStep.done && bucketStep.value.ref === row.ref) {
      const bucket = bucketStep.value;
      if (typeof bucket.band !== "number"
        || !Number.isSafeInteger(bucket.band)
        || bucket.band < 0
        || bucket.band >= BANDS) {
        outOfRangeBands += 1;
      } else {
        bandCounts[bucket.band]! += 1;
        if (expectedHashes && bucket.band_hash !== expectedHashes[bucket.band]) {
          wrongBandHashes += 1;
        }
      }
      bucketStep = bucketIterator.next();
      advanceMalformedBucketOwners();
    }
    for (const count of bandCounts) {
      if (count === 0) missingBands += 1;
      else if (count > 1) duplicateBuckets += count - 1;
    }
  }
  while (!bucketStep.done) {
    malformedBucketOwners += 1;
    bucketStep = bucketIterator.next();
  }

  const failures: string[] = [];
  if (malformedFingerprints > 0) {
    failures.push(`${malformedFingerprints} malformed fingerprint row(s)`);
  }
  if (malformedBucketOwners > 0) {
    failures.push(`${malformedBucketOwners} malformed LSH bucket owner row(s)`);
  }
  if (missingBands > 0) failures.push(`${missingBands} missing fingerprint LSH band(s)`);
  if (duplicateBuckets > 0) {
    failures.push(`${duplicateBuckets} duplicate fingerprint LSH bucket row(s)`);
  }
  if (outOfRangeBands > 0) {
    failures.push(`${outOfRangeBands} out-of-range fingerprint LSH bucket row(s)`);
  }
  if (wrongBandHashes > 0) {
    failures.push(`${wrongBandHashes} fingerprint LSH bucket hash mismatch(es)`);
  }
  return failures;
}

function decodeStoredFingerprint(row: StoredFingerprintRow): Fingerprint | null {
  if (!(row.minhash instanceof Uint8Array)
    || typeof row.neighbors !== "string"
    || typeof row.token_count !== "number"
    || !Number.isSafeInteger(row.token_count)
    || row.token_count < 0) return null;
  let minhash: unknown;
  let neighbors: unknown;
  try {
    minhash = decodeMinhash(row.minhash);
    neighbors = JSON.parse(row.neighbors);
  } catch {
    return null;
  }
  if (!Array.isArray(minhash)
    || minhash.length !== K
    || minhash.some((value) => (
      typeof value !== "number"
      || !Number.isInteger(value)
      || value < 0
      || value > 0xffff_ffff
    ))
    || !Array.isArray(neighbors)
    || neighbors.some((value) => typeof value !== "string")) return null;
  return { minhash, neighbors, tokenCount: row.token_count };
}

function readCount(db: SqliteDatabase, sql: string): number {
  const row = db.prepare(sql).get() as { count?: unknown } | undefined;
  const value = row?.count;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CorruptGraphIndexError("A graph invariant query returned an invalid count.");
  }
  return value;
}

function readMetadata(db: SqliteDatabase): Map<string, MetadataValue> {
  const placeholders = STATUS_METADATA_KEYS.map(() => "?").join(", ");
  const oversized = db.prepare(
    `SELECT 1 FROM project_metadata
     WHERE key IN (${placeholders})
       AND (
         typeof(value) <> 'text'
         OR length(CAST(value AS BLOB)) > CASE
           WHEN key = ? THEN ? ELSE ? END
       )
     LIMIT 1`,
  ).get(
    ...STATUS_METADATA_KEYS,
    GRAPH_SNAPSHOT_METADATA_KEY,
    GRAPH_CORPUS_LIMITS.maxSnapshotMetadataBytes,
    MAX_METADATA_VALUE_BYTES,
  );
  if (oversized) {
    throw new CorruptGraphIndexError("Graph status metadata exceeds its bounded value policy.");
  }
  const rows = db.prepare(
    `SELECT key, value, updated_at FROM project_metadata
     WHERE key IN (${placeholders}) ORDER BY key LIMIT ${STATUS_METADATA_KEYS.length}`,
  ).all(...STATUS_METADATA_KEYS) as Array<{ key: string; value: string; updated_at: number }>;
  if (rows.some((row) => typeof row.key !== "string"
    || typeof row.value !== "string"
    || !Number.isSafeInteger(row.updated_at)
    || row.updated_at < 0)) {
    throw new CorruptGraphIndexError("Graph status metadata contains an invalid field.");
  }
  return new Map(rows.map((row) => [row.key, { value: row.value, updatedAt: row.updated_at }]));
}

function readSnapshot(raw: string | undefined): { snapshot?: GraphSnapshot; error?: string } {
  if (raw === undefined) return {};
  const snapshot = parseGraphSnapshot(raw);
  return snapshot
    ? { snapshot }
    : { error: "graph_snapshot_v1 has invalid JSON, fields, or version." };
}

function quickCheck(db: SqliteDatabase): string[] {
  const rows = db.prepare("PRAGMA quick_check(100)").all() as Array<Record<string, unknown>>;
  return rows.map((row) => String(row.quick_check ?? Object.values(row)[0] ?? ""))
    .filter((result) => result.toLowerCase() !== "ok");
}

function tableExists(db: SqliteDatabase, name: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

function readSchemaVersion(db: SqliteDatabase): number | null {
  const row = db.prepare(
    "SELECT version FROM schema_versions ORDER BY version DESC LIMIT 1",
  ).get() as { version: number } | undefined;
  return row && Number.isInteger(row.version) ? row.version : null;
}

function latestIndexedAt(files: FileRow[]): string | null {
  const latest = Math.max(...files.map((file) => Number(file.indexed_at)).filter(Number.isFinite));
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}

function metadataTimestamp(metadata: MetadataValue | undefined): string | null {
  if (!metadata || !Number.isFinite(metadata.updatedAt)) return null;
  return new Date(metadata.updatedAt).toISOString();
}

function inspectCurrentManifest(
  projectRoot: string,
  diagnostics: Diagnostic[],
): ReturnType<typeof graphManifest> | null {
  try {
    return graphManifest(projectRoot);
  } catch (error) {
    const corpusLimit = isGraphCorpusLimitError(error);
    diagnostics.push({
      code: corpusLimit
        ? "GRAPH_MANIFEST_CORPUS_LIMIT_EXCEEDED"
        : "GRAPH_MANIFEST_INSPECTION_FAILED",
      severity: "warning",
      message: corpusLimit
        ? "The graph configuration corpus exceeds MEX's bounded inspection policy."
        : `Could not inspect the current graph build manifest: ${errorMessage(error)}`,
    });
    return null;
  }
}

async function inspectRepoState(
  projectRoot: string,
  observedAt: string,
): Promise<RepoObservation> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  try {
    const result = await execFileAsync("git", [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-C",
      projectRoot,
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=normal",
    ], {
      cwd: projectRoot,
      env,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    let branch: string | null = null;
    let head: string | null = null;
    let dirty = false;
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith("# branch.head ")) {
        const value = line.slice("# branch.head ".length);
        branch = value === "(detached)" ? null : value || null;
      } else if (line.startsWith("# branch.oid ")) {
        const value = line.slice("# branch.oid ".length);
        head = /^[0-9a-f]{40,64}$/i.test(value) ? value : null;
      } else if (line !== "" && !line.startsWith("# ")) {
        dirty = true;
      }
    }
    return {
      state: { branch, head, dirty, observedAt },
      complete: true,
      diagnostics: [],
    };
  } catch (error) {
    const message = errorMessage(error);
    if (/not a git repository/i.test(message)) {
      return { state: emptyRepoState(observedAt), complete: true, diagnostics: [] };
    }
    return {
      state: emptyRepoState(observedAt),
      complete: false,
      diagnostics: [{
        code: "GRAPH_REPO_STATE_UNAVAILABLE",
        severity: "info",
        message: `Could not inspect Git working-tree state: ${message}`,
      }],
    };
  }
}

function classifyDatabaseError(error: unknown, operation: string): ClassifiedError {
  const message = errorMessage(error);
  const code = errorCode(error);
  if (error instanceof GraphCorpusLimitError) {
    return {
      status: "degraded",
      diagnostic: {
        code: "GRAPH_INDEX_CORPUS_LIMIT_EXCEEDED",
        severity: "warning",
        message: "The disposable graph index exceeds MEX's bounded inspection policy.",
      },
    };
  }
  const corrupt = error instanceof CorruptGraphIndexError
    || /corrupt|malformed|not a database|file is encrypted|no such (?:table|column)/i.test(message)
    || /CORRUPT|NOTADB/.test(code);
  if (corrupt) {
    return {
      status: "corrupt",
      diagnostic: {
        code: "GRAPH_INDEX_CORRUPT",
        severity: "error",
        message: `Could not ${operation} the graph index: ${message}`,
      },
    };
  }
  return {
    status: "degraded",
    diagnostic: {
      code: /busy|locked/i.test(`${code} ${message}`) ? "GRAPH_INDEX_LOCKED" : "GRAPH_INDEX_UNAVAILABLE",
      severity: "warning",
      message: `Could not ${operation} the graph index without mutation: ${message}`,
      remediation: [{ label: "Retry graph status" }],
    },
  };
}

function rebuildDiagnostic(message: string, executable = true): Diagnostic {
  return {
    code: "GRAPH_INDEX_REBUILD_REQUIRED",
    severity: "warning",
    message,
    remediation: executable ? [{ label: "Rebuild graph", command: "mex graph rebuild" }] : undefined,
  };
}

function repairDiagnostic(message: string): Diagnostic {
  return {
    code: "GRAPH_INDEX_REPAIR_AVAILABLE",
    severity: "warning",
    message,
    remediation: [{ label: "Upgrade graph schema", command: "mex graph repair" }],
  };
}

function isGraphMaintenanceCommand(command: string | undefined): boolean {
  return command === "mex graph"
    || command === "mex graph refresh"
    || command === "mex graph rebuild"
    || command === "mex graph repair";
}

function resolveNow(now: InspectGraphStatusOptions["now"]): Date {
  const value = typeof now === "function" ? now() : now ?? new Date();
  if (Number.isNaN(value.getTime())) throw new Error("inspectGraphStatus requires a valid clock value.");
  return value;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_MAX_CHANGED_PATHS;
  if (!Number.isFinite(limit)) return DEFAULT_MAX_CHANGED_PATHS;
  return Math.max(0, Math.floor(limit));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

function diagnosticBasename(path: string): string {
  const safe = basename(path).replace(/[\u0000-\u001f\u007f]/g, "?");
  return safe.length <= 160 ? safe : `${safe.slice(0, 159)}…`;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGraphCorpusLimitError(error: unknown): boolean {
  if (error instanceof GraphCorpusLimitError || errorCode(error) === "GRAPH_CORPUS_LIMIT_EXCEEDED") {
    return true;
  }
  if (!isRecord(error) || !Array.isArray(error.failures)) return false;
  return error.failures.some((failure) =>
    isRecord(failure) && failure.code === "GRAPH_CORPUS_LIMIT_EXCEEDED");
}

function errorCode(error: unknown): string {
  if (!isRecord(error)) return "";
  return typeof error.code === "string" ? error.code : "";
}
