import { z } from "zod";
import { EntrySchema, EntryIdSchema } from "../knowledge/entry.js";
import type { RecordWriter } from "../record/index.js";
import type { ReviewReader } from "./state.js";
import { hash } from "../judge/evidence.js";

export const ConflictItem = z.object({
  entry: EntrySchema,
  checkout: z.string().max(4096),
  evidence: z.array(z.union([z.string().max(512), z.number().finite()])).max(32),
  replaces: EntryIdSchema.optional(),
  conflicts: z.array(z.object({ id: EntryIdSchema, level: z.enum(["personal", "team", "hint"]), revision: z.string() }).strict()).min(1).max(10000),
}).strict();
export type StoredConflict = z.infer<typeof ConflictItem>;

const settingKey = (id: string) => `review.conflict.${id}`;
export function readConflict(reader: ReviewReader, project: string, id: string): StoredConflict | undefined {
  const raw = reader.setting(project, settingKey(id));
  if (!raw || Buffer.byteLength(raw) > 256 << 10) return undefined;
  try { return ConflictItem.parse(JSON.parse(raw)); } catch { return undefined; }
}

export function stageConflict(writer: RecordWriter, project: string, item: StoredConflict, now: Date): string {
  const { entry, checkout, conflicts, evidence, replaces } = item;
  const { created: _created, ...stable } = entry.mex;
  const id = `rv_conflict_${hash(JSON.stringify([project, checkout, stable, entry.text, evidence, replaces, conflicts])).slice(7, 39)}`;
  const raw = JSON.stringify(ConflictItem.parse(item));
  if (Buffer.byteLength(raw) > 256 << 10) throw new Error("Review data exceeds its size limit.");
  const inserted = writer.db.prepare("INSERT INTO review VALUES(?,?,?,'contradiction','pending',?) ON CONFLICT(id) DO NOTHING")
    .run(id, project, entry.mex.id, now.toISOString());
  if (inserted.changes) writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, settingKey(id), raw);
  return id;
}
