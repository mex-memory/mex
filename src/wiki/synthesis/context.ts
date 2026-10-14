/**
 * §12.3 step 1, second half — the evidence a cluster is judged on.
 *
 * Structural facts from the code graph plus the actual source from disk, split
 * into `primary` and `supporting`. Both halves are needed and neither is
 * sufficient: the graph alone gives shape without meaning, and source alone
 * gives text without structure.
 *
 * The ranking is the part that earns its place. Everything a prompt is given
 * costs tokens and dilutes attention, so an unranked dump of a forty-file
 * cluster produces worse knowledge than a ranked half of it. `primary` is what
 * the prose should be built around; `supporting` is what clarifies it.
 *
 * Deterministic and side-effect free apart from reads.
 */

import { estimateTokens } from "../query/budget.js";
import { readFileLines, sliceLines } from "./source.js";
import type {
  Cluster,
  ClusterCodeBlock,
  ClusterContext,
  ClusterContextNode,
  ClusterFileSummary,
  CodeBlockKind,
  ContextGraphNode,
  ContextGraphReader,
  ExtractClusterContextOptions,
  NodeImportance,
} from "./types.js";

/** Kinds that participate in the call graph. */
const CALLABLE_KINDS = new Set(["function", "method"]);

/** Structural kinds that carry a cluster's meaning. These default to primary. */
const CENTRAL_KINDS = new Set([
  "function",
  "method",
  "class",
  "struct",
  "interface",
  "trait",
  "protocol",
  "enum",
  "type_alias",
  "namespace",
  "module",
  "component",
  "route",
]);

/** Leaf declarations — supporting unless exported or call-graph connected. */
const LEAF_KINDS = new Set(["variable", "constant", "property", "field"]);

function importanceRank(importance: NodeImportance): number {
  return importance === "primary" ? 0 : 1;
}

function compareNodes(left: ClusterContextNode, right: ClusterContextNode): number {
  return (
    importanceRank(left.importance) - importanceRank(right.importance) ||
    left.filePath.localeCompare(right.filePath) ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}

function compareCodeBlocks(left: ClusterCodeBlock, right: ClusterCodeBlock): number {
  return (
    importanceRank(left.importance) - importanceRank(right.importance) ||
    left.filePath.localeCompare(right.filePath) ||
    (left.startLine ?? 0) - (right.startLine ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Rank one node, and record why in words.
 *
 * The reason is not decoration: it goes into the prompt, so an agent can see
 * that a symbol is primary because it is exported and called from four places
 * rather than because it happened to sort first.
 */
function rankNode(
  node: ContextGraphNode,
  callers: readonly string[] | undefined,
  callees: readonly string[] | undefined,
): { importance: NodeImportance; reason: string } {
  const exported = node.isExported === true;
  const central = CENTRAL_KINDS.has(node.kind);
  const leaf = LEAF_KINDS.has(node.kind);
  const edgeCount = (callers?.length ?? 0) + (callees?.length ?? 0);

  const signals: string[] = [];
  if (central) signals.push(`central ${node.kind}`);
  if (exported) signals.push("exported symbol");
  if (edgeCount > 0) signals.push(`${edgeCount} call-graph edge(s)`);
  if (node.docstring !== undefined && node.docstring !== "") signals.push("documented");

  const primary = leaf ? exported || edgeCount > 0 : central || exported || edgeCount > 0;

  return {
    importance: primary ? "primary" : "supporting",
    reason: signals.length > 0 ? signals.join("; ") : `${node.kind} with no strong centrality signals`,
  };
}

/** Stable id for a block, grounded to its node (or file) and line range. */
function codeBlockId(
  filePath: string,
  startLine: number | undefined,
  endLine: number | undefined,
  nodeId: string | undefined,
): string {
  const location = startLine !== undefined && endLine !== undefined ? `${startLine}-${endLine}` : "full";
  return `${nodeId ?? filePath}@${location}`;
}

type ResolvedOptions = Required<Omit<ExtractClusterContextOptions, "maxTokens">> & { maxTokens?: number };

const DEFAULT_MAX_NODES = 60;

function resolveOptions(options: ExtractClusterContextOptions): ResolvedOptions {
  return {
    callGraphForCallablesOnly: options.callGraphForCallablesOnly ?? true,
    includeFileFallbacks: options.includeFileFallbacks ?? true,
    primaryContextLines: options.primaryContextLines ?? 3,
    maxFileLines: options.maxFileLines ?? 400,
    supportingMaxLines: options.supportingMaxLines ?? 120,
    includeFileSummaries: options.includeFileSummaries ?? true,
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  };
}

/**
 * A file-level block: the whole file when small, a bounded leading slice
 * otherwise, so a large file is never dumped wholesale.
 */
function fileBlock(
  filePath: string,
  lines: readonly string[],
  importance: NodeImportance,
  options: ResolvedOptions,
  nodeId?: string,
): ClusterCodeBlock | null {
  if (lines.length === 0 || lines.join("\n").trim() === "") return null;

  const cap =
    importance === "primary" ? options.maxFileLines : Math.min(options.maxFileLines, options.supportingMaxLines);

  if (lines.length <= cap) {
    return {
      id: codeBlockId(filePath, undefined, undefined, nodeId),
      ...(nodeId === undefined ? {} : { nodeId }),
      filePath,
      kind: "full_file",
      content: lines.join("\n"),
      importance,
    };
  }

  return {
    id: codeBlockId(filePath, 1, cap, nodeId),
    ...(nodeId === undefined ? {} : { nodeId }),
    filePath,
    startLine: 1,
    endLine: cap,
    kind: "file_section",
    content: lines.slice(0, cap).join("\n"),
    importance,
  };
}

/** A node's own span, padded when primary; the file when the span is unusable. */
function codeBlockForNode(
  node: ContextGraphNode,
  importance: NodeImportance,
  lines: readonly string[],
  options: ResolvedOptions,
): ClusterCodeBlock | null {
  const pad = importance === "primary" ? options.primaryContextLines : 0;
  const slice = sliceLines(lines, node.startLine, node.endLine, pad);

  if (slice !== null) {
    const padded = slice.startLine < node.startLine || slice.endLine > node.endLine;
    const kind: CodeBlockKind = padded ? "node_with_context" : "exact_node_body";
    return {
      id: codeBlockId(node.filePath, slice.startLine, slice.endLine, node.id),
      nodeId: node.id,
      filePath: node.filePath,
      startLine: slice.startLine,
      endLine: slice.endLine,
      kind,
      content: slice.content,
      importance,
    };
  }

  return fileBlock(node.filePath, lines, importance, options, node.id);
}

function resolveContextNode(
  graph: ContextGraphReader,
  node: ContextGraphNode,
  options: ResolvedOptions,
): ClusterContextNode {
  let callers: string[] | undefined;
  let callees: string[] | undefined;

  if (!options.callGraphForCallablesOnly || CALLABLE_KINDS.has(node.kind)) {
    const incoming = graph.callersOf(node.id);
    const outgoing = graph.calleesOf(node.id);
    if (incoming.length > 0) callers = [...new Set(incoming)].sort();
    if (outgoing.length > 0) callees = [...new Set(outgoing)].sort();
  }

  const { importance, reason } = rankNode(node, callers, callees);

  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    filePath: node.filePath,
    importance,
    reason,
    ...(node.signature === undefined ? {} : { signature: node.signature }),
    ...(node.qualifiedName === undefined ? {} : { qualifiedName: node.qualifiedName }),
    ...(node.docstring === undefined ? {} : { docstring: node.docstring }),
    ...(callers === undefined ? {} : { callers }),
    ...(callees === undefined ? {} : { callees }),
  };
}

interface FileSummaryAccumulator {
  symbols: number;
  exports: Set<string>;
}

function buildFileSummaries(
  cluster: Cluster,
  perFile: Map<string, FileSummaryAccumulator>,
): ClusterFileSummary[] {
  return [...cluster.files].sort().map((filePath) => {
    const accumulator = perFile.get(filePath);
    const summary: ClusterFileSummary = { filePath };
    if (accumulator !== undefined && accumulator.exports.size > 0) {
      summary.exports = [...accumulator.exports].sort();
    }
    if (accumulator !== undefined && accumulator.symbols > 0) {
      const exported = accumulator.exports.size > 0 ? ` (${accumulator.exports.size} exported)` : "";
      summary.notes = `${accumulator.symbols} resolved symbol${accumulator.symbols === 1 ? "" : "s"}${exported}`;
    } else {
      summary.notes = "no resolved symbols; included as file-level context";
    }
    return summary;
  });
}

/**
 * Fit the evidence inside the bounds, and count what was dropped.
 *
 * Supporting evidence goes first, then primary evidence from the tail — the
 * sort already put the least useful evidence there, which is what makes this a
 * correctness property of the sort rather than a presentation choice.
 *
 * **Primary evidence is bounded too.** The first version of this exempted it,
 * on the reasoning that a context missing the code its claim is about is worse
 * than one that is merely large. A measured run against a real repository
 * produced a 4.5 MB prompt for one 133-file cluster, which no model can read,
 * so the exemption protected nothing and cost everything. What matters is not
 * whether evidence is dropped but whether the agent is told it was: the counts
 * come back here and the renderer states them.
 */
function fitEvidence(
  nodes: readonly ClusterContextNode[],
  blocks: readonly ClusterCodeBlock[],
  options: ResolvedOptions,
): {
  nodes: ClusterContextNode[];
  blocks: ClusterCodeBlock[];
  truncated: boolean;
  dropped: { nodes: number; primaryBlocks: number; supportingBlocks: number };
} {
  const keptNodes = nodes.slice(0, options.maxNodes);
  const droppedNodes = nodes.length - keptNodes.length;

  // Only evidence for a node the agent can actually see: an id it cannot read
  // is an id it cannot ground to, and a block for one is pure cost.
  const visible = new Set(keptNodes.map((node) => node.id));
  const eligible = blocks.filter((block) => block.nodeId === undefined || visible.has(block.nodeId));

  if (options.maxTokens === undefined) {
    return {
      nodes: keptNodes,
      blocks: eligible,
      truncated: droppedNodes > 0 || eligible.length < blocks.length,
      dropped: {
        nodes: droppedNodes,
        primaryBlocks: blocks.filter((block) => block.importance === "primary").length - eligible.filter((block) => block.importance === "primary").length,
        supportingBlocks:
          blocks.filter((block) => block.importance === "supporting").length -
          eligible.filter((block) => block.importance === "supporting").length,
      },
    };
  }

  const kept: ClusterCodeBlock[] = [];
  let used = 0;
  let droppedPrimary = blocks.filter((block) => block.importance === "primary").length;
  let droppedSupporting = blocks.filter((block) => block.importance === "supporting").length;

  for (const block of eligible) {
    const cost = estimateTokens(block);
    if (used + cost > options.maxTokens) continue;
    kept.push(block);
    used += cost;
    if (block.importance === "primary") droppedPrimary -= 1;
    else droppedSupporting -= 1;
  }

  return {
    nodes: keptNodes,
    blocks: kept,
    truncated: droppedNodes > 0 || droppedPrimary > 0 || droppedSupporting > 0,
    dropped: { nodes: droppedNodes, primaryBlocks: droppedPrimary, supportingBlocks: droppedSupporting },
  };
}

/** Extract the evidence for one cluster. */
export function extractClusterContext(
  graph: ContextGraphReader,
  cluster: Cluster,
  repoRoot: string,
  options: ExtractClusterContextOptions = {},
): ClusterContext {
  const resolved = resolveOptions(options);
  const nodes: ClusterContextNode[] = [];
  const codeBlocks: ClusterCodeBlock[] = [];
  const seenNodeIds = new Set<string>();
  const filesWithBlocks = new Set<string>();
  const perFile = new Map<string, FileSummaryAccumulator>();

  // One read per file, reused across every span it contributes.
  const lineCache = new Map<string, string[] | null>();
  const linesOf = (filePath: string): string[] | null => {
    if (!lineCache.has(filePath)) lineCache.set(filePath,
      graph.readFileLines ? graph.readFileLines(filePath) : readFileLines(repoRoot, filePath));
    return lineCache.get(filePath) ?? null;
  };

  for (const nodeId of cluster.nodeIds) {
    const graphNode = graph.describeNode(nodeId);
    if (graphNode === null) continue;

    const contextNode = resolveContextNode(graph, graphNode, resolved);
    nodes.push(contextNode);

    const accumulator = perFile.get(graphNode.filePath) ?? { symbols: 0, exports: new Set<string>() };
    accumulator.symbols += 1;
    if (graphNode.isExported === true) accumulator.exports.add(graphNode.name);
    perFile.set(graphNode.filePath, accumulator);

    if (seenNodeIds.has(nodeId)) continue;
    seenNodeIds.add(nodeId);

    const lines = linesOf(graphNode.filePath);
    if (lines === null) continue;

    const block = codeBlockForNode(graphNode, contextNode.importance, lines, resolved);
    if (block === null) continue;
    codeBlocks.push(block);
    filesWithBlocks.add(block.filePath);
  }

  if (resolved.includeFileFallbacks) {
    for (const filePath of cluster.files) {
      if (filesWithBlocks.has(filePath)) continue;
      const lines = linesOf(filePath);
      if (lines === null) continue;
      const block = fileBlock(filePath, lines, "supporting", resolved);
      if (block === null) continue;
      codeBlocks.push(block);
      filesWithBlocks.add(filePath);
    }
  }

  nodes.sort(compareNodes);
  codeBlocks.sort(compareCodeBlocks);

  const fitted = fitEvidence(nodes, codeBlocks, resolved);

  return {
    cluster,
    nodes: fitted.nodes,
    codeBlocks: fitted.blocks,
    truncated: fitted.truncated,
    dropped: fitted.dropped,
    ...(resolved.includeFileSummaries ? { fileSummaries: buildFileSummaries(cluster, perFile) } : {}),
  };
}

/** Extract context for every cluster, in order. */
export function extractAllClusterContexts(
  graph: ContextGraphReader,
  clusters: readonly Cluster[],
  repoRoot: string,
  options: ExtractClusterContextOptions = {},
): ClusterContext[] {
  return clusters.map((cluster) => extractClusterContext(graph, cluster, repoRoot, options));
}
