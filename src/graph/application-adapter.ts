import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type {
  CodeResolution,
  CodeSymbol,
  GraphCodeResolutionRequest,
  GraphImpactNode,
  GraphImpactRequest,
  GraphImpactResult,
  GraphMaintenanceOptions,
  GraphPage,
  GraphPort,
  GraphRefreshResult,
  GraphRelation,
  GraphRelationRequest,
  GraphSource,
  GraphSourceMatch,
  GraphSourceReadRequest,
  GraphSourceSearchRequest,
  GraphStatus,
  GraphNodeSearchRequest,
} from "../team/contracts/graph.js";
import { GRAPH_READ_LIMITS } from "../team/contracts/graph.js";
import type {
  CodeRef,
  PageRequest,
  ProblemDetails,
} from "../team/contracts/shared.js";
import {
  isRepoRelativePath,
  MexPortError,
} from "../team/contracts/shared.js";
import type { SqliteDatabase } from "./db/sqlite.js";
import type { GraphEngine, SourceChunkMatch } from "./engine.js";
import { deserializeFingerprint, serializeFingerprint } from "./fingerprint.js";
import { FingerprintStore } from "./fingerprint-store.js";
import type { GroundingBaseline, GroundingSubject } from "./grounding.js";
import {
  GraphMaintenanceError,
  rebuildGraph,
  refreshGraph,
} from "./maintenance.js";
import {
  loadFreshGraphReadSession,
  type InternalFreshGraphReadSession,
  type InternalFreshGraphReadResult,
} from "./read-session.js";
import { MinHashReconciler } from "./reconcile-engine.js";
import type { Resolution } from "./reconcile.js";
import { GRAPH_SNAPSHOT_METADATA_KEY } from "./snapshot.js";
import { inspectGraphStatus } from "./status.js";
import { LANGUAGES, NODE_KINDS, type GraphNode } from "./types.js";

const MAX_CURSOR_BYTES = 4 * 1024;
const MAX_QUERY_CHARS = 256;
const MAX_SYMBOL_ID_CHARS = 512;
const MAX_GROUNDING_SYMBOLS = 50;
const MAX_SEARCH_RESULTS = 500;
const MAX_RELATION_RESULTS = 500;
const MAX_SIGNATURE_CHARS = 4 * 1024;
const MAX_PROVENANCE_CHARS = 128;
const MAX_SOURCE_SYMBOL_REFS = 20;
const CURSOR_VERSION = 1 as const;
const RELATION_PROVENANCE = new Set([
  "tree-sitter",
  "typescript-compiler",
  "callback-synthesis",
  "lexical",
  "framework",
  "heuristic",
]);

type CursorOperation = "nodes" | "sources" | "source" | "callers" | "callees";

interface GraphCursor {
  v: typeof CURSOR_VERSION;
  operation: CursorOperation;
  snapshotHash: string;
  requestHash: string;
  offset: number;
}

interface FreshContext {
  session: InternalFreshGraphReadSession;
  revision: string;
  status: GraphStatus;
}

export type GraphBundleGroup<T> =
  | { ok: true; value: T }
  | { ok: false; problem: ProblemDetails };

export interface GraphSearchBundleRequest {
  nodes: GraphNodeSearchRequest;
  sources: GraphSourceSearchRequest;
}

export interface GraphSearchBundleResult {
  revision: string;
  status: GraphStatus;
  nodes: GraphBundleGroup<GraphPage<CodeSymbol>>;
  sources: GraphBundleGroup<GraphPage<GraphBoundedSourceMatch>>;
}

/** @internal Exact clipping state for Hub source previews. */
export interface GraphBoundedSourceMatch extends GraphSourceMatch {
  linesTruncated: boolean;
  bytesTruncated: boolean;
}

export interface GraphSymbolWorkspaceRequest {
  symbolId: string;
  workspaceView?: "overview" | "callers" | "callees" | "impact";
  source: {
    cursor?: string;
    limit?: number;
    maxLines: number;
    maxBytes: number;
  };
  callers?: PageRequest;
  callees?: PageRequest;
  impact?: {
    depth: number;
    maxNodes: number;
  };
}

export interface GraphSymbolWorkspaceResult {
  revision: string;
  status: GraphStatus;
  symbol: CodeSymbol;
  source: GraphPage<GraphSource>;
  callers: GraphPage<GraphRelation> | null;
  callees: GraphPage<GraphRelation> | null;
  impact: GraphImpactResult | null;
}

/** @internal Grounding-safe projection of one graph node. */
export interface RepositoryGraphGroundedNode {
  id: string;
  bodyHash: string | null;
  filePath: string;
  startLine: number;
  endLine: number;
}

/**
 * @internal Package-private graph snapshot used by Wiki grounding.
 *
 * The shape is intentionally structural and graph-owned: this module never
 * imports Wiki code. Every method reads the same immutable SQLite snapshot,
 * and the snapshot cannot escape `withFreshGroundingSnapshot`.
 */
export interface RepositoryGraphGroundingSnapshot {
  /** Exact immutable graph snapshot revision, for composite Wiki cursors. */
  readonly revision: string;
  getNode(nodeId: string): RepositoryGraphGroundedNode | null;
  /** Up to 50 direct symbols, in request order without duplicates or source bodies. */
  getSymbols(nodeIds: readonly string[]): readonly CodeSymbol[];
  getFingerprint(nodeId: string): string | null;
  reconcile(nodeId: string, committedFingerprint: string, bodyHash?: string): Resolution | null;
  getBaselineSource(subject: GroundingSubject, nodeId: string): GroundingBaseline | null;
}

/**
 * @internal Opaque two-phase publication prepared while Graph is fresh.
 *
 * The graph adapter final-validates its immutable snapshot before calling
 * `commit`. If that validation fails, it calls `discard` instead. Candidate
 * paths, SQLite handles, and source bytes never cross this boundary.
 */
export interface RepositoryGraphPreparedPublication<T> {
  preflight(): void | Promise<void>;
  commit(): T | Promise<T>;
  discard(): void | Promise<void>;
}

class GroundingSnapshotCallbackError {
  constructor(readonly cause: unknown) {}
}

interface AdapterDependencies {
  inspectStatus: typeof inspectGraphStatus;
  loadFresh: typeof loadFreshGraphReadSession;
  refresh: typeof refreshGraph;
  rebuild: typeof rebuildGraph;
}

export interface RepositoryGraphPortOptions {
  dbPath?: string;
  /** Hub construction runs separately; ordinary readers and CLI keep their defaults. */
  candidateExecution?: "process";
  /** @internal Deterministic dependency seams for adapter conformance tests. */
  __internal?: Partial<AdapterDependencies>;
}

/**
 * Repository-bound application adapter over the existing graph engine.
 *
 * Discovery methods preserve engine relevance order. Every returned read is
 * buffered under one immutable session and released only after final freshness
 * revalidation succeeds.
 */
export class RepositoryGraphPort implements GraphPort {
  readonly #projectRoot: string;
  readonly #dbPath: string;
  readonly #deps: AdapterDependencies;
  readonly #candidateExecution?: "process";

  constructor(projectRoot: string, options: RepositoryGraphPortOptions = {}) {
    this.#projectRoot = resolve(projectRoot);
    this.#dbPath = options.dbPath ?? resolve(this.#projectRoot, ".mex", "graph.db");
    this.#candidateExecution = options.candidateExecution;
    this.#deps = {
      inspectStatus: options.__internal?.inspectStatus ?? inspectGraphStatus,
      loadFresh: options.__internal?.loadFresh ?? loadFreshGraphReadSession,
      refresh: options.__internal?.refresh ?? refreshGraph,
      rebuild: options.__internal?.rebuild ?? rebuildGraph,
    };
  }

  async inspectStatus(): Promise<GraphStatus> {
    try {
      return await this.#deps.inspectStatus({
        projectRoot: this.#projectRoot,
        dbPath: this.#dbPath,
      });
    } catch {
      throw portError(
        "INDEX_CORRUPT",
        503,
        "Graph status unavailable",
        "The graph status could not be inspected safely.",
      );
    }
  }

  async refresh(options: GraphMaintenanceOptions = {}): Promise<GraphRefreshResult> {
    return this.#maintain("refresh", options);
  }

  async rebuild(options: GraphMaintenanceOptions = {}): Promise<GraphRefreshResult> {
    return this.#maintain("rebuild", options);
  }

  async searchNodes(request: GraphNodeSearchRequest): Promise<GraphPage<CodeSymbol>> {
    return (await this.#withFresh((context) => searchNodes(context, request))).value;
  }

  async searchSource(request: GraphSourceSearchRequest): Promise<GraphPage<GraphBoundedSourceMatch>> {
    return (await this.#withFresh((context) => searchSources(context, request))).value;
  }

  async getNode(id: string): Promise<CodeSymbol | null> {
    return (await this.#withFresh((context) => {
      const safeId = validateSymbolId(id);
      const node = context.session.graph.getNode(safeId);
      return node ? projectNode(node) : null;
    })).value;
  }

  async readSource(request: GraphSourceReadRequest): Promise<GraphPage<GraphSource>> {
    return (await this.#withFresh((context) => readSource(context, request))).value;
  }

  async getCallers(request: GraphRelationRequest): Promise<GraphPage<GraphRelation>> {
    return (await this.#withFresh((context) => readRelations(context, request, "callers"))).value;
  }

  async getCallees(request: GraphRelationRequest): Promise<GraphPage<GraphRelation>> {
    return (await this.#withFresh((context) => readRelations(context, request, "callees"))).value;
  }

  async getImpact(request: GraphImpactRequest): Promise<GraphImpactResult> {
    return (await this.#withFresh((context) => readImpact(context, request))).value;
  }

  async resolveCodeRef(request: GraphCodeResolutionRequest): Promise<CodeResolution> {
    return (await this.#withFresh((context) => resolveCodeReference(context, request))).value;
  }

  /** @internal Home/Search workbench read with independent group failures. */
  async searchBundle(request: GraphSearchBundleRequest): Promise<GraphSearchBundleResult> {
    const read = await this.#withFresh((context) => ({
      nodes: settleSearchGroup(() => searchNodes(context, request.nodes)),
      sources: settleSearchGroup(() => searchSources(context, request.sources)),
    }));
    return {
      revision: read.revision,
      status: read.status,
      ...read.value,
    };
  }

  /** @internal Symbol detail and selected traversal under one freshness proof. */
  async readSymbolWorkspace(
    request: GraphSymbolWorkspaceRequest,
  ): Promise<GraphSymbolWorkspaceResult> {
    const read = await this.#withFresh((context) => {
      const symbolId = validateSymbolId(request.symbolId);
      const node = context.session.graph.getNode(symbolId);
      if (!node) throw notFound("The requested graph symbol does not exist.");
      const canonicalId = node.id;
      const workspaceView = validateWorkspaceView(request.workspaceView);
      const sourceRequest: GraphSourceReadRequest = {
        ref: { kind: "symbol", symbolId: canonicalId },
        maxLines: request.source.maxLines,
        maxBytes: request.source.maxBytes,
        ...(request.source.cursor === undefined ? {} : { cursor: request.source.cursor }),
        ...(request.source.limit === undefined ? {} : { limit: request.source.limit }),
      };
      return {
        symbol: projectNode(node),
        source: readSource(context, sourceRequest, { workspaceView }),
        callers: request.callers
          ? readRelations(context, { ...request.callers, symbolId: canonicalId }, "callers")
          : null,
        callees: request.callees
          ? readRelations(context, { ...request.callees, symbolId: canonicalId }, "callees")
          : null,
        impact: request.impact
          ? readImpact(context, {
              ref: { kind: "symbol", symbolId: canonicalId },
              depth: request.impact.depth,
              maxNodes: request.impact.maxNodes,
            })
          : null,
      };
    });
    return {
      revision: read.revision,
      status: read.status,
      ...read.value,
    };
  }

  /**
   * @internal Run Wiki grounding work against one exact fresh Graph snapshot.
   *
   * The callback may be asynchronous. Final Graph freshness revalidation and
   * descriptor cleanup happen only after it settles, so callers cannot mix a
   * Wiki snapshot with Graph facts from two revisions.
   */
  async withFreshGroundingSnapshot<T>(
    callback: (snapshot: RepositoryGraphGroundingSnapshot) => T | Promise<T>,
  ): Promise<T> {
    try {
      const read = await this.#withFresh(async (context) => {
        const snapshot = this.#groundingSnapshot(context);
        try {
          return await callback(snapshot.value);
        } catch (error) {
          throw new GroundingSnapshotCallbackError(error);
        } finally {
          snapshot.revoke();
        }
      });
      return read.value;
    } catch (error) {
      if (error instanceof GroundingSnapshotCallbackError) throw error.cause;
      throw error;
    }
  }

  /**
   * @internal Prepare a Wiki candidate under Graph, then publish it only after
   * Graph's final freshness proof succeeds and before the Graph session closes.
   */
  async withFreshGroundingPublication<T>(
    prepare: (
      snapshot: RepositoryGraphGroundingSnapshot,
    ) => RepositoryGraphPreparedPublication<T> | Promise<RepositoryGraphPreparedPublication<T>>,
  ): Promise<T> {
    let prepared: RepositoryGraphPreparedPublication<T> | undefined;
    let commitStarted = false;
    let committed: T | undefined;
    try {
      await this.#withFresh(async (context) => {
        const snapshot = this.#groundingSnapshot(context);
        try {
          prepared = await prepare(snapshot.value);
          await prepared.preflight();
          return prepared;
        } catch (error) {
          throw new GroundingSnapshotCallbackError(error);
        } finally {
          snapshot.revoke();
        }
      }, async (publication) => {
        commitStarted = true;
        committed = await publication.commit();
      });
      return committed!;
    } catch (error) {
      if (prepared !== undefined && !commitStarted) {
        try {
          await prepared.discard();
        } catch {
          // The candidate stays private and no Wiki generation was published.
          // Preserve the primary Graph/callback failure at this boundary.
        }
      }
      if (error instanceof GroundingSnapshotCallbackError) throw error.cause;
      throw error;
    }
  }

  #groundingSnapshot(context: FreshContext): {
    value: RepositoryGraphGroundingSnapshot;
    revoke(): void;
  } {
      const store = new FingerprintStore(context.session.db);
      const reconciler = new MinHashReconciler(store);
      let active = true;
      const assertActive = (): void => {
        if (!active) {
          throw interruptedRead("The graph grounding snapshot is no longer active.");
        }
      };
      const snapshot: RepositoryGraphGroundingSnapshot = {
        revision: context.revision,
        getSymbols(nodeIds) {
          assertActive();
          if (!Array.isArray(nodeIds) || nodeIds.length > MAX_GROUNDING_SYMBOLS) {
            throw invalid("A grounding symbol request accepts at most 50 node IDs.");
          }
          const ids = [...new Set(Array.from(nodeIds, validateSymbolId))];
          try {
            return ids.flatMap((id) => {
              const node = context.session.graph.getNode(id);
              // Graph point reads also follow aliases. Only the requested
              // declaration belongs in this direct-symbol projection.
              return node?.id === id ? [projectNode(node)] : [];
            });
          } catch {
            throw interruptedRead("The graph grounding snapshot could not read symbols safely.");
          }
        },
        getNode(nodeId) {
          assertActive();
          try {
            const node = context.session.graph.getNode(nodeId);
            return node === null ? null : {
              id: node.id,
              bodyHash: node.bodyHash ?? null,
              filePath: node.filePath,
              startLine: node.startLine,
              endLine: node.endLine,
            };
          } catch {
            throw interruptedRead("The graph grounding snapshot could not read a node safely.");
          }
        },
        getFingerprint(nodeId) {
          assertActive();
          try {
            const fingerprint = store.get(nodeId);
            return fingerprint === null ? null : serializeFingerprint(fingerprint);
          } catch {
            throw interruptedRead("The graph grounding snapshot could not read a fingerprint safely.");
          }
        },
        reconcile(nodeId, committedFingerprint, bodyHash) {
          assertActive();
          try {
            const fingerprint = deserializeFingerprint(committedFingerprint);
            return fingerprint === null ? null : reconciler.reconcile(nodeId, fingerprint, bodyHash);
          } catch {
            throw interruptedRead("The graph grounding snapshot could not reconcile a code reference safely.");
          }
        },
        getBaselineSource(subject, nodeId) {
          assertActive();
          try {
            return store.getBaseline(subject, nodeId);
          } catch {
            throw interruptedRead("The graph grounding snapshot could not read a baseline safely.");
          }
        },
      };
      return {
        value: snapshot,
        revoke() {
          active = false;
        },
      };
  }

  async #maintain(
    operation: "refresh" | "rebuild",
    options: GraphMaintenanceOptions,
  ): Promise<GraphRefreshResult> {
    const executionOptions = this.#candidateExecution
      ? { ...options, candidateExecution: this.#candidateExecution }
      : options;
    try {
      return operation === "refresh"
        ? await this.#deps.refresh(this.#projectRoot, executionOptions)
        : await this.#deps.rebuild(this.#projectRoot, executionOptions);
    } catch (error) {
      throw translateMaintenanceError(error);
    }
  }

  async #withFresh<T>(
    build: (context: FreshContext) => T | Promise<T>,
    afterValidation?: (value: T) => void | Promise<void>,
  ): Promise<{
    revision: string;
    status: GraphStatus;
    value: T;
  }> {
    let loaded: InternalFreshGraphReadResult;
    try {
      loaded = await this.#deps.loadFresh(this.#projectRoot, {
        dbPath: this.#dbPath,
        loadSession: true,
      });
    } catch {
      throw interruptedRead("The graph changed or became unavailable before the read began.");
    }
    const session = loaded.session;
    if (!session) throw errorForStatus(loaded.graphStatus);
    try {
      const revision = readSnapshotRevision(session.db);
      const context: FreshContext = {
        session,
        revision,
        status: session.graphStatus,
      };
      let value: T;
      try {
        value = await build(context);
      } catch (error) {
        let validation;
        try {
          validation = session.validate();
        } catch {
          throw interruptedRead("The graph could not be revalidated after a read failure.");
        }
        if (!validation.valid) {
          throw interruptedRead("The graph changed while the read was being prepared.");
        }
        if (error instanceof MexPortError || error instanceof GroundingSnapshotCallbackError) throw error;
        throw corruptIndex("Graph data could not be read safely.");
      }
      let final;
      try {
        final = await session.revalidateFreshness();
      } catch {
        throw interruptedRead("Graph freshness could not be revalidated after the read.");
      }
      if (!final.valid) {
        throw interruptedRead("Graph freshness changed while the read was being prepared.");
      }
      await afterValidation?.(value);
      return { revision, status: final.graphStatus, value };
    } finally {
      try {
        session.close();
      } catch {
        // No graph-derived value is returned before this point. Closing an
        // immutable read handle is best-effort and never exposes raw failures.
      }
    }
  }
}

export function createRepositoryGraphPort(
  projectRoot: string,
  options: RepositoryGraphPortOptions = {},
): RepositoryGraphPort {
  return new RepositoryGraphPort(projectRoot, options);
}

function settleSearchGroup<T>(read: () => T): GraphBundleGroup<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (
      error instanceof MexPortError
      && (error.problem.code === "VALIDATION_FAILED"
        || error.problem.code === "REVISION_CONFLICT")
    ) {
      return { ok: false, problem: error.problem };
    }
    throw error;
  }
}

function searchNodes(
  context: FreshContext,
  request: GraphNodeSearchRequest,
): GraphPage<CodeSymbol> {
  const query = validateQuery(request.query);
  const limit = validatePageLimit(request.limit);
  const symbolKinds = validateSet(request.symbolKinds, NODE_KINDS, "symbolKinds");
  const languages = validateSet(request.languages, LANGUAGES, "languages");
  const requestHash = hashRequest({ query, symbolKinds, languages, limit });
  const offset = decodeCursorOffset(request.cursor, "nodes", context.revision, requestHash);
  const nodes = context.session.graph.searchNodes(query, {
    limit: MAX_SEARCH_RESULTS + 1,
    ...(symbolKinds.length === 0 ? {} : { kinds: symbolKinds }),
    ...(languages.length === 0 ? {} : { languages }),
  });
  const available = Math.min(nodes.length, MAX_SEARCH_RESULTS);
  if (offset > available || (request.cursor !== undefined && offset >= available)) {
    throw invalidCursor("The graph cursor points beyond the available node results.");
  }
  const items = nodes.slice(offset, Math.min(offset + limit, available)).map(projectNode);
  const hasMore = offset + items.length < available;
  return {
    items,
    nextCursor: hasMore
      ? encodeCursor("nodes", context.revision, requestHash, offset + items.length)
      : null,
    truncated: nodes.length > MAX_SEARCH_RESULTS,
  };
}

function searchSources(
  context: FreshContext,
  request: GraphSourceSearchRequest,
): GraphPage<GraphBoundedSourceMatch> {
  const query = validateQuery(request.query);
  const limit = validatePageLimit(request.limit);
  const maxLines = validateBound(
    request.maxLinesPerMatch,
    1,
    GRAPH_READ_LIMITS.maxSourceLines,
    "maxLinesPerMatch",
  );
  const maxBytes = validateBound(
    request.maxBytesPerMatch,
    1,
    GRAPH_READ_LIMITS.maxSourceBytes,
    "maxBytesPerMatch",
  );
  const requestHash = hashRequest({ query, maxLines, maxBytes, limit });
  const offset = decodeCursorOffset(request.cursor, "sources", context.revision, requestHash);
  const search = context.session.graph.searchSource;
  if (!search) throw corruptIndex("The graph source-search reader is unavailable.");
  const matches = search.call(context.session.graph, query, MAX_SEARCH_RESULTS + 1);
  const available = Math.min(matches.length, MAX_SEARCH_RESULTS);
  if (offset > available || (request.cursor !== undefined && offset >= available)) {
    throw invalidCursor("The graph cursor points beyond the available source results.");
  }
  let projectionTruncated = false;
  const items = matches
    .slice(offset, Math.min(offset + limit, available))
    .map((match) => {
      const projected = projectSourceMatch(context, match, maxLines, maxBytes);
      projectionTruncated ||= projected.truncated;
      return projected.value;
    });
  const hasMore = offset + items.length < available;
  return {
    items,
    nextCursor: hasMore
      ? encodeCursor("sources", context.revision, requestHash, offset + items.length)
      : null,
    truncated: matches.length > MAX_SEARCH_RESULTS || projectionTruncated,
  };
}

function projectSourceMatch(
  context: FreshContext,
  match: SourceChunkMatch,
  maxLines: number,
  maxBytes: number,
): { value: GraphBoundedSourceMatch; truncated: boolean } {
  const path = validateStoredPath(match.filePath);
  const startLine = validateStoredLine(match.startLine);
  const endLine = validateStoredLine(match.endLine);
  if (endLine < startLine) throw corruptIndex("The graph source range is invalid.");
  const fullSource = readIndexedSource(context, path);
  const lines = fullSource.split("\n");
  if (startLine > lines.length || endLine > lines.length) {
    throw corruptIndex("A graph source match falls outside its indexed file.");
  }
  const boundedEnd = Math.min(endLine, startLine + maxLines - 1, lines.length);
  const selected = lines.slice(startLine - 1, boundedEnd).join("\n");
  const clipped = truncateUtf8(selected, maxBytes);
  const actualEndLine = startLine + contentLineSpan(clipped.value);
  const symbolRefs = (match.nodeIds ?? [])
    .slice(0, MAX_SOURCE_SYMBOL_REFS)
    .map((symbolId) => ({ kind: "symbol" as const, symbolId: validateStoredSymbolId(symbolId) }));
  const rawMatchedTerms = match.matchedTerms ?? [];
  if (!Array.isArray(rawMatchedTerms)) {
    throw corruptIndex("The graph contains invalid source-search terms.");
  }
  const matchedTerms = [...new Set(rawMatchedTerms
    .map((term) => validateStoredText(term, MAX_QUERY_CHARS, "source-search term").normalize("NFC")))]
    .slice(0, 20);
  return {
    value: {
      path,
      startLine,
      endLine: Math.max(startLine, actualEndLine),
      content: clipped.value,
      contentHash: validateStoredHash(match.contentHash),
      symbolRefs,
      rank: validateStoredRank(match.rank),
      matchedTerms,
      linesTruncated: boundedEnd < endLine,
      bytesTruncated: clipped.truncated,
    },
    truncated: boundedEnd < endLine
      || clipped.truncated
      || (match.nodeIds?.length ?? 0) > MAX_SOURCE_SYMBOL_REFS
      || (match.matchedTerms?.length ?? 0) > matchedTerms.length,
  };
}

function readSource(
  context: FreshContext,
  request: GraphSourceReadRequest,
  cursorBinding?: { workspaceView: "overview" | "callers" | "callees" | "impact" },
): GraphPage<GraphSource> {
  const limit = validatePageLimit(request.limit);
  const maxLines = validateBound(request.maxLines, 1, GRAPH_READ_LIMITS.maxSourceLines, "maxLines");
  const maxBytes = validateBound(request.maxBytes, 1, GRAPH_READ_LIMITS.maxSourceBytes, "maxBytes");
  const target = resolveSourceTarget(context, request.ref);
  const requestHash = hashRequest({
    ref: target.ref,
    maxLines,
    maxBytes,
    limit,
    ...(cursorBinding === undefined ? {} : { cursorBinding }),
  });
  const offset = decodeCursorOffset(request.cursor, "source", context.revision, requestHash);
  if (limit < 1) throw invalid("limit must be at least 1.");

  const source = readIndexedSource(context, target.path);
  const sourceLines = source.split("\n");
  if (target.startLine > sourceLines.length || target.endLine > sourceLines.length) {
    throw corruptIndex("A graph source range falls outside its indexed file.");
  }
  const rangeText = sourceLines.slice(target.startLine - 1, target.endLine).join("\n");
  const bytes = Buffer.from(rangeText, "utf8");
  if (offset > bytes.length || !isUtf8Boundary(bytes, offset)) {
    throw invalidCursor("The source cursor does not identify a valid continuation point.");
  }
  if (request.cursor !== undefined && offset === bytes.length) {
    throw invalidCursor("The source cursor points beyond the available source content.");
  }
  const sliced = sliceSourcePage(rangeText, offset, maxLines, maxBytes);
  const prefixText = bytes.subarray(0, offset).toString("utf8");
  const startLine = target.startLine + countNewlines(prefixText);
  const endLine = Math.max(startLine, startLine + contentLineSpan(sliced.content));
  const nextOffset = offset + sliced.bytesConsumed;
  const hasMore = nextOffset < bytes.length;
  return {
    items: [{
      path: target.path,
      startLine,
      endLine,
      content: sliced.content,
      contentHash: target.contentHash,
      symbolRefs: target.symbolRefs,
    }],
    nextCursor: hasMore
      ? encodeCursor("source", context.revision, requestHash, nextOffset)
      : null,
    truncated: false,
  };
}

interface SourceTarget {
  ref: CodeRef;
  path: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  symbolRefs: readonly { kind: "symbol"; symbolId: string }[];
}

function resolveSourceTarget(context: FreshContext, ref: CodeRef): SourceTarget {
  if (!ref || typeof ref !== "object") throw invalid("ref must identify a symbol or indexed file.");
  if (ref.kind === "symbol") {
    const symbolId = validateSymbolId(ref.symbolId);
    validateOptionalFingerprint(ref.fingerprint);
    const node = context.session.graph.getNode(symbolId);
    if (!node) throw notFound("The requested graph symbol does not exist.");
    const projected = projectNode(node);
    const file = readFileRecord(context.session.db, projected.path);
    if (!file) throw corruptIndex("The graph symbol references an unindexed source file.");
    return {
      ref: {
        kind: "symbol",
        symbolId: node.id,
        ...(ref.fingerprint === undefined ? {} : { fingerprint: ref.fingerprint }),
      },
      path: projected.path,
      startLine: projected.startLine,
      endLine: projected.endLine,
      contentHash: file.contentHash,
      symbolRefs: [{ kind: "symbol", symbolId: node.id }],
    };
  }
  if (ref.kind === "file") {
    const path = validateRequestedPath(ref.path);
    validateOptionalFingerprint(ref.fingerprint);
    const file = readFileRecord(context.session.db, path);
    if (!file) throw notFound("The requested file is not present in the graph index.");
    const source = readIndexedSource(context, path);
    return {
      ref: {
        kind: "file",
        path,
        ...(ref.fingerprint === undefined ? {} : { fingerprint: ref.fingerprint }),
      },
      path,
      startLine: 1,
      endLine: Math.max(1, source.split("\n").length),
      contentHash: file.contentHash,
      symbolRefs: [],
    };
  }
  throw invalid("ref must identify a symbol or indexed file.");
}

function readRelations(
  context: FreshContext,
  request: GraphRelationRequest,
  direction: "callers" | "callees",
): GraphPage<GraphRelation> {
  const requestedId = validateSymbolId(request.symbolId);
  const target = context.session.graph.getNode(requestedId);
  if (!target) throw notFound("The requested graph symbol does not exist.");
  const canonicalId = target.id;
  const limit = validatePageLimit(request.limit);
  const requestHash = hashRequest({ symbolId: canonicalId, limit });
  const offset = decodeCursorOffset(request.cursor, direction, context.revision, requestHash);
  const rows = queryRelationRows(
    context.session.db,
    canonicalId,
    direction,
    MAX_RELATION_RESULTS + 1,
  );
  const available = Math.min(rows.length, MAX_RELATION_RESULTS);
  if (offset > available || (request.cursor !== undefined && offset >= available)) {
    throw invalidCursor("The graph cursor points beyond the available relation results.");
  }
  const items = rows
    .slice(offset, Math.min(offset + limit, available))
    .map(projectRelationRow);
  const hasMore = offset + items.length < available;
  return {
    items,
    nextCursor: hasMore
      ? encodeCursor(direction, context.revision, requestHash, offset + items.length)
      : null,
    truncated: rows.length > MAX_RELATION_RESULTS,
  };
}

interface RelationRow {
  source: string;
  target: string;
  kind: string;
  line: number | null;
  col: number | null;
  confidence: number | null;
  provenance: string | null;
  source_path: string;
}

function queryRelationRows(
  db: SqliteDatabase,
  symbolId: string,
  direction: "callers" | "callees",
  limit: number,
): RelationRow[] {
  const predicate = direction === "callers" ? "edges.target = ?" : "edges.source = ?";
  return db.prepare(
    `SELECT edges.source, edges.target, edges.kind, edges.line, edges.col,
            edges.confidence, edges.provenance, source_nodes.file_path AS source_path
       FROM edges
       JOIN nodes source_nodes ON source_nodes.id = edges.source
      WHERE ${predicate} AND edges.kind = 'calls'
      ORDER BY edges.source, edges.target, edges.kind,
               IFNULL(edges.line, -1), IFNULL(edges.col, -1), edges.id
      LIMIT ?`,
  ).all(symbolId, limit) as RelationRow[];
}

function projectRelationRow(row: RelationRow): GraphRelation {
  const relation: GraphRelation = {
    kind: validateStoredText(row.kind, 64, "relation kind"),
    source: { kind: "symbol", symbolId: validateStoredSymbolId(row.source) },
    target: { kind: "symbol", symbolId: validateStoredSymbolId(row.target) },
    path: validateStoredPath(row.source_path),
  };
  if (row.line !== null) relation.line = validateStoredLine(row.line);
  if (row.col !== null) relation.column = validateStoredNonNegative(row.col, "column");
  if (row.confidence !== null) {
    if (!Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1) {
      throw corruptIndex("A graph relation has invalid confidence.");
    }
    relation.confidence = row.confidence;
  }
  if (row.provenance !== null) {
    const provenance = validateStoredText(row.provenance, MAX_PROVENANCE_CHARS, "provenance");
    if (!RELATION_PROVENANCE.has(provenance)) {
      throw corruptIndex("A graph relation has invalid provenance.");
    }
    relation.provenance = provenance;
  }
  return relation;
}

function readImpact(context: FreshContext, request: GraphImpactRequest): GraphImpactResult {
  const depth = validateBound(request.depth, 0, GRAPH_READ_LIMITS.maxImpactDepth, "depth");
  const maxNodes = validateBound(request.maxNodes, 1, GRAPH_READ_LIMITS.maxImpactNodes, "maxNodes");
  const normalizedRef = validateCodeRef(request.ref);
  const rootResult = resolveImpactRoots(context, normalizedRef, maxNodes);
  const roots = rootResult.nodes;
  const impacted: GraphImpactNode[] = [];
  const relations: GraphRelation[] = [];
  const visited = new Set(roots.map((node) => node.id));
  let frontier = roots.map((node) => ({ node, root: node.id }));
  let truncated = rootResult.truncated;

  for (let currentDepth = 1; currentDepth <= depth && frontier.length > 0; currentDepth += 1) {
    const next: Array<{ node: GraphNode; root: string }> = [];
    for (const entry of frontier) {
      const rows = queryDistinctCallerRows(
        context.session.db,
        entry.node.id,
        maxNodes + 1,
      );
      for (const row of rows) {
        if (visited.has(row.source)) continue;
        if (visited.size >= maxNodes) {
          truncated = true;
          continue;
        }
        const caller = context.session.graph.getNode(row.source);
        if (!caller) throw corruptIndex("A graph relation references a missing symbol.");
        visited.add(caller.id);
        impacted.push({
          symbol: projectNode(caller),
          depth: currentDepth,
          root: { kind: "symbol", symbolId: entry.root },
        });
        relations.push(projectRelationRow(row));
        next.push({ node: caller, root: entry.root });
      }
    }
    frontier = next;
  }
  if (frontier.length > 0) {
    for (const entry of frontier) {
      if (queryDistinctCallerRows(context.session.db, entry.node.id, maxNodes + 1)
        .some((row) => !visited.has(row.source))) {
        truncated = true;
        break;
      }
    }
  }
  return {
    target: normalizedRef,
    roots: roots.map(projectNode),
    impacted,
    relations,
    truncated,
  };
}

function queryDistinctCallerRows(
  db: SqliteDatabase,
  symbolId: string,
  limit: number,
): RelationRow[] {
  return db.prepare(
    `WITH ranked_callers AS (
       SELECT edges.source, edges.target, edges.kind, edges.line, edges.col,
              edges.confidence, edges.provenance,
              source_nodes.file_path AS source_path,
              ROW_NUMBER() OVER (
                PARTITION BY edges.source
                ORDER BY IFNULL(edges.line, -1), IFNULL(edges.col, -1), edges.id
              ) AS caller_rank
         FROM edges
         JOIN nodes source_nodes ON source_nodes.id = edges.source
        WHERE edges.target = ? AND edges.kind = 'calls'
     )
     SELECT source, target, kind, line, col, confidence, provenance, source_path
       FROM ranked_callers
      WHERE caller_rank = 1
      ORDER BY source, target, kind, IFNULL(line, -1), IFNULL(col, -1)
      LIMIT ?`,
  ).all(symbolId, limit) as RelationRow[];
}

function resolveImpactRoots(
  context: FreshContext,
  ref: CodeRef,
  maxNodes: number,
): { nodes: GraphNode[]; truncated: boolean } {
  if (ref.kind === "symbol") {
    const node = context.session.graph.getNode(ref.symbolId);
    if (!node) throw notFound("The requested graph symbol does not exist.");
    return { nodes: [node], truncated: false };
  }
  const rows = context.session.db.prepare(
    `SELECT id FROM nodes WHERE file_path = ? ORDER BY start_line, end_line, id LIMIT ?`,
  ).all(ref.path, maxNodes + 1) as Array<{ id: string }>;
  if (rows.length === 0 && !readFileRecord(context.session.db, ref.path)) {
    throw notFound("The requested file is not present in the graph index.");
  }
  const nodes = rows.slice(0, maxNodes).map((row) => {
    const node = context.session.graph.getNode(validateStoredSymbolId(row.id));
    if (!node) throw corruptIndex("A graph impact root disappeared from the snapshot.");
    return node;
  });
  return { nodes, truncated: rows.length > maxNodes };
}

function resolveCodeReference(
  context: FreshContext,
  request: GraphCodeResolutionRequest,
): CodeResolution {
  const maxCandidates = validateBound(
    request.maxCandidates,
    1,
    GRAPH_READ_LIMITS.maxResolutionCandidates,
    "maxCandidates",
  );
  const ref = validateCodeRef(request.ref);
  if (ref.kind === "file") return resolveFileReference(context, ref);

  const exact = context.session.graph.getNode(ref.symbolId);
  const fingerprint = ref.fingerprint === undefined ? null : deserializeFingerprint(ref.fingerprint);
  if (ref.fingerprint !== undefined && !fingerprint) {
    return {
      status: "unverified",
      ref,
      health: "unverified",
      detail: "The stored symbol fingerprint is invalid.",
    };
  }
  const store = new FingerprintStore(context.session.db);
  if (exact) {
    const resolvedRef = {
      kind: "symbol" as const,
      symbolId: exact.id,
      ...(ref.fingerprint === undefined ? {} : { fingerprint: ref.fingerprint }),
    };
    if (!fingerprint) {
      return {
        status: "resolved",
        ref,
        health: "fresh",
        resolvedRef,
        symbol: projectNode(exact),
      };
    }
    const current = store.get(exact.id);
    if (!current) {
      return {
        status: "unverified",
        ref,
        health: "unverified",
        detail: "The current graph has no fingerprint for this symbol.",
      };
    }
    return {
      status: "resolved",
      ref,
      health: serializeFingerprint(current) === ref.fingerprint ? "fresh" : "changed",
      resolvedRef,
      symbol: projectNode(exact),
    };
  }
  if (!fingerprint) return { status: "missing", ref, health: "missing" };
  const resolution = new MinHashReconciler(store).reconcile(ref.symbolId, fingerprint);
  if (resolution.kind === "GONE") return { status: "missing", ref, health: "missing" };
  const candidateId = resolution.kind === "MOVED" ? resolution.nodeId : resolution.candidate;
  const candidate = context.session.graph.getNode(candidateId);
  if (!candidate) {
    return {
      status: "unverified",
      ref,
      health: "unverified",
      detail: "The graph reconciliation candidate could not be verified.",
    };
  }
  if (resolution.kind === "AMBIGUOUS") {
    const candidates = [projectNode(candidate)].slice(0, maxCandidates);
    return {
      status: "ambiguous",
      ref,
      health: "ambiguous",
      candidates,
      truncated: false,
    };
  }
  return {
    status: "resolved",
    ref,
    health: "fresh",
    resolvedRef: {
      kind: "symbol",
      symbolId: candidate.id,
      fingerprint: ref.fingerprint,
    },
    symbol: projectNode(candidate),
  };
}

function resolveFileReference(
  context: FreshContext,
  ref: Extract<CodeRef, { kind: "file" }>,
): CodeResolution {
  if (ref.fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(ref.fingerprint)) {
    return {
      status: "unverified",
      ref,
      health: "unverified",
      detail: "The stored file fingerprint is invalid.",
    };
  }
  const file = readFileRecord(context.session.db, ref.path);
  if (!file) return { status: "missing", ref, health: "missing" };
  const resolvedRef = {
    kind: "file" as const,
    path: ref.path,
    ...(ref.fingerprint === undefined ? {} : { fingerprint: ref.fingerprint }),
  };
  return {
    status: "resolved",
    ref,
    health: ref.fingerprint === undefined || ref.fingerprint === file.contentHash
      ? "fresh"
      : "changed",
    resolvedRef,
  };
}

function validateCodeRef(ref: CodeRef): CodeRef {
  if (!ref || typeof ref !== "object") throw invalid("ref must identify a symbol or indexed file.");
  if (ref.kind === "symbol") {
    const symbolId = validateSymbolId(ref.symbolId);
    validateOptionalFingerprint(ref.fingerprint);
    return {
      kind: "symbol",
      symbolId,
      ...(ref.fingerprint === undefined ? {} : { fingerprint: ref.fingerprint }),
    };
  }
  if (ref.kind === "file") {
    const path = validateRequestedPath(ref.path);
    validateOptionalFingerprint(ref.fingerprint);
    return {
      kind: "file",
      path,
      ...(ref.fingerprint === undefined ? {} : { fingerprint: ref.fingerprint }),
    };
  }
  throw invalid("ref must identify a symbol or indexed file.");
}

function projectNode(node: GraphNode): CodeSymbol {
  const path = validateStoredPath(node.filePath);
  const startLine = validateStoredLine(node.startLine);
  const endLine = validateStoredLine(node.endLine);
  if (endLine < startLine) throw corruptIndex("A graph symbol has an invalid source range.");
  const symbol: CodeSymbol = {
    ref: { kind: "symbol", symbolId: validateStoredSymbolId(node.id) },
    symbolKind: validateStoredText(node.kind, 64, "symbol kind"),
    name: validateStoredText(node.name, 1024, "symbol name"),
    qualifiedName: validateStoredText(node.qualifiedName, 2048, "qualified symbol name"),
    language: validateStoredText(node.language, 64, "language"),
    path,
    startLine,
    endLine,
  };
  if (node.signature !== undefined) {
    if (typeof node.signature !== "string" || node.signature.includes("\0")) {
      throw corruptIndex("The graph contains an invalid symbol signature.");
    }
    symbol.signature = node.signature.slice(0, MAX_SIGNATURE_CHARS);
  }
  return symbol;
}

function readIndexedSource(context: FreshContext, path: string): string {
  try {
    return context.session.readIndexedSource(path);
  } catch {
    let validation;
    try {
      validation = context.session.validate();
    } catch {
      throw interruptedRead("The indexed source could not be revalidated after a read failure.");
    }
    if (!validation.valid) {
      throw interruptedRead("The indexed source changed while it was being read.");
    }
    throw corruptIndex("The indexed source could not be read safely.");
  }
}

function readFileRecord(
  db: SqliteDatabase,
  path: string,
): { path: string; contentHash: string } | null {
  const row = db.prepare(
    "SELECT path, content_hash FROM files WHERE path = ? LIMIT 1",
  ).get(path) as { path: string; content_hash: string } | undefined;
  if (!row) return null;
  return {
    path: validateStoredPath(row.path),
    contentHash: validateStoredHash(row.content_hash),
  };
}

function readSnapshotRevision(db: SqliteDatabase): string {
  let row: { value: string } | undefined;
  try {
    row = db.prepare(
      "SELECT value FROM project_metadata WHERE key = ? LIMIT 1",
    ).get(GRAPH_SNAPSHOT_METADATA_KEY) as { value: string } | undefined;
  } catch {
    throw corruptIndex("The graph snapshot identity could not be read safely.");
  }
  if (!row || typeof row.value !== "string") {
    throw corruptIndex("The graph snapshot identity is missing.");
  }
  return sha256(row.value);
}

function encodeCursor(
  operation: CursorOperation,
  snapshotHash: string,
  requestHash: string,
  offset: number,
): string {
  const cursor: GraphCursor = {
    v: CURSOR_VERSION,
    operation,
    snapshotHash,
    requestHash,
    offset,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursorOffset(
  encoded: string | undefined,
  operation: CursorOperation,
  snapshotHash: string,
  requestHash: string,
): number {
  if (encoded === undefined) return 0;
  if (
    encoded.length === 0
    || Buffer.byteLength(encoded, "utf8") > MAX_CURSOR_BYTES
    || !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw invalidCursor("The graph cursor is malformed.");
  }
  let value: unknown;
  let rawText: string;
  try {
    const raw = Buffer.from(encoded, "base64url");
    if (raw.toString("base64url") !== encoded) throw new Error("non-canonical cursor");
    rawText = raw.toString("utf8");
    value = JSON.parse(rawText);
  } catch {
    throw invalidCursor("The graph cursor is malformed.");
  }
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== "offset,operation,requestHash,snapshotHash,v") {
    throw invalidCursor("The graph cursor is malformed.");
  }
  if (
    value.v !== CURSOR_VERSION
    || value.operation !== operation
    || typeof value.snapshotHash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.snapshotHash)
    || typeof value.requestHash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.requestHash)
    || !Number.isSafeInteger(value.offset)
    || (value.offset as number) < 0
  ) {
    throw invalidCursor("The graph cursor is malformed.");
  }
  const canonical = JSON.stringify({
    v: value.v,
    operation: value.operation,
    snapshotHash: value.snapshotHash,
    requestHash: value.requestHash,
    offset: value.offset,
  });
  if (rawText! !== canonical) {
    throw invalidCursor("The graph cursor is malformed.");
  }
  if (value.snapshotHash !== snapshotHash) {
    throw portError(
      "REVISION_CONFLICT",
      409,
      "Graph cursor is stale",
      "The graph changed after this cursor was issued. Restart from the first page.",
    );
  }
  if (value.requestHash !== requestHash) {
    throw invalidCursor("The graph cursor does not match this request.");
  }
  return value.offset as number;
}

function hashRequest(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateQuery(value: unknown): string {
  if (typeof value !== "string") throw invalid("query must be a string.");
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length === 0
    || normalized.length > MAX_QUERY_CHARS
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw invalid(`query must contain 1 to ${MAX_QUERY_CHARS} safe characters.`);
  }
  return normalized;
}

function validatePageLimit(value: unknown): number {
  return value === undefined
    ? GRAPH_READ_LIMITS.defaultPageSize
    : validateBound(value, 1, GRAPH_READ_LIMITS.maxPageSize, "limit");
}

function validateBound(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw invalid(`${field} must be an integer between ${min} and ${max}.`);
  }
  return value as number;
}

function validateSet<const T extends readonly string[]>(
  value: readonly string[] | undefined,
  allowed: T,
  field: string,
): T[number][] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > allowed.length) {
    throw invalid(`${field} contains too many values.`);
  }
  const allowedSet = new Set<string>(allowed);
  const result = [...new Set(value)];
  if (result.some((entry) => typeof entry !== "string" || !allowedSet.has(entry))) {
    throw invalid(`${field} contains an unsupported value.`);
  }
  return result.sort(compareCodePoints) as T[number][];
}

function validateSymbolId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_SYMBOL_ID_CHARS
    || !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw invalid("symbolId is invalid.");
  }
  return value;
}

function validateWorkspaceView(
  value: unknown,
): "overview" | "callers" | "callees" | "impact" {
  if (value === undefined) return "overview";
  if (value === "overview" || value === "callers" || value === "callees" || value === "impact") {
    return value;
  }
  throw invalid("workspaceView is invalid.");
}

function validateStoredSymbolId(value: unknown): string {
  try {
    return validateSymbolId(value);
  } catch {
    throw corruptIndex("The graph contains an invalid symbol identifier.");
  }
}

function validateRequestedPath(value: unknown): string {
  if (typeof value !== "string" || !isRepoRelativePath(value) || value.length > 4 * 1024) {
    throw portError(
      "PATH_OUTSIDE_PROJECT",
      400,
      "Unsafe repository path",
      "The requested path must be a safe repository-relative path.",
    );
  }
  return value;
}

function validateStoredPath(value: unknown): string {
  if (typeof value !== "string" || !isRepoRelativePath(value) || value.length > 4 * 1024) {
    throw corruptIndex("The graph contains an unsafe source path.");
  }
  return value;
}

function validateOptionalFingerprint(value: unknown): void {
  if (value !== undefined && (typeof value !== "string" || value.length === 0 || value.length > 32 * 1024)) {
    throw invalid("fingerprint is invalid.");
  }
}

function validateStoredHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw corruptIndex("The graph contains an invalid content hash.");
  }
  return value;
}

function validateStoredText(value: unknown, max: number, field: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > max
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw corruptIndex(`The graph contains an invalid ${field}.`);
  }
  return value;
}

function validateStoredLine(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw corruptIndex("The graph contains an invalid source line.");
  }
  return value as number;
}

function validateStoredNonNegative(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw corruptIndex(`The graph contains an invalid ${field}.`);
  }
  return value as number;
}

function validateStoredRank(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw corruptIndex("The graph contains an invalid search rank.");
  }
  return value;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return { value: result, truncated: true };
}

function sliceSourcePage(
  rangeText: string,
  byteOffset: number,
  maxLines: number,
  maxBytes: number,
): { content: string; bytesConsumed: number } {
  const bytes = Buffer.from(rangeText, "utf8");
  const remaining = bytes.subarray(byteOffset).toString("utf8");
  let content = "";
  let consumed = 0;
  let lines = 1;
  for (const character of remaining) {
    const size = Buffer.byteLength(character, "utf8");
    if (consumed + size > maxBytes) break;
    content += character;
    consumed += size;
    if (character === "\n") {
      if (lines >= maxLines) break;
      lines += 1;
    }
  }
  if (consumed === 0 && remaining.length > 0) {
    throw invalid("maxBytes is too small to read the next UTF-8 character.");
  }
  return { content, bytesConsumed: consumed };
}

function isUtf8Boundary(bytes: Buffer, offset: number): boolean {
  return offset === 0
    || offset === bytes.length
    || (bytes[offset]! & 0b1100_0000) !== 0b1000_0000;
}

function countNewlines(value: string): number {
  let count = 0;
  for (const character of value) if (character === "\n") count += 1;
  return count;
}

function contentLineSpan(value: string): number {
  const newlines = countNewlines(value);
  return Math.max(0, newlines - (value.endsWith("\n") ? 1 : 0));
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function errorForStatus(status: GraphStatus): MexPortError {
  switch (status.status) {
    case "missing":
      return portError(
        "INDEX_MISSING",
        503,
        "Graph index missing",
        "The graph index does not exist. Rebuild it before reading graph data.",
      );
    case "stale":
      return portError(
        "INDEX_STALE",
        409,
        "Graph index stale",
        "The graph index is stale. Refresh it before reading graph data.",
      );
    case "rebuild_required":
      return portError(
        "MIGRATION_REQUIRED",
        409,
        "Graph rebuild required",
        "The graph index is incompatible and must be rebuilt.",
      );
    case "corrupt":
      return corruptIndex("The graph index is corrupt and must be rebuilt.");
    case "degraded":
      return portError(
        "OPERATION_INTERRUPTED",
        503,
        "Graph temporarily unavailable",
        "The graph could not be observed safely. Retry after current repository activity settles.",
      );
    case "fresh":
      return interruptedRead("The fresh graph reader could not be opened safely.");
  }
}

function translateMaintenanceError(error: unknown): MexPortError {
  if (error instanceof MexPortError) return error;
  if (!(error instanceof GraphMaintenanceError)) {
    return portError(
      "JOB_FAILED",
      500,
      "Graph maintenance failed",
      "Graph maintenance failed without changing the published graph.",
    );
  }
  switch (error.code) {
    case "GRAPH_INDEX_MISSING":
      return portError(
        "INDEX_MISSING",
        409,
        "Graph index missing",
        "The graph index must be rebuilt before it can be refreshed.",
      );
    case "GRAPH_INDEX_NOT_REFRESHABLE":
      return portError(
        "INDEX_STALE",
        409,
        "Graph refresh unavailable",
        "The current graph state cannot be refreshed safely. Rebuild it instead.",
      );
    case "GRAPH_INDEX_NOT_REPAIRABLE":
      return portError(
        "MIGRATION_REQUIRED",
        409,
        "Graph repair unavailable",
        "The graph cannot be upgraded losslessly. Rebuild it from canonical source instead.",
      );
    case "GRAPH_MAINTENANCE_LOCKED":
    case "GRAPH_MAINTENANCE_GATE_STALE":
      return portError(
        "JOB_ALREADY_RUNNING",
        409,
        "Graph maintenance already running",
        "Another graph maintenance operation currently owns the repository lock.",
      );
    case "GRAPH_MAINTENANCE_CANCELLED":
      return portError(
        "OPERATION_INTERRUPTED",
        409,
        "Graph maintenance interrupted",
        "Graph maintenance was cancelled before publication.",
      );
    case "GRAPH_MAINTENANCE_PATH_UNSAFE":
      return portError(
        "PATH_OUTSIDE_PROJECT",
        400,
        "Unsafe graph path",
        "Graph maintenance could not prove that every path remained inside the repository.",
      );
    case "GRAPH_MAINTENANCE_RACE":
      return portError(
        "REVISION_CONFLICT",
        409,
        "Graph changed during maintenance",
        "The published graph or source corpus changed during maintenance. Retry from current state.",
      );
    case "GRAPH_CANDIDATE_INVALID":
    case "GRAPH_PUBLICATION_FAILED":
      return portError(
        "JOB_FAILED",
        500,
        "Graph maintenance failed",
        "The isolated graph candidate could not be published safely.",
      );
  }
}

function invalid(detail: string): MexPortError {
  return portError("VALIDATION_FAILED", 422, "Invalid graph request", detail);
}

function invalidCursor(detail: string): MexPortError {
  return portError("VALIDATION_FAILED", 422, "Invalid graph cursor", detail);
}

function notFound(detail: string): MexPortError {
  return portError("NOT_FOUND", 404, "Graph resource not found", detail);
}

function corruptIndex(detail: string): MexPortError {
  return portError("INDEX_CORRUPT", 503, "Graph index corrupt", detail);
}

function interruptedRead(detail: string): MexPortError {
  return portError("OPERATION_INTERRUPTED", 409, "Graph read interrupted", detail);
}

function portError(
  code: ProblemDetails["code"],
  status: number,
  title: string,
  detail: string,
): MexPortError {
  return new MexPortError({ code, status, title, detail });
}
