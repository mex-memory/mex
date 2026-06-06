import type { DriftIssue, Severity } from "../types.js";

const SEVERITY_COST: Record<Severity, number> = {
  error: 10,
  warning: 3,
  info: 1,
};

/** Compute drift score from 0-100. Starts at 100, deducts per issue. */
export function computeScore(issues: DriftIssue[]): number {
  let score = 100;
  for (const issue of issues) {
    score -= SEVERITY_COST[issue.severity];
  }
  return Math.max(0, Math.min(100, score));
}
