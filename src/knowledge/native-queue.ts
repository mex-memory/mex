import { openRecord } from "../record/index.js";
import { queueJob } from "../record/background.js";
import "./native-job.js";

/**
 * After entries change, ask the background process to rebuild the native
 * rule files. It runs between sessions; with `local` (the person's own notes
 * changed) their hidden local files are rewritten at once. Best effort: a
 * failure here never fails the command that changed the entry.
 */
export function queueNativeRebuild(projectPath: string, options: { local?: boolean } = {}): boolean {
  try {
    const writer = openRecord({ create: true, projectPath });
    try {
      const row = writer.checkout(projectPath);
      if (!row) return false;
      queueJob(writer, { kind: "native-files", projectId: row.project_id, params: { checkout: row.path, ...(options.local ? { local: true } : {}) } });
      return true;
    } finally { writer.close(); }
  } catch { return false; }
}
