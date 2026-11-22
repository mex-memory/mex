import { processGraphSizing } from "./sizing.js";
import { assertTextSource, unavailableFileReason } from "./source-errors.js";
import { discoverGraphReadPaths } from "./read-discovery.js";
import { skippedByRule } from "../file-index/discover.js";
import { graphCoverage } from "./read-coverage.js";
import { currentGraphPath, graphStoragePathAllowed } from "./storage.js";
import { graphManifest, configHashForSources, discoverGraphConfigSources, corpusExtractorVersion, RESOLVER_VERSION, type GraphManifest } from "./manifest.js";
export { graphManifest, graphManifestHash, graphManifestDiffersOnlyByConfig, type GraphManifest, type GraphManifestInputs } from "./manifest.js";
import { GraphSourceStagingError, type GraphSourceStagingFailure } from "./source-errors.js";
export { GraphSourceStagingError, type GraphSourceStagingFailure } from "./source-errors.js";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpath,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { lstat as lstatAsync, open as openAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isSameResolvedPath, toPosix } from "../paths.js";
import type {
  BuildResult, GraphEngine, GraphEngineReport, GraphPublicationReport, NodeSearchOptions, SkippedSourceFile,
} from "./engine.js";
import { engineFileExtractorVersion, graphEngineHandlesEcmaScript, graphEngineLanguageFamily, graphEngineLanguages, TREE_SITTER_EXTRACTOR_VERSION } from "./engine-languages.js";
import type { EngineStagedFile } from "./native-engine.js";
import {
  GRAPH_CORPUS_GLOB_OPTIONS,
  graphCorpusIgnoreGlobs,
  GRAPH_CORPUS_LIMITS,
  GRAPH_SUPPORTED_SOURCE_GLOB,
  GraphCorpusLimitError,
  addGraphCorpusBytes,
  discoverBoundedGraphPaths,
  isPerFileCorpusLimitError,
} from "./corpus-policy.js";
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
  canonicalNodeIdentity,
  detectLanguage,
  extractFile,
  grammarManifestHash,
  isSupportedSourceFile,
  loadGrammars,
  normalizedAstTokens,
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
  createGraphSnapshot,
  parseGraphSnapshot,
  readGraphGitProvenance,
  gitProvenanceChanged,
  serializeGraphSnapshot,
  type GraphGitProvenance,
  type GraphSnapshot,
} from "./snapshot.js";
import { getCallees, getCallers, getIncoming, getOutgoing } from "./traversal/traversal.js";
import { recordGraphMemory, recordGraphPhase, timeGraphPhase, timeGraphPhaseAsync } from "./phase-timing.js";
import { recallSource, rememberSource, reserveHeldBytes } from "./source-memo.js";
import type { GraphEdge, GraphNode, Language, ReferenceKind } from "./types.js";

const BODY_KINDS = new Set<GraphNode["kind"]>([
  "function", "method", "class", "interface", "enum", "type_alias", "struct",
  "trait", "protocol", "constant", "variable", "component",
  // Class properties and fields carry behaviour (defaults, visibility), so
  // facts about them need a body hash and fingerprint to be grounded.
  "property", "field",
]);

export interface GraphEngineOptions {
  rootDir: string;
  dbPath?: string;
  /** Query-only engine for sandboxed agent commands. Build/sync are unavailable. */
  readOnly?: boolean;
  /** Injectable source-file access for embedders and deterministic fault tests. */
  sourceFileAccess?: Partial<GraphSourceFileAccess>;
}

interface GraphEngineInternalHooks {
  /** Parent-owned workspace for cleanup after a candidate process aborts. */
  sourceSpoolDirectory?: string;
  /** Skip engine staging when the standalone engine job already failed. */
  engineFallbackReason?: string;
  /** Numeric construction progress; never carries source paths or content. */
  onBuildProgress?: (progress: {
    phase: "parse" | "resolve";
    completed?: number;
    total?: number;
  }) => void;
  afterSourcesStaged?: () => void;
  afterExtraction?: () => void;
  /** Called as a full extraction starts, with the previous cache payloads still held. */
  beforeFullExtraction?: (retainedPayloads: number) => void;
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

/**
 * Immutable, process-private source staging on disk.
 *
 * Tree-sitter languages are read and extracted one file at a time from this
 * spool. Sources are loaded on demand for Node's extraction and resolution.
 *
 * Inside a maintenance operation, staged bytes are held in memory while the
 * operation's bounded source budget allows (see source-memo), and only the
 * rest is written to disk; either way a read returns exactly the staged
 * bytes.
 */
export class GraphSourceSpool {
  readonly directory: string;
  private readonly entries = new Map<string, string>();
  private readonly held = new Map<string, string>();
  private disposed = false;

  constructor(parentDirectory = tmpdir(), private readonly diskOnly = false) {
    this.directory = mkdtempSync(join(parentDirectory, "mex-graph-stage-"));
  }

  stage(relPath: string, source: string): void {
    if (this.disposed) throw new Error("The graph source spool is closed.");
    if (this.entries.has(relPath) || this.held.has(relPath)) throw new Error(`Duplicate staged source: ${relPath}`);
    if (!this.diskOnly && reserveHeldBytes(Buffer.byteLength(source, "utf8"))) {
      this.held.set(relPath, source);
      return;
    }
    const stagedPath = join(this.directory, `${String(this.entries.size).padStart(8, "0")}.source`);
    writeFileSync(stagedPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
    this.entries.set(relPath, stagedPath);
  }

  /** Private basename passed to an engine job reading its captured input. */
  capturedName(path: string): string {
    const entry = this.entries.get(path);
    if (!entry || this.disposed) throw new Error("The immutable graph source spool is unavailable.");
    return basename(entry);
  }

  read(file: DiscoveredFile): string {
    const held = this.disposed ? undefined : this.held.get(file.relPath);
    if (held !== undefined) return held;
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
    this.held.clear();
  }
}

const NODE_SOURCE_FILE_ACCESS: GraphSourceFileAccess = {
  stat: (absolutePath) => statSync(absolutePath),
  read: (absolutePath) => readFileSync(absolutePath, "utf-8"),
};

export interface DiscoveredFile {
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
export interface DiscoveredCorpus {
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
  frameworksResolved?: boolean;
  /**
   * Present on files the Rust engine staged: its sketches by node id, which
   * fingerprinting uses instead of tokenizing the file again.
   */
  sketches?: Map<string, { minhash: number[]; tokenCount: number }>;
}

interface StagedCorpus {
  files: StagedFile[];
  /** What the Rust graph engine built; absent unless it was asked to build a language. */
  engine?: GraphEngineReport;
  /** Files discovered but not indexed, carried through to the build result. */
  skipped: GraphSkippedSourceFile[];
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
  entries: Array<{ path: string; contentHash: string; payload: Uint8Array; changed: boolean }>;
}

/** What a refresh may reuse from the stored graph (issue #209). */
interface ExtractionReuse {
  identity: string | null;
  stored: Map<string, StoredExtraction>;
  /** Stored fingerprint sketches by node id; neighbours are always recomputed. */
  fingerprints: ReadonlyMap<string, Pick<Fingerprint, "minhash" | "tokenCount">>;
  /** Stored file records, to know which files' sketches still hold. */
  records: ReadonlyMap<string, FileRecord>;
}

const EXTRACTION_CACHE_IDENTITY_KEY = "extraction_cache_identity";
class GraphEngineImpl implements GraphEngine {
  private readonly rootDir: string;
  private dbPath: string;
  private readonly readOnly: boolean;
  private readonly immutable: boolean;
  private readonly managed: boolean;
  private readonly sourceFileAccess: GraphSourceFileAccess;
  private readonly internal: GraphEngineInternalHooks;
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
    this.dbPath = options.dbPath ?? currentGraphPath(this.rootDir);
    if (options.dbPath !== undefined && options.readOnly !== true && /^graph-base-[a-z0-9-]+\.db$/.test(basename(this.dbPath)) && graphStoragePathAllowed(this.rootDir, this.dbPath)) throw new Error("Published graphs are immutable");
    this.managed = options.dbPath === undefined;
    this.readOnly = options.readOnly ?? false;
    this.immutable = options.immutable ?? false;
    this.sourceFileAccess = options.sourceFileAccess
      ? { ...NODE_SOURCE_FILE_ACCESS, ...options.sourceFileAccess }
      : NODE_SOURCE_FILE_ACCESS;
    this.internal = (options as GraphEngineOptions & GraphEngineInternalOptions)
      .__internalGraphEngineHooks ?? {};
    this.refreshStrategy = options.__internalRefreshStrategy ?? "incremental";
    if (database) {
      this.db = database;
      this.store = new GraphStore(database);
    }
  }

  private getStore(allowRebuild = false): GraphStore {
    if (!this.store) {
      this.internal.beforeDatabaseOpen?.();
      this.db = timeGraphPhase("engine.openDatabase", () => openGraphDatabase(this.dbPath, {
        allowRebuild,
        readOnly: this.readOnly || this.managed,
        immutable: this.immutable || this.managed,
      }));
      this.store = new GraphStore(this.db);
    }
    return this.store;
  }

  async build(rootDir?: string): Promise<BuildResult> {
    if (this.managed && !this.readOnly) {
      this.close();
      const { rebuildGraph } = await import("./maintenance.js");
      const result = await rebuildGraph(rootDir ?? this.rootDir);
      this.dbPath = currentGraphPath(this.rootDir);
      return { ...result, skipped: result.skipped ? [...result.skipped] : undefined };
    }
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
      { reason: "a rebuild extracts in full" },
    );
    try {

      const { publication: _publication, ...result } = await this.publish(staged, root, gitBeforeStaging, false);
      return { ...result, durationMs: Date.now() - started };
    } finally {
      timeGraphPhase("stage.disposeSpool", () => staged.sourceSpool.dispose());
    }
  }

  async sync(changedFiles: string[]): Promise<BuildResult> {
    if (this.managed && !this.readOnly) {
      this.close();
      const { refreshGraph } = await import("./maintenance.js");
      const result = await refreshGraph(this.rootDir);
      this.dbPath = currentGraphPath(this.rootDir);
      return { ...result, skipped: result.skipped ? [...result.skipped] : undefined };
    }
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
      const corpus = await timeGraphPhaseAsync("sync.discover", () =>
        discoverSourceFilesConcurrently(this.rootDir, this.sourceFileAccess, sourceSpool));
      if (changedSources.length === 0) {
        const unchanged = unchangedGraphSnapshot(store, gitBeforeStaging, manifest, corpus.files);
        if (unchanged && !(unchanged.engineFallback
          && (await import("./native-engine.js")).graphEngineBinary())) {
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
      : timeGraphPhase("stage.loadCache", () => loadExtractionReuse(store));
    const staged = await timeGraphPhaseAsync("stage.total", () => stageCorpus(
      this.rootDir,
      manifest,
      this.sourceFileAccess,
      this.internal,
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

      const previousFiles = new Map(this.getStore(true).getAllFileRecords()
        .map((file) => [file.path, file.contentHash]));
      const filesChanged = staged.files.filter((file) => previousFiles.get(file.record.path) !== file.record.contentHash)
        .length + [...previousFiles.keys()].filter((path) => !stagedByPath.has(path)).length;
      const { publication, ...result } = await timeGraphPhaseAsync("publish.total", () => this.publish(
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
      timeGraphPhase("stage.disposeSpool", () => staged.sourceSpool.dispose());
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

  private async publish(
    staged: StagedCorpus,
    root: string,
    gitBeforeStaging: GraphGitProvenance,
    allowDelta: boolean,
  ): Promise<Omit<BuildResult, "durationMs"> & { publication: GraphPublicationReport }> {
    this.internal.beforePublication?.();
    const store = this.getStore(true);
    const freshNodes = staged.files.flatMap((file) => file.nodes);
    // Incremental publication (issue #209): rewrite only the files whose
    // owned rows changed. Any reason it cannot is a full publication, which
    // also records the digests the next refresh compares against.
    const grouped = timeGraphPhase("publish.rowGroups", () => groupRowsByFile(staged.files, staged.fingerprints));
    recordGraphMemory("publish.afterRowGroups");
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
    const git = await timeGraphPhaseAsync("publish.verifyInputs", () => verifyPublicationInputs(
      root,
      staged,
      gitBeforeStaging,
      this.sourceFileAccess,
    ));
    let edgeCount = 0;
    const expectedNodes = staged.files.reduce((count, file) => count + file.nodes.length, 0);
    const snapshot = createGraphSnapshot({
      indexedAt: new Date().toISOString(),
      git,
      schemaVersion: DB_SCHEMA_VERSION,
      extractorVersion: corpusExtractorVersion(),
      resolverVersion: RESOLVER_VERSION,
      grammarHash: staged.grammarHash,
      configHash: staged.configHash,
      manifestHash: staged.manifestHash,
      sources: staged.files.map((file) => ({
        path: file.record.path,
        contentHash: file.record.contentHash,
        parseStatus: file.record.parseStatus ?? "ok",
      })),
      ...(staged.engine && staged.engine.fallbackFiles > 0 ? {
        engineFallback: {
          languages: staged.engine.languages,
          files: staged.engine.files,
          fallbackFiles: staged.engine.fallbackFiles,
          ...(staged.engine.fellBack ? { fellBack: staged.engine.fellBack } : {}),
        },
      } : {}),
    });
    const serializedSnapshot = serializeGraphSnapshot(snapshot);

    recordGraphMemory("publish.beforeTransaction");
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
      timeGraphPhase("publish.coverage", () => {
        // Rows only for files the corpus considered and did not index; every
        // other path's coverage follows from `files` (see coverageFor).
        this.db!.exec("CREATE TABLE IF NOT EXISTS coverage(path TEXT PRIMARY KEY, reason TEXT NOT NULL) WITHOUT ROWID; DELETE FROM coverage;");
        const cover = this.db!.prepare("INSERT OR REPLACE INTO coverage(path,reason) VALUES(?,?)");
        for (const file of staged.files) if (file.record.parseStatus === "failed") cover.run(file.record.path, "parse failed");
        for (const file of staged.skipped) cover.run(file.filePath, file.reason === "corpus-limit" ? "too big" : file.reason);
      });
      timeGraphPhase("publish.invariants", () => store.validateInvariants(expectedNodes));
      // A refresh can start from a database published by the retired route.
      for (const key of ["compiler_version", "typescript_compilers", "extraction_project_states", "extraction_project_inputs"]) {
        store.deleteMetadata(key);
      }
      store.setMetadata("extractor_version", corpusExtractorVersion());
      store.setMetadata("resolver_version", RESOLVER_VERSION);
      store.setMetadata("config_hash", staged.configHash);
      store.setMetadata("grammar_hash", staged.grammarHash);
      store.setMetadata(GRAPH_COVERAGE_METADATA_KEY, coverage);
      store.setMetadata(GRAPH_SNAPSHOT_METADATA_KEY, serializedSnapshot);
      store.setMetadata(EXTRACTION_CACHE_IDENTITY_KEY, staged.extraction.cache.identity);
      if ("reason" in grouped) store.deleteMetadata(INCREMENTAL_STATE_METADATA_KEY);
      else store.setMetadata(INCREMENTAL_STATE_METADATA_KEY, incrementalStateMarker(serializedSnapshot));
      markGraphReady(this.db!, staged.manifestHash);
    });
    recordGraphMemory("publish.afterTransaction");

    return {
      filesIndexed: staged.files.length,
      nodesCreated: expectedNodes,
      edgesCreated: edgeCount,
      health: healthCounts(staged.files),
      ...(staged.skipped.length > 0 ? { skipped: [...staged.skipped] } : {}),
      ...(staged.engine ? { engine: staged.engine } : {}),
      ...(delta ? { [DELTA_AUDIT_SCOPE]: [...delta.rewritten.map((group) => group.path), ...delta.removed] } : {}),
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
    timeGraphPhase("publish.insert.edges", () => {
      edgeCount = store.insertEdges(staged.files.flatMap((file) => file.edges));
    });
    for (const file of staged.files) {
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
    return this.getStore().search(query, options).filter(node => this.fileVisible(node.filePath));
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

  getNode(id: string): GraphNode | null { const node = this.getStore().getNodeById(id); return node && this.fileVisible(node.filePath) ? node : null; }
  getCallers(id: string): GraphNode[] { return getCallers(this.getStore(), id).filter(node => this.fileVisible(node.filePath)); }
  getCallees(id: string): GraphNode[] { return getCallees(this.getStore(), id).filter(node => this.fileVisible(node.filePath)); }
  getIncoming(id: string, kinds?: GraphEdge["kind"][]) { return getIncoming(this.getStore(), id, kinds); }
  getOutgoing(id: string, kinds?: GraphEdge["kind"][]) { return getOutgoing(this.getStore(), id, kinds); }

  private coverageStatement?: { db: SqliteDatabase; statement: ReturnType<SqliteDatabase["prepare"]> | null };
  /** The coverage row of one path, or undefined when it has none (or the graph predates coverage). */
  private coverageRow(path: string): string | undefined {
    this.getStore();
    if (this.coverageStatement?.db !== this.db) {
      const has = !!this.db!.prepare("SELECT 1 FROM sqlite_master WHERE name='coverage' AND type='table'").get();
      this.coverageStatement = { db: this.db!, statement: has ? this.db!.prepare("SELECT reason FROM coverage WHERE path=?") : null };
    }
    const row = this.coverageStatement.statement?.get(path) as { reason: string } | undefined;
    return row?.reason;
  }

  private fileVisible(path: string): boolean { return this.coverageRow(path) === undefined; }

  coverageFor(path: string): { indexed: true } | { indexed: false; reason: string } {
    const relativePath = toPosix(relative(this.rootDir, resolve(this.rootDir, path)));
    return graphCoverage(relativePath, this.coverageRow(relativePath), this.getStore().getFileRecord(relativePath) !== null, this.rootDir);
  }

  close(): void {
    if (this.db) this.db.close();
    this.db = null;
    this.store = null;
  }
}

/**
 * The snapshot a refresh of `store` would leave unchanged, or null: exactly
 * the check `sync` applies before any staging. The manifest, the branch, every
 * source file still match; only coverage and
 * the recorded HEAD can still move.
 */
function unchangedGraphSnapshot(
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
export function refreshWouldPublishNothing(
  rootDir: string,
  dbPath: string,
  options: { sourcesInspected?: boolean } = {},
): boolean {
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
    if (options.sourcesInspected) {
      // A fresh or degraded inspection of these exact bytes already found the
      // manifest, branch and every source file unchanged. Only HEAD and
      // coverage remain to compare.
      const snapshot = parseGraphSnapshot(store.getMetadata(GRAPH_SNAPSHOT_METADATA_KEY));
      return snapshot !== null
        && store.getMetadata("manifest_hash") === snapshot.manifestHash
        && snapshot.indexedBranch === git.branch
        && snapshot.indexedHead === git.head
        && store.getMetadata(GRAPH_COVERAGE_METADATA_KEY) === captureGraphCoverage(root);
    }
    const manifest = graphManifest(root);
    if (store.getMetadata("manifest_hash") !== manifest.manifestHash) return false;
    const corpus = timeGraphPhase("envelope.noOpDiscover", () => discoverSourceFiles(root, NODE_SOURCE_FILE_ACCESS).files);
    const snapshot = unchangedGraphSnapshot(store, git, manifest, corpus);
    return snapshot !== null
      && snapshot.indexedHead === git.head
      && store.getMetadata(GRAPH_COVERAGE_METADATA_KEY) === captureGraphCoverage(root);
  } finally {
    db.close();
  }
}

/**
 * @internal The files a delta publication rewrote, carried on its in-process
 * build result for the candidate's change-sized fingerprint audit. A result
 * that crossed a process boundary never carries it, and is audited in full.
 */
export const DELTA_AUDIT_SCOPE: unique symbol = Symbol("mex.graph.deltaAuditScope");

export function deltaAuditScope(result: BuildResult): readonly string[] | undefined {
  const scope = (result as BuildResult & { [DELTA_AUDIT_SCOPE]?: readonly string[] })[DELTA_AUDIT_SCOPE];
  return Array.isArray(scope) ? scope : undefined;
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
 * digests must describe the stored snapshot.
 */
function loadExtractionReuse(store: GraphStore): ExtractionReuse | { reason: string } {
  if (!incrementalStateIsCurrent(store)) return { reason: "no extraction cache describes the stored graph" };
  const fingerprints = new Map<string, Pick<Fingerprint, "minhash" | "tokenCount">>();
  for (const row of store.getFingerprintSketches()) {
    fingerprints.set(row.nodeId, { minhash: decodeMinhash(row.minhash), tokenCount: row.tokenCount });
  }
  return {
    identity: store.getMetadata(EXTRACTION_CACHE_IDENTITY_KEY),
    stored: store.getExtractionCache(),
    fingerprints,
    records: new Map(store.getAllFileRecords().map((record) => [record.path, record])),
  };
}

async function stageCorpus(
  root: string,
  manifest = graphManifest(root),
  sourceFileAccess: GraphSourceFileAccess = NODE_SOURCE_FILE_ACCESS,
  internal: GraphEngineInternalHooks = {},
  reuse: ExtractionReuse | { reason: string } = { reason: "a full extraction was requested" },
  /** A corpus already discovered into its spool; staging takes ownership of the spool. */
  prepared?: PreparedCorpus,
): Promise<StagedCorpus> {
  const sourceSpool = prepared?.sourceSpool ?? new GraphSourceSpool(internal.sourceSpoolDirectory);
  try {
    const { files: discovered, skipped } = prepared?.corpus ?? await timeGraphPhaseAsync("stage.discover", () =>
      discoverSourceFilesConcurrently(root, sourceFileAccess, sourceSpool));
    const configSources = timeGraphPhase("stage.config", () => discoverGraphConfigSources(root));
    const stagedConfigHash = configHashForSources(configSources);
    if (stagedConfigHash !== manifest.configHash) {
      throw new GraphSourceStagingError([{
        filePath: ".",
        operation: "discover",
        message: "The graph configuration (configHash) changed before semantic staging began.",
      }]);
    }

    internal.afterSourcesStaged?.();
    const engine = await timeGraphPhaseAsync("stage.engine", () => stageWithGraphEngine(
      root, discovered, graphEngineLanguages(), configSources,
      internal.sourceSpoolDirectory, internal.engineFallbackReason,
    ));
    internal.afterExtraction?.();
    const reportParsed = (completed: number): void => internal.onBuildProgress?.({
      phase: "parse",
      completed,
      ...(discovered.length > 0 ? { total: discovered.length } : {}),
    });
    reportParsed(0);

    // Only Node's pre-resolution extractions are cached here. The engine
    // stages its own corpus as a unit, including cross-file resolution.
    const identity = extractionCacheIdentity(manifest.manifestHash, configSources);
    const plan: IncrementalExtractionPlan | { reason: string } = "reason" in reuse ? reuse
      : reuse.identity !== identity ? { reason: "the configuration or the engine changed" }
      : timeGraphPhase("stage.plan", () => planIncrementalExtraction(
        reuse.stored,
        new Map(discovered.filter((file) => !engine?.files.has(file.relPath))
          .map((file) => [file.relPath, file.contentHash])),
      ));
    if ("reason" in plan) {
      if (!("reason" in reuse)) reuse.stored.clear();
      internal.beforeFullExtraction?.(0);
    }
    const treeLanguages = [...new Set(discovered
      .filter((file) => !engine?.files.has(file.relPath))
      .map((file) => detectLanguage(file.relPath)))];
    await timeGraphPhaseAsync("stage.loadGrammars", () => loadGrammars(treeLanguages));

    const storedExtraction = "reason" in reuse ? new Map<string, StoredExtraction>() : reuse.stored;
    const cacheEntries = new Map<string, ExtractionCacheState["entries"][number]>();
    const setCacheEntry = (path: string, contentHash: string, payload: Uint8Array): void => {
      const previous = storedExtraction.get(path);
      const changed = !previous || previous.contentHash !== contentHash
        || !Buffer.from(previous.payload).equals(Buffer.from(payload));
      cacheEntries.set(path, { path, contentHash, payload, changed });
    };
    const cachedTrees = "reason" in plan ? undefined : plan.trees;

    let parsed = 0;
    let treesExtracted = 0;
    const files = discovered.map((file) => {
      reportParsed(++parsed);
      const engineFile = engine?.files.get(file.relPath);
      if (engineFile) {
        engine!.files.delete(file.relPath);
        return timeGraphPhase("stage.engineFiles", () => stageEngineFile(file, engineFile));
      }
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
      setCacheEntry(file.relPath, file.contentHash, encodeCachedExtraction(cachedTreeFile(staged)));
      return staged;
    });
    if (engine && engine.report.fallbackFiles > 0) demoteDanglingEngineEdges(files);
    if (!("reason" in plan)) plan.trees.clear();
    storedExtraction.clear();
    internal.onBuildProgress?.({ phase: "resolve" });
    timeGraphPhase("stage.resolve", () =>
      stageFrameworkAndFallbackResolution(root, files, configSources, sourceSpool));
    timeGraphPhase("stage.validate", () => validateStagedCorpus(files));
    const fingerprints = timeGraphPhase("stage.fingerprints", () => stageFingerprints(
      files,
      sourceSpool,
      "reason" in reuse ? undefined : reuse,
    ));
    recordGraphMemory("stage.afterFingerprints");
    return {
      files,
      ...(engine ? { engine: engine.report } : {}),
      skipped,
      fingerprints,
      sourceSpool,
      ...manifest,
      extraction: {
        mode: "reason" in plan ? "full" : "incremental",
        ...("reason" in plan ? { fallbackReason: plan.reason } : {}),
        filesReextracted: treesExtracted + (engine?.report.files ?? 0),
        cache: {
          identity,
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
function stageFrameworkAndFallbackResolution(
  root: string,
  files: StagedFile[],
  configSources: ReadonlyMap<string, string>,
  sourceSpool: GraphSourceSpool,
): void {
  if (files.every((file) => file.frameworksResolved)) return;
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
    if (file.record.parseStatus !== "ok" || file.frameworksResolved) continue;
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
    && ref.resolver !== "lexical-containment"
    // The Rust engine already resolved its files; what it left unresolved it
    // could not prove, and a name match here would only guess.
    && !ref.resolver?.startsWith("engine-"),
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
    if (nodes.length === 0) continue;
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
      continue;
    }
    // The engine sketched its own nodes; framework nodes added after it are
    // tokenized as today.
    const engineSketches = file.sketches;
    const unsketched = engineSketches ? nodes.filter((node) => !engineSketches.has(node.id)) : nodes;
    let tokens = new Map<string, string[]>();
    if (unsketched.length > 0) {
      tokens = normalizedAstTokens(file.record.path, sourceSpool.read(file.discovered), unsketched);
    }
    for (const node of nodes) {
      const sketch = engineSketches?.get(node.id);
      if (sketch) {
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
        continue;
      }
      pending.push({
        nodeId: node.id,
        fingerprint: fingerprintBuilder.create(
          tokens.get(node.id) ?? [],
          [...(callersByTarget.get(node.id) ?? [])],
          [...(calleesBySource.get(node.id) ?? [])],
        ),
      });
    }
  }
  return pending;
}

interface EngineStaging {
  files: Map<string, EngineStagedFile>;
  report: GraphEngineReport;
}

/** Memory cap and deadline for one engine stage job. */
const ENGINE_STAGE_LIMITS = { memoryMb: 2048, deadlineMs: 30 * 60_000 };

/**
 * Stage `languages` with the Rust engine (OSS-73), streamed as rows for
 * today's schema v4 store. The engine extracts and resolves every file of
 * those languages in one job. Any failure keeps today's extractors for every
 * file and says why in the report; staging never fails because of it.
 */
async function stageWithGraphEngine(
  root: string,
  discovered: readonly DiscoveredFile[],
  languages: string[],
  configs: ReadonlyMap<string, string>,
  requestDir: string | undefined,
  forcedFallback?: string,
): Promise<EngineStaging | undefined> {
  const paths = discovered.filter((file) => {
    const language = detectLanguage(file.relPath);
    return languages.includes(graphEngineLanguageFamily(language));
  });
  if (paths.length === 0) return undefined;
  const requested = new Map(paths.map((file) => [file.relPath, file]));
  const requestedLanguages = [...new Set(paths.map((file) => graphEngineLanguageFamily(detectLanguage(file.relPath))))].sort();
  const files = new Map<string, EngineStagedFile>();
  const fellBack = (reason: string): EngineStaging => {
    files.clear();
    return { files, report: { languages: requestedLanguages, files: 0, fallbackFiles: paths.length, fellBack: reason } };
  };
  if (forcedFallback) return fellBack(forcedFallback);
  const { graphEngineBinary, graphEngineVersion, graphEngineFailureReason, runGraphEngine } = await import("./native-engine.js");
  const binary = graphEngineBinary();
  if (!binary) return fellBack("no mex-graph binary was found");
  const version = graphEngineVersion(binary);
  if ("problem" in version) return fellBack(version.problem);
  const enabled = requestedLanguages.flatMap((language) =>
    language === "typescript" ? [language, "tsx"] : language === "javascript" ? [language, "jsx"] : [language]);
  const seen = new Set<string>();
  let run: Awaited<ReturnType<typeof runGraphEngine>>;
  try {
    run = await runGraphEngine(binary, {
      mode: "stage",
      root,
      files: paths.map((file) => ({ path: file.relPath, size: file.size })),
      ...(graphEngineHandlesEcmaScript(requestedLanguages) ? {
        configs: [...configs].map(([path, source]) => ({ path, source })),
      } : {}),
      languages: enabled,
      frameworks: true,
      limits: ENGINE_STAGE_LIMITS,
    }, {
      requestDir,
      onEvent: (event) => {
        if (event.type !== "staged" && event.type !== "file") return;
        const source = requested.get(event.path);
        if (!source || seen.has(event.path)) return;
        seen.add(event.path);
        // The engine read the path itself. A read that no longer matches
        // discovery falls back to the exact bytes in Node's source spool.
        if (event.type === "staged" && event.contentHash === source.contentHash) files.set(event.path, event);
      },
    });
  } catch {
    return fellBack("the engine job could not be started");
  }
  if (run.exitCode !== 0 || !run.result) {
    // Codes only: the report crosses the candidate boundary, where no path may.
    return fellBack(graphEngineFailureReason(run));
  }
  if (seen.size !== paths.length) return fellBack("the engine did not report every requested file");
  if (files.size !== paths.length) {
    // Framework detection and handler resolution can depend on any engine
    // file. If one read disagreed with discovery, rerun that pass over the
    // authoritative spool, including the unrelated files the engine staged.
    for (const file of files.values()) {
      if (!file.frameworksResolved) continue;
      file.frameworksResolved = false;
      const frameworkIds = new Set(file.edges
        .filter((edge) => edge.kind === "contains" && edge.provenance === "framework")
        .map((edge) => edge.target));
      file.nodes = file.nodes.filter((node) => !frameworkIds.has(node.id));
      file.edges = file.edges.filter((edge) => edge.provenance !== "framework");
      file.unresolved = file.unresolved.filter((ref) => !frameworkIds.has(ref.fromNodeId));
    }
  }
  return {
    files,
    report: {
      languages: requestedLanguages, files: files.size, fallbackFiles: paths.length - files.size,
      wallMs: run.result.usage.wallMs, peakRssMb: run.result.usage.peakRssMb,
    },
  };
}

/** One engine-staged file in the shape `stageTreeFile` produces. */
function stageEngineFile(discovered: DiscoveredFile, staged: EngineStagedFile): StagedFile {
  const now = Date.now();
  const sketches = new Map<string, { minhash: number[]; tokenCount: number }>();
  const nodes = staged.nodes.map(({ minhash, tokenCount, ...node }) => {
    if (minhash && tokenCount !== undefined) sketches.set(node.id, { minhash, tokenCount });
    return { ...node, updatedAt: now };
  });
  const health = staged.health;
  return {
    discovered,
    record: {
      path: discovered.relPath,
      contentHash: discovered.contentHash,
      language: staged.language,
      size: discovered.size,
      modifiedAt: discovered.modifiedAt,
      indexedAt: now,
      nodeCount: nodes.length,
      errors: health.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      parseStatus: health.status,
      diagnosticCount: health.diagnosticCount,
      missingCount: health.missingCount,
      errorCoverage: health.errorCoverage,
      extractorVersion: engineFileExtractorVersion(staged.language),
    },
    nodes,
    edges: staged.edges,
    references: staged.unresolved,
    imports: staged.imports ?? [],
    sketches,
    frameworksResolved: staged.frameworksResolved,
  };
}

/**
 * An engine edge can point at a file today's extractors built instead, whose
 * node ids may differ; such an edge becomes an unresolved reference.
 */
function demoteDanglingEngineEdges(files: StagedFile[]): void {
  const ids = new Set(files.flatMap((file) => file.nodes.map((node) => node.id)));
  for (const file of files) {
    if (!file.sketches) continue;
    file.edges = file.edges.filter((edge) => {
      if (ids.has(edge.target)) return true;
      file.references.push({
        fromNodeId: edge.source, referenceName: String(edge.metadata?.targetName ?? edge.target), referenceKind: edge.kind,
        filePath: file.record.path, language: file.record.language, line: edge.line, column: edge.column,
        status: "unresolved",
        resolver: edge.resolutionMethod?.startsWith("engine-") ? edge.resolutionMethod : `engine-${file.record.language}`,
        metadata: { reason: "target_changed_during_build" },
      });
      return false;
    });
    for (const binding of file.imports) {
      if (binding.targetId && !ids.has(binding.targetId)) binding.targetId = undefined;
    }
  }
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
/** Carry old anchors across a full build without retaining unrelated node payloads. */
export function restoreGraphAliases(
  previous: GraphStore,
  destination: GraphStore,
  previousFingerprints: FingerprintStore,
  destinationFingerprints: FingerprintStore,
): void {
  const ids = new Set(destination.getAllNodeIds());
  if (previous.getAllNodeIds().every(id => ids.has(id))) {
    for (const alias of previous.getAllAliases()) {
      destination.insertAlias(alias.aliasId, alias.canonicalNodeId, alias.matchMethod, alias.confidence);
    }
    return;
  }
  const fresh = destination.getAllNodes();
  const plan = planCompatibilityAliases(previous, fresh, previousFingerprints);
  createCompatibilityAliases(destination, plan, fresh, destinationFingerprints);
}

/** Overlay continuity looks up candidates only for IDs that disappeared. */
export function restoreOverlayAliases(
  previous: GraphStore,
  destination: GraphStore,
  vanished: readonly GraphNode[],
  previousFingerprints: FingerprintStore,
  destinationFingerprints: FingerprintStore,
): void {
  const missing = new Set(vanished.map(node => node.id));
  const remapped = new Map<string, string>();
  const one = (nodes: readonly GraphNode[]): GraphNode | undefined => nodes.length === 1 ? nodes[0] : undefined;
  for (const old of vanished) {
    const qualified = one(destination.getNodesByFile(old.filePath)
      .filter(node => node.kind === old.kind && node.qualifiedName === old.qualifiedName));
    let match = qualified && { node: qualified, method: "qualified-name", confidence: 1 };
    if (!match && normalizedSignature(old.signature)) {
      const key = compatibilitySignatureKey(old);
      const matchesSignature = (node: GraphNode) => compatibilitySignatureKey(node) === key;
      if (one(previous.getNodesByName(old.kind, old.name).filter(matchesSignature))) {
        const node = one(destination.getNodesByName(old.kind, old.name).filter(matchesSignature));
        if (node) match = { node, method: "signature", confidence: 0.98 };
      }
    }
    if (!match && old.bodyHash) {
      const node = one(destination.getNodesByBodyHash(old.kind, old.bodyHash, 2));
      if (node) match = { node, method: "body-hash", confidence: 0.95 };
    }
    if (!match) {
      // The v5 fingerprint projection already supplies canonical IDs with their kind.
      const kindPrefix = `${old.kind}:`;
      match = fingerprintAliasMatch(old, previousFingerprints.get(old.id) ?? undefined, destinationFingerprints,
        id => destination.getNodeById(id) ?? undefined, id => id.startsWith(kindPrefix)) ?? undefined;
    }
    if (match) {
      destination.insertAlias(old.id, match.node.id, match.method, match.confidence);
      remapped.set(old.id, match.node.id);
    }
  }
  for (const alias of previous.getAllAliases()) {
    const canonical = missing.has(alias.canonicalNodeId) ? remapped.get(alias.canonicalNodeId) : alias.canonicalNodeId;
    if (canonical) destination.insertAlias(alias.aliasId, canonical, alias.matchMethod, alias.confidence);
  }
}

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
      const match = fingerprintAliasMatch(old, old.baseline, freshFingerprints, id => freshById.get(id));
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
    const match = fingerprintAliasMatch(old, old.baseline, freshFingerprints, id => freshById.get(id));
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
  lookupNode: (id: string) => GraphNode | undefined,
  matchesKind = (id: string) => lookupNode(id)?.kind === old.kind,
): { node: GraphNode; method: string; confidence: number } | null {
  if (!baseline || baseline.tokenCount < MIN_TOKENS) return null;
  const scored = freshFingerprints.lookup(baseline)
    .filter(candidate => matchesKind(candidate.nodeId))
    .map(candidate => ({ nodeId: candidate.nodeId, score: minhashJaccard(baseline.minhash, candidate.fingerprint.minhash) }))
    .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId));
  const best = scored[0];
  if (!best || best.score < 0.95) return null;
  const runnerUp = scored[1];
  if (runnerUp && best.score - runnerUp.score < 0.08) return null;
  const node = lookupNode(best.nodeId);
  return node ? { node, method: "fingerprint", confidence: best.score } : null;
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
/** Source files read at once by {@link discoverSourceFilesConcurrently}. */
const DISCOVERY_READ_WINDOW = 512;

/**
 * {@link discoverSourceFiles} with the reads overlapped (#281): the same
 * files, hashes, spool, skips, failures and limits, in the same order. Each
 * read makes several file-system calls, and on a large corpus they waited one
 * after another; status inspection already reads concurrently. Custom file
 * access (tests, hosts) keeps the sequential path.
 */
export interface NativeSourceObservation {
  contentHash: string;
  identity: string;
  utf8Size: number;
}

export function nativeGraphSourcePaths(root: string): string[] {
  return discoverGraphReadPaths(GRAPH_SUPPORTED_SOURCE_GLOB, {
    ...GRAPH_CORPUS_GLOB_OPTIONS, cwd: root, ignore: graphCorpusIgnoreGlobs(root),
  }, GRAPH_CORPUS_LIMITS.maxSourceFiles).map(toPosix).filter(isSupportedSourceFile).sort();
}

function nativeSourceReader(root: string) {
  const canonicalRoot = realpathSync.native(root);
  const sourcePath = (path: string) => {
    const absolute = resolve(root, path);
    const canonical = realpathSync.native(absolute);
    if (!isContainedPath(root, absolute) || !isContainedPath(canonicalRoot, canonical)) {
      throw sourceContainmentError("Resolved source path escapes the repository root.");
    }
    return canonical;
  };
  const stat = (path: string, directories?: Map<string, string>) => {
    let canonical: string;
    if (directories) {
      const absolute = resolve(root, path);
      const dir = dirname(absolute);
      let resolved = directories.get(dir);
      if (!resolved) {
        resolved = realpathSync.native(dir);
        if (!isContainedPath(root, dir) || !isContainedPath(canonicalRoot, resolved)) {
          throw sourceContainmentError("Resolved source directory escapes the repository root.");
        }
        directories.set(dir, resolved);
      }
      canonical = join(resolved, basename(absolute));
    } else canonical = sourcePath(path);
    let before = lstatSync(canonical, { bigint: true });
    if (before.isSymbolicLink()) {
      canonical = sourcePath(path);
      before = lstatSync(canonical, { bigint: true });
    }
    if (!before.isFile()) throw sourceContainmentError("Resolved source path is not a stable regular file.");
    if (before.size > GRAPH_CORPUS_LIMITS.maxSourceFileBytes) {
      throw new GraphCorpusLimitError("maxSourceFileBytes", Number(before.size));
    }
    return { canonical, before, identity: preciseSourceIdentity(before) };
  };
  const read = (path: string, observed = stat(path)) => {
    const { canonical, identity } = observed;
    const fd = openSync(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (preciseSourceIdentity(fstatSync(fd, { bigint: true })) !== identity) throw sourceContainmentError("Source changed before it opened.");
      const source = readFileSync(fd, "utf8");
      const after = fstatSync(fd, { bigint: true });
      if (preciseSourceIdentity(after) !== identity || !isSameResolvedPath(sourcePath(path), canonical)
        || preciseSourceIdentity(lstatSync(canonical, { bigint: true })) !== identity) {
        throw sourceContainmentError("Source changed while being read.");
      }
      assertTextSource(source);
      return source;
    } finally { closeSync(fd); }
  };
  return { stat, read };
}

/** Same contained exact-byte capture for a reported edit as for a refresh. */
export function captureNativeGraphSource(root: string, path: string): DiscoveredFile & NativeSourceObservation {
  const reader = nativeSourceReader(root);
  const observed = reader.stat(path);
  const source = reader.read(path, observed);
  return {
    relPath: path, size: Number(observed.before.size), modifiedAt: Number(observed.before.mtimeNs) / 1e6,
    contentHash: sha256(source), identity: observed.identity, utf8Size: Buffer.byteLength(source, "utf8"),
  };
}

/** Capture one private source observation for a native maintenance run. */
export function discoverGraphBuildSources(
  root: string,
  stage: (path: string, source: string, contentHash: string) => void,
  previous?: ReadonlyMap<string, NativeSourceObservation>,
): { files: Array<DiscoveredFile & NativeSourceObservation>; skipped: GraphSkippedSourceFile[]; assertUnchanged(): void } {
  const paths = () => nativeGraphSourcePaths(root);
  const { stat, read } = nativeSourceReader(root);
  let listed: string[];
  try { listed = paths(); }
  catch (error) { throw new GraphSourceStagingError([sourceStagingFailure(".", "discover", error)]); }
  const files: Array<DiscoveredFile & NativeSourceObservation> = [];
  const skipped: GraphSkippedSourceFile[] = [];
  const proofs = new Map<string, { canonical: string; identity: string; hash: string; precise: boolean }>();
  const directories = new Map<string, string>();
  let sourceBytes = 0;
  const skip = (path: string, error: unknown) => unavailableFileReason(error) ? unavailableSourceFile(path, error)
    : isPerFileCorpusLimitError(error) ? skippedSourceFile(path, error) : undefined;
  for (const path of listed) {
    try {
      const observed = stat(path, directories);
      const { canonical, before, identity } = observed;
      const old = previous?.get(path);
      let observation: NativeSourceObservation;
      const precise = before.ino !== 0n && before.ctimeNs % 1_000_000n !== 0n;
      // Coarse timestamps cannot distinguish writes in the same tick. Keep
      // exact-byte reads for those files and for all changed or unknown stamps.
      if (old?.identity === identity && precise) {
        observation = old;
      } else {
        const source = read(path, observed);
        observation = { contentHash: sha256(source), identity, utf8Size: Buffer.byteLength(source, "utf8") };
        stage(path, source, observation.contentHash);
      }
      sourceBytes = addGraphCorpusBytes(sourceBytes, observation.utf8Size, "source");
      files.push({ relPath: path, ...observation, size: Number(before.size), modifiedAt: Number(before.mtimeNs) / 1e6 });
      proofs.set(path, { canonical, identity, hash: observation.contentHash, precise });
    } catch (error) {
      const omitted = skip(path, error);
      if (!omitted) throw new GraphSourceStagingError([sourceStagingFailure(path, "read", error)]);
      skipped.push(omitted);
    }
  }
  const skippedByPath = new Map(skipped.map(file => [file.filePath, file.reason]));
  return {
    files, skipped,
    assertUnchanged() {
      const current = paths();
      if (current.length !== listed.length || current.some((path, index) => path !== listed[index])) {
        throw new GraphSourceStagingError([{ filePath: ".", operation: "discover", message: "The source corpus changed during graph construction." }]);
      }
      const verifiedDirectories = new Map<string, string>();
      for (const path of current) {
        try {
          const proof = proofs.get(path);
          if (!proof) {
            try { read(path); }
            catch (error) { if (skip(path, error)?.reason === skippedByPath.get(path)) continue; }
          } else {
            const observed = stat(path, verifiedDirectories);
            if (isSameResolvedPath(observed.canonical, proof.canonical) && observed.identity === proof.identity
              && (proof.precise || sha256(read(path, observed)) === proof.hash)) continue;
          }
          throw new Error("Source identity changed during graph construction.");
        } catch (error) { throw new GraphSourceStagingError([sourceStagingFailure(path, "read", error)]); }
      }
    },
  };
}

export function preciseSourceIdentity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

async function discoverSourceFilesConcurrently(
  root: string,
  sourceFileAccess: GraphSourceFileAccess,
  sourceSpool?: Pick<GraphSourceSpool, "stage">,
): Promise<DiscoveredCorpus> {
  if (sourceFileAccess !== NODE_SOURCE_FILE_ACCESS) return discoverSourceFiles(root, sourceFileAccess, sourceSpool);
  let matches: string[];
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
    matches = discoverGraphReadPaths(GRAPH_SUPPORTED_SOURCE_GLOB, {
      ...GRAPH_CORPUS_GLOB_OPTIONS,
      cwd: root,
      ignore: graphCorpusIgnoreGlobs(root),
    }, GRAPH_CORPUS_LIMITS.maxSourceFiles).map(toPosix);
  } catch (error) {
    throw new GraphSourceStagingError([sourceStagingFailure(".", "discover", error)]);
  }
  const canonicalDirectories = new Map<string, string>();
  type Entry = { relPath: string; canonical?: string; containment?: unknown };
  const entries: Entry[] = [];
  for (const relPath of matches) {
    if (!isSupportedSourceFile(relPath)) continue;
    try {
      entries.push({ relPath, canonical: resolveContainedRepoFile(root, canonicalRoot, relPath, canonicalDirectories) });
    } catch (error) {
      entries.push({ relPath, containment: error });
    }
  }
  const files: DiscoveredFile[] = [];
  const skipped: GraphSkippedSourceFile[] = [];
  const failures: GraphSourceStagingFailure[] = [];
  let sourceBytes = 0;
  // A window at a time, so at most one window of sources is held unstaged.
  for (let start = 0; start < entries.length; start += DISCOVERY_READ_WINDOW) {
    const window = entries.slice(start, start + DISCOVERY_READ_WINDOW);
    const reads = new Array<{ file?: Awaited<ReturnType<typeof readStableUtf8FileAsync>>; error?: unknown }>(window.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < window.length) {
        const index = next++;
        const entry = window[index]!;
        if (entry.canonical === undefined) continue;
        try {
          reads[index] = { file: await readStableUtf8FileAsync(entry.canonical, resolve(root, entry.relPath)) };
        } catch (error) {
          reads[index] = { error };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(processGraphSizing().readConcurrency, window.length) }, worker));
    for (const [index, entry] of window.entries()) {
      if (entry.canonical === undefined) {
        failures.push(sourceStagingFailure(entry.relPath, "discover", entry.containment));
        continue;
      }
      const read = reads[index]!;
      try {
        if (read.error !== undefined) throw read.error;
        const file = read.file!;
        sourceBytes = addGraphCorpusBytes(sourceBytes, Buffer.byteLength(file.source, "utf8"), "source");
        assertTextSource(file.source);
          const contentHash = sha256(file.source);
        sourceSpool?.stage(entry.relPath, file.source);
        files.push({ relPath: entry.relPath, contentHash, size: file.size, modifiedAt: file.modifiedAt });
      } catch (error) {
        if (unavailableFileReason(error)) skipped.push(unavailableSourceFile(entry.relPath, error));
          else if (isPerFileCorpusLimitError(error)) skipped.push(skippedSourceFile(entry.relPath, error));
        else {
          failures.push(sourceStagingFailure(entry.relPath, "read", error));
          // The corpus limit stops discovery, as the sequential loop does.
          if (error instanceof GraphCorpusLimitError) throw new GraphSourceStagingError(failures);
        }
      }
    }
  }
  if (failures.length > 0) throw new GraphSourceStagingError(failures);
  return { files, skipped };
}

function discoverSourceFiles(
  root: string,
  sourceFileAccess: GraphSourceFileAccess,
  sourceSpool?: Pick<GraphSourceSpool, "stage">,
): DiscoveredCorpus {
  let matches: string[];
  const files: DiscoveredFile[] = [];
  const skipped: GraphSkippedSourceFile[] = [];
  const failures: GraphSourceStagingFailure[] = [];
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
    matches = discoverGraphReadPaths(GRAPH_SUPPORTED_SOURCE_GLOB, {
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
        assertTextSource(file.source);
          const contentHash = sha256(file.source);
        sourceSpool?.stage(relPath, file.source);
        files.push({ relPath, contentHash, size: file.size, modifiedAt: file.modifiedAt });
      } catch (error) {
        if (unavailableFileReason(error)) skipped.push(unavailableSourceFile(relPath, error));
        else if (isPerFileCorpusLimitError(error)) skipped.push(skippedSourceFile(relPath, error));
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
      assertTextSource(source);
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
      if (unavailableFileReason(error)) skipped.push(unavailableSourceFile(relPath, error));
        else if (isPerFileCorpusLimitError(error)) skipped.push(skippedSourceFile(relPath, error));
      else {
        failures.push(sourceStagingFailure(relPath, "read", error));
        if (error instanceof GraphCorpusLimitError) break;
      }
    }
  }
  if (failures.length > 0) throw new GraphSourceStagingError(failures);
  return { files, skipped };
}

function unavailableSourceFile(filePath: string, error: unknown): GraphSkippedSourceFile {
  return { filePath, reason: unavailableFileReason(error)!, limit: "per-file", limitBytes: 0, message: error instanceof Error ? error.message : String(error) };
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
  const remembered = recallSource(canonicalPath, before);
  if (remembered !== undefined) {
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) {
      throw new GraphCorpusLimitError(limitName, Number.isSafeInteger(before.size) ? before.size : undefined);
    }
    return { source: remembered, size: before.size, modifiedAt: before.mtimeMs };
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
    rememberSource(canonicalPath, opened, source);
    return { source, size: opened.size, modifiedAt: opened.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

/**
 * The JavaScript resolver `realpathSync` uses, asynchronously. The native one
 * behind `fs/promises` expands Windows 8.3 short names (a runner's TEMP), so its
 * answer would not compare equal to paths this engine resolved synchronously.
 */
function realpathAsync(path: string): Promise<string> {
  return new Promise((resolveRealpath, reject) => {
    realpath(path, (error, resolved) => (error ? reject(error) : resolveRealpath(resolved)));
  });
}

/** {@link readStableUtf8File} through asynchronous calls, with the same checks in the same order. */
async function readStableUtf8FileAsync(
  canonicalPath: string,
  sourcePath = canonicalPath,
  maxBytes = GRAPH_CORPUS_LIMITS.maxSourceFileBytes,
): Promise<{ source: string; size: number; modifiedAt: number }> {
  const limitName = "maxSourceFileBytes";
  const before = await lstatAsync(canonicalPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw sourceContainmentError("Resolved source path is not a stable regular file.");
  }
  const remembered = recallSource(canonicalPath, before);
  if (remembered !== undefined) {
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) {
      throw new GraphCorpusLimitError(limitName, Number.isSafeInteger(before.size) ? before.size : undefined);
    }
    return { source: remembered, size: before.size, modifiedAt: before.mtimeMs };
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await openAsync(canonicalPath, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw sourceContainmentError("Source path changed before it could be opened.");
    }
    if (!Number.isSafeInteger(opened.size) || opened.size < 0 || opened.size > maxBytes) {
      throw new GraphCorpusLimitError(limitName, Number.isSafeInteger(opened.size) ? opened.size : undefined);
    }
    const source = await handle.readFile("utf8");
    const after = await handle.stat();
    const resolvedAfter = await realpathAsync(sourcePath);
    const pathAfter = await lstatAsync(resolvedAfter);
    if (!sameFileIdentity(opened, after)
      || !isSameResolvedPath(resolvedAfter, canonicalPath)
      || !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || !sameFileIdentity(opened, pathAfter)) {
      throw sourceContainmentError("Source file changed while it was being read.");
    }
    rememberSource(canonicalPath, opened, source);
    return { source, size: opened.size, modifiedAt: opened.mtimeMs };
  } finally {
    await handle.close();
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
async function verifyPublicationInputs(
  root: string,
  staged: StagedCorpus,
  gitBeforeStaging: GraphGitProvenance,
  sourceFileAccess: GraphSourceFileAccess,
): Promise<GraphGitProvenance> {
  const currentFiles = (await discoverSourceFilesConcurrently(root, sourceFileAccess)).files;
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

  // Git is deliberately the last checkout observation. A checkout during any
  // source or manifest verification is therefore
  // caught before snapshot construction and the publication transaction.
  const currentGit = readGraphGitProvenance(root);
  if (gitProvenanceChanged(gitBeforeStaging, currentGit)) {
    failures.push({
      filePath: ".git/HEAD",
      operation: "discover",
      message: "Git branch or HEAD changed while the graph corpus was being staged.",
    });
  }

  if (failures.length > 0) throw new GraphSourceStagingError(failures);
  // An unreadable final read records what staging began with.
  if (!currentGit.unreadable) return currentGit;
  return { branch: gitBeforeStaging.branch, head: gitBeforeStaging.head };
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

/** @internal Exported for the Rust engine's shared vectors. */
export function bodyHash(sourceLines: string[], startLine: number, endLine: number): string {
  return sha256(sourceLines.slice(startLine - 1, endLine).join("\n").replace(/\s+/g, " ").trim());
}
