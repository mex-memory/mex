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
 * against it. That would make a disposable cache authoritative. A lost or
 * refreshed cache cannot establish what the fact previously accepted, nor
 * recreate old source from current code. Historical source is evidence for a
 * diff only while it matches the committed hash; absent source keeps finer
 * review conservative. The committed baseline survives either index being
 * deleted and rebuilt.
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
 * | Tier-1 miss → `MOVED`, committed body or verified rename-only source matches | `fresh` (rebound) | `fresh` |
 * | Tier-1 miss → `MOVED`, committed body differs without safe source evidence | `stale` (rebound) | `changed` |
 * | Tier-1 miss → `AMBIGUOUS` | `unresolved` | `ambiguous` |
 * | Tier-1 miss → `GONE` | `missing` | `missing` |
 * | no graph, absent change baseline/current body, or nothing to compare against | `unresolved` | `unverified` |
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
 * not falls back to the fingerprint and can only see structural change. A
 * matching fingerprint with no body baseline therefore leaves linked code
 * unverified rather than claiming that its literals are unchanged.
 *
 * The second is the `MOVED` row, which the brief resolves to `fresh` outright.
 * A move alone is still not drift — the entity id never changes and a rebound
 * symbol whose committed body matches is `fresh` — but a symbol can move *and* be
 * rewritten in one commit, and calling that fresh would let real drift through
 * the rename door. The committed body hash remains the change signal after a
 * rebind; only verified old/new source can establish a declaration-only rename.
 *
 * Whether a resolution was rebound is visible as `resolvedNode !== node` on
 * every variant, and as `rebound` on the fresh one.
 */

import {
  aggregateGroundingHealth,
  groundingComparator,
  type GroundingDriftNote,
  type GroundingHealth,
  type GroundingResolution,
  type WikiGrounding,
} from "../model/grounding.js";
import { sameFingerprintCode, type GroundedNode, type GroundingGraph } from "./adapter.js";
import { factDrift } from "./fact-drift.js";

/** What resolution may know about the entity a grounding belongs to. */
export interface GroundingContext {
  /** The entity's text (title and body): the fact the grounding supports. */
  fact?: string;
}

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
  context: GroundingContext = {},
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
  if (direct !== null) return compare(grounding, graph, direct, grounding.node, context);
  if (graph.incompleteReason) {
    return { state: "unresolved", health: "unverified", node: grounding.node, reason: graph.incompleteReason };
  }

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
  return compare(grounding, graph, rebound, grounding.node, context);
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
  context: GroundingContext,
): GroundingResolution {
  const currentBodyHash = node.bodyHash ?? "";
  const rebound = node.id !== declaredNode;

  // Identity reconciliation finds the node; it never accepts its new body.
  // A rename and a literal change can have the same structural fingerprint.
  // Compare the committed change baseline even after a move, and relax only
  // with verified old/new source evidence (including a declaration-only rename).
  if (groundingComparator(grounding) === "bodyHash") {
    if (currentBodyHash === "") {
      return {
        state: "unresolved", health: "unverified", node: declaredNode, resolvedNode: node.id,
        reason: "The graph has no current body hash, so the committed change baseline cannot be compared.",
      };
    }
    if (grounding.bodyHash === currentBodyHash) {
      // Keep the body the committed hash names, content-addressed, so a later
      // edit can be diffed against it. Without it the comment, layout, rename
      // and nearby relaxations have no old side and every edit reads changed.
      graph.rememberBody?.(node.id, currentBodyHash);
      return {
        state: "fresh",
        health: "fresh",
        node: declaredNode,
        resolvedNode: node.id,
        rebound,
        bodyHash: currentBodyHash,
      };
    }
    const drift = explainDrift(grounding, graph, node.id, context);
    // A rebound symbol whose old body this checkout never saw keeps the #229
    // rule: identity was re-established by structure, so matching structure
    // is the same code in a new place. With the old body, its evidence decides.
    if (drift === "no-baseline" && rebound) {
      const currentFingerprint = graph.getFingerprint(node.id);
      if (currentFingerprint !== null && sameFingerprintCode(currentFingerprint, grounding.fingerprint)) {
        return { state: "fresh", health: "fresh", node: declaredNode, resolvedNode: node.id, rebound, bodyHash: currentBodyHash };
      }
    }
    if (drift !== null && drift !== "no-baseline") {
      return {
        state: "fresh",
        health: "fresh",
        node: declaredNode,
        resolvedNode: node.id,
        rebound,
        bodyHash: currentBodyHash,
        ...(drift === "rename-only" ? {} : { drift }),
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

  // Legacy references without a change baseline can still reveal structural
  // edits. A structural match cannot establish freshness for a code body.
  const currentFingerprint = graph.getFingerprint(node.id);
  if (currentFingerprint === null) {
    return {
      state: "unresolved",
      health: "unverified",
      node: declaredNode,
      reason: `${node.id} has no fingerprint in this graph, so there is nothing to compare the committed one against.`,
    };
  }
  // By value: a grounding committed before #233 spells the same fingerprint in
  // the older encoding, and that is not a change. And by code alone: the
  // neighbour list changes when a caller elsewhere is added or node ids are
  // re-minted (#240), and reading that as this node's code changing reported
  // `changed` for groundings whose every token was the same.
  if (sameFingerprintCode(currentFingerprint, grounding.fingerprint)) {
    return {
      state: "unresolved", health: "unverified", node: declaredNode, resolvedNode: node.id,
      reason: "No committed body baseline; matching structure cannot verify unchanged literals or signatures. Review the fact before recording a baseline.",
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

/**
 * Why a body that differs from the committed hash still says the same thing,
 * or null when that cannot be shown. In order of certainty: only comments
 * changed, only layout changed, or — given the fact's text — the change is in
 * lines away from everything the fact names ({@link factDrift}). Every gap in
 * the evidence (no source, no remembered old body, no fact) returns null, and
 * the grounding stays `changed`.
 */
function explainDrift(
  grounding: WikiGrounding,
  graph: GroundingGraph,
  nodeId: string,
  context: GroundingContext,
): GroundingDriftNote | "rename-only" | "no-baseline" | null {
  const evidence = graph.explainChange?.(grounding, nodeId) ?? null;
  if (evidence === null) return "no-baseline";
  if (evidence.commentOnly) return { kind: "comment-only" };
  if (evidence.layoutOnly) return { kind: "layout-only" };
  const rebound = grounding.node !== nodeId;
  if (rebound && evidence.renameOnly === true) return "rename-only";
  if (evidence.oldBody === null || evidence.newBody === null) return "no-baseline";
  if (context.fact !== undefined) {
    const verdict = factDrift(context.fact, evidence.oldBody, evidence.newBody);
    if (verdict.kind === "nearby") return { kind: "changed-nearby", anchors: verdict.anchors };
  }
  // A rebind whose rename cannot be proven either way has no evidence for it.
  return rebound && evidence.renameOnly === undefined ? "no-baseline" : null;
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
  context: GroundingContext = {},
): EntityResolution {
  if (groundings.length === 0) {
    return { groundings: [], health: "unverified" };
  }
  const resolved = groundings.map((grounding) => resolveGrounding(grounding, graph, context));
  // The model's precedence, not the query layer's `HEALTH_RANK`. The two orders
  // genuinely differ — the model calls `ambiguous` worse than `changed`, the
  // ranking penalizes `changed` more — because they answer different questions:
  // which finding should represent this entity, and how far a finding should
  // push it down a result list. Neither was invented here, and aggregating with
  // the ranking order would answer the first question with the second's answer.
  return { groundings: resolved, health: aggregateGroundingHealth(resolved) };
}
