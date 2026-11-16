import { openRecordReadOnly } from "../record/index.js";
import { knowledgeProject, type KnowledgeOptions } from "../knowledge/context.js";
import { reviewQueue } from "./queue.js";

import { claimDailyReview } from "./daily-receipt.js";
/** Atomic, project-wide daily claim. Never opens a writer or repairs a database. */
export function dailyReviewLine(options: KnowledgeOptions, now = Date.now()): string | undefined {
  if (process.env.MEX_OFF === "1" || process.env.MEX_BACKGROUND === "1") return undefined;
  const project = knowledgeProject(options), reader = openRecordReadOnly(options);
  if (!reader) return undefined;
  try {
    if (reader.diagnostic || reader.setting("global", "enabled") === "false") return undefined;
    const checkout = reader.get<{ state: string; off_until: string | null }>("SELECT state,off_until FROM checkouts WHERE path=? AND project_id=?", project.root, project.projectId);
    if (!checkout || checkout.state === "off" || checkout.state === "off until" && !(Date.parse(checkout.off_until ?? "") <= now)) return undefined;
  } finally { reader.close(); }
  const waiting = reviewQueue(options, now).waiting;
  if (!waiting) return undefined;
  if (!claimDailyReview(project.location.directory, project.projectId, now)) return undefined;
  return `MEX: ${Math.min(waiting, 5)} ${waiting === 1 ? "rule waits" : "rules wait"} for review. Run mex review.`;
}
