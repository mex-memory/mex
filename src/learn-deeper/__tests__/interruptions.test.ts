import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as gate from "../../knowledge/gate.js";
import { ModelRunError, type runModel } from "../../model-runner/index.js";
import { claimModelBatch, enqueueModelBatch, recoverModelBatches, settleModelBatch } from "../../model-runner/budget-queue.js";
import { recordedModelSpend } from "../../model-runner/consent.js";
import { runBackground } from "../../record/background.js";
import { describeJob, listJobs, ownerId, registerJobKind, requeueReadyJobs, runOneBatch, type JobRow } from "../../record/jobs.js";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { ZERO } from "../../record/usage.js";
import { ForgeClient } from "../forge.js";
import * as harvest from "../harvest/index.js";
import { createLearnKind } from "../job.js";
import { offerLearning } from "../offer.js";
import { LEARN_KIND } from "../plan.js";
import { reviewRows } from "../pipeline.js";
import * as proof from "../prove.js";
import { WEEKLY_KIND } from "../weekly-schedule.js";
import { accept, advance, claim, commit, doc, docReply, due, git, jobRow, mockGithub, notes, only, path, rawRows, reply, repo, state, useLearningFixture } from "./fixtures/learning.js";
import { isGatePrompt } from "./fixtures/gate.js";

useLearningFixture();

type Request = Parameters<typeof runModel>[0];
const deadPid = 2_000_000_000;
const interrupted = "Fixture stage interrupted.";
const status = (writer: RecordWriter, job: JobRow) => describeJob(listJobs({
  all: (sql, ...args) => writer.db.prepare(sql).all(...args) as never,
}, 50, { terminal: true, details: true }).find(item => item.id === job.id)!);
const phase = (row: JobRow) => state(row).v2?.phase ?? "harvest";
const callStage = ({ prompt, role }: Request) => {
  if (role === "cheap") return "triage";
  if (isGatePrompt(prompt)) return "gate";
  if (prompt.startsWith("You turn observations")) return "norm";
  if (prompt.startsWith("Find a code pattern")) {
    return JSON.parse(prompt.split("\n").at(-1)!)[0].previous ? "repair" : "pattern";
  }
  return "writing";
};
const stages = (model: ReturnType<typeof vi.fn<typeof runModel>>) => model.mock.calls.map(([request]) => callStage(request));

async function atPhase(writer: RecordWriter, job: JobRow, target: string) {
  const at = await advance(writer, job, row => row.state !== "queued" || phase(row) === target);
  expect(at.state, String(at.reason)).toBe("queued");
  expect(phase(at)).toBe(target);
  return at;
}

function claimed(writer: RecordWriter, job: JobRow, age = 0) {
  writer.db.prepare("UPDATE jobs SET state='running',owner=?,updated_at=? WHERE id=?")
    .run(ownerId("background", deadPid), new Date(Date.now() - age).toISOString(), job.id);
  return jobRow(writer);
}

function finish(writer: RecordWriter, job: JobRow, done: JobRow, results: number, end = "done") {
  expect(done, String(done.reason)).toMatchObject({ id: job.id, state: end, results, owner: null, failures: 0 });
  expect(notes(writer, job)).toHaveLength(results);
  expect(reviewRows(writer, job.project_id!, job.id)).toHaveLength(results);
  expect(rawRows(writer, job)).toEqual([]);
}

function admit(writer: RecordWriter, job: JobRow, stage: string) {
  const estimate = { ...ZERO, input: 13 };
  const batch = enqueueModelBatch(writer, {
    agent: "codex", model: "gpt-6.1-sol", projectPath: repo,
    consented: { estimate, ceiling: 100_000 },
    job: { jobId: job.id, batch: job.batch, projectId: job.project_id, stage: "call." + stage },
  });
  expect(claimModelBatch(writer, batch)).toBeUndefined();
  return batch;
}

async function screen(job: JobRow) {
  const lines: string[] = [];
  const confirm = vi.fn(async () => false);
  await offerLearning({ root: JSON.parse(job.params).checkout, projectId: job.project_id!, write: line => lines.push(line),
    explicit: true, interactive: true, confirm });
  expect(confirm).not.toHaveBeenCalled();
  return lines.join("\n");
}

it.each([
  { event: "terminal closed before model admission", paid: "none", age: 0 },
  { event: "terminal closed mid-batch", paid: "admitted", age: 0 },
  { event: "terminal closed after saving the reply", paid: "answered", age: 0 },
  { event: "sleep or reboot (modelled by a dead owner and a six-hour clock jump)", paid: "answered", age: 6 * 60 * 60_000 },
] as const)("recovers after $event", async ({ paid, age }) => {
  await accept();
  const writer = openRecord();
  let now = Date.now();
  const model = vi.fn<typeof runModel>(async request => {
    if (!isGatePrompt(request.prompt)) {
      const batch = admit(writer, jobRow(writer), "docs.0");
      settleModelBatch(writer, batch, { ...ZERO, input: 13, model: "gpt-6.1-sol", estimated: false });
    }
    return docReply(request);
  });
  const kind = createLearnKind({ model, now: () => now });
  registerJobKind(kind);
  try {
    const job = jobRow(writer);
    const at = await atPhase(writer, job, "write");
    const running = claimed(writer, job, age);
    if (paid === "answered") {
      // Leave the job owner in place, as if the runner died in proof before the write.
      vi.spyOn(proof, "proveEntry").mockRejectedValueOnce(new Error(interrupted));
      await expect(kind.runBatch({ writer, job: running, params: JSON.parse(job.params), checkpoint: state(running) }))
        .rejects.toThrow(interrupted);
      expect(rawRows(writer, job).some(row => String(row.key).endsWith(".reply.docs.0"))).toBe(true);
    } else if (paid === "admitted") {
      // The request reached admission. Killing the owner leaves no reply and no settlement.
      const batch = admit(writer, running, "docs.0");
      writer.db.prepare("UPDATE model_batches SET pid=? WHERE id=?").run(deadPid, batch.id);
    }
    expect(rawRows(writer, job).length).toBeGreaterThan(0);
    expect(jobRow(writer)).toMatchObject({ state: "running", batch: at.batch, results: 0 });
    expect(status(writer, job)).toContain("interrupted");
    const shown = await screen(job);
    expect(shown).toContain("interrupted.");
    expect(shown).toContain("`mex jobs`");
    now += age;
    vi.stubEnv("MEX_BACKGROUND", "1");
    expect(await runBackground({ isNetwork: () => false, memory: () => Infinity, clock: () => now })).toBe("memory");
    const progress = paid === "none" ? "Reading sources again after interruption" : "Finishing after interrupted learning was cleared";
    expect(jobRow(writer)).toMatchObject({ state: "queued", owner: null, batch: at.batch, progress });
    expect(rawRows(writer, job)).toEqual([]);
    recoverModelBatches(writer, now, () => false);
    const harvestAgain = vi.spyOn(harvest, "harvestBatch");
    const done = await advance(writer, job);
    if (paid === "none") {
      finish(writer, job, done, 1);
      expect(harvestAgain).toHaveBeenCalled();
      expect(stages(model)).toEqual(["writing", "gate"]);
    } else {
      finish(writer, job, done, 0, "done with gaps");
      expect(harvestAgain).not.toHaveBeenCalled();
      expect(stages(model)).toEqual(paid === "answered" ? ["writing"] : []);
      const states = writer.db.prepare("SELECT state FROM model_batches WHERE job_id=?").all(job.id);
      expect(states).toEqual([{ state: paid === "admitted" ? "interrupted" : "done" }]);
      expect(status(writer, job)).toContain("Learning stopped after an interruption.");
      expect(status(writer, job)).toContain("Run mex learn to start a new run.");
    }
    expect(recordedModelSpend(writer, job.id)).toBe(13);
  } finally { writer.close(); }
}, 60_000);

const file = "src/changed.ts";
const rule = "Use the stable adapter for changedEntry instead of calling fallback.";
function recordedReview() {
  const recorded = readFileSync(new URL("./fixtures/harvest/changes.json", import.meta.url), "utf8");
  const { originalLines } = JSON.parse(recorded);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, file), originalLines.join("\n") + "\n");
  const before = commit("Add the adapter");
  writeFileSync(join(repo, file), originalLines.join("\n").replace("fallback(label)", "stable(label)") + "\n");
  const after = commit("Use the stable adapter");
  const { merged } = JSON.parse(recorded.replaceAll("OID_ORIGINAL", before).replaceAll("OID_MERGE", after));
  const now = Date.now();
  const at = new Date(now - 24 * 60 * 60_000).toISOString();
  merged.mergedAt = merged.closedAt = at;
  merged.reviewThreads.nodes = merged.reviewThreads.nodes.slice(0, 1);
  merged.reviewThreads.totalCount = 1;
  const comment = merged.reviewThreads.nodes[0].comments.nodes[0];
  comment.body = rule;
  comment.createdAt = new Date(now - 2 * 24 * 60 * 60_000).toISOString();
  merged.body = "";
  merged.files.nodes = [{ path: file }];
  merged.changedFiles = 1;
  vi.stubGlobal("fetch", mockGithub({ at, pull: merged }));
}

function stageReply(request: Request) {
  switch (callStage(request)) {
    case "triage": {
      const item = /^\[(i\d+)\] .*Use the stable adapter/mu.exec(request.prompt)?.[1];
      expect(item).toBeDefined();
      return reply({ observations: [{ item, quote: rule, norm: rule, kind: "api-design", scope: [file],
        form: "stated", why: "", stated_as_rule: true, response: "changed" }] });
    }
    case "norm": {
      const observation = JSON.parse(request.prompt.split("\n").find(line => line.startsWith('{"id":"sha256:'))!);
      return reply({ policies: [], norms: [{ text: rule, kind: observation.kind, scope: [file], support: [observation.id], patternable: true }] });
    }
    case "pattern":
    case "repair": {
      const [{ id, previous }] = JSON.parse(request.prompt.split("\n").at(-1)!);
      return reply({ patterns: [{ id, when: [{ type: "anti", match: "literal", pattern: previous ? "fallback(" : "auditComplete(" }],
        fix: { pair: 0, start: 3, end: 3 }, examples: { flag: "return fallback(label);", ok: "return stable(label);" } }] });
    }
    default: return docReply(request);
  }
}

it.each(["harvest", "triage", "writing", "proof", "repair", "gate", "publishing"] as const)(
  "restarts the last committed stage when %s throws", async stage => {
    recordedReview();
    await accept();
    let fail = true;
    const model = vi.fn<typeof runModel>(async request => {
      if (fail && callStage(request) === stage) throw new Error(interrupted);
      return stageReply(request);
    });
    registerJobKind(createLearnKind({ model }));
    const writer = openRecord();
    try {
      const job = jobRow(writer);
      const at = await atPhase(writer, job, stage === "harvest" || stage === "triage" ? stage : "write");
      if (stage === "harvest") vi.spyOn(harvest, "harvestBatch").mockRejectedValueOnce(new Error(interrupted));
      if (stage === "proof") vi.spyOn(proof, "proveEntry").mockRejectedValueOnce(new Error(interrupted));
      const publish = vi.spyOn(gate, "propose");
      if (stage === "publishing") publish.mockRejectedValueOnce(new Error(interrupted));
      await runOneBatch(writer, ownerId("foreground"), only(job));
      expect(jobRow(writer)).toMatchObject({ state: "queued", batch: at.batch, reason: interrupted, failures: 1, owner: null, results: 0 });
      expect(status(writer, job)).toContain("queued (last try: " + interrupted + ")");
      expect(await screen(job)).toContain(interrupted);
      fail = false;
      finish(writer, job, await advance(writer, job), 2);
      expect(reviewRows(writer, job.project_id!, job.id)).toContainEqual(expect.objectContaining({ claim: rule, proven: true }));
      const expected = ["triage", "norm", "writing", "pattern", "repair", "gate"];
      if (stage === "triage" || stage === "writing" || stage === "repair" || stage === "gate") {
        expected.splice(expected.indexOf(stage), 0, stage);
      }
      expect(stages(model)).toEqual(expected);
      expect(publish).toHaveBeenCalledTimes(stage === "publishing" ? 2 : 1);
    } finally { writer.close(); }
  }, 60_000,
);

it.each(["offline", "expired login"] as const)("pauses inside GitHub harvest when %s", async failure => {
  recordedReview();
  await accept();
  const fetch = globalThis.fetch;
  let broken = true, now = Date.now();
  const model = vi.fn<typeof runModel>(async request => stageReply(request));
  const client = async (plan: { origin: ConstructorParameters<typeof ForgeClient>[0] }) => new ForgeClient(plan.origin, "forge-fixture-token",
    async (input, init) => {
      if (!broken || new URL(String(input)).pathname !== "/graphql") return fetch(input, init);
      if (failure === "expired login") return new Response(null, { status: 401 });
      throw new TypeError("Fixture connection unavailable");
    }, 0);
  registerJobKind(createLearnKind({ model, client, now: () => now }));
  const writer = openRecord();
  try {
    const job = jobRow(writer);
    const waiting = await advance(writer, job);
    const message = failure === "offline" ? /could not be reached/iu : /sign in/iu;
    expect(waiting).toMatchObject({ state: "waiting", batch: job.batch, failures: 0, results: 0, owner: null });
    expect(status(writer, job)).toMatch(message);
    expect(await screen(job)).toMatch(message);
    expect(model).not.toHaveBeenCalled();
    expect(requeueReadyJobs(writer)).toBe(0);
    broken = false;
    now += 61_000;
    expect(requeueReadyJobs(writer)).toBe(1);
    finish(writer, job, await advance(writer, job), 2);
    expect(stages(model)).toEqual(["triage", "norm", "writing", "pattern", "repair", "gate"]);
  } finally { writer.close(); }
}, 60_000);

it.each([
  { case: "usage limit", problem: "usage_limit", message: /usage limit/iu },
  { case: "expired login", problem: "authentication", message: /sign in/iu },
  { case: "offline, reported as a failed command", problem: "failed", message: /model command failed/iu },
] as const)("handles an interrupted agent call ($case)", async ({ problem, message }) => {
  await accept();
  let broken = true, now = Date.now();
  const writer = openRecord();
  try {
    const job = jobRow(writer);
    const model = vi.fn<typeof runModel>(async request => {
      if (broken && isGatePrompt(request.prompt)) {
        // The real runner settles unsuccessful invocations conservatively even if there is no reply.
        const batch = admit(writer, jobRow(writer), "gate.window.0");
        settleModelBatch(writer, batch, { ...ZERO, input: 13, model: "gpt-6.1-sol", estimated: true });
        throw new ModelRunError(problem, "codex");
      }
      return docReply(request);
    });
    registerJobKind(createLearnKind({ model, now: () => now }));
    const at = await atPhase(writer, job, "write");
    await runOneBatch(writer, ownerId("foreground"), only(job));
    const waiting = jobRow(writer);
    expect(waiting).toMatchObject({ state: problem === "failed" ? "queued" : "waiting", batch: at.batch, results: 0 });
    expect(status(writer, job)).toMatch(message);
    expect(await screen(job)).toMatch(message);
    expect(recordedModelSpend(writer, job.id)).toBeGreaterThan(0);
    broken = false;
    if (waiting.state === "waiting") {
      expect(requeueReadyJobs(writer)).toBe(0);
      now += 61_000;
      expect(requeueReadyJobs(writer)).toBe(1);
    }
    const done = await advance(writer, job);
    if (problem === "failed") {
      // The runner returns a generic failure for connection errors. It retries once before
      // returning control to jobs, which subsequently accounts for the missing gate reply.
      finish(writer, job, done, 1, "done with gaps");
      expect(status(writer, job)).toContain("paid model reply could not be recovered");
    } else {
      finish(writer, job, done, 1);
    }
    expect(stages(model)).toEqual(["writing", "gate", "gate"]);
  } finally { writer.close(); }
}, 60_000);

it.each(["branch switch", "second mex", "weekly run"] as const)("keeps the paid writer reply through a %s", async event => {
  const { ask } = await accept();
  const writer = openRecord();
  try {
    const job = jobRow(writer);
    const model = vi.fn<typeof runModel>(async request => {
      if (isGatePrompt(request.prompt) && model.mock.calls.length === 2) {
        expect(jobRow(writer)).toMatchObject({ state: "running" });
        if (event === "branch switch") {
          // The pinned plan sees the same observable change as checking out another branch.
          writeFileSync(join(repo, path), doc("The other revision has different guidance."));
          commit("Change the contributor guide");
          throw new Error(interrupted);
        }
        if (event === "second mex") {
          expect(await screen(job)).toMatch(/Deep analysis: running/u);
          expect(await runOneBatch(writer, ownerId("foreground"), only(job))).toBe("idle");
          expect(ask).toHaveBeenCalledTimes(1);
          expect(writer.db.prepare("SELECT id FROM jobs WHERE kind=?").all(LEARN_KIND)).toHaveLength(1);
        } else {
          const other = openRecord();
          try {
            due(other, git("rev-parse", "HEAD"), Date.now());
            expect(other.db.prepare("SELECT id FROM jobs WHERE kind=?").all(WEEKLY_KIND)).toEqual([]);
          } finally { other.close(); }
        }
      }
      return docReply(request);
    });
    registerJobKind(createLearnKind({ model }));
    if (event === "branch switch") {
      const at = await atPhase(writer, job, "write");
      await runOneBatch(writer, ownerId("foreground"), only(job));
      expect(jobRow(writer)).toMatchObject({ state: "queued", batch: at.batch, reason: interrupted, results: 0 });
      expect(status(writer, job)).toContain(interrupted);
      expect(await screen(job)).toContain(interrupted);
    }
    finish(writer, job, await advance(writer, job), 1);
    expect(notes(writer, job)[0]?.mex.one_line).toBe(claim);
    expect(stages(model)).toEqual(event === "branch switch" ? ["writing", "gate", "gate"] : ["writing", "gate"]);
  } finally { writer.close(); }
}, 60_000);
