import { existsSync } from "node:fs";
import { openRecord } from "../record/index.js";
import { queueJob } from "../record/background.js";
import "./native-job.js";

/**
 * After entries change, ask the background process to rebuild the native
 * rule files. It runs between sessions; with `local` (the person's own notes
 * changed) their hidden local files are rewritten at once, in every checkout
 * of the project that is on, since notes belong to the project, not to one
 * worktree. Best effort: a failure here never fails the command that changed
 * the entry.
 */
export function queueNativeRebuild(projectPath: string, options: { local?: boolean } = {}): boolean {
  try {
    const writer = openRecord({ create: true, projectPath });
    try {
      const row = writer.checkout(projectPath);
      if (!row) return false;
      const checkouts = options.local
        ? [row.path, ...(writer.db.prepare("SELECT path FROM checkouts WHERE project_id=? AND state='on' AND path<>? ORDER BY path LIMIT 32").all(row.project_id, row.path) as { path: string }[])
          .map(other => other.path).filter(path => existsSync(path))]
        : [row.path];
      for (const checkout of checkouts) queueJob(writer, { kind: "native-files", projectId: row.project_id, params: { checkout, ...(options.local ? { local: true } : {}) } });
      return true;
    } finally { writer.close(); }
  } catch { return false; }
}
