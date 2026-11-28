import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ModelWaitError, runModel } from "../../model-runner/index.js";
import { claimModelBatch, enqueueModelBatch } from "../../model-runner/budget-queue.js";
import { openRecord, projectIdentity } from "../../record/index.js";
import { enqueueJob, ownerId, type JobRow } from "../../record/jobs.js";
import { ZERO } from "../../record/usage.js";
import { setCheckoutEnabled } from "../../controls/index.js";
import { prUnits } from "../pr-units.js";
import { candidate } from "./fixtures/observations.js";
import "../job.js";
import { initialState, runPipelineBatch, type PipelineInput } from "../pipeline.js";
import { LEARN_KIND } from "../plan.js";

it.each(["no row", "unstarted", "other stage", "done", "cancelled", "interrupted", "dead running", "charged after cleanup"] as const)(
  "retries only if the stage went uncharged (%s)", async prior => {
    const root = mkdtempSync(join(tmpdir(), "mex-spend-recovery-"));
    const writer = openRecord({ home: join(root, "mex"), isNetwork: () => false });
    try {
      const projectId = writer.register(projectIdentity(root)).id;
      const checkout = setCheckoutEnabled(writer, root, true).path;
      const { job } = enqueueJob(writer, { kind: LEARN_KIND, projectId });
      const claimed: JobRow = { ...job, state: "running", owner: ownerId("foreground") };
      writer.db.prepare("UPDATE jobs SET state='running',owner=? WHERE id=?").run(claimed.owner, job.id);
      const prefix = `learning.deep.v2.${job.id}.`;
      const insert = writer.db.prepare("INSERT INTO settings VALUES(?,?,?)");
      const item = candidate(1);
      insert.run(projectId, prefix + "cand.0", JSON.stringify([item]));
      insert.run(projectId, prefix + "triage.units.0", JSON.stringify(prUnits([item])));
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
        text: JSON.stringify({ observations: [] }),
        usage: { ...ZERO, model: "fixture", estimated: false }, selectedModel: "fixture",
      }));
      const withCheckFiles = async (_home: string, _id: string, _paths: string[], run: (dir: string) => Promise<unknown>) => run(root);
      const gaps = new Set<string>();
      await runPipelineBatch({ context: { writer, job: claimed, params: {}, checkpoint: undefined },
        plan: { agent: "codex", setup: "mixed", checkout, ceiling: 100_000 } as PipelineInput["plan"],
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
