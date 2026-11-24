import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { setCheckoutEnabled } from "../../controls/index.js";
import { ModelRunError } from "../../model-runner/errors.js";
import type { runModel } from "../../model-runner/index.js";
import { openRecord } from "../../record/index.js";
import { enqueueJob, ownerId, type JobRow } from "../../record/jobs.js";
import { ZERO } from "../../record/usage.js";
import { readObservations } from "../observations.js";
import { initialState, runPipelineBatch, type PipelineInput } from "../pipeline.js";
import { packUnits, prUnits } from "../pr-units.js";
import { LEARN_KIND } from "../plan.js";
import { candidate, fixtureNorm, fixturePath, fixtureAt } from "./fixtures/observations.js";
import "../job.js";

function splitFixture(answers: (call: number) => boolean, raw?: (call: number) => string | Error | undefined) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-triage-split-")));
  const writer = openRecord({ home: join(root, "mex"), projectPath: root, isNetwork: () => false });
  const { project_id: project, path: checkout } = setCheckoutEnabled(writer, root, true);
  const job = enqueueJob(writer, { kind: LEARN_KIND, projectId: project }).job;
  const claimed: JobRow = { ...job, state: "running", owner: ownerId("foreground") };
  writer.db.prepare("UPDATE jobs SET state='running',owner=? WHERE id=?").run(claimed.owner, job.id);
  const selected = Array.from({ length: 32 }, (_, i) => candidate(i + 1, fixtureNorm + " " + "x".repeat(1000)));
  const units = packUnits(prUnits(selected));
  expect(units).toHaveLength(1);
  const put = writer.db.prepare("INSERT INTO settings VALUES(?,?,?)");
  const prefix = "learning.deep.v2." + job.id + ".";
  put.run(project, prefix + "cand.0", JSON.stringify(selected));
  put.run(project, prefix + "triage.units.0", JSON.stringify(units[0]));
  const prompts: string[] = [];
  const model = vi.fn<typeof runModel>(async request => {
    prompts.push(request.prompt);
    const override = raw?.(prompts.length);
    if (override instanceof Error) throw override;
    const observations = answers(prompts.length) ? [{ item: "i1", quote: fixtureNorm, norm: fixtureNorm,
      why: "", scope: [fixturePath], kind: "tests", form: "stated", stated_as_rule: false, response: "unknown" }] : [];
    return { text: override ?? JSON.stringify({ observations }), selectedModel: "fixture", usage: { ...ZERO, model: "fixture", estimated: false } };
  });
  const withCheckFiles = async (_home: string, _id: string, _paths: string[], run: (dir: string) => Promise<unknown>) => run(root);
  const run = () => runPipelineBatch({ context: { writer, job: claimed, params: {}, checkpoint: undefined },
    plan: { checkout, agent: "codex", setup: "mixed", ceiling: 200_000 } as PipelineInput["plan"],
    state: { ...initialState(), phase: "triage", chunks: 1, early: true, harvestDone: true, batches: 1 }, weekly: false, gaps: new Set(),
    deps: { tree: { withCheckFiles } as PipelineInput["deps"]["tree"], model, now: () => Date.parse(fixtureAt) } });
  return { writer, project, prompts, model, run, dispose() { writer.close(); rmSync(root, { recursive: true, force: true }); } };
}

it("splits a large empty reply once at PR boundaries before writing", async () => {
  const f = splitFixture(call => call > 1);
  try {
    const result = await f.run();
    expect(f.prompts).toHaveLength(3);
    expect(f.prompts[1]).toContain("=== PR #1 ");
    expect(f.prompts[1]).not.toContain("=== PR #17 ");
    expect(f.prompts[2]).toContain("=== PR #17 ");
    expect(result.state.counts).toMatchObject({ "calls.triage": 3, "triage-splits": 1, "triage-kept": 2 });
    expect(readObservations(f.writer.db, f.project, fixtureAt).map(item => item.pull).sort((a, b) => a! - b!)).toEqual([1, 17]);
  } finally { f.dispose(); }
});

it("accepts empty halves instead of splitting a quiet batch down to single PRs", async () => {
  const f = splitFixture(() => false);
  try {
    const result = await f.run();
    expect(f.prompts).toHaveLength(3);
    expect(result.state.counts).toMatchObject({ "calls.triage": 3, "triage-splits": 1 });
    expect(result.state.counts["triage-kept"] ?? 0).toBe(0);
    expect(readObservations(f.writer.db, f.project, fixtureAt)).toEqual([]);
  } finally { f.dispose(); }
});

it("tries a failed command once more as a text-only call, and keeps its answer", async () => {
  const f = splitFixture(() => true, call => call === 1 ? new ModelRunError("failed", "codex") : undefined);
  try {
    const result = await f.run();
    expect(f.prompts).toHaveLength(2);
    expect(f.model.mock.calls.every(([request]) => request.isolatedText === true)).toBe(true);
    expect(result.state.counts).toMatchObject({ "calls.triage": 1, "triage-kept": 1 });
  } finally { f.dispose(); }
});

it("bounds a batch that never gets a readable answer at six calls", async () => {
  const f = splitFixture(() => false, () => "not json");
  try {
    await f.run();
    // First read and its retry, then each half once with its own retry. Nothing splits further.
    expect(f.prompts).toHaveLength(6);
  } finally { f.dispose(); }
});
