/**
 * §12.4 — a grounding is accepted only when the graph can produce it.
 *
 * The gap this closes is a real one in the reference implementation, where
 * `grounding.nodeIds` could be persisted without ever capturing a snapshot: an
 * agent writes a plausible-looking node id, nothing checks it, and the entity
 * is thereafter "grounded" to something that was never verified. §8.7 states
 * the rule directly — *a unit is not considered verifiably grounded merely
 * because its Markdown contains an arbitrary node ID.*
 *
 * ## Where this sits, given P5 does not exist
 *
 * The operation this belongs to is `set-grounding`, and operations are P5. So
 * what is built here is the **check**, as a pure function over an injected
 * graph, with no knowledge of plans, previews or writes. P5's `plan.ts` calls
 * it and turns a non-empty result into a rejected plan; nothing else changes
 * when it does. Building the operation now would mean guessing P5's pipeline
 * shape, and building nothing would leave P5 to invent the rule.
 *
 * The check is deliberately *re-derivation*, not comparison against a store.
 * Asking "is this pair in the baseline table" would accept anything a previous
 * unverified write had already put there — the invariant has to bottom out in
 * the live graph, in this process, or it bottoms out in itself.
 */

import type { WikiDiagnostic } from "../model/diagnostic.js";
import {
  verifyGroundingProvenance,
  type GraphDerivedGrounding,
  type WikiGrounding,
} from "../model/grounding.js";
import { deriveGrounding, sameFingerprint, type GroundingGraph } from "./adapter.js";

/**
 * Whether this exact node-and-fingerprint pair comes out of the current graph.
 *
 * Both halves are checked. A real node id carrying a stale or invented
 * fingerprint is exactly the shape of a caller who copied one line and made up
 * the other, and it is the case a node-only check would wave through.
 *
 * A committed `bodyHash`, when present, is checked too: it is what drift is
 * later measured against, so accepting a wrong one would poison every future
 * resolution — the entity would read `stale` forever, or worse, `fresh` against
 * a hash that never described the code.
 */
export function isGraphDerivedGrounding(graph: GroundingGraph, grounding: WikiGrounding): boolean {
  const derived = deriveGrounding(graph, grounding.node);
  if (derived === null) return false;
  if (derived.node !== grounding.node) return false;
  if (!sameFingerprint(derived.fingerprint, grounding.fingerprint)) return false;
  if (grounding.bodyHash !== undefined && derived.bodyHash !== grounding.bodyHash) return false;
  return true;
}

/**
 * Check a proposed set of groundings, returning one `GROUNDING_UNVERIFIED` per
 * pair the graph cannot produce.
 *
 * An empty result means the set is acceptable. A missing graph fails *every*
 * grounding rather than passing them: an operation that writes a permanent
 * canonical reference cannot be allowed to proceed unverified just because the
 * thing that would verify it is absent. That is the opposite of the read path,
 * where a missing graph degrades to `unverified` and shows what it has.
 */
export function checkGroundingProvenance(
  groundings: readonly WikiGrounding[],
  graph: GroundingGraph | null,
): WikiDiagnostic[] {
  if (graph === null) {
    return verifyGroundingProvenance(groundings, () => false);
  }
  return verifyGroundingProvenance(groundings, (grounding) => isGraphDerivedGrounding(graph, grounding));
}

/**
 * Re-derive a caller's proposed groundings, returning the branded values on
 * success and diagnostics on failure.
 *
 * This is the shape P5 wants: it cannot accept the caller's strings and it
 * cannot mint the branded type itself, so it hands the pairs here and gets back
 * either values it may write or the reasons it may not.
 */
export function deriveVerifiedGroundings(
  groundings: readonly WikiGrounding[],
  graph: GroundingGraph | null,
): { ok: true; groundings: GraphDerivedGrounding[] } | { ok: false; diagnostics: WikiDiagnostic[] } {
  const diagnostics = checkGroundingProvenance(groundings, graph);
  if (diagnostics.length > 0 || graph === null) {
    return { ok: false, diagnostics };
  }

  const derived: GraphDerivedGrounding[] = [];
  for (const grounding of groundings) {
    // Non-null by construction: `checkGroundingProvenance` returned nothing,
    // which it only does when every pair re-derived.
    const value = deriveGrounding(graph, grounding.node, {
      file: grounding.file,
      commit: grounding.commit,
      verifiedAt: grounding.verifiedAt,
      reason: grounding.reason,
    });
    if (value === null) {
      return { ok: false, diagnostics: verifyGroundingProvenance([grounding], () => false) };
    }
    derived.push(value);
  }
  return { ok: true, groundings: derived };
}
