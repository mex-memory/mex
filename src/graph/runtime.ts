import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { globSync } from "glob";
import type { MexConfig, Grounding } from "../types.js";
import { extractGroundings, findMexAnchors, rewriteMexAnchor, writeGroundings } from "../markdown.js";
import { createGroundingChecker, type GroundingChecker, type GroundedSource } from "./grounding.js";
import type { SourceDriftGrounding, SourceDriftResolution } from "../drift/checkers/grounding.js";
import { createGraphEngine } from "./engine-impl.js";
import type { GraphEngine } from "./engine.js";
import { detectLanguage, extractFile, loadGrammars } from "./extraction/index.js";
import type { CompilerSourceLanguage } from "./extraction/compiler.js";
import type { Language } from "./types.js";
import {
  GRAPH_CORPUS_GLOB_OPTIONS,
  GRAPH_CORPUS_LIMITS,
  graphCorpusIgnoreGlobs,
  GRAPH_SUPPORTED_SOURCE_GLOB,
} from "./corpus-policy.js";
import { openGraphDatabase } from "./db/database.js";
import type { SqliteDatabase } from "./db/sqlite.js";
import { FingerprintStore } from "./fingerprint-store.js";
import { deserializeFingerprint, serializeFingerprint } from "./fingerprint.js";
import { acquireGraphMaintenanceLease } from "./maintenance.js";
import { MinHashReconciler } from "./reconcile-engine.js";
import type { Fingerprint, Reconciler } from "./reconcile.js";
import {
  inspectGraphSidecars,
  inspectGraphStatus,
  inspectGraphStatusWithFreshObservation,
  readContainedRepositorySource,
  type InternalGraphStatusInspection,
} from "./status.js";
import {
  loadFreshGraphReadSession,
  openImmutableGraphReadSessionSync,
  type InternalGraphReadSession,
} from "./read-session.js";
import type { GraphStatus } from "../team/contracts/graph.js";

export interface GroundingRuntime {
  graph: GraphEngine;
  reconciler: MinHashReconciler;
  checker: GroundingChecker;
  fingerprints: FingerprintStore;
  /** Pre-sync fingerprints for inline ids that may disappear during a rename. */
  anchorFingerprints: ReadonlyMap<string, Fingerprint>;
  close(): void;
}

export interface GroundingBaselineCaptureResult {
  captured: number;
  skipped: number;
}

export interface GroundingBaselineCaptureOptions {
  /** Renew only these explicitly reviewed entries, after revalidating their exact facts. */
  acceptedGroundings?: readonly GroundingBaselineAcceptance[];
  warn?: (message: string) => void;
}

/** An in-process review bound to one document revision and one exact graph fact. */
export interface GroundingBaselineAcceptance {
  scaffoldFile: string;
  nodeId: string;
  contentHash: string;
  fingerprint: string;
  bodyHash: string;
}

export interface GroundingBaselineReview {
  acceptance: GroundingBaselineAcceptance;
  content: string;
  oldBody: string | null;
  newBody: string;
}

const GROUNDING_REVIEW_MAX_BYTES = 64 * 1024;
const GROUNDING_REVIEW_MAX_ENTRIES = 64;

export interface ReadOnlyGroundingRuntimeResult {
  graphStatus: GraphStatus;
  runtime: GroundingRuntime | null;
  /**
   * True when `runtime` is bound to a stale snapshot whose only fault is
   * changed source (#228). Its checker never reconciles and reports what it
   * cannot settle as GROUNDING_UNVERIFIED. Only set under `allowSourceDrift`.
   */
  sourceDrift?: boolean;
}

export interface LoadReadOnlyGroundingRuntimeOptions {
  /** Internal seam for status/error-path tests. */
  inspectStatus?: typeof inspectGraphStatus;
  /** Internal seam for deterministic reader-handshake tests. */
  inspectSidecars?: typeof inspectGraphSidecars;
  /** Inspect status without opening graph readers when grounding is irrelevant. */
  loadRuntime?: boolean;
  /**
   * Also bind a stale snapshot when changed source is its only shortfall, and
   * check groundings against it (#228). Every other non-fresh store still
   * returns no runtime. Opt-in, because the caller owns labelling the result.
   */
  allowSourceDrift?: boolean;
}

interface ReadOnlyGroundingRuntimeInternalHooks {
  inspectObservation?: typeof inspectGraphStatusWithFreshObservation;
  afterStatusInspection?: (
    inspection: InternalGraphStatusInspection,
  ) => void | Promise<void>;
  afterDatabaseIdentityRead?: () => void | Promise<void>;
  afterDatabaseOpen?: (database: SqliteDatabase) => void | Promise<void>;
  afterDatabaseDescriptorClose?: () => void;
}

type LoadReadOnlyGroundingRuntimeInternalOptions = LoadReadOnlyGroundingRuntimeOptions & {
  /** Module-private deterministic race seams; deliberately absent from declarations. */
  __internal?: ReadOnlyGroundingRuntimeInternalHooks;
};

/**
 * Load grounding readers without synchronizing or otherwise repairing the
 * graph. A non-fresh snapshot is reported to the caller and never used for
 * grounding, because doing so could incorrectly present stale facts as clean.
 *
 * **One exception, opt-in (#228).** Under `allowSourceDrift`, a snapshot that
 * is stale *only* because source files changed — engine identity, config,
 * branch, grammar and parse health all intact, and the complete drifted-path
 * list known — is bound as well. Before this, any source edit switched
 * grounding off until a full refresh, so the score could not move for exactly
 * the edit it exists to catch. Such a snapshot still vouches for every node in
 * an unchanged file; a node in an edited file is re-derived from that file by
 * the same extractor and body hash a refresh would use, or reported
 * unverified. Nothing about staleness is hidden: the status stays `stale`.
 */
export async function loadReadOnlyGroundingRuntime(
  config: MexConfig,
  options: LoadReadOnlyGroundingRuntimeOptions = {},
): Promise<ReadOnlyGroundingRuntimeResult> {
  const dbPath = resolve(config.projectRoot, ".mex", "graph.db");
  const internal = (options as LoadReadOnlyGroundingRuntimeInternalOptions).__internal;
  const statusOptions = { projectRoot: config.projectRoot, dbPath };
  const inspectBase = options.inspectStatus
    ? async (): Promise<InternalGraphStatusInspection> => ({
        graphStatus: await options.inspectStatus!(statusOptions),
        freshObservation: null,
      })
    : internal?.inspectObservation ?? inspectGraphStatusWithFreshObservation;
  // The read-session loader would also adopt config drift and parse health.
  // Grounding accepts neither, so hide every degraded observation except the
  // one whose sole shortfall is changed source; the rest behave as before.
  const inspectObservation: typeof inspectGraphStatusWithFreshObservation = options.allowSourceDrift
    ? async (inspectOptions) => onlySourceDrift(await inspectBase(inspectOptions))
    : inspectBase;
  const loaded = await loadFreshGraphReadSession(config.projectRoot, {
    dbPath,
    loadSession: options.loadRuntime,
    allowDegradedReads: options.allowSourceDrift === true,
    inspectObservation,
    inspectSidecars: options.inspectSidecars,
    afterStatusInspection: internal?.afterStatusInspection,
    hooks: {
      afterDatabaseIdentityRead: internal?.afterDatabaseIdentityRead,
      afterDatabaseOpen: internal?.afterDatabaseOpen,
      afterDatabaseDescriptorClose: internal?.afterDatabaseDescriptorClose,
    },
  });
  if (!loaded.session) return { graphStatus: loaded.graphStatus, runtime: null };

  const session = loaded.session;
  try {
    const fingerprints = new FingerprintStore(session.db);
    const anchorFingerprints = snapshotAnchorFingerprints(config, fingerprints);
    const guard: GroundingRuntimeGuard = {
      validate: () => session.validate().valid,
      invalidate: () => {
        if (loaded.graphStatus.diagnostics.some((entry) => entry.code === "GRAPH_INDEX_READER_DATABASE_CHANGED")) {
          return;
        }
        loaded.graphStatus.status = "degraded";
        loaded.graphStatus.diagnostics = [
          ...loaded.graphStatus.diagnostics,
          {
            code: "GRAPH_INDEX_READER_DATABASE_CHANGED",
            severity: "warning",
            message: "The graph changed while grounding checks were running; graph-derived results were discarded.",
            remediation: [{ label: "Retry after graph maintenance finishes" }],
          },
        ];
      },
    };
    const sourceDrift = session.degradations.length > 0
      ? await prepareSourceDriftGrounding(
          config.projectRoot,
          session.graph,
          session.driftedSources,
          loaded.graphStatus.changes.modified,
        )
      : undefined;
    const runtime = assembleGroundingRuntime(
      session.graph,
      null,
      fingerprints,
      anchorFingerprints,
      guard,
      sourceDrift,
    );
    return {
      graphStatus: loaded.graphStatus,
      // Close through the session, not just its graph: the session also owns
      // the descriptor that binds `graph.db`'s identity. Closing only the graph
      // left that descriptor open, and on Windows an open handle makes the next
      // in-process refresh fail to replace the file ("The live graph changed
      // before candidate publication").
      runtime: { ...runtime, close: () => session.close() },
      ...(sourceDrift ? { sourceDrift: true } : {}),
    };
  } catch {
    session.close();
    return {
      graphStatus: {
        ...loaded.graphStatus,
        status: "degraded",
        diagnostics: [
          ...loaded.graphStatus.diagnostics,
          {
            code: "GRAPH_INDEX_READER_OPEN_FAILED",
            severity: "warning",
            message: "The graph changed or became unavailable while immutable grounding readers were opening; grounding was skipped.",
            remediation: [{ label: "Retry after graph maintenance finishes" }],
          },
        ],
      },
      runtime: null,
    };
  }
}

/**
 * Load and synchronize grounding state for explicitly mutating setup/sync
 * workflows. Ordinary reads must use {@link loadReadOnlyGroundingRuntime}.
 */
export async function loadGroundingRuntime(config: MexConfig): Promise<GroundingRuntime | null> {
  const lease = acquireGraphMaintenanceLease(config.projectRoot, "refresh");
  let priorSession: InternalGraphReadSession | null = null;
  let graph: GraphEngine | null = null;
  let db: SqliteDatabase | null = null;
  try {
    // Preserve fingerprints for inline ids before refresh can replace them.
    // The maintenance lease prevents a cooperating publisher from changing the
    // old snapshot between this read and the isolated refresh publication.
    priorSession = openImmutableGraphReadSessionSync(config.projectRoot, lease.databasePath);
    const anchorFingerprints = snapshotAnchorFingerprints(config, new FingerprintStore(priorSession.db));
    priorSession.close();
    priorSession = null;

    await lease.refresh();
    graph = createGraphEngine({ rootDir: config.projectRoot, dbPath: lease.databasePath });
    db = openGraphDatabase(lease.databasePath);
    const fingerprints = new FingerprintStore(db);
    const assembled = assembleGroundingRuntime(graph, db, fingerprints, anchorFingerprints);
    graph = null;
    db = null;
    let closed = false;
    return {
      ...assembled,
      close: () => {
        if (closed) return;
        closed = true;
        try {
          assembled.close();
        } finally {
          lease.release();
        }
      },
    };
  } catch (error) {
    try { priorSession?.close(); } catch { /* preserve the maintenance failure */ }
    try { graph?.close(); } catch { /* preserve the maintenance failure */ }
    try { db?.close(); } catch { /* preserve the maintenance failure */ }
    lease.release();
    throw error;
  }
}

/** Capture authored grounding against the current graph, shared by setup/migrate/sync. */
export async function captureGroundingBaselines(
  config: MexConfig,
  options: GroundingBaselineCaptureOptions = {},
): Promise<GroundingBaselineCaptureResult> {
  const runtime = await loadGroundingRuntime(config);
  if (!runtime) {
    options.warn?.("Code graph unavailable; grounding baselines were not captured.");
    return { captured: 0, skipped: 0 };
  }
  try {
    const scaffoldFiles = options.acceptedGroundings === undefined
      ? globSync("**/*.md", { cwd: config.scaffoldRoot, absolute: true, nodir: true })
      : [...new Set(options.acceptedGroundings.map((entry) =>
        resolveGroundingReviewFile(config, entry.scaffoldFile)))];
    return refreshGroundingBaselines(config, scaffoldFiles, runtime, options);
  } finally {
    runtime.close();
  }
}

/** Compare graph file metadata to disk; includes additions, edits, and deletions. */
export function findChangedSourceFiles(projectRoot: string, db: SqliteDatabase): string[] {
  const rows = db.prepare("SELECT path, size, modified_at FROM files").all() as Array<{
    path: string; size: number; modified_at: number;
  }>;
  const tracked = new Map(rows.map((row) => [row.path, row]));
  const current = globSync(GRAPH_SUPPORTED_SOURCE_GLOB, {
    ...GRAPH_CORPUS_GLOB_OPTIONS,
    cwd: projectRoot,
    ignore: graphCorpusIgnoreGlobs(projectRoot),
  })
    .map((path) => path.replaceAll("\\", "/"));
  const changed: string[] = [];
  for (const path of current) {
    const row = tracked.get(path);
    const stat = statSync(resolve(projectRoot, path));
    if (!row || row.size !== stat.size || row.modified_at !== stat.mtimeMs) changed.push(path);
    tracked.delete(path);
  }
  changed.push(...tracked.keys());
  return [...new Set(changed)].sort();
}

/** Identity repair moves the old evidence; it does not accept the new body. */
function moveGroundingBaseline(
  scaffoldFile: string,
  oldId: string,
  newId: string,
  runtime: GroundingRuntime,
  pendingMoves: Map<string, { previous: GroundedSource; newId: string }>,
  grounding?: Grounding,
): void {
  const previous = runtime.fingerprints.getGroundedSource(scaffoldFile, oldId);
  if (grounding && grounding.bodyHash === undefined && previous) {
    grounding.bodyHash = previous.bodyHash;
  }
  const destination = runtime.fingerprints.getGroundedSource(scaffoldFile, newId);
  if (previous && (destination?.nodeId !== newId || (grounding && grounding.bodyHash === previous.bodyHash))) {
    pendingMoves.set(oldId, { previous, newId });
  }
}

/** Persist only high-confidence MOVED repairs. AMBIGUOUS/GONE remain for the agent. */
export function persistMovedGroundings(
  config: MexConfig,
  scaffoldFiles: readonly string[],
  runtime: GroundingRuntime,
): number {
  let moved = 0;
  for (const filePath of scaffoldFiles) {
    const content = readBoundedText(filePath, GRAPH_CORPUS_LIMITS.maxSourceFileBytes);
    const groundings = extractGroundings(content);
    const scaffoldFile = relative(config.projectRoot, filePath).replaceAll("\\", "/");
    let dirty = false;
    const pendingMoves = new Map<string, { previous: GroundedSource; newId: string }>();
    // Per-node migration is atomic (#128): a node grounded both in
    // grounds_to and as an inline mex:// anchor must migrate through ONE
    // resolution. The grounds_to pass records its resolution per old id so
    // the anchor pass can follow it even when the store has already lost
    // the old node's rows (no baseline, no fingerprint, no alias) — instead
    // of skipping the anchor and leaving GROUNDING_GONE behind.
    const migratedNodes = new Map<string, string>();
    for (const grounding of groundings) {
      const aliasedNode = runtime.graph.getNode(grounding.node);
      if (aliasedNode) {
        if (aliasedNode.id === grounding.node) continue;
        if (groundings.some((other) => other !== grounding && other.node === aliasedNode.id)) continue;
        const oldId = grounding.node;
        grounding.node = aliasedNode.id;
        const fingerprint = runtime.reconciler.getFingerprint(aliasedNode.id);
        if (fingerprint) grounding.fingerprint = serializeFingerprint(fingerprint);
        moveGroundingBaseline(scaffoldFile, oldId, grounding.node, runtime, pendingMoves, grounding);
        migratedNodes.set(oldId, grounding.node);
        dirty = true;
        moved += 1;
        continue;
      }
      const baselineSource = runtime.reconciler.getGroundedSource(scaffoldFile, grounding.node);
      const baseline = deserializeFingerprint(grounding.fingerprint)
        ?? (baselineSource ? deserializeFingerprint(baselineSource.fingerprint) : null);
      if (!baseline) continue;
      const resolution = runtime.reconciler.reconcile(grounding.node, baseline);
      if (resolution.kind !== "MOVED") continue;
      if (groundings.some((other) => other !== grounding && other.node === resolution.nodeId)) continue;
      const oldId = grounding.node;
      grounding.node = resolution.nodeId;
      const fingerprint = runtime.reconciler.getFingerprint(resolution.nodeId);
      if (fingerprint) grounding.fingerprint = serializeFingerprint(fingerprint);
      moveGroundingBaseline(scaffoldFile, oldId, grounding.node, runtime, pendingMoves, grounding);
      migratedNodes.set(oldId, grounding.node);
      dirty = true;
      moved += 1;
    }
    const groundedContent = dirty ? writeGroundings(content, groundings) : content;
    let anchoredContent = groundedContent;
    const anchors = findMexAnchors(anchoredContent);
    for (const anchor of [...anchors].reverse()) {
      const migratedId = migratedNodes.get(anchor.nodeId);
      if (migratedId !== undefined) {
        anchoredContent = rewriteMexAnchor(anchoredContent, anchor, migratedId);
        moved += 1;
        continue;
      }
      const aliasedNode = runtime.graph.getNode(anchor.nodeId);
      if (aliasedNode) {
        if (aliasedNode.id === anchor.nodeId) continue;
        if (!groundings.some((entry) => entry.node === aliasedNode.id)) {
          moveGroundingBaseline(scaffoldFile, anchor.nodeId, aliasedNode.id, runtime, pendingMoves);
        }
        anchoredContent = rewriteMexAnchor(anchoredContent, anchor, aliasedNode.id);
        moved += 1;
        continue;
      }
      const baselineSource = runtime.reconciler.getGroundedSource(scaffoldFile, anchor.nodeId);
      const baseline = runtime.anchorFingerprints.get(anchor.nodeId)
        ?? (baselineSource ? deserializeFingerprint(baselineSource.fingerprint) : null);
      if (!baseline) continue;
      const resolution = runtime.reconciler.reconcile(anchor.nodeId, baseline);
      if (resolution.kind !== "MOVED") continue;
      if (!groundings.some((entry) => entry.node === resolution.nodeId)) {
        moveGroundingBaseline(scaffoldFile, anchor.nodeId, resolution.nodeId, runtime, pendingMoves);
      }
      anchoredContent = rewriteMexAnchor(anchoredContent, anchor, resolution.nodeId);
      moved += 1;
    }
    if (anchoredContent !== content) {
      replaceGroundingDocument(config, filePath, content, anchoredContent, GRAPH_CORPUS_LIMITS.maxSourceFileBytes);
      for (const [oldId, { previous, newId }] of pendingMoves) {
        runtime.fingerprints.saveGroundedSource({ ...previous, nodeId: newId });
        runtime.fingerprints.deleteGroundedSource(scaffoldFile, oldId);
      }
    }
  }
  return moved;
}

interface GroundingReconcilerCapabilities {
  getGroundedSource(scaffoldFile: string, nodeId: string): GroundedSource | null;
  getFingerprint(nodeId: string): Fingerprint | null;
}

interface GroundingRuntimeGuard {
  validate(): boolean;
  invalidate(): void;
}

function assembleGroundingRuntime(
  graph: GraphEngine,
  database: SqliteDatabase | null,
  fingerprints: FingerprintStore,
  anchorFingerprints: ReadonlyMap<string, Fingerprint>,
  guard?: GroundingRuntimeGuard,
  sourceDrift?: SourceDriftGrounding,
): GroundingRuntime {
  const reconciler = new MinHashReconciler(fingerprints);
  const checkerReconciler: Reconciler & GroundingReconcilerCapabilities = {
    reconcile: (nodeId, baseline) => reconciler.reconcile(nodeId, baseline),
    getFingerprint: (nodeId) => anchorFingerprints.get(nodeId) ?? reconciler.getFingerprint(nodeId),
    getGroundedSource: (file, nodeId) => reconciler.getGroundedSource(file, nodeId),
  };
  const rawChecker = createGroundingChecker(graph, checkerReconciler, sourceDrift);
  const checker: GroundingChecker = guard
    ? (...args) => {
        if (!guard.validate()) {
          guard.invalidate();
          return [];
        }
        let issues;
        try {
          issues = rawChecker(...args);
        } catch (error) {
          if (!guard.validate()) {
            guard.invalidate();
            return [];
          }
          throw error;
        }
        if (!guard.validate()) {
          guard.invalidate();
          return [];
        }
        return issues;
      }
    : rawChecker;
  let db: SqliteDatabase | null = database;
  return {
    graph,
    reconciler,
    checker,
    fingerprints,
    anchorFingerprints,
    close: () => { graph.close(); db?.close(); db = null; },
  };
}

/** Keep a degraded observation only when changed source is the store's sole shortfall. */
function onlySourceDrift(inspection: InternalGraphStatusInspection): InternalGraphStatusInspection {
  const degraded = inspection.degradedObservation ?? null;
  if (!degraded) return inspection;
  const sourceOnly = inspection.graphStatus.status === "stale"
    && degraded.degradations.length === 1
    && degraded.degradations[0] === "source-drift";
  return sourceOnly ? inspection : { ...inspection, degradedObservation: null };
}

/**
 * Compiler-extracted languages. Their spans and identities come from a whole
 * TypeScript program, so one edited file cannot be re-derived exactly without
 * a refresh. The `Record` makes a new compiler language a compile error here
 * rather than a silent tree-sitter approximation of a compiler span.
 */
const COMPILER_SOURCE_LANGUAGES: Readonly<Record<CompilerSourceLanguage, true>> = {
  typescript: true,
  tsx: true,
  javascript: true,
  jsx: true,
};

function isCompilerSourceLanguage(language: Language): boolean {
  return Object.hasOwn(COMPILER_SOURCE_LANGUAGES, language);
}

/**
 * Resolve grounded nodes against a snapshot that is stale only by changed
 * source (#228). `driftedSources` is the exhaustive added/modified/deleted
 * list the status inspection bound this session to.
 *
 * - A node whose file did not change: the snapshot row is exactly what a
 *   refresh would record, because nothing it was derived from moved.
 * - A node in an edited tree-sitter file: re-run the single-file extractor a
 *   refresh uses (`extractFile`) over the current, contained read of that
 *   file, find the node by its Tier-1 id (path, kind, qualified name), and
 *   hash its line span with the graph's own body normalization.
 * - Everything else — a deleted file, an edited compiler-language file, a
 *   node the extractor no longer emits under that id, a file that cannot be
 *   read within the corpus limits — is unverified. None of it is reported
 *   gone or moved: those need the whole refreshed corpus.
 */
async function prepareSourceDriftGrounding(
  projectRoot: string,
  graph: GraphEngine,
  driftedSources: readonly string[],
  modifiedSources: readonly string[],
): Promise<SourceDriftGrounding> {
  const drifted = new Set(driftedSources);
  const modified = new Set(modifiedSources.filter((path) => drifted.has(path)));
  const treeLanguages = [...new Set([...modified].map((path) => detectLanguage(path)))]
    .filter((language) => !isCompilerSourceLanguage(language));
  // A grammar that fails to load leaves `extractFile` returning null, which
  // resolves to unverified below; it never fails the check.
  try { await loadGrammars(treeLanguages); } catch { /* unverified, not fatal */ }
  const rederived = new Map<string, Map<string, { kind: string; bodyHash: string }> | null>();
  const rederive = (filePath: string): Map<string, { kind: string; bodyHash: string }> | null => {
    if (rederived.has(filePath)) return rederived.get(filePath)!;
    let nodes: Map<string, { kind: string; bodyHash: string }> | null = null;
    try {
      const source = readContainedRepositorySource(projectRoot, filePath);
      const extraction = extractFile(filePath, source);
      if (extraction) {
        // Same span, same normalization as the graph's `bodyHash`.
        const lines = source.split("\n");
        nodes = new Map(extraction.nodes.map((node) => [node.id, {
          kind: node.kind,
          bodyHash: hashBody(lines.slice(node.startLine - 1, node.endLine).join("\n")),
        }]));
      }
    } catch {
      nodes = null;
    }
    rederived.set(filePath, nodes);
    return nodes;
  };
  const unverified = (reason: string): SourceDriftResolution => ({ kind: "unverified", reason });
  return {
    resolve(nodeId) {
      const node = graph.getNode(nodeId);
      if (!node) return unverified("not in the last graph snapshot");
      if (!drifted.has(node.filePath)) return { kind: "current", bodyHash: node.bodyHash };
      if (!modified.has(node.filePath)) return unverified(`${node.filePath} was deleted`);
      if (isCompilerSourceLanguage(node.language) || isCompilerSourceLanguage(detectLanguage(node.filePath))) {
        return unverified(`${node.filePath} changed; its compiler-derived span needs a refresh`);
      }
      const current = rederive(node.filePath)?.get(nodeId);
      if (!current || current.kind !== node.kind) {
        return unverified(`${node.filePath} changed; the node could not be located there exactly`);
      }
      // Only body-bearing kinds carry a hash, and the kind is part of the id.
      return { kind: "current", bodyHash: node.bodyHash === undefined ? undefined : current.bodyHash };
    },
  };
}

function snapshotAnchorFingerprints(config: MexConfig, store: FingerprintStore): Map<string, Fingerprint> {
  const snapshots = new Map<string, Fingerprint>();
  const files = [
    ...globSync("**/*.md", { cwd: config.scaffoldRoot, absolute: true, nodir: true }),
    ...["CLAUDE.md", ".cursorrules", ".windsurfrules"]
      .map((file) => resolve(config.projectRoot, file))
      .filter(existsSync),
  ];
  for (const file of files) {
    let content: string;
    try { content = readFileSync(file, "utf-8"); } catch { continue; }
    for (const anchor of findMexAnchors(content)) {
      const fingerprint = store.get(anchor.nodeId);
      if (fingerprint) snapshots.set(anchor.nodeId, fingerprint);
    }
  }
  return snapshots;
}

/** Initialize missing baselines, or renew only exact entries explicitly reviewed by the caller. */
export function refreshGroundingBaselines(
  config: MexConfig,
  scaffoldFiles: readonly string[],
  runtime: GroundingRuntime,
  options: GroundingBaselineCaptureOptions = {},
): GroundingBaselineCaptureResult {
  const accepted = options.acceptedGroundings;
  if (accepted && accepted.length > GROUNDING_REVIEW_MAX_ENTRIES) {
    throw new Error(`Grounding review is limited to ${GROUNDING_REVIEW_MAX_ENTRIES} entries.`);
  }
  let captured = 0;
  let skipped = 0;
  for (const filePath of scaffoldFiles) {
    const readLimit = accepted === undefined ? GRAPH_CORPUS_LIMITS.maxSourceFileBytes : GROUNDING_REVIEW_MAX_BYTES;
    const content = readBoundedText(filePath, readLimit);
    const groundings = extractGroundings(content);
    const anchors = findMexAnchors(content);
    if (groundings.length === 0 && anchors.length === 0) continue;
    const scaffoldFile = relative(config.projectRoot, filePath).replaceAll("\\", "/");
    let dirty = false;
    const pendingBaselines: GroundedSource[] = [];
    const groundingByNode = new Map(groundings.map((grounding) => [grounding.node, grounding]));
    const nodeIds = new Set([
      ...groundingByNode.keys(),
      ...anchors.map((anchor) => anchor.nodeId),
    ]);
    for (const nodeId of nodeIds) {
      const acceptance = accepted?.find((entry) => entry.scaffoldFile === scaffoldFile && entry.nodeId === nodeId);
      // A selected renewal must not initialize or change any unselected entry.
      if (accepted !== undefined && acceptance === undefined) continue;
      const grounding = groundingByNode.get(nodeId);
      const previous = runtime.fingerprints.getGroundedSource(scaffoldFile, nodeId);
      if (accepted === undefined && grounding && grounding.bodyHash === undefined && previous) {
        // Legacy backfill preserves the historical baseline, even if code has changed.
        grounding.bodyHash = previous.bodyHash;
        dirty = true;
      }
      const fingerprint = runtime.reconciler.getFingerprint(nodeId);
      const node = runtime.graph.getNode(nodeId);
      if (!fingerprint || node?.id !== nodeId || !node.bodyHash) {
        skipped += 1;
        options.warn?.(`Skipped grounding baseline for unavailable node ${nodeId} in ${scaffoldFile}.`);
        continue;
      }
      const serialized = serializeFingerprint(fingerprint);
      if (acceptance) {
        if (!grounding
          || resolveGroundingReviewFile(config, scaffoldFile) !== resolve(filePath)
          || acceptance.contentHash !== hashText(content)
          || acceptance.fingerprint !== serialized
          || acceptance.bodyHash !== node.bodyHash) {
          skipped += 1;
          options.warn?.(`Grounding review changed for ${nodeId} in ${scaffoldFile}; review it again.`);
          continue;
        }
      } else {
        const baselineHash = grounding?.bodyHash ?? previous?.bodyHash;
        if ((grounding && grounding.fingerprint !== serialized)
          || (baselineHash !== undefined && baselineHash !== node.bodyHash)) {
          skipped += 1;
          options.warn?.(`Preserved changed grounding ${nodeId} in ${scaffoldFile}; explicit review is required.`);
          continue;
        }
      }

      // The old body is evidence too. Never replace it with current code merely
      // because a structural fingerprint matches or an agent exited cleanly.
      const baseline = currentBaseline(config, scaffoldFile, nodeId, serialized, runtime);
      if (baseline === null) {
        skipped += 1;
        options.warn?.(`Skipped grounding baseline for non-body node ${nodeId} in ${scaffoldFile}.`);
        continue;
      }
      pendingBaselines.push(baseline);
      if (grounding && acceptance && grounding.fingerprint !== serialized) {
        grounding.fingerprint = serialized;
        dirty = true;
      }
      if (grounding && (grounding.bodyHash === undefined || acceptance) && grounding.bodyHash !== baseline.bodyHash) {
        grounding.bodyHash = baseline.bodyHash;
        dirty = true;
      }
    }
    if (readBoundedText(filePath, readLimit) !== content) {
      skipped += pendingBaselines.length;
      options.warn?.(`Grounding document ${scaffoldFile} changed during capture; review it again.`);
      continue;
    }
    if (pendingBaselines.some((entry) => currentBaseline(config, scaffoldFile, entry.nodeId, entry.fingerprint, runtime)?.bodyHash !== entry.bodyHash)) {
      skipped += pendingBaselines.length;
      options.warn?.(`Grounding source changed during capture for ${scaffoldFile}; review it again.`);
      continue;
    }
    if (readBoundedText(filePath, readLimit) !== content) {
      skipped += pendingBaselines.length;
      options.warn?.(`Grounding document ${scaffoldFile} changed before publication; review it again.`);
      continue;
    }
    if (dirty) replaceGroundingDocument(config, filePath, content, writeGroundings(content, groundings), readLimit);
    // Markdown is authoritative. A failed document publication leaves its old
    // cache untouched; a cache failure after publication cannot erase history.
    for (const baseline of pendingBaselines) {
      const previous = runtime.fingerprints.getGroundedSource(scaffoldFile, baseline.nodeId);
      if (previous?.bodyHash !== baseline.bodyHash || previous.fingerprint !== baseline.fingerprint) {
        runtime.fingerprints.saveGroundedSource(baseline);
      }
    }
    captured += pendingBaselines.length;
  }
  return { captured, skipped };
}

/** Produce a bounded review from current graph facts without changing a baseline. */
export function groundingReviewNodeIds(config: MexConfig, scaffoldFile: string): string[] | null {
  const filePath = resolveGroundingReviewFile(config, scaffoldFile);
  if (statSync(filePath).size > GROUNDING_REVIEW_MAX_BYTES) return null;
  const content = readBoundedText(filePath, GROUNDING_REVIEW_MAX_BYTES);
  return [...new Set(extractGroundings(content).map((entry) => entry.node))];
}

/** Produce a bounded review from current graph facts without changing a baseline. */
export function previewGroundingBaseline(
  config: MexConfig,
  scaffoldFile: string,
  nodeId: string,
  runtime: GroundingRuntime,
): GroundingBaselineReview | null {
  const filePath = resolveGroundingReviewFile(config, scaffoldFile);
  if (statSync(filePath).size > GROUNDING_REVIEW_MAX_BYTES) return null;
  const content = readBoundedText(filePath, GROUNDING_REVIEW_MAX_BYTES);
  const matching = extractGroundings(content).filter((entry) => entry.node === nodeId);
  if (matching.length !== 1) return null;
  const grounding = matching[0]!;
  const node = runtime.graph.getNode(nodeId);
  const fingerprint = runtime.reconciler.getFingerprint(nodeId);
  if (node?.id !== nodeId || !node.bodyHash || !fingerprint) return null;
  const serialized = serializeFingerprint(fingerprint);
  const previous = runtime.fingerprints.getGroundedSource(scaffoldFile, nodeId);
  if ((grounding.bodyHash ?? previous?.bodyHash) === node.bodyHash
    && grounding.fingerprint === serialized) return null;
  const newBody = readNodeBody(config.projectRoot, node.filePath, node.startLine, node.endLine);
  const oldBody = previous && (grounding.bodyHash === undefined || grounding.bodyHash === previous.bodyHash)
    && hashBody(previous.source) === previous.bodyHash ? previous.source : null;
  if (hashBody(newBody) !== node.bodyHash
    || Buffer.byteLength(newBody) > GROUNDING_REVIEW_MAX_BYTES
    || (oldBody !== null && Buffer.byteLength(oldBody) > GROUNDING_REVIEW_MAX_BYTES)) return null;
  return {
    acceptance: { scaffoldFile, nodeId, contentHash: hashText(content), fingerprint: serialized, bodyHash: node.bodyHash },
    content,
    oldBody,
    newBody,
  };
}

function resolveGroundingReviewFile(config: MexConfig, scaffoldFile: string): string {
  const filePath = resolve(config.projectRoot, scaffoldFile);
  const scaffoldRelative = relative(realpathSync(config.scaffoldRoot), realpathSync(filePath));
  if (isAbsolute(scaffoldFile)
    || relative(config.projectRoot, filePath).replaceAll("\\", "/") !== scaffoldFile
    || scaffoldRelative === "" || scaffoldRelative === ".." || scaffoldRelative.startsWith("../")
    || scaffoldRelative.startsWith("..\\") || isAbsolute(scaffoldRelative)
    || !filePath.endsWith(".md")) {
    throw new Error("Grounding review requires a Markdown file contained in the scaffold.");
  }
  return filePath;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Same normalized body bytes used by the graph; never bless a changed source read. */
function hashBody(source: string): string {
  return hashText(source.replace(/\s+/g, " ").trim());
}

export function groundingPromptContext(
  config: MexConfig,
  scaffoldFile: string,
  nodeId: string,
  runtime: GroundingRuntime,
  candidateId?: string,
): { nodeId: string; oldBody: string; newBody: string; candidateId?: string } | null {
  const baseline = runtime.reconciler.getGroundedSource(scaffoldFile, nodeId);
  const current = runtime.graph.getNode(candidateId ?? nodeId);
  if (!baseline || !current) return null;
  const grounding = extractGroundings(readBoundedText(resolve(config.projectRoot, scaffoldFile), GRAPH_CORPUS_LIMITS.maxSourceFileBytes))
    .find((entry) => entry.node === nodeId);
  if (grounding?.bodyHash !== undefined && grounding.bodyHash !== baseline.bodyHash) return null;
  return {
    nodeId,
    oldBody: baseline.source,
    newBody: readNodeBody(config.projectRoot, current.filePath, current.startLine, current.endLine),
    candidateId,
  };
}

/** Stage a graph-verified cache row. The caller publishes Markdown before saving it. */
function currentBaseline(
  config: MexConfig,
  scaffoldFile: string,
  nodeId: string,
  fingerprint: string,
  runtime: GroundingRuntime,
): GroundedSource | null {
  const node = runtime.graph.getNode(nodeId);
  if (!node?.bodyHash) return null;
  const body = readNodeBody(config.projectRoot, node.filePath, node.startLine, node.endLine);
  if (hashBody(body) !== node.bodyHash) return null;
  return {
    scaffoldFile,
    nodeId: node.id,
    source: body,
    bodyHash: node.bodyHash,
    fingerprint,
  };
}

function readNodeBody(root: string, filePath: string, startLine: number, endLine: number): string {
  return readBoundedText(resolve(root, filePath), GRAPH_CORPUS_LIMITS.maxSourceFileBytes)
    .split("\n").slice(startLine - 1, endLine).join("\n");
}

function readBoundedText(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error("Grounding file exceeds its read limit.");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    const after = fstatSync(fd, { bigint: true });
    if (length !== Number(before.size) || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("Grounding file changed during its read.");
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}

function replaceGroundingDocument(
  config: MexConfig,
  filePath: string,
  previous: string,
  next: string,
  readLimit: number,
): void {
  const scaffoldFile = relative(config.projectRoot, filePath).replaceAll("\\", "/");
  resolveGroundingReviewFile(config, scaffoldFile);
  const temporary = `${filePath}.grounding-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, next, { flag: "wx", mode: statSync(filePath).mode & 0o777 });
    resolveGroundingReviewFile(config, scaffoldFile);
    if (readBoundedText(filePath, readLimit) !== previous) {
      throw new Error("Grounding document changed before publication; review it again.");
    }
    renameSync(temporary, filePath);
  } finally {
    try { unlinkSync(temporary); } catch { /* A successful rename consumed it. */ }
  }
}
