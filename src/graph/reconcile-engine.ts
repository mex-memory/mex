import { HI, LO, MIN_TOKENS, W_BODY, W_NBR } from "./config.js";
import type { GroundedSource } from "./grounding.js";
import { FingerprintStore } from "./fingerprint-store.js";
import type { Fingerprint, Reconciler, Resolution } from "./reconcile.js";

export class MinHashReconciler implements Reconciler {
  constructor(private readonly store: FingerprintStore) {}

  reconcile(_missingNodeId: string, baseline: Fingerprint): Resolution {
    if (baseline.tokenCount < MIN_TOKENS) return { kind: "GONE" };
    const candidates = this.store.lookup(baseline);
    if (candidates.length === 0) return { kind: "GONE" };

    const best = candidates
      .map((candidate) => ({
        ...candidate,
        score: W_BODY * minhashJaccard(baseline.minhash, candidate.fingerprint.minhash)
          + W_NBR * neighborOverlap(baseline.neighbors, candidate.fingerprint.neighbors),
      }))
      .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId))[0];

    if (best.score >= HI) return { kind: "MOVED", nodeId: best.nodeId };
    if (best.score < LO) return { kind: "GONE" };
    return { kind: "AMBIGUOUS", candidate: best.nodeId };
  }

  getFingerprint(nodeId: string): Fingerprint | null {
    return this.store.get(nodeId);
  }

  getGroundedSource(scaffoldFile: string, nodeId: string): GroundedSource | null {
    return this.store.getGroundedSource(scaffoldFile, nodeId);
  }
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
