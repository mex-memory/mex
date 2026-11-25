import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { EntryIdSchema } from "../knowledge/entry.js";
import { localSettings } from "../knowledge/state.js";
import type { RecordWriter } from "../record/index.js";
import type { NoteInput } from "./input.js";

export const NOTE_ATTEMPT_LIMIT = 3;
const PREFIX = "filter.note-retry.";
const NoteAttempt = z.object({ hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  failures: z.number().int().min(0).max(NOTE_ATTEMPT_LIMIT), cycle: z.string().uuid().optional() }).strict();
export type NoteAttempt = z.infer<typeof NoteAttempt>;

function decode(value: string): NoteAttempt {
  try { if (Buffer.byteLength(value) <= 256) return NoteAttempt.parse(JSON.parse(value)); }
  catch { /* Report a fixed error without exposing stored data. */ }
  throw new Error("The filter's note retry state is invalid.");
}

export function noteAttempt(writer: RecordWriter, project: string, id: string, hash: string): NoteAttempt | undefined {
  const raw = writer.setting(project, PREFIX + id);
  const attempt = raw === undefined ? undefined : decode(raw);
  return attempt?.hash === hash ? attempt : undefined;
}

/** Called in the batch completion transaction, alongside journal acknowledgements. */
export function settleNoteAttempts(writer: RecordWriter, project: string, notes: readonly NoteInput[], accepted: ReadonlySet<string>): void {
  const put = writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
  const clear = writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?");
  for (const note of notes) {
    if (!isDeepStrictEqual(noteAttempt(writer, project, note.id, note.hash), note.attempt)) throw new Error("Note retry state changed; the batch will be checked again.");
    if (accepted.has(note.id)) {
      put.run(project, `filter.note.${note.id}`, note.hash);
      clear.run(project, PREFIX + note.id);
    } else {
      put.run(project, PREFIX + note.id, JSON.stringify({ ...note.attempt, hash: note.hash, failures: (note.attempt?.failures ?? 0) + 1 }));
    }
  }
}

/** An explicit sync releases exhausted attempts and gives them a fresh cache identity. */
export function releaseNoteAttempts(writer: RecordWriter, project: string): number {
  const held = localSettings(writer, project, PREFIX, 256).flatMap(row => {
    if (!EntryIdSchema.safeParse(row.key.slice(PREFIX.length)).success) return [];
    const attempt = decode(row.value);
    return attempt.failures === NOTE_ATTEMPT_LIMIT || attempt.failures === 0 ? [{ ...row, attempt }] : [];
  });
  if (!held.length) return 0;
  const cycle = randomUUID();
  const update = writer.db.prepare("UPDATE settings SET value=? WHERE scope=? AND key=? AND value=?");
  writer.db.exec("BEGIN IMMEDIATE");
  try {
    let ready = 0;
    for (const row of held) {
      // A prior sync can have released an attempt before its background job was queued.
      if (row.attempt.failures === 0) {
        if (writer.setting(project, row.key) === row.value) ready++;
      } else {
        ready += Number(update.run(JSON.stringify({ ...row.attempt, failures: 0, cycle }), project, row.key, row.value).changes);
      }
    }
    writer.db.exec("COMMIT");
    return ready;
  } catch (error) { writer.db.exec("ROLLBACK"); throw error; }
}
