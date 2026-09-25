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

/**
 * A MOVED match must lead the runner-up by at least this much, or it is
 * AMBIGUOUS: an exact copy of a grounded body elsewhere must not win a tie by
 * id order and be rebound silently. Same margin refresh's fingerprint aliases use.
 */
export const MOVED_MARGIN = 0.08;

/** Weight of body similarity (MinHash Jaccard) in the reconcile score. */
export const W_BODY = 0.7;

/** Weight of neighborhood overlap (caller/callee ids) in the reconcile score. */
export const W_NBR = 0.3;

/**
 * Below this token count a node's body sketch is untrusted: it never decides a
 * match by itself, and only caller/callee continuity can (see below).
 */
export const MIN_TOKENS = 30;

// ----------------------------------------------------------------------------
// Small nodes: caller/callee continuity (#229)
// ----------------------------------------------------------------------------
//
// Below MIN_TOKENS a body sketch cannot tell one wrapper from another, so a
// renamed three-line function used to be GONE outright. Its callers and
// callees usually survive a rename untouched, so for small nodes they are the
// evidence, and the body is only a shape check that must also pass.

/**
 * A small-node candidate must share at least this many neighbors with the
 * baseline. A single shared caller says little: most helpers have one, and a
 * replacement function inherits it just as easily as a renamed one.
 */
export const NBR_MIN_SHARED = 2;

/**
 * Neighbor Jaccard a small-node candidate needs to be MOVED. A pure rename of
 * a freshly grounded node keeps every neighbor (1.0); 0.8 tolerates one added
 * or dropped neighbor among five, but not a pre-existing function with one
 * extra caller of its own (3 of 4 = 0.75), which is what a replacement usually
 * looks like. Below it a compatible body is AMBIGUOUS at most.
 */
export const NBR_HI = 0.8;

/**
 * MinHash Jaccard a small-node candidate needs for its body shape to count as
 * compatible. Identifier and literal spellings are not tokens, so a pure
 * rename scores 1.0; on a ~15-token body one changed token already costs about
 * a third of the trigrams, so this admits a small edit and not a new body.
 */
export const SMALL_BODY_MIN = 0.6;

/** Largest relative token-count difference a compatible small-node body may have. */
export const SMALL_TOKEN_SLACK = 0.25;

/**
 * Bounded work: the most neighborhood candidates one small-node miss scores.
 * Candidates are ranked by shared neighbors first, so a hub neighbor cannot
 * crowd out the real one.
 */
export const NBR_CANDIDATE_LIMIT = 64;

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
  MOVED_MARGIN,
  W_BODY,
  W_NBR,
  MIN_TOKENS,
  NBR_MIN_SHARED,
  NBR_HI,
  SMALL_BODY_MIN,
  SMALL_TOKEN_SLACK,
  NBR_CANDIDATE_LIMIT,
  K,
  BANDS,
  ROWS,
});

export type ReconcilerParams = typeof RECONCILER_PARAMS;
