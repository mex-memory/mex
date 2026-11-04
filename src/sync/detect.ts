import type { DriftStatus } from "@mex/hub-contracts";
import { runDriftCheckWithGraphStatus, type GraphAwareDriftReport } from "../drift/index.js";
import type { MexConfig } from "../types.js";
import { groupIntoTargets, selectSyncWork } from "./work.js";
import { MAX_ALERT_FILES } from "./alert-summary.js";

const MAX_LISTED_FILES = 100;

/** What `mex sync` would do with this report, decided by the filter it uses itself. */
export function summarizeDrift(report: GraphAwareDriftReport, listedFiles = MAX_LISTED_FILES): DriftStatus {
  const { issues, commentOnly, relevantIssues } = selectSyncWork(report.issues);
  const targets = groupIntoTargets(relevantIssues);
  return {
    state: relevantIssues.length > 0
      ? "needs_sync"
      : issues.length === 0 && commentOnly.length > 0
        ? "comment_review"
        : "in_sync",
    checkedAt: report.timestamp,
    issueCount: relevantIssues.length,
    fileCount: targets.length,
    files: targets.slice(0, listedFiles).map((target) => ({
      path: target.file,
      errors: target.issues.filter((i) => i.severity === "error").length,
      warnings: target.issues.filter((i) => i.severity === "warning").length,
    })),
    commentOnlyCount: commentOnly.length,
    warningOnlyCount: issues.length - relevantIssues.length,
    codeLinks: report.graphStatus.status === "fresh" ? "checked" : "partial",
  };
}

/** Read-only: the check neither refreshes the graph nor starts an agent. */
export async function detectDrift(config: MexConfig): Promise<DriftStatus> {
  return summarizeDrift(await runDriftCheckWithGraphStatus(config));
}

/** Alert decisions use complete bounded findings, independently of the Hub page. */
export async function detectDriftForAlerts(config: MexConfig): Promise<DriftStatus> {
  return summarizeDrift(await runDriftCheckWithGraphStatus(config), MAX_ALERT_FILES);
}
