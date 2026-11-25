import { queueJob } from "../record/background.js";
import type { RecordWriter } from "../record/index.js";
import type { BeforeJobInsert } from "../record/jobs.js";
import { LEARN_KIND, type LearningPlan } from "./plan.js";

/** Enqueue the approved plan through the same record job service in both surfaces. */
export function queueLearning(writer: RecordWriter, projectId: string, plan: LearningPlan, beforeInsert?: BeforeJobInsert) {
  return queueJob(writer, { kind: LEARN_KIND, projectId, params: plan, tokensEstimate: plan.estimate }, beforeInsert);
}
