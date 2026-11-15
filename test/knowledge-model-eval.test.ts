import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MODEL, checkPrompt, makePlan, proposals, runEvaluation, score, type CorpusData } from "../scripts/knowledge-bench/model-runtime.js";
import type { ModelRequest, ModelResult } from "../src/model-runner/index.js";
import { openRecord } from "../src/record/index.js";
import { buildIndex } from "../src/file-index/build.js";

let base: string, subject: string, binary: string, corpus: CorpusData, serial = 0;
const git = (...args: string[]) => execFileSync("git", ["-C", subject, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-model-bench-"))); subject = join(base, "subject"); mkdirSync(subject);
  binary = join(base, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  const commit = (version: string) => {
    writeFileSync(join(subject, "package.json"), JSON.stringify({ name: "fixture", version }) + "\n");
    git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", version); return git("rev-parse", "HEAD");
  };
  const c0 = commit("1"), c1 = commit("2"), c2 = commit("1");
  corpus = { manifest: { dataset_sha256: "a".repeat(64) },
    claims: [{ id: "one", file: "package.json", one_line: "The package name is fixture." }, { id: "two", file: "package.json", one_line: "The package version is 1." }],
    checkpoints: [{ id: "C0", sha: c0 }, { id: "C1", sha: c1 }, { id: "C2", sha: c2 }],
    labels: ["C0", "C1", "C2"].flatMap(checkpoint => [{ claim: "one", checkpoint, truth: true }, { claim: "two", checkpoint, truth: checkpoint !== "C1" }]),
  };
}, 300_000);
beforeEach(() => { vi.stubEnv("MEX_HOME", join(base, `isolated-${serial++}`)); vi.stubEnv("MEX_OFF", "0"); });
afterEach(() => vi.unstubAllEnvs());
afterAll(() => {
  // Remove only known temporary fixture worktrees through Git, without force.
  if (base) {
    const trees = git("worktree", "list", "--porcelain").split("\n").filter(l => l.startsWith("worktree ")).map(l => l.slice(9));
    for (const tree of trees) if (tree !== subject) {
      // These fixture files are owned by this test; make the worktree clean first.
      rmSync(join(tree, ".mex"), { recursive: true });
      git("worktree", "remove", tree);
    }
    rmSync(base, { recursive: true });
  }
});
const options = () => ({ plan: makePlan(corpus, subject, "b".repeat(40)), corpus, subject, binary, work: join(base, `run-${serial++}`), refreshIndex: () => {} });
function fakeModel(request: ModelRequest): ModelResult {
  const evidence = JSON.parse(request.prompt.split("Evidence follows as JSON:\n")[1]!.split("\nRepair only")[0]!);
  const results = request.purpose.startsWith("judge-bench.") ? evidence.claims.map((c: { id: string }) => ({ id: c.id, checks: [
    { kind: "key", role: "complete", target: { file: "package.json", pointer: c.id.endsWith("one") ? "/name" : "/version" } },
  ] })) : evidence.entries.map((e: { id: string }) => e.id.endsWith("one") ? { id: e.id, result: "still-true" } : {
    id: e.id, result: "rewritten", one_line: "The package version is 2.", text: "The package version is 2.",
    checks: [{ kind: "key", role: "complete", target: { file: "package.json", pointer: "/version" } }],
  });
  return { selectedModel: MODEL, text: JSON.stringify({ results }), usage: { input: 100, cache_write: 0, cache_read: 0, output: 30, estimated: false, model: MODEL } };
}

it("does not reveal hand-written check targets or truth labels to the writer", () => {
  const claims = corpus.claims.map(c => ({ ...c, check: { target: "oracle-only-marker" }, truth: false }));
  const prompt = checkPrompt(claims, '{"name":"fixture","version":"1"}');
  expect(prompt).not.toContain("oracle-only-marker"); expect(prompt).not.toContain('"truth"'); expect(prompt).toContain("mx_kbxone");
});
it("binds the quote to candidate, corpus sources, prices and sample denominators", () => {
  const first = makePlan(corpus, subject, "b".repeat(40));
  expect(first.historical.comparable_sample).toBe(false); expect(first.check_writer_calls).toBe(1);
  expect(first.checkpoints.map(c => [c.true, c.stale])).toEqual([[2, 0], [1, 1], [2, 0]]);
  expect(makePlan(corpus, subject, "c".repeat(40)).approval_hash).not.toBe(first.approval_hash);
  const changed = structuredClone(corpus); changed.claims[0]!.one_line += " Another claim.";
  expect(makePlan(changed, subject, "b".repeat(40)).approval_hash).not.toBe(first.approval_hash);
  const labels = structuredClone(corpus);
  for (const row of labels.labels) if (row.checkpoint === "C1") row.truth = !row.truth;
  expect(makePlan(labels, subject, "b".repeat(40)).approval_hash).not.toBe(first.approval_hash);
});
it("retains privacy-withheld cases in the plan instead of paying to send their source", () => {
  const blocked = structuredClone(corpus); blocked.claims[0]!.one_line = 'const password = "example-placeholder-value";';
  const plan = makePlan(blocked, subject, "b".repeat(40));
  expect(plan.privacy_withheld).toEqual(["one", "two"]); expect(plan.check_writer_calls).toBe(0);
  expect(plan.checkpoints[0]!.true).toBe(2);
});
it("refuses missing or stale approval before any model or workspace mutation", async () => {
  const opts = options(), model = vi.fn(async request => fakeModel(request));
  await expect(runEvaluation({ ...opts, approvalHash: "unapproved", model })).rejects.toThrow("exact approved plan");
  expect(model).not.toHaveBeenCalled(); expect(existsSync(opts.work)).toBe(false);
});
it("never replaces an existing work directory", async () => {
  const opts = options(); mkdirSync(opts.work); writeFileSync(join(opts.work, "keep"), "preserve");
  await expect(runEvaluation({ ...opts, approvalHash: opts.plan.approval_hash, model: vi.fn() })).rejects.toThrow("new work directory");
  expect(readFileSync(join(opts.work, "keep"), "utf8")).toBe("preserve");
});
it("rejects duplicate, missing and escaped generated checks", () => {
  const good = { id: "mx_kbxone", checks: [{ kind: "key", role: "complete", target: { file: "outside.json", pointer: "/name" } }] };
  expect(() => proposals(JSON.stringify({ results: [good] }), corpus.claims)).toThrow();
  expect(() => proposals(JSON.stringify({ results: [good, good] }), corpus.claims)).toThrow();
  expect(() => proposals(JSON.stringify({ results: [good] }), [corpus.claims[0]!])).toThrow("escaped");
});
it("does not count unknown withholding as proven stale detection, or stale full text as a catch", () => {
  const common = { check_generation_failed: false, judgement: undefined };
  const result = score([
    { ...common, claim: "a", truth: false, verdict: "unknown", delivery: "withheld", original: false },
    { ...common, claim: "b", truth: false, verdict: "held", delivery: "full", original: true },
    { ...common, claim: "c", truth: false, verdict: "broken", delivery: "withheld", original: false },
  ]);
  expect(result).toMatchObject({ cases: 3, stale_total: 3, stale_caught: 1, stale_served: 1, uncertain: 1 });
});
it("runs generated checks through the real evaluator, judge, delivery and recovery checkpoint with fake calls", async () => {
  const opts = options(), model = vi.fn(async request => fakeModel(request));
  const report = await runEvaluation({ ...opts, approvalHash: opts.plan.approval_hash, model });
  expect(report.complete).toBe(true);
  expect(report.checkpoints).toEqual([
    expect.objectContaining({ id: "C0", score: expect.objectContaining({ true_kept: 2, generation_failed: 0 }) }),
    expect.objectContaining({ id: "C1", score: expect.objectContaining({ true_kept: 1, stale_caught: 1, stale_served: 0 }) }),
    expect.objectContaining({ id: "C2", score: expect.objectContaining({ true_kept: 2, stale_total: 0 }) }),
  ]);
  expect(report.ledger.length).toBeGreaterThan(1); expect(report.charged_api_equivalent_usd).toBeGreaterThan(0);
  expect(report.token_counts).toMatchObject({ input: report.ledger.length * 100, output: report.ledger.length * 30, unmeasured_calls: 0 });
  expect(report.provenance.binary_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(git("status", "--porcelain")).toBe("");
});
it("stops after a transport failure, retaining a non-complete cost ledger", async () => {
  const opts = options(), model = vi.fn(async () => { throw new Error("Fixture transport failed"); });
  await expect(runEvaluation({ ...opts, approvalHash: opts.plan.approval_hash, model })).rejects.toThrow("no further paid calls");
  expect(model).toHaveBeenCalledTimes(1);
  const report = JSON.parse(readFileSync(join(opts.work, "report.json"), "utf8"));
  expect(report.complete).toBe(false); expect(report.ledger[0].state).toBe("failed");
});
it("repairs only rejected model proposals once and keeps the initial diagnostic",async()=>{
  const opts=options();
  const model=vi.fn(async (request:ModelRequest)=>{
    const response=fakeModel(request);
    if(request.purpose==="judge-bench.checks") {
      const value=JSON.parse(response.text);value.results[1].checks[0].target.pointer="/not-a-key";response.text=JSON.stringify(value);
    }
    return response;
  });
  const report=await runEvaluation({...opts,approvalHash:opts.plan.approval_hash,model});
  expect(report.generation_repaired).toEqual(["two"]);
  expect(report.generation_diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({stage:"initial-recording",claims:["two"]})]));
  expect(model.mock.calls.filter(([r])=>r.purpose==="judge-bench.repair")).toHaveLength(1);
  expect(report.checkpoints[0]!.score).toMatchObject({true_kept:2,generation_failed:0});
});
it("retains malformed generation in every denominator without hand-written fallback checks", async () => {
  const opts = options(), model = vi.fn(async request => ({ ...fakeModel(request), text: '{"results":[]}' }));
  const report = await runEvaluation({ ...opts, approvalHash: opts.plan.approval_hash, model });
  expect(report.checkpoints).toHaveLength(3);
  for (const cp of report.checkpoints) expect(cp.score).toMatchObject({ cases: 2, generation_failed: 2 });
});
it("stops on estimated token usage before admitting any later call", async () => {
  const opts = options(), model = vi.fn(async request => {
    const result = fakeModel(request); result.usage.estimated = true; return result;
  });
  await expect(runEvaluation({ ...opts, approvalHash: opts.plan.approval_hash, model })).rejects.toThrow("no further paid calls");
  expect(model).toHaveBeenCalledTimes(1);
  const report = JSON.parse(readFileSync(join(opts.work, "report.json"), "utf8"));
  expect(report.token_counts.unmeasured_calls).toBe(1); expect(report.complete).toBe(false);
});
it("records model-proposed literal patterns and supplies their current source to the judge", async () => {
  const opts = options();
  const model = vi.fn(async request => {
    const result = fakeModel(request);
    if (request.purpose === "judge-bench.checks") {
      const results = JSON.parse(result.text).results;
      for (const r of results) r.checks = [{ kind: "pattern", role: "complete", target: {
        scope: "package.json", pattern: r.id.endsWith("one") ? '"name":"fixture"' : '"version":"1"', match: "literal",
      } }];
      result.text = JSON.stringify({ results });
    }
    return result;
  });
  const report = await runEvaluation({ ...opts, approvalHash: opts.plan.approval_hash, model,
    refreshIndex: async checkout => {
      const writer = openRecord({ projectPath: checkout, isNetwork: () => false });
      try { await buildIndex({ root: checkout, projectId: writer.checkout(checkout)!.project_id, recordDirectory: writer.location.directory, workers: 0 }); }
      finally { writer.close(); }
    },
  });
  expect(report.checkpoints[0]!.score).toMatchObject({ true_kept: 2, generation_failed: 0 });
  expect(report.checkpoints[1]!.score).toMatchObject({ stale_caught: 1, generation_failed: 0 });
  const judged = model.mock.calls.filter(([r]) => r.purpose === "judge");
  expect(judged.length).toBeGreaterThan(0);
  for (const [r] of judged) {
    const evidence = JSON.parse(r.prompt.split("Evidence follows as JSON:\n")[1]!);
    expect(evidence.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: "package.json" })]));
  }
});
