import type { MachineReviewCard } from "@mex/hub-contracts/machine";
import { hash } from "../../judge/evidence.js";
import { serializeEntry } from "../../knowledge/entry.js";
import { stripHidden } from "../../knowledge/gates.js";
import type { RecordReader } from "../../record/index.js";
import type { StoredConflict } from "../../review/conflicts.js";
import { readKnowledgeEntry, type KnowledgeTarget } from "./knowledge-detail.js";
import { knowledgeKey } from "./read.js";

type CurrentNote = NonNullable<MachineReviewCard["contradiction"]>["current"][number];
type ConflictNote = StoredConflict["conflicts"][number];
export const MAX_CONFLICT_NOTES = 128;
export const CONFLICT_CHANGED = "A current note changed or couldn’t be read. Open Review again before using this proposal.";

export function reviewNote(reader: RecordReader, target: KnowledgeTarget, id: string, audience: CurrentNote["audience"], now: number) {
  const ref = { key: knowledgeKey(target.repoId, audience, id), audience };
  try {
    const point = readKnowledgeEntry(reader, target, { repoId: target.repoId, id, audience }, now);
    if (point.entry.mex.status === "active") return {
      note: { ...ref, claim: stripHidden(point.entry.mex.one_line).trim() || "Current note" },
      revision: hash(serializeEntry(point.entry)),
    };
  } catch { /* Keep missing or unsafe content out of the response. */ }
  return { note: { ...ref, claim: "Current note unavailable" }, revision: undefined };
}

export function conflictNote(reader: RecordReader, target: KnowledgeTarget, { id, level, revision }: ConflictNote, now: number) {
  const found = reviewNote(reader, target, id, level === "personal" ? "onlyYou" : level, now);
  return { note: found.note, matches: found.revision === revision };
}
