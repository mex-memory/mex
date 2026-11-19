import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import crossSpawn from "cross-spawn";
import { DatabaseSync } from "node:sqlite";
import { openRecord, projectIdentity, migrateRecord, schemaVersion, type RecordWriter } from "../../record/index.js";
import { recordMigrations } from "../../record/schema.js";
import { recordModelCall } from "../../record/usage.js";
import { enqueueJob, registerJobKind, requeueReadyJobs, runOneBatch, type JobRow } from "../../record/jobs.js";
import { runModel } from "../index.js";
import { acquireModelAdmission, cancelModelBatch, claimModelBatch, enqueueModelBatch, modelBudgetSnapshot, recoverModelBatches, settleModelBatch, type BatchRequest, type ModelBatchRow } from "../budget-queue.js";
import { modelWeights, REFERENCE_BATCH, REFERENCE_BATCH_UNITS } from "../budget-prices.js";
import { weightedTokens } from "../budget-policy.js";

let root: string, writer: RecordWriter, projectId: string;
const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const iso = (at: number) => new Date(at).toISOString();
const reader = () => ({ setting: (scope: string, key: string) => writer.setting(scope, key), all: <T>(sql: string, ...values: any[]) => writer.db.prepare(sql).all(...values) as T[] });
const setting = (scope: string, key: string, value: string) => writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(scope, key, value);
const request = (extra: Partial<BatchRequest> = {}): BatchRequest => ({ agent: "claude", model: "opus", projectPath: root, automatic: { estimate: { ...REFERENCE_BATCH } }, ...extra });
const usage = (extra = {}) => ({ ...REFERENCE_BATCH, model: "unknown", estimated: false, ...extra });
function entry(id: number) { return writer.db.prepare("SELECT * FROM model_batches WHERE id=?").get(id) as unknown as ModelBatchRow; }
function spend(count: number, at = NOW) {
  for (let n = 0; n < count; n++) { const batch = enqueueModelBatch(writer, request(), at); expect(claimModelBatch(writer, batch, at)).toBeUndefined(); settleModelBatch(writer, batch, usage()); }
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "mex-budget-")));
  vi.stubEnv("MEX_HOME", join(root, "home"));
  writer = openRecord({ isNetwork: () => false });
  projectId = writer.register(projectIdentity(root)).id;
});
afterEach(() => { writer.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("durable model admissions", () => {
  it("adds migration four without losing existing calls or partially applying failed SQL", () => {
    const directory = mkdtempSync(join(root, "old-record-"));
    const db = new DatabaseSync(join(directory, "record.db"));
    for (const migration of recordMigrations.slice(0, 3)) db.exec(migration.sql);
    db.exec("PRAGMA user_version=3; INSERT INTO settings VALUES('global','kept','yes'); INSERT INTO model_calls(ts,purpose,agent,model,input,cache_write,cache_read,output,estimated) VALUES('old','test','claude','unknown',1,2,3,4,0)");
    expect(() => migrateRecord(db, [{ version: 4, sql: "CREATE TABLE temporary_admission(n); INSERT INTO missing_table VALUES(1)" }])).toThrow();
    expect(schemaVersion(db)).toBe(3);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='temporary_admission'").get()).toBeUndefined();
    db.close();
    const upgraded = openRecord({ home: directory, isNetwork: () => false });
    try {
      expect(schemaVersion(upgraded.db)).toBe(5);
      expect(upgraded.setting("global", "kept")).toBe("yes");
      expect(upgraded.db.prepare("SELECT input,cache_write,cache_read,output,batch_id FROM model_calls").get()).toMatchObject({ input: 1, cache_write: 2, cache_read: 3, output: 4, batch_id: null });
    } finally { upgraded.close(); }
  });
  it("reserves transactionally and stops after seven unreadable-usage attempts", () => {
    spend(7);
    const eighth = enqueueModelBatch(writer, request(), NOW);
    expect(claimModelBatch(writer, eighth, NOW)).toBe("fallback");
    expect(entry(eighth.id)).toMatchObject({ state: "queued", admitted_at: null });
    expect(modelBudgetSnapshot(reader(), NOW)).toMatchObject({ ownUsageReadable: false, admittedAttempts: 7, spentUnits: REFERENCE_BATCH_UNITS * 7 });
    writer.close(); writer = openRecord({ isNetwork: () => false });
    expect(claimModelBatch(writer, eighth, NOW)).toBe("fallback");
    cancelModelBatch(writer, eighth);
  });
  it("enforces the cost floor for readable usage without inflating it for a large request", () => {
    setting("own-usage", "status.claude", JSON.stringify({ agent: "claude", status: "readable" }));
    spend(7);
    const denied = enqueueModelBatch(writer, request(), NOW);
    expect(claimModelBatch(writer, denied, NOW)).toBe("cap");
    expect(modelBudgetSnapshot(reader(), NOW).ownUsageReadable).toBe(true);
  });
  it("requires measured room for a weekly batch and keeps its interrupted reservation charged", () => {
    const weekly = request({ automatic: { estimate: { ...REFERENCE_BATCH }, measuredUsageOnly: true } });
    const batch = enqueueModelBatch(writer, weekly, NOW);
    expect(claimModelBatch(writer, batch, NOW)).toBe("cap");
    setting("own-usage", "status.claude", JSON.stringify({ agent: "claude", status: "readable" }));
    writer.db.prepare("INSERT INTO own_usage VALUES(?,?,?,?,?,?,0)").run("2026-11-14", "claude", 1, 0, 0, 0);
    expect(claimModelBatch(writer, batch, NOW)).toBe("cap");
    writer.db.exec("UPDATE own_usage SET input=10000000");
    writer.db.prepare("INSERT INTO usage_windows VALUES('claude','primary',?,75,?,'allowed')").run(iso(NOW), iso(NOW + 60_000));
    expect(claimModelBatch(writer, batch, NOW)).toBe("usage-window");
    expect(claimModelBatch(writer, batch, NOW + 60_000)).toBeUndefined();
    recoverModelBatches(writer, NOW + 61_000, () => false);
    expect(entry(batch.id)).toMatchObject({ automatic: 1, state: "interrupted", charged_units: batch.reserved_units });
  });
  it("uses the larger historical base, excludes future own usage and subtracts MEX conservatively", () => {
    writer.db.prepare("INSERT INTO own_usage VALUES(?,?,?,?,?,?,0)").run("2026-11-14", "claude", 10_000_000, 0, 0, 0);
    writer.db.prepare("INSERT INTO own_usage VALUES(?,?,?,?,?,?,0)").run("2026-10-25", "claude", 30_000_000, 0, 0, 0);
    writer.db.prepare("INSERT INTO own_usage VALUES(?,?,?,?,?,?,0)").run("2026-11-15", "claude", 100_000_000, 0, 0, 0);
    expect(recordModelCall({ agent: "claude", model: "opus", purpose: "test", input: 1_000_000, cache_write: 0, cache_read: 0, output: 0, estimated: false, timestamp: iso(NOW) })).toBe(true);
    expect(modelBudgetSnapshot(reader(), NOW)).toMatchObject({ lastSevenUnits: 36_000_000_000, lastFourWeeksUnits: 156_000_000_000 });
  });
  it("serializes both agents and explicit commands while leaving one running row", () => {
    const first = enqueueModelBatch(writer, request({ automatic: undefined }), NOW);
    const second = enqueueModelBatch(writer, request({ agent: "codex", model: "gpt-6.1-sol", automatic: undefined }), NOW);
    expect(claimModelBatch(writer, second, NOW)).toBe("queue");
    expect(claimModelBatch(writer, first, NOW)).toBeUndefined();
    expect(claimModelBatch(writer, second, NOW)).toBe("queue");
    expect(() => writer.db.prepare("UPDATE model_batches SET state='running' WHERE id=?").run(second.id)).toThrow();
    settleModelBatch(writer, first, usage());
    expect(claimModelBatch(writer, second, NOW)).toBeUndefined();
    settleModelBatch(writer, second, usage());
  });
  it("does not let an automatic hold block an explicit command or another agent", () => {
    writer.db.prepare("INSERT INTO usage_windows VALUES('claude','primary',?,75,?,'allowed')").run(iso(NOW), iso(NOW + 60_000));
    const held = enqueueModelBatch(writer, request(), NOW);
    const other = enqueueModelBatch(writer, request({ agent: "codex", model: "gpt-6.1-sol" }), NOW);
    expect(claimModelBatch(writer, held, NOW)).toBe("usage-window");
    expect(claimModelBatch(writer, other, NOW)).toBeUndefined();
    settleModelBatch(writer, other, usage());
    const explicit = enqueueModelBatch(writer, request({ automatic: undefined }), NOW);
    expect(claimModelBatch(writer, explicit, NOW)).toBeUndefined();
    settleModelBatch(writer, explicit, usage());
    expect(claimModelBatch(writer, held, NOW + 60_000)).toBeUndefined();
    settleModelBatch(writer, held, usage());
  });
  it("prefers visible sooner-reset allowance among automatic entries", () => {
    writer.db.prepare("INSERT INTO usage_windows VALUES('claude','primary',?,20,?,'allowed')").run(iso(NOW), iso(NOW + 120_000));
    writer.db.prepare("INSERT INTO usage_windows VALUES('codex','primary',?,20,?,'allowed')").run(iso(NOW), iso(NOW + 60_000));
    const later = enqueueModelBatch(writer, request(), NOW);
    const sooner = enqueueModelBatch(writer, request({ agent: "codex", model: "gpt-6.1-sol" }), NOW);
    expect(claimModelBatch(writer, later, NOW)).toBe("queue");
    expect(claimModelBatch(writer, sooner, NOW)).toBeUndefined();
    settleModelBatch(writer, sooner, usage());
    expect(claimModelBatch(writer, later, NOW)).toBeUndefined();
    settleModelBatch(writer, later, usage());
  });
  it("keeps interrupted reservations charged, retires unstarted entries and never steals live owners", () => {
    const batch = enqueueModelBatch(writer, request(), NOW);
    expect(claimModelBatch(writer, batch, NOW)).toBeUndefined();
    const queued = enqueueModelBatch(writer, request(), NOW);
    recoverModelBatches(writer, NOW + 1_000_000, () => true);
    expect(entry(batch.id).state).toBe("running");
    recoverModelBatches(writer, NOW + 1_000_000, () => false);
    expect(entry(batch.id)).toMatchObject({ state: "interrupted", charged_units: batch.reserved_units });
    expect(entry(queued.id)).toMatchObject({ state: "cancelled", admitted_at: null, charged_units: 0 });
    expect(modelBudgetSnapshot(reader(), NOW).admittedAttempts).toBe(1);
    spend(6);
    const retry = enqueueModelBatch(writer, request(), NOW);
    expect(claimModelBatch(writer, retry, NOW)).toBe("fallback");
  });
  it("does not infer a dead owner from an unfamiliar identity while its PID is live", () => {
    const old = enqueueModelBatch(writer, request(), NOW);
    writer.db.prepare("UPDATE model_batches SET owner='model:old-incarnation' WHERE id=?").run(old.id);
    const live = enqueueModelBatch(writer, request(), NOW);
    recoverModelBatches(writer, NOW, () => true);
    expect(entry(old.id).state).toBe("queued");
    expect(entry(live.id).state).toBe("queued");
  });
  it("retains reported overspend even if a worker dies before settlement", () => {
    const batch = enqueueModelBatch(writer, request(), NOW);
    expect(claimModelBatch(writer, batch, NOW)).toBeUndefined();
    const measured = usage({ output: 10_000 });
    expect(recordModelCall({ ...measured, agent: "claude", purpose: "test", batchId: batch.id })).toBe(true);
    recoverModelBatches(writer, NOW, () => false);
    expect(entry(batch.id).charged_units).toBe(weightedTokens(measured, modelWeights("opus", measured)));
  });
  it("retains the reservation when accounting fails or only an estimate is available", () => {
    for (const recorded of [true, false]) {
      const batch = enqueueModelBatch(writer, request(), NOW);
      expect(claimModelBatch(writer, batch, NOW)).toBeUndefined();
      settleModelBatch(writer, batch, usage({ input: 1, output: 1, estimated: true }), recorded);
      expect(entry(batch.id)).toMatchObject({ charged_units: batch.reserved_units, state: recorded ? "done" : "interrupted" });
    }
  });
  it("keeps future-dated admissions charged after a backwards clock adjustment", () => {
    spend(7, NOW + 86_400_000);
    const retry = enqueueModelBatch(writer, request(), NOW);
    expect(claimModelBatch(writer, retry, NOW)).toBe("fallback");
  });
  it("honors off and unknown-model holds without consuming an admission", () => {
    setting("global", "enabled", "false");
    const off = enqueueModelBatch(writer, request(), NOW);
    expect(claimModelBatch(writer, off, NOW)).toBe("off");
    const unknown = enqueueModelBatch(writer, request({ model: "unpriced-fixture" }), NOW);
    expect(claimModelBatch(writer, unknown, NOW)).toBe("pricing");
    expect(modelBudgetSnapshot(reader(), NOW).admittedAttempts).toBe(0);
    const explicit = enqueueModelBatch(writer, request({ automatic: undefined }), NOW);
    expect(claimModelBatch(writer, explicit, NOW)).toBeUndefined();
    settleModelBatch(writer, explicit, usage());
  });
  it("keeps explicit commands independent of unusable valuation data", () => {
    writer.db.prepare("INSERT INTO own_usage VALUES('2026-11-14','claude',?,0,0,0,0)").run(Number.MAX_SAFE_INTEGER);
    const explicit = enqueueModelBatch(writer, request({ automatic: undefined }), NOW);
    expect(claimModelBatch(writer, explicit, NOW)).toBeUndefined();
    settleModelBatch(writer, explicit, usage());
    const automatic = enqueueModelBatch(writer, request(), NOW);
    expect(() => claimModelBatch(writer, automatic, NOW)).toThrow();
    expect(entry(automatic.id).admitted_at).toBeNull();
  });
  it("saturates an unrepresentable report conservatively instead of losing the charge", () => {
    const batch = enqueueModelBatch(writer, request(), NOW);
    expect(claimModelBatch(writer, batch, NOW)).toBeUndefined();
    settleModelBatch(writer, batch, usage({ input: Number.MAX_SAFE_INTEGER }));
    expect(entry(batch.id)).toMatchObject({ state: "interrupted", charged_units: Number.MAX_SAFE_INTEGER });
  });
  it("cancels a waiting explicit caller without changing another owner's entry", async () => {
    const owned = await acquireModelAdmission(request({ automatic: undefined }));
    const controller = new AbortController();
    const waiting = acquireModelAdmission(request({ automatic: undefined }), controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ category: "cancelled" });
    expect(entry(owned!.id).state).toBe("running");
    owned!.finish(usage(), true); owned!.close();
    expect(writer.db.prepare("SELECT count(*) n FROM model_batches WHERE state='queued'").get()!.n).toBe(0);
  });
  it("bounds explicit queue waits and holds automatic work when storage is unavailable", async () => {
    const owned = await acquireModelAdmission(request({ automatic: undefined }));
    try {
      await expect(acquireModelAdmission(request({ automatic: undefined }), undefined, 1)).rejects.toMatchObject({ reason: "queue" });
      expect(writer.db.prepare("SELECT count(*) n FROM model_batches WHERE state='queued'").get()!.n).toBe(0);
    } finally { owned!.finish(usage(), true); owned!.close(); }
    const broken = join(root, "not-a-directory"); writeFileSync(broken, "synthetic"); vi.stubEnv("MEX_HOME", broken);
    const spawn = vi.fn() as unknown as typeof crossSpawn;
    await expect(runModel({ agent: "claude", prompt: "Synthetic task", projectRoot: root, purpose: "test", automatic: { estimate: { ...REFERENCE_BATCH } }, __internal: { spawn } })).rejects.toMatchObject({ reason: "storage" });
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each(["claude", "codex"] as const)("saves visible %s usage-window observations before admitting the next call", async agent => {
    const window = agent === "claude" ? { type: "rate_limit_event", rate_limit_info: { rateLimitType: "five_hour", utilization: 0.8, status: "allowed_warning", resetsAt: Math.floor(Date.now() / 1000) + 3600 } }
      : { type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 80, resets_at: Math.floor(Date.now() / 1000) + 3600 } } } };
    const events = agent === "claude" ? [window, { type: "result", subtype: "success", result: "ok", usage: { input_tokens: 10, output_tokens: 1 } }]
      : [window, { type: "item.completed", item: { type: "agent_message", text: "ok" } }, { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1 } }];
    const spawn = vi.fn((_command: string, _args: string[], options: any) => crossSpawn(process.execPath, ["-e", `process.stdin.resume();for(const event of ${JSON.stringify(events)})process.stdout.write(JSON.stringify(event)+String.fromCharCode(10));`], options)) as unknown as typeof crossSpawn;
    const input = { agent, prompt: "Synthetic task", projectRoot: root, purpose: "test", automatic: { estimate: { ...REFERENCE_BATCH } }, __internal: { spawn } };
    await expect(runModel(input)).resolves.toMatchObject({ text: "ok" });
    expect(writer.db.prepare("SELECT used_percent FROM usage_windows WHERE agent=?").get(agent)!.used_percent).toBe(80);
    await expect(runModel(input)).rejects.toMatchObject({ reason: "usage-window" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe("automatic model jobs", () => {
  it("uses the job writer's home for reservations and accounting instead of another CLI home", async () => {
    const name = `home-${randomUUID()}`;
    const spawn = ((_command: string, _args: string[], options: any) => crossSpawn(process.execPath,
      ["-e", "process.stdin.resume();process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'ok',usage:{input_tokens:1,output_tokens:1}}));"], options)) as typeof crossSpawn;
    registerJobKind({ name, label: "Synthetic model work", scope: "project", sideEffects: "none", async runBatch() {
      await runModel({ agent: "claude", prompt: "Synthetic task", projectRoot: root, purpose: "test", __internal: { spawn } });
      return { checkpoint: 1, done: true };
    } });
    const job = enqueueJob(writer, { kind: name, projectId }).job;
    vi.stubEnv("MEX_HOME", join(root, "another-home"));
    await runOneBatch(writer, `foreground:${process.pid}:test`);
    expect(writer.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id)!.state).toBe("done");
    expect(writer.db.prepare("SELECT count(*) n FROM model_calls WHERE batch_id IS NOT NULL").get()!.n).toBe(1);
  });
  it("preserves checkpoint, batch and failure count on a foreground-run cap hold, then resumes", async () => {
    spend(7, Date.now());
    const name = `budget-${randomUUID()}`;
    const spawn = vi.fn((_command: string, _args: string[], options: any) => crossSpawn(process.execPath,
      ["-e", `process.stdin.resume();process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'ok',usage:{input_tokens:10,output_tokens:1}}));`], options)) as unknown as typeof crossSpawn;
    registerJobKind({ name, label: "Synthetic model work", scope: "project", sideEffects: "none", async runBatch() {
      await runModel({ agent: "claude", prompt: "Synthetic task", projectRoot: root, purpose: "test", automatic: { estimate: { ...REFERENCE_BATCH } }, __internal: { spawn } });
      return { checkpoint: { next: 4 }, done: true };
    } });
    const job = enqueueJob(writer, { kind: name, projectId }).job;
    writer.db.prepare("UPDATE jobs SET checkpoint=?,batch=4,failures=2 WHERE id=?").run('{"next":3}', job.id);
    await runOneBatch(writer, `foreground:${process.pid}:test`);
    const held = writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id) as unknown as JobRow;
    expect(held).toMatchObject({ state: "waiting", batch: 4, failures: 2, checkpoint: '{"next":3}' });
    expect(spawn).not.toHaveBeenCalled();
    expect(requeueReadyJobs(writer)).toBe(0);
    writer.db.prepare("UPDATE model_batches SET admitted_at='2000-01-01T00:00:00.000Z' WHERE admitted_at IS NOT NULL").run();
    expect(requeueReadyJobs(writer)).toBe(1);
    await runOneBatch(writer, `foreground:${process.pid}:test`);
    expect(writer.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id)!.state).toBe("done");
    expect(writer.db.prepare("SELECT automatic,job_id,job_batch FROM model_batches WHERE job_id=? AND state='done'").get(job.id)).toMatchObject({ automatic: 1, job_id: job.id, job_batch: 4 });
    expect(writer.db.prepare("SELECT count(*) n FROM model_calls WHERE batch_id IS NOT NULL").get()!.n).toBe(1);
  });
});
