/**
 * Bounds, in the vocabulary the graph already uses.
 *
 * **HARD (§4.7): this is not a second budget system.** `estimateTokens` and
 * `BudgetLedger` in `src/graph/agent-protocol.ts` are what every agent-facing
 * command in this repo already accounts with, and P7 has to fuse wiki results
 * with graph results into one response under one ceiling. Two estimators would
 * make that response's own accounting wrong — each half honest about itself and
 * neither honest about the total — so the wiki reuses them rather than
 * measuring tokens its own way.
 *
 * What is added here is only what the wiki needs and the graph does not have: a
 * default neighbourhood ceiling (D10: 4,000 tokens) and the two count bounds
 * that go with it.
 */

import { BudgetLedger, estimateTokens, FRAMING_RESERVE } from "../../graph/agent-protocol.js";

export { estimateTokens, BudgetLedger, FRAMING_RESERVE };

/** D10's default neighbourhood budget. */
export const DEFAULT_NEIGHBORHOOD_TOKENS = 4000;

/**
 * Default and hard-maximum result counts.
 *
 * The maximum is the half that matters: a caller can ask for more than the
 * default, but nothing can ask for everything. "No query may silently fall back
 * to loading the whole wiki" is a HARD invariant, and the way to keep it is to
 * make unbounded inexpressible rather than merely discouraged.
 */
export const DEFAULT_RESULT_LIMIT = 50;
export const MAX_RESULT_LIMIT = 500;

/** Default and maximum traversal depth for `related`. */
export const DEFAULT_TRAVERSAL_DEPTH = 2;
export const MAX_TRAVERSAL_DEPTH = 5;

/**
 * How many edges one entity's relation or backlink list may carry.
 *
 * Separate from `limit` on purpose. Reusing the result limit for both meant
 * that asking for one *node* also fetched one *edge*, so a traversal bounded to
 * a single node reported the neighbourhood as complete when it had seen one
 * relation out of several — a bound silently changing the answer rather than
 * truncating it.
 */
export const MAX_EDGES_PER_ENTITY = 200;

export interface Bounds {
  /** Rows returned. Clamped into `[1, MAX_RESULT_LIMIT]`. */
  limit: number;
  /** Edges fetched per entity. Independent of `limit`; see above. */
  edgeLimit: number;
  /** Estimated tokens the result may occupy. */
  maxTokens: number;
  /** Traversal depth, for the queries that traverse. Clamped to `MAX_TRAVERSAL_DEPTH`. */
  depth: number;
}

export interface BoundsInput {
  limit?: number;
  edgeLimit?: number;
  maxTokens?: number;
  depth?: number;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

/**
 * Resolve caller-supplied bounds against the defaults.
 *
 * Every query path goes through this, so there is exactly one place where a
 * limit could be omitted — and it cannot be, because the return type has no
 * "unbounded" case.
 */
export function resolveBounds(input: BoundsInput = {}): Bounds {
  return {
    limit: clamp(input.limit, DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT),
    edgeLimit: clamp(input.edgeLimit, MAX_EDGES_PER_ENTITY, MAX_EDGES_PER_ENTITY),
    maxTokens: clamp(input.maxTokens, DEFAULT_NEIGHBORHOOD_TOKENS, Number.MAX_SAFE_INTEGER),
    depth: clamp(input.depth, DEFAULT_TRAVERSAL_DEPTH, MAX_TRAVERSAL_DEPTH),
  };
}

/**
 * Fill a result list up to both bounds.
 *
 * Returns what fits and says whether anything was dropped, rather than
 * truncating silently: a caller that cannot tell a complete answer from a
 * truncated one will treat the truncated one as complete.
 */
export function fitWithinBudget<T>(items: readonly T[], bounds: Bounds): { items: T[]; truncated: boolean } {
  const ledger = new BudgetLedger(bounds.maxTokens);
  const kept: T[] = [];
  let truncated = false;

  for (const item of items) {
    if (kept.length >= bounds.limit) {
      truncated = true;
      break;
    }
    if (!ledger.tryAdd(item)) {
      truncated = true;
      break;
    }
    kept.push(item);
  }

  return { items: kept, truncated };
}
