import type {
  CodeRef,
  Diagnostic,
  IndexJobResult,
  Page,
  PageRequest,
  RepoRelativePath,
  RepoState,
} from "./shared.js";

/** Hard application-boundary limits. Adapters may use smaller limits. */
export const GRAPH_READ_LIMITS = {
  defaultPageSize: 50,
  maxPageSize: 100,
  maxSourceLines: 400,
  maxSourceBytes: 256 * 1024,
  maxImpactDepth: 8,
  maxImpactNodes: 500,
  maxResolutionCandidates: 20,
} as const;

export type GraphStatusKind =
  | "missing"
  | "fresh"
  | "stale"
  | "degraded"
  | "rebuild_required"
  | "corrupt";

export interface GraphParseHealth {
  total: number;
  ok: number;
  partial: number;
  failed: number;
  failedPaths: readonly RepoRelativePath[];
  failedPathsTruncated: boolean;
}

export interface GraphSourceChanges {
  total: number;
  added: readonly RepoRelativePath[];
  modified: readonly RepoRelativePath[];
  deleted: readonly RepoRelativePath[];
  truncated: boolean;
  branchChanged: boolean;
  manifestChanged: boolean;
  configChanged: boolean;
  grammarChanged: boolean;
}

export interface GraphStatus {
  status: GraphStatusKind;
  /**
   * False when the store could not be opened for immutable inspection, so
   * `lastSuccessfulIndexAt`, `parseHealth` and `changes` are placeholders
   * rather than measurements. Optional and additive.
   */
  inspected?: boolean;
  observedAt: string;
  currentRepo: RepoState;
  lastSuccessfulIndexAt: string | null;
  indexedAt: string | null;
  indexedBranch: string | null;
  indexedHead: string | null;
  schemaVersion: number | null;
  extractorVersion: string | null;
  grammarVersion: string | null;
  parseHealth: GraphParseHealth;
  changes: GraphSourceChanges;
  diagnostics: readonly Diagnostic[];
}

export interface GraphMaintenanceProgress {
  phase: "discover" | "stage" | "parse" | "resolve" | "validate" | "publish";
  completed?: number;
  total?: number;
  message: string;
}

export interface GraphMaintenanceOptions {
  signal?: AbortSignal;
  onProgress?: (progress: GraphMaintenanceProgress) => void;
}

/**
 * One repository file the bounded corpus policy declined to index.
 *
 * Reported rather than fatal: the rest of the repository indexed normally,
 * and this is how a user learns why a symbol is absent from the graph.
 */
export interface GraphSkippedSource {
  filePath: RepoRelativePath;
  reason: "corpus-limit";
  limit: string;
  limitBytes: number;
  observedBytes?: number;
  message: string;
}

/** Port mutations return only successful results; failures throw typed errors. */
export interface GraphRefreshResult extends IndexJobResult {
  state: "succeeded";
  status: GraphStatus;
  filesIndexed: number;
  nodesCreated: number;
  edgesCreated: number;
  /** Optional and additive; absent when every discovered file was indexed. */
  skipped?: readonly GraphSkippedSource[];
  /** Compiler config inputs outside the project corpus that were declined. */
  declinedInputs?: readonly GraphDeclinedInput[];
}

/**
 * A compiler config input the containment policy declined to read.
 *
 * No source file is missing from the graph, but the affected project's type
 * resolution is less complete than it looks, so it is reported.
 */
export interface GraphDeclinedInput {
  filePath: string;
  reason: "outside-project-corpus";
  message: string;
}

export interface GraphPage<T> extends Page<T> {
  /** True when a configured safety bound omitted additional matching results. */
  truncated: boolean;
}

export type SymbolCodeRef = Extract<CodeRef, { kind: "symbol" }>;

/** Application projection over a code symbol, independent of graph DB rows. */
export interface CodeSymbol {
  ref: SymbolCodeRef;
  symbolKind: string;
  name: string;
  qualifiedName: string;
  language: string;
  path: RepoRelativePath;
  startLine: number;
  endLine: number;
  signature?: string;
}

export interface GraphRelation {
  kind: string;
  source: SymbolCodeRef;
  target: SymbolCodeRef;
  path?: RepoRelativePath;
  line?: number;
  column?: number;
  confidence?: number;
  provenance?: string;
}

export interface GraphSource {
  path: RepoRelativePath;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  symbolRefs: readonly SymbolCodeRef[];
}

export interface GraphSourceMatch extends GraphSource {
  rank: number;
  matchedTerms: readonly string[];
}

export interface GraphNodeSearchRequest extends PageRequest {
  query: string;
  symbolKinds?: readonly string[];
  languages?: readonly string[];
}

export interface GraphSourceSearchRequest extends PageRequest {
  query: string;
  maxLinesPerMatch: number;
  maxBytesPerMatch: number;
}

export interface GraphSourceReadRequest extends PageRequest {
  ref: CodeRef;
  maxLines: number;
  maxBytes: number;
}

export interface GraphRelationRequest extends PageRequest {
  symbolId: string;
}

export interface GraphImpactRequest {
  ref: CodeRef;
  depth: number;
  maxNodes: number;
}

export interface GraphCodeResolutionRequest {
  ref: CodeRef;
  maxCandidates: number;
}

export interface GraphImpactNode {
  symbol: CodeSymbol;
  depth: number;
  root: SymbolCodeRef;
}

export interface GraphImpactResult {
  target: CodeRef;
  roots: readonly CodeSymbol[];
  impacted: readonly GraphImpactNode[];
  relations: readonly GraphRelation[];
  truncated: boolean;
}

export type CodeResolution =
  | {
      status: "resolved";
      ref: CodeRef;
      health: "fresh" | "changed";
      resolvedRef: CodeRef;
      symbol?: CodeSymbol;
    }
  | {
      status: "ambiguous";
      ref: CodeRef;
      health: "ambiguous";
      candidates: readonly CodeSymbol[];
      truncated: boolean;
    }
  | {
      status: "missing";
      ref: CodeRef;
      health: "missing";
    }
  | {
      status: "unverified";
      ref: CodeRef;
      health: "unverified";
      detail: string;
    };

/** Application seam over the existing graph; it exposes no persisted row type. */
export interface GraphPort {
  /** Strictly read-only: it must never create, migrate, refresh, or rebuild. */
  inspectStatus(): Promise<GraphStatus>;
  refresh(options?: GraphMaintenanceOptions): Promise<GraphRefreshResult>;
  rebuild(options?: GraphMaintenanceOptions): Promise<GraphRefreshResult>;
  searchNodes(request: GraphNodeSearchRequest): Promise<GraphPage<CodeSymbol>>;
  searchSource(request: GraphSourceSearchRequest): Promise<GraphPage<GraphSourceMatch>>;
  getNode(id: string): Promise<CodeSymbol | null>;
  readSource(request: GraphSourceReadRequest): Promise<GraphPage<GraphSource>>;
  getCallers(request: GraphRelationRequest): Promise<GraphPage<GraphRelation>>;
  getCallees(request: GraphRelationRequest): Promise<GraphPage<GraphRelation>>;
  getImpact(request: GraphImpactRequest): Promise<GraphImpactResult>;
  resolveCodeRef(request: GraphCodeResolutionRequest): Promise<CodeResolution>;
}
