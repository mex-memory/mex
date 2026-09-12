import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isSameResolvedPath, resolveRealPath } from "../paths.js";
import type { GraphStatus } from "../team/contracts/graph.js";
import { GRAPH_CORPUS_LIMITS, GraphCorpusLimitError } from "./corpus-policy.js";
import { openGraphDatabase } from "./db/database.js";
import type { SqliteDatabase } from "./db/sqlite.js";
import { createGraphEngineFromOpenDatabase } from "./engine-impl.js";
import type { GraphEngine, IndexedFileInfo } from "./engine.js";
import {
  inspectGraphSidecars,
  inspectGraphStatusWithFreshObservation,
  resolveContainedGraphDatabasePath,
  type GraphSidecarProbe,
  type InternalGraphFreshObservationToken,
  type InternalGraphStatusInspection,
  type GraphReadDegradation,
} from "./status.js";
import {
  GRAPH_SNAPSHOT_METADATA_KEY,
  computeSourceCorpusDigest,
  parseGraphSnapshot,
  type GraphSnapshot,
} from "./snapshot.js";

export interface GraphReadValidation {
  valid: boolean;
  code?: string;
  message?: string;
}

/** @internal One immutable SQLite snapshot shared by every graph facade in a read. */
export interface InternalGraphReadSession {
  graph: GraphEngine;
  db: SqliteDatabase;
  /** Read one indexed source file from a stable fd and prove its exact bytes match SQLite. */
  readIndexedSource(filePath: string): string;
  validate(): GraphReadValidation;
  close(): void;
}

export interface GraphFreshnessRevalidation extends GraphReadValidation {
  graphStatus: GraphStatus;
}

/** @internal A stable database session bound to one successful freshness observation. */
export interface InternalFreshGraphReadSession extends InternalGraphReadSession {
  graphStatus: GraphStatus;
  /**
   * The ways this store falls short of `fresh`, empty when it does not.
   *
   * It is bound exactly either way; these say what a reader must qualify when
   * it reports the answer.
   */
  degradations: readonly GraphReadDegradation[];
  /** Complete, sorted list of indexed paths that no longer match the tree. */
  driftedSources: readonly string[];
  revalidateFreshness(): Promise<GraphFreshnessRevalidation>;
}

export interface InternalFreshGraphReadResult {
  graphStatus: GraphStatus;
  session: InternalFreshGraphReadSession | null;
  /**
   * True when config content drifted under an engine identity that still
   * reproduces. A caller explaining a refusal uses this to avoid naming the
   * one input the gate excused.
   */
  configDriftTolerated?: boolean;
}

interface ImmutableGraphReadHooks {
  afterDatabaseIdentityRead?: () => void | Promise<void>;
  afterDatabaseOpen?: (database: SqliteDatabase) => void | Promise<void>;
  afterDatabaseDescriptorClose?: () => void;
  beforeIndexedSourceRead?: (filePath: string) => void;
  afterIndexedSourceRead?: (filePath: string) => void;
}

export interface LoadFreshGraphReadSessionOptions {
  dbPath?: string;
  loadSession?: boolean;
  /**
   * Also adopt a store whose only unproven input is config content, reported
   * as `config-drifted`.
   *
   * Opt-in, because the caller — not this loader — owns the obligation to say
   * so in its output. A consumer that cannot label a degraded answer must not
   * receive one.
   */
  allowDegradedReads?: boolean;
  inspectObservation?: typeof inspectGraphStatusWithFreshObservation;
  inspectSidecars?: typeof inspectGraphSidecars;
  afterStatusInspection?: (
    inspection: InternalGraphStatusInspection,
  ) => void | Promise<void>;
  hooks?: ImmutableGraphReadHooks;
}

export interface OpenImmutableGraphReadSessionOptions extends ImmutableGraphReadHooks {
  inspectSidecars?: typeof inspectGraphSidecars;
  expectedObservation?: InternalGraphFreshObservationToken;
  /** Fresh loaders verify the adopted snapshot before performing the final path probe. */
  deferPostOpenValidation?: boolean;
}

export interface OpenImmutableGraphReadSessionSyncOptions {
  inspectSidecars?: typeof inspectGraphSidecars;
  afterDatabaseDescriptorClose?: () => void;
}

interface BoundDatabaseFile {
  readonly databasePath: string;
  readonly identity: string;
  close(): void;
}

class GraphReadSessionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GraphReadSessionError";
  }
}

/** Synchronous form used by the existing synchronous Scope command surface. */
export function openImmutableGraphReadSessionSync(
  projectRoot: string,
  dbPath = resolve(projectRoot, ".mex", "graph.db"),
  options: OpenImmutableGraphReadSessionSyncOptions = {},
): InternalGraphReadSession {
  const canonicalDbPath = resolveContainedGraphDatabasePath(projectRoot, dbPath);
  if (!canonicalDbPath) {
    throw new GraphReadSessionError(
      "GRAPH_INDEX_READER_PATH_CHANGED",
      "The graph database path changed or escaped the project while immutable readers were opening.",
    );
  }
  let boundFile: BoundDatabaseFile | null = null;
  let databaseIdentityBefore: string;
  try {
    boundFile = bindDatabaseFile(canonicalDbPath, options.afterDatabaseDescriptorClose);
    databaseIdentityBefore = boundFile.identity;
  } catch {
    throw new GraphReadSessionError(
      "GRAPH_INDEX_READER_PATH_CHANGED",
      "The graph database became unavailable while immutable readers were opening.",
    );
  }
  const inspectSidecars = options.inspectSidecars ?? inspectGraphSidecars;

  let graph: GraphEngine | null = null;
  let pendingDb: SqliteDatabase | null = null;
  try {
    const sidecarsBeforeOpen = inspectSidecars(canonicalDbPath);
    if (sidecarsBeforeOpen.state !== "clear") {
      throw new GraphReadSessionError(
        "GRAPH_INDEX_READER_SIDECAR_ACTIVITY",
        sidecarMessage("before immutable readers opened", sidecarsBeforeOpen),
      );
    }
    pendingDb = openGraphDatabase(boundFile.databasePath, { readOnly: true, immutable: true });
    const sharedDb = pendingDb;
    graph = createGraphEngineFromOpenDatabase({ rootDir: projectRoot, dbPath: canonicalDbPath }, sharedDb);
    pendingDb = null;
    const validation = validateReadPath(
      projectRoot,
      dbPath,
      canonicalDbPath,
      databaseIdentityBefore,
      inspectSidecars,
    );
    if (!validation.valid) throw new GraphReadSessionError(validation.code!, validation.message!);

    const ownedGraph = graph;
    const ownedBoundFile = boundFile;
    graph = null;
    boundFile = null;
    let open = true;
    let sourceValidation: GraphReadValidation | null = null;
    const readIndexedSource = createIndexedSourceReader(
      projectRoot,
      sharedDb,
      {},
      (code, message) => {
        sourceValidation = { valid: false, code, message };
      },
    );
    return {
      graph: ownedGraph,
      db: sharedDb,
      readIndexedSource,
      validate: () => open
        ? sourceValidation
          ?? validateReadPath(projectRoot, dbPath, canonicalDbPath, databaseIdentityBefore, inspectSidecars)
        : {
            valid: false,
            code: "GRAPH_INDEX_READER_OPEN_FAILED",
            message: "The immutable graph reader is already closed.",
          },
      close: () => {
        if (!open) return;
        open = false;
        try {
          ownedGraph.close();
        } finally {
          ownedBoundFile.close();
        }
      },
    };
  } catch (error) {
    const classified = classifyOpenFailure(
      error,
      projectRoot,
      dbPath,
      canonicalDbPath,
      databaseIdentityBefore,
      inspectSidecars,
    );
    try {
      graph?.close();
      pendingDb?.close();
    } finally {
      boundFile?.close();
    }
    throw classified;
  }
}

/**
 * Open one stable immutable database snapshot without asserting source freshness.
 * Scope uses this so its deliberate stale-file text fallback stays available.
 */
export async function openImmutableGraphReadSession(
  projectRoot: string,
  dbPath = resolve(projectRoot, ".mex", "graph.db"),
  options: OpenImmutableGraphReadSessionOptions = {},
): Promise<InternalGraphReadSession> {
  const expected = options.expectedObservation;
  const canonicalDbPath = resolveContainedGraphDatabasePath(projectRoot, dbPath);
  if (!canonicalDbPath || (expected && canonicalDbPath !== expected.canonicalDbPath)) {
    throw new GraphReadSessionError(
      "GRAPH_INDEX_READER_PATH_CHANGED",
      "The graph database path changed or escaped the project while immutable readers were opening.",
    );
  }

  let boundFile: BoundDatabaseFile | null = null;
  let databaseIdentityBefore: string;
  try {
    boundFile = bindDatabaseFile(canonicalDbPath, options.afterDatabaseDescriptorClose);
    databaseIdentityBefore = boundFile.identity;
  } catch {
    throw new GraphReadSessionError(
      "GRAPH_INDEX_READER_PATH_CHANGED",
      "The graph database became unavailable while immutable readers were opening.",
    );
  }
  const inspectSidecars = options.inspectSidecars ?? inspectGraphSidecars;

  let graph: GraphEngine | null = null;
  let pendingDb: SqliteDatabase | null = null;
  try {
    if (expected && databaseIdentityBefore !== expected.databaseIdentity) {
      throw new GraphReadSessionError(
        "GRAPH_INDEX_READER_DATABASE_CHANGED",
        "The graph database changed after freshness inspection.",
      );
    }
    await options.afterDatabaseIdentityRead?.();
    const sidecarsBeforeOpen = inspectSidecars(canonicalDbPath);
    if (sidecarsBeforeOpen.state !== "clear") {
      throw new GraphReadSessionError(
        "GRAPH_INDEX_READER_SIDECAR_ACTIVITY",
        sidecarMessage("before immutable readers opened", sidecarsBeforeOpen),
      );
    }
    pendingDb = openGraphDatabase(boundFile.databasePath, { readOnly: true, immutable: true });
    await options.afterDatabaseOpen?.(pendingDb);
    const sharedDb = pendingDb;
    graph = createGraphEngineFromOpenDatabase({ rootDir: projectRoot, dbPath: canonicalDbPath }, sharedDb);
    pendingDb = null;

    if (!options.deferPostOpenValidation) {
      const validation = validateReadPath(
        projectRoot,
        dbPath,
        canonicalDbPath,
        databaseIdentityBefore,
        inspectSidecars,
      );
      if (!validation.valid) throw new GraphReadSessionError(validation.code!, validation.message!);
    }

    const ownedGraph = graph;
    const ownedBoundFile = boundFile;
    graph = null;
    boundFile = null;
    let open = true;
    let sourceValidation: GraphReadValidation | null = null;
    const readIndexedSource = createIndexedSourceReader(
      projectRoot,
      sharedDb,
      options,
      (code, message) => {
        sourceValidation = { valid: false, code, message };
      },
    );
    return {
      graph: ownedGraph,
      db: sharedDb,
      readIndexedSource,
      validate: () => open
        ? sourceValidation
          ?? validateReadPath(projectRoot, dbPath, canonicalDbPath, databaseIdentityBefore, inspectSidecars)
        : {
            valid: false,
            code: "GRAPH_INDEX_READER_OPEN_FAILED",
            message: "The immutable graph reader is already closed.",
          },
      close: () => {
        if (!open) return;
        open = false;
        try {
          ownedGraph.close();
        } finally {
          ownedBoundFile.close();
        }
      },
    };
  } catch (error) {
    const classified = classifyOpenFailure(
      error,
      projectRoot,
      dbPath,
      canonicalDbPath,
      databaseIdentityBefore,
      inspectSidecars,
    );
    try {
      graph?.close();
      pendingDb?.close();
    } finally {
      boundFile?.close();
    }
    throw classified;
  }
}

/**
 * Inspect freshness, bind readers to that exact observation, and expose a final
 * revalidation step for callers that buffer graph-derived output until commit.
 */
export async function loadFreshGraphReadSession(
  projectRoot: string,
  options: LoadFreshGraphReadSessionOptions = {},
): Promise<InternalFreshGraphReadResult> {
  const dbPath = options.dbPath ?? resolve(projectRoot, ".mex", "graph.db");
  const inspectObservation = options.inspectObservation ?? inspectGraphStatusWithFreshObservation;
  const inspection = await inspectObservation({ projectRoot, dbPath });
  await options.afterStatusInspection?.(inspection);
  const { graphStatus } = inspection;
  const degraded = graphStatus.status !== "fresh"
    && options.allowDegradedReads === true
    && (inspection.degradedObservation ?? null) !== null
      ? inspection.degradedObservation!
      : null;
  const degradations: readonly GraphReadDegradation[] = degraded?.degradations ?? [];
  const driftedSources: readonly string[] = degraded?.driftedSources ?? [];
  const configDriftTolerated = inspection.configDriftTolerated === true;
  const withTolerance = (result: InternalFreshGraphReadResult): InternalFreshGraphReadResult =>
    ({ ...result, configDriftTolerated });
  const freshObservation = degraded ? degraded.token : inspection.freshObservation;
  if ((graphStatus.status !== "fresh" && !degraded) || options.loadSession === false) {
    return withTolerance({ graphStatus, session: null });
  }
  if (!freshObservation || sha256(freshObservation.snapshotRaw) !== freshObservation.snapshotHash) {
    return withTolerance(unavailableFreshGraphReadResult(
      graphStatus,
      "GRAPH_INDEX_READER_SNAPSHOT_CHANGED",
      "The fresh graph observation could not be bound to an exact snapshot; graph reads were skipped.",
    ));
  }

  let base: InternalGraphReadSession | null = null;
  try {
    base = await openImmutableGraphReadSession(projectRoot, dbPath, {
      expectedObservation: freshObservation,
      inspectSidecars: options.inspectSidecars,
      deferPostOpenValidation: true,
      ...options.hooks,
    });
    const snapshotIdentity = readSessionSnapshotIdentity(base.db);
    const snapshot = snapshotIdentity.snapshot;
    const indexedFiles = base.graph.getIndexedFiles?.();
    if (snapshotIdentity.snapshotRaw !== freshObservation.snapshotRaw
      || snapshotIdentity.snapshotHash !== freshObservation.snapshotHash
      || !snapshot
      || !snapshotMatchesStatus(snapshot, graphStatus)
      || !indexedFiles
      || !snapshotMatchesIndexedFiles(snapshot, indexedFiles)) {
      base.close();
      return withTolerance(unavailableFreshGraphReadResult(
        graphStatus,
        "GRAPH_INDEX_READER_SNAPSHOT_CHANGED",
        "The graph snapshot changed while immutable readers were opening; graph reads were skipped.",
      ));
    }
    const openedValidation = base.validate();
    if (!openedValidation.valid) {
      base.close();
      return withTolerance(unavailableFreshGraphReadResult(
        graphStatus,
        openedValidation.code ?? "GRAPH_INDEX_READER_OPEN_FAILED",
        openedValidation.message
          ?? "The graph changed or became unavailable while immutable readers were opening.",
      ));
    }

    const guardedStatus: GraphStatus = { ...graphStatus, diagnostics: [...graphStatus.diagnostics] };
    const ownedBase = base;
    base = null;
    const session: InternalFreshGraphReadSession = {
      ...ownedBase,
      graphStatus: guardedStatus,
      degradations,
      driftedSources,
      validate: () => ownedBase.validate(),
      revalidateFreshness: async () => {
        const before = session.validate();
        // The bound observation already passed the structural audit. Handing
        // its identity back lets the final inspection skip re-auditing that
        // exact file while still re-proving sources, Git, snapshot and sidecars.
        const finalInspection = await inspectObservation({
          projectRoot,
          dbPath,
          auditedDatabase: {
            canonicalDbPath: freshObservation.canonicalDbPath,
            databaseIdentity: freshObservation.databaseIdentity,
          },
        });
        // Output is committed under the class it was labelled with. A store
        // that changed class mid-read — drifted while being read as fresh, or
        // repaired while being read as drifted — carries a label the buffered
        // records no longer earn, so the response is discarded rather than
        // relabelled after the fact.
        const finalDegraded = finalInspection.degradedObservation ?? null;
        const finalObservation = degradations.length > 0
          ? (finalDegraded
            && sameDegradations(finalDegraded.degradations, degradations)
            // A file that drifted after the answer was assembled would make a
            // returned fact describe a revision that no longer exists, so the
            // exact set has to hold for the whole read, not just its kinds.
            && sameStringSets(finalDegraded.driftedSources, driftedSources)
              ? finalDegraded.token
              : null)
          : finalInspection.graphStatus.status === "fresh"
            ? finalInspection.freshObservation
            : null;
        if (!finalObservation) {
          return { valid: false, graphStatus: finalInspection.graphStatus };
        }
        if (!sameObservation(freshObservation, finalObservation)) {
          const changed = unavailableStatus(
            finalInspection.graphStatus,
            "GRAPH_INDEX_READER_SNAPSHOT_CHANGED",
            "Graph freshness changed while graph-derived output was being prepared; the output was discarded.",
          );
          return {
            valid: false,
            code: "GRAPH_INDEX_READER_SNAPSHOT_CHANGED",
            message: changed.diagnostics.at(-1)?.message,
            graphStatus: changed,
          };
        }
        if (!before.valid) return { ...before, graphStatus: finalInspection.graphStatus };
        const after = session.validate();
        return after.valid
          ? { valid: true, graphStatus: finalInspection.graphStatus }
          : { ...after, graphStatus: guardedStatus };
      },
    };
    return withTolerance({ graphStatus: guardedStatus, session });
  } catch (error) {
    base?.close();
    const coded = graphReadError(error);
    return withTolerance(unavailableFreshGraphReadResult(graphStatus, coded.code, coded.message));
  }
}

function createIndexedSourceReader(
  projectRoot: string,
  db: SqliteDatabase,
  hooks: Pick<ImmutableGraphReadHooks, "beforeIndexedSourceRead" | "afterIndexedSourceRead">,
  invalidate: (code: string, message: string) => void,
): (filePath: string) => string {
  const cache = new Map<string, string>();
  return (filePath: string): string => {
    const cached = cache.get(filePath);
    if (cached !== undefined) return cached;
    try {
      const indexed = db.prepare(
        "SELECT content_hash FROM files WHERE path = ?",
      ).get(filePath) as { content_hash?: unknown } | undefined;
      if (typeof indexed?.content_hash !== "string" || !/^[0-9a-f]{64}$/.test(indexed.content_hash)) {
        const code = "GRAPH_INDEX_READER_SOURCE_READ_FAILED";
        const message = "An indexed source record could not be verified; graph-derived source output was discarded.";
        invalidate(code, message);
        throw new GraphReadSessionError(
          code,
          message,
        );
      }
      hooks.beforeIndexedSourceRead?.(filePath);
      const bytes = readStableContainedSource(projectRoot, filePath);
      hooks.afterIndexedSourceRead?.(filePath);
      // Indexing and status both hash the once-decoded UTF-8 source string.
      // Keep that parity for invalid byte sequences while still binding the
      // returned text to this one exact, fd-stable buffer.
      const source = bytes.toString("utf8");
      if (sha256(source) !== indexed.content_hash) {
        invalidate(
          "GRAPH_SOURCE_CORPUS_MISMATCH",
          "Source bytes no longer match the graph snapshot; graph-derived source output was discarded.",
        );
      }
      cache.set(filePath, source);
      return source;
    } catch (error) {
      if (error instanceof GraphReadSessionError) throw error;
      const code = "GRAPH_INDEX_READER_SOURCE_READ_FAILED";
      const message = "An indexed source file could not be read from a stable contained path; graph-derived source output was discarded.";
      invalidate(code, message);
      throw new GraphReadSessionError(
        code,
        message,
      );
    }
  };
}

/** Read one exact byte buffer through a contained, identity-stable file descriptor. */
function readStableContainedSource(projectRoot: string, filePath: string): Buffer {
  const lexicalRoot = resolve(projectRoot);
  const canonicalRoot = resolveRealPath(lexicalRoot);
  const absolutePath = resolve(lexicalRoot, filePath);
  if (!isContainedPath(lexicalRoot, absolutePath)) {
    throw new Error("Indexed source path escapes the project root.");
  }
  const canonicalPath = resolveRealPath(absolutePath);
  if (!isContainedPath(canonicalRoot, canonicalPath)) {
    throw new Error("Indexed source target escapes the project root.");
  }
  const before = lstatSync(canonicalPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Indexed source target is not a stable regular file.");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const fd = openSync(canonicalPath, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error("Indexed source changed before it could be opened.");
    }
    if (!Number.isSafeInteger(opened.size)
      || opened.size < 0
      || opened.size > GRAPH_CORPUS_LIMITS.maxSourceFileBytes) {
      throw new GraphCorpusLimitError("maxSourceFileBytes");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const resolvedAfter = resolveRealPath(absolutePath);
    const pathAfter = lstatSync(resolvedAfter);
    if (!sameFileIdentity(opened, after)
      || !isSameResolvedPath(resolvedAfter, canonicalPath)
      || !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || !sameFileIdentity(opened, pathAfter)) {
      throw new Error("Indexed source changed while it was being read.");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sameFileIdentity(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function validateReadPath(
  projectRoot: string,
  requestedDbPath: string,
  canonicalDbPath: string,
  expectedIdentity: string,
  inspectSidecars: typeof inspectGraphSidecars,
): GraphReadValidation {
  try {
    if (resolveContainedGraphDatabasePath(projectRoot, requestedDbPath) !== canonicalDbPath) {
      return {
        valid: false,
        code: "GRAPH_INDEX_READER_PATH_CHANGED",
        message: "The graph database path changed while graph-derived output was being prepared.",
      };
    }
    const sidecars = inspectSidecars(canonicalDbPath);
    if (sidecars.state !== "clear") {
      return {
        valid: false,
        code: "GRAPH_INDEX_READER_SIDECAR_ACTIVITY",
        message: sidecarMessage("while graph-derived output was being prepared", sidecars),
      };
    }
    if (readDatabaseIdentity(canonicalDbPath) !== expectedIdentity) {
      return {
        valid: false,
        code: "GRAPH_INDEX_READER_DATABASE_CHANGED",
        message: "The graph database changed while graph-derived output was being prepared.",
      };
    }
    return { valid: true };
  } catch {
    return {
      valid: false,
      code: "GRAPH_INDEX_READER_DATABASE_CHANGED",
      message: "The graph database changed or became unavailable while graph-derived output was being prepared.",
    };
  }
}

function graphReadError(error: unknown): { code: string; message: string } {
  if (error instanceof GraphReadSessionError) return error;
  return {
    code: "GRAPH_INDEX_READER_OPEN_FAILED",
    message: "The graph changed or became unavailable while immutable readers were opening.",
  };
}

function classifyOpenFailure(
  error: unknown,
  projectRoot: string,
  requestedDbPath: string,
  canonicalDbPath: string,
  expectedIdentity: string,
  inspectSidecars: typeof inspectGraphSidecars,
): GraphReadSessionError {
  if (error instanceof GraphReadSessionError) return error;
  const validation = validateReadPath(
    projectRoot,
    requestedDbPath,
    canonicalDbPath,
    expectedIdentity,
    inspectSidecars,
  );
  if (!validation.valid) {
    return new GraphReadSessionError(validation.code!, validation.message!);
  }
  return new GraphReadSessionError(
    "GRAPH_INDEX_READER_OPEN_FAILED",
    "The graph changed or became unavailable while immutable readers were opening.",
  );
}

function readDatabaseIdentity(dbPath: string): string {
  const stats = statSync(dbPath);
  return databaseFileIdentity(stats);
}

/**
 * Bind SQLite to the exact inode that was inspected, not merely its pathname.
 * On POSIX, opening `/dev/fd/<n>` (or `/proc/self/fd/<n>`) gives SQLite another
 * handle to that same file even if `graph.db` is atomically replaced in the
 * meantime. Windows does not expose descriptor paths, but its open handles
 * prevent the rename-away/restore ABA that this binding closes on POSIX.
 */
function bindDatabaseFile(dbPath: string, afterClose?: () => void): BoundDatabaseFile {
  const before = lstatSync(dbPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Graph database is not a stable regular file.");
  }
  if (!Number.isSafeInteger(before.size)
    || before.size < 0
    || before.size > GRAPH_CORPUS_LIMITS.maxIndexBytes) {
    throw new GraphCorpusLimitError("maxIndexBytes");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const fd = openSync(dbPath, constants.O_RDONLY | noFollow);
  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    try {
      closeSync(fd);
    } finally {
      try {
        afterClose?.();
      } catch {
        // Test-only observation must never compromise descriptor cleanup.
      }
    }
  };
  try {
    const opened = fstatSync(fd);
    const resolvedAfter = resolveRealPath(dbPath);
    const pathAfter = lstatSync(resolvedAfter);
    if (!opened.isFile()
      || !isSameResolvedPath(resolvedAfter, dbPath)
      || !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || !sameFileIdentity(before, opened)
      || !sameFileIdentity(opened, pathAfter)) {
      throw new Error("Graph database changed before it could be bound.");
    }
    if (!Number.isSafeInteger(opened.size)
      || opened.size < 0
      || opened.size > GRAPH_CORPUS_LIMITS.maxIndexBytes) {
      throw new GraphCorpusLimitError("maxIndexBytes");
    }
    return {
      databasePath: descriptorDatabasePath(fd, dbPath),
      identity: databaseFileIdentity(opened),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

function descriptorDatabasePath(fd: number, fallbackPath: string): string {
  if (process.platform === "win32") return fallbackPath;
  for (const prefix of ["/dev/fd", "/proc/self/fd"]) {
    const candidate = `${prefix}/${fd}`;
    try {
      statSync(candidate);
      return candidate;
    } catch {
      // Try the next platform descriptor namespace.
    }
  }
  throw new Error("This platform cannot bind SQLite to an inspected file descriptor.");
}

function databaseFileIdentity(
  stats: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
): string {
  return JSON.stringify([stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs]);
}

function readSessionSnapshotIdentity(db: SqliteDatabase): {
  snapshotRaw: string | null;
  snapshotHash: string | null;
  snapshot: GraphSnapshot | null;
} {
  const row = db.prepare(
    `SELECT CASE
       WHEN typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= ? THEN value
       ELSE NULL END AS value
     FROM project_metadata WHERE key = ?`,
  ).get(
    GRAPH_CORPUS_LIMITS.maxSnapshotMetadataBytes,
    GRAPH_SNAPSHOT_METADATA_KEY,
  ) as { value?: unknown } | undefined;
  const snapshotRaw = typeof row?.value === "string" ? row.value : null;
  return {
    snapshotRaw,
    snapshotHash: snapshotRaw === null ? null : sha256(snapshotRaw),
    snapshot: parseGraphSnapshot(snapshotRaw),
  };
}

function snapshotMatchesStatus(snapshot: GraphSnapshot, status: GraphStatus): boolean {
  return snapshot.indexedAt === status.indexedAt
    && snapshot.lastSuccessfulIndexAt === status.lastSuccessfulIndexAt
    && snapshot.indexedBranch === status.indexedBranch
    && snapshot.indexedHead === status.indexedHead
    && snapshot.schemaVersion === status.schemaVersion
    && snapshot.extractorVersion === status.extractorVersion
    && snapshot.grammarHash === status.grammarVersion
    && snapshot.parseHealth.total === status.parseHealth.total
    && snapshot.parseHealth.ok === status.parseHealth.ok
    && snapshot.parseHealth.partial === status.parseHealth.partial
    && snapshot.parseHealth.failed === status.parseHealth.failed;
}

function snapshotMatchesIndexedFiles(
  snapshot: GraphSnapshot,
  files: readonly IndexedFileInfo[],
): boolean {
  if (snapshot.sourceCount !== files.length
    || snapshot.sourceCorpusDigest !== computeSourceCorpusDigest(files)) return false;
  let ok = 0;
  let partial = 0;
  let failed = 0;
  for (const file of files) {
    if (file.parseStatus === "ok") ok += 1;
    else if (file.parseStatus === "partial") partial += 1;
    else failed += 1;
  }
  return snapshot.parseHealth.total === files.length
    && snapshot.parseHealth.ok === ok
    && snapshot.parseHealth.partial === partial
    && snapshot.parseHealth.failed === failed;
}

/** Order-independent equality; the producer sorts, this must not depend on it. */
function sameDegradations(
  left: readonly GraphReadDegradation[],
  right: readonly GraphReadDegradation[],
): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function sameStringSets(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function sameObservation(
  left: InternalGraphFreshObservationToken,
  right: InternalGraphFreshObservationToken,
): boolean {
  return left.canonicalDbPath === right.canonicalDbPath
    && left.databaseIdentity === right.databaseIdentity
    && left.snapshotRaw === right.snapshotRaw
    && left.snapshotHash === right.snapshotHash;
}

function unavailableFreshGraphReadResult(
  status: GraphStatus,
  code: string,
  message: string,
): InternalFreshGraphReadResult {
  return { graphStatus: unavailableStatus(status, code, message), session: null };
}

function unavailableStatus(status: GraphStatus, code: string, message: string): GraphStatus {
  return {
    ...status,
    status: "degraded",
    diagnostics: [
      ...status.diagnostics,
      {
        code,
        severity: "warning",
        message,
        remediation: [{ label: "Retry after graph maintenance finishes" }],
      },
    ],
  };
}

function sidecarMessage(when: string, probe: GraphSidecarProbe): string {
  const paths = probe.paths.length > 0 ? ` (${probe.paths.join(", ")})` : "";
  return probe.state === "active"
    ? `SQLite recovery activity was detected ${when}${paths}; graph reads were skipped.`
    : `SQLite recovery state could not be verified ${when}${paths}; graph reads were skipped.`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
