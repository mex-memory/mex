import { openRecordReadOnly } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";
import { claimHash } from "../../knowledge/state.js";
import { groupId, storedItems } from "../../review/state.js";
import { boundedSetting, readStore } from "./read.js";

export type ReviewOutcome = "Kept" | "Shared" | "Used" | null;

/** Undefined means the retained rows don't establish that this card was handled. */
export function reviewOutcome(location: LocationOptions, repoId: string, cardId: string): ReviewOutcome | undefined {
  return readStore(openRecordReadOnly, location, (reader) => {
    if (!reader?.project(repoId)) return undefined;
    if (cardId.startsWith("rv_conflict_")) {
      const row = reader.get<{ state: string }>(
        "SELECT state FROM review WHERE project_id=? AND id=? AND reason='contradiction'", repoId, cardId,
      );
      return row?.state === "accepted" ? "Used" : row?.state === "dismissed" ? null : undefined;
    }
    // Normal card IDs are derived from grouped claims, not primary keys.
    const ids: string[] = [];
    let keepKey: string | undefined;
    for (const [id, item] of storedItems(reader, repoId)) {
      if (groupId(repoId, item.entry) !== cardId) continue;
      ids.push(id);
      keepKey ??= "review.keep." + claimHash(item.entry.text).slice(7);
    }
    if (!ids.length) return undefined;
    const rows = reader.all<{ state: string; superseded: number }>(`
      SELECT state, instr(reason, '(superseded by new free evidence)') AS superseded
      FROM review WHERE project_id=? AND id IN (SELECT value FROM json_each(?))`, repoId, JSON.stringify(ids));
    if (rows.length !== ids.length || rows.some(({ state }) => state === "pending")) return undefined;
    if (rows.every(({ state }) => state === "accepted")) return "Shared";
    // Edit and producer supersession also dismiss rows. The claim-level marker
    // is the evidence for Keep; mixed or otherwise ambiguous results stay unknown.
    if (rows.every(({ state, superseded }) => state === "dismissed" && !superseded)
      && boundedSetting(reader, repoId, keepKey!, 128) === '{"version":1}') return "Kept";
    return null;
  });
}
