import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const pendingKey = "learning.deep.cleanup";
const changed = new WeakSet<DatabaseSync>();

export const learningRunPrefix = (jobId: string) => `learning.deep.v2.${jobId}.`;

/** Keep the deletion and checkpoint intent in the same transaction. */
export function clearLearningRows(db: DatabaseSync, project: string, jobId: string): boolean {
  const prefix = learningRunPrefix(jobId);
  // The final '.' sorts immediately before '/', letting the primary key bound the delete.
  const deleted = db.prepare("DELETE FROM settings WHERE scope=? AND key>=? AND key<?")
    .run(project, prefix, prefix.slice(0, -1) + "/");
  if (!deleted.changes) return false;
  db.prepare("INSERT INTO settings VALUES('global',?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
    .run(pendingKey, randomUUID());
  changed.add(db);
  return true;
}

/** Run outside the write transaction. A reader holding an old snapshot can delay truncation. */
export function checkpointLearningRows(db: DatabaseSync, retry = false): void {
  if (!changed.delete(db) && !retry) return;
  try {
    const pending = db.prepare("SELECT value FROM settings WHERE scope='global' AND key=?").get(pendingKey)?.value;
    if (pending === undefined) return;
    const timeout = Number(db.prepare("PRAGMA busy_timeout").get()!.timeout);
    db.exec("PRAGMA busy_timeout=0");
    try {
      if (db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy === 0) {
        // Another writer may have scheduled a newer deletion after the checkpoint.
        db.prepare("DELETE FROM settings WHERE scope='global' AND key=? AND value=?").run(pendingKey, pending);
      }
    } finally { db.exec(`PRAGMA busy_timeout=${timeout}`); }
  } catch { /* A later background pass retries the durable intent. */ }
}
