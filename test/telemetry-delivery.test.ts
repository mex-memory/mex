import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Resolver } from "node:dns";
import { createSocket } from "node:dgram";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build, stop as stopEsbuild } from "esbuild";
import { openSqlite } from "../src/graph/db/sqlite.js";
import { getMachineId, readMachineId, readGlobalConfig, setGlobalConfigKey } from "../src/global-config.js";
import { __resetTelemetryForTest, __setTelemetryEndpointForTest, __setTransport, captureEvent, disableTelemetry,
  flush, getTelemetryInspection, isEnabled, startHubTelemetry } from "../src/telemetry/index.js";
import { claimBatch, closeOutbox, enqueue, finishBatch, inspectOutbox, OUTBOX_LIMITS, purgeOutbox } from "../src/telemetry/outbox.js";
import { eventAttributes, makeEvent, validateStoredEvent, type TelemetryAttributes, type TelemetryEvent } from "../src/telemetry/schema.js";

let root: string;
let cwd: string;
let prior: Record<string, string | undefined>;
const servers: Server[] = [];
const pause = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
beforeEach(() => {
  cwd = process.cwd();
  prior = Object.fromEntries(["MEX_HOME", "MEX_TELEMETRY", "DO_NOT_TRACK", "MEX_DEV"].map((key) => [key, process.env[key]]));
  root = mkdtempSync(join(tmpdir(), "mex-telemetry-delivery-"));
  process.chdir(root);
  process.env.MEX_HOME = root;
  delete process.env.MEX_TELEMETRY; delete process.env.DO_NOT_TRACK; delete process.env.MEX_DEV;
  __resetTelemetryForTest();
  // Even an accidentally enabled capture can only reach a refused LOOPBACK port.
  __setTelemetryEndpointForTest("http://127.0.0.1:1/batch/");
});
afterEach(async () => {
  __resetTelemetryForTest();
  await pause();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.chdir(cwd);
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});
async function endpoint(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  const url = `http://127.0.0.1:${address.port}/batch/`;
  __setTelemetryEndpointForTest(url);
  return url;
}
function event(now = Date.now()): TelemetryEvent {
  return makeEvent("cli.command_completed", { command: "wiki.query", outcome: "success", duration_ms: 3 }, getMachineId(), now)!;
}
const dbPath = () => join(root, ".mex", "telemetry", "outbox.db");

describe("closed event schema", () => {
  it.each([
    ["cli.command_started", { command: "wiki.query", query: "PRIVATE" }],
    ["cli.command_started", { command: "/private/path" }],
    ["cli.command_started", { command: undefined }],
    ["cli.command_completed", { command: "check", outcome: undefined, duration_ms: 1 }],
    ["cli.command_completed", { command: "check", outcome: "success", duration_ms: undefined }],
    ["cli.command_completed", { command: "check", outcome: "success", duration_ms: Infinity }],
    ["cli.command_completed", { command: "check", outcome: "success", duration_ms: -1 }],
    ["hub.page_viewed", { page: "knowledge/secret" }],
    ["hub.action_completed", { action: "relay.publish", stage: "preview", outcome: "success", duration_ms: 1, replayed: true }],
    ["private.event", {}],
  ])("rejects untrusted or incomplete %s attributes before identity creation", (name, attrs) => {
    expect(eventAttributes(name, attrs)).toBeUndefined();
    const captured = vi.fn(); __setTransport(captured);
    captureEvent(name as "cli.command_started", attrs as TelemetryAttributes);
    expect(captured).not.toHaveBeenCalled();
    expect(existsSync(join(root, ".mex"))).toBe(false);
  });
  it("uses the same installation ID for CLI and Hub, without project or person fields", () => {
    const calls: Record<string, unknown>[] = [];
    __setTransport((_name, attrs) => { calls.push(attrs); });
    captureEvent("cli.command_started", { command: "wiki.query", stage: "direct" });
    captureEvent("hub.page_viewed", { page: "knowledge" });
    expect(calls).toHaveLength(2);
    expect(calls[0].installation_id).toBe(calls[1].installation_id);
    expect(calls[0]).toMatchObject({ schema_version: 2, source: "cli", $process_person_profile: false, $geoip_disable: true });
    expect(calls[1].source).toBe("hub");
    expect(JSON.stringify(calls)).not.toMatch(/scaffold_id|machine_id|member_id|email|session_id/);
  });
  it("rechecks persisted property values and envelope keys, not just live callers", () => {
    const item = event();
    expect(validateStoredEvent(item)).toBe(true);
    expect(validateStoredEvent({ ...item, properties: { ...item.properties, command: "private project" } })).toBe(false);
    expect(validateStoredEvent({ ...item, properties: { ...item.properties, path: "private" } })).toBe(false);
    expect(validateStoredEvent({ ...item, unexpected: "private" })).toBe(false);
  });
  it("never sends malformed identity bytes or overwrites the identity file", () => {
    mkdirSync(join(root, ".mex"));
    const file = join(root, ".mex", "telemetry-id");
    writeFileSync(file, "person@example.com");
    const captured = vi.fn(); __setTransport(captured);
    captureEvent("hub.page_viewed", { page: "knowledge" });
    expect(captured).not.toHaveBeenCalled();
    expect(readMachineId()).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("person@example.com");
    expect(JSON.stringify(getTelemetryInspection())).not.toContain("person@example.com");
  });
});

describe("bounded persistent outbox", () => {
  it("retains events through reopening, with their original timestamp and deduplication UUID", () => {
    const item = event(Date.now() - 10_000);
    expect(enqueue(item)).toBe(true);
    closeOutbox();
    const batch = claimBatch();
    expect(batch?.events).toEqual([item]);
    finishBatch(batch!, false);
    closeOutbox();
    const retry = claimBatch();
    expect(retry?.events).toEqual([item]);
    finishBatch(retry!, true);
    expect(inspectOutbox()).toEqual({ state: "available", events: 0, bytes: 0 });
  });
  it("caps rows, payload bytes and actual database size; drops oldest and expires old data", () => {
    const now = Date.now();
    const expired = event(now - OUTBOX_LIMITS.ageMs - 1);
    enqueue(expired, now - OUTBOX_LIMITS.ageMs - 1);
    for (let i = 0; i < OUTBOX_LIMITS.events + 8; i++) expect(enqueue(event(now + i), now + i)).toBe(true);
    const status = inspectOutbox();
    expect(status.events).toBe(OUTBOX_LIMITS.events);
    expect(status.bytes).toBeLessThanOrEqual(OUTBOX_LIMITS.bytes);
    expect(statSync(dbPath()).size).toBeLessThanOrEqual(OUTBOX_LIMITS.databaseBytes);
    const batch = claimBatch(now + 1000)!;
    expect(batch.events).toHaveLength(OUTBOX_LIMITS.batchEvents);
    expect(batch.events.some((row) => row.uuid === expired.uuid)).toBe(false);
    expect(batch.events[0].timestamp).toBe(new Date(now + 8).toISOString());
  });
  it("uses disjoint delivery claims and recovers a crashed sender's expired claim", () => {
    const now = Date.now();
    for (let i = 0; i < 40; i++) enqueue(event(now), now);
    const first = claimBatch(now)!;
    closeOutbox();
    const second = claimBatch(now)!;
    expect(first.events).toHaveLength(32); expect(second.events).toHaveLength(8);
    expect(second.events.some((item) => first.events.some((earlier) => item.uuid === earlier.uuid))).toBe(false);
    closeOutbox();
    const afterCrash = claimBatch(now + OUTBOX_LIMITS.leaseMs + 1)!;
    expect(afterCrash.events).toEqual(first.events);
  });
  it("drops a contended enqueue immediately, preserving the other writer's events", () => {
    const first = event(); enqueue(first); closeOutbox();
    const owner = openSqlite(dbPath()); owner.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    try {
      expect(enqueue(event())).toBe(false);
      expect(performance.now() - started).toBeLessThan(100);
      expect(purgeOutbox()).toBe(false);
    } finally { owner.exec("ROLLBACK"); owner.close(); }
    expect(claimBatch()?.events).toEqual([first]);
  });
  it("never sends malformed on-disk payloads", () => {
    enqueue(event()); closeOutbox();
    const db = openSqlite(dbPath());
    db.exec("UPDATE events SET payload='{}'"); db.close();
    expect(claimBatch()).toBeUndefined();
    expect(inspectOutbox().events).toBe(0);
  });
  it("does not send an expired payload hidden behind a fresh occurred column", () => {
    const old = event(Date.now() - OUTBOX_LIMITS.ageMs - 1000);
    enqueue(event()); closeOutbox();
    const db = openSqlite(dbPath());
    db.prepare("UPDATE events SET uuid=?,payload=?").run(old.uuid, JSON.stringify(old)); db.close();
    expect(claimBatch()).toBeUndefined();
    expect(inspectOutbox().events).toBe(0);
  });
  it("rejects user triggers whose names resemble SQLite internal objects", () => {
    enqueue(event()); closeOutbox();
    const db = openSqlite(dbPath());
    db.exec("CREATE TRIGGER sqliteXunexpected AFTER INSERT ON events BEGIN DELETE FROM events; END"); db.close();
    const before = readFileSync(dbPath());
    expect(enqueue(event())).toBe(false);
    expect(inspectOutbox().state).toBe("unavailable");
    expect(readFileSync(dbPath())).toEqual(before);
  });
  it("retains every acknowledged enqueue from concurrent real processes", async () => {
    const first = event(); enqueue(first); closeOutbox();
    const directory = join(root, "worker-dist"); mkdirSync(directory);
    const worker = join(directory, "queue-worker.mjs");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "telemetry-worker-fixture", version: JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).version }));
    try {
      await build({ stdin: { contents: `
        import {enqueue,closeOutbox} from ${JSON.stringify(join(cwd, "src/telemetry/outbox.ts"))};
        import {makeEvent} from ${JSON.stringify(join(cwd, "src/telemetry/schema.ts"))};
        import {getMachineId} from ${JSON.stringify(join(cwd, "src/global-config.ts"))};
        const ids=[];
        for(let i=0;i<10;i++) {
          const event=makeEvent('cli.command_started',{command:'check'},getMachineId());
          if(enqueue(event)) ids.push(event.uuid);
        }
        closeOutbox(); process.stdout.write(JSON.stringify(ids));
      `, sourcefile: "queue-worker.ts", resolveDir: cwd }, outfile: worker, bundle: true,
        packages: "external", platform: "node", format: "esm", target: "node22", logLevel: "silent" });
    } finally { await stopEsbuild(); }
    const results = await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath, [worker], {
      cwd: root, env: { ...process.env, MEX_TELEMETRY: "0" }, timeout: 5000, maxBuffer: 32768,
    })));
    const accepted = results.flatMap((result) => JSON.parse(result.stdout) as string[]);
    expect(accepted.length).toBeGreaterThan(0);
    const retained = claimBatch()!.events.map((item) => item.uuid);
    expect(new Set(retained)).toEqual(new Set([first.uuid, ...accepted]));
  });
  it("rejects arbitrary schemas on inspect without evaluating a recursive view or modifying bytes", () => {
    mkdirSync(join(root, ".mex", "telemetry"), { recursive: true });
    const db = openSqlite(dbPath());
    db.exec("CREATE VIEW events AS WITH RECURSIVE counter(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM counter) SELECT n AS payload FROM counter"); db.close();
    const before = readFileSync(dbPath());
    expect(inspectOutbox().state).toBe("unavailable");
    expect(enqueue(event())).toBe(false);
    expect(readFileSync(dbPath())).toEqual(before);
  });
  it("derives its page-count cap from large SQLite pages", () => {
    mkdirSync(join(root, ".mex", "telemetry"), { recursive: true });
    const db = openSqlite(dbPath()); db.exec("PRAGMA page_size=65536"); db.exec("VACUUM"); db.close();
    expect(enqueue(event())).toBe(true);
    // This cap belongs to the live writer connection, not the database header.
    const batch = claimBatch()!;
    expect(batch.queue.db.prepare("PRAGMA max_page_count").get()).toMatchObject({ max_page_count: 16 });
    expect(statSync(dbPath()).size).toBeLessThanOrEqual(OUTBOX_LIMITS.databaseBytes);
  });
});

describe("noninitializing audit and filesystem containment", () => {
  it("keeps explicit opt-out after a stale unrelated writer restores telemetry:on in JSON", () => {
    setGlobalConfigKey("telemetry", "on");
    const stale = { ...readGlobalConfig(), feedbackInviteCount: 1 };
    expect(disableTelemetry()).toEqual({ purged: true });
    // Reproduce the final step of a different process that read before disable:
    // atomically publish its stale merged preferences AFTER disable returned.
    const temp = join(root, ".mex", "stale-writer.tmp");
    writeFileSync(temp, JSON.stringify(stale)); renameSync(temp, join(root, ".mex", "config.json"));
    expect(readGlobalConfig().telemetry).toBe("on");
    expect(isEnabled()).toEqual({ enabled: false, reason: "config" });
    const captured = vi.fn(); __setTransport(captured);
    captureEvent("cli.command_started", { command: "check" });
    expect(captured).not.toHaveBeenCalled();
    const marker = join(root, ".mex", "telemetry-disabled");
    const before = statSync(marker, { bigint: true });
    setGlobalConfigKey("feedbackDismissed", true);
    setGlobalConfigKey("telemetry", "off");
    const after = statSync(marker, { bigint: true });
    expect(after.ino).toBe(before.ino); expect(after.dev).toBe(before.dev);
    expect(after.size).toBe(0n);
    if (process.platform !== "win32") expect(Number(after.mode & 0o777n)).toBe(0o600);
    setGlobalConfigKey("telemetry", "on");
    expect(existsSync(marker)).toBe(false); expect(isEnabled().enabled).toBe(true);
  });
  it("does not reinterpret malformed UTF-8 as an absent telemetry preference", () => {
    mkdirSync(join(root, ".mex"));
    // A replacement decoder would silently turn this invalid key into an
    // unrelated property and use the default-on telemetry preference.
    const bytes = Buffer.concat([Buffer.from('{"telemetr'), Buffer.from([0xff]), Buffer.from('y":"off"}')]);
    writeFileSync(join(root, ".mex", "config.json"), bytes);
    expect(isEnabled()).toEqual({ enabled: false, reason: "config_unavailable" });
    expect(readFileSync(join(root, ".mex", "config.json"))).toEqual(bytes);
  });
  it("fails closed on an unexpected opt-out marker and refuses to erase it on enable", () => {
    mkdirSync(join(root, ".mex"));
    const marker = join(root, ".mex", "telemetry-disabled"); mkdirSync(marker);
    expect(isEnabled()).toEqual({ enabled: false, reason: "config" });
    expect(() => setGlobalConfigKey("telemetry", "on")).toThrow("Unsafe MEX telemetry opt-out marker");
    expect(statSync(marker).isDirectory()).toBe(true);
  });
  it("retains the marker when a preference-write failure prevents enable", () => {
    disableTelemetry();
    const config = join(root, ".mex", "config.json"); rmSync(config); mkdirSync(config);
    expect(() => setGlobalConfigKey("telemetry", "on")).toThrow();
    expect(existsSync(join(root, ".mex", "telemetry-disabled"))).toBe(true);
    expect(isEnabled()).toEqual({ enabled: false, reason: "config" });
  });
  it.runIf(process.platform !== "win32")("never follows or removes a linked opt-out marker", () => {
    mkdirSync(join(root, ".mex"));
    const target = join(root, "keep"); writeFileSync(target, "private");
    const marker = join(root, ".mex", "telemetry-disabled"); symlinkSync(target, marker);
    expect(isEnabled()).toEqual({ enabled: false, reason: "config" });
    expect(() => setGlobalConfigKey("telemetry", "on")).toThrow();
    expect(() => setGlobalConfigKey("telemetry", "off")).toThrow();
    expect(readFileSync(target, "utf8")).toBe("private");
    expect(existsSync(marker)).toBe(true);
  });
  it.each(["{bad json", "[]", '{"telemetry":"unexpected"}', "x".repeat(65537)])("fails closed on invalid existing preferences without replacing them", (contents) => {
    mkdirSync(join(root, ".mex"));
    const config = join(root, ".mex", "config.json"); writeFileSync(config, contents);
    expect(isEnabled()).toEqual({ enabled: false, reason: "config_unavailable" });
    captureEvent("cli.command_started", { command: "check" });
    expect(existsSync(join(root, ".mex", "telemetry-id"))).toBe(false);
    expect(readFileSync(config, "utf8")).toBe(contents);
  });
  it("atomically updates the opt-out while preserving other preferences", () => {
    setGlobalConfigKey("feedbackDismissed", true);
    const config = join(root, ".mex", "config.json");
    const before = statSync(config, { bigint: true });
    expect(disableTelemetry()).toEqual({ purged: true });
    const after = statSync(config, { bigint: true });
    expect(before.ino === after.ino && before.dev === after.dev).toBe(false);
    expect(readGlobalConfig()).toEqual({ feedbackDismissed: true, telemetry: "off" });
    expect(readdirSync(join(root, ".mex"))).toEqual(["config.json", "telemetry-disabled"]);
  });
  it.runIf(process.platform !== "win32")("refuses a linked global config on both capture and explicit disable", () => {
    mkdirSync(join(root, ".mex"));
    const target = join(root, "original.json"); writeFileSync(target, '{"private":"keep"}');
    symlinkSync(target, join(root, ".mex", "config.json"));
    expect(isEnabled()).toEqual({ enabled: false, reason: "config_unavailable" });
    expect(() => disableTelemetry()).toThrow("Unsafe MEX preference file");
    expect(readFileSync(target, "utf8")).toBe('{"private":"keep"}');
  });
  it("inspect never creates files, even with telemetry enabled", () => {
    expect(getTelemetryInspection()).toMatchObject({ enabled: true, installation_id: null, queue: { state: "absent", events: 0 } });
    expect(readdirSync(root)).toEqual([]);
  });
  it("inspect leaves existing database bytes and directory entries unchanged", () => {
    enqueue(event()); closeOutbox();
    const before = readFileSync(dbPath()); const files = readdirSync(join(root, ".mex", "telemetry"));
    getTelemetryInspection();
    expect(readFileSync(dbPath())).toEqual(before);
    expect(readdirSync(join(root, ".mex", "telemetry"))).toEqual(files);
  });
  it.runIf(process.platform !== "win32")("refuses linked store directories, databases and identity files", () => {
    const outside = join(root, "outside"); mkdirSync(outside);
    mkdirSync(join(root, ".mex"));
    symlinkSync(outside, join(root, ".mex", "telemetry"), "dir");
    expect(enqueue(event())).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(join(root, ".mex", "telemetry")).isSymbolicLink()).toBe(true);
    unlinkSync(join(root, ".mex", "telemetry")); mkdirSync(join(root, ".mex", "telemetry"));
    const other = join(outside, "other"); writeFileSync(other, "do not change");
    symlinkSync(other, dbPath());
    expect(enqueue(event())).toBe(false);
    expect(readFileSync(other, "utf8")).toBe("do not change");
    rmSync(join(root, ".mex", "telemetry-id")); symlinkSync(other, join(root, ".mex", "telemetry-id"));
    expect(readMachineId()).toBeUndefined();
    expect(() => getMachineId()).toThrow();
    expect(readFileSync(other, "utf8")).toBe("do not change");
  });
});

describe("silent bounded delivery", () => {
  it("cancels a real DNS lookup sent only to a loopback UDP blackhole", async () => {
    const blackhole = createSocket("udp4");
    blackhole.bind(0, "127.0.0.1"); await once(blackhole, "listening");
    const address = blackhole.address();
    let queries = 0; blackhole.on("message", () => { queries++; });
    const original = Resolver.prototype.resolve4;
    const callbacks: string[] = [];
    const resolve = vi.spyOn(Resolver.prototype, "resolve4").mockImplementation(function(this: Resolver, hostname: string, callback: any) {
      expect(hostname).toBe("us.i.posthog.com");
      this.setServers([`127.0.0.1:${address.port}`]);
      return original.call(this, hostname, (error, values) => { callbacks.push(error?.code ?? "resolved"); callback(error, values); });
    });
    const cancel = vi.spyOn(Resolver.prototype, "cancel");
    try {
      // DNS is hard-pinned to the blackhole above before any resolver call; no
      // PostHog address can be resolved and no production connection can start.
      __setTelemetryEndpointForTest(null);
      const firstQuery = once(blackhole, "message", { signal: AbortSignal.timeout(1000) });
      captureEvent("cli.command_started", { command: "check" });
      // Observe an in-flight query before measuring cancellation. A fixed sleep
      // can leave scheduled dispatch and cold HTTPS setup inside this interval.
      await firstQuery;
      expect(callbacks).toEqual([]); expect(cancel).not.toHaveBeenCalled();
      const started = performance.now(); await flush({ deadlineMs: 25 });
      expect(performance.now() - started).toBeLessThan(150);
      await pause(10);
      expect(resolve).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalled();
      expect(queries).toBeGreaterThan(0); expect(callbacks).toEqual(["ECANCELLED"]);
      const count = queries; await pause(25); expect(queries).toBe(count);
      expect(inspectOutbox().events).toBe(1);
    } finally {
      __setTelemetryEndpointForTest("http://127.0.0.1:1/batch/");
      resolve.mockRestore(); cancel.mockRestore();
      await new Promise<void>((done) => blackhole.close(() => done()));
    }
  });
  it("explicit disable aborts an in-flight request and clears its queued claim", async () => {
    let started!: () => void; const received = new Promise<void>((resolve) => { started = resolve; });
    await endpoint((request) => { request.resume(); started(); });
    captureEvent("cli.command_started", { command: "check" }); await received;
    expect(disableTelemetry()).toEqual({ purged: true });
    await flush(); expect(inspectOutbox().events).toBe(0);
    expect(isEnabled()).toEqual({ enabled: false, reason: "config" });
  });
  it("sends one correct batch, then removes only acknowledged events", async () => {
    const bodies: Array<{ batch: TelemetryEvent[] }> = [];
    await endpoint((request, response) => {
      let body = ""; request.on("data", (part) => { body += part; });
      request.on("end", () => { bodies.push(JSON.parse(body)); response.end('{"status":1}'); });
    });
    captureEvent("cli.command_started", { command: "wiki.query", stage: "direct" });
    captureEvent("cli.command_completed", { command: "wiki.query", stage: "direct", outcome: "success", duration_ms: 5 });
    await flush({ deadlineMs: 50 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].batch.map((item) => item.event)).toEqual(["cli.command_started", "cli.command_completed"]);
    expect(bodies[0].batch.every(validateStoredEvent)).toBe(true);
    expect(inspectOutbox().events).toBe(0);
    captureEvent("cli.command_started", { command: "check" });
    await flush({ deadlineMs: 50 });
    expect(bodies).toHaveLength(1);
    expect(inspectOutbox().events).toBe(1);
  });
  it("retains an unavailable batch and aborts a hung request within the flush grace", async () => {
    await endpoint((request) => { request.resume(); });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    captureEvent("cli.command_started", { command: "check" });
    await pause(5);
    const started = performance.now();
    await flush({ deadlineMs: 25 });
    expect(performance.now() - started).toBeLessThan(150); // scheduler headroom; whole-process harness owns performance gate
    expect(inspectOutbox().events).toBe(1);
    expect(stderr).not.toHaveBeenCalled();
  });
  it("never follows an ingestion redirect", async () => {
    let calls = 0;
    await endpoint((_request, response) => { calls++; response.writeHead(302, { Location: "https://example.com/private" }); response.end(); });
    captureEvent("cli.command_started", { command: "check" }); await flush({ deadlineMs: 50 });
    expect(calls).toBe(1); expect(inspectOutbox().events).toBe(1);
  });
  it("checks opt-out again before scheduled send; explicit disable clears queued events", async () => {
    let calls = 0;
    await endpoint((_request, response) => { calls++; response.end('{"status":1}'); });
    captureEvent("cli.command_started", { command: "check" });
    process.env.DO_NOT_TRACK = "1";
    await flush();
    expect(calls).toBe(0); expect(inspectOutbox().events).toBe(1);
    expect(disableTelemetry()).toEqual({ purged: true });
    expect(inspectOutbox().events).toBe(0);
    captureEvent("cli.command_started", { command: "check" });
    expect(inspectOutbox().events).toBe(0);
  });
  it("batches Hub activity at lifecycle shutdown without counting idle timer ticks", async () => {
    const batches: TelemetryEvent[][] = [];
    await endpoint((request, response) => {
      let body = ""; request.on("data", (part) => { body += part; });
      request.on("end", () => { batches.push(JSON.parse(body).batch); response.end('{"status":1}'); });
    });
    const stop = startHubTelemetry();
    captureEvent("hub.session_started"); captureEvent("hub.page_viewed", { page: "knowledge" });
    await pause(5); expect(batches).toHaveLength(0);
    await stop(); await stop();
    expect(batches).toHaveLength(1); expect(batches[0]).toHaveLength(2);
  });
  it("the test endpoint seam cannot be directed to a remote origin or arbitrary path", () => {
    for (const value of ["https://us.i.posthog.com/batch/", "http://example.com:80/batch/", "http://127.0.0.1:80/private", "http://user@127.0.0.1:80/batch/"]) {
      expect(() => __setTelemetryEndpointForTest(value)).toThrow();
    }
  });
});
