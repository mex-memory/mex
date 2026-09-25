/**
 * The resolution state machine: what one grounding means in this checkout.
 *
 * Pure. It takes the graph as an interface and returns a value, so every row of
 * the table can be tested directly rather than by arranging a repository that
 * happens to produce it.
 *
 * ## The rule this file exists to enforce
 *
 * **The oracle is what Markdown committed, never what the graph cached.**
 *
 * `graph.db` holds a baseline — the node's source and body hash as of the last
 * grounding — and it is tempting to resolve by comparing the current node
 * against it. That is the bug. The baseline is re-captured every time the graph
 * is rebuilt or re-grounded, so after any ordinary `mex graph` the comparison
 * is current-against-current, every entity reports `fresh`, and drift
 * disappears at precisely the moment a user does the most routine thing
 * available to them. The cached baseline is for *showing* a reviewer the old
 * side of a diff. It decides nothing.
 *
 * Both values this file compares are canonical: the current node, read live,
 * and the entity's committed reference, read from Git-tracked Markdown.
 *
 * ## The table
 *
 * | condition | state | health |
 * |---|---|---|
 * | node found, committed reference matches | `fresh` | `fresh` |
 * | node found, committed reference diverges | `stale` | `changed` |
 * | Tier-1 miss → `MOVED`, rebound structure matches | `fresh` (rebound) | `fresh` |
 * | Tier-1 miss → `MOVED`, rebound structure diverges | `stale` (rebound) | `changed` |
 * | Tier-1 miss → `AMBIGUOUS` | `unresolved` | `ambiguous` |
 * | Tier-1 miss → `GONE` | `missing` | `missing` |
 * | no graph, or nothing to compare against | `unresolved` | `unverified` |
 * | entity has no grounding at all | `ungrounded` | `unverified` |
 *
 * Two rows differ from the brief's version, both in the direction of seeing
 * more drift rather than less.
 *
 * The first is *what* is compared: the brief says the fingerprint, and the
 * fingerprint provably cannot see a changed constant — the extractor represents
 * literals and identifiers by grammar kind alone, so `3600` becoming `7200`
 * leaves it byte-identical. {@link groundingComparator} carries the measurement.
 * A grounding that committed a body hash is checked against that; one that did
 * not falls back to the fingerprint and can only see structural change.
 *
 * The second is the `MOVED` row, which the brief resolves to `fresh` outright.
 * A move alone is still not drift — the entity id never changes and a rebound
 * symbol whose structure matches is `fresh` — but a symbol can move *and* be
 * rewritten in one commit, and calling that fresh would let real drift through
 * the rename door. So the rebound node is compared, by fingerprint (see
 * {@link compare} for why it cannot be by body hash).
 *
 * Whether a resolution was rebound is visible as `resolvedNode !== node` on
 * every variant, and as `rebound` on the fresh one.
 */

import {
  aggregateGroundingHealth,
  groundingComparator,
  type GroundingHealth,
  type GroundingResolution,
  type WikiGrounding,
} from "../model/grounding.js";
import type { GroundedNode, GroundingGraph } from "./adapter.js";

/**
 * Resolve one grounding against the local checkout.
 *
 * A null graph is the no-graph case and is completely normal: a fresh clone, a
 * checkout that never ran `mex graph`, a sandbox. It resolves `unverified`,
 * never a fabricated `fresh` (§8.7).
 */
export function resolveGrounding(
  grounding: WikiGrounding,
  graph: GroundingGraph | null,
): GroundingResolution {
  if (graph === null) {
    return {
      state: "unresolved",
      health: "unverified",
      node: grounding.node,
      reason: "No code graph is available in this checkout.",
    };
  }

  const direct = graph.getNode(grounding.node);
  if (direct !== null) return compare(grounding, graph, direct, grounding.node);

  // Tier-1 miss. The committed fingerprint is what finds the symbol again —
  // this is the job MinHash is actually for.
  const resolution = graph.reconcile(grounding.node, grounding.fingerprint, grounding.bodyHash);
  if (resolution === null) {
    return {
      state: "unresolved",
      health: "unverified",
      node: grounding.node,
      reason: `The committed fingerprint for ${grounding.node} could not be decoded, so the symbol cannot be looked for.`,
    };
  }

  if (resolution.kind === "AMBIGUOUS") {
    return {
      state: "unresolved",
      health: "ambiguous",
      node: grounding.node,
      candidates: [resolution.candidate],
      reason: `${grounding.node} may have moved; ${resolution.candidate} is a plausible but uncertain match.`,
    };
  }

  if (resolution.kind === "GONE") {
    return {
      state: "missing",
      health: "missing",
      node: grounding.node,
      reason: `${grounding.node} no longer exists in the code graph.`,
    };
  }

  const rebound = graph.getNode(resolution.nodeId);
  if (rebound === null) {
    // Reconciliation named a node the graph cannot produce. Treating that as
    // `fresh` would be inventing a verdict out of an inconsistency.
    return {
      state: "unresolved",
      health: "unverified",
      node: grounding.node,
      reason: `${grounding.node} was rebound to ${resolution.nodeId}, which the graph does not hold.`,
    };
  }
  return compare(grounding, graph, rebound, grounding.node);
}

/**
 * Compare a live node against what the entity committed.
 *
 * The whole rule, in one place: `bodyHash` when Markdown carries one,
 * fingerprint otherwise, and never the graph's cache.
 */
function compare(
  grounding: WikiGrounding,
  graph: GroundingGraph,
  node: GroundedNode,
  declaredNode: string,
): GroundingResolution {
  const currentBodyHash = node.bodyHash ?? "";
  const rebound = node.id !== declaredNode;

  // **A rebind is compared by fingerprint, never by body hash.** A symbol's
  // name is part of its body, so renaming it changes the body hash by
  // construction — measured, not assumed. Comparing it here would make
  // `fresh` with `rebound: true` unreachable and every rename would read as
  // drift, which is the brief's `MOVED` row inverted. Identity has already
  // been re-established by fingerprint at this point, so fingerprint is the
  // honest thing to compare.
  //
  // The residual, stated because it is real: a commit that renames a symbol
  // *and* edits a constant inside it resolves fresh, since neither signal can
  // see it. It does not stay hidden — the rebind means Markdown still names a
  // node that no longer exists, so it has to be rewritten by an operation, and
  // that write re-derives the body hash from the current node.
  if (!rebound && groundingComparator(grounding) === "bodyHash") {
    if (grounding.bodyHash === currentBodyHash) {
      return {
        state: "fresh",
        health: "fresh",
        node: declaredNode,
        resolvedNode: node.id,
        rebound,
        bodyHash: currentBodyHash,
      };
    }
    return {
      state: "stale",
      health: "changed",
      node: declaredNode,
      resolvedNode: node.id,
      // The *committed* hash, which is what the verdict was reached against.
      // The cached one may differ from it and is not what was compared.
      baselineBodyHash: grounding.bodyHash,
      currentBodyHash,
    };
  }

  // Structure: either the grounding committed no body hash, or the symbol was
  // rebound. This sees a symbol being rewritten and misses a constant being
  // edited, which is why anything mex writes commits a body hash.
  const currentFingerprint = graph.getFingerprint(node.id);
  if (currentFingerprint === null) {
    return {
      state: "unresolved",
      health: "unverified",
      node: declaredNode,
      reason: `${node.id} has no fingerprint in this graph, so there is nothing to compare the committed one against.`,
    };
  }
  if (currentFingerprint === grounding.fingerprint) {
    return {
      state: "fresh",
      health: "fresh",
      node: declaredNode,
      resolvedNode: node.id,
      rebound,
      bodyHash: currentBodyHash,
    };
  }
  return {
    state: "stale",
    health: "changed",
    node: declaredNode,
    resolvedNode: node.id,
    currentBodyHash,
  };
}

/** One entity's groundings, resolved together. */
export interface EntityResolution {
  /** One resolution per declared grounding, in declaration order. */
  groundings: GroundingResolution[];
  /** The worst health across them — `unverified` when there are none. */
  health: GroundingHealth;
}

/**
 * Resolve every grounding an entity declares.
 *
 * An entity with none is `ungrounded`, whose health is `unverified` and never
 * `fresh`: absence of evidence is not freshness, and the other default would
 * make an ungrounded wiki look fully verified.
 */
export function resolveEntityGroundings(
  groundings: readonly WikiGrounding[],
  graph: GroundingGraph | null,
): EntityResolution {
  if (groundings.length === 0) {
    return { groundings: [], health: "unverified" };
  }
  const resolved = groundings.map((grounding) => resolveGrounding(grounding, graph));
  // The model's precedence, not the query layer's `HEALTH_RANK`. The two orders
  // genuinely differ — the model calls `ambiguous` worse than `changed`, the
  // ranking penalizes `changed` more — because they answer different questions:
  // which finding should represent this entity, and how far a finding should
  // push it down a result list. Neither was invented here, and aggregating with
  // the ranking order would answer the first question with the second's answer.
  return { groundings: resolved, health: aggregateGroundingHealth(resolved) };
}
