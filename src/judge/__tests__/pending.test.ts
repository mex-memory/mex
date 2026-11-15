import { afterEach, beforeEach, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { shortHash } from "../../record/project.js";
import { enqueueJob, registerJobKind } from "../../record/jobs.js";
import { judgePending, queuePendingJudgements } from "../pending.js";
import "../job.js";

let base: string, root: string, writer: RecordWriter, path: string;
function mark(over = {}) {
  mkdirSync(join(writer.location.directory, "judge-pending"), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, project_id: writer.checkout(root)!.project_id, checkout: root, agent: "codex", reason: "start", generation: "1", near: ["src/api.ts"], not_before: 0, ...over }));
}
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-judge-pending-")));
  root = join(base, "repo"); mkdirSync(root);
  writer = openRecord({ home: join(base, "home"), projectPath: root, isNetwork: () => false });
  path = join(writer.location.directory, "judge-pending", `${shortHash(root)}.json`);
});
afterEach(() => { writer.close(); rmSync(base, { recursive: true, force: true }); });

it("queues a host-specific checkout job once and preserves a later request behind it", () => {
  mark(); expect(judgePending(writer.location.directory)).toBe(true);
  expect(queuePendingJudgements(writer, enqueueJob)).toBe(1);
  expect(judgePending(writer.location.directory)).toBe(false);
  const job = writer.db.prepare("SELECT * FROM jobs").get()!;
  expect(JSON.parse(String(job.params))).toEqual({ checkout: root, agent: "codex", near: ["src/api.ts"], generation: "1" });
  mark({ generation: "2" });
  expect(queuePendingJudgements(writer, enqueueJob)).toBe(0);
  expect(existsSync(path)).toBe(true);
  writer.db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(job.id!);
  expect(queuePendingJudgements(writer, enqueueJob)).toBe(1);
});
it("waits for idle and respects repo off and global controls", () => {
  mark({ reason: "edit", not_before: 100 });
  expect(queuePendingJudgements(writer, enqueueJob, 99)).toBe(0);
  writer.db.prepare("UPDATE checkouts SET state='off'").run();
  expect(queuePendingJudgements(writer, enqueueJob, 101)).toBe(0);
  writer.db.prepare("UPDATE checkouts SET state='on'").run();
  writer.db.prepare("INSERT INTO settings VALUES('global','enabled','false')").run();
  expect(queuePendingJudgements(writer, enqueueJob, 101)).toBe(0);
  writer.db.prepare("DELETE FROM settings WHERE scope='global'").run();
  expect(queuePendingJudgements(writer, enqueueJob, 101)).toBe(1);
});
it("never queues a request whose project does not own that checkout", () => {
  mark({ project_id: `f-${"0".repeat(24)}` });
  expect(queuePendingJudgements(writer, enqueueJob)).toBe(0);
  expect(writer.db.prepare("SELECT count(*) n FROM jobs").get()!.n).toBe(0);
});
it("preserves a paused session's request and queues it only after resume", () => {
  const hooks = new DatabaseSync(writer.location.hooks);
  try {
    hooks.exec("CREATE TABLE sessions(session_id TEXT,agent TEXT,paused INTEGER); INSERT INTO sessions VALUES('editing','codex',1); PRAGMA user_version=6");
    mark({ session_id: "editing" });
    expect(queuePendingJudgements(writer, enqueueJob)).toBe(0);
    expect(existsSync(path)).toBe(true);
    hooks.exec("UPDATE sessions SET paused=0");
    expect(queuePendingJudgements(writer, enqueueJob)).toBe(1);
  } finally { hooks.close(); }
});

it("keeps a concurrent edit request and restores a request if queueing fails", () => {
  mark();
  expect(queuePendingJudgements(writer, (w, options) => { mark({ generation: "2" }); return enqueueJob(w, options); })).toBe(1);
  expect(existsSync(path)).toBe(true);
  writer.db.prepare("UPDATE jobs SET state='done'").run();
  expect(queuePendingJudgements(writer, () => { throw new Error("storage busy"); })).toBe(0);
  expect(existsSync(path)).toBe(true);
});

it("rotates recovery past claims protected by newer request files", () => {
  mark();
  const directory = join(writer.location.directory, "judge-pending"), key = shortHash(root);
  const content = JSON.stringify({ version: 1, project_id: writer.checkout(root)!.project_id, checkout: root, agent: "codex", reason: "start", generation: "1", near: [], not_before: 0 });
  rmSync(path);
  writeFileSync(`${path}.00000000-0000-0000-0000-000000000000.claim`, content);
  for (let i = 1; i <= 32; i++) {
    const fake = (BigInt(`0x${key}`) - BigInt(i)).toString(16).padStart(24, "0");
    writeFileSync(join(directory, `${fake}.json`), "{}");
    writeFileSync(join(directory, `${fake}.json.00000000-0000-0000-0000-000000000000.claim`), "{}");
  }
  expect(queuePendingJudgements(writer, enqueueJob)).toBe(0);
  expect(queuePendingJudgements(writer, enqueueJob)).toBe(1);
});

it("discovers hook requests in the foreground fallback without a detached process", async () => {
  const { runPendingInForeground } = await import("../../record/background.js");
  registerJobKind({ name: "judge", label: "Fake judge", scope: "project", sideEffects: "none", runBatch: () => ({ checkpoint: {}, done: true, results: 1 }) });
  mark();
  expect(await runPendingInForeground(writer, 5_000)).toBe(1);
  expect(writer.db.prepare("SELECT state,results FROM jobs WHERE kind='judge'").get()).toMatchObject({ state: "done", results: 1 });
});
