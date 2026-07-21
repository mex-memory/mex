import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GraphEngine } from "./engine.js";
import type { GraphNode, NodeKind } from "./types.js";

export type DetailLevel = "minimal" | "standard" | "source";

/**
 * Ephemeral, agent-facing fact for one graph node — structure and relationship
 * counts, never the source body. Source is a separate, opt-in {@link SourceRange}
 * record. Never persisted.
 */
export interface CompactFact {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  signature?: string;
  callerCount: number;
  calleeCount: number;
  detail: DetailLevel;
  sourceIncluded: boolean;
  /** Short content hash (node body sha256) for cache-aware source expansion. */
  bodyHash?: string;
  /** Full serialized minhash fingerprint. Opt-in (--fingerprint); used by grounding. */
  fingerprint?: string;
}

/** One node's source body, read on demand and line-capped. */
export interface SourceRange {
  startLine: number;
  endLine: number;
  nodeIds: string[];
  content: string;
  truncated: boolean;
}

/** FTS top-ten seeds expanded by one hop in both call directions. Deduped. */
export function scopeSelect(graph: GraphEngine, task: string): string[] {
  const ids = new Set<string>();
  for (const seed of graph.searchNodes(task, { limit: 10 })) {
    ids.add(seed.id);
    for (const caller of graph.getCallers(seed.id)) ids.add(caller.id);
    for (const callee of graph.getCallees(seed.id)) ids.add(callee.id);
  }
  return [...ids];
}

/**
 * Build a compact fact (structure + relationship counts) for a node id, or null
 * if the node no longer exists. `sourceIncluded` reflects whether the caller
 * intends to emit a companion source record (detail === "source").
 */
export function compactFact(graph: GraphEngine, id: string, detail: DetailLevel): CompactFact | null {
  const node = graph.getNode(id);
  if (!node) return null;
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    lineStart: node.startLine,
    lineEnd: node.endLine,
    signature: node.signature,
    callerCount: graph.getCallers(id).length,
    calleeCount: graph.getCallees(id).length,
    detail,
    sourceIncluded: detail === "source",
    bodyHash: node.bodyHash,
  };
}

/**
 * Read a node's source body from disk, capped at `maxLines` (0 = unlimited).
 * Returns null when the file cannot be read.
 */
export function readNodeSource(node: GraphNode, rootDir: string, maxLines: number): SourceRange | null {
  let lines: string[];
  try {
    lines = readFileSync(resolve(rootDir, node.filePath), "utf-8").split("\n");
  } catch {
    return null;
  }
  const body = lines.slice(node.startLine - 1, node.endLine);
  const truncated = maxLines > 0 && body.length > maxLines;
  const kept = truncated ? body.slice(0, maxLines) : body;
  return {
    startLine: node.startLine,
    endLine: truncated ? node.startLine + kept.length - 1 : node.endLine,
    nodeIds: [node.id],
    content: kept.join("\n"),
    truncated,
  };
}

/** Group nodes by file path, preserving first-seen order of both files and nodes. */
export function groupByFile(nodes: GraphNode[]): Map<string, GraphNode[]> {
  const groups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const bucket = groups.get(node.filePath);
    if (bucket) bucket.push(node);
    else groups.set(node.filePath, [node]);
  }
  return groups;
}
