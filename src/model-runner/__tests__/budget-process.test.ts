import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { buildSync } from "esbuild";
import { openRecord, projectIdentity, type RecordWriter } from "../../record/index.js";
import { enqueueModelBatch, claimModelBatch, recoverModelBatches, settleModelBatch, modelBudgetSnapshot } from "../budget-queue.js";
import { REFERENCE_BATCH, REFERENCE_BATCH_UNITS } from "../budget-prices.js";

let bundleRoot: string, bundle: string, root: string, writer: RecordWriter;
const children: ChildProcess[] = [];
beforeAll(() => {
  mkdirSync(resolve("node_modules/.cache"), { recursive: true });
  bundleRoot = mkdtempSync(resolve("node_modules/.cache/mex-budget-worker-"));
  mkdirSync(join(bundleRoot, "dist"));
  writeFileSync(join(bundleRoot, "package.json"), readFileSync(resolve("package.json")));
  bundle = join(bundleRoot, "dist", "worker.mjs");
  buildSync({ entryPoints: [resolve("src/model-runner/__tests__/fixtures/budget-worker.ts")], outfile: bundle,
    bundle: true, packages: "external", platform: "node", format: "esm", target: "node22", logLevel: "silent" });
});
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }));
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "mex-budget-process-")));
  vi.stubEnv("MEX_HOME", join(root, "home"));
  writer = openRecord({ isNetwork: () => false });
  writer.register(projectIdentity(root));
});
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  writer.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});
function worker(mode: string, index: number, project = root) {
  const child = spawn(process.execPath, [bundle, mode, project, join(root, "trace"), join(root, "start"), String(index)], {
    env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  children.push(child);
  let output = "", diagnostic = "";
  child.stdout!.on("data", chunk => { output += chunk; });
  child.stderr!.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-8192); });
  const done = new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(output) : reject(new Error(`Synthetic worker failed (${code}): ${diagnostic}`)));
  });
  void done.catch(() => {});
  return { child, done, output: () => output };
}
function assertSerial(expected: number) {
  const events = readFileSync(join(root, "trace"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  let active = 0, maximum = 0;
  for (const event of events) { active += event.kind === "start" ? 1 : -1; maximum = Math.max(active, maximum); expect(active).toBeGreaterThanOrEqual(0); }
  expect(active).toBe(0); expect(maximum).toBe(1); expect(events.filter(event => event.kind === "start")).toHaveLength(expected);
}
function spendSix(readable = false) {
  if (readable) writer.db.prepare("INSERT INTO settings VALUES('own-usage','status.claude',?)").run(JSON.stringify({ agent: "claude", status: "readable" }));
  for (let n = 0; n < 6; n++) {
    const entry = enqueueModelBatch(writer, { agent: "claude", model: "opus", projectPath: root, automatic: { estimate: { ...REFERENCE_BATCH } } });
    expect(claimModelBatch(writer, entry)).toBeUndefined();
    settleModelBatch(writer, entry, { ...REFERENCE_BATCH, model: "unknown", estimated: false });
  }
}

describe("machine-wide model queue across real processes and fake models", () => {
  it("serializes foreground callers across agents", async () => {
    const workers = [0, 1, 2, 3].map(index => worker("explicit", index));
    writeFileSync(join(root, "start"), "");
    expect((await Promise.all(workers.map(item => item.done))).map(item => JSON.parse(item))).toEqual(Array(4).fill({ ok: true }));
    assertSerial(4);
    expect(writer.db.prepare("SELECT count(*) n FROM model_calls WHERE batch_id IS NOT NULL").get()!.n).toBe(4);
  });
  it("keeps different job kinds and projects in one automatic lane", async () => {
    const workers = [0, 1, 2, 3].map(index => {
      const project = join(root, `project-${index}`); mkdirSync(project); writer.register(projectIdentity(project));
      return worker("job", index, project);
    });
    writeFileSync(join(root, "start"), "");
    expect((await Promise.all(workers.map(item => item.done))).map(item => JSON.parse(item))).toEqual(Array(4).fill({ ok: true }));
    assertSerial(4);
    expect(writer.db.prepare("SELECT count(DISTINCT job_id) n FROM model_batches WHERE state='done'").get()!.n).toBe(4);
    expect(modelBudgetSnapshot({ setting: (scope, key) => writer.setting(scope, key), all: (sql, ...args) => writer.db.prepare(sql).all(...args) as any }).admittedAttempts).toBe(4);
  });
  it("lets only one racing worker spend the last cost reservation, including retries", async () => {
    spendSix(true);
    // All contenders use the same priced model so the last reference batch is exact.
    const workers = [0, 2, 4, 6].map(index => worker("race", index));
    writeFileSync(join(root, "start"), "");
    const outcomes = (await Promise.all(workers.map(item => item.done))).map(item => JSON.parse(item));
    expect(outcomes.filter(item => item.ok)).toHaveLength(1);
    expect(outcomes.filter(item => item.held === "cap")).toHaveLength(3);
    assertSerial(1);
    expect(writer.db.prepare("SELECT sum(charged_units) n FROM model_batches WHERE automatic=1").get()!.n).toBe(7 * REFERENCE_BATCH_UNITS);
  });
  it("charges a killed admitted worker after reopening and refuses a free retry", async () => {
    spendSix();
    const crashed = worker("crash", 0);
    writeFileSync(join(root, "start"), "");
    await vi.waitFor(() => expect(crashed.output()).toContain("admitted"), { timeout: 5000 });
    const id = JSON.parse(crashed.output()).admitted;
    crashed.child.kill("SIGKILL"); await crashed.done.catch(() => {});
    writer.close(); writer = openRecord({ isNetwork: () => false });
    recoverModelBatches(writer);
    expect(writer.db.prepare("SELECT state,charged_units FROM model_batches WHERE id=?").get(id)).toMatchObject({ state: "interrupted", charged_units: REFERENCE_BATCH_UNITS });
    const retry = worker("race", 2);
    expect(JSON.parse(await retry.done)).toEqual({ held: "fallback" });
    expect(existsSync(join(root, "trace"))).toBe(false);
  });
});
