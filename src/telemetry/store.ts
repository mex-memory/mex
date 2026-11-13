/** Local counters and bounded report history, using Node's existing record.db. */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mexHomeDir } from "../global-config.js";
import { openRecord, openRecordReadOnly, openHooksReadOnly, recordLocation, type RecordWriter, type RecordReader } from "../record/index.js";
import { telemetryEnabled, isCI } from "./policy.js";
import { COUNTER_NAMES, COUNT_RANGES, REPORT_AGENTS, countRange, reportAttributes, validateReport, type CounterName, type ReportAttributes, type ReportName, type UsageReport } from "./report-schema.js";

export const REPORT_RETENTION_DAYS = 7;
export const REPORT_QUEUE_LIMIT = 128;
export const REPORT_HISTORY_LIMIT = 100;
export const REPORT_BYTES = 16 * 1024;
const SCOPE = "telemetry.v3";
const DAY_MS = 86_400_000;
export const utcDay = (now = Date.now()): string => new Date(now).toISOString().slice(0, 10);
export const cutoffDay = (now = Date.now()): string => utcDay(now - REPORT_RETENTION_DAYS * DAY_MS);
export type Agent = typeof REPORT_AGENTS[number];
interface CounterRow { day: string; name: string; value: number; }
export interface PendingReport { event: ReportName; attributes: ReportAttributes; timestamp: string; uuid: string; }
interface SettingRow { key: string; value: string; }

function safeFiles(): void {
  try { const home = lstatSync(mexHomeDir()); if (!home.isDirectory() || home.isSymbolicLink()) throw new Error("Unsafe telemetry home"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const location = recordLocation({ create: false });
  for (const file of [location.record, `${location.record}-wal`, `${location.record}-shm`, location.hooks, `${location.hooks}-wal`, `${location.hooks}-shm`]) {
    try { const st = lstatSync(file); if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error("Unsafe telemetry record file"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function plainTable(reader: RecordReader, name: string): boolean {
  return reader.get<{ type: string }>("SELECT type FROM sqlite_schema WHERE name=?", name)?.type === "table";
}

export function withTelemetryRecord<T>(work: (writer: RecordWriter) => T): T | undefined {
  let writer: RecordWriter | undefined;
  try {
    safeFiles();
    const existing = openRecordReadOnly({ create: false });
    if (existing) {
      try {
        if (existing.diagnostic) return undefined;
        for (const row of existing.all<{ type: string }>("SELECT type FROM sqlite_schema WHERE name IN ('settings','counters_node')")) {
          if (row.type !== "table") return undefined;
        }
        if (existing.get("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('settings','counters_node') LIMIT 1")) return undefined;
      } finally { existing.close(); }
    }
    writer = openRecord({ busyTimeoutMs: 10 });
    // Capture is best effort; never wait five seconds on another writer's counter transaction.
    writer.db.exec("PRAGMA busy_timeout=10");
    return work(writer);
  } catch { return undefined; }
  finally { try { writer?.close(); } catch { /* best effort */ } }
}

export function setting(writer: RecordWriter, key: string, value: string): void {
  writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(SCOPE, key, value);
}
export function getSetting(writer: RecordWriter, key: string): string | undefined { return writer.setting(SCOPE, key); }
export function deleteSetting(writer: RecordWriter, key: string): void { writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?").run(SCOPE, key); }
export function settings(reader: Pick<RecordReader, "all">, prefix: string, limit: number): SettingRow[] {
  return reader.all<SettingRow>("SELECT key,CASE WHEN length(CAST(value AS BLOB))<=? THEN value ELSE '' END value FROM settings WHERE scope=? AND key LIKE ? AND length(key)<=160 ORDER BY key LIMIT ?", REPORT_BYTES, SCOPE, `${prefix}%`, limit);
}
const view = (writer: RecordWriter): Pick<RecordReader, "all"> => ({ all: (sql, ...args) => writer.db.prepare(sql).all(...args) as never });
export function pendingReports(writer: RecordWriter): SettingRow[] { return settings(view(writer), "pending:", REPORT_QUEUE_LIMIT); }

export function transaction<T>(writer: RecordWriter, work: () => T): T {
  writer.db.exec("BEGIN IMMEDIATE");
  try { const result = work(); writer.db.exec("COMMIT"); return result; }
  catch (error) { try { writer.db.exec("ROLLBACK"); } catch { /* already aborted */ } throw error; }
}

export function validCounterKey(key: string): boolean {
  if ((COUNTER_NAMES as readonly string[]).includes(key)) return true;
  const match = /^agent:([^:]+):(.+)$/.exec(key);
  return !!match && (REPORT_AGENTS as readonly string[]).includes(match[1])
    && ((COUNTER_NAMES as readonly string[]).includes(match[2]) || /^hook\.ms\.[0-5]$/.test(match[2]));
}

/** No identity or network work. Agent and metric names are closed, never payload strings. */
export function recordCounter(name: CounterName, amount = 1, agent?: Agent, now = Date.now()): boolean {
  if (!telemetryEnabled().enabled || isCI() || !(COUNTER_NAMES as readonly string[]).includes(name)
    || !Number.isSafeInteger(amount) || amount <= 0 || (agent !== undefined && !(REPORT_AGENTS as readonly string[]).includes(agent))) return false;
  return withTelemetryRecord((writer) => recordCounterIn(writer, name, amount, agent, now)) ?? false;
}

/** Existing jobs can use their owned writer after committing their product transaction. */
export function recordCounterIn(writer: RecordWriter, name: CounterName, amount = 1, agent?: Agent, now = Date.now()): boolean {
  try {
    if (!telemetryEnabled().enabled || isCI() || !(COUNTER_NAMES as readonly string[]).includes(name)
      || !Number.isSafeInteger(amount) || amount <= 0 || (agent !== undefined && !(REPORT_AGENTS as readonly string[]).includes(agent))) return false;
    const key = agent ? `agent:${agent}:${name}` : name;
    writer.db.prepare(`INSERT INTO counters_node(day,name,value) VALUES(?,?,?)
      ON CONFLICT(day,name) DO UPDATE SET value=min(2147483647,value+excluded.value)`).run(utcDay(now), key, Math.min(2147483647, amount));
    return true;
  } catch { return false; }
}

export function parsePending(value: string): PendingReport | undefined {
  if (Buffer.byteLength(value) > REPORT_BYTES) return undefined;
  try {
    const item = JSON.parse(value) as PendingReport;
    if (!item || Object.keys(item).sort().join() !== "attributes,event,timestamp,uuid" || typeof item.timestamp !== "string"
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.timestamp) || !Number.isFinite(Date.parse(item.timestamp))
      || !/^[a-f0-9-]{36}$/.test(item.uuid) || !reportAttributes(item.event, item.attributes)) return undefined;
    return item;
  } catch { return undefined; }
}

export function enqueueReport(writer: RecordWriter, event: ReportName, attributes: ReportAttributes, now: number, dedup?: string): boolean {
  if (!reportAttributes(event, attributes) || (dedup && getSetting(writer, `once:${dedup}`))) return false;
  if (pendingReports(writer).length >= REPORT_QUEUE_LIMIT) return false;
  const item: PendingReport = { event, attributes, uuid: randomUUID(), timestamp: new Date(now).toISOString() };
  const serialized = JSON.stringify(item);
  if (Buffer.byteLength(serialized) > REPORT_BYTES) return false;
  setting(writer, `pending:${item.uuid}`, serialized);
  if (dedup) setting(writer, `once:${dedup}`, utcDay(now));
  try { writeFileSync(join(writer.location.home, "jobs-pending"), ""); } catch { /* a future command can still discover it */ }
  return true;
}

export function recordLifecycle(event: ReportName, attributes: ReportAttributes = {}, now = Date.now(), dedup?: string): boolean {
  if (!telemetryEnabled().enabled || isCI() || event === "daily" || event === "ci.run") return false;
  if (event === "error") dedup = `error:${attributes.code}:${utcDay(now)}`;
  if (event === "install.first_run") dedup = "install";
  return withTelemetryRecord((writer) => transaction(writer, () => enqueueReport(writer, event, attributes, now, dedup))) ?? false;
}

/** This reads Go's file only. Unknown/future counters never become outgoing fields. */
export function dailyCounters(now = Date.now()): CounterRow[] {
  const rows: CounterRow[] = [];
  safeFiles();
  for (const open of [openRecordReadOnly, openHooksReadOnly]) {
    let reader: RecordReader | undefined;
    try {
      reader = open({ create: false });
      if (!reader || reader.diagnostic) continue;
      const table = open === openRecordReadOnly ? "counters_node" : "counters_go";
      if (!plainTable(reader, table)) continue;
      const admitted = reader.all<CounterRow>(`SELECT day,name,value FROM ${table} WHERE day>=? AND day<? ORDER BY day,name LIMIT 8193`, cutoffDay(now), utcDay(now));
      if (admitted.length > 8192) throw new Error("Telemetry counter read limit exceeded");
      rows.push(...admitted.filter((row) => /^\d{4}-\d\d-\d\d$/.test(row.day) && validCounterKey(row.name) && Number.isSafeInteger(row.value) && row.value >= 0));
    } finally { reader?.close(); }
  }
  return rows;
}

export function summarizeCounters(rows: CounterRow[]): ReportAttributes {
  const totals: Record<string, number> = {}, agents: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    if (!validCounterKey(row.name) || !Number.isSafeInteger(row.value) || row.value < 0) continue;
    const match = /^agent:([^:]+):(.+)$/.exec(row.name);
    const name = match?.[2] ?? row.name;
    if (match) { const values = agents[match[1]] ??= {}; values[name] = Math.min(2147483647, (values[name] ?? 0) + row.value); }
    if ((COUNTER_NAMES as readonly string[]).includes(name)) totals[name] = Math.min(2147483647, (totals[name] ?? 0) + row.value);
  }
  const ranged = (values: Record<string, number>) => Object.fromEntries(Object.entries(values).filter(([key]) => (COUNTER_NAMES as readonly string[]).includes(key)).map(([key, value]) => [key, countRange(value)]));
  const byAgent = Object.fromEntries(Object.entries(agents).map(([agent, values]) => {
    const samples = COUNT_RANGES.map((_, index) => values[`hook.ms.${index}`] ?? 0);
    const total = samples.reduce((sum, n) => sum + n, 0);
    let seen = 0;
    const p95 = total ? COUNT_RANGES[samples.findIndex((n) => (seen += n) >= Math.ceil(total * .95))] : undefined;
    return [agent, { counts: ranged(values), ...(p95 === undefined ? {} : { hook_p95_ms: p95 }) }];
  }));
  return { counts: ranged(totals), ...(Object.keys(byAgent).length ? { agents: Object.keys(byAgent).sort() as Agent[], by_agent: byAgent } : {}) };
}

export function prepareDailyReports(writer: RecordWriter, now = Date.now()): number {
  const discard = getSetting(writer, "discard_through_day");
  const rows = dailyCounters(now).filter((row) => !discard || row.day > discard);
  let queued = 0;
  transaction(writer, () => {
    for (const day of [...new Set(rows.map((row) => row.day))].sort()) {
      if (enqueueReport(writer, "daily", summarizeCounters(rows.filter((row) => row.day === day)), Date.parse(`${day}T23:59:59.999Z`), `daily:${day}`)) queued++;
    }
  });
  return queued;
}

export function pruneReports(writer: RecordWriter, now = Date.now()): void {
  const cutoff = cutoffDay(now);
  for (const row of pendingReports(writer)) {
    const item = parsePending(row.value);
    if (!item || item.timestamp.slice(0, 10) < cutoff) deleteSetting(writer, row.key);
  }
  for (const row of settings(view(writer), "once:", 1024)) {
    // First notice and first setup in a checkout are lifetime local markers.
    if (row.key !== "once:install" && !/^once:setup:[a-f0-9]{64}$/.test(row.key) && row.value < cutoff) deleteSetting(writer, row.key);
  }
  const history = settings(view(writer), "history:", REPORT_HISTORY_LIMIT + REPORT_QUEUE_LIMIT);
  for (const row of history.slice(0, Math.max(0, history.length - REPORT_HISTORY_LIMIT))) deleteSetting(writer, row.key);
  writer.db.prepare("DELETE FROM counters_node WHERE day<?").run(cutoff);
}

export function inspectReports(): { pending: PendingReport[]; sent: UsageReport[]; controls?: Array<{ event: "off"; timestamp: string }> } {
  let reader: RecordReader | undefined;
  try {
    safeFiles(); reader = openRecordReadOnly({ create: false });
    if (!reader || reader.diagnostic || !plainTable(reader, "settings")) return { pending: [], sent: [] };
    const pending = settings(reader, "pending:", REPORT_QUEUE_LIMIT).map((row) => parsePending(row.value)).filter((item): item is PendingReport => !!item);
    const sent = settings(reader, "history:", REPORT_HISTORY_LIMIT).flatMap((row) => {
      if (Buffer.byteLength(row.value) > REPORT_BYTES) return [];
      try { const item: unknown = JSON.parse(row.value); return validateReport(item) ? [item] : []; } catch { return []; }
    });
    const off = reader.setting(SCOPE, "control:off");
    return { pending, sent, ...(off && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(off) ? { controls: [{ event: "off" as const, timestamp: off }] } : {}) };
  } catch { return { pending: [], sent: [] }; }
  finally { reader?.close(); }
}

export function clearPendingReports(): boolean {
  const location = recordLocation({ create: false });
  if (!existsSync(location.record) && !existsSync(location.hooks)) return true;
  return withTelemetryRecord((writer) => transaction(writer, () => {
    writer.db.prepare("DELETE FROM settings WHERE scope=? AND key LIKE 'pending:%'").run(SCOPE);
    writer.db.prepare("DELETE FROM counters_node").run();
    // Node never deletes Go-owned rows. Ignore them through the opt-out day so
    // re-enabling cannot resurrect a summary the user chose to discard.
    setting(writer, "discard_through_day", utcDay());
    setting(writer, "control:off", new Date().toISOString());
    return true;
  })) ?? false;
}
