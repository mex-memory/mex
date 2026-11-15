import { z } from "zod";
import type { RecordWriter } from "../record/index.js";
import { KnowledgeError } from "../knowledge/entry.js";
import { sourceSchema } from "./provenance.js";
import type { FilterCandidate } from "./job.js";
export const LearningMetadata = z.object({ at: z.string().max(64), holds: z.array(z.string().max(64)).max(16), sessions: z.array(z.string().max(512)).max(128), needs_checks: z.boolean().optional(),
  sources: z.array(z.object({ source: sourceSchema, quote: z.string().min(1).max(8192), label: z.enum(["lasting", "unsure"]) }).strict()).max(128).optional() }).strict();
export interface SourceRecord { source: FilterCandidate["source"]; quote: string; label: "lasting" | "unsure"; }
export function learningMetadata(writer: RecordWriter, project: string, id: string): Partial<z.infer<typeof LearningMetadata>> {
  const raw = writer.setting(project, `learning.note.${id}`);
  if (!raw) return {};
  try { if (Buffer.byteLength(raw) > 512 << 10) throw new Error(); return LearningMetadata.parse(JSON.parse(raw)); }
  catch { throw new KnowledgeError("INVALID_ENTRY", "Consolidation metadata is invalid; notes were kept."); }
}
