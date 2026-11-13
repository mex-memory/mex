import { createHash } from "node:crypto";
import type { RecordReader, RecordWriter } from "../record/index.js";
import { EntryIdSchema, KNOWLEDGE_LIMITS, KnowledgeError, validateEntry, type KnowledgeEntry } from "./entry.js";

const RETIRED = "knowledge.retired.";
export type Retirement = NonNullable<KnowledgeEntry["mex"]["retired"]>;
export interface Tombstone { id: string; retired: Retirement; claim_hash: string; }

/** Local suppression survives restored entry files and follows project-ID promotion. */
export function retiredIds(reader: RecordReader | undefined, projectId: string): Set<string> {
  if (!reader) return new Set();
  const rows = reader.all<{ key: string }>(
    "SELECT key FROM settings WHERE scope=? AND key LIKE 'knowledge.retired.%' ORDER BY key LIMIT ?",
    projectId, KNOWLEDGE_LIMITS.entries + 1,
  );
  if (rows.length > KNOWLEDGE_LIMITS.entries) throw new KnowledgeError("STORE_LIMIT", "Knowledge tombstones exceed the scan limit.");
  return new Set(rows.map(row => row.key.slice(RETIRED.length)));
}

export function claimHash(text: string): string {
  return `sha256:${createHash("sha256").update(text.normalize("NFKC").trim().replace(/\s+/gu, " ")).digest("hex")}`;
}

export function tombstone(writer: RecordWriter, projectId: string, id: string): Tombstone | undefined {
  const value = writer.setting(projectId, RETIRED + id);
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value) as Tombstone;
    if (parsed.id !== id || !/^sha256:[a-f0-9]{64}$/u.test(parsed.claim_hash)
      || !parsed.retired || typeof parsed.retired.reason !== "string" || typeof parsed.retired.by !== "string"
      || !/^\d{4}-\d{2}-\d{2}$/u.test(parsed.retired.at)) throw new Error("Invalid tombstone");
    return parsed;
  } catch { throw new KnowledgeError("INVALID_STATE", "The entry's local retirement record is invalid; it remains hidden."); }
}

/** Must be called in the writer's transaction. There is no resurrection operation. */
export function saveTombstone(writer: RecordWriter, projectId: string, entry: KnowledgeEntry, retired: Retirement): Tombstone {
  if (!EntryIdSchema.safeParse(entry.mex.id).success) throw new KnowledgeError("INVALID_ID", "Invalid entry id.");
  validateEntry({ ...entry, mex: { ...entry.mex, status: "retired", retired } });
  const marker: Tombstone = { id: entry.mex.id, retired, claim_hash: claimHash(entry.text) };
  writer.db.prepare("INSERT OR IGNORE INTO settings(scope,key,value) VALUES(?,?,?)")
    .run(projectId, RETIRED + entry.mex.id, JSON.stringify(marker));
  return tombstone(writer, projectId, entry.mex.id)!;
}
