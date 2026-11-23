import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { claimModelBatch, enqueueModelBatch, settleModelBatch } from "../../model-runner/budget-queue.js";
import { LEARN_KIND } from "../../learn-deeper/plan.js";
import { runBackground } from "../background.js";
import { openRecord, projectIdentity } from "../index.js";
import { enqueueJob, ownerId, requestJob, runOneBatch } from "../jobs.js";
import { ZERO } from "../usage.js";

it.each(["cancellation", "background startup", "busy checkpoint", "paid interruption"] as const)("removes raw learning bytes after %s", async cleanup => {
  const root = mkdtempSync(join(tmpdir(), "mex-learning-cleanup-"));
  const writer = openRecord({ home: join(root, "mex"), isNetwork: () => false });
  try {
    const project = writer.register(projectIdentity(root)).id;
    const source = { host: "github.com", slug: "example/project" };
    const date = "2026-01-01T00:00:00Z";
    const { job } = enqueueJob(writer, { kind: LEARN_KIND, projectId: project, params: {
      checkout: root, head: "1".repeat(40), origin: source, source, visibility: "public", agent: "codex", setup: "mixed",
      since: date, until: date, preferred: [], pulls: [], docs: [], gaps: [], estimate: 200, ceiling: 300,
    } });
    const key = `learning.deep.v2.${job.id}.cand.0`;
    const marker = "synthetic-record-cleanup-review-marker";
    const upsert = writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
    const includesMarker = (file: string) => existsSync(file) && readFileSync(file).includes(marker);
    const record = writer.location.record;
    upsert.run(project, key, (marker + "-old").repeat(600));
    writer.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    upsert.run(project, key, (marker + "-new").repeat(400));
    expect(includesMarker(record)).toBe(true);
    expect(includesMarker(record + "-wal")).toBe(true);

    vi.stubEnv("MEX_BACKGROUND", "1");
    const start = () => runBackground({ home: writer.location.home, isNetwork: () => false, memory: () => Infinity });
    if (cleanup === "cancellation") requestJob(writer, job.id, "cancel");
    else if (cleanup === "busy checkpoint") {
      const reader = new DatabaseSync(record, { readOnly: true });
      try {
        reader.exec("BEGIN");
        expect(!!reader.prepare("SELECT 1 FROM settings WHERE scope=? AND key=?").get(project, key)).toBe(true);
        requestJob(writer, job.id, "cancel");
        expect(includesMarker(record + "-wal")).toBe(true);
      } finally { reader.close(); }
      expect(await start()).toBe("memory");
    } else {
      writer.db.prepare("UPDATE jobs SET state='running',owner=? WHERE id=?").run(ownerId("background", 2_000_000_000), job.id);
      if (cleanup === "paid interruption") {
        const estimate = { ...ZERO, input: 100 };
        const paid = enqueueModelBatch(writer, { agent: "codex", model: "gpt-6.1-sol", projectPath: root,
          job: { jobId: job.id, batch: 0, projectId: project }, consented: { estimate, ceiling: 300 } });
        expect(claimModelBatch(writer, paid)).toBeUndefined();
        settleModelBatch(writer, paid, { ...estimate, input: 120, model: "gpt-6.1-sol", estimated: false });
      }
      // Stop before running any job. Cleanup belongs to startup itself.
      expect(await start()).toBe("memory");
    }

    expect(writer.setting(project, key)).toBeUndefined();
    expect(includesMarker(record)).toBe(false);
    expect(includesMarker(record + "-wal")).toBe(false);
    if (cleanup === "paid interruption") {
      expect(await runOneBatch(writer, ownerId("foreground"), { only: new Set([job.id]) })).toBe("ran");
      expect(writer.db.prepare("SELECT state,tokens_used FROM jobs WHERE id=?").get(job.id)).toMatchObject({ state: "done with gaps", tokens_used: 120 });
      expect(writer.db.prepare("SELECT count(*) count FROM model_batches WHERE job_id=?").get(job.id)?.count).toBe(1);
    }
  } finally {
    vi.unstubAllEnvs();
    writer.close();
    rmSync(root, { recursive: true, force: true });
  }
});
