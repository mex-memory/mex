import { z } from "zod";
import { EntryIdSchema, isLearnedEntry, KnowledgeError, type KnowledgeEntry } from "./entry.js";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { recordVerified } from "./gate.js";
import { openHooksReadOnly, openRecord, type RecordWriter } from "../record/index.js";
import { shortHash } from "../record/project.js";
import { isAgentCaller } from "../repo-start/caller.js";
import { expand } from "./store.js";

const DAY = 86_400_000;
export const UNANCHORED_MAX_MS = 90 * DAY;
const noiseKey = (id: string) => `learning.noise.${id}`;
const restoredKey = (id: string) => `learning.noise.restored.${id}`;
export const UpkeepReview = z.object({ version: z.literal(1), status: z.literal("proposed"), kind: z.enum(["report", "noise", "age"]),
  checkout: z.string().max(4096), id: EntryIdSchema, path: z.string().max(4096), level: z.enum(["personal", "team"]),
  entryHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }).strict();
type Upkeep = z.infer<typeof UpkeepReview>;
export const upkeepPrefix = "learning.upkeep.";
const reviewPrefix = (kind: Upkeep["kind"], id: string) => `${upkeepPrefix}${kind}.${id}.`;
const set = (writer: RecordWriter, project: string, key: string, value: string) => writer.db.prepare(
  "INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(project, key, value);

export function stageUpkeep(writer: RecordWriter, project: string, data: Omit<Upkeep, "version" | "status">,
  reason: string, identity: string, at: number): void {
  const id = reviewPrefix(data.kind, data.id) + shortHash(`${data.checkout}\n${identity}`);
  writer.db.prepare("UPDATE review SET state='dismissed' WHERE project_id=? AND id GLOB ? AND id<>? AND state='pending' AND id IN (SELECT key FROM settings WHERE scope=? AND json_valid(value) AND json_extract(value,'$.checkout')=?)")
    .run(project, `${reviewPrefix(data.kind, data.id)}*`, id, project, data.checkout);
  writer.db.prepare("INSERT OR IGNORE INTO review(id,project_id,entry_id,reason,state,created_at) VALUES(?,?,?,?,'pending',?)")
    .run(id, project, data.id, reason, new Date(at).toISOString());
  set(writer, project, id, JSON.stringify(UpkeepReview.parse({ ...data, version: 1, status: "proposed" })));
}

function dismiss(writer: RecordWriter, project: string, kind: Upkeep["kind"], id: string): void {
  writer.db.prepare("UPDATE review SET state='dismissed' WHERE project_id=? AND id GLOB ? AND state='pending'").run(project, `${reviewPrefix(kind, id)}*`);
}

export function upkeepAction(action: "restore" | "verify", id: string, options: KnowledgeOptions, at = Date.now()): void {
  if (isAgentCaller(options.env)) throw new KnowledgeError("INVALID_OPTION", "A person must make this Review decision.");
  const project = knowledgeProject(options);
  const { entry } = expand(id, options);
  if (!isLearnedEntry(entry.mex)) throw new KnowledgeError("INVALID_OPTION", "This is not a learned rule.");
  const writer = openRecord(options);
  try {
    writer.db.exec("BEGIN IMMEDIATE");
    if (action === "restore") {
      if (writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?").run(project.projectId, noiseKey(id)).changes === 0) {
        throw new KnowledgeError("NOT_FOUND", "This rule's speed bump is already on.");
      }
      set(writer, project.projectId, restoredKey(id), new Date(at).toISOString());
      dismiss(writer, project.projectId, "noise", id);
    } else {
      recordVerified(writer, project.projectId, id, "person", new Date(at));
      dismiss(writer, project.projectId, "age", id);
    }
    writer.db.exec("COMMIT");
  } catch (error) { writer.db.exec("ROLLBACK"); throw error; }
  finally { writer.close(); }
}

export function unanchored(entry: KnowledgeEntry): boolean {
  return !entry.mex.checks.some(check => {
    switch (check.kind) {
      case "fixture": case "pattern": case "symbol": case "quote": case "until": case "key": case "value": case "command": case "section": case "relation": return true;
      case "source": return "file" in check.target;
      case "scope": return check.target.glob !== "**";
      default: return false;
    }
  });
}

interface Stop { entry_id: string; ts: string; ignored: number; }

export function noiseStops(home: string, project: string): Stop[] {
  const hooks = openHooksReadOnly({ home });
  try {
    if (!hooks || hooks.diagnostic) return [];
    const rows = hooks.all<Stop>(`SELECT d.entry_id,d.ts,CASE WHEN
      EXISTS(SELECT 1 FROM followups f WHERE f.delivery_id=d.id AND f.kind='wrong') OR
      EXISTS(SELECT 1 FROM deliveries c WHERE c.session_id=d.session_id AND c.agent_id=d.agent_id AND c.epoch=d.epoch AND c.entry_id=d.entry_id
        AND c.project_id=d.project_id AND c.checkout=d.checkout AND c.moment='bump' AND c.action='control' AND c.detail='override' AND c.rowid>d.rowid)
      THEN 1 ELSE 0 END AS ignored FROM deliveries d WHERE d.project_id=? AND d.moment='bump' AND d.action='given' LIMIT 100001`, project);
    return rows.length <= 100_000 ? rows : [];
  } catch { return []; }
  finally { hooks?.close(); }
}

export function upkeepScan(writer: RecordWriter, project: string, checkout: string,
  items: Array<{ id: string; entry_hash: string; path: string; level: "team" | "personal"; entry: KnowledgeEntry }>, at = Date.now()): void {
  const candidates = items.filter(item => isLearnedEntry(item.entry.mex) && !writer.setting(project, `knowledge.retired.${item.id}`));
  if (!candidates.length) return;
  const restores = new Map(candidates.map(({ id }) => [id, Date.parse(writer.setting(project, restoredKey(id)) ?? "") || 0]));
  const counts = new Map<string, { stops: number; ignored: number }>();
  for (const row of noiseStops(writer.location.home, project)) {
    const restored = restores.get(row.entry_id);
    if (restored === undefined || Date.parse(row.ts) <= restored) continue;
    const count = counts.get(row.entry_id) ?? { stops: 0, ignored: 0 };
    count.stops++;
    count.ignored += row.ignored;
    counts.set(row.entry_id, count);
  }
  for (const { entry, id, path, level, entry_hash: entryHash } of candidates) {
    const target = { checkout, id, path, level, entryHash };
    const count = counts.get(id);
    if (count && count.stops >= 20 && count.ignored * 10 > count.stops && !writer.setting(project, noiseKey(id))) {
      const when = entry.mex.when?.some(trigger => trigger.type === "anti" || trigger.type === "rejected");
      if (when) {
        const time = new Date(at).toISOString();
        set(writer, project, noiseKey(id), JSON.stringify({ ...count, at: time }));
        stageUpkeep(writer, project, { ...target, kind: "noise" }, `The speed bump was ignored or reported wrong on ${count.ignored} of ${count.stops} stops.`, time, at);
      }
    }
    if (!unanchored(entry)) { dismiss(writer, project, "age", id); continue; }
    const created = Date.parse(entry.mex.created);
    let verified = created;
    try {
      // Honor recorded follows. Delivery of a prose rule cannot prove it was followed.
      const row = JSON.parse(writer.setting(project, `knowledge.verified.${id}`) ?? "null");
      if (row?.how === "person" || row?.how === "judge" || row?.how === "followed") {
        verified = Math.max(created, Date.parse(row.at) || 0);
      }
    } catch { /* Creation is the baseline for older entries. */ }
    if (at - verified < UNANCHORED_MAX_MS) { dismiss(writer, project, "age", id); continue; }
    stageUpkeep(writer, project, { ...target, kind: "age" }, "This rule has gone 90 days without verification.", `${entryHash}\n${verified}`, at);
  }
}
