// ============================================================================
// mex code-graph — Reconciler interface  (FROZEN — Phase 0, spec §4)
// ============================================================================
//
// The identity core. Tier-1 ids survive body edits and line shifts but read a
// RENAME or MOVE as delete+add. The reconciler recovers identity in exactly that
// case: it fires ONLY on a Tier-1 miss (a grounded node id that no longer
// exists), and decides whether the node MOVED (rebind silently), is GONE
// (deleted → checker error), or is AMBIGUOUS (agent adjudicates in `sync`).
//
// Algorithm (Track B implements against this frozen interface, spec §4):
//   reconcile(missingNodeId, baseline):
//     1. baseline.tokenCount < MIN_TOKENS       -> GONE   (too small to trust)
//     2. candidates = LSH_lookup(baseline);
//        candidates empty                       -> GONE
//     3. score(c) = W_BODY*jaccard(baseline.minhash, c.minhash)
//                 + W_NBR*overlap(baseline.neighbors, c.neighbors)
//     4. best = argmax(score)
//        score >= HI                            -> MOVED(best.id)
//        score <  LO                            -> GONE
//        else                                   -> AMBIGUOUS(best.id)
//
// Tunable params (HI/LO/W_BODY/W_NBR/MIN_TOKENS/K/BANDS/ROWS) live in
// `src/graph/config.ts`. They are placeholders, tuned later against a real
// fixture (spec §12) — not truths baked into this contract.

import { NotImplementedError } from "./errors.js";

// ----------------------------------------------------------------------------
// Fingerprint (Tier-2 identity payload)
// ----------------------------------------------------------------------------

/**
 * A node's Tier-2 fingerprint, decoded from a `node_fingerprints` row (or from
 * a scaffold's `grounds_to[].fingerprint` baseline). Built fresh by Track B (B1)
 * — this contract only describes its shape.
 *
 * `minhash` is a K-length (spec §4: K=64) MinHash sketch of the node's
 * normalized-AST trigrams. `neighbors` is the sorted list of caller+callee
 * Tier-1 ids. `tokenCount` gates trust: below `MIN_TOKENS` the fingerprint is
 * too small to distinguish, so reconciliation returns GONE rather than guess.
 */
export interface Fingerprint {
  /** K uint32 MinHash values (K = {@link config.K}). */
  minhash: number[];
  /** Sorted caller+callee Tier-1 node ids (the neighborhood signature). */
  neighbors: string[];
  /** Token count of the normalized body; below MIN_TOKENS the fingerprint is untrusted. */
  tokenCount: number;
}

/**
 * Serialization prefix for the `grounds_to[].fingerprint` frontmatter string.
 * The baseline fingerprint is stored as `"mh:<K>:<hex>"` (spec §5). Track B owns
 * the exact encode/decode; this constant pins the discriminator so writers and
 * readers agree.
 */
export const FINGERPRINT_PREFIX = "mh" as const;

// ----------------------------------------------------------------------------
// Resolution (the reconciler's verdict)
// ----------------------------------------------------------------------------

/**
 * The outcome of reconciling a missing (Tier-1) node id against the current
 * graph. Exactly the three cases from spec §4 — do not add variants:
 *
 *  - `MOVED`     — same anchor found under a new id; rebind `grounds_to`
 *                  silently (no error/warning). Carries the new `nodeId`.
 *  - `GONE`      — the node was deleted; the grounding checker emits an ERROR.
 *  - `AMBIGUOUS` — a plausible-but-uncertain match; the checker emits a WARNING
 *                  naming `candidate`, and `sync` asks the agent to confirm.
 */
export type Resolution =
  | { kind: "MOVED"; nodeId: string }
  | { kind: "GONE" }
  | { kind: "AMBIGUOUS"; candidate: string };

// ----------------------------------------------------------------------------
// The interface
// ----------------------------------------------------------------------------

/**
 * Resolves a Tier-1 miss into a {@link Resolution}. Implementations read
 * candidate fingerprints via LSH over `node_fingerprints` / `lsh_buckets`
 * (Track B); this seam hides that behind one synchronous call, so the grounding
 * checker (and its tests) can depend on the interface, not the storage.
 *
 * Synchronous by design: `node:sqlite` reads are synchronous, and the grounding
 * checker that calls this must itself stay synchronous to match the existing
 * drift-checker signature (see `src/graph/grounding.ts`).
 */
export interface Reconciler {
  /**
   * @param missingNodeId The grounded Tier-1 id that no longer resolves.
   * @param baseline      The fingerprint captured when the scaffold was grounded
   *                      (from `_mex_grounded_source` / `grounds_to`).
   */
  reconcile(missingNodeId: string, baseline: Fingerprint): Resolution;
}

/**
 * Phase-0 throwing stub. Track B replaces it with the real reconciler (B3).
 * Present so the grounding checker and its tests can be wired against the
 * interface before the engine exists.
 */
export const notImplementedReconciler: Reconciler = {
  reconcile(): Resolution {
    throw new NotImplementedError("Reconciler.reconcile");
  },
};
