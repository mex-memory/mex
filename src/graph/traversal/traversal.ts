// ============================================================================
// mex code-graph — graph traversal  (A4)
// ============================================================================
//
// The call-graph reads behind `GraphEngine.getCallers` / `getCallees`. Both are
// synchronous single-hop lookups over the `calls` edge set — the frozen contract
// (`../engine.ts`): callers are the sources of incoming `calls` edges, callees
// the targets of outgoing `calls` edges. Synchronous by design so the grounding
// checker (Track B) can stay synchronous.

import type { GraphNode } from "../types.js";
import type { GraphStore } from "../db/store.js";

/**
 * Nodes with an incoming `calls` edge to `id` (its direct callers). Empty if the
 * node has no callers or does not exist. Deduped, batch-fetched (no N+1).
 */
export function getCallers(store: GraphStore, id: string): GraphNode[] {
  const edges = store.getIncomingEdges(id, ["calls"]);
  return fetchEndpoints(store, edges.map((e) => e.source));
}

/**
 * Nodes with an outgoing `calls` edge from `id` (its direct callees). Empty if
 * the node calls nothing or does not exist. Deduped, batch-fetched.
 */
export function getCallees(store: GraphStore, id: string): GraphNode[] {
  const edges = store.getOutgoingEdges(id, ["calls"]);
  return fetchEndpoints(store, edges.map((e) => e.target));
}

/** Fetch the unique endpoint nodes, preserving first-seen edge order. */
function fetchEndpoints(store: GraphStore, ids: string[]): GraphNode[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const nodes = store.getNodesByIds(unique);
  const out: GraphNode[] = [];
  for (const id of unique) {
    const node = nodes.get(id);
    if (node) out.push(node);
  }
  return out;
}
