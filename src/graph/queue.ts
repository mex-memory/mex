import { queueJob } from "../record/background.js";
import type { RecordWriter } from "../record/index.js";
import type { GraphJobParams } from "./jobs.js";

/**
 * Queue the code map for the background process: setup calls this right after
 * the file index. Returns the job, or the one already open for the project.
 */
export function queueGraphBuild(writer: RecordWriter, projectId: string, checkout: string): string {
  return queueJob(writer, { kind: "graph-build", projectId, params: { checkout } satisfies GraphJobParams }).job.id;
}
