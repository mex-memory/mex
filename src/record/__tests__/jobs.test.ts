import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecord, openRecordReadOnly, type RecordWriter, type JobState } from "../index.js";
import {
  blockedReason, canTransition, describeJob, enqueueJob, JOB_STATES, JOB_TRANSITIONS, listJobs, recoverInterruptedJobs,
  registerJobKind, requestJob, requeueReadyJobs, runOneBatch, type BatchResult, type JobRow,
} from "../jobs.js";

let home: string, writer: RecordWriter;
const reader = () => ({ all: <T>(sql: string, ...args: import("node:sqlite").SQLInputValue[]) => writer.db.prepare(sql).all(...args) as T[] });
const job = (id: string) => writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as unknown as JobRow;
const results = (id: string) => writer.db.prepare("SELECT batch,summary FROM job_results WHERE job_id=? ORDER BY batch").all(id) as Array<{ batch: number; summary: string }>;
function project(name: string) {
  const path = join(home, name);
  writer.db.prepare("INSERT OR IGNORE INTO projects(id,root_path,kind,created_at) VALUES(?,?,'folder','2026-01-01')").run(`f-${name.padEnd(24, "0")}`, path);
  return `f-${name.padEnd(24, "0")}`;
}

let behaviour: { fail?: string; wait?: string; ready?: boolean; total?: number } = {};
registerJobKind<{ total?: number }, { next: number }>({
  name: "test-batches", label: "Test batches", scope: "project", sideEffects: "none",
  runBatch({ checkpoint, params }) {
    if (behaviour.fail) throw new Error(`${behaviour.fail}\nstack line that must not be kept`);
    const next = (checkpoint?.next ?? 0) + 1, total = params.total ?? behaviour.total ?? 3;
    if (behaviour.wait) return { checkpoint: { next: checkpoint?.next ?? 0 }, wait: behaviour.wait };
    return { checkpoint: { next }, results: 2, tokens: 10, summary: `batch ${next}`, progress: `batch ${next + 1} of ${total}`, done: next >= total };
  },
  ready: () => behaviour.ready ?? true,
});
registerJobKind({ name: "test-learning", label: "Learning", scope: "project", machineExclusive: true, sideEffects: "none",
  runBatch: () => ({ checkpoint: 1, done: true }) });
registerJobKind({ name: "test-machine", label: "Machine work", scope: "machine", sideEffects: "none",
  runBatch: () => ({ checkpoint: 1, done: true, gaps: true }) });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mex-jobs-"));
  writer = openRecord({ home: join(home, "record"), isNetwork: () => false });
  behaviour = {};
});
afterEach(() => { writer.close(); vi.restoreAllMocks(); });

describe("job states", () => {
  it("allows exactly the documented transitions and refuses every other", () => {
    for (const from of JOB_STATES) for (const to of JOB_STATES) {
      expect(canTransition(from, to)).toBe(JOB_TRANSITIONS[from].includes(to));
    }
    expect(JOB_STATES).toEqual(["queued", "running", "paused", "waiting", "done", "done with gaps", "failed", "cancelled"]);
    for (const terminal of ["done", "done with gaps", "cancelled"] as JobState[]) expect(JOB_TRANSITIONS[terminal]).toEqual([]);
  });
  it("refuses a resume of a finished job and a pause of a failed one, in plain words", async () => {
    const { job: queued } = enqueueJob(writer, { kind: "test-batches", projectId: project("a"), params: { total: 1 } });
    await runOneBatch(writer, "background:1:x");
    expect(job(queued.id).state).toBe("done");
    expect(() => requestJob(writer, queued.id, "resume")).toThrow("A done job can't be resumed.");
    behaviour.fail = "boom";
    const { job: other } = enqueueJob(writer, { kind: "test-batches", projectId: project("b") });
    for (let i = 0; i < 3; i++) await runOneBatch(writer, "background:1:x");
    expect(job(other.id).state).toBe("failed");
    expect(() => requestJob(writer, other.id, "pause")).toThrow("A failed job can't become paused.");
    expect(requestJob(writer, other.id, "cancel").state).toBe("cancelled");
  });
});

describe("batches and checkpoints", () => {
  it("commits each batch's results, checkpoint, cost and progress together", async () => {
    const { job: queued } = enqueueJob(writer, { kind: "test-batches", projectId: project("a"), tokensEstimate: 100 });
    expect(await runOneBatch(writer, "background:1:x")).toBe("ran");
    expect(job(queued.id)).toMatchObject({ state: "queued", batch: 1, results: 2, tokens_used: 10, checkpoint: '{"next":1}', progress: "batch 2 of 3", owner: null });
    await runOneBatch(writer, "background:1:x"); await runOneBatch(writer, "background:1:x");
    expect(job(queued.id)).toMatchObject({ state: "done", batch: 3, results: 6, tokens_used: 30, progress: null });
    expect(job(queued.id).finished_at).not.toBeNull();
    expect(results(queued.id)).toEqual([{ batch: 0, summary: "batch 1" }, { batch: 1, summary: "batch 2" }, { batch: 2, summary: "batch 3" }]);
    expect(await runOneBatch(writer, "background:1:x")).toBe("idle");
  });
  it("discards a batch whose job was taken over while it ran", async () => {
    let resume!: () => void;
    registerJobKind({ name: "test-slow", label: "Slow", scope: "machine", sideEffects: "none",
      runBatch: () => new Promise<BatchResult>((done) => { resume = () => done({ checkpoint: 1, results: 1 }); }) });
    const { job: queued } = enqueueJob(writer, { kind: "test-slow" });
    const running = runOneBatch(writer, "background:1:first");
    await vi.waitFor(() => expect(resume).toBeTypeOf("function"));
    // Another runner presumed the first dead and took the job over.
    writer.db.prepare("UPDATE jobs SET owner='background:2:second' WHERE id=?").run(queued.id);
    resume(); await running;
    expect(job(queued.id)).toMatchObject({ state: "running", batch: 0, results: 0, owner: "background:2:second" });
    expect(results(queued.id)).toEqual([]);
  });
  it("stops after the same failure three times, with a one-line cause; a different cause restarts the count", async () => {
    const { job: queued } = enqueueJob(writer, { kind: "test-batches", projectId: project("a") });
    behaviour.fail = "Network is down";
    await runOneBatch(writer, "background:1:x");
    expect(job(queued.id)).toMatchObject({ state: "queued", failures: 1, reason: "Network is down" });
    behaviour.fail = "Disk is full";
    await runOneBatch(writer, "background:1:x");
    expect(job(queued.id)).toMatchObject({ state: "queued", failures: 1, reason: "Disk is full" });
    await runOneBatch(writer, "background:1:x"); await runOneBatch(writer, "background:1:x");
    expect(job(queued.id)).toMatchObject({ state: "failed", failures: 3, reason: "Disk is full", owner: null });
    // Resuming keeps the position and starts the count again.
    behaviour = {};
    expect(requestJob(writer, queued.id, "resume")).toMatchObject({ state: "queued", failures: 0, reason: null });
    await runOneBatch(writer, "background:1:x");
    expect(job(queued.id).batch).toBe(1);
  });
  it("waits with one reason and continues by itself when the condition clears", async () => {
    const { job: queued } = enqueueJob(writer, { kind: "test-batches", projectId: project("a") });
    behaviour = { wait: "Waiting for your usage window to reset", ready: false };
    await runOneBatch(writer, "background:1:x");
    expect(job(queued.id)).toMatchObject({ state: "waiting", reason: "Waiting for your usage window to reset", batch: 0 });
    expect(results(queued.id)).toEqual([]);
    expect(requeueReadyJobs(writer)).toBe(0);
    expect(await runOneBatch(writer, "background:1:x")).toBe("idle");
    behaviour = { ready: true };
    expect(requeueReadyJobs(writer)).toBe(1);
    expect(job(queued.id)).toMatchObject({ state: "queued", reason: null });
    await runOneBatch(writer, "background:1:x");
    expect(job(queued.id).batch).toBe(1);
  });
  it("applies pause and cancel to a running job after its current batch", async () => {
    let release!: () => void;
    registerJobKind({ name: "test-gate", label: "Gate", scope: "machine", sideEffects: "none",
      runBatch: () => new Promise<BatchResult>((done) => { release = () => done({ checkpoint: 1, results: 1 }); }) });
    const { job: queued } = enqueueJob(writer, { kind: "test-gate" });
    let running = runOneBatch(writer, "background:1:x");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(requestJob(writer, queued.id, "pause")).toMatchObject({ state: "running", request: "pause" });
    release(); await running;
    expect(job(queued.id)).toMatchObject({ state: "paused", batch: 1, request: null });
    requestJob(writer, queued.id, "resume");
    release = undefined as never;
    running = runOneBatch(writer, "background:1:x");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    requestJob(writer, queued.id, "cancel");
    release(); await running;
    expect(job(queued.id)).toMatchObject({ state: "cancelled", batch: 2 });
    expect(() => requestJob(writer, queued.id, "cancel")).toThrow("already cancelled");
  });
  it("pauses and cancels a job that isn't running at once", () => {
    const { job: a } = enqueueJob(writer, { kind: "test-batches", projectId: project("a") });
    expect(requestJob(writer, a.id, "pause").state).toBe("paused");
    expect(requestJob(writer, a.id, "cancel").state).toBe("cancelled");
  });
});

describe("concurrency rules", () => {
  it("runs at most one job per project and one machine-exclusive job per machine, and says why the rest wait", async () => {
    const a = project("repo-a"), b = project("repo-b");
    registerJobKind({ name: "test-hold", label: "Graph build", scope: "project", sideEffects: "none",
      runBatch: () => new Promise<BatchResult>(() => { /* holds its project */ }) });
    const { job: holding } = enqueueJob(writer, { kind: "test-hold", projectId: a });
    void runOneBatch(writer, "background:1:x");
    await vi.waitFor(() => expect(job(holding.id).state).toBe("running"));
    const { job: sameRepo } = enqueueJob(writer, { kind: "test-batches", projectId: a });
    const { job: otherRepo } = enqueueJob(writer, { kind: "test-batches", projectId: b });
    expect(blockedReason(reader(), sameRepo)).toBe("Waiting: Graph build is running in repo-a");
    expect(await runOneBatch(writer, "background:1:x")).toBe("ran");
    expect(job(otherRepo.id).batch).toBe(1);
    expect(job(sameRepo.id).batch).toBe(0);

    writer.db.prepare("INSERT INTO jobs(id,project_id,kind,state,owner,tokens_used,created_at,updated_at) VALUES('l1',?, 'test-learning','running','background:1:x',0,'2026','2026')").run(b);
    const { job: learning } = enqueueJob(writer, { kind: "test-learning", projectId: project("repo-c") });
    expect(blockedReason(reader(), learning)).toBe("Waiting: learning is running in repo-b");
  });
  it("returns the open job instead of queuing a second one for the same project and kind", () => {
    const a = project("repo-a");
    const first = enqueueJob(writer, { kind: "test-batches", projectId: a });
    const second = enqueueJob(writer, { kind: "test-batches", projectId: a });
    expect(second).toEqual({ job: first.job, existing: true });
    expect(() => enqueueJob(writer, { kind: "test-batches" })).toThrow("Test batches needs a project.");
    expect(() => enqueueJob(writer, { kind: "nope" })).toThrow("Unknown job kind");
  });
});

describe("recovery", () => {
  it("requeues a job left running by a dead runner, keeps a live runner's job, and applies a pending cancel", () => {
    const a = project("a"), b = project("b"), c = project("c");
    const insert = (id: string, projectId: string, owner: string, request: string | null = null) => writer.db.prepare(
      "INSERT INTO jobs(id,project_id,kind,state,owner,request,batch,checkpoint,tokens_used,created_at,updated_at) VALUES(?,?,'test-batches','running',?,?,2,'{\"next\":2}',0,'2026','2026')")
      .run(id, projectId, owner, request);
    insert("dead", a, "background:111:x"); insert("live", b, "foreground:222:y"); insert("cancel", c, "background:111:x", "cancel");
    expect(recoverInterruptedJobs(writer, "background:333:z", (pid) => pid === 222)).toBe(2);
    expect(job("dead")).toMatchObject({ state: "queued", batch: 2, checkpoint: '{"next":2}', owner: null });
    expect(job("live")).toMatchObject({ state: "running", owner: "foreground:222:y" });
    expect(job("cancel").state).toBe("cancelled");
  });
});

describe("the jobs list", () => {
  it("lists every state across two repos with plain wording, no raw ids, and no stale progress on stopped jobs", () => {
    const a = project("repo-a"), b = project("repo-b");
    const states: Array<[JobState, string | null, string | null]> = [
      ["queued", null, "batch 1 of 4"], ["running", null, "batch 3 of 10"], ["paused", null, "batch 2 of 4"],
      ["waiting", "Waiting for your 5-hour limit to reset at 3:10 pm", "batch 2 of 4"], ["done", null, "387 / 387 parsed"],
      ["done with gaps", null, null], ["failed", "Claude Code is logged out", "batch 4 of 9"], ["cancelled", null, "batch 1 of 2"],
    ];
    states.forEach(([state, reason, progress], index) => {
      writer.db.prepare(`INSERT INTO jobs(id,project_id,kind,state,reason,progress,owner,results,tokens_used,tokens_estimate,created_at,updated_at,finished_at)
        VALUES(?,?,'test-batches',?,?,?,?,?,?,?,?,?,?)`).run(`job-${index}`, index % 2 ? b : a, state, reason, progress,
        state === "running" ? `background:${process.pid}:x` : null, index, index * 100, index === 1 ? 5000 : null,
        `2026-01-01T00:00:0${index}Z`, `2026-01-01T00:00:0${index}Z`, null);
    });
    writer.db.prepare("INSERT INTO jobs(id,project_id,kind,state,tokens_used,created_at,updated_at) VALUES('future',NULL,'from-the-future','queued',0,'2026-01-02','2026-01-02')").run();
    const read = openRecordReadOnly({ home: writer.location.home })!;
    try {
      const items = listJobs(read);
      expect(items.map((item) => [item.position, item.state, item.project?.name ?? null])).toEqual([
        [1, "queued", null], [2, "cancelled", "repo-b"], [3, "failed", "repo-a"], [4, "done with gaps", "repo-b"], [5, "done", "repo-a"],
        [6, "waiting", "repo-b"], [7, "paused", "repo-a"], [8, "running", "repo-b"], [9, "queued", "repo-a"],
      ]);
      const text = items.map(describeJob).join("\n");
      expect(text).not.toMatch(/job-\d|[0-9a-f]{8}-[0-9a-f]{4}/);
      expect(text).not.toContain("387 / 387");
      expect(text).toContain(" 1  Unknown job (needs a newer MEX) · this machine");
      expect(text).toContain("    running · batch 3 of 10 · 1 result so far · 100 of about 5,000 tokens");
      expect(text).toContain("    waiting: Waiting for your 5-hour limit to reset at 3:10 pm · batch 2 of 4 · 3 results so far · 300 tokens");
      expect(text).toContain("    failed: Claude Code is logged out · 6 results · 600 tokens");
      expect(text).toContain(`Test batches · repo-a (${join(home, "repo-a")})`);
      const json = JSON.parse(JSON.stringify(items.map(({ id: _id, ...item }) => item)));
      expect(json[7]).toMatchObject({ position: 8, state: "running", doing: "batch 3 of 10", tokens: { used: 100, estimate: 5000 } });
      expect(json[4]).toMatchObject({ state: "done", doing: null });
    } finally { read.close(); }
  });
  it("shows a running job whose runner died as interrupted", () => {
    writer.db.prepare(`INSERT INTO jobs(id,project_id,kind,state,progress,owner,tokens_used,created_at,updated_at)
      VALUES('j',NULL,'test-machine','running','batch 2 of 3','background:999999:x',0,'2026','2026')`).run();
    expect(listJobs(reader())[0]!.doing).toBe("interrupted; resumes from its last batch when the background process starts again");
  });
});
