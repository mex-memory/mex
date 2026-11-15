import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecord, projectIdentity, type RecordWriter } from "../../record/index.js";
import { enqueueJob, registerJobKind, runOneBatch, requeueReadyJobs, type JobRow } from "../../record/jobs.js";
import { runModel, type ModelRequest, type ModelResult } from "../../model-runner/index.js";
import { enqueueModelBatch, claimModelBatch, settleModelBatch } from "../../model-runner/budget-queue.js";
import { REFERENCE_BATCH } from "../../model-runner/budget-prices.js";
import { serializeEntry, type EntryCheck } from "../../knowledge/entry.js";
import { entry } from "../../knowledge/__tests__/fixtures.js";
import type { NativeReport } from "../../knowledge/check.js";
import { createJudgeKind, readJudgement, type JudgeDependencies } from "../job.js";
import { hash, nextBatch, type Candidate } from "../evidence.js";

let base: string, root: string, home: string, writer: RecordWriter, projectId: string;
let report: NativeReport, calls: ModelRequest[], deps: JudgeDependencies;
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
const row = (id: string) => writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as unknown as JobRow;
const source = (path: string, value: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), value); };
const usage = { input: 100, cache_write: 0, cache_read: 0, output: 20, model: "test", estimated: false };
function answer(request: ModelRequest, result: "still-true" | "cannot-tell" = "still-true"): ModelResult {
  const snapshot = JSON.parse(request.prompt.split("Evidence follows as JSON:\n")[1]!);
  return { text: JSON.stringify({ results: snapshot.entries.map((e: { id: string }) => ({ id: e.id, result })) }), selectedModel: "test-cheap", usage };
}
function add(id: string, path = "src/api.ts", verdict: "changed" | "broken" | "held" = "changed", role: "complete" | "supporting" = "supporting") {
  const check: EntryCheck = { kind: "source", role, target: { file: path }, saw: { hash: hash("old\n") }, files: { [path]: hash("old\n") } };
  const value = entry(id, { kind: "fact", checks: [check], one_line: `${path} uses the old behavior.` }, `${path} uses the old behavior.`);
  const file = join(root, ".mex/learned", `${id}.md`);
  writeFileSync(file, serializeEntry(value));
  report.items!.push({ id, path: file, level: "team", status: "active", kind: "fact", verdict });
  report.results!.push({ entry_id: id, verdict, checks: [{ index: 0, kind: "source", role, status: verdict === "broken" ? "fail" : "pass" }] });
  return file;
}
function queue(near = ["src/api.ts"]) {
  registerJobKind(createJudgeKind(deps));
  return enqueueJob(writer, { kind: "judge", projectId, params: { checkout: root, agent: "claude", near } }).job.id;
}
async function run(id: string) { await runOneBatch(writer, "test", { only: new Set([id]) }); }
async function finish(id: string) {
  for (let n = 0; n < 12 && row(id).state === "queued"; n++) await run(id);
  return row(id);
}
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-judge-")));
  root = join(base, "repo"); home = join(base, "home"); mkdirSync(root);
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  source("src/api.ts", "old\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "baseline");
  source("src/api.ts", "new\ncaller also changed\n");
  mkdirSync(join(root, ".mex/learned"), { recursive: true });
  vi.stubEnv("MEX_HOME", home);
  writer = openRecord({ home, projectPath: root, isNetwork: () => false });
  projectId = writer.checkout(root)!.project_id;
  report = { ok: true, stored: false, items: [], results: [], problems: [] };
  calls = [];
  deps = {
    evaluate: vi.fn(async () => report), recordChecks: vi.fn(async () => undefined),
    model: vi.fn(async request => { calls.push(request); return answer(request); }),
  };
});
afterEach(() => { writer.close(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

describe("judge job and queue", () => {
  it("requires one file common to every member of a batch", () => {
    const candidate = (id: string, files: string[]) => ({ item: { id }, files, spare: false }) as Candidate;
    const values = [candidate("first", ["a.ts", "b.ts"]), candidate("second", ["a.ts"]), candidate("third", ["b.ts"])];
    expect(nextBatch(values).map(c => c.item.id)).toEqual(["first", "second"]);
  });
  it("judges unresolved entries nearest first, at most five sharing a file, then complete held entries", async () => {
    source("other/a.ts", "new\n");
    add("mx_faraway", "other/a.ts");
    for (let i = 0; i < 6; i++) add(`mx_near00${i}`);
    add("mx_spare00", "src/api.ts", "held", "complete");
    const id = queue();
    expect((await finish(id)).state).toBe("done");
    const groups = calls.map(c => JSON.parse(c.prompt.split("Evidence follows as JSON:\n")[1]!).entries.map((e: { id: string }) => e.id));
    expect(groups).toEqual([["mx_near000", "mx_near001", "mx_near002", "mx_near003", "mx_near004"], ["mx_near005"], ["mx_faraway"], ["mx_spare00"]]);
    expect(calls.every(c => c.role === "cheap" && c.automatic && c.purpose === "judge")).toBe(true);
    expect(readJudgement(writer, projectId, root, "mx_near000")).toMatchObject({ result: "still-true", label: "checked by model", model: "test-cheap" });
  });
  it("includes the claim, check observations and all changes in the file, including the caller", async () => {
    add("mx_context"); const id = queue(); await finish(id);
    const snapshot = JSON.parse(calls[0]!.prompt.split("Evidence follows as JSON:\n")[1]!);
    expect(snapshot.entries[0].entry.text).toContain("old behavior");
    expect(snapshot.entries[0].checks_now).toHaveLength(1);
    expect(snapshot.files[0].baselines[0]).toMatchObject({ hash: hash("old\n"), commit: git("rev-parse", "HEAD") });
    expect(snapshot.files[0].baselines[0].diff).toContain("+caller also changed");
  });
  it("stores a validated rewrite locally with freshly recorded checks, leaving knowledge bytes alone", async () => {
    const file = add("mx_rewrite", "src/api.ts", "broken", "complete"); const before = readFileSync(file, "utf8");
    deps.model = vi.fn(async request => ({ ...answer(request), text: JSON.stringify({ results: [{ id: "mx_rewrite", result: "rewritten", text: "The new behavior includes the caller.", one_line: "New behavior.", checks: [{ kind: "source", role: "complete", target: { file: "src/api.ts" } }] }] }) }));
    const current = hash(readFileSync(join(root, "src/api.ts"), "utf8"));
    deps.recordChecks = vi.fn(async (): Promise<EntryCheck[]> => [{ kind: "source", role: "complete", target: { file: "src/api.ts" }, saw: { hash: current }, files: { "src/api.ts": current } }]);
    const id = queue(); await finish(id);
    expect(readJudgement(writer, projectId, root, "mx_rewrite")).toMatchObject({ result: "rewritten", rewrite: { text: "The new behavior includes the caller.", mex: { checks: [{ files: { "src/api.ts": current } }] } } });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(git("status", "--porcelain")).not.toContain("M .mex");
  });
  it("cannot certify a rewrite whose proposed checks cannot be recorded", async () => {
    add("mx_badcheck");
    deps.model = vi.fn(async request => ({ ...answer(request), text: JSON.stringify({ results: [{ id: "mx_badcheck", result: "rewritten", text: "New fact.", one_line: "New fact.", checks: [{ kind: "value", role: "complete", target: { file: "gone.ts", symbol: "missing" } }] }] }) }));
    const id = queue(); expect((await finish(id)).state).toBe("done with gaps");
    expect(readJudgement(writer, projectId, root, "mx_badcheck")).toMatchObject({ result: "cannot-tell" });
  });
  it("skips unavailable or oversized source evidence without calling the model", async () => {
    add("mx_toobig0"); source("src/api.ts", "x".repeat(65 << 10));
    const id = queue(); expect((await finish(id)).state).toBe("done with gaps");
    expect(deps.model).not.toHaveBeenCalled();
    expect(readJudgement(writer, projectId, root, "mx_toobig0")).toBeUndefined();
  });
  it("keeps an unavailable historical baseline explicit", async () => {
    source("untracked.ts", "new uncommitted behavior\n"); add("mx_nobase0", "untracked.ts");
    const id = queue(); await finish(id);
    const snapshot = JSON.parse(calls[0]!.prompt.split("Evidence follows as JSON:\n")[1]!);
    expect(snapshot.files[0].baselines).toEqual([{ hash: hash("old\n"), commit: null, diff: null }]);
  });
  it("resumes without spending again on the same inputs, including a lost job checkpoint", async () => {
    add("mx_restart"); const id = queue(); await run(id);
    expect(calls).toHaveLength(1);
    writer.db.prepare("UPDATE jobs SET checkpoint=NULL WHERE id=?").run(id);
    await finish(id);
    writer.close(); writer = openRecord({ home, isNetwork: () => false });
    await finish(queue());
    expect(calls).toHaveLength(1);
  });
  it.each(["source", "entry", "branch", "consent"])("discards a model response when %s changes in flight", async what => {
    const file = add("mx_racing0");
    deps.model = vi.fn(async request => {
      if (what === "source") source("src/api.ts", "changed again\n");
      if (what === "entry") writeFileSync(file, serializeEntry(entry("mx_racing0", { kind: "fact" }, "Different claim.")));
      if (what === "branch") git("switch", "-c", "unrelated");
      if (what === "consent") writer.db.prepare("UPDATE checkouts SET state='off' WHERE path=?").run(root);
      return answer(request);
    });
    const id = queue(); await run(id);
    expect(row(id).results).toBe(0);
    expect(readJudgement(writer, projectId, root, "mx_racing0")).toBeUndefined();
    if (what === "branch") { await run(id); expect(row(id).state).toBe("done with gaps"); }
  });
  it("waits above the real cap without launching a model or advancing the batch", async () => {
    add("mx_capped0");
    writer.db.prepare("INSERT INTO settings VALUES('own-usage','status.claude',?)").run(JSON.stringify({ agent: "claude", status: "readable" }));
    // Consume the shared allowance through its real accounting API, with no model.
    for (let i = 0; i < 7; i++) {
      const batch = enqueueModelBatch(writer, { agent: "claude", model: "opus", projectPath: root, automatic: { estimate: REFERENCE_BATCH } });
      expect(claimModelBatch(writer, batch)).toBeUndefined();
      settleModelBatch(writer, batch, { ...REFERENCE_BATCH, model: "opus", estimated: false });
    }
    const spawn = vi.fn(() => { throw new Error("The capped judge must not launch a process"); });
    deps.model = request => runModel({ ...request, __internal: { spawn: spawn as never } });
    const id = queue(); await run(id);
    expect(row(id)).toMatchObject({ state: "waiting", batch: 0, results: 0, failures: 0 });
    expect(row(id).reason).toContain("allowance is used up");
    expect(writer.db.prepare("SELECT count(*) n FROM model_batches WHERE state='running'").get()!.n).toBe(0);
    expect(requeueReadyJobs(writer)).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });
  it("records cannot-tell once and rejects duplicate/missing model answers without leaking response text", async () => {
    add("mx_unknown"); deps.model = vi.fn(async request => answer(request, "cannot-tell"));
    const id = queue(); expect((await finish(id)).state).toBe("done with gaps");
    await finish(queue()); expect(deps.model).toHaveBeenCalledTimes(1);
    source("src/api.ts", "later\n");
    deps.model = vi.fn(async () => ({ text: '{"results":[],"private":"not for logs"}', selectedModel: "test", usage }));
    const bad = queue(); expect((await finish(bad)).state).toBe("failed");
    expect(row(bad).reason).toBe("The judge did not return one valid answer per entry.");
  });
});
