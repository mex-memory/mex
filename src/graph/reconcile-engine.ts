import {
  HI,
  LO,
  MIN_TOKENS,
  MOVED_MARGIN,
  NBR_CANDIDATE_LIMIT,
  NBR_HI,
  NBR_MIN_SHARED,
  SMALL_BODY_MIN,
  SMALL_TOKEN_SLACK,
  W_BODY,
  W_NBR,
} from "./config.js";
import type { GroundedSource } from "./grounding.js";
import { FingerprintStore } from "./fingerprint-store.js";
import type { Fingerprint, Reconciler, Resolution } from "./reconcile.js";

interface Scored {
  nodeId: string;
  score: number;
}

/**
 * What decided a verdict. `neighbors` marks a MOVED that callers and callees
 * decided for a node too small for its body to tell (#229): callers surface it
 * as an info notice naming old → new, since a rebind is otherwise silent.
 */
export type ReconcileEvidence = "body" | "neighbors";

export interface ExplainedResolution {
  resolution: Resolution;
  evidence: ReconcileEvidence;
}

export class MinHashReconciler implements Reconciler {
  constructor(private readonly store: FingerprintStore) {}

  /**
   * `bodyHash` is the committed body hash of the missing node, when the caller
   * has one. It is never evidence on its own: it only picks, among candidates
   * the fingerprint already rates as equally good, the one whose text is
   * identical to the grounded text. A rename changes that text, so it settles
   * a node whose id changed for another reason, such as a path-dependent id
   * from an older extractor (#240), and never a rename.
   */
  reconcile(missingNodeId: string, baseline: Fingerprint, bodyHash?: string): Resolution {
    return this.explain(missingNodeId, baseline, bodyHash).resolution;
  }

  /** {@link reconcile}, plus the evidence that decided it. */
  explain(missingNodeId: string, baseline: Fingerprint, bodyHash?: string): ExplainedResolution {
    if (baseline.tokenCount < MIN_TOKENS) return this.reconcileSmall(missingNodeId, baseline, bodyHash);
    return { resolution: this.reconcileBody(missingNodeId, baseline, bodyHash), evidence: "body" };
  }

  private reconcileBody(missingNodeId: string, baseline: Fingerprint, bodyHash: string | undefined): Resolution {
    const candidates = this.store.lookup(baseline);
    if (candidates.length === 0) return { kind: "GONE" };

    const scored = candidates
      .map((candidate) => ({
        ...candidate,
        score: W_BODY * minhashJaccard(baseline.minhash, candidate.fingerprint.minhash)
          + W_NBR * neighborOverlap(baseline.neighbors, candidate.fingerprint.neighbors),
      }))
      .sort(byScore);
    const [best, runnerUp] = scored;

    if (best.score >= HI) {
      // A near-tie is not proof of identity: surface it rather than rebind by id order.
      if (runnerUp && best.score - runnerUp.score < MOVED_MARGIN) {
        const exact = this.identicalText(missingNodeId, nearTies(scored), bodyHash);
        return exact ? { kind: "MOVED", nodeId: exact } : { kind: "AMBIGUOUS", candidate: best.nodeId };
      }
      return { kind: "MOVED", nodeId: best.nodeId };
    }
    if (best.score < LO) return { kind: "GONE" };
    return { kind: "AMBIGUOUS", candidate: best.nodeId };
  }

  getFingerprint(nodeId: string): Fingerprint | null {
    return this.store.get(nodeId);
  }

  getGroundedSource(scaffoldFile: string, nodeId: string): GroundedSource | null {
    return this.store.getGroundedSource(scaffoldFile, nodeId);
  }

  /**
   * Below MIN_TOKENS the body sketch cannot tell one small wrapper from another,
   * so this used to be GONE outright, even for a plain rename (#229). A rename
   * keeps the callers and callees, so they are the evidence here. Candidates
   * are current nodes of the same kind sharing at least NBR_MIN_SHARED
   * neighbors; a candidate is *strong* when its neighbor Jaccard reaches
   * NBR_HI, and *compatible* when its body passes SMALL_BODY_MIN and
   * SMALL_TOKEN_SLACK.
   *
   *  - MOVED needs the best candidate strong and compatible, and no other
   *    within MOVED_MARGIN of it;
   *  - otherwise a strong or a compatible candidate is AMBIGUOUS. That covers
   *    a rename whose committed neighbors went stale as callers came and went:
   *    it cannot be told from a replacement that inherited the callers, so it
   *    names the candidate and does not rebind;
   *  - a candidate neither strong nor compatible is another function that
   *    shares callers, and none at all is GONE, as before.
   *
   * A baseline with fewer than NBR_MIN_SHARED neighbors therefore never
   * reaches MOVED. An identical-text match makes it AMBIGUOUS at most.
   */
  private reconcileSmall(
    missingNodeId: string,
    baseline: Fingerprint,
    bodyHash: string | undefined,
  ): ExplainedResolution {
    const kind = nodeKind(missingNodeId);
    const scored = this.store.neighborhood(baseline.neighbors, NBR_MIN_SHARED, NBR_CANDIDATE_LIMIT)
      .filter((nodeId) => nodeId !== missingNodeId && kind !== null && nodeKind(nodeId) === kind)
      .flatMap((nodeId) => {
        const fingerprint = this.store.get(nodeId);
        if (!fingerprint) return [];
        const neighbors = neighborOverlap(baseline.neighbors, fingerprint.neighbors);
        const body = minhashJaccard(baseline.minhash, fingerprint.minhash);
        const tokenSlack = Math.abs(fingerprint.tokenCount - baseline.tokenCount)
          / Math.max(baseline.tokenCount, 1);
        const strong = neighbors >= NBR_HI;
        const compatible = body >= SMALL_BODY_MIN && tokenSlack <= SMALL_TOKEN_SLACK;
        if (!strong && !compatible) return [];
        return [{ nodeId, strong, compatible, score: W_BODY * body + W_NBR * neighbors }];
      })
      .sort(byScore);

    const [best] = scored;
    if (!best) {
      const exact = this.identicalText(missingNodeId, this.store.lookup(baseline), bodyHash);
      return {
        resolution: exact ? { kind: "AMBIGUOUS", candidate: exact } : { kind: "GONE" },
        evidence: exact ? "body" : "neighbors",
      };
    }
    const close = nearTies(scored);
    if (close.length === 1 && best.strong && best.compatible) {
      return { resolution: { kind: "MOVED", nodeId: best.nodeId }, evidence: "neighbors" };
    }
    // An identical grounded text settles the tie by body, not by neighbors.
    const exact = this.identicalText(missingNodeId, close.filter((candidate) => candidate.strong), bodyHash);
    return exact
      ? { resolution: { kind: "MOVED", nodeId: exact }, evidence: "body" }
      : { resolution: { kind: "AMBIGUOUS", candidate: best.nodeId }, evidence: "neighbors" };
  }

  /** The one same-kind candidate whose body hash equals the committed one, when exactly one does. */
  private identicalText(
    missingNodeId: string,
    candidates: ReadonlyArray<{ nodeId: string }>,
    bodyHash: string | undefined,
  ): string | null {
    const kind = nodeKind(missingNodeId);
    if (bodyHash === undefined || kind === null) return null;
    const matches = candidates.filter((candidate) => (
      nodeKind(candidate.nodeId) === kind && this.store.bodyHash(candidate.nodeId) === bodyHash
    ));
    return matches.length === 1 ? matches[0]!.nodeId : null;
  }
}

function byScore(left: Scored, right: Scored): number {
  return right.score - left.score || left.nodeId.localeCompare(right.nodeId);
}

/** The best candidate and every other within MOVED_MARGIN of it; `scored` is sorted best first. */
function nearTies<T extends Scored>(scored: readonly T[]): T[] {
  const best = scored[0];
  return best ? scored.filter((candidate) => best.score - candidate.score < MOVED_MARGIN) : [];
}

/** The kind prefix of a node id (`function:…` is `function`), or null for an id without one. */
function nodeKind(nodeId: string): string | null {
  const separator = nodeId.indexOf(":");
  return separator > 0 ? nodeId.slice(0, separator) : null;
}

export function minhashJaccard(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let matches = 0;
  for (let index = 0; index < length; index += 1) {
    if (left[index] === right[index]) matches += 1;
  }
  return matches / length;
}

export function neighborOverlap(left: readonly string[], right: readonly string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const value of leftSet) if (rightSet.has(value)) intersection += 1;
  return intersection / union.size;
}
