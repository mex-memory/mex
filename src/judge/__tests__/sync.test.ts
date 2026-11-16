import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { enqueueJob, registerJobKind, requestJob, runOneBatch, type JobRow } from "../../record/jobs.js";
import { runModel, ModelWaitError, type ModelRequest, type ModelResult } from "../../model-runner/index.js";
import { enqueueModelBatch, claimModelBatch, settleModelBatch } from "../../model-runner/budget-queue.js";
import { REFERENCE_BATCH } from "../../model-runner/budget-prices.js";
import type { NativeReport } from "../../knowledge/check.js";
import { entry } from "../../knowledge/__tests__/fixtures.js";
import { serializeEntry } from "../../knowledge/entry.js";
import { shortHash } from "../../record/project.js";
import { createJudgeKind, type JudgeDependencies } from "../job.js";
import { hash } from "../evidence.js";
import { runJudgeSync } from "../sync.js";

let base: string, root: string, home: string, projectId: string, writer: RecordWriter;
let dependencies: JudgeDependencies, report: NativeReport;
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
const row = (id: string) => writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as unknown as JobRow;
const count = (table: string) => Number(writer.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
const answer = (request: ModelRequest): ModelResult => ({
  selectedModel: "fixture-cheap", usage: { input: 30, cache_write: 0, cache_read: 0, output: 10, model: "fixture", estimated: false },
  text: JSON.stringify({ results: JSON.parse(request.prompt.split("Evidence follows as JSON:\n")[1]!).entries.map((e: { id: string }) => ({ id: e.id, result: "still-true" })) }),
});
function pending(sessionId?: string, agent = "claude-code") {
  const directory = join(writer.location.directory, "judge-pending"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${shortHash(root)}.json`), JSON.stringify({ version: 1, project_id: projectId,
    checkout: root, agent, reason: "edit", generation: "1", near: ["api.ts"], not_before: Date.now() + 60_000,
    ...(sessionId ? { session_id: sessionId } : {}) }));
}
async function sync(extra = {}) {
  registerJobKind(createJudgeKind(dependencies));
  return runJudgeSync({ home, projectPath: root, ...extra }, { available: () => true, evaluate: dependencies.evaluate, write: vi.fn() });
}
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-sync-judge-"))); root = join(base, "repo"); home = join(base, ".mex"); mkdirSync(root);
  vi.stubEnv("MEX_HOME", base); vi.stubEnv("MEX_BACKGROUND", "0"); vi.stubEnv("CODEX_THREAD_ID", ""); vi.stubEnv("CLAUDECODE", "");
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "api.ts"), "old\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "Baseline");
  writeFileSync(join(root, "api.ts"), "new\n"); mkdirSync(join(root, ".mex/learned"), { recursive: true });
  const file = join(root, ".mex/learned/mx_sync000.md");
  const value = serializeEntry(entry("mx_sync000", { kind: "fact", checks: [{ kind: "source", role: "supporting", target: { file: "api.ts" }, saw: { hash: hash("old\n") }, files: { "api.ts": hash("old\n") } }] }, "The API uses old behavior."));
  writeFileSync(file, value);
  writer = openRecord({ home, projectPath: root, isNetwork: () => false }); projectId = writer.checkout(root)!.project_id;
  report = { ok: true, stored: false, problems: [], items: [{ id: "mx_sync000", path: file, level: "team", kind: "fact", status: "active", verdict: "changed", entry_hash: hash(value) }],
    results: [{ entry_id: "mx_sync000", verdict: "changed", checks: [{ index: 0, kind: "source", role: "supporting", status: "floor" }], inputs: { "api.ts": hash("new\n") } }] };
  dependencies = { evaluate: vi.fn(async () => structuredClone(report)), recordChecks: vi.fn(async () => undefined), model: vi.fn(async request => answer(request)) };
});
afterEach(() => { writer.close(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

it("runs the capped cheap judge now without a legacy scaffold, and reuses exact cached judgments", async () => {
  pending();
  const first = await sync(); expect(first).toMatchObject({ state: "done", results: 1, tokens_used: 40 });
  expect(dependencies.model).toHaveBeenCalledWith(expect.objectContaining({ role: "cheap", purpose: "judge", automatic: expect.any(Object) }));
  await sync(); expect(dependencies.model).toHaveBeenCalledTimes(1);
  expect(existsSync(join(root, ".mex/ROUTER.md"))).toBe(false);
  expect(git("diff", "--cached", "--name-only")).toBe("");
});

it("previews eligible entries with read-only checks and no jobs, models or record writes", async () => {
  const before = readFileSync(writer.location.record), file = report.items![0]!.path, original = readFileSync(file);
  const write = vi.fn();
  await runJudgeSync({ home, projectPath: root, dryRun: true }, { available: () => false, evaluate: dependencies.evaluate, write });
  expect(write.mock.calls.flat().join("\n")).toContain("1 changed or broken entries");
  expect(dependencies.model).not.toHaveBeenCalled(); expect(count("jobs")).toBe(0); expect(count("judgements")).toBe(0);
  expect(readFileSync(writer.location.record)).toEqual(before); expect(readFileSync(file)).toEqual(original);
});

it("does not initialize an unregistered home even for a dry run", async () => {
  const absent = join(base, "unregistered");
  await expect(runJudgeSync({ home: absent, projectPath: root, dryRun: true })).rejects.toThrow("not registered");
  expect(existsSync(absent)).toBe(false);
});

it("leaves timed-out work durable without bypassing idle after foreground handover", async () => {
  pending(); registerJobKind(createJudgeKind(dependencies));
  const job = await runJudgeSync({ home, projectPath: root }, { available: () => true, write: vi.fn(), budgetMs: 0 });
  expect(job!.state).toBe("queued"); expect(dependencies.model).not.toHaveBeenCalled();
  await runOneBatch(writer, "fixture"); expect(row(job!.id).state).toBe("waiting");
});

it("reports a missing runner without creating a judge job", async () => {
  await expect(runJudgeSync({ home, projectPath: root }, { available: () => false })).rejects.toThrow("needs Claude Code or Codex");
  expect(count("jobs")).toBe(0); expect(dependencies.model).not.toHaveBeenCalled();
});

it("does not run an older host's queued job from a paused current session", async () => {
  registerJobKind(createJudgeKind(dependencies));
  const job = enqueueJob(writer, { kind: "judge", projectId, params: { checkout: root, agent: "claude", near: [] } }).job;
  vi.stubEnv("CODEX_THREAD_ID", "current-paused-session");
  const directory = join(writer.location.directory, "hook-paused"); mkdirSync(directory);
  writeFileSync(join(directory, shortHash("codex\0current-paused-session")), "");
  await sync();
  expect(dependencies.model).not.toHaveBeenCalled(); expect(row(job.id)).toMatchObject({ state: "queued", batch: 0, params: job.params });
});

it("does not attempt a reused job with an unavailable runner just because another host is installed", async () => {
  registerJobKind(createJudgeKind(dependencies));
  const job = enqueueJob(writer, { kind: "judge", projectId, params: { checkout: root, agent: "claude", near: [] } }).job;
  await expect(runJudgeSync({ home, projectPath: root }, { available: agent => agent === "codex", write: vi.fn() })).rejects.toThrow("existing judge job uses claude");
  expect(dependencies.model).not.toHaveBeenCalled(); expect(row(job.id)).toMatchObject({ state: "queued", batch: 0, params: job.params });
});

it("can report a paused job without requiring its model CLI", async () => {
  registerJobKind(createJudgeKind(dependencies));
  const job = enqueueJob(writer, { kind: "judge", projectId, params: { checkout: root, agent: "claude", near: [] } }).job;
  requestJob(writer, job.id, "pause");
  expect(await runJudgeSync({ home, projectPath: root }, { available: () => false, write: vi.fn() })).toMatchObject({ id: job.id, state: "paused" });
  expect(dependencies.model).not.toHaveBeenCalled();
});

it("does not borrow another editing session's queued job", async () => {
  registerJobKind(createJudgeKind(dependencies));
  const job = enqueueJob(writer, { kind: "judge", projectId, params: { checkout: root, agent: "codex", near: [], sessionId: "other-session" } }).job;
  vi.stubEnv("CODEX_THREAD_ID", "current-session");
  expect(await sync()).toMatchObject({ id: job.id, state: "queued", params: job.params });
  expect(dependencies.model).not.toHaveBeenCalled();
});

it("does not use a different host when the invoking host's CLI is unavailable", async () => {
  vi.stubEnv("CODEX_THREAD_ID", "current-session");
  await expect(runJudgeSync({ home, projectPath: root }, { available: agent => agent === "claude", write: vi.fn() })).rejects.toThrow("This session needs codex");
  expect(count("jobs")).toBe(0); expect(dependencies.model).not.toHaveBeenCalled();
});

it("does not bind the current session to a stale same-host paused request", async () => {
  pending("old-paused-session", "codex"); vi.stubEnv("CODEX_THREAD_ID", "current-session");
  const directory = join(writer.location.directory, "hook-paused"); mkdirSync(directory);
  writeFileSync(join(directory, shortHash("codex\0old-paused-session")), "");
  const job = await sync();
  expect(job!.state).toBe("done"); expect(JSON.parse(job!.params).sessionId).toBe("current-session");
  expect(dependencies.model).toHaveBeenCalledWith(expect.objectContaining({ agent: "codex" }));
});

it.each(["valid", "oversized", "linked"])("bounds the optional saved runner selection (%s)", async kind => {
  const value = JSON.stringify({ aiTools: ["codex"], ...(kind === "oversized" ? { padding: "x".repeat(70_000) } : {}) });
  const config = join(root, ".mex/config.json");
  if (kind === "linked") {
    const outside = join(base, "outside-config.json"); writeFileSync(outside, value); symlinkSync(outside, config, "file");
  } else writeFileSync(config, value);
  await sync();
  expect(dependencies.model).toHaveBeenCalledWith(expect.objectContaining({ agent: kind === "valid" ? "codex" : "claude" }));
});

it("resumes an idle wait without making future background batches immediate", async () => {
  pending(); registerJobKind(createJudgeKind(dependencies));
  const job = enqueueJob(writer, { kind: "judge", projectId, params: { checkout: root, agent: "claude", near: [] } }).job;
  await runOneBatch(writer, "fixture"); expect(row(job.id).state).toBe("waiting");
  const result = await sync(); expect(result).toMatchObject({ id: job.id, state: "done", results: 1 });
  const next = enqueueJob(writer, { kind: "judge", projectId, params: { checkout: root, agent: "claude", near: [] } }).job;
  await runOneBatch(writer, "fixture"); expect(row(next.id).state).toBe("waiting");
  expect(JSON.parse(row(job.id).params)).not.toHaveProperty("immediate");
});

it("leaves deliberate pauses and another checkout's unfinished judge alone", async () => {
  registerJobKind(createJudgeKind(dependencies));
  const other = join(base, "other"); mkdirSync(other); writer.register({ id: projectId, rootPath: other, kind: "git" });
  const job = enqueueJob(writer, { kind: "judge", projectId, params: { checkout: other, agent: "claude", near: [] } }).job;
  requestJob(writer, job.id, "pause");
  expect(await sync()).toMatchObject({ id: job.id, state: "paused", params: job.params }); expect(dependencies.model).not.toHaveBeenCalled();
  requestJob(writer, job.id, "cancel");
  const local = enqueueJob(writer, { kind: "judge", projectId, params: { checkout: root, agent: "claude", near: [] } }).job;
  requestJob(writer, local.id, "pause"); expect(await sync()).toMatchObject({ id: local.id, state: "paused" });
  expect(dependencies.model).not.toHaveBeenCalled();
});

it("runs only its judge, preserving unrelated queued work and same-project concurrency", async () => {
  const other = vi.fn(() => ({ checkpoint: {}, done: true }));
  registerJobKind({ name: "sync-fixture", label: "Fixture", scope: "machine", sideEffects: "none", runBatch: other });
  const unrelated = enqueueJob(writer, { kind: "sync-fixture" }).job;
  await sync(); expect(other).not.toHaveBeenCalled(); expect(row(unrelated.id).state).toBe("queued");
  registerJobKind({ name: "project-fixture", label: "Fixture", scope: "project", sideEffects: "none", runBatch: other });
  const busy = enqueueJob(writer, { kind: "project-fixture", projectId }).job;
  // A live runner's claim remains authoritative while sync attempts its own job.
  const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    writer.db.prepare("UPDATE jobs SET state='running',owner=? WHERE id=?").run(`background:${live.pid}:fixture`, busy.id);
    expect(await sync()).toMatchObject({ state: "queued", results: 0 });
  } finally { live.kill(); }
});

it.each(["checkout", "global", "session"])("honors %s off/pause before the immediate run", async mode => {
  if (mode === "checkout") writer.db.prepare("UPDATE checkouts SET state='off'").run();
  if (mode === "global") writer.db.prepare("INSERT INTO settings VALUES('global','enabled','false')").run();
  if (mode === "session") {
    pending("paused"); const directory = join(writer.location.directory, "hook-paused"); mkdirSync(directory);
    writeFileSync(join(directory, shortHash("claude-code\0paused")), "");
  }
  expect(await sync()).toMatchObject({ state: "waiting", results: 0 }); expect(dependencies.model).not.toHaveBeenCalled();
});

it.each(["readable", "unreadable"])("retains the real exhausted allowance with %s own usage and never spawns on a forced retry", async status => {
  writer.db.prepare("INSERT INTO settings VALUES('own-usage','status.claude',?)").run(JSON.stringify({ agent: "claude", status }));
  for (let i = 0; i < 7; i++) {
    const batch = enqueueModelBatch(writer, { agent: "claude", model: "opus", projectPath: root, automatic: { estimate: REFERENCE_BATCH } });
    expect(claimModelBatch(writer, batch)).toBeUndefined(); settleModelBatch(writer, batch, { ...REFERENCE_BATCH, model: "opus", estimated: false });
  }
  const spawn = vi.fn(() => { throw new Error("A capped sync must not launch a model"); });
  dependencies.model = request => runModel({ ...request, __internal: { spawn: spawn as never } });
  pending();
  const first = await sync(); expect(first).toMatchObject({ state: "waiting", results: 0 });
  expect(first!.reason).toBe(status === "readable" ? "Waiting: MEX's automatic model allowance is used up" : "Waiting: the seven automatic batches for unreadable usage are used up");
  expect(await sync()).toMatchObject({ id: first!.id, state: "waiting", results: 0 });
  expect(spawn).not.toHaveBeenCalled();
});

it("leaves a live judge with its runner rather than launching a duplicate", async () => {
  registerJobKind(createJudgeKind(dependencies));
  const job = enqueueJob(writer, { kind: "judge", projectId, params: { checkout: root, agent: "claude", near: [] } }).job;
  const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const owner = `background:${live.pid}:fixture`;
    writer.db.prepare("UPDATE jobs SET state='running',owner=? WHERE id=?").run(owner, job.id);
    expect(await sync()).toMatchObject({ id: job.id, state: "running", owner });
    expect(dependencies.model).not.toHaveBeenCalled(); expect(count("jobs")).toBe(1);
  } finally { live.kill(); }
});

it("discards an immediate reply when the latest originating session pauses during the call", async () => {
  dependencies.model = vi.fn(async request => {
    pending("new-paused-session"); const directory = join(writer.location.directory, "hook-paused"); mkdirSync(directory);
    writeFileSync(join(directory, shortHash("claude-code\0new-paused-session")), "");
    return answer(request);
  });
  expect(await sync()).toMatchObject({ state: "waiting", results: 0 });
  expect(count("judgements")).toBe(0); expect(dependencies.model).toHaveBeenCalledTimes(1);
});

it("does not reset a waiting job's branch checkpoint to the new branch", async () => {
  dependencies.model = vi.fn(async () => { throw new ModelWaitError("cap"); });
  const first = await sync(); expect(first!.state).toBe("waiting"); git("switch", "-c", "unrelated");
  dependencies.model = vi.fn(async request => answer(request));
  expect(await sync()).toMatchObject({ id: first!.id, state: "done with gaps", results: 0 });
  expect(dependencies.model).not.toHaveBeenCalled(); expect(git("diff", "--cached", "--name-only")).toBe("");
});
