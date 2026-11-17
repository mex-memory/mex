/** Telemetry v3: local producers, background reports, identity-free CI. */
import { readMachineId, readGlobalConfig, setGlobalConfigKey } from "../global-config.js";
import { platform } from "node:os";
import { VERSION } from "../version.js";
import { enqueueJob } from "../record/jobs.js";
import { ensureBackground, markPending } from "../record/background.js";
import { eventAttributes, type TelemetryAttributes, type TelemetryEventName, type TelemetryProjectContext } from "./schema.js";
import { purgeOutbox, closeOutbox } from "./outbox.js";
import { readSharedProjectTelemetryContext, setupTelemetryKey } from "./project-context.js";
import { telemetryEnabled, reportingAllowed, isCI, TELEMETRY_NOTICE_VERSION } from "./policy.js";
import { REPORT_EVENTS, COUNTER_NAMES, COUNT_RANGES, REPORT_COMMANDS, REPORT_AGENTS, countRange } from "./report-schema.js";
import { recordCounter, recordLifecycle, withTelemetryRecord, pendingReports, dailyCounters, inspectReports, clearPendingReports, REPORT_QUEUE_LIMIT, REPORT_HISTORY_LIMIT } from "./store.js";
import { abortReporting, flushCiReport, queueCiReport, noteCiDisclosure, ciDisclosureShown, resetReporting, setReportingSink } from "./reporting.js";
import { setEndpointForTest, TELEMETRY_ENDPOINT } from "./transport.js";
export type { TelemetryAttributes, TelemetryEventName, TelemetryEvent } from "./schema.js";
export { TELEMETRY_ACTIONS, TELEMETRY_COMMANDS, TELEMETRY_EVENTS, TELEMETRY_JOB_KINDS, TELEMETRY_PAGES } from "./schema.js";
export { recordCounter, recordLifecycle } from "./store.js";
export { sendUsageReports } from "./reporting.js";
export { isCI } from "./policy.js";
export const TELEMETRY_FLUSH_GRACE_MS = 25;
export const HUB_TELEMETRY_INTERVAL_MS = 60_000;
export const isEnabled = telemetryEnabled;
export type EnabledResult = ReturnType<typeof telemetryEnabled>;
let customSink = false;
const projectSelection = Symbol("local telemetry project selection");
type LocalProjectContext = TelemetryProjectContext & { [projectSelection]?: string };

/** Legacy producer shapes stay local. Removed features are deliberately ignored. */
export function captureEvent(name: TelemetryEventName, attributes: TelemetryAttributes = {}): void {
  try {
    if (!eventAttributes(name, attributes) || !telemetryEnabled().enabled) return;
    if (isCI()) {
      if (name === "cli.command_started" && (REPORT_COMMANDS as readonly string[]).includes(attributes.command ?? "")) showFirstRunNotice();
      if (name === "cli.command_completed" && (REPORT_COMMANDS as readonly string[]).includes(attributes.command ?? "")) {
        const selected = (attributes as TelemetryAttributes & { [projectSelection]?: string })[projectSelection];
        const context = readSharedProjectTelemetryContext(selected ?? process.cwd(), selected ? "exact" : "git-root");
        queueCiReport({ command: attributes.command as typeof REPORT_COMMANDS[number], outcome: attributes.outcome,
          duration: countRange(Math.floor(attributes.duration_ms ?? 0)), ...(context.scaffold_id ? { project_id: context.scaffold_id } : {}) });
      }
      return;
    }
    if (name === "cli.command_started" && (REPORT_COMMANDS as readonly string[]).includes(attributes.command ?? "")) {
      recordCounter("commands");
      if (attributes.command === "setup") recordCounter("setup.started");
    } else if (name === "cli.command_completed" && ["setup", "init"].includes(attributes.command ?? "") && attributes.outcome === "success" && attributes.stage !== "preview") {
      recordCounter("setup.finished");
      const selected = (attributes as TelemetryAttributes & { [projectSelection]?: string })[projectSelection];
      const dedup = setupTelemetryKey(selected ?? process.cwd());
      if (dedup) recordLifecycle("setup.finished", { outcome: "success", duration: countRange(Math.floor(attributes.duration_ms ?? 0)) }, Date.now(), dedup);
    } else if (name === "hub.session_started") recordCounter("hub.sessions");
    else if (name === "hub.page_viewed" && !["workstreams", "specs", "spec_detail", "playbooks", "catch_up", "inbox"].includes(attributes.page ?? "")) recordCounter("hub.pages");
    else if (name === "hub.job_completed") {
      recordCounter(attributes.outcome === "success" ? "jobs.completed" : "jobs.failed");
      if (attributes.outcome === "success" && ["graph_refresh", "graph_rebuild"].includes(attributes.job_kind ?? "")) recordCounter("graph.builds");
    }
  } catch { /* Measurement never changes the product result. */ }
}
export function getProjectTelemetryContext(startDir: string, discovery: "git-root" | "exact" = "git-root"): LocalProjectContext {
  try {
    if (!telemetryEnabled().enabled) return {};
    return { ...readSharedProjectTelemetryContext(startDir, discovery), [projectSelection]: startDir };
  } catch { return {}; }
}
export function createProjectTelemetryCapture(startDir: string): typeof captureEvent {
  let context: TelemetryProjectContext | undefined;
  return (name, attributes = {}) => {
    if (!eventAttributes(name, attributes) || !telemetryEnabled().enabled) return;
    context ??= getProjectTelemetryContext(startDir, "exact");
    captureEvent(name, { ...attributes, ...context });
  };
}

/** Queue finite work only when there is actually a report to send. */
export function wakeTelemetry(): void {
  if (customSink || isCI() || !reportingAllowed()) return;
  withTelemetryRecord((writer) => {
    if (!pendingReports(writer).length && !dailyCounters().length) return;
    enqueueJob(writer, { kind: "telemetry" });
    markPending(writer);
  });
}
/** Personal commands never do network I/O. CI has one bounded send. */
export async function flush(options: { deadlineMs?: number } = {}): Promise<void> {
  try {
    if (!telemetryEnabled().enabled) { abortReporting(); return; }
    if (isCI()) await flushCiReport(options.deadlineMs);
    else wakeTelemetry();
  } catch { /* best effort */ }
}
export function startHubTelemetry(): () => Promise<void> {
  const timer = telemetryEnabled().enabled && !isCI() ? setInterval(() => { wakeTelemetry(); if (!customSink) ensureBackground(); }, HUB_TELEMETRY_INTERVAL_MS) : undefined;
  timer?.unref();
  return async () => { if (timer) clearInterval(timer); await flush(); };
}
export function disableTelemetry(): { purged: boolean } {
  abortReporting();
  setGlobalConfigKey("telemetry", "off");
  return { purged: clearPendingReports() && purgeOutbox() };
}
export function enableTelemetry(): void {
  setGlobalConfigKey("telemetry", "on");
  showFirstRunNotice();
  recordLifecycle("on");
  wakeTelemetry();
}
/** Inspection never records usage, creates an ID, repairs storage, or sends. */
export function getTelemetryInspection(): Record<string, unknown> {
  return { schema_version: 3, ...telemetryEnabled(), notice_shown: readGlobalConfig().telemetryNoticeVersion === TELEMETRY_NOTICE_VERSION,
    endpoint: TELEMETRY_ENDPOINT, installation_id: isCI() ? null : readMachineId() ?? null, ci: isCI(),
    ...inspectReports(), limits: { queue: REPORT_QUEUE_LIMIT, history: REPORT_HISTORY_LIMIT, retention_days: 7 },
    catalog: { events: REPORT_EVENTS, counters: COUNTER_NAMES, count_ranges: COUNT_RANGES, agents: REPORT_AGENTS },
  };
}
export function showFirstRunNotice(): boolean {
  try {
    if (!telemetryEnabled().enabled) return false;
    if (isCI()) {
      if (ciDisclosureShown()) return false;
      process.stderr.write("mex: anonymous usage counts on · set MEX_TELEMETRY=0 to turn off\n");
      noteCiDisclosure(); return true;
    }
    if (!process.stderr.isTTY || readGlobalConfig().telemetryNoticeVersion === TELEMETRY_NOTICE_VERSION) return false;
    process.stderr.write("\nMEX sends anonymous usage counts to help improve it: never code, file paths,\nprompts or repo names. Turn off any time: mex telemetry off (or DO_NOT_TRACK=1)\nInspect: mex telemetry inspect\n\n");
    setGlobalConfigKey("telemetryNoticeVersion", TELEMETRY_NOTICE_VERSION);
    setGlobalConfigKey("firstRunNoticeShown", true);
    recordLifecycle("install.first_run", {}, Date.now(), "install");
    wakeTelemetry(); return true;
  } catch { return false; }
}
export function captureCommand(command: string, _scaffoldId?: string): void { captureEvent("cli.command_started", { command: command.replaceAll(" ", ".") }); }
export function capture(_event: string, command: string, _scaffoldId?: string): void { captureCommand(command); }
export function buildPayload(_command: string, _scaffoldId?: string): Record<string, unknown> {
  return { schema_version: 3, source: "person", installation_id: readMachineId() ?? "<installation UUID; not created by preview>",
    mex_version: VERSION, os: platform(), $process_person_profile: false, $geoip_disable: true, counts: { commands: "1" } };
}
export function getPayloadPreview(command: string, _scaffoldId?: string, _machineId?: string): Record<string, unknown> { return buildPayload(command); }
export function __setTransport(next: ((event: string, properties: Record<string, unknown>) => void) | null): void { customSink = next !== null; setReportingSink(next); }
export function __setTelemetryEndpointForTest(endpoint: string | null): void { setEndpointForTest(endpoint); }
export function __resetTelemetryForTest(): void { resetReporting(); customSink = false; closeOutbox(); setEndpointForTest(null); }
