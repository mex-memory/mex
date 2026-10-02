import type { WikiDiagnostic } from "./diagnostic.js";
import {
  contextDiagnostic,
  isPlainObject,
  optional,
  reject,
  succeed,
  validateShape,
  validateString,
  type ValidationContext,
  type Validator,
} from "./validate.js";
import { isCanonicalRepoPath } from "./path.js";

/**
 * Code grounding — how a knowledge entity points at real code.
 *
 * Grounding is kept apart from general evidence (`source.ts`) because it does
 * two jobs nothing else does: it drives drift detection, and it is the join
 * that lets a question about code return the conventions and decisions attached
 * to *that* code rather than a keyword-similar document.
 *
 * ## What is canonical
 *
 * The node id and fingerprint in Markdown are the canonical, Git-tracked
 * reference, and **the fingerprint is the drift oracle**. Everything else is
 * rebuildable cache: the code graph holds a baseline body hash and old source
 * text so drift can be *displayed* as an old-vs-new diff, and the wiki index
 * holds derived resolution results so they can be filtered and sorted. Delete
 * both databases and drift is still detectable, because the canonical
 * fingerprint is in the Markdown. Anything that treats the cached baseline as
 * the primary signal will silently report `fresh` after a graph rebuild
 * re-captures that baseline, which is exactly the failure this note exists to
 * prevent.
 *
 * ## Two axes that must never be assignable to one another
 *
 * | Axis | Values | Meaning |
 * |---|---|---|
 * | Lifecycle (canonical, in Markdown, shared via Git) | `in_flight` `promoted` `deprecated` `archived` | governance — what the team decided |
 * | Grounding health (derived, local, per checkout) | `fresh` `changed` `missing` `ambiguous` `unverified` | is the code this claim describes still what it was |
 *
 * A promoted entity can be changed on one branch and fresh on another. Local
 * health must never rewrite canonical lifecycle. The reference implementation
 * had a `stale` value inside its lifecycle enum; that conflation is the bug
 * these two separate enums exist to make unrepresentable.
 */

/** The canonical, Git-tracked grounding reference as it appears in Markdown. */
export interface WikiGrounding {
  /** Code-graph node id. Produced by the graph, never invented. */
  node: string;
  /**
   * Serialized MinHash fingerprint, `mh2:<K>:<base64url>` (or `mh:<K>:<hex>`
   * before #233). Produced by the graph.
   *
   * This is an **identity** signal, not a change signal. It is what finds a
   * symbol again after it moves — see {@link groundingComparator} for why that
   * distinction decides how drift is detected.
   */
  fingerprint: string;
  /**
   * sha256 of the grounded node's body when the entity was grounded.
   *
   * **The change signal, and canonical because it is in Markdown.** Optional
   * only because §8.7 requires `node` and `fingerprint` and this is additive:
   * a grounding written before this field existed still resolves, through the
   * coarser comparator {@link groundingComparator} names. Everything mex writes
   * carries it.
   */
  bodyHash?: string;
  /** Repository-relative path, cached for display when the graph is unavailable. */
  file?: string;
  commit?: string;
  /** ISO 8601 timestamp of the last successful verification. */
  verifiedAt?: string;
  /** Why this entity is grounded here. */
  reason?: string;
}

/**
 * Derived, per-checkout resolution state. Never written to Markdown.
 *
 * `ungrounded` is a property of the *entity* (it declares no groundings);
 * the other four are properties of one grounding reference.
 */
export type GroundingState = "fresh" | "stale" | "missing" | "unresolved" | "ungrounded";

/** Derived, per-checkout health. Never written to Markdown. */
export type GroundingHealth = "fresh" | "changed" | "missing" | "ambiguous" | "unverified";

export const GROUNDING_STATES = ["fresh", "stale", "missing", "unresolved", "ungrounded"] as const;
export const GROUNDING_HEALTHS = ["fresh", "changed", "missing", "ambiguous", "unverified"] as const;

/**
 * Resolution of one grounding against the local checkout.
 *
 * A discriminated union on `state`, with `health` pinned to a literal in each
 * variant, so a contradictory pair such as `{state: "stale", health: "fresh"}`
 * does not typecheck. Making it unrepresentable is stronger than documenting it
 * as discouraged, because the value is assembled in one place and read in a
 * dozen.
 */
export type GroundingResolution =
  | {
      state: "fresh";
      health: "fresh";
      /** The declared node id. */
      node: string;
      /**
       * The node actually resolved to. Differs from `node` when the symbol
       * moved and was rebound through reconciliation — the entity id is
       * unchanged, and Markdown is updated separately by an operation.
       */
      resolvedNode: string;
      /** True when reconciliation rebound a moved symbol. */
      rebound: boolean;
      bodyHash: string;
    }
  | {
      state: "stale";
      health: "changed";
      node: string;
      resolvedNode: string;
      /** Body hash captured when the entity was grounded. */
      baselineBodyHash?: string;
      /** Body hash in the current checkout. */
      currentBodyHash: string;
    }
  | {
      state: "missing";
      health: "missing";
      node: string;
      /** Why the node could not be found — carried through for the reviewer. */
      reason?: string;
    }
  | {
      state: "unresolved";
      /**
       * `ambiguous` — reconciliation found several equally good candidates.
       * `unverified` — no graph, or no fingerprint to compare against.
       *
       * The two are different situations with the same state, so health is the
       * discriminator: ambiguity is a real finding about the code, while
       * unverified means we simply did not look.
       */
      health: "ambiguous" | "unverified";
      node: string;
      /** Candidate nodes, when the resolution was ambiguous. */
      candidates?: string[];
      reason?: string;
    }
  | {
      state: "ungrounded";
      health: "unverified";
    };

/**
 * Aggregate health across several groundings: the worst one wins.
 *
 * Precedence, worst first: `missing` > `ambiguous` > `changed` > `unverified` >
 * `fresh`. An entity with no groundings at all is `unverified`, never `fresh` —
 * absence of evidence is not freshness, and defaulting the other way would make
 * an ungrounded wiki look fully verified.
 */
const HEALTH_PRECEDENCE: Record<GroundingHealth, number> = {
  missing: 0,
  ambiguous: 1,
  changed: 2,
  unverified: 3,
  fresh: 4,
};

export function aggregateGroundingHealth(resolutions: readonly GroundingResolution[]): GroundingHealth {
  if (resolutions.length === 0) return "unverified";
  let worst: GroundingHealth = "fresh";
  for (const resolution of resolutions) {
    if (HEALTH_PRECEDENCE[resolution.health] < HEALTH_PRECEDENCE[worst]) worst = resolution.health;
  }
  return worst;
}

/** Order two healths worst-first. Exported so query ranking shares one ordering. */
export function compareGroundingHealth(left: GroundingHealth, right: GroundingHealth): number {
  return HEALTH_PRECEDENCE[left] - HEALTH_PRECEDENCE[right];
}

/**
 * Shape of a serialized fingerprint in the original encoding: `mh:<K>:<hex>`.
 *
 * Shape only. The canonical codec lives in `src/graph/fingerprint.ts`, and the
 * model layer deliberately does not import it — the model must stay free of the
 * graph so wiki reads work with no graph present. Decoding and comparing
 * fingerprints is the grounding adapter's job.
 */
export const FINGERPRINT_PATTERN = /^mh:\d+:(?:[0-9a-f]{2})+$/i;

/** Shape of the compact encoding written since #233: `mh2:<K>:<base64url>`. Case is data here. */
export const COMPACT_FINGERPRINT_PATTERN = /^mh2:\d+:[A-Za-z0-9_-]+$/;

export function isFingerprintShaped(value: unknown): value is string {
  return typeof value === "string"
    && (FINGERPRINT_PATTERN.test(value) || COMPACT_FINGERPRINT_PATTERN.test(value));
}

/**
 * Shape of a code-graph node id: `<kind>:<hex>`.
 *
 * Also shape only, and deliberately permissive about the kind, since the graph
 * adds node kinds as it learns new languages. A shape check catches the common
 * failure — an agent writing a function *name* where a node id belongs — while
 * real verification against the live graph happens at write time.
 */
export const GRAPH_NODE_ID_PATTERN = /^[a-z_]+:[0-9a-f]{8,}$/i;

export function isNodeIdShaped(value: unknown): value is string {
  return typeof value === "string" && GRAPH_NODE_ID_PATTERN.test(value);
}

/**
 * Which committed value a grounding can be checked against, and therefore what
 * kind of change it can see.
 *
 * **The fingerprint cannot see a changed constant, and this is measured, not
 * assumed.** The extractor represents identifiers and literals by their grammar
 * kind alone — `normalizedCompilerTokens` says so in as many words, and a probe
 * against a real graph confirms it: changing `3600` to `7200`, or renaming a
 * local, moves the node's `bodyHash` and leaves its serialized fingerprint
 * byte-identical. That is deliberate and correct for the fingerprint's actual
 * job, which is finding a symbol again after it moves.
 *
 * It is the wrong instrument for drift. A decision entity that says "tokens
 * rotate every hour" is grounded to exactly the code where the constant lives,
 * and a fingerprint-only check reports it `fresh` forever after someone edits
 * the number.
 *
 * So the drift comparison prefers the body hash **committed in Markdown**. Note
 * what that does *not* mean: the graph's cached `body_hash` is still never the
 * oracle. A cache is re-captured by an ordinary graph rebuild, so comparing
 * current-against-cache compares current against current and drift vanishes.
 * Both values compared here — the current node's, and the entity's — are
 * canonical: one is the live code, the other is in Git.
 */
export function groundingComparator(grounding: WikiGrounding): "bodyHash" | "fingerprint" {
  return typeof grounding.bodyHash === "string" && grounding.bodyHash.length > 0
    ? "bodyHash"
    : "fingerprint";
}

const shapeValidator = validateShape<WikiGrounding>({
  node: validateString(),
  fingerprint: validateString(),
  bodyHash: optional(validateString()),
  file: optional(validateString()),
  commit: optional(validateString()),
  verifiedAt: optional(validateString()),
  reason: optional(validateString()),
});

/**
 * Validate a canonical grounding reference.
 *
 * Both `node` and `fingerprint` are required: a node id alone cannot detect
 * drift, and an entity whose Markdown merely contains an arbitrary node id is
 * not verifiably grounded.
 */
export const validateGrounding: Validator<WikiGrounding> = (value, context) => {
  if (!isPlainObject(value)) {
    return reject(context, "MALFORMED_GROUNDING", "Expected a grounding object with `node` and `fingerprint`.");
  }
  const base = shapeValidator(value, context);
  if (!base.ok) {
    // Re-code the generic field diagnostics so consumers see a grounding
    // problem rather than an anonymous type error.
    return {
      ok: false,
      diagnostics: base.diagnostics.map((entry) =>
        entry.code === "MISSING_REQUIRED_FIELD" || entry.code === "INVALID_FIELD_TYPE"
          ? { ...entry, code: "MALFORMED_GROUNDING" as const }
          : entry,
      ),
    };
  }

  const grounding = base.value;
  const diagnostics: WikiDiagnostic[] = [...base.diagnostics];

  if (!isNodeIdShaped(grounding.node)) {
    diagnostics.push(
      contextDiagnostic(context, "MALFORMED_GROUNDING", `"${grounding.node}" is not a code-graph node id.`),
    );
  }
  if (!isFingerprintShaped(grounding.fingerprint)) {
    diagnostics.push(
      contextDiagnostic(context, "MALFORMED_GROUNDING", `"${grounding.fingerprint}" is not a serialized fingerprint (mh2:<K>:<base64url> or mh:<K>:<hex>).`),
    );
  }
  if (grounding.file !== undefined && !isCanonicalRepoPath(grounding.file)) {
    diagnostics.push(contextDiagnostic(
      context,
      "MALFORMED_GROUNDING",
      `"${grounding.file}" is not a normalized repository-relative POSIX path.`,
    ));
  }
  if (grounding.verifiedAt !== undefined && Number.isNaN(Date.parse(grounding.verifiedAt))) {
    diagnostics.push(contextDiagnostic(context, "MALFORMED_GROUNDING", `"${grounding.verifiedAt}" is not an ISO 8601 timestamp.`));
  }

  return diagnostics.some((entry) => entry.severity === "error")
    ? { ok: false, diagnostics }
    : succeed(grounding, diagnostics);
};

/**
 * Proof that a grounding came from live graph output.
 *
 * The build spec's §12.4 invariant is that an agent cannot invent a node id or
 * a fingerprint — a caller-supplied string that merely *looks* like one must be
 * rejected. This is the model-level representation of that: a grounding can
 * only acquire the brand by passing through {@link asGraphDerived}, which the
 * grounding adapter calls with values it re-derived from the graph in the same
 * process. A plain `WikiGrounding` parsed from JSON can never be assigned to it.
 */
declare const graphDerivedBrand: unique symbol;

export type GraphDerivedGrounding = WikiGrounding & { readonly [graphDerivedBrand]: true };

/**
 * Brand a grounding as graph-derived.
 *
 * **Only the grounding adapter may call this**, with values it obtained from a
 * live `GraphEngine` response in the current process. Calling it on
 * caller-supplied input defeats the invariant, which is why it takes a
 * deliberately awkward explicit witness rather than being a plain cast.
 */
export function asGraphDerived(
  grounding: WikiGrounding,
  witness: { derivedFromLiveGraph: true },
): GraphDerivedGrounding {
  if (witness.derivedFromLiveGraph !== true) {
    throw new Error("asGraphDerived requires a live-graph witness");
  }
  return grounding as GraphDerivedGrounding;
}

/**
 * Check that each proposed grounding was actually produced by the graph.
 *
 * `verify` is supplied by the grounding adapter and answers "did this exact
 * node and fingerprint come out of the current graph". A grounding that fails
 * gets `GROUNDING_UNVERIFIED` and the operation is blocked — the caller's
 * assertion is never sufficient on its own.
 */
export function verifyGroundingProvenance(
  groundings: readonly WikiGrounding[],
  verify: (grounding: WikiGrounding) => boolean,
  context: ValidationContext = { path: "groundsTo" },
): WikiDiagnostic[] {
  const diagnostics: WikiDiagnostic[] = [];
  for (let index = 0; index < groundings.length; index += 1) {
    const grounding = groundings[index]!;
    if (verify(grounding)) continue;
    diagnostics.push(
      contextDiagnostic(
        { ...context, path: `${context.path}[${index}]` },
        "GROUNDING_UNVERIFIED",
        `Grounding to ${grounding.node} could not be re-derived from the current code graph.`,
      ),
    );
  }
  return diagnostics;
}

/**
 * Normalized identity of a grounding, for deduplication.
 *
 * The node is the identity; the fingerprint is what that node looked like when
 * the entity was grounded, so re-grounding the same node updates rather than
 * appends.
 */
export function groundingIdentity(grounding: WikiGrounding): string {
  return grounding.node;
}
