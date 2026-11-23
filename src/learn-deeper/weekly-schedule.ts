import { randomBytes } from "node:crypto";
import { lstatSync, opendirSync, renameSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { automaticWorkEnabled, checkoutOn } from "../controls/index.js";
import { containedDirectory } from "../knowledge/files.js";
import { openHooksReadOnly, type RecordWriter } from "../record/index.js";
import type { EnqueueOptions, EnqueueResult } from "../record/jobs.js";
import { LEARN_KIND, Plan, type LearningPlan } from "./plan.js";
import { NETWORK_KIND, networkProofPrefix } from "./network-proof.js";

export const WEEKLY_KIND = "learn-deeper-weekly";
const SCHEDULE = "learning.deep.weekly";
const WAKE = "learning-refresh-due";
export const DAY_MS = 86_400_000;
const SESSION_IDLE_MS = 10 * 60_000;

export const WeeklySchedule = Plan.pick({ checkout: true, origin: true, source: true, visibility: true, agent: true, setup: true,
  preferred: true, head: true, since: true }).extend({ due: z.number().int().positive().max(8.64e15) }).strict();
export type WeeklySchedule = z.infer<typeof WeeklySchedule>;

export function nextWeeklyAt(now: number, random = Math.random): number {
  return Math.floor(now + (7 + 7 * random()) * DAY_MS);
}

export function weeklySchedule(writer: RecordWriter, project: string): string | undefined {
  return writer.setting(project, SCHEDULE);
}

/** Called in the same local transaction as a completed backfill or refresh receipt. */
export function saveWeeklySchedule(writer: RecordWriter, project: string, schedule: WeeklySchedule): void {
  writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
    .run(project, SCHEDULE, JSON.stringify(WeeklySchedule.parse(schedule)));
}

export function scheduleFromPlan(plan: LearningPlan, due: number): WeeklySchedule {
  const { checkout, origin, source, visibility, agent, setup, preferred, head } = plan;
  return { checkout, origin, source, visibility, agent, setup, preferred, head, since: plan.until, due };
}

export function sessionsActive(writer: RecordWriter, now: number): boolean {
  if (writer.setting("global", "learning.weekly.waitForIdle") === "false") return false;
  let hooks;
  try {
    hooks = openHooksReadOnly({ home: writer.location.home });
    const since = now - SESSION_IDLE_MS;
    if (hooks?.diagnostic || hooks?.get("SELECT 1 FROM sessions WHERE last_seen_at>=? LIMIT 1", new Date(since).toISOString())) return true;
    const root = containedDirectory(writer.location.home, ["heartbeats"]);
    if (!root) return false;
    // Hooks touch heartbeat files even when they cannot write hooks.db.
    let visited = 0;
    const agents = opendirSync(root);
    try {
      for (let agent; (agent = agents.readSync());) {
        if (++visited > 2048) return true;
        if (!agent.isDirectory()) continue;
        const directory = containedDirectory(root, [agent.name]);
        if (!directory) continue;
        const files = opendirSync(directory);
        try {
          for (let file; (file = files.readSync());) {
            if (++visited > 2048) return true;
            if (file.isFile() && lstatSync(join(directory, file.name)).mtimeMs >= since) return true;
          }
        } finally { files.closeSync(); }
      }
    } finally { agents.closeSync(); }
    return false;
  } catch { return true; }
  finally { hooks?.close(); }
}

function dueRows(writer: RecordWriter, until: number): Array<{ scope: string; value: string; due: number }> {
  return writer.db.prepare(`SELECT scope,value,json_extract(value,'$.due') due FROM settings
    WHERE key=? AND CASE WHEN json_valid(value) THEN json_type(value,'$.due')='integer' AND due BETWEEN 1 AND ? ELSE 0 END ORDER BY due LIMIT 32`)
    .all(SCHEDULE, until) as unknown as Array<{ scope: string; value: string; due: number }>;
}

/** DB is authoritative. This tiny timestamp only lets the on-demand hooks wake an idle daemon. */
export function weeklyWakeDue(home: string, now = Date.now()): boolean {
  try { const info = lstatSync(join(home, WAKE)); return info.isFile() && info.size === 0 && info.mtimeMs <= now; }
  catch { return false; }
}

export function publishWeeklyWake(writer: RecordWriter, earliest = 0): void {
  const path = join(writer.location.home, WAKE);
  const due = dueRows(writer, 8.64e15)[0]?.due;
  if (!due) { try { unlinkSync(path); } catch { /* no mirror yet */ } return; }
  const wakeAt = Math.max(earliest, due);
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    try { const info = lstatSync(path); if (info.isFile() && info.size === 0 && Math.abs(info.mtimeMs - wakeAt) <= 1) return; }
    catch { /* missing mirror */ }
    writeFileSync(temporary, "", { flag: "wx", mode: 0o600 });
    utimesSync(temporary, wakeAt / 1000, wakeAt / 1000);
    renameSync(temporary, path);
  } catch { /* the next worker pass can repair an absent mirror */ }
  finally { try { unlinkSync(temporary); } catch { /* published or never created */ } }
}

/** This only queues local DB work. Forge access and model admission belong to the job. */
export function queueDueWeekly(writer: RecordWriter, queue: (writer: RecordWriter, options: EnqueueOptions) => EnqueueResult, now = Date.now()): void {
  for (const row of dueRows(writer, now)) {
    let parsed;
    try { parsed = WeeklySchedule.safeParse(JSON.parse(row.value)); } catch { continue; }
    if (!parsed.success) continue;
    const checkout = writer.checkout(parsed.data.checkout);
    if (checkout?.path !== parsed.data.checkout || checkout.project_id !== row.scope || !checkoutOn(checkout, now)
      || !automaticWorkEnabled(writer, row.scope, now)) continue;
    const networkDue = "learning.deep.network.queued";
    if (parsed.data.origin.host === "github.com" && writer.setting(row.scope, networkDue) !== String(row.due)
      && writer.db.prepare("SELECT 1 FROM settings WHERE scope=? AND key GLOB ? LIMIT 1").get(row.scope, `${networkProofPrefix}*`)
      && weeklySchedule(writer, row.scope) === row.value) {
      queue(writer, { kind: NETWORK_KIND, projectId: row.scope, params: parsed.data });
      writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
        .run(row.scope, networkDue, String(row.due));
    }
    if (writer.db.prepare("SELECT 1 FROM jobs WHERE project_id=? AND kind IN (?,?) AND state NOT IN ('done','done with gaps','failed','cancelled') LIMIT 1")
      .get(row.scope, LEARN_KIND, WEEKLY_KIND)) continue;
    // If a worker finished between the scan and enqueue, let the new schedule win.
    if (weeklySchedule(writer, row.scope) === row.value) queue(writer, { kind: WEEKLY_KIND, projectId: row.scope, params: parsed.data });
  }
  // A disabled checkout or an existing job already owns the immediate wake.
  // Reconsider due rows on ordinary worker polls without constantly spawning it.
  publishWeeklyWake(writer, now + 10 * 60_000);
}
