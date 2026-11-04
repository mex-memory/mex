import type { DriftIssue, SyncTarget } from "../types.js";

/** Findings `sync` reports but never hands to an AI session. */
export const SYNC_NOTICE_CODES: ReadonlySet<DriftIssue["code"]> = new Set([
  "GROUNDING_MOVED_BY_NEIGHBORS",
  "GROUNDING_COMMENT_DRIFT",
  "GROUNDING_MOVED",
  "GROUNDING_NEARBY_DRIFT",
]);

export interface SyncWork {
  /** Every finding except notices. */
  issues: DriftIssue[];
  /** Bodies that changed only in comments. */
  commentOnly: DriftIssue[];
  /** The findings a sync session works on. */
  relevantIssues: DriftIssue[];
}

/** Sort a drift report's findings into what `sync` does with each. */
export function selectSyncWork(allIssues: readonly DriftIssue[], includeWarnings = false): SyncWork {
  // Notices, not repairs. A completed rebind (#229) has nothing left to do.
  // A body that changed only in comments (#236) needs a review of the new
  // body, not an AI session over prose that still describes the code.
  const commentOnly = allIssues.filter((i) => i.code === "GROUNDING_COMMENT_DRIFT");
  // A move and a change away from the fact are notices too: the link's
  // verdict is not `changed`, so nothing in the prose is in question.
  const issues = allIssues.filter((i) => !SYNC_NOTICE_CODES.has(i.code));
  const relevantIssues = includeWarnings
    ? issues
    : issues.filter((i) => {
        // Every grounding outcome is a repair path, including warning-only
        // inline GONE anchors; do not require --warnings to maintain pointers.
        if (i.code.startsWith("GROUNDING_")) return true;
        const fileHasError = issues.some(
          (other) => other.file === i.file && other.severity === "error"
        );
        return fileHasError;
      });
  return { issues, commentOnly, relevantIssues };
}

export function groupIntoTargets(issues: DriftIssue[]): SyncTarget[] {
  const byFile = new Map<string, DriftIssue[]>();
  for (const issue of issues) {
    if (!byFile.has(issue.file)) byFile.set(issue.file, []);
    byFile.get(issue.file)!.push(issue);
  }

  return Array.from(byFile.entries()).map(([file, issues]) => ({
    file,
    issues,
    gitDiff: null,
  }));
}
