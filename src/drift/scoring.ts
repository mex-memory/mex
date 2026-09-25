import type { DriftIssue, Severity } from "../types.js";

const SEVERITY_COST: Record<Severity, number> = {
  error: 10,
  warning: 3,
  info: 1,
};

/**
 * Notices: reported so a reader can see what happened, but not drift. A MOVED
 * decided by callers and callees is a correct rebind that would otherwise be
 * silent (#229); it must not cost what a real finding costs.
 */
const UNSCORED_CODES: ReadonlySet<DriftIssue["code"]> = new Set(["GROUNDING_MOVED_BY_NEIGHBORS"]);

/** Compute drift score from 0-100. Starts at 100, deducts per issue. */
export function computeScore(issues: DriftIssue[]): number {
  let score = 100;
  for (const issue of issues) {
    if (UNSCORED_CODES.has(issue.code)) continue;
    score -= SEVERITY_COST[issue.severity];
  }
  return Math.max(0, Math.min(100, score));
}
