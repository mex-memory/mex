// ============================================================================
// mex code-graph — reconciler tuning params  (Phase 0, spec §4 / §12)
// ============================================================================
//
// PLACEHOLDER VALUES. These are the reconciler's knobs, shipped as named
// constants so the algorithm (Track B) reads them from one place. They are NOT
// truths — they get eval-tuned later against a real fixture (spec §12: "ship
// placeholders, tune later"). Treat every value here as provisional until the
// eval harness lands.

/** MOVED threshold: score >= HI ⇒ same node under a new id ⇒ rebind silently. */
export const HI = 0.85;

/** GONE threshold: score < LO ⇒ deleted. Between LO and HI ⇒ AMBIGUOUS. */
export const LO = 0.55;

/** Weight of body similarity (MinHash Jaccard) in the reconcile score. */
export const W_BODY = 0.7;

/** Weight of neighborhood overlap (caller/callee ids) in the reconcile score. */
export const W_NBR = 0.3;

/** Below this token count a node's fingerprint is untrusted ⇒ reconcile ⇒ GONE. */
export const MIN_TOKENS = 30;

/** MinHash sketch size (number of hash values per fingerprint). */
export const K = 64;

/** LSH band count. BANDS * ROWS must equal K. */
export const BANDS = 32;

/** LSH rows per band. BANDS * ROWS must equal K. */
export const ROWS = 2;

/**
 * All reconciler params as one frozen object, for callers/tests that want to
 * pass or snapshot them together. Mirrors the individual named constants above.
 */
export const RECONCILER_PARAMS = Object.freeze({
  HI,
  LO,
  W_BODY,
  W_NBR,
  MIN_TOKENS,
  K,
  BANDS,
  ROWS,
});

export type ReconcilerParams = typeof RECONCILER_PARAMS;
