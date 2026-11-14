import { createHash } from "node:crypto";
import { RecordReader, type RecordWriter } from "../record/index.js";
import { EntryIdSchema, KNOWLEDGE_LIMITS, KnowledgeError, validateEntry, type KnowledgeEntry } from "./entry.js";

const RETIRED = "knowledge.retired.";
export type Retirement = NonNullable<KnowledgeEntry["mex"]["retired"]>;
export interface Tombstone { id: string; retired: Retirement; claim_hash: string; }

/** Bounded local metadata reads, including when a corrupt row has a huge value. */
export function localSettings(reader: RecordReader | RecordWriter, scope: string, prefix: string, maxValueBytes = 32768): Array<{ key: string; value: string }> {
  const result: Array<{ key: string; value: string }> = [];
  let after = "", bytes = 0;
  while (true) {
    const sql = "SELECT CASE WHEN length(key)<=256 THEN key ELSE NULL END key,CASE WHEN length(CAST(value AS BLOB))<=? THEN value ELSE NULL END value FROM settings WHERE scope=? AND key LIKE ? AND key>? ORDER BY key LIMIT 64";
    const page = reader instanceof RecordReader ? reader.all<{ key: string | null; value: string | null }>(sql, maxValueBytes, scope, `${prefix}%`, after)
      : reader.db.prepare(sql).all(maxValueBytes, scope, `${prefix}%`, after) as Array<{ key: string | null; value: string | null }>;
    for (const row of page) {
      if (result.length >= KNOWLEDGE_LIMITS.entries || row.key === null || row.value === null) throw new KnowledgeError("STORE_LIMIT", "Local knowledge state exceeds its scan limit.");
      bytes += Buffer.byteLength(row.value);
      if (bytes > KNOWLEDGE_LIMITS.scanBytes) throw new KnowledgeError("STORE_LIMIT", "Local knowledge state exceeds its byte limit.");
      result.push({ key: row.key, value: row.value });
    }
    if (page.length < 64) return result;
    after = result.at(-1)!.key;
  }
}

export function retiredClaimHashes(reader: RecordReader | RecordWriter, projectId: string): Set<string> {
  return new Set(localSettings(reader, projectId, RETIRED, 8192).map(row => {
    try {
      const marker = JSON.parse(row.value) as Tombstone;
      if (row.key !== RETIRED + marker.id || !EntryIdSchema.safeParse(marker.id).success || !/^sha256:[a-f0-9]{64}$/u.test(marker.claim_hash)) throw new Error("Invalid tombstone");
      return marker.claim_hash;
    } catch { throw new KnowledgeError("INVALID_STATE", "A retirement record is invalid."); }
  }));
}

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
  return saveHashedTombstone(writer, projectId, { id: entry.mex.id, retired, claim_hash: claimHash(entry.text) });
}
/** Hint expiry can finish even if the disposable hint copy is already missing. */
export function saveHashedTombstone(writer: RecordWriter, projectId: string, marker: Tombstone): Tombstone {
  if (!EntryIdSchema.safeParse(marker.id).success || !/^sha256:[a-f0-9]{64}$/u.test(marker.claim_hash)
    || !marker.retired.reason.trim() || marker.retired.reason.length > 2048 || !marker.retired.by.trim()
    || !/^\d{4}-\d{2}-\d{2}$/u.test(marker.retired.at)) throw new KnowledgeError("INVALID_STATE", "Invalid retirement metadata.");
  writer.db.prepare("INSERT OR IGNORE INTO settings(scope,key,value) VALUES(?,?,?)")
    .run(projectId, RETIRED + marker.id, JSON.stringify(marker));
  return tombstone(writer, projectId, marker.id)!;
}
