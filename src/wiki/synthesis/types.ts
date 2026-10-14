/**
 * Synthesis — the in-memory artefacts of §12's pipeline.
 *
 * Nothing here is persisted and nothing here is knowledge. A cluster is a
 * deterministic reading of the repository's own folder layout; a cluster
 * context is that reading plus the source it points at. Both are inputs to a
 * prompt the *agent* runs, and both are thrown away when the run ends.
 *
 * The reader interfaces are declared here rather than imported from the graph
 * door on purpose, the same way the reference implementation declared its own:
 * a narrow interface is what keeps clustering and context extraction testable
 * against object literals, and it is why this pipeline survived being rebound
 * onto a different code graph without a rewrite. `SynthesisGraph` in
 * `grounding/adapter.ts` satisfies both.
 */

/** A coherent area of the codebase, suitable for proposing knowledge about. */
export interface Cluster {
  /** Short module name — `auth`, `billing`, `payments`. */
  name: string;
  /** Code-graph node ids belonging to this cluster, sorted. */
  nodeIds: string[];
  /** Repository-relative source files in this cluster, sorted. */
  files: string[];
  /** A one-line structural description. Deterministic, never prose. */
  description?: string;
}

/** The reads clustering makes. Two methods, so a stub is two lines. */
export interface ClusterGraphReader {
  listFiles(): Array<{ path: string }>;
  nodesInFile(filePath: string): Array<{ id: string; kind: string }>;
}

export interface FindClustersOptions {
  /** Minimum source files for a cluster to be kept. Default 1. */
  minFiles?: number;
  /**
   * Carry only symbol kinds worth grounding to. Default true.
   *
   * A folder of nothing but `file` and `import` nodes is not something anyone
   * can write a grounded claim about, so it is dropped rather than proposed.
   */
  symbolNodesOnly?: boolean;
}

/** How important a node or code block is within its cluster. */
export type NodeImportance = "primary" | "supporting";

/**
 * How a code block's source was selected.
 *
 * Recorded so the prompt can say how tightly the text maps to the symbol —
 * a padded span and a truncated file are different kinds of evidence.
 */
export type CodeBlockKind = "exact_node_body" | "node_with_context" | "file_section" | "full_file";

/** One declaration, resolved and ranked. */
export interface ClusterContextNode {
  id: string;
  kind: string;
  name: string;
  filePath: string;
  signature?: string;
  qualifiedName?: string;
  docstring?: string;
  callers?: string[];
  callees?: string[];
  importance: NodeImportance;
  /** Deterministic explanation of the importance, for the prompt and a reader. */
  reason?: string;
}

/** Source text for one symbol or file. */
export interface ClusterCodeBlock {
  /** Stable id: the node (or file) plus the line range. */
  id: string;
  nodeId?: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  kind: CodeBlockKind;
  content: string;
  importance: NodeImportance;
}

/** A light structural tally per file. No model involvement. */
export interface ClusterFileSummary {
  filePath: string;
  exports?: string[];
  notes?: string;
}

/**
 * Everything an agent is given about one cluster.
 *
 * Nodes and blocks are ordered `primary` first, then by file and line, so a
 * consumer may rely on primary evidence appearing before supporting evidence —
 * which is what makes dropping from the tail a safe way to fit a budget.
 */
export interface ClusterContext {
  cluster: Cluster;
  nodes: ClusterContextNode[];
  codeBlocks: ClusterCodeBlock[];
  fileSummaries?: ClusterFileSummary[];
  /**
   * True when a bound dropped evidence.
   *
   * Data, never a diagnostic: a bounded context is the normal outcome on a
   * large cluster, and a caller that cannot tell a complete context from a
   * trimmed one will read an absence as a fact about the code.
   */
  truncated?: boolean;
  /** What the bound dropped, counted, so the prompt can say so in words. */
  dropped?: { nodes: number; primaryBlocks: number; supportingBlocks: number };
}

/** Structural detail for one node, as context extraction needs it. */
export interface ContextGraphNode {
  id: string;
  kind: string;
  name: string;
  filePath: string;
  qualifiedName?: string;
  signature?: string;
  docstring?: string;
  startLine: number;
  endLine: number;
  isExported?: boolean;
  visibility?: "public" | "private" | "protected" | "internal";
}

/** The reads context extraction makes. */
export interface ContextGraphReader {
  /** Use immutable, hash-matched source when the reader owns a repository snapshot. */
  readFileLines?(filePath: string): string[] | null;
  describeNode(id: string): ContextGraphNode | null;
  callersOf(nodeId: string): string[];
  calleesOf(nodeId: string): string[];
}

export interface ExtractClusterContextOptions {
  /** Attach callers/callees only for callable kinds. Default true. */
  callGraphForCallablesOnly?: boolean;
  /** Add a file-level block for cluster files that produced no symbol block. Default true. */
  includeFileFallbacks?: boolean;
  /** Lines of surrounding context on each side of a *primary* span. Default 3. */
  primaryContextLines?: number;
  /** Upper bound on lines in any file-level block. Default 400. */
  maxFileLines?: number;
  /** Tighter cap for *supporting* file-level blocks. Default 120. */
  supportingMaxLines?: number;
  /** Attach per-file summaries. Default true. */
  includeFileSummaries?: boolean;
  /**
   * Token ceiling for the whole context.
   *
   * D10 requires that the wiki compose with the graph's budget rather than
   * inventing a second one, and a cluster context handed to an agent is the
   * largest payload this engine produces.
   *
   * Supporting evidence is dropped first, then primary evidence from the tail.
   * **Primary evidence is bounded too, and that is a correction rather than a
   * concession.** The first version never dropped a primary block, reasoning
   * that a context missing the code its claim is about is worse than one that
   * is large. Measured against a real repository that produced a 4.5 MB prompt
   * for one cluster — unusable by any model, so the guarantee protected
   * nothing. What actually distinguishes the two is not whether evidence is
   * dropped but whether the agent is *told*: the count is carried in
   * `dropped` and stated in the rendered context, so an absence is never read
   * as a fact about the code.
   */
  maxTokens?: number;
  /**
   * Cap on structural nodes listed. Default 60.
   *
   * Separate from the token budget because the node list is what grounding is
   * checked against: an agent can only copy an id it can see, so this bounds
   * what may be grounded to rather than merely what is shown.
   *
   * A count rather than a share of the budget, deliberately — a symbol whose
   * evidence was trimmed is still worth grounding to, so the two bounds answer
   * different questions and one number could not serve both. The consequence,
   * stated rather than hidden: on a very large cluster this is the dominant
   * cost of the rendered prompt, and the real answer there is a finer cluster
   * rather than a bigger context.
   */
  maxNodes?: number;
}
