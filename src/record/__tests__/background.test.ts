import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "tsup";
import type { RecordWriter } from "../index.js";

/**
 * Real background processes, killed for real. The entry is bundled once into a temp
 * folder (with a package.json beside it, as in the installed package), so these tests
 * don't depend on dist/ being built.
 */
let bundle: string;
let mod: typeof import("../background.js");
let records: typeof import("../index.js");
let jobs: typeof import("../jobs.js");
const pids: number[] = [];
let home: string, writer: RecordWriter;

const env = {
  MEX_JOBS_DEMO: "1", MEX_BACKGROUND_POLL_MS: "50", MEX_BACKGROUND_HEARTBEAT_MS: "100",
  MEX_BACKGROUND_LEASE_MS: "2000", MEX_BACKGROUND_TAKEOVER_MS: "8000",
};

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "mex-bg-bundle-"));
  writeFileSync(join(root, "package.json"), readFileSync(resolve("package.json")));
  await build({
    entry: { entry: resolve("src/record/background-entry.ts") }, outDir: join(root, "dist"), format: ["esm"],
    platform: "node", target: "node22", splitting: false, sourcemap: false, dts: false, clean: false, silent: true, config: false,
  });
  bundle = join(root, "dist", "entry.js");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  // Registration of the demo kind reads MEX_JOBS_DEMO when the module loads.
  mod = await import("../background.js");
  records = await import("../index.js");
  jobs = await import("../jobs.js");
}, 120_000);
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mex-bg-"));
  writer = records.openRecord({ home: join(home, "record"), isNetwork: () => false });
});
afterEach(() => {
  for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  writer.close();
});
afterAll(() => vi.unstubAllEnvs());

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until<T>(read: () => T, ok: (value: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() > end) throw new Error(`Timed out; last value ${JSON.stringify(value)}`);
    await sleep(50);
  }
}
const lease = () => writer.db.prepare("SELECT * FROM background WHERE id=1").get() as { owner: string | null; pid: number | null; version: string | null; request: string | null };
const job = (id: string) => writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as { state: string; batch: number; results: number; owner: string | null };
const resultRows = (id: string) => (writer.db.prepare("SELECT batch FROM job_results WHERE job_id=? ORDER BY batch").all(id) as Array<{ batch: number }>).map((row) => row.batch);
function start(extra: Record<string, string> = {}, force = true) {
  const result = mod.ensureBackground({ home: writer.location.home, entry: bundle, args: [], force, env: { ...process.env, ...extra } });
  if (result.started) pids.push(result.pid);
  return result;
}
function queueDemo(params: Record<string, unknown>) {
  const project = join(home, "repo"); mkdirSync(project, { recursive: true });
  const identity = records.projectIdentity(project);
  writer.register(identity);
  return mod.queueJob(writer, { kind: "demo", projectId: identity.id, params }).job;
}
const alive = (pid: number) => jobs.processAlive(pid);

describe("the background process, for real", () => {
  it.each([1, 3, 5])("killed hard during batch %i leaves no partial batch and redoes at most one", async (killAt) => {
    const trace = join(home, "trace.txt");
    const queued = queueDemo({ batches: 8, delayMs: 300, traceFile: trace });
    const first = start();
    expect(first.started).toBe(true);
    const pid = (first as { pid: number }).pid;
    await until(() => job(queued.id).batch, (batch) => batch >= killAt);
    // Inside the next batch's delay.
    await sleep(100);
    process.kill(pid, "SIGKILL");
    await until(() => alive(pid), (value) => !value);
    const afterKill = job(queued.id);
    expect(afterKill.state).toBe("running");
    expect(resultRows(queued.id)).toEqual([...Array(afterKill.batch).keys()]);
    expect(afterKill.results).toBe(afterKill.batch);

    const second = start();
    expect(second.started).toBe(true);
    await until(() => job(queued.id).state, (state) => state === "done");
    expect(resultRows(queued.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(job(queued.id).results).toBe(8);
    const runs = readFileSync(trace, "utf8").trim().split("\n").map(Number);
    expect(runs.length).toBeLessThanOrEqual(9);
    expect(new Set(runs)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
  }, 60_000);

  it("ends with one process when two start at once", async () => {
    queueDemo({ batches: 3, delayMs: 200 });
    const children = [0, 1].map(() => spawn(process.execPath, [bundle], {
      env: { ...process.env, MEX_BACKGROUND: "1", MEX_RECORD_HOME: writer.location.home }, stdio: "ignore", windowsHide: true,
    }));
    children.forEach((child) => pids.push(child.pid!));
    const exits = children.map((child) => new Promise<number | null>((done) => child.on("exit", done)));
    const first = await Promise.race(exits);
    expect(first).toBe(0);
    const live = lease();
    expect(live.owner).not.toBeNull();
    expect(children.filter((child) => child.exitCode === null).map((child) => child.pid)).toEqual([live.pid]);
  }, 30_000);

  it("a second start while one is starting or running does nothing", async () => {
    queueDemo({ batches: 30, delayMs: 200 });
    expect(start().started).toBe(true);
    expect(start()).toEqual({ started: false, reason: "starting" });
    await until(lease, (row) => row.owner !== null);
    expect(start()).toEqual({ started: false, reason: "running" });
  }, 30_000);

  it("hands over to a different version: the old one finishes its batch and exits, the job continues", async () => {
    const queued = queueDemo({ batches: 12, delayMs: 200 });
    const old = start() as { pid: number };
    await until(() => job(queued.id).batch, (batch) => batch >= 2);
    // Pretend the running process is an older MEX.
    writer.db.prepare("UPDATE background SET version='0.0.1-old' WHERE id=1").run();
    const next = start();
    expect(next).toMatchObject({ started: true, replacing: "0.0.1-old" });
    await until(() => alive(old.pid), (value) => !value);
    await until(lease, (row) => row.pid === (next as { pid: number }).pid);
    await until(() => job(queued.id).state, (state) => state === "done");
    expect(resultRows(queued.id)).toEqual([...Array(12).keys()]);
  }, 60_000);

  it("takes over a stale lease from a dead process and leaves a live one alone", async () => {
    writer.db.prepare("UPDATE background SET owner='background:999999:gone',pid=999999,version='x',heartbeat_at=? WHERE id=1").run(new Date().toISOString());
    const queued = queueDemo({ batches: 2, delayMs: 50 });
    start();
    await until(() => job(queued.id).state, (state) => state === "done");

    writer.db.prepare("UPDATE background SET owner=?,pid=?,version=?,heartbeat_at=? WHERE id=1")
      .run(`background:${process.pid}:test`, process.pid, (await import("../../version.js")).VERSION, new Date().toISOString());
    const child = spawn(process.execPath, [bundle], { env: { ...process.env, MEX_BACKGROUND: "1", MEX_RECORD_HOME: writer.location.home }, stdio: "ignore", windowsHide: true });
    pids.push(child.pid!);
    expect(await new Promise((done) => child.on("exit", done))).toBe(0);
    expect(lease().owner).toBe(`background:${process.pid}:test`);
  }, 30_000);

  it("exits when idle and clears the pending marker", async () => {
    const queued = queueDemo({ batches: 1, delayMs: 10 });
    expect(existsSync(join(writer.location.home, "jobs-pending"))).toBe(true);
    const started = start({ MEX_BACKGROUND_IDLE_MS: "500" }) as { pid: number };
    await until(() => job(queued.id).state, (state) => state === "done");
    await until(() => alive(started.pid), (value) => !value);
    expect(lease().owner).toBeNull();
    expect(existsSync(join(writer.location.home, "jobs-pending"))).toBe(false);
    expect(readFileSync(join(writer.location.home, "background.log"), "utf8")).toContain("stopping: idle");
  }, 30_000);

  it("stops over its memory cap without losing the job, which then runs elsewhere", async () => {
    const queued = queueDemo({ batches: 2, delayMs: 10 });
    const started = start({ MEX_BACKGROUND_MEMORY_MB: "1" }) as { pid: number };
    await until(() => alive(started.pid), (value) => !value);
    expect(readFileSync(join(writer.location.home, "background.log"), "utf8")).toContain("stopping: memory");
    expect(job(queued.id).state).toBe("queued");
    expect(await mod.runPendingInForeground(writer, 10_000)).toBe(2);
    expect(job(queued.id).state).toBe("done");
  }, 30_000);

  it("is off with MEX_BACKGROUND=0, and the foreground runner does the work instead", async () => {
    vi.stubEnv("MEX_BACKGROUND", "0");
    try {
      const queued = queueDemo({ batches: 3, delayMs: 10 });
      expect(start()).toEqual({ started: false, reason: "disabled" });
      expect(await mod.runPendingInForeground(writer, 10_000)).toBe(3);
      expect(job(queued.id).state).toBe("done");
    } finally { vi.stubEnv("MEX_BACKGROUND", ""); }
  });

  it("never starts from inside a background run, and doesn't start without work", () => {
    expect(start({}, false)).toEqual({ started: false, reason: "no-work" });
    vi.stubEnv("MEX_BACKGROUND", "1");
    try { expect(start()).toEqual({ started: false, reason: "inside-background" }); }
    finally { vi.stubEnv("MEX_BACKGROUND", ""); }
  });

  it("restarts from the cheap marker only when work is pending", () => {
    expect(mod.restartIfPending({ home: writer.location.home, entry: bundle, args: [] })).toBeUndefined();
    queueDemo({ batches: 1, delayMs: 10 });
    const result = mod.restartIfPending({ home: writer.location.home, entry: bundle, args: [] });
    expect(result?.started).toBe(true);
    if (result?.started) pids.push(result.pid);
    unlinkSync(join(writer.location.home, "jobs-pending"));
    expect(mod.restartIfPending({ home: writer.location.home, entry: bundle, args: [] })).toBeUndefined();
  });
});
