/** The only vocabulary allowed across the telemetry v3 network boundary. */
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { isTelemetryId } from "../global-config.js";
import { VERSION } from "../version.js";

export const REPORT_EVENTS = ["install.first_run", "setup.finished", "daily", "share.done", "off", "on", "uninstall", "error", "ci.run"] as const;
export type ReportName = typeof REPORT_EVENTS[number];
export const COUNT_RANGES = ["0", "1", "2–5", "6–20", "21–100", "100+"] as const;
export type CountRange = typeof COUNT_RANGES[number];
export const REPORT_AGENTS = ["claude-code", "codex", "copilot", "cursor", "opencode", "antigravity", "gemini", "devin", "kiro"] as const;
export const COUNTER_NAMES = [
  "sessions", "hook.calls", "hook.errors", "knowledge.delivered", "knowledge.followed", "knowledge.missed", "knowledge.opened", "knowledge.wrong",
  "speed_bumps", "rescues", "graph.builds", "jobs.completed", "jobs.failed", "hub.sessions", "hub.pages", "commands", "setup.started", "setup.finished",
] as const;
export type CounterName = typeof COUNTER_NAMES[number];
export const REPORT_COMMANDS = ["mex", "setup", "init", "check", "graph", "graph.status", "graph.refresh", "graph.rebuild", "graph.query", "graph.scope", "graph.get", "impact", "note", "recall", "expand", "edit", "wrong", "forget", "share", "upgrade", "jobs", "hub", "doctor"] as const;
export const ERROR_CODES = ["hook.parse", "hook.timeout", "job.failed", "setup.failed", "graph.failed", "storage.unavailable"] as const;
export type Counters = Partial<Record<CounterName, CountRange>>;
export interface ReportAttributes {
  counts?: Counters;
  by_agent?: Partial<Record<typeof REPORT_AGENTS[number], { counts: Counters; hook_p95_ms?: CountRange }>>;
  agents?: typeof REPORT_AGENTS[number][];
  command?: typeof REPORT_COMMANDS[number];
  outcome?: "success" | "failure" | "cancelled";
  duration?: CountRange;
  code?: typeof ERROR_CODES[number];
  project_id?: string;
}
export interface UsageReport {
  event: ReportName; uuid: string; timestamp: string; distinct_id: string;
  properties: ReportAttributes & {
    schema_version: 3; source: "person" | "ci"; mex_version: string; os: string;
    installation_id?: string; $process_person_profile: false; $geoip_disable: true;
  };
}

const contains = (values: readonly string[], value: unknown): boolean => typeof value === "string" && values.includes(value);
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function countRange(value: number): CountRange {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("A telemetry count must be a nonnegative safe integer");
  return value === 0 ? "0" : value === 1 ? "1" : value <= 5 ? "2–5" : value <= 20 ? "6–20" : value <= 100 ? "21–100" : "100+";
}

export function reportAttributes(name: string, value: unknown): value is ReportAttributes {
  if (!contains(REPORT_EVENTS, name) || !plain(value)) return false;
  const fields = name === "daily" ? ["counts", "agents", "by_agent"] : name === "ci.run" ? ["command", "outcome", "duration", "project_id"]
    : name === "error" ? ["code", "agents"] : name === "setup.finished" ? ["agents", "duration", "outcome", "project_id"]
    : name === "share.done" ? ["counts", "project_id"] : name === "install.first_run" ? ["agents"] : [];
  if (Object.keys(value).some((key) => !fields.includes(key))) return false;
  if (value.counts !== undefined && (!plain(value.counts) || Object.entries(value.counts).some(([key, count]) => !contains(COUNTER_NAMES, key) || !contains(COUNT_RANGES, count)))) return false;
  if (name === "daily" && (!plain(value.counts) || Object.keys(value.counts).length === 0)) return false;
  if (value.by_agent !== undefined && (!plain(value.by_agent) || Object.entries(value.by_agent).some(([agent, stats]) => !contains(REPORT_AGENTS, agent)
    || !plain(stats) || Object.keys(stats).some((key) => !["counts", "hook_p95_ms"].includes(key)) || !plain(stats.counts)
    || Object.entries(stats.counts).some(([key, count]) => !contains(COUNTER_NAMES, key) || !contains(COUNT_RANGES, count))
    || (stats.hook_p95_ms !== undefined && !contains(COUNT_RANGES, stats.hook_p95_ms))))) return false;
  const agents = value.agents;
  if (agents !== undefined && (!Array.isArray(agents) || agents.length > REPORT_AGENTS.length
    || agents.some((agent, index) => !contains(REPORT_AGENTS, agent) || (index > 0 && agents[index - 1] >= agent)))) return false;
  if (value.command !== undefined && !contains(REPORT_COMMANDS, value.command)) return false;
  if (value.outcome !== undefined && !contains(["success", "failure", "cancelled"], value.outcome)) return false;
  if (value.duration !== undefined && !contains(COUNT_RANGES, value.duration)) return false;
  if (value.code !== undefined && !contains(ERROR_CODES, value.code)) return false;
  if (name === "error" && value.code === undefined) return false;
  return value.project_id === undefined || isTelemetryId(value.project_id);
}

/** Identity must come from the shared-repository reader, never a path or Git hash. */
export function makeReport(name: ReportName, attributes: ReportAttributes, installationId: string | undefined, now = Date.now(), uuid: string = randomUUID()): UsageReport | undefined {
  const ci = name === "ci.run";
  if (!reportAttributes(name, attributes) || (!ci && !isTelemetryId(installationId)) || !isTelemetryId(uuid)) return undefined;
  return { event: name, uuid, timestamp: new Date(now).toISOString(), distinct_id: ci ? "ci" : installationId!, properties: {
    schema_version: 3, source: ci ? "ci" : "person", mex_version: VERSION, os: platform(),
    ...(!ci ? { installation_id: installationId } : {}), $process_person_profile: false, $geoip_disable: true,
    ...JSON.parse(JSON.stringify(attributes)) as ReportAttributes,
  } };
}

/** Persisted data is untrusted. Recheck the entire object immediately before sending. */
export function validateReport(value: unknown): value is UsageReport {
  if (!plain(value) || Object.keys(value).sort().join() !== "distinct_id,event,properties,timestamp,uuid"
    || !contains(REPORT_EVENTS, value.event) || !isTelemetryId(value.uuid) || typeof value.timestamp !== "string"
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.timestamp) || !Number.isFinite(Date.parse(value.timestamp)) || !plain(value.properties)) return false;
  const p = value.properties, ci = value.event === "ci.run";
  const base = ["schema_version", "source", "mex_version", "os", "$process_person_profile", "$geoip_disable", ...(!ci ? ["installation_id"] : [])];
  if (p.schema_version !== 3 || p.source !== (ci ? "ci" : "person") || p.$process_person_profile !== false || p.$geoip_disable !== true
    || (ci ? value.distinct_id !== "ci" : !isTelemetryId(value.distinct_id) || p.installation_id !== value.distinct_id)
    || typeof p.mex_version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(p.mex_version)
    || !contains(["aix", "android", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32"], p.os)) return false;
  return reportAttributes(String(value.event), Object.fromEntries(Object.entries(p).filter(([key]) => !base.includes(key))));
}
