import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parseEntry, serializeEntry } from "../../knowledge/entry.js";
import { publishNotes, snapshotNotes } from "../../knowledge/personal-store.js";
import { claimModelBatch, enqueueModelBatch } from "../../model-runner/budget-queue.js";
import type { runModel } from "../../model-runner/index.js";
import { openRecord, openRecordReadOnly, projectIdentity } from "../../record/index.js";
import { enqueueJob, ownerId, registerJobKind, requestJob, runOneBatch, type JobRow } from "../../record/jobs.js";
import { learningRunPrefix } from "../../record/learning-rows.js";
import { ZERO } from "../../record/usage.js";
import { readOutcome } from "../activity.js";
import { rememberNote, rememberObservationLinks, rememberObservations, rememberSetting } from "../cancel.js";
import { createLearnKind } from "../job.js";
import { saveObservations, supportObservations } from "../observations.js";
import { LEARN_KIND } from "../plan.js";
import { fixtureAt, observation } from "./fixtures/observations.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mex-learn-decision-"));
  const location = { home: join(root, "mex"), isNetwork: () => false };
  const writer = openRecord(location);
  const project = writer.register(projectIdentity(root)).id;
  const { job } = enqueueJob(writer, { kind: LEARN_KIND, projectId: project });
  return { root, location, writer, project, job, dispose() {
    writer.close();
    rmSync(root, { recursive: true, force: true });
  } };
}

const idFor = (n: number) => `mx_fixture${n}`;
function rawRule(n: number, status: "active" | "proposed" = "proposed") {
  const text = `Use the stable adapter for example ${n}.`;
  return serializeEntry({ text, mex: { id: idFor(n), kind: "rule", scope: ["src/**"],
    source: { producer: LEARN_KIND, type: "review", ref: "https://github.com/example/app/pull/1" },
    evidence: "review", one_line: text, checks: [], status, created: "2026-11-24" } });
}

it("takes back the observations a cancelled run stored or linked, and keeps everyone else's", async () => {
  const f = fixture();
  const { writer, job, project } = f;
  // One observation an earlier run stored and left unlinked, one it linked to an earlier rule.
  saveObservations(writer.db, project, [observation(1), observation(2)], fixtureAt);
  supportObservations(writer.db, project, "mx_earlier", [observation(2).id]);
  const kind = createLearnKind();
  registerJobKind({ ...kind, async runBatch({ job: live }) {
    writer.db.exec("BEGIN IMMEDIATE");
    rememberObservations(writer, live, saveObservations(writer.db, project, [observation(1), observation(3)], fixtureAt));
    const ids = [1, 2, 3].map(n => observation(n).id);
    rememberObservationLinks(writer, live, idFor(1), ids);
    supportObservations(writer.db, project, idFor(1), ids);
    writer.db.exec("COMMIT");
    expect(requestJob(writer, job.id, "cancel")).toMatchObject({ state: "running", request: "cancel" });
    return { checkpoint: { gaps: [] }, done: true, tokens: 0, results: 0 };
  } });
  try {
    await runOneBatch(writer, ownerId("foreground"));
    expect(writer.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id)).toEqual({ state: "cancelled" });
    const rows = writer.db.prepare("SELECT id,norm_id FROM learning_observations WHERE project_id=? ORDER BY id").all(project);
    expect(rows).toEqual([
      { id: observation(1).id, norm_id: null },
      { id: observation(2).id, norm_id: "mx_earlier" },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect(writer.db.prepare("SELECT count(*) n FROM settings WHERE key LIKE 'learning.deep.effects.%'").get()).toEqual({ n: 0 });
  } finally { registerJobKind(kind); f.dispose(); }
});

it("cleans up published active and proposed notes when cancellation arrives during the last batch", async () => {
  const f = fixture();
  const { writer, job, project, root } = f;
  const existing = rawRule(0, "active"), setting = "learning.fixture.receipt";
  publishNotes(writer, project, snapshotNotes(writer, project), new Map([[idFor(0), existing]]), () => {});
  const kind = createLearnKind();
  registerJobKind({ ...kind, async runBatch({ job: live }) {
    const batch = enqueueModelBatch(writer, { agent: "codex", model: "gpt-6.1-sol", projectPath: root,
      job: { jobId: job.id, batch: job.batch, projectId: project },
      consented: { ceiling: 1_000, estimate: { ...ZERO, input: 123 } } });
    expect(claimModelBatch(writer, batch)).toBeUndefined();
    writer.db.prepare("UPDATE model_batches SET state='done',charged_units=reserved_units WHERE id=?").run(batch.id);
    const before = snapshotNotes(writer, project);
    const notes = new Map(before.files).set(idFor(1), rawRule(1, "active")).set(idFor(2), rawRule(2));
    publishNotes(writer, project, before, notes, () => {
      for (const n of [1, 2]) rememberNote(writer, live, idFor(n), undefined, notes.get(idFor(n)));
      rememberSetting(writer, live, setting, "saved");
      writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, setting, "saved");
    });
    expect(requestJob(writer, job.id, "cancel")).toMatchObject({ state: "running", request: "cancel" });
    return { checkpoint: { gaps: [] }, done: true, tokens: 0, results: 2 };
  } });
  try {
    await runOneBatch(writer, ownerId("foreground"));
    expect(writer.db.prepare("SELECT state,tokens_used,results,request FROM jobs WHERE id=?").get(job.id))
      .toEqual({ state: "cancelled", tokens_used: 123, results: 0, request: null });
    expect(snapshotNotes(writer, project).files).toEqual(new Map([[idFor(0), existing]]));
    expect(writer.setting(project, setting)).toBeUndefined();
  } finally { registerJobKind(kind); f.dispose(); }
});

it("reads the durable outcome and shows only actionable gaps in the job summary", () => {
  const f = fixture();
  const { writer, job, location, root } = f;
  const outcome = { sources: 9, learned: 3, keptAutomatically: 2, toConfirm: 1, dropped: 2, tokens: 123, minutes: 2 };
  const origin = { host: "github.com", slug: "example/app" };
  const date = "2026-11-24T00:00:00.000Z";
  const params = { checkout: root, head: "a".repeat(40), origin, source: origin, visibility: "public",
    agent: "codex", setup: "mixed", since: date, until: date, preferred: [], pulls: [], docs: [], gaps: [], estimate: 300, ceiling: 450 };
  const checkpoint = { outcome, gaps: ["Some review paths exceeded the file limit.", "Sign in to GitHub to read private reviews."] };
  writer.db.prepare("UPDATE jobs SET state='done with gaps',params=?,checkpoint=? WHERE id=?")
    .run(JSON.stringify(params), JSON.stringify(checkpoint), job.id);
  writer.db.prepare("INSERT INTO job_results VALUES(?,?,?)").run(job.id, 0, checkpoint.gaps.join(" "));
  const reader = openRecordReadOnly(location)!;
  try {
    const done = { ...job, state: "done with gaps", params: JSON.stringify(params), checkpoint: JSON.stringify(checkpoint) } as const;
    expect(readOutcome(location, job.id)).toEqual(outcome);
    const kind = createLearnKind();
    expect(kind.display?.(done, reader)?.summary).toBe("read 9 sources · 3 rules learned · 1 to confirm · Sign in to GitHub to read private reviews.");
    expect(kind.details?.(done, reader)).toContain(checkpoint.gaps[0]);
  } finally { reader.close(); f.dispose(); }
});
