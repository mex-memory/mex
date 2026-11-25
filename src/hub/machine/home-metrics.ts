import type { MachineHome } from "@mex/hub-contracts/machine";
import { readModelUse } from "../../model-runner/model-use.js";
import { openHooksReadOnly, openRecordReadOnly, type RecordReader } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";
import { readStore } from "./read.js";

const DAY_MS = 86_400_000;
const PROJECT_LIMIT = 1_000;
const ACTIVITY_SCAN_LIMIT = 500_000;
const ACTIVITY_BUCKET_LIMIT = 40_000;
const SESSION_RECEIPT_LIMIT = 250_000;

type Activity = MachineHome["activity"][number];
type Counts = Pick<Activity, "gave" | "heldBack" | "replaced">;
type Session = MachineHome["sessions"][number];
type HomeMetrics = Pick<MachineHome, "activity" | "agents" | "week" | "byRepo" | "sessions">;

export function registeredProjectIds(reader: RecordReader | undefined): string[] {
  const rows = reader?.all<{ id: string }>("SELECT id FROM projects ORDER BY id LIMIT ?", PROJECT_LIMIT + 1) ?? [];
  if (rows.length > PROJECT_LIMIT) throw new Error("Home project scan limit exceeded");
  return rows.map(({ id }) => id);
}

export function homeTimeZone(zone: string | undefined): string {
  if (!zone || zone.length > 100 || /^[+-]/u.test(zone)) return "UTC";
  try { return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone; }
  catch { return "UTC"; }
}

function agentName(agent: string): string {
  if (agent === "claude-code") return "Claude Code";
  return agent.toLowerCase().replace(/[-_]+/gu, " ").replace(/(^|\s)\p{L}/gu, (letter) => letter.toUpperCase());
}

function activityWindow(zone: string, now: number) {
  const date = new Intl.DateTimeFormat("en", {
    timeZone: zone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const localDay = (stamp: number | Date) => {
    const parts = Object.fromEntries(date.formatToParts(stamp).map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const today = Date.parse(localDay(now));
  const days = Array.from({ length: 7 }, (_, index) => new Date(today - (6 - index) * DAY_MS).toISOString().slice(0, 10));
  const offset = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "longOffset" });
  // India and other half-hour zones fit ten-minute boundaries. Quarter-hour
  // zones need a split inside that bucket to keep both sides of midnight exact.
  const splitBucket = days.some((day) => offset.formatToParts(new Date(day)).some(
    ({ type, value }) => type === "timeZoneName" && /:[0-5]5$/u.test(value),
  ));
  // Compare whole-second prefixes: RFC3339Nano omits fractional digits at
  // exact seconds, so comparing to a fractional ISO endpoint can drop rows.
  const from = new Date(now - 8 * DAY_MS).toISOString().slice(0, 19);
  const through = new Date(now + 1000).toISOString().slice(0, 19);
  return { days, from, through, splitBucket, localDay: (bucket: string) => localDay(new Date(bucket + ":00Z")) };
}

function blankActivity(days: readonly string[]): Activity[] {
  return days.map((day) => ({ day, sessions: 0, gave: 0, heldBack: 0, replaced: 0 }));
}

function bucketSql(column: "ts" | "last_seen_at", splitBucket: boolean): string {
  // Go writes UTC RFC3339Nano. The prefix ends before the minute's units digit.
  const minute = splitBucket ? `CASE WHEN substr(${column},16,1)<'5' THEN '0' ELSE '5' END` : "'0'";
  return `substr(${column},1,15) || ${minute}`;
}

const receiptCounts = `
  count(CASE WHEN action IN ('given','replaced') AND moment<>'correction'
             AND substr(entry_id,1,4)<>'mex:' THEN 1 END) AS gave,
  count(CASE WHEN action='withheld' AND detail='' AND moment<>'correction'
             AND substr(entry_id,1,4)<>'mex:' THEN 1 END) AS heldBack,
  count(CASE WHEN action='control' AND moment='lever-observation' AND agent_id=''
             AND json_extract(CASE WHEN length(detail)<=4096 AND json_valid(detail) THEN detail END,'$.kind')='saving'
             THEN 1 END) AS replaced`;

function checkedBuckets<T extends { scanned: number }>(rows: T[]): T[] {
  if (rows.length > ACTIVITY_BUCKET_LIMIT || rows.reduce((total, row) => total + row.scanned, 0) > ACTIVITY_SCAN_LIMIT) {
    throw new Error("Home activity scan limit exceeded");
  }
  return rows;
}

function latestSessions(hooks: RecordReader, registered: string, detail: string): Session[] {
  const rows = hooks.all<Session & { scanned: number }>(`
    WITH latest AS (
      SELECT session_id,agent,project_id,checkout,last_seen_at FROM sessions
      WHERE project_id IN (SELECT value FROM json_each(?))
      ORDER BY last_seen_at DESC,session_id DESC LIMIT 20
    ), receipts AS (
      SELECT d.session_id,d.action,d.moment,d.entry_id,d.agent_id,${detail} AS detail
      FROM latest AS s CROSS JOIN deliveries AS d
      WHERE d.session_id=s.session_id AND d.project_id=s.project_id AND d.checkout=s.checkout LIMIT ?
    ), counts AS (
      SELECT session_id,${receiptCounts},count(*) AS scanned FROM receipts GROUP BY session_id
    )
    SELECT s.session_id AS id,s.project_id AS repoId,s.agent,s.last_seen_at AS at,
      coalesce(gave,0) AS gave,coalesce(heldBack,0) AS heldBack,coalesce(replaced,0) AS replaced,
      coalesce(scanned,0) AS scanned
    FROM latest AS s LEFT JOIN counts USING(session_id)
    ORDER BY s.last_seen_at DESC,s.session_id DESC LIMIT 20`, registered, SESSION_RECEIPT_LIMIT + 1);
  if (rows.reduce((total, row) => total + row.scanned, 0) > SESSION_RECEIPT_LIMIT) {
    throw new Error("Home session receipt scan limit exceeded");
  }
  return rows.map(({ scanned: _scanned, ...row }) => ({
    ...row, agent: agentName(row.agent), at: new Date(row.at).toISOString(),
  }));
}

function readHookMetrics(hooks: RecordReader, projects: Map<string, { activity: Activity[]; agents: Set<string> }>, window: ReturnType<typeof activityWindow>) {
  const { from, through, splitBucket, days, localDay } = window;
  const registered = JSON.stringify([...projects.keys()]);
  const dayIndices = new Map(days.map((day, index) => [day, index]));
  const bucketIndices = new Map<string, number | undefined>();
  function activityAt(project: string, bucket: string) {
    if (!bucketIndices.has(bucket)) bucketIndices.set(bucket, dayIndices.get(localDay(bucket)));
    const index = bucketIndices.get(bucket);
    return index === undefined ? undefined : projects.get(project)?.activity[index];
  }
  // The transaction is local to this read-only connection and holds one WAL
  // snapshot across the counts and latest list. Closing the reader releases it.
  hooks.get("BEGIN");
  const sessions = checkedBuckets(hooks.all<{ project_id: string; agent: string; bucket: string; scanned: number }>(`
    WITH recent AS (
      SELECT project_id, agent, ${bucketSql("last_seen_at", splitBucket)} AS bucket FROM sessions
      WHERE last_seen_at>=? AND last_seen_at<? AND project_id IN (SELECT value FROM json_each(?)) LIMIT ?
    )
    SELECT project_id,agent,bucket,count(*) AS scanned FROM recent GROUP BY project_id,agent,bucket LIMIT ?`,
    from, through, registered, ACTIVITY_SCAN_LIMIT + 1, ACTIVITY_BUCKET_LIMIT + 1));
  for (const row of sessions) {
    const day = activityAt(row.project_id, row.bucket);
    if (!day) continue;
    day.sessions += row.scanned;
    projects.get(row.project_id)?.agents.add(agentName(row.agent));
  }

  // The project and checkout columns landed before receipt details. Old hooks
  // can still show sessions and their activity without asking Go to migrate.
  if (hooks.version < 2) return latestSessionsWithoutReceipts(hooks, registered);
  const detail = hooks.version >= 5 ? "d.detail" : "''";
  const deliveries = checkedBuckets(hooks.all<Counts & { project_id: string; bucket: string; scanned: number }>(`
    WITH recent AS (
      SELECT project_id,${bucketSql("ts", splitBucket)} AS bucket,action,moment,entry_id,agent_id,${detail} AS detail
      FROM deliveries AS d WHERE ts>=? AND ts<? AND project_id IN (SELECT value FROM json_each(?)) LIMIT ?
    )
    SELECT project_id,bucket,${receiptCounts},count(*) AS scanned FROM recent GROUP BY project_id,bucket LIMIT ?`,
    from, through, registered, ACTIVITY_SCAN_LIMIT + 1, ACTIVITY_BUCKET_LIMIT + 1));
  for (const row of deliveries) {
    const day = activityAt(row.project_id, row.bucket);
    if (!day) continue;
    day.gave += row.gave;
    day.heldBack += row.heldBack;
    day.replaced += row.replaced;
  }
  return latestSessions(hooks, registered, detail);
}

function latestSessionsWithoutReceipts(hooks: RecordReader, registered: string): Session[] {
  return hooks.all<Pick<Session, "id" | "repoId" | "agent" | "at">>(`SELECT session_id AS id,project_id AS repoId,agent,last_seen_at AS at
    FROM sessions WHERE project_id IN (SELECT value FROM json_each(?))
    ORDER BY last_seen_at DESC,session_id DESC LIMIT 20`, registered).map((row) => ({
    ...row, agent: agentName(row.agent), at: new Date(row.at).toISOString(), gave: 0, heldBack: 0, replaced: 0,
  }));
}

export function readHomeMetrics(location: LocationOptions, zone: string, now: number): HomeMetrics {
  const { ids, week } = readStore(openRecordReadOnly, location, (reader) => {
    const ids = registeredProjectIds(reader);
    let model;
    try { model = readModelUse(reader, now); }
    catch { model = readModelUse(undefined, now); }
    const { percent, capPercent } = model;
    return { ids, week: { percent, capPercent } };
  });
  const window = activityWindow(zone, now);
  const projects = new Map(ids.map((id) => [id, { activity: blankActivity(window.days), agents: new Set<string>() }]));
  const sessions = projects.size ? readStore(openHooksReadOnly, location, (hooks) => hooks ? readHookMetrics(hooks, projects, window) : []) : [];
  const activity = blankActivity(window.days);
  const agents = new Set<string>();
  const byRepo = Object.fromEntries([...projects].map(([id, project]) => {
    for (const agent of project.agents) agents.add(agent);
    project.activity.forEach((day, index) => {
      activity[index].sessions += day.sessions;
      activity[index].gave += day.gave;
      activity[index].heldBack += day.heldBack;
      activity[index].replaced += day.replaced;
    });
    return [id, { activity: project.activity, agents: [...project.agents].sort(), week }];
  }));
  return { activity, agents: [...agents].sort(), week, byRepo, sessions };
}
