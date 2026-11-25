import { z } from "zod";
import type { RecordReader, RecordWriter } from "../record/index.js";
import { shortHash } from "../record/project.js";
import { assertNoSecrets, stripHidden } from "../knowledge/gates.js";
import { KnowledgeError } from "../knowledge/entry.js";
import type { Position } from "../judge/evidence.js";
import type { FilterCandidate } from "./job.js";
import { filterSession, timestampNs } from "./input.js";

export const CONTINUITY_TTL = 14 * 86400000;
const Item = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/u), session: z.string().min(1).max(512), at: z.string().datetime({ offset: true }),
  head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u), text: z.string().min(1).max(240) }).strict();
export const ContinuityItems = z.object({ version: z.literal(1), checkout: z.string().max(4096), branch: z.string().min(1).max(1024), items: z.array(Item).max(3) }).strict();
export const continuityKey = (checkout: string, branch: string) => `learning.continuity.${shortHash(checkout + "\0" + branch)}`;
export function readContinuityItems(reader: RecordReader | RecordWriter, project: string, checkout: string, branch: string) {
  const sql = "SELECT CASE WHEN length(CAST(value AS BLOB))<=16384 THEN value END value FROM settings WHERE scope=? AND key=?";
  const key = continuityKey(checkout, branch);
  const row = "location" in reader ? reader.db.prepare(sql).get(project, key) as { value: string | null } | undefined : reader.get<{ value: string | null }>(sql, project, key);
  if (!row) return undefined;
  const raw = row.value;
  try {
    if (raw === null) throw new Error();
    const value = ContinuityItems.parse(JSON.parse(raw));
    if (value.checkout !== checkout || value.branch !== branch) throw new Error();
    return value;
  } catch { throw new KnowledgeError("INVALID_STATE", "Filtered continuity is invalid; it was kept private."); }
}
/** Called in the producer's transaction. Only position-proven sources cross. */
export function stageContinuity<T extends Pick<FilterCandidate, "label" | "text" | "source">>(writer: RecordWriter, project: string, checkout: string,
  at: Position, candidates: readonly T[], now = Date.now()): Set<T> {
  const accepted = new Set<T>(), branch = at.branch?.startsWith("refs/heads/") ? at.branch.slice(11) : undefined;
  if (!branch || !at.head) return accepted;
  const existing = readContinuityItems(writer, project, checkout, branch);
  const items = new Map((existing?.items ?? []).filter(i => now - Date.parse(i.at) < CONTINUITY_TTL && Date.parse(i.at) <= now).map(i => [i.id, i]));
  for (const c of candidates) {
    if (c.label !== "next-session" || !c.source.session || c.source.marks || c.source.delivered.length || c.source.note_id) continue;
    const meta = filterSession(writer, project, checkout, c.source.session), sourceAt = timestampNs(c.source.at), since = timestampNs(meta?.position_at ?? ""), seen = timestampNs(meta?.seen_at ?? "");
    if (!meta || meta.branch !== branch || meta.head !== at.head || sourceAt === undefined || since === undefined || seen === undefined || sourceAt < since || sourceAt > seen) continue;
    if (Date.parse(c.source.at) > now || now - Date.parse(c.source.at) >= CONTINUITY_TTL) continue;
    assertNoSecrets(c);
    const text = Array.from(stripHidden(c.text).trim().replace(/\s+/gu, " ")).slice(0, 120).join("");
    if (!text) continue;
    const id = shortHash(JSON.stringify([checkout, branch, c.source.session, c.source.at, c.source.row, c.text]));
    items.set(id, { id, text, session: c.source.session, at: c.source.at, head: at.head }); accepted.add(c);
  }
  if (accepted.size || existing && items.size !== existing.items.length) {
    const value = ContinuityItems.parse({ version: 1, checkout, branch, items: [...items.values()].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).filter((item, i, all) => all.findIndex(other => other.text === item.text) === i).slice(0, 3) });
    if (value.items.length) writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(project, continuityKey(checkout, branch), JSON.stringify(value));
    else writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?").run(project, continuityKey(checkout, branch));
  }
  return accepted;
}
