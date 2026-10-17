/** The entire telemetry vocabulary. No caller data is spread into an event. */
import { platform } from "node:os";
import { randomUUID } from "node:crypto";
import { VERSION } from "../version.js";
import { isTelemetryId } from "../global-config.js";

export const TELEMETRY_EVENTS = [
  "cli.command_started", "cli.command_completed", "hub.session_started",
  "hub.page_viewed", "hub.action_completed", "hub.job_completed", "hub.team_access",
] as const;
export type TelemetryEventName = typeof TELEMETRY_EVENTS[number];
export const TELEMETRY_COMMANDS = [
  "mex", "setup", "init", "check", "graph", "graph.status", "graph.refresh", "graph.rebuild",
  "graph.query", "graph.scope", "graph.get", "graph.repair", "graph.ground",
  "wiki.list", "wiki.show", "wiki.query", "wiki.related", "wiki.backlinks", "wiki.validate",
  "wiki.graph", "wiki.rebuild-index", "wiki.regenerate-views", "wiki.migrate", "wiki.apply",
  "wiki.build", "wiki.prepare", "wiki.propose", "wiki.for-code", "impact", "log", "heartbeat",
  "doctor", "sync", "pattern.add", "watch", "completion", "feedback", "commands", "tui",
  "member.add", "member.update", "member.deactivate", "member.reactivate", "member.select",
  "activity.record", "workstream.create", "workstream.update", "workstream.archive",
  "inbox.draft.save", "inbox.draft.delete", "inbox.publish", "inbox.proposal.approve",
  "inbox.proposal.reject", "inbox.proposal.withdraw", "inbox.proposal.mark-stale", "inbox.proposal.repair",
  "relay.draft.save", "relay.draft.delete", "relay.publish", "relay.acknowledge", "relay.close",
] as const;
export const TELEMETRY_PAGES = [
  "home", "search", "knowledge", "knowledge_detail", "code", "code_symbol", "workstreams",
  "specs", "spec_detail", "playbooks", "catch_up", "inbox", "relays", "members", "activity",
  "jobs", "health", "settings", "setup", "not_found",
] as const;
export const TELEMETRY_ACTIONS = [
  "member.add", "member.update", "member.deactivate", "member.reactivate", "member.select", "member.clear",
  "workstream.create", "workstream.update", "workstream.archive", "activity.record",
  "inbox.draft.save", "inbox.draft.delete", "inbox.publish", "inbox.approve", "inbox.reject",
  "inbox.withdraw", "inbox.mark-stale", "inbox.repair", "relay.draft.save", "relay.draft.delete",
  "relay.publish", "relay.acknowledge", "relay.close", "job.start", "job.cancel", "settings.logging.update",
] as const;
export const TELEMETRY_JOB_KINDS = ["graph_refresh", "graph_rebuild", "wiki_refresh", "wiki_rebuild"] as const;
export const TELEMETRY_OUTCOMES = ["success", "failure", "cancelled"] as const;
export const TELEMETRY_STAGES = ["preview", "apply", "direct"] as const;
/** Where people stop on the Hub's team-access card; no contact details or other values. */
export const TELEMETRY_TEAM_ACCESS_STEPS = ["card_viewed", "button_clicked", "dialog_opened", "submitted"] as const;
/** Persisted tool selections, never a claim about the agent invoking a command. */
export const TELEMETRY_AI_TOOLS = ["claude", "codex", "copilot", "cursor", "opencode", "windsurf"] as const;
export type TelemetryAiTool = typeof TELEMETRY_AI_TOOLS[number];
export interface TelemetryProjectContext {
  scaffold_id?: string;
  configured_ai_tools?: TelemetryAiTool[];
}

/** Strings are checked against the catalog at runtime, including data read from disk. */
export interface TelemetryAttributes extends TelemetryProjectContext {
  command?: string;
  page?: string;
  action?: string;
  job_kind?: string;
  outcome?: "success" | "failure" | "cancelled";
  stage?: "preview" | "apply" | "direct";
  duration_ms?: number;
  replayed?: boolean;
  step?: "card_viewed" | "button_clicked" | "dialog_opened" | "submitted";
}
export type TelemetryProperties = Record<string, string | number | boolean | string[]>;
export interface TelemetryEvent {
  event: TelemetryEventName;
  uuid: string;
  timestamp: string;
  distinct_id: string;
  properties: TelemetryProperties;
}

const includes = (values: readonly string[], value: unknown): value is string =>
  typeof value === "string" && values.includes(value);
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function configuredAiTools(value: unknown): value is TelemetryAiTool[] {
  if (!Array.isArray(value) || value.length > TELEMETRY_AI_TOOLS.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !includes(TELEMETRY_AI_TOOLS, value[index])
      || (index > 0 && value[index - 1] >= value[index])) return false;
  }
  return true;
}

export function eventAttributes(name: string, value: unknown): TelemetryAttributes | undefined {
  if (!includes(TELEMETRY_EVENTS, name) || !plain(value)) return undefined;
  let required: string[];
  let optional: string[] = [];
  if (name === "cli.command_started") { required = ["command"]; optional = ["stage"]; }
  else if (name === "cli.command_completed") { required = ["command", "outcome", "duration_ms"]; optional = ["stage"]; }
  else if (name === "hub.page_viewed") required = ["page"];
  else if (name === "hub.action_completed") { required = ["action", "stage", "outcome", "duration_ms"]; optional = ["replayed"]; }
  else if (name === "hub.job_completed") required = ["job_kind", "outcome", "duration_ms"];
  else if (name === "hub.team_access") required = ["step"];
  else required = [];
  optional.push("scaffold_id", "configured_ai_tools");
  if (Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) return undefined;
  if (required.some((key) => !Object.hasOwn(value, key) || value[key] === undefined)) return undefined;
  if (value.scaffold_id !== undefined && (!isTelemetryId(value.scaffold_id) || value.scaffold_id.length !== 36)) return undefined;
  if (value.configured_ai_tools !== undefined && !configuredAiTools(value.configured_ai_tools)) return undefined;
  if (value.command !== undefined && !includes(TELEMETRY_COMMANDS, value.command)) return undefined;
  if (value.page !== undefined && !includes(TELEMETRY_PAGES, value.page)) return undefined;
  if (value.action !== undefined && !includes(TELEMETRY_ACTIONS, value.action)) return undefined;
  if (value.job_kind !== undefined && !includes(TELEMETRY_JOB_KINDS, value.job_kind)) return undefined;
  if (value.outcome !== undefined && !includes(TELEMETRY_OUTCOMES, value.outcome)) return undefined;
  if (value.stage !== undefined && !includes(TELEMETRY_STAGES, value.stage)) return undefined;
  if (value.step !== undefined && !includes(TELEMETRY_TEAM_ACCESS_STEPS, value.step)) return undefined;
  if (value.replayed !== undefined && (typeof value.replayed !== "boolean" || value.stage !== "apply")) return undefined;
  if (value.duration_ms !== undefined && (typeof value.duration_ms !== "number"
    || !Number.isFinite(value.duration_ms) || value.duration_ms < 0 || value.duration_ms > 86_400_000)) return undefined;
  const projected: TelemetryProperties = {};
  for (const key of [...required, ...optional]) {
    const item = value[key];
    if (item === undefined) continue;
    if (key === "configured_ai_tools") projected[key] = [...item as TelemetryAiTool[]];
    else projected[key] = key === "duration_ms" ? Math.floor(item as number) : item as string | boolean;
  }
  return projected as TelemetryAttributes;
}

function properties(name: TelemetryEventName, attributes: TelemetryAttributes, installationId: string): TelemetryProperties {
  return {
    schema_version: 2,
    source: name.startsWith("cli.") ? "cli" : "hub",
    installation_id: installationId,
    mex_version: VERSION,
    os: platform(),
    node_version: process.version,
    // API events default to identified; explicitly disable profile creation and GeoIP.
    $process_person_profile: false,
    $geoip_disable: true,
    ...attributes,
  };
}

export function makeEvent(name: TelemetryEventName, value: unknown, installationId: string, now = Date.now()): TelemetryEvent | undefined {
  const attributes = eventAttributes(name, value);
  if (!attributes || !isTelemetryId(installationId)) return undefined;
  return { event: name, uuid: randomUUID(), timestamp: new Date(now).toISOString(), distinct_id: installationId,
    properties: properties(name, attributes, installationId) };
}

/** Revalidate every persisted byte before sending. Invalid/extra fields never escape. */
export function validateStoredEvent(value: unknown): value is TelemetryEvent {
  if (!plain(value) || Object.keys(value).sort().join() !== "distinct_id,event,properties,timestamp,uuid"
    || !includes(TELEMETRY_EVENTS, value.event) || !isTelemetryId(value.uuid) || !isTelemetryId(value.distinct_id)
    || typeof value.timestamp !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.timestamp)
    || !Number.isFinite(Date.parse(value.timestamp)) || !plain(value.properties)) return false;
  const p = value.properties;
  const base = ["schema_version", "source", "installation_id", "mex_version", "os", "node_version", "$process_person_profile", "$geoip_disable"];
  if (p.schema_version !== 2 || p.source !== (value.event.startsWith("cli.") ? "cli" : "hub")
    || p.installation_id !== value.distinct_id || p.$process_person_profile !== false || p.$geoip_disable !== true
    || typeof p.mex_version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(p.mex_version)
    || typeof p.node_version !== "string" || !/^v\d+\.\d+\.\d+$/.test(p.node_version)
    || !includes(["aix", "android", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32"], p.os)) return false;
  const attributes = Object.fromEntries(Object.entries(p).filter(([key]) => !base.includes(key)));
  return eventAttributes(value.event, attributes) !== undefined;
}

/** Symbolic examples intentionally do not generate a UUID or read/write identity. */
export function previewEvent(name: TelemetryEventName, attributes: TelemetryAttributes, installationId?: string): Record<string, unknown> {
  const id = isTelemetryId(installationId) ? installationId : "<installation UUID; not created by inspect>";
  return { event: name, uuid: "<event UUID>", timestamp: "<original event time in UTC>", distinct_id: id,
    properties: properties(name, eventAttributes(name, attributes) ?? {}, id) };
}
