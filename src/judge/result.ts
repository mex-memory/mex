import { z } from "zod";
import { EntrySchema, type KnowledgeEntry } from "../knowledge/entry.js";
import type { RecordWriter } from "../record/index.js";
import { shortHash } from "../record/project.js";
import { JUDGE_LIMITS, hash, type Position } from "./evidence.js";

export interface Judgement {
  version: 1; id: string; inputs_hash: string; checkout: string; position: Position;
  entry_hash: string; files: Array<{ path: string; hash: string | null }>;
  checks_hash: string;
  evaluation_hash?: string;
  result: "still-true" | "rewritten" | "cannot-tell";
  label: "checked by model"; model: string; at: string; rewrite?: KnowledgeEntry;
}
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const JudgementSchema = z.object({
  version: z.literal(1), id: z.string().regex(/^mx_[a-z0-9]{6,64}$/u), inputs_hash: sha, checkout: z.string().max(4096),
  position: z.object({ branch: z.string().max(1024).nullable(), head: z.string().regex(/^[a-f0-9]{40,64}$/u).nullable() }).strict(),
  entry_hash: sha, checks_hash: sha, evaluation_hash: sha.optional(), files: z.array(z.object({ path: z.string().min(1).max(512), hash: sha.nullable() }).strict()).max(JUDGE_LIMITS.files),
  result: z.enum(["still-true", "rewritten", "cannot-tell"]), label: z.literal("checked by model"),
  model: z.string().min(1).max(128), at: z.string().datetime(), rewrite: EntrySchema.optional(),
}).strict();
export const resultKey = (checkout: string, id: string) => `judge.${shortHash(checkout)}.${id}`;

/** Shared native attestation identity. Lengths and ordering are UTF-8, so no
 * JSON escaping, ambiguous separators or language-specific key order is trusted. */
export function judgementInputsHash(value: Judgement): string {
  const parts = ["model-judgement-v1", value.checkout, value.id, value.entry_hash, value.evaluation_hash ?? "", value.checks_hash,
    value.model, value.position.branch ?? "", value.position.head ?? "",
    ...[...value.files].sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path))).flatMap(f=>[f.path,f.hash ?? "missing"])];
  return hash(parts.map(s=>`${Buffer.byteLength(s)}:${s}`).join(""));
}

/** Internal result; only Go can accept its native evaluation attestation. */
export function readJudgement(writer: RecordWriter, projectId: string, checkout: string, id: string): Judgement | undefined {
  if (writer.setting(projectId, `knowledge.retired.${id}`)) return undefined;
  const raw = writer.db.prepare("SELECT CASE WHEN length(CAST(value AS BLOB))<=? THEN value ELSE NULL END value FROM settings WHERE scope=? AND key=?")
    .get(128 << 10, projectId, resultKey(checkout, id))?.value;
  if (typeof raw !== "string") return undefined;
  try { const value = JudgementSchema.parse(JSON.parse(raw)); return value.checkout === checkout && value.id === id ? value : undefined; }
  catch { return undefined; }
}
