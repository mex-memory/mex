import type { DatabaseSync } from "node:sqlite";
import { publishNotes, recoverNotes, snapshotNotes } from "../knowledge/personal-store.js";
import { recoverModelBatches } from "../model-runner/budget-queue.js";
import { recordedModelSpend } from "../model-runner/consent.js";
import type { RecordWriter } from "../record/index.js";
import type { JobRow } from "../record/jobs.js";
import { trialReceiptKey, reviewRowsKey } from "./pipeline.js";
import { sourceDigest } from "./source.js";

// Separate from scratch rows, which may be purged when an interrupted job resumes.
const prefix = (id: string) => `learning.deep.effects.${id}.`;
type Effect = { name: string; before?: string; after?: string; created?: boolean };

function recordEffect(writer: RecordWriter, job: JobRow, kind: "note" | "setting", effect: Effect): void {
  if (job.kind !== "learn-deeper") return;
  const project = job.project_id!, key = prefix(job.id) + kind + "." + effect.name;
  const previous = writer.setting(project, key);
  if (previous) {
    const old = JSON.parse(previous) as Effect;
    // If somebody edited between our batches, retain that newer baseline.
    const before = kind === "note" && effect.before !== undefined ? sourceDigest(effect.before) : effect.before;
    if (before === old.after) effect.before = old.before;
    effect.created ||= old.created;
  }
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
    .run(project, key, JSON.stringify(effect));
}

export function rememberNote(writer: RecordWriter, job: JobRow, id: string, before?: string, after?: string): void {
  recordEffect(writer, job, "note", { name: id, before, after: after === undefined ? undefined : sourceDigest(after),
    created: before === undefined && after !== undefined });
}

export function rememberSetting(writer: RecordWriter, job: JobRow, name: string, after?: string): void {
  recordEffect(writer, job, "setting", { name, before: writer.setting(job.project_id!, name), after });
}

/** Observations this run added to the per-project store. */
export function rememberObservations(writer: RecordWriter, job: JobRow, ids: readonly string[]): void {
  if (job.kind !== "learn-deeper" || !ids.length) return;
  const set = writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO NOTHING");
  for (const id of ids) set.run(job.project_id, prefix(job.id) + "observation." + id, JSON.stringify({ created: true }));
}

/** Stored observations this run is about to link to a rule. Only unlinked rows change, so cancel unlinks them. */
export function rememberObservationLinks(writer: RecordWriter, job: JobRow, normId: string, ids: readonly string[]): void {
  if (job.kind !== "learn-deeper" || !ids.length) return;
  const unlinked = writer.db.prepare("SELECT 1 FROM learning_observations WHERE project_id=? AND id=? AND norm_id IS NULL AND forgotten=0");
  const set = writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO NOTHING");
  for (const id of ids) if (unlinked.get(job.project_id, id)) {
    set.run(job.project_id, prefix(job.id) + "observation." + id, JSON.stringify({ linked: normId }));
  }
}

export function clearRunEffects(db: DatabaseSync, job: JobRow): void {
  const start = prefix(job.id);
  db.prepare("DELETE FROM settings WHERE scope=? AND key>=? AND key<?").run(job.project_id, start, start.slice(0, -1) + "/");
}

export function cancelLearning(job: JobRow, writer: RecordWriter): number {
  const project = job.project_id!;
  recoverModelBatches(writer);
  const tokens = recordedModelSpend(writer, job.id);
  const start = prefix(job.id);
  const effects = writer.db.prepare("SELECT key,value FROM settings WHERE scope=? AND key>=? AND key<?")
    .all(project, start, start.slice(0, -1) + "/");
  const validate = () => {
    const live = writer.db.prepare("SELECT owner,state,request FROM jobs WHERE id=?").get(job.id);
    if (live?.owner !== job.owner || live?.state !== "running" || live?.request !== "cancel") {
      throw new Error("Learning lost its job before cleanup.");
    }
  };
  const restore = () => {
    const set = writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
    const del = writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?");
    const drop = writer.db.prepare("DELETE FROM learning_observations WHERE project_id=? AND id=?");
    const unlink = writer.db.prepare("UPDATE learning_observations SET norm_id=NULL WHERE project_id=? AND id=? AND norm_id=?");
    for (const row of effects) if (String(row.key).startsWith(start + "observation.")) {
      const id = String(row.key).slice((start + "observation.").length);
      const effect = JSON.parse(String(row.value)) as { created?: true; linked?: string };
      if (effect.created) drop.run(project, id);
      else if (effect.linked) unlink.run(project, id, effect.linked);
    }
    for (const row of effects) if (String(row.key).startsWith(start + "setting.")) {
      const effect = JSON.parse(String(row.value)) as Effect;
      if (writer.setting(project, effect.name) !== effect.after) continue;
      if (effect.before === undefined) del.run(project, effect.name);
      else set.run(project, effect.name, effect.before);
    }
    for (const name of [reviewRowsKey(job.id), reviewRowsKey(job.id) + ".overflow", trialReceiptKey(job.id)]) del.run(project, name);
    writer.db.prepare("DELETE FROM job_results WHERE job_id=?").run(job.id);
    clearRunEffects(writer.db, job);
  };
  const notes = effects.filter(row => String(row.key).startsWith(start + "note."));
  if (notes.length) {
    recoverNotes(writer, project);
    const before = snapshotNotes(writer, project);
    const files = new Map(before.files);
    for (const row of notes) {
      const effect = JSON.parse(String(row.value)) as Effect;
      if (effect.created) files.delete(effect.name);
      else if (effect.before !== undefined) {
        const current = files.get(effect.name);
        if ((current === undefined ? undefined : sourceDigest(current)) === effect.after) files.set(effect.name, effect.before);
      }
    }
    publishNotes(writer, project, before, files, restore, { validate });
  } else {
    writer.db.exec("BEGIN IMMEDIATE");
    try { validate(); restore(); writer.db.exec("COMMIT"); }
    catch (error) { writer.db.exec("ROLLBACK"); throw error; }
  }
  return tokens;
}
