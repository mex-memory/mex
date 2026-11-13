import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { setGlobalConfigKey, mexHomeDir } from "../../global-config.js";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { enqueueJob, registerJobKind, runOneBatch } from "../../record/jobs.js";
import { __resetTelemetryForTest, __setTransport, __setTelemetryEndpointForTest, captureEvent, flush, showFirstRunNotice, disableTelemetry, getTelemetryInspection, getProjectTelemetryContext } from "../index.js";
import { sendUsageReports } from "../reporting.js";
import { recordCounter, recordLifecycle, inspectReports, pruneReports, pendingReports, prepareDailyReports, REPORT_QUEUE_LIMIT } from "../store.js";
import { makeReport, validateReport, countRange, reportAttributes } from "../report-schema.js";
import { readSharedProjectTelemetryContext as readTelemetryProjectContext } from "../project-context.js";
import { sendBatch } from "../transport.js";

const NOW = Date.parse("2026-11-13T09:00:00.000Z");
const YESTERDAY = NOW - 86_400_000;
let root: string, cwd: string;
let writer: RecordWriter | undefined;
let server: Server | undefined;
let sent: Array<{ event: string; properties: Record<string, unknown> }>;
const stderrTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-v3-")); cwd = process.cwd(); process.chdir(root);
  vi.stubEnv("MEX_HOME", root); vi.stubEnv("MEX_DEV", ""); vi.stubEnv("MEX_BACKGROUND", "0");
  for (const key of ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "GITLAB_CI", "TF_BUILD", "BUILDKITE", "CIRCLECI", "JENKINS_URL", "DO_NOT_TRACK", "MEX_TELEMETRY", "MEX_OFFLINE"]) vi.stubEnv(key, "");
  __resetTelemetryForTest(); sent = [];
  __setTransport((event, properties) => sent.push({ event, properties }));
});
afterEach(async () => {
  __resetTelemetryForTest(); writer?.close(); writer = undefined;
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; }
  process.chdir(cwd); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  if (stderrTty) Object.defineProperty(process.stderr, "isTTY", stderrTty);
  else delete (process.stderr as { isTTY?: boolean }).isTTY;
});
function record(): RecordWriter { return writer ??= openRecord({ isNetwork: () => false }); }
function disclose(): void { setGlobalConfigKey("telemetryNoticeVersion", 3); }
async function endpoint(reply: (body: string, response: import("node:http").ServerResponse) => void): Promise<void> {
  __setTransport(null);
  server = createServer((req, res) => {
    let body = ""; req.on("data", (chunk) => { body += String(chunk); }); req.on("end", () => reply(body, res));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  __setTelemetryEndpointForTest(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/batch/`);
}

describe("v3 reporting boundary", () => {
  it("reports first setup once per checkout, retaining the local marker beyond the delivery window", () => {
    const context = getProjectTelemetryContext(root, "exact");
    const completed = { command: "setup", outcome: "success" as const, duration_ms: 10, ...context };
    captureEvent("cli.command_completed", completed);
    captureEvent("cli.command_completed", completed);
    expect(inspectReports().pending.filter((report) => report.event === "setup.finished")).toHaveLength(1);
    pruneReports(record(), Date.now() + 8 * 86_400_000);
    captureEvent("cli.command_completed", completed);
    expect(inspectReports().pending).toHaveLength(0);
    const other = join(root, "second-checkout"); mkdirSync(other);
    captureEvent("cli.command_completed", { ...completed, ...getProjectTelemetryContext(other, "exact") });
    expect(inspectReports().pending.filter((report) => report.event === "setup.finished")).toHaveLength(1);
    expect(JSON.stringify(inspectReports())).not.toContain(root);
  });

  it.each(["done", "failed", "taken-over"] as const)("counts only this runner's terminal job transition: %s", async (mode) => {
    const kind = `telemetry-test-${mode}`;
    registerJobKind({ name: kind, label: "Counter fixture", scope: "machine", sideEffects: "none",
      runBatch({ writer, job }) {
        if (mode === "failed") throw new Error("fixture failure");
        if (mode === "taken-over") writer.db.prepare("UPDATE jobs SET owner='peer',state='done' WHERE id=?").run(job.id);
        return { checkpoint: {}, done: true };
      },
    });
    enqueueJob(record(), { kind });
    for (let index = 0; index < 4; index++) await runOneBatch(record(), "fixture-owner");
    const rows = record().db.prepare("SELECT name,value FROM counters_node WHERE name LIKE 'jobs.%'").all();
    expect(rows).toEqual(mode === "taken-over" ? [] : [expect.objectContaining({ name: mode === "done" ? "jobs.completed" : "jobs.failed", value: 1 })]);
  });

  it("keeps command captures local, with no ID and no network before the v3 notice", async () => {
    setGlobalConfigKey("firstRunNoticeShown", true); // An old v2 notice is not the new notice.
    captureEvent("cli.command_started", { command: "check" });
    recordCounter("knowledge.delivered", 17, undefined, YESTERDAY);
    await flush();
    expect(await sendUsageReports(record(), NOW)).toBe(0);
    expect(sent).toEqual([]); expect(existsSync(join(mexHomeDir(), "telemetry-id"))).toBe(false);
    expect(record().db.prepare("SELECT value FROM counters_node WHERE name='commands'").get()?.value).toBe(1);
  });

  it("merges Go and Node counters, ranges every number, and sends a closed UTC day once", async () => {
    record(); disclose();
    recordCounter("knowledge.delivered", 17, undefined, YESTERDAY);
    const go = new DatabaseSync(writer!.location.hooks);
    go.exec("PRAGMA user_version=1; CREATE TABLE counters_go(day TEXT,name TEXT,value INTEGER,PRIMARY KEY(day,name))");
    const insert = go.prepare("INSERT INTO counters_go VALUES('2026-11-12',?,?)");
    insert.run("agent:codex:sessions", 4); insert.run("agent:codex:hook.calls", 30);
    insert.run("agent:codex:hook.ms.1", 28); insert.run("agent:codex:hook.ms.5", 2);
    insert.run("private/repository/name", 7); go.close();
    expect(await sendUsageReports(record(), NOW)).toBe(1);
    expect(sent).toEqual([{ event: "daily", properties: expect.objectContaining({ schema_version: 3,
      counts: { "knowledge.delivered": "6–20", sessions: "2–5", "hook.calls": "21–100" },
      by_agent: { codex: { counts: { sessions: "2–5", "hook.calls": "21–100" }, hook_p95_ms: "100+" } },
    }) }]);
    expect(JSON.stringify(sent)).not.toContain("private/repository");
    expect(await sendUsageReports(record(), NOW)).toBe(0);
    expect(inspectReports().sent).toHaveLength(1);
    expect(inspectReports().pending).toEqual([]);
  });

  it("does not send today's unfinished daily total", async () => {
    disclose(); recordCounter("commands", 3, undefined, NOW);
    expect(await sendUsageReports(record(), NOW)).toBe(0);
    expect(sent).toEqual([]);
  });

  it.each([[0,"0"],[1,"1"],[2,"2–5"],[5,"2–5"],[6,"6–20"],[20,"6–20"],[21,"21–100"],[100,"21–100"],[101,"100+"]])("ranges %i as %s", (n, range) => {
    expect(countRange(Number(n))).toBe(range);
  });

  it("rejects raw fields, unknown counters, forged stored reports and legacy events", () => {
    const id = randomUUID();
    expect(reportAttributes("daily", { counts: { commands: "1" }, prompt: "secret" })).toBe(false);
    expect(reportAttributes("daily", { counts: { "private/path": "1" } })).toBe(false);
    expect(reportAttributes("cli.command_started", { command: "check" })).toBe(false);
    expect(recordCounter("private/path" as never)).toBe(false);
    const report = makeReport("daily", { counts: { commands: "1" } }, id)!;
    expect(validateReport(report)).toBe(true);
    expect(validateReport({ ...report, properties: { ...report.properties, prompt: "secret" } })).toBe(false);
    const ci = makeReport("ci.run", { command: "check", outcome: "success" }, undefined)!;
    expect(validateReport(ci)).toBe(true);
    expect(validateReport({ ...ci, properties: { ...ci.properties, installation_id: id } })).toBe(false);
  });

  it.each(["DO_NOT_TRACK", "MEX_TELEMETRY", "MEX_OFFLINE"])("honors %s before capture and again before sending", async (key) => {
    disclose(); recordCounter("commands", 1, undefined, YESTERDAY);
    vi.stubEnv(key, key === "MEX_TELEMETRY" ? "0" : "1");
    expect(recordCounter("commands", 10)).toBe(false);
    expect(await sendUsageReports(record(), NOW)).toBe(0);
    expect(sent).toEqual([]); expect(existsSync(join(mexHomeDir(), "telemetry-id"))).toBe(false);
  });

  it("preserves an old opt-out through the upgrade notice", () => {
    setGlobalConfigKey("telemetry", "off");
    setGlobalConfigKey("firstRunNoticeShown", true);
    expect(showFirstRunNotice()).toBe(false);
    expect(recordCounter("commands")).toBe(false);
    expect(existsSync(join(mexHomeDir(), "record.db"))).toBe(false);
  });

  it("inspect and explicit off do not initialize an absent record or ID", () => {
    expect(getTelemetryInspection()).toMatchObject({ schema_version: 3, pending: [], sent: [] });
    expect(existsSync(mexHomeDir())).toBe(false);
    disableTelemetry();
    expect(readdirSync(mexHomeDir()).sort()).toEqual(["config.json", "telemetry-disabled"]);
  });

  it("records the v3 notice once and only after successfully writing its text", () => {
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(showFirstRunNotice()).toBe(true); expect(showFirstRunNotice()).toBe(false);
    expect(write.mock.calls.flat().join("")).toContain("mex telemetry off");
    expect(inspectReports().pending.filter((r) => r.event === "install.first_run")).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("has a hard queue cap and removes expired pending reports", () => {
    record();
    for (let n = 0; n < REPORT_QUEUE_LIMIT + 2; n++) recordLifecycle("on", {}, YESTERDAY);
    expect(pendingReports(record())).toHaveLength(REPORT_QUEUE_LIMIT);
    pruneReports(record(), NOW + 8 * 86_400_000);
    expect(pendingReports(record())).toEqual([]);
  });

  it("drops a contended counter promptly without changing the other writer's data", () => {
    recordCounter("commands", 1); const owner = record();
    owner.db.exec("BEGIN IMMEDIATE");
    try {
      const started = performance.now();
      expect(recordCounter("commands")).toBe(false);
      expect(performance.now() - started).toBeLessThan(100);
    } finally { owner.db.exec("ROLLBACK"); }
    expect(owner.db.prepare("SELECT value FROM counters_node WHERE name='commands'").get()?.value).toBe(1);
  });

  it("rejects a recursive settings view without evaluating it or changing its bytes", () => {
    mkdirSync(mexHomeDir());
    const path = join(mexHomeDir(),"record.db"), db = new DatabaseSync(path);
    db.exec("PRAGMA user_version=3; CREATE VIEW settings AS WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT 'telemetry.v3' scope,'pending:x' key,x value FROM n"); db.close();
    const before = readFileSync(path);
    expect(recordCounter("commands")).toBe(false);
    expect(getTelemetryInspection()).toMatchObject({ pending: [], sent: [] });
    expect(readFileSync(path)).toEqual(before);
  });

  it("never resurrects pre-opt-out Go counters after re-enabling", async () => {
    record(); disclose();
    const go = new DatabaseSync(writer!.location.hooks);
    go.exec("PRAGMA user_version=1; CREATE TABLE counters_go(day TEXT,name TEXT,value INTEGER,PRIMARY KEY(day,name)); INSERT INTO counters_go VALUES('2026-11-12','agent:codex:sessions',4)"); go.close();
    disableTelemetry(); setGlobalConfigKey("telemetry","on");
    expect(await sendUsageReports(record(),NOW)).toBe(0); expect(sent).toEqual([]);
    expect(getTelemetryInspection()).toMatchObject({ controls: [{ event: "off" }] });
  });

  it("drops oversized or tampered pending values before creating a reporting ID", async () => {
    record(); disclose(); recordLifecycle("on",{},NOW);
    writer!.db.prepare("UPDATE settings SET value=? WHERE scope='telemetry.v3' AND key LIKE 'pending:%'").run("x".repeat(16385));
    expect(await sendUsageReports(record(),NOW)).toBe(0);
    expect(existsSync(join(mexHomeDir(),"telemetry-id"))).toBe(false); expect(sent).toEqual([]);
  });
});

describe("CI and shared-project accounting", () => {
  it("emits one CI event, with a notice, and never mints an installation ID or database", async () => {
    vi.stubEnv("CI", "true"); const notice = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(notice).not.toHaveBeenCalled();
    captureEvent("cli.command_started", { command: "check" });
    expect(showFirstRunNotice()).toBe(false);
    expect(notice).toHaveBeenCalledOnce();
    captureEvent("cli.command_completed", { command: "check", outcome: "success", duration_ms: 17 });
    await flush(); await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event: "ci.run", properties: { source: "ci", command: "check", duration: "6–20" } });
    expect(sent[0].properties).not.toHaveProperty("installation_id");
    expect(existsSync(mexHomeDir())).toBe(false);
  });

  it("does not send CI before its notice", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    captureEvent("cli.command_completed", { command: "check", outcome: "success", duration_ms: 1 });
    await flush(); expect(sent).toEqual([]); expect(existsSync(mexHomeDir())).toBe(false);
  });

  it("never uses an unshared scaffold ID; requires a shared record and share-created random ID", () => {
    const id = randomUUID(); mkdirSync(join(root, ".mex"), { recursive: true });
    writeFileSync(join(root, ".mex", "config.json"), JSON.stringify({ scaffold_id: id }));
    expect(readTelemetryProjectContext(root, "exact")).toEqual({});
    writer = openRecord({ projectPath: root, isNetwork: () => false });
    const checkout = writer.checkout(root)!;
    expect(readTelemetryProjectContext(root, "exact")).toEqual({});
    writer.db.prepare("UPDATE projects SET shared=1 WHERE id=?").run(checkout.project_id);
    expect(readTelemetryProjectContext(root, "exact")).toEqual({});
    writer.db.prepare("INSERT INTO settings VALUES(?, 'shared.project_id', ?)").run(checkout.project_id, id);
    expect(readTelemetryProjectContext(root, "exact")).toEqual({ scaffold_id: id });
  });
});

describe("real report transport and recovery", () => {
  it("rejects an invalid payload at the transport boundary without opening a request", async () => {
    disclose(); let requests = 0;
    await endpoint((_body,response) => { requests++; response.end('{"status":1}'); });
    const report = makeReport("daily",{ counts: { commands: "1" } },randomUUID())!;
    expect(await sendBatch([{...report,properties:{...report.properties,prompt:"PRIVATE"}} as never]).done).toBe(false);
    expect(requests).toBe(0);
  });
  it("retries a rejected ACK with the same UUID and records only the successful send", async () => {
    disclose(); recordCounter("commands", 2, undefined, YESTERDAY);
    const bodies: Array<{ batch: unknown[] }> = [];
    await endpoint((body, response) => { bodies.push(JSON.parse(body)); response.end(JSON.stringify({ status: bodies.length === 1 ? 0 : 1 })); });
    expect(await sendUsageReports(record(), NOW)).toBe(0);
    expect(inspectReports().pending).toHaveLength(1); expect(inspectReports().sent).toEqual([]);
    expect(await sendUsageReports(record(), NOW)).toBe(1);
    expect(bodies[0].batch).toEqual(bodies[1].batch);
    expect(inspectReports().sent).toHaveLength(1);
  });

  it("serializes concurrent background and foreground reporters", async () => {
    disclose(); recordCounter("commands", 1, undefined, YESTERDAY);
    let requests = 0;
    await endpoint((_body, response) => { requests++; response.end('{"status":1}'); });
    const other = openRecord();
    try {
      const results = await Promise.all([sendUsageReports(record(), NOW), sendUsageReports(other, NOW)]);
      expect(results.reduce((a,b) => a+b)).toBe(1); expect(requests).toBe(1);
    } finally { other.close(); }
  });

  it("aborts a real in-flight request when the user opts out", async () => {
    disclose(); recordCounter("commands", 1, undefined, YESTERDAY);
    let arrived!: () => void;
    const received = new Promise<void>((resolve) => { arrived = resolve; });
    await endpoint(() => arrived());
    const sending = sendUsageReports(record(), NOW);
    await received; disableTelemetry();
    expect(await sending).toBe(0); expect(inspectReports().pending).toEqual([]);
  });
});
