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
  /** Relevance score in [0,1]. Present on `scope` facts only. */
  score?: number;
  /** Why this node was selected (e.g. "exact-name-match"). Scope facts only. */
  selectionReasons?: string[];
}

/** Quota bucket for scope selection diversity. */
export type SelectionCategory = "direct" | "neighbor" | "test";

/** A ranked scope candidate with its reasons and quota bucket. */
export interface ScopedCandidate {
  id: string;
  score: number;
  reasons: string[];
  category: SelectionCategory;
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

const QUOTA: Record<SelectionCategory, number> = { direct: 5, neighbor: 4, test: 2 };
const HOP_CAP = 3;

interface Candidate {
  node: GraphNode;
  score: number;
  reasons: Set<string>;
  category: SelectionCategory;
}

function isTestNode(node: GraphNode): boolean {
  return /(^|\/)(__tests__|tests?)\//.test(node.filePath) || /\.(test|spec)\./.test(node.filePath);
}

/** Identifier-like tokens in a task string (drops trivial 1-char fragments). */
function taskTokens(task: string): string[] {
  return [...new Set(task.split(/[^A-Za-z0-9_$]+/).filter((t) => t.length >= 2))];
}

/**
 * Scored, quota-limited scope selection. Combines whole-task semantic search,
 * exact identifier matches (which are boosted so explicitly named symbols survive
 * trimming), and a capped one-hop neighborhood, then applies per-category quotas
 * under `maxNodes`. Deterministic: ties break by node id.
 *
 * Returns the picked candidates plus `matchedCount`, the size of the candidate
 * pool before the cap (so callers can report truncation).
 */
export function selectScope(
  graph: GraphEngine,
  task: string,
  maxNodes: number,
): { candidates: ScopedCandidate[]; matchedCount: number } {
  const pool = new Map<string, Candidate>();
  const add = (node: GraphNode, score: number, reason: string, bucket: SelectionCategory): void => {
    const category = isTestNode(node) ? "test" : bucket;
    const existing = pool.get(node.id);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      existing.reasons.add(reason);
      if (category === "direct") existing.category = "direct";
    } else {
      pool.set(node.id, { node, score, reasons: new Set([reason]), category });
    }
  };

  graph.searchNodes(task, { limit: 10 }).forEach((node, i) => add(node, 0.6 - i * 0.03, "semantic-match", "direct"));
  for (const token of taskTokens(task)) {
    for (const match of graph.searchNodes(token, { limit: 20 })) {
      if (match.name === token || match.qualifiedName === token || match.qualifiedName.endsWith(`::${token}`)) {
        add(match, 1, "exact-name-match", "direct");
      }
    }
  }

  const directSeeds = [...pool.values()]
    .filter((c) => c.category === "direct")
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))
    .slice(0, 6);
  for (const seed of directSeeds) {
    for (const caller of graph.getCallers(seed.node.id).slice(0, HOP_CAP)) add(caller, 0.3, "caller-of-seed", "neighbor");
    for (const callee of graph.getCallees(seed.node.id).slice(0, HOP_CAP)) add(callee, 0.3, "callee-of-seed", "neighbor");
  }

  const ranked = [...pool.values()].sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  const used: Record<SelectionCategory, number> = { direct: 0, neighbor: 0, test: 0 };
  const candidates: ScopedCandidate[] = [];
  for (const candidate of ranked) {
    if (candidates.length >= maxNodes) break;
    if (used[candidate.category] >= QUOTA[candidate.category]) continue;
    used[candidate.category] += 1;
    candidates.push({
      id: candidate.node.id,
      score: Number(candidate.score.toFixed(2)),
      reasons: [...candidate.reasons].sort(),
      category: candidate.category,
    });
  }
  return { candidates, matchedCount: pool.size };
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
    // False at build time; the emitter flips it true only for facts whose source
    // record actually fit the budget (see planSource). Defaulting false keeps the
    // accounted record shape >= the emitted one, so the token ceiling stays hard.
    sourceIncluded: false,
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
