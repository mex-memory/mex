import type { DatabaseSync } from "node:sqlite";
import { Observation } from "./triage.js";

const MAX_ROWS = 10_000;
const DEFAULT_DAYS = 730;
const DAY = 86_400_000;

export interface StoredObservation extends Observation { normId?: string; forgotten: boolean }

export function readObservations(db: DatabaseSync, project: string, after: string, unbackedOnly = false): StoredObservation[] {
  const rows = db.prepare(`SELECT payload,norm_id,forgotten FROM learning_observations
    WHERE project_id=? AND at>=? AND (?=0 OR (norm_id IS NULL AND forgotten=0))
    ORDER BY at DESC,id LIMIT ?`).all(project, after, Number(unbackedOnly), MAX_ROWS);
  return rows.reverse().flatMap(row => {
    try {
      const parsed = Observation.safeParse(JSON.parse(String(row.payload)));
      return parsed.success ? [{ ...parsed.data, normId: typeof row.norm_id === "string" ? row.norm_id : undefined,
        forgotten: row.forgotten === 1 }] : [];
    } catch { return []; }
  });
}

export function observationCutoff(now: number, setting?: string | null): string {
  const days = Number(setting);
  return new Date(now - (Number.isInteger(days) && days >= 1 && days <= DEFAULT_DAYS ? days : DEFAULT_DAYS) * DAY).toISOString();
}

/** The caller holds the publication or job writer transaction. A replay cannot restore a forgotten observation. */
/** Returns the ids this call added, so a cancelled run can take them back out. */
export function saveObservations(db: DatabaseSync, project: string, observations: readonly Observation[], cutoff: string): string[] {
  const insert = db.prepare(`INSERT INTO learning_observations(project_id,id,at,payload)
    VALUES(?,?,?,?) ON CONFLICT(project_id,id) DO NOTHING`);
  const added: string[] = [];
  for (const observation of observations) if (observation.at >= cutoff) {
    if (insert.run(project, observation.id, observation.at, JSON.stringify(observation)).changes) added.push(observation.id);
  }
  db.prepare(`DELETE FROM learning_observations WHERE project_id=? AND (at<? OR id IN (
    SELECT id FROM learning_observations WHERE project_id=? ORDER BY at DESC,id LIMIT -1 OFFSET ?
  ))`).run(project, cutoff, project, MAX_ROWS);
  return added;
}

export function supportObservations(db: DatabaseSync, project: string, normId: string, ids: readonly string[]): void {
  const update = db.prepare(`UPDATE learning_observations SET norm_id=?
    WHERE project_id=? AND id=? AND forgotten=0 AND (norm_id IS NULL OR norm_id=?)`);
  for (const id of ids) update.run(normId, project, id, normId);
}

export function forgetObservations(db: DatabaseSync, project: string, normId: string): void {
  db.prepare("UPDATE learning_observations SET forgotten=1 WHERE project_id=? AND norm_id=?").run(project, normId);
}

export function clearObservations(db: DatabaseSync, project?: string): void {
  if (project === undefined) db.prepare("DELETE FROM learning_observations").run();
  else db.prepare("DELETE FROM learning_observations WHERE project_id=?").run(project);
}
