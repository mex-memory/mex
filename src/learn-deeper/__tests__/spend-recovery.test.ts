import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ModelWaitError, runModel } from "../../model-runner/index.js";
import { claimModelBatch, enqueueModelBatch } from "../../model-runner/budget-queue.js";
import { openRecord, projectIdentity } from "../../record/index.js";
import { enqueueJob, ownerId, type JobRow } from "../../record/jobs.js";
import { ZERO } from "../../record/usage.js";
import { planClusters, type Triaged } from "../cluster.js";
import "../job.js";
import { MEANING_PURPOSE } from "../meaning.js";
import { initialState, runPipelineBatch, type PipelineInput } from "../pipeline.js";
import { LEARN_KIND } from "../plan.js";
import { meaningQuestions, recordedMeaning } from "./fixtures/meaning.js";

it.each(["no row", "unstarted", "other stage", "done", "cancelled", "interrupted", "dead running", "charged after cleanup"] as const)(
  "retries only if the stage went uncharged (%s)", async prior => {
    const root = mkdtempSync(join(tmpdir(), "mex-spend-recovery-"));
    const writer = openRecord({ home: join(root, "mex"), isNetwork: () => false });
    try {
      const projectId = writer.register(projectIdentity(root)).id;
      const { job } = enqueueJob(writer, { kind: LEARN_KIND, projectId });
      const claimed: JobRow = { ...job, state: "running", owner: ownerId("foreground") };
      writer.db.prepare("UPDATE jobs SET state='running',owner=? WHERE id=?").run(claimed.owner, job.id);
      const prefix = `learning.deep.v2.${job.id}.`;
      const insert = writer.db.prepare("INSERT INTO settings VALUES(?,?,?)");
      insert.run(projectId, prefix + "cand.0", JSON.stringify([{ id: "doc:Guide.md#development", kind: "doc", signal: "weak", text: "Use the stable renderer." }]));
      if (prior !== "charged after cleanup") insert.run(projectId, prefix + "call.triage.0", JSON.stringify({ lastBatch: 0, spent: 0 }));
      const lost = prior !== "no row" && prior !== "unstarted" && prior !== "other stage";
      if (prior !== "no row") {
        const stage = prior === "other stage" ? "call.other" : prior === "charged after cleanup" ? "call.triage.0" : undefined;
        const batch = enqueueModelBatch(writer, { agent: "codex", model: "gpt-6.1-sol", projectPath: root,
          job: { jobId: job.id, projectId, batch: 0, stage },
          consented: { ceiling: 100_000, estimate: { ...ZERO, input: 123 } } });
        if (prior === "unstarted") writer.db.prepare("UPDATE model_batches SET state='cancelled' WHERE id=?").run(batch.id);
        else {
          expect(claimModelBatch(writer, batch)).toBeUndefined();
          if (prior === "dead running") writer.db.prepare("UPDATE model_batches SET pid=? WHERE id=?").run(2_000_000_000, batch.id);
          else {
            const state = prior === "other stage" || prior === "charged after cleanup" ? "done" : prior;
            writer.db.prepare("UPDATE model_batches SET state=?,charged_units=reserved_units WHERE id=?").run(state, batch.id);
          }
        }
      }
      const model = vi.fn<typeof runModel>(async () => ({
        text: JSON.stringify({ results: [{ id: "doc:Guide.md#development", keep: false, category: "one-off", lesson: "A fixture lesson." }] }),
        usage: { ...ZERO, model: "fixture", estimated: false }, selectedModel: "fixture",
      }));
      const withCheckFiles = async (_home: string, _id: string, _paths: string[], run: (dir: string) => Promise<unknown>) => run(root);
      const gaps = new Set<string>();
      await runPipelineBatch({ context: { writer, job: claimed, params: {}, checkpoint: undefined },
        plan: { agent: "codex", setup: "mixed", checkout: root, ceiling: 100_000 } as PipelineInput["plan"],
        state: { ...initialState(), phase: "triage", chunks: 1, early: true, harvestDone: true }, weekly: false, gaps,
        deps: { model, now: Date.now, tree: { withCheckFiles } as PipelineInput["deps"]["tree"] } });
      expect(model).toHaveBeenCalledTimes(lost ? 0 : 1);
      const reply = JSON.parse(writer.setting(projectId, prefix + "reply.triage.0")!);
      if (lost) {
        expect(reply).toMatchObject({ text: "", tokens: 123, lost: true });
        expect([...gaps]).toContain("A paid model reply could not be recovered after an interruption.");
      } else expect(reply.lost).toBeUndefined();
    } finally {
      writer.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

it.each(["complete", "one omitted verdict"] as const)(
  "shares a judgment between writer batches and earned docs, then recovers it (%s)", async response => {
  const root = mkdtempSync(join(tmpdir(), "mex-shared-quote-recovery-"));
  const writer = openRecord({ home: join(root, "mex"), isNetwork: () => false });
  try {
    const projectId = writer.register(projectIdentity(root)).id;
    const { job } = enqueueJob(writer, { kind: LEARN_KIND, projectId });
    const claimed: JobRow = { ...job, state: "running", owner: ownerId("foreground") };
    writer.db.prepare("UPDATE jobs SET state='running',owner=? WHERE id=?").run(claimed.owner, job.id);
    const repo = { host: "github.com", slug: "acme/service" } as const;
    const sources = [
      { claim: "Before cutting a release, run npm run verify.", quote: "Run npm run verify before cutting a release." },
      { claim: "Before starting a new worker, apply the schema migrations.", quote: "Apply the schema migrations before starting a new worker." },
      { claim: "Before packaging a release, rebuild the command index.", quote: "Rebuild the command index before packaging a release." },
      { claim: "After changing flags, refresh the reference.", quote: "Refresh the reference after changing flags." },
    ];
    const observations = sources.map(({ claim, quote }, i): Triaged => {
      const kind = i < 2 ? "review-thread" : "doc";
      const id = `${kind}:${i}`;
      return { candidate: { id, kind, link: `https://github.com/acme/service/pull/${i + 1}#discussion_r${i}`,
        text: quote, signal: "strong", at: "2026-05-01T00:00:00.000Z", hash: "", nodeIds: [], reviewers: ["maintainer"],
        ...(kind === "review-thread" ? { pull: i + 1 } : {}),
        weights: { actedOn: true, familiar: true, guidelineLink: false, generalising: true, smallPr: true, hotUnknown: false } },
        triage: { id, lesson: claim, category: "process", keep: true } };
    });
    const insert = writer.db.prepare("INSERT INTO settings VALUES(?,?,?)");
    const [firstReview, secondReview, ...docs] = observations.map(item => planClusters([item]).resolve()[0]!);
    [[firstReview], [secondReview], docs].forEach((clusters, i) =>
      insert.run(projectId, `learning.deep.v2.${job.id}.clusters.${i}`, JSON.stringify(clusters)));
    let blockMissing = response === "one omitted verdict";
    const model = vi.fn<typeof runModel>(async request => {
      let answer: unknown;
      if (request.purpose === MEANING_PURPOSE) {
        expect(request.isolatedText).toBe(true);
        const questions = meaningQuestions(request.prompt);
        const retry = response === "one omitted verdict" && questions.length === 1;
        const expected = retry ? [sources[1]!] : sources.slice(0, 3);
        expect(questions.map(({ index: _index, ...question }) => question)).toEqual(expected.map(({ claim, quote }) => ({ clause: claim, quote })));
        if (retry && blockMissing) throw new ModelWaitError("cap");
        const { results } = recordedMeaning(request.prompt);
        answer = { results: response === "one omitted verdict" && !retry ? results.filter(([id]) => id !== 1) : results };
      } else {
        const [cluster] = JSON.parse(request.prompt.split("\nClusters:\n")[1]!);
        const id = cluster.members[0].id as string;
        const { claim, quote } = sources.find((_, i) => observations[i]!.candidate.id === id)!;
        answer = { entries: [{ cluster: cluster.cluster, route: "process-rule", kind: "rule", claim, scope: ["**"],
          clauses: [{ text: claim, quotes: [{ id, quote }] }] }] };
      }
      return { text: JSON.stringify(answer), usage: { ...ZERO, model: "fixture", estimated: false }, selectedModel: "fixture" };
    });
    const withCheckFiles = async (_home: string, _id: string, _paths: string[], run: (dir: string) => Promise<unknown>) => run(root);
    const state = { ...initialState(undefined, true), phase: "write" as const, batches: 3, counts: { "saved-other": 3 } };
    state.quoteBatch!.units = [0, 1];
    state.quoteBatch!.nextDocument = 2;
    const input: PipelineInput = {
      context: { writer, job: claimed, params: {}, checkpoint: undefined },
      plan: { agent: "codex", setup: "mixed", checkout: root, ceiling: 100_000, origin: repo,
        harvest: { inventory: { bands: [] } } } as unknown as PipelineInput["plan"],
      state, weekly: false, gaps: new Set<string>(),
      deps: { model, now: Date.now, tree: { withCheckFiles, paths: () => [] } as unknown as PipelineInput["deps"]["tree"] },
    };
    const first = await runPipelineBatch(input);
    const second = await runPipelineBatch({ ...input, state: first.state });
    expect(second.state.quoteBatch?.waiting).toEqual([0, 1]);
    const scheduled = await runPipelineBatch({ ...input, state: second.state });
    const doc = { document: 2, start: 0, end: 1 };
    expect(scheduled.state.quoteBatch).toMatchObject({ units: [doc], nextDocument: 2, documentOffset: 1 });
    const beforeJudge = await runPipelineBatch({ ...input, state: scheduled.state });
    expect(beforeJudge.state.quoteBatch?.waiting).toEqual([0, 1, doc]);
    const pending = { ...input, state: beforeJudge.state };
    const prefix = `learning.deep.v2.${job.id}.`;
    await expect(runPipelineBatch({ ...pending, plan: { ...input.plan, ceiling: 10_000 } })).rejects.toMatchObject({ reason: "cap" });
    expect(writer.setting(projectId, prefix + "unavailable.shared.0.quotes")).toBeUndefined();
    expect(model.mock.calls.map(([request]) => request.purpose)).toEqual([LEARN_KIND, LEARN_KIND, LEARN_KIND]);
    if (blockMissing) {
      await expect(runPipelineBatch(pending)).rejects.toMatchObject({ reason: "cap" });
      expect(writer.setting(projectId, prefix + "reply.shared.0.quotes")).toBeDefined();
      expect(writer.setting(projectId, prefix + "unavailable.shared.0.quotes.missing")).toBeUndefined();
      blockMissing = false;
    }
    expect(writer.setting(projectId, prefix + "quote-results.0")).toBeUndefined();
    expect(input.gaps.size).toBe(0);
    const judged = await runPipelineBatch(pending);
    expect(judged.state.quoteBatch).toMatchObject({ units: [0, 1, doc], next: 0, waiting: [], round: 1 });
    expect(judged.state.counts["doc-quota"]).toBeUndefined();
    expect(input.gaps.size).toBe(0);
    const recovered = await runPipelineBatch(pending);
    expect(recovered.state).toEqual(judged.state);
    expect(model.mock.calls.map(([request]) => request.purpose)).toEqual([LEARN_KIND, LEARN_KIND, LEARN_KIND,
      ...Array.from({ length: response === "one omitted verdict" ? 3 : 1 }, () => MEANING_PURPOSE)]);
  } finally {
    writer.close();
    rmSync(root, { recursive: true, force: true });
  }
});
