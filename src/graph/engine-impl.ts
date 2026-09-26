import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isSameResolvedPath, toPosix } from "../paths.js";
import type {
  BuildResult, DeclinedCompilerInput, GraphEngine, GraphPublicationReport, NodeSearchOptions, SkippedSourceFile,
} from "./engine.js";
import {
  GRAPH_CONFIG_GLOBS,
  GRAPH_CORPUS_GLOB_OPTIONS,
  graphCorpusIgnoreGlobs,
  GRAPH_CORPUS_LIMITS,
  graphCorpusPolicyHash,
  GRAPH_SUPPORTED_SOURCE_GLOB,
  GraphCorpusLimitError,
  addGraphCompilerSourceBytes,
  addGraphCorpusBytes,
  addGraphSemanticInput,
  createGraphSemanticInputLedger,
  discoverBoundedGraphPaths,
  isPerFileCorpusLimitError,
} from "./corpus-policy.js";
import { graphConfigIdentity } from "./config-identity.js";
import { captureGraphCoverage, GRAPH_COVERAGE_METADATA_KEY } from "./coverage.js";
import { DB_SCHEMA_VERSION, markGraphReady, openGraphDatabase } from "./db/database.js";
import {
  GraphStore,
  type FileRecord,
  type ImportBindingRecord,
  type NodeAliasRecord,
  type UnresolvedRefRecord,
} from "./db/store.js";
import type { SqliteDatabase } from "./db/sqlite.js";
import {
  buildTypeScriptExtraction,
  canonicalNodeIdentity,
  CompilerIncrementalFallback,
  detectLanguage,
  extractFile,
  grammarManifestHash,
  isSupportedSourceFile,
  loadGrammars,
  normalizedAstTokens,
  normalizedCompilerTokens,
  TYPESCRIPT_COMPILER_EXTRACTOR_VERSION,
  TYPESCRIPT_COMPILER_VERSION,
  type CompilerExtractedNode,
  type CompilerExtractionOptions,
  type CompilerIncrementalInput,
  type CompilerExtractionResult,
  type CompilerFileExtraction,
  type CompilerSemanticInput,
  type CompilerStagedInput,
} from "./extraction/index.js";
import { FingerprintStore, upsertFingerprintsInOwnedTransaction } from "./fingerprint-store.js";
import { createFingerprintBuilder, decodeMinhash } from "./fingerprint.js";
import { MIN_TOKENS } from "./config.js";
import { minhashJaccard } from "./reconcile-engine.js";
import type { Fingerprint } from "./reconcile.js";
import {
  applyRowDelta,
  groupRowsByFile,
  INCREMENTAL_STATE_METADATA_KEY,
  incrementalStateIsCurrent,
  incrementalStateMarker,
  planRowDelta,
  type FileRowGroups,
  type RowDelta,
} from "./publication-delta.js";
import {
  encodeCachedExtraction,
  extractionCacheIdentity,
  planIncrementalExtraction,
  type CachedTreeFile,
  type IncrementalExtractionPlan,
  type StoredExtraction,
} from "./extraction-cache.js";
import { createStagedResolutionContext } from "./resolution/context.js";
import { FRAMEWORK_RESOLVERS } from "./resolution/frameworks/index.js";
import { resolveReferences } from "./resolution/resolver.js";
import {
  GRAPH_SNAPSHOT_METADATA_KEY,
  GRAPH_SNAPSHOT_MAX_SEMANTIC_INPUTS,
  createGraphSnapshot,
  parseGraphSnapshot,
  readGraphGitProvenance,
  serializeGraphSnapshot,
  type GraphGitProvenance,
  type GraphSnapshot,
  type GraphSnapshotSemanticInput,
} from "./snapshot.js";
import { getCallees, getCallers, getIncoming, getOutgoing } from "./traversal/traversal.js";
import { recordGraphPhase, timeGraphPhase, timeGraphPhaseAsync } from "./phase-timing.js";
import type { GraphEdge, GraphNode, Language, ReferenceKind } from "./types.js";

const BODY_KINDS = new Set<GraphNode["kind"]>([
  "function", "method", "class", "interface", "enum", "type_alias", "struct",
  "trait", "protocol", "constant", "variable", "component",
]);

const COMPILER_LANGUAGES = new Set<Language>(["typescript", "javascript", "tsx", "jsx"]);
const RESOLVER_VERSION = "compiler-first-v2";
const TREE_SITTER_EXTRACTOR_VERSION = "tree-sitter-v2";
const CORPUS_EXTRACTOR_VERSION = `${TYPESCRIPT_COMPILER_EXTRACTOR_VERSION}+${TREE_SITTER_EXTRACTOR_VERSION}`;

export interface GraphEngineOptions {
  rootDir: string;
  dbPath?: string;
  /** Query-only engine for sandboxed agent commands. Build/sync are unavailable. */
  readOnly?: boolean;
  /** Injectable source-file access for embedders and deterministic fault tests. */
  sourceFileAccess?: Partial<GraphSourceFileAccess>;
  /** Compiler extraction knobs (semantic diagnostics, program-crash fault tests). */
  compilerExtraction?: CompilerExtractionOptions;
}

interface GraphEngineInternalHooks {
  /** Parent-owned workspace for cleanup after a candidate process aborts. */
  sourceSpoolDirectory?: string;
  /** Numeric construction progress; never carries source paths or content. */
  onBuildProgress?: (progress: {
    phase: "parse" | "resolve";
    completed?: number;
    total?: number;
  }) => void;
  afterSemanticInputsStaged?: () => void;
  afterCompilerExtraction?: () => void;
  afterFinalSemanticInputRead?: (path: string) => void;
  /** Final path/cancellation seam immediately before SQLite opens or creates the database. */
  beforeDatabaseOpen?: () => void;
  /** Final cancellation/fault seam before any publication continuity reads. */
  beforePublication?: () => void;
}

/**
 * How `sync` rebuilds a stale graph. `full` re-stages the whole corpus, the
 * behaviour every sync had before incremental refresh; it stays reachable as
 * the convergence oracle for tests and as the fallback.
 */
export type GraphRefreshStrategy = "incremental" | "full";

interface GraphEngineInternalOptions {
  /** Deliberately absent from GraphEngineOptions and generated declarations. */
  __internalGraphEngineHooks?: GraphEngineInternalHooks;
  __internalRefreshStrategy?: GraphRefreshStrategy;
  immutable?: boolean;
}

export interface GraphSourceFileAccess {
  stat(absolutePath: string): { size: number; mtimeMs: number };
  read(absolutePath: string): string;
}

export interface GraphSourceStagingFailure {
  filePath: string;
  operation: "stat" | "read" | "discover" | "parse";
  code?: string;
  message: string;
}

/** A structural sync never publishes a corpus whose source discovery was incomplete. */
export class GraphSourceStagingError extends Error {
  readonly code = "GRAPH_SOURCE_STAGING_FAILED";
  readonly failures: GraphSourceStagingFailure[];

  constructor(failures: GraphSourceStagingFailure[]) {
    const boundedFailures = failures.slice(0, GRAPH_CORPUS_LIMITS.maxDiagnostics);
    const omitted = failures.length - boundedFailures.length;
    super(`Could not stage ${failures.length} source file(s): ${boundedFailures.map((failure) => failure.filePath).join(", ")}${omitted > 0 ? ` (${omitted} more omitted)` : ""}`);
    this.name = "GraphSourceStagingError";
    this.failures = boundedFailures;
  }
}

/**
 * Immutable, process-private source staging on disk.
 *
 * Tree-sitter languages are read and extracted one file at a time from this
 * spool. TypeScript/JavaScript sources are loaded only for the compiler's
 * separately bounded semantic batch. The complete repository corpus is never
 * retained as strings in the maintenance process.
 */
class GraphSourceSpool {
  private readonly directory: string;
  private readonly entries = new Map<string, string>();
  private disposed = false;

  constructor(parentDirectory = tmpdir()) {
    this.directory = mkdtempSync(join(parentDirectory, "mex-graph-stage-"));
  }

  stage(relPath: string, source: string): void {
    if (this.disposed) throw new Error("The graph source spool is closed.");
    if (this.entries.has(relPath)) throw new Error(`Duplicate staged source: ${relPath}`);
    const stagedPath = join(this.directory, `${String(this.entries.size).padStart(8, "0")}.source`);
    writeFileSync(stagedPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
    this.entries.set(relPath, stagedPath);
  }

  read(file: DiscoveredFile): string {
    const stagedPath = this.entries.get(file.relPath);
    if (this.disposed || !stagedPath) {
      throw new GraphSourceStagingError([{
        filePath: file.relPath,
        operation: "read",
        message: "The immutable graph source spool is unavailable.",
      }]);
    }
    let fd: number | null = null;
    try {
      const before = lstatSync(stagedPath);
      if (!before.isFile()
        || before.isSymbolicLink()
        || !Number.isSafeInteger(before.size)
        || before.size < 0
        || before.size > GRAPH_CORPUS_LIMITS.maxSourceFileBytes) {
        throw new Error("The immutable staged source is not a bounded regular file.");
      }
      const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
      fd = openSync(stagedPath, constants.O_RDONLY | noFollow);
      const opened = fstatSync(fd);
      if (!opened.isFile() || !sameFileIdentity(before, opened)) {
        throw new Error("The immutable staged source changed before it could be opened.");
      }
      const source = readFileSync(fd, "utf8");
      const after = fstatSync(fd);
      const pathAfter = lstatSync(stagedPath);
      if (!sameFileIdentity(opened, after)
        || !pathAfter.isFile()
        || pathAfter.isSymbolicLink()
        || !sameFileIdentity(opened, pathAfter)) {
        throw new Error("The immutable staged source changed while it was being read.");
      }
      const bytes = Buffer.byteLength(source, "utf8");
      if (bytes > GRAPH_CORPUS_LIMITS.maxSourceFileBytes || sha256(source) !== file.contentHash) {
        throw new Error("The immutable staged source failed its content check.");
      }
      return source;
    } catch (error) {
      if (error instanceof GraphSourceStagingError) throw error;
      throw new GraphSourceStagingError([sourceStagingFailure(file.relPath, "read", error)]);
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      rmSync(this.directory, { recursive: true, force: true });
    } catch {
      // Cleanup must not replace the result/error from the explicit graph job.
    }
    this.entries.clear();
  }
}

const NODE_SOURCE_FILE_ACCESS: GraphSourceFileAccess = {
  stat: (absolutePath) => statSync(absolutePath),
  read: (absolutePath) => readFileSync(absolutePath, "utf-8"),
};

interface DiscoveredFile {
  relPath: string;
  contentHash: string;
  size: number;
  modifiedAt: number;
}

type GraphSkippedSourceFile = SkippedSourceFile;

/** A corpus discovered into its spool before staging begins. */
interface PreparedCorpus {
  sourceSpool: GraphSourceSpool;
  corpus: DiscoveredCorpus;
}

/** What one source walk found: the corpus, and what it declined to read. */
interface DiscoveredCorpus {
  files: DiscoveredFile[];
  skipped: GraphSkippedSourceFile[];
}

interface StagedFile {
  discovered: DiscoveredFile;
  record: FileRecord;
  nodes: GraphNode[];
  edges: GraphEdge[];
  references: UnresolvedRefRecord[];
  imports: ImportBindingRecord[];
  compilerNodes?: CompilerExtractedNode[];
}

interface StagedCorpus {
  files: StagedFile[];
  /** Files discovered but not indexed, carried through to the build result. */
  skipped: GraphSkippedSourceFile[];
  /** Config inputs the containment policy declined during compiler extraction. */
  declinedInputs: DeclinedCompilerInput[];
  compiler: Pick<CompilerExtractionResult, "compilerVersion" | "semanticInputs">;
  semanticInputs: CompilerSemanticInput[];
  fingerprints: Array<{ nodeId: string; fingerprint: Fingerprint }>;
  manifestHash: string;
  configHash: string;
  grammarHash: string;
  sourceSpool: GraphSourceSpool;
  extraction: StagedExtraction;
}

/** How staging extracted the corpus, and the cache it leaves for the next refresh. */
interface StagedExtraction {
  mode: "incremental" | "full";
  fallbackReason?: string;
  filesReextracted: number;
  cache: ExtractionCacheState;
}

/** The extraction cache a publication writes: one entry per staged file. */
interface ExtractionCacheState {
  identity: string;
  projectStates: Record<string, string>;
  entries: Array<{ path: string; contentHash: string; payload: Uint8Array; changed: boolean }>;
}

/** What a refresh may reuse from the stored graph (issue #209). */
interface ExtractionReuse {
  identity: string | null;
  stored: Map<string, StoredExtraction>;
  projectStates: Record<string, string>;
  /** Stored fingerprint sketches by node id; neighbours are always recomputed. */
  fingerprints: ReadonlyMap<string, Pick<Fingerprint, "minhash" | "tokenCount">>;
  /** Stored file records, to know which files' sketches still hold. */
  records: ReadonlyMap<string, FileRecord>;
}

const EXTRACTION_CACHE_IDENTITY_KEY = "extraction_cache_identity";
const EXTRACTION_PROJECT_STATES_KEY = "extraction_project_states";

export interface GraphManifest {
  manifestHash: string;
  configHash: string;
  grammarHash: string;
  /**
   * The exact inputs `manifestHash` was folded from.
   *
   * Kept alongside the hash so a reader can ask which *class* of input moved
   * rather than only whether the fold changed. Config content is a build input
   * that may shift under a usable index; the remaining entries are engine
   * identity, and a difference in any of them means the store was written by
   * code that no longer exists here.
   */
  inputs: GraphManifestInputs;
}

/** One fixed key order; the serialized form is the manifest hash preimage. */
export interface GraphManifestInputs {
  db: number;
  compiler: string;
  extractor: string;
  resolver: string;
  corpusPolicyHash: string;
  grammarHash: string;
  configHash: string;
}

class GraphEngineImpl implements GraphEngine {
  private readonly rootDir: string;
  private readonly dbPath: string;
  private readonly readOnly: boolean;
  private readonly immutable: boolean;
  private readonly sourceFileAccess: GraphSourceFileAccess;
  private readonly internal: GraphEngineInternalHooks;
  private readonly compilerExtraction?: CompilerExtractionOptions;
  private readonly refreshStrategy: GraphRefreshStrategy;
  private db: SqliteDatabase | null = null;
  private store: GraphStore | null = null;

  constructor(options: GraphEngineOptions & GraphEngineInternalOptions, database?: SqliteDatabase) {
    if (options.immutable && options.readOnly !== true) {
      throw new TypeError("Immutable graph access requires readOnly: true.");
    }
    if (database && (options.readOnly !== true || options.immutable !== true)) {
      throw new TypeError("An adopted graph database must be an immutable read-only connection.");
    }
    this.rootDir = resolve(options.rootDir);
    this.dbPath = options.dbPath ?? resolve(this.rootDir, ".mex", "graph.db");
    this.readOnly = options.readOnly ?? false;
    this.immutable = options.immutable ?? false;
    this.sourceFileAccess = options.sourceFileAccess
      ? { ...NODE_SOURCE_FILE_ACCESS, ...options.sourceFileAccess }
      : NODE_SOURCE_FILE_ACCESS;
    this.internal = (options as GraphEngineOptions & GraphEngineInternalOptions)
      .__internalGraphEngineHooks ?? {};
    this.compilerExtraction = options.compilerExtraction;
    this.refreshStrategy = options.__internalRefreshStrategy ?? "incremental";
    if (database) {
      this.db = database;
      this.store = new GraphStore(database);
    }
  }

  private getStore(allowRebuild = false): GraphStore {
    if (!this.store) {
      this.internal.beforeDatabaseOpen?.();
      this.db = openGraphDatabase(this.dbPath, {
        allowRebuild,
        readOnly: this.readOnly,
        immutable: this.immutable,
      });
      this.store = new GraphStore(this.db);
    }
    return this.store;
  }

  async build(rootDir?: string): Promise<BuildResult> {
    if (this.readOnly) throw new Error("A read-only graph engine cannot build an index.");
    const started = Date.now();
    const root = rootDir ? resolve(rootDir) : this.rootDir;
    const gitBeforeStaging = readGraphGitProvenance(root);
    const manifest = graphManifest(root);
    const staged = await stageCorpus(
      root,
      manifest,
      this.sourceFileAccess,
      this.internal,
      this.compilerExtraction,
      { reason: "a rebuild extracts in full" },
    );
    try {
      this.assertNoNewParseFailures(staged);
      const { publication: _publication, ...result } = this.publish(staged, root, gitBeforeStaging, false);
      return { ...result, durationMs: Date.now() - started };
    } finally {
      staged.sourceSpool.dispose();
    }
  }

  async sync(changedFiles: string[]): Promise<BuildResult> {
    if (this.readOnly) throw new Error("A read-only graph engine cannot synchronize an index.");
    const started = Date.now();
    const changed = [...new Set(changedFiles.map((file) =>
      toPosix(relative(this.rootDir, resolve(this.rootDir, file))),
    ).filter((file) => file && !file.startsWith("..")))].sort();
    const changedSources = changed.filter(isSupportedSourceFile);
    const deletedChangedSources = inspectChangedSources(this.rootDir, changedSources, this.sourceFileAccess);
    const gitBeforeStaging = timeGraphPhase("sync.git", () => readGraphGitProvenance(this.rootDir));
    const manifest = timeGraphPhase("sync.manifest", () => graphManifest(this.rootDir));
    const store = this.getStore(true);
    // One discovery serves both the unchanged check and staging (issue #209):
    // the corpus is read, hashed and spooled once, and the check compares the
    // very bytes that would be staged.
    const sourceSpool = new GraphSourceSpool(this.internal.sourceSpoolDirectory);
    let prepared: PreparedCorpus | undefined;
    try {
      const corpus = timeGraphPhase("sync.discover", () =>
        discoverSourceFiles(this.rootDir, this.sourceFileAccess, sourceSpool));
      if (changedSources.length === 0) {
        const unchanged = unchangedGraphSnapshot(this.rootDir, store, gitBeforeStaging, manifest, corpus.files);
        if (unchanged) {
          timeGraphPhase("sync.coverage", () => this.recordUnchangedRefresh(store, unchanged, gitBeforeStaging));
          return { filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: Date.now() - started };
        }
      }
      prepared = { sourceSpool, corpus };
    } finally {
      if (!prepared) sourceSpool.dispose();
    }

    // Stage the whole semantic corpus: every file's extraction, re-extracted or
    // reused from the cache (issue #209), then resolution over all of it. This
    // makes an arbitrary sync sequence converge to the same graph as a clean
    // build and re-resolves cross-file refs.
    const reuse = this.refreshStrategy === "full"
      ? { reason: "the full-restage strategy was requested" }
      : timeGraphPhase("stage.loadCache", () => loadExtractionReuse(store, this.rootDir));
    const staged = await timeGraphPhaseAsync("stage.total", () => stageCorpus(
      this.rootDir,
      manifest,
      this.sourceFileAccess,
      this.internal,
      this.compilerExtraction,
      reuse,
      prepared,
    ));
    try {
      const stagedByPath = new Map(staged.files.map((file) => [file.record.path, file]));
      // A file the corpus policy deliberately skipped is absent from the
      // staged corpus by design, so it is not evidence of a lost source.
      const skippedPaths = new Set(staged.skipped.map((file) => file.filePath));
      const unstagedExisting = changedSources.filter((file) => (
        !deletedChangedSources.has(file)
        && !stagedByPath.has(file)
        && !skippedPaths.has(file)
      ));
      if (unstagedExisting.length > 0) {
        throw new GraphSourceStagingError(unstagedExisting.map((filePath) => ({
          filePath,
          operation: "discover",
          message: "The changed source still exists but was absent from the staged corpus.",
        })));
      }
      this.assertNoNewParseFailures(staged);
      const previousFiles = new Map(this.getStore(true).getAllFileRecords()
        .map((file) => [file.path, file.contentHash]));
      const filesChanged = staged.files.filter((file) => previousFiles.get(file.record.path) !== file.record.contentHash)
        .length + [...previousFiles.keys()].filter((path) => !stagedByPath.has(path)).length;
      const { publication, ...result } = timeGraphPhase("publish.total", () => this.publish(
        staged,
        this.rootDir,
        gitBeforeStaging,
        this.refreshStrategy === "incremental",
      ));
      return {
        ...result,
        refresh: {
          mode: staged.extraction.mode,
          ...(staged.extraction.fallbackReason ? { fallbackReason: staged.extraction.fallbackReason } : {}),
          filesChanged,
          filesReextracted: staged.extraction.filesReextracted,
          ...publication,
        },
        durationMs: Date.now() - started,
      };
    } finally {
      staged.sourceSpool.dispose();
    }
  }

  /**
   * A refresh that changes no graph fact still records what it observed: the
   * coverage, and HEAD when the commits since the snapshot touched no indexed
   * file (issue #209: the snapshot used to keep the older head while status
   * reported fresh).
   */
  private recordUnchangedRefresh(store: GraphStore, snapshot: GraphSnapshot, git: GraphGitProvenance): void {
    const coverage = captureGraphCoverage(this.rootDir);
    const advanceHead = snapshot.indexedHead !== git.head
      // Never record a head that moved while this refresh ran.
      && readGraphGitProvenance(this.rootDir).head === git.head;
    store.transaction(() => {
      store.setMetadata(GRAPH_COVERAGE_METADATA_KEY, coverage);
      if (!advanceHead) return;
      const incrementalStateCurrent = incrementalStateIsCurrent(store);
      const now = new Date().toISOString();
      const serialized = serializeGraphSnapshot({
        ...snapshot, indexedHead: git.head, indexedAt: now, lastSuccessfulIndexAt: now,
      });
      store.setMetadata(GRAPH_SNAPSHOT_METADATA_KEY, serialized);
      if (incrementalStateCurrent) store.setMetadata(INCREMENTAL_STATE_METADATA_KEY, incrementalStateMarker(serialized));
    });
  }

  private assertNoNewParseFailures(staged: StagedCorpus): void {
    const store = this.getStore(true);
    const previousFiles = store.getAllFileRecords();
    if (previousFiles.length === 0) return;
    const previous = new Map(previousFiles.map((file) => [file.path, file.parseStatus ?? "ok"]));
    const newlyFailed = staged.files.filter((file) => (
      file.record.parseStatus === "failed" && previous.get(file.record.path) !== "failed"
    ));
    if (newlyFailed.length === 0) return;
    throw new GraphSourceStagingError(newlyFailed.map((file) => ({
      filePath: file.record.path,
      operation: "parse",
      code: "GRAPH_SOURCE_PARSE_FAILED",
      message: "The source no longer parses; the last trustworthy graph snapshot was preserved.",
    })));
  }

  private publish(
    staged: StagedCorpus,
    root: string,
    gitBeforeStaging: GraphGitProvenance,
    allowDelta: boolean,
  ): Omit<BuildResult, "durationMs"> & { publication: GraphPublicationReport } {
    this.internal.beforePublication?.();
    const store = this.getStore(true);
    const freshNodes = staged.files.flatMap((file) => file.nodes);
    // Incremental publication (issue #209): rewrite only the files whose
    // owned rows changed. Any reason it cannot is a full publication, which
    // also records the digests the next refresh compares against.
    const grouped = timeGraphPhase("publish.rowGroups", () => groupRowsByFile(staged.files, staged.fingerprints));
    const planned = !allowDelta ? { reason: "a full publication was requested" }
      : "reason" in grouped ? grouped
      : timeGraphPhase("publish.deltaPlan", () => planRowDelta(store, this.db!, grouped));
    const delta = "reason" in planned ? undefined : planned;
    const continuity = timeGraphPhase("publish.continuityPlan", () => delta
      ? planIncrementalCompatibilityAliases(store, freshNodes, delta, new FingerprintStore(this.db!))
      : planCompatibilityAliases(store, freshNodes, new FingerprintStore(this.db!)));
    // Continuity reads above may be substantial on a mature index. Re-probe
    // only after they finish, at the final synchronous boundary before the
    // snapshot is constructed and its publication transaction begins.
    const coverage = timeGraphPhase("publish.coverage", () => captureGraphCoverage(root));
    const git = timeGraphPhase("publish.verifyInputs", () => verifyPublicationInputs(
      root,
      staged,
      gitBeforeStaging,
      this.sourceFileAccess,
      this.internal,
    ));
    let edgeCount = 0;
    const expectedNodes = staged.files.reduce((count, file) => count + file.nodes.length, 0);
    const semanticInputs = staged.semanticInputs
      .map((input) => ({ path: input.filePath, contentHash: input.contentHash }));
    if (semanticInputs.length > GRAPH_SNAPSHOT_MAX_SEMANTIC_INPUTS) {
      throw new GraphSourceStagingError([{
        filePath: ".",
        operation: "discover",
        message: `Compiler provenance exceeds the ${GRAPH_SNAPSHOT_MAX_SEMANTIC_INPUTS}-path safety cap.`,
      }]);
    }
    const snapshot = createGraphSnapshot({
      indexedAt: new Date().toISOString(),
      git,
      schemaVersion: DB_SCHEMA_VERSION,
      compilerVersion: staged.compiler.compilerVersion,
      extractorVersion: CORPUS_EXTRACTOR_VERSION,
      resolverVersion: RESOLVER_VERSION,
      grammarHash: staged.grammarHash,
      configHash: staged.configHash,
      manifestHash: staged.manifestHash,
      sources: staged.files.map((file) => ({
        path: file.record.path,
        contentHash: file.record.contentHash,
        parseStatus: file.record.parseStatus ?? "ok",
      })),
      semanticInputs,
    });
    const serializedSnapshot = serializeGraphSnapshot(snapshot);

    store.transaction(() => {
      if (delta) {
        const stagedByPath = new Map(staged.files.map((file) => [file.record.path, file]));
        timeGraphPhase("publish.delta", () => applyRowDelta(
          store,
          this.db!,
          delta,
          new Map(staged.files.map((file) => [file.record.path, file.record])),
          (path) => staged.sourceSpool.read(stagedByPath.get(path)!.discovered),
        ));
        edgeCount = (grouped as FileRowGroups).edgeCount;
        timeGraphPhase("publish.cache", () => {
          const current = new Set(staged.extraction.cache.entries.map((entry) => entry.path));
          for (const entry of staged.extraction.cache.entries) {
            if (entry.changed) store.setExtractionCacheEntry(entry.path, entry.contentHash, entry.payload);
          }
          for (const path of store.getExtractionCache().keys()) {
            if (!current.has(path)) store.deleteExtractionCacheEntry(path);
          }
        });
        if (continuity) {
          timeGraphPhase("publish.aliases", () => applyIncrementalCompatibilityAliases(
            store, continuity, freshNodes, new FingerprintStore(this.db!),
          ));
        }
      } else {
        edgeCount = this.publishInFull(staged, store, continuity!, freshNodes);
        if (!("reason" in grouped)) {
          for (const group of grouped.groups.values()) store.setFileRowDigest(group.path, group.digest);
        }
        timeGraphPhase("publish.cache", () => {
          for (const entry of staged.extraction.cache.entries) {
            store.setExtractionCacheEntry(entry.path, entry.contentHash, entry.payload);
          }
        });
      }
      timeGraphPhase("publish.invariants", () => store.validateInvariants(expectedNodes));
      store.setMetadata("compiler_version", staged.compiler.compilerVersion);
      store.setMetadata("extractor_version", CORPUS_EXTRACTOR_VERSION);
      store.setMetadata("resolver_version", RESOLVER_VERSION);
      store.setMetadata("config_hash", staged.configHash);
      store.setMetadata("grammar_hash", staged.grammarHash);
      store.setMetadata(GRAPH_COVERAGE_METADATA_KEY, coverage);
      store.setMetadata(GRAPH_SNAPSHOT_METADATA_KEY, serializedSnapshot);
      store.setMetadata(EXTRACTION_CACHE_IDENTITY_KEY, staged.extraction.cache.identity);
      store.setMetadata(EXTRACTION_PROJECT_STATES_KEY, JSON.stringify(staged.extraction.cache.projectStates));
      if ("reason" in grouped) store.deleteMetadata(INCREMENTAL_STATE_METADATA_KEY);
      else store.setMetadata(INCREMENTAL_STATE_METADATA_KEY, incrementalStateMarker(serializedSnapshot));
      markGraphReady(this.db!, staged.manifestHash);
    });

    return {
      filesIndexed: staged.files.length,
      nodesCreated: expectedNodes,
      edgesCreated: edgeCount,
      health: healthCounts(staged.files),
      ...(staged.skipped.length > 0 ? { skipped: [...staged.skipped] } : {}),
      ...(staged.declinedInputs.length > 0
        ? { declinedInputs: [...staged.declinedInputs] }
        : {}),
      publication: delta
        ? { publication: "delta", filesRewritten: delta.rewritten.length + delta.removed.length }
        : {
            publication: "full",
            publicationFallbackReason: (planned as { reason: string }).reason,
            filesRewritten: staged.files.length,
          },
    };
  }

  /** The full publication: clear every derived row and insert the corpus again. */
  private publishInFull(
    staged: StagedCorpus,
    store: GraphStore,
    continuity: CompatibilityAliasPlan,
    freshNodes: readonly GraphNode[],
  ): number {
    let edgeCount = 0;
    timeGraphPhase("publish.clear", () => store.clearDerivedGraph());
    const insertStarted = performance.now();
    timeGraphPhase("publish.insert.filesAndChunks", () => {
      for (const file of staged.files) {
        store.upsertFile(file.record);
        store.replaceSourceChunks(
          file.record.path,
          staged.sourceSpool.read(file.discovered),
          file.record.contentHash,
        );
      }
    });
    timeGraphPhase("publish.insert.nodes", () => {
      for (const file of staged.files) for (const node of file.nodes) store.insertNode(node);
    });
    for (const file of staged.files) {
      const edgesStarted = performance.now();
      for (const edge of file.edges) if (store.insertEdge(edge)) edgeCount++;
      recordGraphPhase("publish.insert.edges", performance.now() - edgesStarted);
      // A resolved reference is an edge. Keeping the row too duplicated one
      // for every reference the resolver bound — 27-73% of this table on
      // every repository measured, all of them already in `edges`. Resolution
      // happens in memory during staging, so nothing downstream reads these
      // rows back to rebuild anything.
      for (const reference of file.references) {
        if (reference.status === "resolved") continue;
        store.insertUnresolvedRef(reference);
      }
      for (const binding of file.imports) store.insertImportBinding(binding);
    }
    recordGraphPhase("publish.insert", performance.now() - insertStarted);

    timeGraphPhase("publish.fingerprints", () =>
      upsertFingerprintsInOwnedTransaction(this.db!, staged.fingerprints));
    timeGraphPhase("publish.aliases", () => createCompatibilityAliases(
      store, continuity, freshNodes, new FingerprintStore(this.db!),
    ));
    timeGraphPhase("publish.fts", () => store.rebuildSearchIndex());
    return edgeCount;
  }

  searchNodes(query: string, options?: NodeSearchOptions): GraphNode[] {
    return this.getStore().search(query, options);
  }

  searchSource(query: string, limit = 40) {
    return this.getStore().searchSourceChunks(query, limit).map(({ id: _id, ...hit }) => hit);
  }

  getIndexedFiles() {
    return this.getStore().getAllFileRecords().map((file) => ({
      path: file.path,
      contentHash: file.contentHash,
      parseStatus: file.parseStatus ?? "ok",
      diagnosticCount: file.diagnosticCount ?? 0,
      errorCoverage: file.errorCoverage ?? 0,
      nodeCount: file.nodeCount,
    }));
  }

  getNode(id: string): GraphNode | null { return this.getStore().getNodeById(id); }
  getCallers(id: string): GraphNode[] { return getCallers(this.getStore(), id); }
  getCallees(id: string): GraphNode[] { return getCallees(this.getStore(), id); }
  getIncoming(id: string, kinds?: GraphEdge["kind"][]) { return getIncoming(this.getStore(), id, kinds); }
  getOutgoing(id: string, kinds?: GraphEdge["kind"][]) { return getOutgoing(this.getStore(), id, kinds); }

  close(): void {
    if (this.db) this.db.close();
    this.db = null;
    this.store = null;
  }
}

/**
 * The snapshot a refresh of `store` would leave unchanged, or null: exactly
 * the check `sync` applies before any staging. The manifest, the branch, every
 * source file and every recorded semantic input still match; only coverage and
 * the recorded HEAD can still move.
 */
function unchangedGraphSnapshot(
  root: string,
  store: GraphStore,
  git: GraphGitProvenance,
  manifest: GraphManifest,
  currentCorpus: readonly DiscoveredFile[],
): GraphSnapshot | null {
  if (store.getMetadata("manifest_hash") !== manifest.manifestHash) return null;
  const snapshot = parseGraphSnapshot(store.getMetadata(GRAPH_SNAPSHOT_METADATA_KEY));
  return snapshot?.manifestHash === manifest.manifestHash
    && snapshot.indexedBranch === git.branch
    && sourceCorpusMatchesFileRecords(currentCorpus, store.getAllFileRecords())
    && timeGraphPhase("sync.semanticInputs", () => semanticInputsMatchSnapshot(root, snapshot.semanticInputs))
    ? snapshot
    : null;
}

/**
 * Whether refreshing the graph at `dbPath` would publish nothing at all
 * (issue #209): `sync` would find it unchanged, its coverage is current and it
 * already records HEAD. The database is read immutably; the caller must have
 * established that no WAL holds newer data.
 * @internal
 */
export function refreshWouldPublishNothing(rootDir: string, dbPath: string): boolean {
  const root = resolve(rootDir);
  let db: SqliteDatabase;
  try {
    db = openGraphDatabase(dbPath, { readOnly: true, immutable: true });
  } catch {
    return false;
  }
  try {
    const store = new GraphStore(db);
    const git = readGraphGitProvenance(root);
    const manifest = graphManifest(root);
    if (store.getMetadata("manifest_hash") !== manifest.manifestHash) return false;
    const corpus = timeGraphPhase("envelope.noOpDiscover", () => discoverSourceFiles(root, NODE_SOURCE_FILE_ACCESS).files);
    const snapshot = unchangedGraphSnapshot(root, store, git, manifest, corpus);
    return snapshot !== null
      && snapshot.indexedHead === git.head
      && store.getMetadata(GRAPH_COVERAGE_METADATA_KEY) === captureGraphCoverage(root);
  } finally {
    db.close();
  }
}

export function createGraphEngine(options: GraphEngineOptions): GraphEngine {
  if ("immutable" in (options as GraphEngineOptions & { immutable?: unknown })) {
    throw new TypeError("Immutable graph access is internal to the validated grounding runtime.");
  }
  return new GraphEngineImpl(options);
}

/**
 * @internal Adopt one validated immutable connection for all grounding reads.
 * Ownership transfers to the returned engine and `close()` releases it.
 */
export function createGraphEngineFromOpenDatabase(
  options: Pick<GraphEngineOptions, "rootDir" | "dbPath">,
  database: SqliteDatabase,
): GraphEngine {
  return new GraphEngineImpl({ ...options, readOnly: true, immutable: true }, database);
}

/**
 * What a refresh may reuse, or why it must extract in full: the cache and
 * digests must describe the stored snapshot, and every non-corpus input the
 * compiler recorded must still hold the bytes it read.
 */
function loadExtractionReuse(store: GraphStore, root: string): ExtractionReuse | { reason: string } {
  if (!incrementalStateIsCurrent(store)) return { reason: "no extraction cache describes the stored graph" };
  const snapshot = parseGraphSnapshot(store.getMetadata(GRAPH_SNAPSHOT_METADATA_KEY));
  if (!snapshot || !semanticInputsMatchSnapshot(root, snapshot.semanticInputs)) {
    return { reason: "a non-corpus compiler input changed" };
  }
  let projectStates: Record<string, string>;
  try {
    projectStates = JSON.parse(store.getMetadata(EXTRACTION_PROJECT_STATES_KEY) ?? "null") as Record<string, string>;
  } catch {
    return { reason: "no extraction cache describes the stored graph" };
  }
  if (!projectStates || typeof projectStates !== "object") {
    return { reason: "no extraction cache describes the stored graph" };
  }
  const fingerprints = new Map<string, Pick<Fingerprint, "minhash" | "tokenCount">>();
  for (const row of store.getFingerprintSketches()) {
    fingerprints.set(row.nodeId, { minhash: decodeMinhash(row.minhash), tokenCount: row.tokenCount });
  }
  return {
    identity: store.getMetadata(EXTRACTION_CACHE_IDENTITY_KEY),
    stored: store.getExtractionCache(),
    projectStates,
    fingerprints,
    records: new Map(store.getAllFileRecords().map((record) => [record.path, record])),
  };
}

async function stageCorpus(
  root: string,
  manifest = graphManifest(root),
  sourceFileAccess: GraphSourceFileAccess = NODE_SOURCE_FILE_ACCESS,
  internal: GraphEngineInternalHooks = {},
  compilerExtraction?: CompilerExtractionOptions,
  reuse: ExtractionReuse | { reason: string } = { reason: "a full extraction was requested" },
  /** A corpus already discovered into its spool; staging takes ownership of the spool. */
  prepared?: PreparedCorpus,
): Promise<StagedCorpus> {
  const sourceSpool = prepared?.sourceSpool ?? new GraphSourceSpool(internal.sourceSpoolDirectory);
  try {
    const { files: discovered, skipped } = prepared?.corpus ?? timeGraphPhase("stage.discover", () =>
      discoverSourceFiles(root, sourceFileAccess, sourceSpool));
    const configSources = timeGraphPhase("stage.config", () => discoverGraphConfigSources(root));
    const stagedConfigHash = configHashForSources(configSources);
    if (stagedConfigHash !== manifest.configHash) {
      throw new GraphSourceStagingError([{
        filePath: ".",
        operation: "discover",
        message: "The graph configuration (configHash) changed before semantic staging began.",
      }]);
    }

    const compilerFiles = discovered.filter((file) =>
      COMPILER_LANGUAGES.has(detectLanguage(file.relPath)));
    const compilerPaths = compilerFiles.map((file) => file.relPath);
    const compilerInputs: CompilerStagedInput[] = [...configSources.entries()]
      .map(([filePath, source]) => ({ filePath, source }));
    let compilerSourceBytes = 0;
    for (const file of compilerFiles) {
      const source = sourceSpool.read(file);
      try {
        compilerSourceBytes = addGraphCompilerSourceBytes(
          compilerSourceBytes,
          Buffer.byteLength(source, "utf8"),
        );
      } catch (error) {
        throw new GraphSourceStagingError([sourceStagingFailure(file.relPath, "read", error)]);
      }
      compilerInputs.push({ filePath: file.relPath, source });
    }
    compilerInputs.sort((left, right) => compareCodePoints(left.filePath, right.filePath));
    internal.afterSemanticInputsStaged?.();
    const reportParsed = (completed: number): void => internal.onBuildProgress?.({
      phase: "parse",
      completed,
      ...(discovered.length > 0 ? { total: discovered.length } : {}),
    });
    reportParsed(0);

    // Incremental extraction (issue #209): plan which files to extract again,
    // or record why the whole corpus is extracted.
    const identity = extractionCacheIdentity(manifest.manifestHash, configSources);
    const discoveredByPath = new Map(discovered.map((file) => [file.relPath, file]));
    const isCompilerFile = (path: string): boolean => COMPILER_LANGUAGES.has(detectLanguage(path));
    let plan: IncrementalExtractionPlan | { reason: string } = "reason" in reuse ? reuse
      : reuse.identity !== identity ? { reason: "the configuration or the engine changed" }
      : timeGraphPhase("stage.plan", () => planIncrementalExtraction(
        reuse.stored,
        new Map(discovered.map((file) => [file.relPath, file.contentHash])),
        isCompilerFile,
        (path) => sourceSpool.read(discoveredByPath.get(path)!),
      ));

    let compiler: CompilerExtractionResult;
    const extractCompilerFiles = (incremental?: CompilerIncrementalInput): CompilerExtractionResult => {
      const semanticInputLedger = createGraphSemanticInputLedger();
      return timeGraphPhase("compiler.total", () => buildTypeScriptExtraction(root, compilerPaths, {
        ...compilerExtraction,
        ...(incremental ? { incremental } : {}),
        stagedInputs: compilerInputs,
        readProjectFile: (absolutePath) => {
          const source = readSecureCompilerInput(root, absolutePath);
          const relPath = toPosix(relative(resolve(root), resolve(absolutePath)));
          try {
            addGraphSemanticInput(
              semanticInputLedger,
              relPath,
              source === undefined ? null : Buffer.byteLength(source, "utf8"),
              source !== undefined || !negativeCompilerProbeCoveredByCorpusPolicy(relPath),
            );
          } catch (error) {
            throw new GraphSourceStagingError([sourceStagingFailure(relPath, "read", error)]);
          }
          return source;
        },
      }, reportParsed));
    };
    try {
      if ("reason" in plan) {
        compiler = extractCompilerFiles();
      } else {
        try {
          compiler = extractCompilerFiles({
            previous: plan.captures,
            affected: plan.affected,
            projectStates: (reuse as ExtractionReuse).projectStates,
          });
        } catch (error) {
          if (!(error instanceof CompilerIncrementalFallback)) throw error;
          plan = { reason: error.reason };
          compiler = extractCompilerFiles();
        }
      }
    } catch (error) {
      if (error instanceof GraphSourceStagingError) throw error;
      throw new GraphSourceStagingError([sourceStagingFailure(".", "read", error)]);
    } finally {
      // Drop the compiler's source-string input batch as soon as the semantic
      // result is materialized. The immutable disk spool remains authoritative.
      compilerInputs.length = 0;
    }
    internal.afterCompilerExtraction?.();
    const stagedInputHashes = new Map<string, string>([
      ...[...configSources.entries()].map(([path, source]) => [path, sha256(source)] as const),
      ...discovered.map((file) => [file.relPath, file.contentHash] as const),
    ]);
    timeGraphPhase("stage.validateCompilerInputs", () =>
      validateCompilerInputs(discovered, compiler, stagedInputHashes, root));
    const compilerByPath = new Map(compiler.files.map((file) => [file.filePath, file]));
    const treeLanguages = [...new Set(discovered.map((file) => detectLanguage(file.relPath))
      .filter((language) => !COMPILER_LANGUAGES.has(language)))];
    // Compiler-language files a crashing project could not stage fall back to
    // tree-sitter, so their grammars must be present too.
    const fallbackLanguages = [...new Set(discovered
      .filter((file) => COMPILER_LANGUAGES.has(detectLanguage(file.relPath))
        && !compilerByPath.has(file.relPath))
      .map((file) => detectLanguage(file.relPath)))];
    await timeGraphPhaseAsync("stage.loadGrammars", () => loadGrammars([...treeLanguages, ...fallbackLanguages]));

    // Cache entries for the next refresh, encoded before resolution adds
    // framework nodes and hydrates bindings in place.
    const storedExtraction = "reason" in reuse ? new Map<string, StoredExtraction>() : reuse.stored;
    const cacheEntries = new Map<string, ExtractionCacheState["entries"][number]>();
    const setCacheEntry = (path: string, contentHash: string, payload: Uint8Array): void => {
      const previous = storedExtraction.get(path);
      const changed = !previous || previous.contentHash !== contentHash
        || !Buffer.from(previous.payload).equals(Buffer.from(payload));
      cacheEntries.set(path, { path, contentHash, payload, changed });
    };
    const reusedCaptures = new Set(compiler.reused);
    timeGraphPhase("stage.cacheCompiler", () => {
      for (const capture of compiler.captures) {
        const contentHash = discoveredByPath.get(capture.filePath)?.contentHash;
        if (!contentHash) continue;
        if (reusedCaptures.has(capture.filePath)) {
          cacheEntries.set(capture.filePath, {
            path: capture.filePath, contentHash, payload: storedExtraction.get(capture.filePath)!.payload, changed: false,
          });
        } else {
          setCacheEntry(capture.filePath, contentHash, encodeCachedExtraction({ kind: "compiler", capture }));
        }
      }
    });
    compiler.captures.length = 0;
    const cachedTrees = "reason" in plan ? undefined : plan.trees;

    let parsed = compiler.files.length;
    let treesExtracted = 0;
    const files = discovered.map((file) => {
      const compilerFile = compilerByPath.get(file.relPath);
      if (compilerFile) {
        const source = sourceSpool.read(file);
        return timeGraphPhase("stage.compilerFiles", () => stageCompilerFile(file, source, compilerFile));
      }
      reportParsed(++parsed);
      const cached = cachedTrees?.get(file.relPath);
      if (cached) {
        cacheEntries.set(file.relPath, {
          path: file.relPath,
          contentHash: file.contentHash,
          payload: storedExtraction.get(file.relPath)!.payload,
          changed: false,
        });
        return restoreTreeFile(file, cached);
      }
      treesExtracted++;
      const staged = timeGraphPhase("stage.treeSitterFiles", () => stageTreeFile(file, sourceSpool.read(file)));
      setCacheEntry(file.relPath, file.contentHash, encodeCachedExtraction({ kind: "tree", file: cachedTreeFile(staged) }));
      return staged;
    });
    compilerByPath.clear();
    // Release project/file extraction arrays after their durable staged shape
    // has been copied. Per-node compiler spans survive only until fingerprinting.
    compiler.files.length = 0;
    compiler.projects.length = 0;

    internal.onBuildProgress?.({ phase: "resolve" });
    timeGraphPhase("stage.resolve", () =>
      stageFrameworkAndFallbackResolution(root, files, configSources, sourceSpool));
    timeGraphPhase("stage.validate", () => validateStagedCorpus(files));
    const fingerprints = timeGraphPhase("stage.fingerprints", () => stageFingerprints(
      files,
      sourceSpool,
      "reason" in reuse ? undefined : reuse,
    ));
    const coveredPaths = new Set([...discovered.map((file) => file.relPath), ...configSources.keys()]);
    const semanticInputs = compiler.semanticInputs.filter((input) => !coveredPaths.has(input.filePath));
    if (semanticInputs.length > GRAPH_SNAPSHOT_MAX_SEMANTIC_INPUTS) {
      throw new GraphSourceStagingError([{
        filePath: ".",
        operation: "discover",
        message: `Compiler provenance exceeds the ${GRAPH_SNAPSHOT_MAX_SEMANTIC_INPUTS}-path safety cap.`,
      }]);
    }
    return {
      files,
      skipped,
      declinedInputs: [...compiler.declinedInputs],
      compiler: {
        compilerVersion: compiler.compilerVersion,
        semanticInputs: [...compiler.semanticInputs],
      },
      semanticInputs,
      fingerprints,
      sourceSpool,
      ...manifest,
      extraction: {
        mode: "reason" in plan ? "full" : "incremental",
        ...("reason" in plan ? { fallbackReason: plan.reason } : {}),
        filesReextracted: compiler.recaptured + treesExtracted,
        cache: {
          identity,
          projectStates: compiler.projectStates,
          entries: discovered.flatMap((file) => cacheEntries.get(file.relPath) ?? []),
        },
      },
    };
  } catch (error) {
    sourceSpool.dispose();
    throw error;
  }
}

/** A tree-sitter file's staged extraction, as the cache stores it. */
function cachedTreeFile(staged: StagedFile): CachedTreeFile {
  return {
    language: staged.record.language,
    nodes: staged.nodes.map(({ updatedAt: _updatedAt, ...node }) => node as GraphNode),
    edges: staged.edges,
    references: staged.references,
    imports: staged.imports,
    errors: staged.record.errors,
    parseStatus: staged.record.parseStatus,
    diagnosticCount: staged.record.diagnosticCount,
    missingCount: staged.record.missingCount,
    errorCoverage: staged.record.errorCoverage,
    extractorVersion: staged.record.extractorVersion,
  };
}

/** The inverse of {@link cachedTreeFile}: what `stageTreeFile` stages for the same bytes. */
function restoreTreeFile(discovered: DiscoveredFile, cached: CachedTreeFile): StagedFile {
  const now = Date.now();
  return {
    discovered,
    record: {
      path: discovered.relPath,
      contentHash: discovered.contentHash,
      language: cached.language,
      size: discovered.size,
      modifiedAt: discovered.modifiedAt,
      indexedAt: now,
      nodeCount: cached.nodes.length,
      errors: cached.errors,
      parseStatus: cached.parseStatus,
      diagnosticCount: cached.diagnosticCount,
      missingCount: cached.missingCount,
      errorCoverage: cached.errorCoverage,
      extractorVersion: cached.extractorVersion,
    },
    nodes: cached.nodes.map((node) => ({ ...node, updatedAt: now })),
    edges: cached.edges,
    references: cached.references,
    imports: cached.imports,
  };
}

/** Missing source/config probes are already observed by bounded corpus walks. */
function negativeCompilerProbeCoveredByCorpusPolicy(relPath: string): boolean {
  if (isSupportedSourceFile(relPath)) return true;
  const name = relPath.split("/").at(-1)?.toLowerCase() ?? "";
  return name === "package.json"
    || /^tsconfig(?:\.[^.]+)?\.json$/u.test(name)
    || /^jsconfig(?:\.[^.]+)?\.json$/u.test(name);
}

function stageFrameworkAndFallbackResolution(
  root: string,
  files: StagedFile[],
  configSources: ReadonlyMap<string, string>,
  sourceSpool: GraphSourceSpool,
): void {
  const initialNodes = files.flatMap((file) => file.nodes);
  const fileByPath = new Map(files.map((file) => [file.record.path, file]));
  const sourceAccess = {
    paths: [...fileByPath.keys()],
    readFile: (path: string) => {
      const file = fileByPath.get(path);
      return file ? sourceSpool.read(file.discovered) : null;
    },
  };
  const detectionContext = createStagedResolutionContext(
    initialNodes,
    root,
    configSources,
    sourceAccess,
  );
  const resolvers = timeGraphPhase("resolve.frameworkDetect", () =>
    FRAMEWORK_RESOLVERS.filter((resolver) => resolver.detect(detectionContext)));
  const fileNodeByPath = new Map(initialNodes
    .filter((node) => node.kind === "file")
    .map((node) => [node.filePath, node]));

  for (const file of files) {
    if (file.record.parseStatus !== "ok") continue;
    const language = detectLanguage(file.record.path);
    const matchingResolvers = resolvers.filter((resolver) =>
      resolver.extract && (!resolver.languages || resolver.languages.includes(language)));
    if (matchingResolvers.length === 0) continue;
    const source = sourceSpool.read(file.discovered);
    for (const resolver of matchingResolvers) {
      const extracted = resolver.extract!(file.record.path, source);
      for (const rawNode of extracted.nodes) {
        const node: GraphNode = {
          ...rawNode,
          identityKey: rawNode.identityKey ?? canonicalNodeIdentity(
            rawNode.filePath, rawNode.kind, rawNode.qualifiedName,
            `framework:${resolver.name}`, rawNode.signature,
          ),
        };
        file.nodes.push(node);
        const fileNode = fileNodeByPath.get(file.record.path);
        if (fileNode) file.edges.push({
          source: fileNode.id,
          target: node.id,
          kind: "contains",
          line: node.startLine,
          confidence: 0.8,
          provenance: "framework",
          resolutionMethod: resolver.name,
          evidence: [{ wiringSite: { filePath: file.record.path, line: node.startLine } }],
        });
      }
      for (const ref of extracted.references) {
        const wiringSite = {
          filePath: ref.filePath,
          line: ref.line === undefined ? undefined : ref.line + 1,
          column: ref.column,
        };
        const explicitTargets = file.imports
          .filter((binding) => binding.localName === ref.referenceName && binding.targetId)
          .map((binding) => binding.targetId!)
          .filter((id, index, values) => values.indexOf(id) === index);
        const explicitTarget = ref.referenceKind === "function_ref" && explicitTargets.length === 1
          ? explicitTargets[0]
          : undefined;
        const resolverName = resolver.name === "express" ? "express-route-handler" : resolver.name;
        const stagedRef: UnresolvedRefRecord = {
          ...ref,
          line: wiringSite.line,
          resolver: explicitTarget ? resolverName : resolver.name,
          status: explicitTarget ? "resolved" : "pending",
          targetId: explicitTarget,
          confidence: 0.8,
          candidates: explicitTarget ? [explicitTarget] : ref.candidates,
          metadata: { wiringSite, ...(explicitTarget ? { importBinding: ref.referenceName } : {}) },
        };
        file.references.push(stagedRef);
        if (explicitTarget) file.edges.push({
          source: ref.fromNodeId,
          target: explicitTarget,
          kind: "references",
          line: wiringSite.line,
          column: wiringSite.column,
          confidence: 0.8,
          provenance: "framework",
          resolutionMethod: resolverName,
          evidence: [{ resolver: resolverName, wiringSite, importBinding: ref.referenceName }],
        });
      }
    }
    file.record.nodeCount = file.nodes.length;
  }

  const nodes = files.flatMap((file) => file.nodes);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const context = createStagedResolutionContext(nodes, root, configSources, sourceAccess);
  const refs = files.flatMap((file) => file.references).filter((ref) =>
    ref.status !== "resolved"
    && !ref.resolver?.startsWith("typescript-")
    && ref.resolver !== "lexical-containment",
  );
  const resolvedEdges = timeGraphPhase("resolve.references", () =>
    resolveReferences(nodes, refs, { resolvers, context }));
  hydrateFallbackImportBindings(files, nodes, nodeById);
  for (const edge of resolvedEdges) {
    const source = nodeById.get(edge.source);
    const stagedFile = source ? fileByPath.get(source.filePath) : undefined;
    if (stagedFile) stagedFile.edges.push(edge);
  }
}

/**
 * Fallback resolvers prove module ownership while resolving import references.
 * Persist that proof on each binding too: namespace imports target the file
 * node, while a uniquely named imported declaration targets the declaration.
 */
function hydrateFallbackImportBindings(
  files: readonly StagedFile[],
  nodes: readonly GraphNode[],
  nodeById: ReadonlyMap<string, GraphNode>,
): void {
  const symbolsByFileAndName = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.kind === "file") continue;
    const key = `${node.filePath}\0${node.name}`;
    const bucket = symbolsByFileAndName.get(key) ?? [];
    bucket.push(node);
    symbolsByFileAndName.set(key, bucket);
  }
  for (const file of files) {
    for (const binding of file.imports) {
      if (binding.resolvedFilePath || binding.targetId) continue;
      const imported = file.references.find((reference) =>
        reference.referenceKind === "imports"
        && reference.referenceName === binding.moduleSpecifier
        && fallbackBindings(reference).some((candidate) =>
          candidate.localName === binding.localName && candidate.importedName === binding.importedName),
      );
      const targetFile = imported?.targetId ? nodeById.get(imported.targetId) : undefined;
      if (!targetFile || targetFile.kind !== "file") continue;
      binding.resolvedFilePath = targetFile.filePath;
      if (binding.importedName === "*") {
        binding.targetId = targetFile.id;
        continue;
      }
      const candidates = symbolsByFileAndName.get(`${targetFile.filePath}\0${binding.importedName}`) ?? [];
      if (candidates.length === 1) binding.targetId = candidates[0]!.id;
    }
  }
}

function validateStagedCorpus(files: readonly StagedFile[]): void {
  const nodes = files.flatMap((file) => file.nodes);
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new Error(`Graph staging invariant failed: duplicate node id ${node.id}.`);
    ids.add(node.id);
    if (!node.identityKey) throw new Error(`Graph staging invariant failed: ${node.id} has no identity key.`);
    if (identities.has(node.identityKey)) {
      throw new Error(`Graph staging invariant failed: duplicate identity key for ${node.id}.`);
    }
    identities.add(node.identityKey);
  }
  for (const file of files) {
    if (file.record.nodeCount !== file.nodes.length) {
      throw new Error(`Graph staging invariant failed: ${file.record.path} emitted ${file.nodes.length} nodes but reported ${file.record.nodeCount}.`);
    }
    if (file.record.parseStatus === "failed" && file.nodes.length > 0) {
      throw new Error(`Graph staging invariant failed: failed file ${file.record.path} emitted graph claims.`);
    }
    for (const node of file.nodes) {
      if (node.containerId && !ids.has(node.containerId)) {
        throw new Error(`Graph staging invariant failed: dangling container ${node.containerId}.`);
      }
    }
    for (const edge of file.edges) {
      if (!ids.has(edge.source) || !ids.has(edge.target)) {
        throw new Error(`Graph staging invariant failed: dangling ${edge.kind} edge ${edge.source} -> ${edge.target}.`);
      }
    }
    for (const ref of file.references) {
      if (!ids.has(ref.fromNodeId)) {
        throw new Error(`Graph staging invariant failed: dangling reference source ${ref.fromNodeId}.`);
      }
      if (ref.targetId && !ids.has(ref.targetId)) {
        throw new Error(`Graph staging invariant failed: dangling reference target ${ref.targetId}.`);
      }
    }
    for (const binding of file.imports) {
      if (binding.targetId && !ids.has(binding.targetId)) {
        throw new Error(`Graph staging invariant failed: dangling import target ${binding.targetId}.`);
      }
    }
  }
}

function stageFingerprints(
  staged: readonly StagedFile[],
  sourceSpool: GraphSourceSpool,
  stored?: Pick<ExtractionReuse, "fingerprints" | "records">,
): Array<{ nodeId: string; fingerprint: Fingerprint }> {
  const fingerprintBuilder = createFingerprintBuilder();
  const pending: Array<{ nodeId: string; fingerprint: Fingerprint }> = [];
  const callersByTarget = new Map<string, Set<string>>();
  const calleesBySource = new Map<string, Set<string>>();
  for (const edge of staged.flatMap((file) => file.edges).filter((edge) => edge.kind === "calls")) {
    const callers = callersByTarget.get(edge.target) ?? new Set<string>();
    callers.add(edge.source);
    callersByTarget.set(edge.target, callers);
    const callees = calleesBySource.get(edge.source) ?? new Set<string>();
    callees.add(edge.target);
    calleesBySource.set(edge.source, callees);
  }
  for (const file of staged) {
    const nodes = file.nodes.filter((node) => node.bodyHash);
    if (nodes.length === 0) {
      file.compilerNodes = undefined;
      continue;
    }
    // A sketch depends only on the node's own tokens (issue #209). For the
    // same bytes and extractor, a node id stands for the same declaration, so
    // a stored sketch still holds; neighbours are recomputed for every node.
    const previous = stored?.records.get(file.record.path);
    const sketches = previous
      && previous.contentHash === file.record.contentHash
      && previous.extractorVersion === file.record.extractorVersion
      ? nodes.map((node) => stored!.fingerprints.get(node.id))
      : undefined;
    if (sketches?.every(Boolean)) {
      nodes.forEach((node, index) => {
        const sketch = sketches[index]!;
        pending.push({
          nodeId: node.id,
          fingerprint: {
            minhash: sketch.minhash,
            neighbors: [...new Set([
              ...(callersByTarget.get(node.id) ?? []),
              ...(calleesBySource.get(node.id) ?? []),
            ])].sort(),
            tokenCount: sketch.tokenCount,
          },
        });
      });
      file.compilerNodes = undefined;
      continue;
    }
    const source = sourceSpool.read(file.discovered);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const compilerNodes = file.compilerNodes?.filter((node) => nodeIds.has(node.id));
    const tokens = compilerNodes && compilerNodes.length > 0
      ? normalizedCompilerTokens(source, compilerNodes)
      : normalizedAstTokens(file.record.path, source, nodes);
    for (const node of nodes) {
      pending.push({
        nodeId: node.id,
        fingerprint: fingerprintBuilder.create(
          tokens.get(node.id) ?? [],
          [...(callersByTarget.get(node.id) ?? [])],
          [...(calleesBySource.get(node.id) ?? [])],
        ),
      });
    }
    file.compilerNodes = undefined;
  }
  return pending;
}

function stageCompilerFile(
  discovered: DiscoveredFile,
  source: string,
  extraction: CompilerFileExtraction,
): StagedFile {
  const now = Date.now();
  const lines = source.split("\n");
  const nodes: GraphNode[] = extraction.nodes.map((node) => ({
    id: node.id,
    identityKey: node.identityKey,
    containerId: node.containerId,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    language: node.language,
    startLine: node.startLine,
    endLine: node.endLine,
    startColumn: node.startColumn,
    endColumn: node.endColumn,
    docstring: node.docstring,
    signature: node.signature,
    visibility: node.visibility,
    isExported: node.isExported,
    isAsync: node.isAsync,
    isStatic: node.isStatic,
    isAbstract: node.isAbstract,
    decorators: node.decorators,
    typeParameters: node.typeParameters,
    returnType: node.returnType,
    bodyHash: BODY_KINDS.has(node.kind) ? bodyHash(lines, node.startLine, node.endLine) : undefined,
    updatedAt: now,
  }));
  const edges: GraphEdge[] = [];
  const references: UnresolvedRefRecord[] = [];
  for (const ref of extraction.references) {
    if (ref.status === "resolved" && ref.targetId) {
      edges.push({
        source: ref.sourceId,
        target: ref.targetId,
        kind: ref.kind,
        metadata: { targetName: ref.targetName, targetQualifiedName: ref.targetQualifiedName },
        line: ref.line + 1,
        column: ref.column,
        provenance: ref.provenance,
        confidence: ref.confidence,
        resolutionMethod: ref.resolutionMethod,
        evidence: [ref.evidence],
      });
      continue;
    }
    // Resolved compiler references are fully represented by the edge above.
    // Keep fallback references separately: import hydration still needs them.
    const reference: UnresolvedRefRecord = {
      refKey: ref.id,
      fromNodeId: ref.sourceId,
      referenceName: ref.targetName,
      referenceKind: ref.kind as ReferenceKind,
      filePath: ref.filePath,
      language: extraction.language,
      line: ref.line + 1,
      column: ref.column,
      candidates: ref.candidates,
      receiver: ref.receiver,
      qualifier: ref.qualifier,
      metadata: ref.evidence,
      status: ref.status,
      targetId: ref.targetId,
      confidence: ref.confidence,
      resolver: ref.resolutionMethod,
    };
    references.push(reference);
  }
  const imports: ImportBindingRecord[] = extraction.importBindings.map((binding) => ({
    bindingKey: binding.id,
    filePath: binding.filePath,
    localName: binding.localName,
    importedName: binding.importedName,
    moduleSpecifier: binding.moduleSpecifier,
    resolvedFilePath: binding.resolvedFilePath,
    targetId: binding.targetId,
    isTypeOnly: binding.isTypeOnly,
    metadata: {
      isNamespace: binding.isNamespace, isDefault: binding.isDefault,
      line: binding.line + 1, column: binding.column,
      confidence: binding.confidence, resolutionMethod: binding.resolutionMethod,
    },
  }));
  return {
    discovered,
    record: {
      path: discovered.relPath,
      contentHash: discovered.contentHash,
      language: extraction.language,
      size: discovered.size,
      modifiedAt: discovered.modifiedAt,
      indexedAt: now,
      nodeCount: nodes.length,
      // File health describes whether structural graph claims are trustworthy.
      // Semantic type errors are useful compiler observations, but treating them
      // as parse/extraction loss makes healthy real-world repositories look
      // corrupt (and would trigger unnecessary agent fallbacks).
      errors: extraction.health.diagnostics
        .slice(0, extraction.health.syntacticDiagnosticCount)
        .map((diagnostic) => ({ ...diagnostic })),
      parseStatus: extraction.health.status,
      diagnosticCount: extraction.health.syntacticDiagnosticCount,
      missingCount: 0,
      errorCoverage: extraction.health.diagnosticByteCoverage,
      extractorVersion: TYPESCRIPT_COMPILER_EXTRACTOR_VERSION,
    },
    nodes,
    edges,
    references,
    imports,
    compilerNodes: extraction.nodes,
  };
}

function stageTreeFile(discovered: DiscoveredFile, source: string): StagedFile {
  const now = Date.now();
  const extraction = extractFile(discovered.relPath, source);
  const language = extraction?.language ?? detectLanguage(discovered.relPath);
  const health = extraction?.health ?? {
    status: "failed" as const, diagnosticCount: 1, missingCount: 0, errorCoverage: 1,
    diagnostics: [{ type: "PARSER_UNAVAILABLE", startLine: 1, endLine: 1 }],
  };
  const containsParents = new Map<string, string>();
  for (const edge of extraction?.edges ?? []) {
    if (edge.kind === "contains" && edge.target) containsParents.set(edge.target, edge.source);
  }
  const lines = source.split("\n");
  const nodes: GraphNode[] = (extraction?.nodes ?? []).map((node) => ({
    ...node,
    containerId: containsParents.get(node.id),
    identityKey: node.identityKey
      ?? canonicalNodeIdentity(node.filePath, node.kind, node.qualifiedName, node.kind, node.signature),
    bodyHash: BODY_KINDS.has(node.kind) ? bodyHash(lines, node.startLine, node.endLine) : undefined,
    updatedAt: now,
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: GraphEdge[] = [];
  const references: UnresolvedRefRecord[] = [];
  for (const edge of extraction?.edges ?? []) {
    if (edge.target) {
      edges.push({
        source: edge.source, target: edge.target, kind: edge.kind as GraphEdge["kind"],
        line: edge.kind === "contains" ? byId.get(edge.target)?.startLine : edge.line === undefined ? undefined : edge.line + 1,
        column: edge.column, metadata: edge.metadata, provenance: "tree-sitter",
        confidence: 1, resolutionMethod: edge.kind === "contains" ? "lexical-containment" : "tree-sitter",
      });
    } else if (edge.targetName) {
      const dot = edge.targetName.lastIndexOf(".");
      references.push({
        fromNodeId: edge.source,
        referenceName: edge.targetName,
        referenceKind: edge.kind,
        filePath: discovered.relPath,
        language,
        line: edge.line === undefined ? undefined : edge.line + 1,
        column: edge.column,
        candidates: edge.candidates,
        receiver: dot > 0 ? edge.targetName.slice(0, dot) : undefined,
        qualifier: dot > 0 ? edge.targetName.slice(0, dot) : undefined,
        metadata: edge.metadata,
        status: "pending",
        resolver: "tree-sitter",
      });
    }
  }
  const imports: ImportBindingRecord[] = references
    .filter((reference) => reference.referenceKind === "imports")
    .flatMap((reference) => fallbackBindings(reference).map((binding) => ({
      bindingKey: `import:${sha256([
        reference.filePath, binding.localName, binding.importedName, reference.referenceName,
      ].join("\0")).slice(0, 32)}`,
      filePath: reference.filePath,
      localName: binding.localName,
      importedName: binding.importedName,
      moduleSpecifier: reference.referenceName,
      isTypeOnly: false,
      metadata: {
        line: reference.line,
        column: reference.column,
        confidence: 1,
        resolutionMethod: "explicit-import",
      },
    })));
  return {
    discovered,
    record: {
      path: discovered.relPath,
      contentHash: discovered.contentHash,
      language,
      size: discovered.size,
      modifiedAt: discovered.modifiedAt,
      indexedAt: now,
      nodeCount: nodes.length,
      errors: health.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      parseStatus: health.status,
      diagnosticCount: health.diagnosticCount,
      missingCount: health.missingCount,
      errorCoverage: health.errorCoverage,
      extractorVersion: TREE_SITTER_EXTRACTOR_VERSION,
    },
    nodes,
    edges,
    references,
    imports,
  };
}

function fallbackBindings(reference: UnresolvedRefRecord): Array<{ localName: string; importedName: string }> {
  const bindings = reference.metadata?.bindings;
  if (!Array.isArray(bindings)) return [];
  return bindings.filter((binding): binding is { localName: string; importedName: string } => {
    if (!binding || typeof binding !== "object") return false;
    const candidate = binding as Record<string, unknown>;
    return typeof candidate.localName === "string" && typeof candidate.importedName === "string";
  });
}

interface CompatibilityAliasPlan {
  oldAliases: NodeAliasRecord[];
  canonicalMap: Map<string, string>;
  direct: NodeAliasRecord[];
  fingerprints: Array<{ id: string; kind: GraphNode["kind"]; baseline: Fingerprint }>;
}

/** Plan continuity while old rows exist; retain only data needed after replacement. */
function planCompatibilityAliases(
  store: GraphStore,
  fresh: readonly GraphNode[],
  fingerprints: FingerprintStore,
): CompatibilityAliasPlan {
  const freshIds = new Set(fresh.map((node) => node.id));
  const oldIds = store.getAllNodeIds();
  const plan: CompatibilityAliasPlan = {
    oldAliases: store.getAllAliases(),
    canonicalMap: new Map(oldIds.filter((id) => freshIds.has(id)).map((id) => [id, id])),
    direct: [],
    fingerprints: [],
  };
  // Body edits normally keep every identity. Avoid loading old descriptions,
  // signatures and fingerprints merely to discover that each ID survived.
  if (plan.canonicalMap.size === oldIds.length) return plan;

  matchVanishedNodes(plan, store.getAllNodes(), fresh, freshIds, fingerprints);
  return plan;
}

/**
 * Incremental publication (issue #209): the plan a full publication makes,
 * without reading back the whole stored graph. A file whose row digest is
 * unchanged stores exactly its fresh nodes, so the stored node set is those
 * plus the stored nodes of every rewritten or removed file. Null when no node
 * disappears: then every alias survives as it is.
 */
function planIncrementalCompatibilityAliases(
  store: GraphStore,
  fresh: readonly GraphNode[],
  delta: RowDelta,
  fingerprints: FingerprintStore,
): CompatibilityAliasPlan | null {
  if (delta.vanished.length === 0) return null;
  const freshIds = new Set(fresh.map((node) => node.id));
  const oldNodes = [
    ...fresh.filter((node) => !delta.previousNodes.has(node.filePath)),
    ...[...delta.previousNodes.values()].flat(),
  ];
  const plan: CompatibilityAliasPlan = {
    oldAliases: store.getAllAliases(),
    canonicalMap: new Map(oldNodes.filter((node) => freshIds.has(node.id)).map((node) => [node.id, node.id])),
    direct: [],
    fingerprints: [],
  };
  matchVanishedNodes(plan, oldNodes, fresh, freshIds, fingerprints);
  return plan;
}

/** Match every stored node that has no fresh counterpart, as continuity requires. */
function matchVanishedNodes(
  plan: CompatibilityAliasPlan,
  oldNodes: readonly GraphNode[],
  fresh: readonly GraphNode[],
  freshIds: ReadonlySet<string>,
  fingerprints: FingerprintStore,
): void {
  const byQualified = groupUnique(fresh, (node) => `${node.filePath}\0${node.kind}\0${node.qualifiedName}`);
  const oldBySignature = groupUnique(
    oldNodes.filter((node) => normalizedSignature(node.signature).length > 0),
    compatibilitySignatureKey,
  );
  const bySignature = groupUnique(
    fresh.filter((node) => normalizedSignature(node.signature).length > 0),
    compatibilitySignatureKey,
  );
  const byBody = groupUnique(fresh.filter((node) => node.bodyHash), (node) => `${node.kind}\0${node.bodyHash}`);
  for (const old of oldNodes) {
    if (freshIds.has(old.id)) continue;
    const qualified = byQualified.get(`${old.filePath}\0${old.kind}\0${old.qualifiedName}`);
    const signatureKey = normalizedSignature(old.signature) ? compatibilitySignatureKey(old) : undefined;
    const oldSignature = signatureKey ? oldBySignature.get(signatureKey) : undefined;
    const signature = oldSignature?.length === 1 && signatureKey
      ? bySignature.get(signatureKey) : undefined;
    const body = old.bodyHash ? byBody.get(`${old.kind}\0${old.bodyHash}`) : undefined;
    const match = qualified?.length === 1 ? { node: qualified[0]!, method: "qualified-name", confidence: 1 }
      : signature?.length === 1 ? { node: signature[0]!, method: "signature", confidence: 0.98 }
      : body?.length === 1 ? { node: body[0]!, method: "body-hash", confidence: 0.95 }
      : undefined;
    if (match) {
      plan.direct.push({
        aliasId: old.id,
        canonicalNodeId: match.node.id,
        matchMethod: match.method,
        confidence: match.confidence,
      });
      plan.canonicalMap.set(old.id, match.node.id);
    } else {
      const baseline = fingerprints.get(old.id);
      if (baseline && baseline.tokenCount >= MIN_TOKENS) {
        plan.fingerprints.push({ id: old.id, kind: old.kind, baseline });
      }
    }
  }
}

function createCompatibilityAliases(
  store: GraphStore,
  plan: CompatibilityAliasPlan,
  fresh: readonly GraphNode[],
  freshFingerprints: FingerprintStore,
): void {
  for (const alias of plan.direct) {
    store.insertAlias(alias.aliasId, alias.canonicalNodeId, alias.matchMethod, alias.confidence);
  }
  if (plan.fingerprints.length > 0) {
    const freshById = new Map(fresh.map((node) => [node.id, node]));
    for (const old of plan.fingerprints) {
      const match = fingerprintAliasMatch(old, old.baseline, freshFingerprints, freshById);
      if (!match) continue;
      store.insertAlias(old.id, match.node.id, match.method, match.confidence);
      plan.canonicalMap.set(old.id, match.node.id);
    }
  }
  for (const alias of plan.oldAliases) {
    const canonical = plan.canonicalMap.get(alias.canonicalNodeId);
    if (canonical) store.insertAlias(alias.aliasId, canonical, alias.matchMethod, alias.confidence);
  }
}

/**
 * Incremental publication (issue #209): leave the alias table exactly as
 * {@link createCompatibilityAliases} leaves it after a full clear. The full
 * path inserts direct matches, then fingerprint matches, then every old alias
 * re-pointed through the canonical map, each insert replacing an earlier row
 * for the same alias; the same sequence is folded here and only its
 * difference from the stored table is written.
 */
function applyIncrementalCompatibilityAliases(
  store: GraphStore,
  plan: CompatibilityAliasPlan,
  fresh: readonly GraphNode[],
  freshFingerprints: FingerprintStore,
): void {
  const freshById = new Map(fresh.map((node) => [node.id, node]));
  const target = new Map<string, NodeAliasRecord>();
  const put = (aliasId: string, canonicalNodeId: string, matchMethod: string, confidence: number): void => {
    // insertAlias skips a self-alias and an alias of a node that does not exist.
    if (aliasId === canonicalNodeId || !freshById.has(canonicalNodeId)) return;
    target.set(aliasId, { aliasId, canonicalNodeId, matchMethod, confidence });
  };
  for (const alias of plan.direct) put(alias.aliasId, alias.canonicalNodeId, alias.matchMethod, alias.confidence);
  for (const old of plan.fingerprints) {
    const match = fingerprintAliasMatch(old, old.baseline, freshFingerprints, freshById);
    if (!match) continue;
    put(old.id, match.node.id, match.method, match.confidence);
    plan.canonicalMap.set(old.id, match.node.id);
  }
  for (const alias of plan.oldAliases) {
    const canonical = plan.canonicalMap.get(alias.canonicalNodeId);
    if (canonical) put(alias.aliasId, canonical, alias.matchMethod, alias.confidence);
  }
  const stored = new Map(store.getAllAliases().map((alias) => [alias.aliasId, alias]));
  for (const aliasId of stored.keys()) if (!target.has(aliasId)) store.deleteAlias(aliasId);
  for (const alias of target.values()) {
    const before = stored.get(alias.aliasId);
    if (before
      && before.canonicalNodeId === alias.canonicalNodeId
      && before.matchMethod === alias.matchMethod
      && before.confidence === alias.confidence) continue;
    store.insertAlias(alias.aliasId, alias.canonicalNodeId, alias.matchMethod, alias.confidence);
  }
}

function normalizedSignature(signature: string | undefined): string {
  return signature?.replace(/\s+/g, " ").trim() ?? "";
}

/** Signature-only moves require the same unambiguous symbol in both snapshots. */
function compatibilitySignatureKey(node: GraphNode): string {
  return `${node.kind}\0${node.name}\0${normalizedSignature(node.signature)}`;
}

function fingerprintAliasMatch(
  old: Pick<GraphNode, "kind">,
  baseline: Fingerprint | undefined,
  freshFingerprints: FingerprintStore,
  freshById: ReadonlyMap<string, GraphNode>,
): { node: GraphNode; method: string; confidence: number } | null {
  if (!baseline || baseline.tokenCount < MIN_TOKENS) return null;
  const scored = freshFingerprints.lookup(baseline)
    .filter((candidate) => freshById.get(candidate.nodeId)?.kind === old.kind)
    .map((candidate) => ({
      ...candidate,
      node: freshById.get(candidate.nodeId)!,
      score: minhashJaccard(baseline.minhash, candidate.fingerprint.minhash),
    }))
    .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId));
  const best = scored[0];
  if (!best || best.score < 0.95) return null;
  const runnerUp = scored[1];
  if (runnerUp && best.score - runnerUp.score < 0.08) return null;
  return { node: best.node, method: "fingerprint", confidence: best.score };
}

function groupUnique<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const bucket = grouped.get(key(value)) ?? [];
    bucket.push(value);
    grouped.set(key(value), bucket);
  }
  return grouped;
}

function inspectChangedSources(
  root: string,
  changedSources: readonly string[],
  sourceFileAccess: GraphSourceFileAccess,
): Set<string> {
  const deleted = new Set<string>();
  const failures: GraphSourceStagingFailure[] = [];
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch (error) {
    throw new GraphSourceStagingError([sourceStagingFailure(".", "discover", error)]);
  }
  for (const relPath of changedSources) {
    let canonicalPath: string;
    try {
      canonicalPath = resolveContainedRepoFile(root, canonicalRoot, relPath);
    } catch (error) {
      if (isMissingPathError(error)) deleted.add(relPath);
      else failures.push(sourceStagingFailure(relPath, "discover", error));
      continue;
    }
    try {
      sourceFileAccess.stat(sourceFileAccess === NODE_SOURCE_FILE_ACCESS
        ? canonicalPath
        : resolve(root, relPath));
    } catch (error) {
      if (isMissingPathError(error)) deleted.add(relPath);
      else failures.push(sourceStagingFailure(relPath, "stat", error));
    }
  }
  if (failures.length > 0) throw new GraphSourceStagingError(failures);
  return deleted;
}

/**
 * Walk the repository's supported sources.
 *
 * A file the bounded corpus policy will not read is **skipped, not fatal.**
 * One oversized generated file used to abort an entire multi-thousand-file
 * build: the per-file limit error was pushed as a staging failure, the loop
 * `break`s so no later file was even attempted, and the accumulated failures
 * were thrown. Every other file in the repository is still perfectly
 * indexable, so a per-file ceiling now records the file and continues.
 *
 * Corpus-wide ceilings (`maxSourceBytes`, `maxSourceFiles`) still abort. They
 * describe the whole run and there is no honest partial answer to them.
 *
 * The skip happens here, at the single discovery seam every consumer shares,
 * so the staged corpus, `verifyPublicationInputs`, `sync`'s corpus comparison
 * and the freshness inspector all agree about which files exist.
 */
function discoverSourceFiles(
  root: string,
  sourceFileAccess: GraphSourceFileAccess,
  sourceSpool?: GraphSourceSpool,
): DiscoveredCorpus {
  let matches: string[];
  const files: DiscoveredFile[] = [];
  const skipped: GraphSkippedSourceFile[] = [];
  const failures: GraphSourceStagingFailure[] = [];
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
    matches = discoverBoundedGraphPaths(GRAPH_SUPPORTED_SOURCE_GLOB, {
      ...GRAPH_CORPUS_GLOB_OPTIONS,
      cwd: root,
      ignore: graphCorpusIgnoreGlobs(root),
    }, GRAPH_CORPUS_LIMITS.maxSourceFiles).map(toPosix);
  } catch (error) {
    throw new GraphSourceStagingError([sourceStagingFailure(".", "discover", error)]);
  }
  let sourceBytes = 0;
  const canonicalDirectories = new Map<string, string>();
  for (const relPath of matches) {
    if (!isSupportedSourceFile(relPath)) continue;
    let canonicalPath: string;
    try {
      canonicalPath = resolveContainedRepoFile(root, canonicalRoot, relPath, canonicalDirectories);
    } catch (error) {
      failures.push(sourceStagingFailure(relPath, "discover", error));
      continue;
    }

    if (sourceFileAccess === NODE_SOURCE_FILE_ACCESS) {
      try {
        const file = readStableUtf8File(
          canonicalPath,
          resolve(root, relPath),
          GRAPH_CORPUS_LIMITS.maxSourceFileBytes,
        );
        sourceBytes = addGraphCorpusBytes(
          sourceBytes,
          Buffer.byteLength(file.source, "utf8"),
          "source",
        );
        const contentHash = sha256(file.source);
        sourceSpool?.stage(relPath, file.source);
        files.push({ relPath, contentHash, size: file.size, modifiedAt: file.modifiedAt });
      } catch (error) {
        if (isPerFileCorpusLimitError(error)) skipped.push(skippedSourceFile(relPath, error));
        else {
          failures.push(sourceStagingFailure(relPath, "read", error));
          if (error instanceof GraphCorpusLimitError) break;
        }
      }
      continue;
    }

    let stat: { size: number; mtimeMs: number };
    let identityBefore: ReturnType<typeof lstatSync>;
    const callbackPath = resolve(root, relPath);
    try {
      identityBefore = lstatSync(canonicalPath);
      if (!identityBefore.isFile() || identityBefore.isSymbolicLink()) {
        throw sourceContainmentError("Resolved source path is not a stable regular file.");
      }
      stat = sourceFileAccess.stat(callbackPath);
    } catch (error) {
      failures.push(sourceStagingFailure(relPath, "stat", error));
      continue;
    }
    try {
      const source = sourceFileAccess.read(callbackPath);
      const actualBytes = Buffer.byteLength(source, "utf8");
      sourceBytes = addGraphCorpusBytes(sourceBytes, actualBytes, "source");
      const identityAfter = lstatSync(canonicalPath);
      if (!sameFileIdentity(identityBefore, identityAfter)
        || resolveContainedRepoFile(root, canonicalRoot, relPath) !== canonicalPath) {
        throw sourceContainmentError("Source path changed while it was being read.");
      }
      files.push({
        relPath,
        contentHash: sha256(source),
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      });
      sourceSpool?.stage(relPath, source);
    } catch (error) {
      if (isPerFileCorpusLimitError(error)) skipped.push(skippedSourceFile(relPath, error));
      else {
        failures.push(sourceStagingFailure(relPath, "read", error));
        if (error instanceof GraphCorpusLimitError) break;
      }
    }
  }
  if (failures.length > 0) throw new GraphSourceStagingError(failures);
  return { files, skipped };
}

function skippedSourceFile(
  filePath: string,
  error: GraphCorpusLimitError,
): GraphSkippedSourceFile {
  return {
    filePath,
    reason: "corpus-limit",
    limit: error.limit,
    limitBytes: GRAPH_CORPUS_LIMITS[error.limit],
    observedBytes: error.observedBytes,
    message: error.message,
  };
}

function sourceCorpusMatchesFileRecords(
  currentCorpus: readonly DiscoveredFile[],
  indexedFiles: readonly FileRecord[],
): boolean {
  if (currentCorpus.length !== indexedFiles.length) return false;
  const indexedByPath = new Map(indexedFiles.map((file) => [file.path, file.contentHash]));
  return indexedByPath.size === indexedFiles.length
    && currentCorpus.every((file) => indexedByPath.get(file.relPath) === file.contentHash);
}

function semanticInputsMatchSnapshot(
  root: string,
  semanticInputs: readonly GraphSnapshotSemanticInput[],
): boolean {
  const ledger = createGraphSemanticInputLedger();
  return semanticInputs.every((input) => {
    const source = readSecureCompilerInput(root, resolve(root, input.path));
    addGraphSemanticInput(
      ledger,
      input.path,
      source === undefined ? null : Buffer.byteLength(source, "utf8"),
    );
    return input.contentHash === null
      ? source === undefined
      : source !== undefined && sha256(source) === input.contentHash;
  });
}

/**
 * With `canonicalDirectories`, a file that is not itself a link resolves
 * through its directory's resolution from earlier in the same walk, which is
 * what a full resolution yields while that directory is unchanged. Every read
 * resolves the path in full again afterwards and must reach this same path,
 * so a directory swapped mid-walk is refused rather than followed.
 */
function resolveContainedRepoFile(
  root: string,
  canonicalRoot: string,
  relPath: string,
  canonicalDirectories?: Map<string, string>,
): string {
  const lexicalRoot = resolve(root);
  const absolutePath = resolve(lexicalRoot, relPath);
  if (!isContainedPath(lexicalRoot, absolutePath)) {
    throw sourceContainmentError("Source path escapes the repository root.");
  }
  const canonicalPath = canonicalDirectories
    ? resolveThroughDirectory(absolutePath, canonicalDirectories)
    : realpathSync(absolutePath);
  if (!isContainedPath(canonicalRoot, canonicalPath)) {
    throw sourceContainmentError("Resolved source path escapes the repository root.");
  }
  return canonicalPath;
}

function resolveThroughDirectory(absolutePath: string, canonicalDirectories: Map<string, string>): string {
  const directory = dirname(absolutePath);
  let canonicalDirectory = canonicalDirectories.get(directory);
  if (canonicalDirectory === undefined) {
    canonicalDirectory = realpathSync(directory);
    canonicalDirectories.set(directory, canonicalDirectory);
  }
  const throughDirectory = join(canonicalDirectory, basename(absolutePath));
  return lstatSync(throughDirectory).isSymbolicLink() ? realpathSync(absolutePath) : throughDirectory;
}

function readStableUtf8File(
  canonicalPath: string,
  sourcePath = canonicalPath,
  maxBytes = GRAPH_CORPUS_LIMITS.maxSourceFileBytes,
  // Named explicitly rather than inferred from `maxBytes`. The source and
  // config per-file ceilings are numerically identical, so comparing the value
  // reported every oversized *source* file as a config-limit breach.
  limitName: "maxSourceFileBytes" | "maxConfigFileBytes" = "maxSourceFileBytes",
): {
  source: string;
  size: number;
  modifiedAt: number;
} {
  const before = lstatSync(canonicalPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw sourceContainmentError("Resolved source path is not a stable regular file.");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const fd = openSync(canonicalPath, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw sourceContainmentError("Source path changed before it could be opened.");
    }
    if (!Number.isSafeInteger(opened.size) || opened.size < 0 || opened.size > maxBytes) {
      throw new GraphCorpusLimitError(
        limitName,
        Number.isSafeInteger(opened.size) ? opened.size : undefined,
      );
    }
    const source = readFileSync(fd, "utf8");
    const after = fstatSync(fd);
    const resolvedAfter = realpathSync(sourcePath);
    const pathAfter = lstatSync(resolvedAfter);
    if (!sameFileIdentity(opened, after)
      || !isSameResolvedPath(resolvedAfter, canonicalPath)
      || !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || !sameFileIdentity(opened, pathAfter)) {
      throw sourceContainmentError("Source file changed while it was being read.");
    }
    return { source, size: opened.size, modifiedAt: opened.mtimeMs };
  } finally {
    closeSync(fd);
  }
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

function isContainedPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"));
}

function sourceContainmentError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "GRAPH_SOURCE_PATH_ESCAPE" });
}

function readSecureCompilerInput(root: string, absolutePath: string): string | undefined {
  const lexicalRoot = resolve(root);
  const resolvedPath = resolve(absolutePath);
  const relPath = toPosix(relative(lexicalRoot, resolvedPath));
  if (!relPath || relPath === ".." || relPath.startsWith("../") || isAbsolute(relPath)) {
    throw new GraphSourceStagingError([sourceStagingFailure(
      relPath || ".",
      "read",
      sourceContainmentError("Compiler input escapes the repository root."),
    )]);
  }
  try {
    const canonicalRoot = realpathSync(lexicalRoot);
    const canonicalPath = resolveContainedRepoFile(lexicalRoot, canonicalRoot, relPath);
    return readStableUtf8File(canonicalPath, resolvedPath).source;
  } catch (error) {
    if (isMissingPathError(error)) {
      try {
        assertContainedMissingCompilerInput(lexicalRoot, relPath);
        return undefined;
      } catch (containmentError) {
        throw new GraphSourceStagingError([sourceStagingFailure(relPath, "read", containmentError)]);
      }
    }
    throw new GraphSourceStagingError([sourceStagingFailure(relPath, "read", error)]);
  }
}

function assertContainedMissingCompilerInput(root: string, relPath: string): void {
  const canonicalRoot = realpathSync(root);
  const absolutePath = resolve(root, relPath);
  try {
    if (lstatSync(absolutePath).isSymbolicLink()) {
      throw sourceContainmentError("A missing compiler input is represented by an unresolved symlink.");
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  let ancestor = dirname(absolutePath);
  for (;;) {
    try {
      const canonicalAncestor = realpathSync(ancestor);
      if (!isContainedPath(canonicalRoot, canonicalAncestor)) {
        throw sourceContainmentError("A missing compiler input's resolved ancestor escapes the repository root.");
      }
      return;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      try {
        if (lstatSync(ancestor).isSymbolicLink()) {
          throw sourceContainmentError("A missing compiler input has an unresolved symlink ancestor.");
        }
      } catch (lstatError) {
        if (!isMissingPathError(lstatError)) throw lstatError;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw sourceContainmentError("No stable repository ancestor exists for the missing compiler input.");
      }
      ancestor = parent;
    }
  }
}

function validateCompilerInputs(
  discovered: readonly DiscoveredFile[],
  compiler: CompilerExtractionResult,
  stagedInputHashes: ReadonlyMap<string, string>,
  root: string,
): void {
  const observed = new Map(compiler.semanticInputs.map((input) => [input.filePath, input.contentHash]));
  const discoveredByPath = new Map(discovered.map((file) => [file.relPath, file]));
  const failures: GraphSourceStagingFailure[] = [];
  // A compiler-language file can be deliberately absent from compiler.files
  // when program creation crashes; the engine then extracts its immutable spool
  // bytes with tree-sitter. Exact compiler-consumption validation therefore
  // applies to files that actually produced compiler facts.
  for (const extraction of compiler.files) {
    const file = discoveredByPath.get(extraction.filePath);
    const compilerHash = observed.get(extraction.filePath);
    if (file && compilerHash === file.contentHash) continue;
    failures.push({
      filePath: extraction.filePath,
      operation: "read",
      message: !file
        ? "The TypeScript compiler produced facts for a file outside the staged corpus."
        : compilerHash === undefined
        ? "The TypeScript compiler did not consume the securely staged source."
        : "The TypeScript compiler consumed source bytes that differ from the staged corpus.",
    });
  }
  for (const input of compiler.semanticInputs) {
    const stagedHash = stagedInputHashes.get(input.filePath);
    if (stagedHash !== undefined) {
      if (input.contentHash === null || stagedHash !== input.contentHash) failures.push({
        filePath: input.filePath,
        operation: "read",
        message: "The compiler semantic input differs from the immutable staged bytes.",
      });
      continue;
    }
    const current = readSecureCompilerInput(root, resolve(root, input.filePath));
    const matches = input.contentHash === null
      ? current === undefined
      : current !== undefined && sha256(current) === input.contentHash;
    if (!matches) failures.push({
      filePath: input.filePath,
      operation: "read",
      message: "A compiler semantic input changed while extraction was running.",
    });
  }
  if (failures.length > 0) throw new GraphSourceStagingError(failures);
}

/**
 * Publication is allowed only when the staged semantic corpus still describes
 * the checkout. The final Git read intentionally happens after source and
 * manifest verification so a checkout operation during either read is also
 * observed before the transaction begins.
 */
function verifyPublicationInputs(
  root: string,
  staged: StagedCorpus,
  gitBeforeStaging: GraphGitProvenance,
  sourceFileAccess: GraphSourceFileAccess,
  internal: GraphEngineInternalHooks = {},
): GraphGitProvenance {
  const currentFiles = discoverSourceFiles(root, sourceFileAccess).files;
  const currentManifest = graphManifest(root);
  const failures: GraphSourceStagingFailure[] = [];

  const changedManifestParts = (["manifestHash", "configHash", "grammarHash"] as const)
    .filter((key) => staged[key] !== currentManifest[key]);
  if (changedManifestParts.length > 0) {
    failures.push({
      filePath: ".",
      operation: "discover",
      message: `The graph build manifest changed while the corpus was being staged (${changedManifestParts.join(", ")}).`,
    });
  }

  const stagedSources = new Map(staged.files.map((file) => [file.record.path, file.record.contentHash]));
  const currentSources = new Map(currentFiles.map((file) => [file.relPath, file.contentHash]));
  const paths = [...new Set([...stagedSources.keys(), ...currentSources.keys()])]
    .sort(compareCodePoints);
  for (const filePath of paths) {
    const stagedHash = stagedSources.get(filePath);
    const currentHash = currentSources.get(filePath);
    if (stagedHash === currentHash) continue;
    const change = stagedHash === undefined ? "appeared"
      : currentHash === undefined ? "disappeared"
        : "changed";
    failures.push({
      filePath,
      operation: "discover",
      message: `The supported source ${change} while the graph corpus was being staged.`,
    });
  }

  const semanticInputLedger = createGraphSemanticInputLedger();
  for (const input of staged.semanticInputs) {
    const source = readSecureCompilerInput(root, resolve(root, input.filePath));
    addGraphSemanticInput(
      semanticInputLedger,
      input.filePath,
      source === undefined ? null : Buffer.byteLength(source, "utf8"),
    );
    internal.afterFinalSemanticInputRead?.(input.filePath);
    if (input.contentHash === null ? source === undefined : source !== undefined && sha256(source) === input.contentHash) {
      continue;
    }
    failures.push({
      filePath: input.filePath,
      operation: "read",
      message: "A compiler semantic input changed before graph publication.",
    });
  }

  // Git is deliberately the last checkout observation. A checkout during any
  // source, manifest, or indirect semantic-input verification is therefore
  // caught before snapshot construction and the publication transaction.
  const currentGit = readGraphGitProvenance(root);
  if (gitBeforeStaging.branch !== currentGit.branch || gitBeforeStaging.head !== currentGit.head) {
    failures.push({
      filePath: ".git/HEAD",
      operation: "discover",
      message: "Git branch or HEAD changed while the graph corpus was being staged.",
    });
  }

  if (failures.length > 0) throw new GraphSourceStagingError(failures);
  return currentGit;
}

function sourceStagingFailure(
  filePath: string,
  operation: GraphSourceStagingFailure["operation"],
  error: unknown,
): GraphSourceStagingFailure {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "") || undefined
    : undefined;
  return {
    filePath,
    operation,
    ...(code ? { code } : {}),
    message: error instanceof Error ? error.message : String(error),
  };
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = String((error as { code?: unknown }).code ?? "");
  return code === "ENOENT" || code === "ENOTDIR";
}

export function graphManifest(root: string): GraphManifest {
  const configSources = discoverGraphConfigSources(root);
  const configHash = configHashForSources(configSources);
  const grammarHash = grammarManifestHash();
  const inputs: GraphManifestInputs = {
    db: DB_SCHEMA_VERSION,
    compiler: TYPESCRIPT_COMPILER_VERSION,
    extractor: CORPUS_EXTRACTOR_VERSION,
    resolver: RESOLVER_VERSION,
    corpusPolicyHash: graphCorpusPolicyHash(root),
    grammarHash,
    configHash,
  };
  return {
    manifestHash: graphManifestHash(inputs),
    configHash,
    grammarHash,
    inputs: Object.freeze(inputs),
  };
}

/**
 * Fold manifest inputs in one fixed order.
 *
 * Exported so a reader can re-fold *these* inputs with a different config hash
 * and compare the result to a stored manifest. That substitution is the only
 * supported way to ask whether a stored manifest and the current one differ by
 * config alone, so the preimage must never be constructed anywhere else.
 */
export function graphManifestHash(inputs: GraphManifestInputs): string {
  return sha256(JSON.stringify({
    db: inputs.db,
    compiler: inputs.compiler,
    extractor: inputs.extractor,
    resolver: inputs.resolver,
    corpusPolicyHash: inputs.corpusPolicyHash,
    grammarHash: inputs.grammarHash,
    configHash: inputs.configHash,
  }));
}

/**
 * True when a stored manifest is reproducible from the current engine identity
 * and the config hash that store recorded — that is, when config content is the
 * only manifest input that moved.
 *
 * This deliberately proves identity by reconstruction rather than by comparing
 * a stored engine-identity field. A store written before this check existed
 * records no such field, and those are exactly the stores that need to keep
 * answering. Reconstruction also covers `corpusPolicyHash`, which no snapshot
 * records at all, so an ignore-policy change cannot pass as config drift.
 *
 * Fails closed on anything it cannot prove: a store with no recorded config
 * hash, or one whose manifest does not reproduce, is not config-drifted.
 */
export function graphManifestDiffersOnlyByConfig(
  current: GraphManifest,
  storedManifestHash: string | undefined,
  storedConfigHash: string | undefined,
): boolean {
  if (typeof storedManifestHash !== "string" || typeof storedConfigHash !== "string") return false;
  if (storedManifestHash === current.manifestHash) return false;
  if (storedConfigHash === current.configHash) return false;
  return graphManifestHash({ ...current.inputs, configHash: storedConfigHash }) === storedManifestHash;
}

function discoverGraphConfigSources(root: string): Map<string, string> {
  let canonicalRoot: string;
  let configPaths: string[];
  try {
    canonicalRoot = realpathSync(root);
    configPaths = discoverBoundedGraphPaths([...GRAPH_CONFIG_GLOBS], {
      ...GRAPH_CORPUS_GLOB_OPTIONS,
      cwd: root,
      ignore: graphCorpusIgnoreGlobs(root),
    }, GRAPH_CORPUS_LIMITS.maxConfigFiles).map(toPosix);
  } catch (error) {
    throw new GraphSourceStagingError([sourceStagingFailure(".", "discover", error)]);
  }
  let configBytes = 0;
  const configs = configPaths.map((path) => {
    try {
      const canonicalPath = resolveContainedRepoFile(root, canonicalRoot, path);
      const file = readStableUtf8File(
        canonicalPath,
        resolve(root, path),
        GRAPH_CORPUS_LIMITS.maxConfigFileBytes,
        "maxConfigFileBytes",
      );
      configBytes = addGraphCorpusBytes(
        configBytes,
        Buffer.byteLength(file.source, "utf8"),
        "config",
      );
      return [path, file.source] as const;
    } catch (error) {
      throw new GraphSourceStagingError([sourceStagingFailure(path, "read", error)]);
    }
  });
  return new Map(configs);
}

/**
 * Identify config inputs by what they contribute to extraction, not by bytes.
 *
 * Hashing raw content made a dependency bump, an npm script or a reindent
 * indistinguishable from a change to module resolution, and every one of them
 * invalidated the index. `graphConfigIdentity` projects each file down to the
 * fields that decide what the compiler resolves, and falls back to exact bytes
 * for anything it cannot parse or recognize.
 */
function configHashForSources(configSources: ReadonlyMap<string, string>): string {
  return sha256(JSON.stringify([...configSources.entries()]
    .map(([path, source]) => [path, sha256(graphConfigIdentity(path, source))])
    .sort(([left], [right]) => compareCodePoints(left!, right!))));
}

function healthCounts(files: StagedFile[]): { ok: number; partial: number; failed: number } {
  return {
    ok: files.filter((file) => file.record.parseStatus === "ok").length,
    partial: files.filter((file) => file.record.parseStatus === "partial").length,
    failed: files.filter((file) => file.record.parseStatus === "failed").length,
  };
}

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bodyHash(sourceLines: string[], startLine: number, endLine: number): string {
  return sha256(sourceLines.slice(startLine - 1, endLine).join("\n").replace(/\s+/g, " ").trim());
}
