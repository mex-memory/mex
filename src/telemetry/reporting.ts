/** The background process owns personal reporting. CLI flush sends only CI's one event. */
import { randomUUID } from "node:crypto";
import { getMachineId } from "../global-config.js";
import { registerJobKind } from "../record/jobs.js";
import type { RecordWriter } from "../record/index.js";
import { reportingAllowed, telemetryEnabled, isCI } from "./policy.js";
import { makeReport, validateReport, type ReportAttributes, type UsageReport } from "./report-schema.js";
import { pendingReports, parsePending, prepareDailyReports, pruneReports, getSetting, setting, deleteSetting, transaction, utcDay } from "./store.js";
import { sendBatch, type BatchRequest } from "./transport.js";

type Sink = (event: string, properties: Record<string, unknown>) => void;
let sink: Sink | null = null;
let active: BatchRequest | undefined;
let ciNoticeShown = false;
let ciPending: ReportAttributes | undefined;
let ciAttempted = false;

export function setReportingSink(next: Sink | null): void { sink = next; }
export function noteCiDisclosure(): void { ciNoticeShown = true; }
export function ciDisclosureShown(): boolean { return ciNoticeShown; }
export function queueCiReport(attributes: ReportAttributes): void {
  if (isCI() && telemetryEnabled().enabled && !ciAttempted) ciPending = attributes;
}
export function abortReporting(): void { active?.abort(); }
export function resetReporting(): void {
  abortReporting(); active = undefined; sink = null; ciNoticeShown = false; ciPending = undefined; ciAttempted = false;
}

async function deliver(report: UsageReport, allowed: () => boolean, deadlineMs = 2000): Promise<boolean> {
  if (!allowed() || !validateReport(report)) return false;
  if (sink) { sink(report.event, report.properties as unknown as Record<string, unknown>); return true; }
  const request = sendBatch([report]);
  active = request;
  const timer = setTimeout(() => request.abort(), Math.min(2000, Math.max(0, deadlineMs)));
  try { return await request.done; }
  finally { clearTimeout(timer); request.abort(); if (active === request) active = undefined; }
}

export async function flushCiReport(deadlineMs = 2000): Promise<void> {
  if (!ciPending || ciAttempted || !isCI() || !ciNoticeShown || !telemetryEnabled().enabled) return;
  const report = makeReport("ci.run", ciPending, undefined);
  ciPending = undefined; ciAttempted = true;
  if (report) await deliver(report, () => ciNoticeShown && telemetryEnabled().enabled, deadlineMs);
}

/** Bounded, restart-safe batch. Stable UUIDs make a retry after a lost ACK idempotent. */
export async function sendUsageReports(writer: RecordWriter, now = Date.now()): Promise<number> {
  if (isCI() || !reportingAllowed()) return 0;
  const owner = randomUUID();
  const acquired = transaction(writer, () => {
    const raw = getSetting(writer, "lease");
    if (raw) {
      try { const lease = JSON.parse(raw) as { expires: number }; if (Number.isFinite(lease.expires) && lease.expires > now && lease.expires <= now + 60_000) return false; }
      catch { /* Replace a malformed/expired private lease. */ }
    }
    setting(writer, "lease", JSON.stringify({ owner, expires: now + 60_000 }));
    return true;
  });
  if (!acquired) return 0;
  let sent = 0;
  try {
    pruneReports(writer, now);
    prepareDailyReports(writer, now);
    for (const row of pendingReports(writer).slice(0, 8)) {
      if (!reportingAllowed()) break;
      const item = parsePending(row.value);
      if (!item || item.event === "ci.run") { deleteSetting(writer, row.key); continue; }
      const report = makeReport(item.event, item.attributes, getMachineId(), Date.parse(item.timestamp), item.uuid);
      if (!report || !validateReport(report)) { deleteSetting(writer, row.key); continue; }
      if (!await deliver(report, reportingAllowed)) break;
      transaction(writer, () => {
        if (getSetting(writer, row.key) !== row.value) return;
        setting(writer, `history:${report.timestamp}:${report.uuid}`, JSON.stringify(report));
        deleteSetting(writer, row.key);
      });
      sent++;
    }
    pruneReports(writer, now);
    return sent;
  } finally {
    try {
      const current = getSetting(writer, "lease");
      if (current && (JSON.parse(current) as { owner?: string }).owner === owner) deleteSetting(writer, "lease");
    } catch { /* The bounded lease expires after an interrupted writer. */ }
  }
}

registerJobKind({
  name: "telemetry", label: "Usage reporting", scope: "machine", machineExclusive: true, sideEffects: "idempotent",
  async runBatch({ writer }) {
    const sent = await sendUsageReports(writer);
    // Failure is deferred to later use, never a retry loop that keeps the background process alive.
    return { checkpoint: { day: utcDay() }, results: sent, done: true, summary: `${sent} usage reports sent` };
  },
});
