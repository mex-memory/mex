import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GraphEngine } from "./engine.js";
import {
  extractQueryTerms,
  identifierComponents,
  isStopWord,
  nameMatchQuality,
} from "./query-terms.js";
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
  matchedTerms: Set<string>;
  category: SelectionCategory;
}

function isTestNode(node: GraphNode): boolean {
  return /(^|\/)(__tests__|tests?)\//.test(node.filePath) || /\.(test|spec)\./.test(node.filePath);
}

function distinctiveQueryTerms(task: string): Set<string> {
  const terms = new Set<string>();
  for (const raw of task.split(/\s+/)) {
    if (!/[_$!]|[a-z0-9][A-Z]/.test(raw)) continue;
    const [full] = identifierComponents(raw);
    if (full) terms.add(full);
  }
  return terms;
}

function kindBonus(kind: NodeKind): number {
  if (kind === "function" || kind === "method") return 0.03;
  if (["class", "struct", "interface", "trait", "protocol", "route", "component"].includes(kind)) return 0.02;
  return 0;
}

/**
 * Scored, quota-limited scope selection. Combines whole-task lexical search,
 * exact/component identifier matches, and a capped one-hop neighborhood, then
 * applies per-category quotas under `maxNodes`. Deterministic: ties break by id.
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
  const add = (
    node: GraphNode,
    score: number,
    reason: string,
    bucket: SelectionCategory,
    matchedTerm?: string,
  ): void => {
    const category = isTestNode(node) ? "test" : bucket;
    const existing = pool.get(node.id);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      existing.reasons.add(reason);
      if (matchedTerm) existing.matchedTerms.add(matchedTerm);
      if (category === "direct") existing.category = "direct";
    } else {
      pool.set(node.id, {
        node,
        score,
        reasons: new Set([reason]),
        matchedTerms: new Set(matchedTerm ? [matchedTerm] : []),
        category,
      });
    }
  };

  const terms = extractQueryTerms(task);
  const distinctiveTerms = distinctiveQueryTerms(task);
  const hasMeaningfulTerms = terms.some((term) => !isStopWord(term));
  // Candidate generation is deliberately wider than the emitted scope. Ranking
  // and the token ledger still enforce the small response; the wider pool keeps
  // a relevant symbol from disappearing behind many generic exact-name hits.
  graph.searchNodes(task, { limit: 30 }).forEach((node, i) => {
    // FTS can rank a parameter literally named "on" above the symbol named in a
    // sentence. It remains searchable directly, but must not seed NL expansion.
    if (hasMeaningfulTerms && isStopWord(node.name)) return;
    add(node, 0.6 - i * 0.03, "lexical-match", "direct");
  });
  for (const term of terms) {
    const matches = graph.searchNodes(term, { limit: 50 });
    // A component shared by dozens of symbols (for example `graph`, `node`, or
    // `source`) carries less evidence than a rarer project term. The floor stays
    // high enough that multi-term coverage can still identify readNodeSource-like
    // names without an embedding model.
    const componentScore = matches.length >= 40 ? 0.76 : matches.length >= 20 ? 0.81 : matches.length >= 10 ? 0.85 : 0.88;
    for (const match of matches) {
      const nameQuality = nameMatchQuality(match.name, term);
      const qualifiedQuality = nameMatchQuality(match.qualifiedName, term);
      if (nameQuality === "exact") {
        const distinctive = terms.length === 1 || distinctiveTerms.has(term);
        add(match, distinctive ? 1 : 0.78, distinctive ? "exact-name-match" : "generic-name-match", "direct", term);
      } else if (nameQuality === "component" || qualifiedQuality !== "none") {
        add(match, componentScore, "component-name-match", "direct", term);
      }
    }
  }

  // Once a symbol has earned a name match, use its signature/doc/path only as
  // corroborating evidence for additional task terms. Context can strengthen a
  // real candidate (`selectScope(graph, ..., maxNodes)`) but can never recreate
  // the original bug where an incidental signature mention became the seed.
  for (const candidate of pool.values()) {
    if (candidate.category !== "direct" || candidate.matchedTerms.size === 0) continue;
    const contextTerms = new Set(identifierComponents([
      candidate.node.signature ?? "",
      candidate.node.docstring ?? "",
      candidate.node.filePath,
    ].join(" ")));
    let addedContext = false;
    for (const term of terms) {
      if (term.length < 3 || candidate.matchedTerms.has(term) || !contextTerms.has(term)) continue;
      candidate.matchedTerms.add(term);
      addedContext = true;
    }
    if (addedContext) candidate.reasons.add("context-term-match");
  }

  const rankScore = (candidate: Candidate): number => {
    const coverage = Math.min(0.12, Math.max(0, candidate.matchedTerms.size - 1) * 0.04);
    const corroborated = candidate.matchedTerms.size > 0 && candidate.reasons.has("lexical-match") ? 0.05 : 0;
    const kind = candidate.matchedTerms.size > 0 ? kindBonus(candidate.node.kind) : 0;
    return Math.min(1, candidate.score + coverage + corroborated + kind);
  };
  const directSeeds = [...pool.values()]
    .filter((c) => c.category === "direct")
    .sort((a, b) => rankScore(b) - rankScore(a) || a.node.id.localeCompare(b.node.id))
    .slice(0, 6);
  for (const seed of directSeeds) {
    for (const caller of graph.getCallers(seed.node.id).slice(0, HOP_CAP)) add(caller, 0.3, "caller-of-seed", "neighbor");
    for (const callee of graph.getCallees(seed.node.id).slice(0, HOP_CAP)) add(callee, 0.3, "callee-of-seed", "neighbor");
  }

  const ranked = [...pool.values()].sort(
    (a, b) => rankScore(b) - rankScore(a) || a.node.id.localeCompare(b.node.id),
  );
  const used: Record<SelectionCategory, number> = { direct: 0, neighbor: 0, test: 0 };
  const candidates: ScopedCandidate[] = [];
  for (const candidate of ranked) {
    if (candidates.length >= maxNodes) break;
    if (used[candidate.category] >= QUOTA[candidate.category]) continue;
    used[candidate.category] += 1;
    candidates.push({
      id: candidate.node.id,
      score: Number(rankScore(candidate).toFixed(2)),
      reasons: [...candidate.reasons].sort(),
      category: candidate.category,
    });
  }
  return { candidates, matchedCount: pool.size };
}

/**
 * Build a compact fact (structure + relationship counts) for a node id, or null
 * if the node no longer exists. Body hashes are opt-in for grounding/fingerprint
 * workflows; ordinary retrieval should not spend its budget on them.
 */
export function compactFact(graph: GraphEngine, id: string, includeBodyHash = false): CompactFact | null {
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
    ...(includeBodyHash && node.bodyHash ? { bodyHash: node.bodyHash } : {}),
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
