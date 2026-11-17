import { openRecord } from "../record/index.js";
import { queueJob } from "../record/background.js";
import "./native-job.js";

/**
 * After entries change, ask the background process to rebuild the native
 * rule files. It runs between sessions. Best effort: a failure here never
 * fails the command that changed the entry.
 */
export function queueNativeRebuild(projectPath: string): boolean {
  try {
    const writer = openRecord({ create: true, projectPath });
    try {
      const row = writer.checkout(projectPath);
      if (!row) return false;
      queueJob(writer, { kind: "native-files", projectId: row.project_id, params: { checkout: row.path } });
      return true;
    } finally { writer.close(); }
  } catch { return false; }
}
