import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, utimesSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openRecord, openRecordReadOnly, type RecordWriter } from "../../record/index.js";
import { enqueueJob, listJobs, registerJobKind, requestJob, runOneBatch, requeueReadyJobs, type JobRow } from "../../record/jobs.js";
import { shortHash } from "../../record/project.js";
import { formatStatus, readStatus } from "../../status.js";
import { ModelWaitError, runModel, type ModelRequest, type ModelResult } from "../../model-runner/index.js";
import { recordChecks } from "../../judge/native.js";
import { runJudgeSync } from "../../judge/sync.js";
import { hash, position } from "../../judge/evidence.js";
import { enqueueModelBatch, claimModelBatch, settleModelBatch } from "../../model-runner/budget-queue.js";
import { REFERENCE_BATCH } from "../../model-runner/budget-prices.js";
import { note } from "../../knowledge/store.js";
import { serializeEntry } from "../../knowledge/entry.js";
import { createFilterKind, readFilterBatch, type FilterDependencies } from "../job.js";
import { acknowledged, acknowledgeTyped, filterInput, FILTER_LIMITS, type FilterInput, type FilterParams, type ScanWindow } from "../input.js";
import { filterPending, queuePendingFilters } from "../pending.js";
import { replyContexts } from "../transcript.js";
import { readContinuityItems } from "../continuity.js";
import { readStageOneBatch } from "../stage-one.js";
import { verbatimNote } from "../verdicts.js";
import { sessionNoteHistory, sessionNoteQuotes } from "../session-notes.js";
import { observeLifetimeGit } from "../lifetime-git.js";

// Extraction tests exercise the staging seam; consolidation has its own integration fixtures.
vi.mock("../consolidation.js", () => ({ consolidateNext: async () => undefined }));

let suite: string, binary: string, base: string, root: string, home: string, writer: RecordWriter, hooks: DatabaseSync, project: string;
let deps: FilterDependencies, calls: ModelRequest[];
const now = Date.now(), old = new Date(now - 20 * 60_000).toISOString();
const params = (): FilterParams => ({ checkout: root, agent: "codex" });
const row = (id: string) => writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as unknown as JobRow;
const inputOf = (request: ModelRequest): FilterInput => JSON.parse(request.prompt.split("Input follows as JSON:\n")[1]!.split("\nRepair only")[0]!);
const check = { kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/test" } };
const usage = { input: 100, cache_write: 0, cache_read: 0, output: 20, model: "fake", estimated: false };
function item(id: string, quote: string) { return { source_id: id, quote, label: "lasting", kind: "rule", scope: ["**"], text: "Tests use vitest because the project chose it.", one_line: "Tests use vitest.", private: false, checks: [check] }; }
function answer(request: ModelRequest): ModelResult {
  const input = inputOf(request);
  return { selectedModel: "fake-cheap", usage, text: JSON.stringify({ items: [
    ...input.messages.map(m => item(m.id, m.text)), ...input.notes.map(n => item(n.id, n.entry.mex.source.quote!)),
  ] }) };
}
function add(session: string, text: string, options: { seen?: string; at?: string; marks?: string; finished?: boolean; transcript?: string } = {}) {
  const seen = options.seen ?? old;
  hooks.prepare("INSERT OR REPLACE INTO sessions VALUES(?,?,?,?,?,?,0)").run(session, "codex", project, root, old, seen);
  const id = Number(hooks.prepare("INSERT INTO journal(session_id,ts,kind,text,marks) VALUES(?,?,'typed',?,?)").run(session, options.at ?? old, text, options.marks ?? "").lastInsertRowid);
  if (options.finished !== undefined) {
    const dir = join(writer.location.directory, "filter-sessions"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${shortHash(project + "\0" + session)}.json`), JSON.stringify({ version: 1, project_id: project, checkout: root, agent: "codex", session_id: session, seen_at: seen, finished: options.finished, transcript: options.transcript ?? "" }));
  }
  return id;
}
function queue() { registerJobKind(createFilterKind(deps)); return enqueueJob(writer, { kind: "filter", projectId: project, params: params() }).job.id; }
async function run(id: string) { await runOneBatch(writer, "filter-test", { only: new Set([id]) }); return row(id); }
function batches() { return writer.db.prepare("SELECT value FROM settings WHERE scope=? AND key LIKE 'filter.batch.%'").all(project).map(r => JSON.parse(String(r.value))); }
beforeAll(() => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), "mex-filter-suite-")));
  binary = join(suite, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(suite, "case-"))); root = join(base, "repo"); home = join(base, "home"); mkdirSync(root);
  writeFileSync(join(root, "package.json"), '{"scripts":{"test":"vitest"}}\n');
  vi.stubEnv("MEX_HOME", home); vi.stubEnv("MEX_HOOK_BINARY", binary);
  writer = openRecord({ home, projectPath: root, isNetwork: () => false }); project = writer.checkout(root)!.project_id;
  // These cases exercise learning from typed statements, which is opt-in.
  writer.db.prepare("INSERT OR REPLACE INTO settings(scope,key,value) VALUES('global','learning.statements','on')").run();
  hooks = new DatabaseSync(join(writer.location.directory, "hooks.db"));
  const schema = resolve("native/record/schema/hooks");
  for (const file of readdirSync(schema).filter(f => f.endsWith(".sql")).sort()) hooks.exec(readFileSync(join(schema, file), "utf8"));
  hooks.exec("PRAGMA user_version=6");
  calls = []; deps = { clock: () => now, recordChecks, model: vi.fn(async request => { calls.push(request); return answer(request); }) };
});
afterEach(() => { hooks.close(); writer.close(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

describe("filter batches and provenance", () => {
  it("uses the 20-message / 24-hour thresholds for expensive runs", () => {
    for (let i = 0; i < 19; i++) add("s", `message ${i}`);
    expect(filterInput(writer, project, params(), false, now)).toBeUndefined();
    add("s", "message 20"); expect(filterInput(writer, project, params(), false, now)?.messages).toHaveLength(20);
    hooks.exec("DELETE FROM journal"); add("old", "one day old", { at: new Date(now - 24 * 60 * 60_000).toISOString() });
    expect(filterInput(writer, project, params(), false, now)?.messages).toHaveLength(1);
  });
  it("never reads typed text while statement learning is off, and counts it as handled", () => {
    writer.db.prepare("DELETE FROM settings WHERE scope='global' AND key='learning.statements'").run();
    add("ended", "Tests use vitest because the project chose it.", { finished: true });
    expect(filterInput(writer, project, params(), true, now)).toBeUndefined();
    acknowledgeTyped(writer, project, root);
    writer.db.prepare("INSERT OR REPLACE INTO settings(scope,key,value) VALUES('global','learning.statements','on')").run();
    // Turning learning on later starts from new text, not from what was typed while it was off.
    expect(filterInput(writer, project, params(), true, now)).toBeUndefined();
    add("later", "Builds use tsup because it bundles fast.", { finished: true });
    expect(filterInput(writer, project, params(), true, now)?.messages.map(m => m.text)).toEqual(["Builds use tsup because it bundles fast."]);
  });
  it("acknowledges typed rows after the consumed cursor, earliest sessions first, so the cursor keeps moving", () => {
    writer.db.prepare("DELETE FROM settings WHERE scope='global' AND key='learning.statements'").run();
    // Consumed rows stay in the journal now. More sessions than one pass reads,
    // named so that their names sort opposite to their rows.
    const ids: number[] = [];
    hooks.exec("BEGIN");
    for (let i = 0; i < 4100; i++) ids.push(add(`s${9999 - i}`, `typed ${i}`));
    hooks.exec("COMMIT");
    const consumed = () => Number(writer.setting(project, "journal.consumed") ?? 0);
    acknowledgeTyped(writer, project, root);
    expect(consumed()).toBe(ids[4095]);
    acknowledgeTyped(writer, project, root);
    expect(consumed()).toBe(ids.at(-1));
    // Rows at or before the cursor are not read again.
    writer.db.prepare("DELETE FROM settings WHERE scope=? AND key LIKE 'filter.session.%'").run(project);
    acknowledgeTyped(writer, project, root);
    expect(writer.db.prepare("SELECT count(*) n FROM settings WHERE scope=? AND key LIKE 'filter.session.%'").get(project)).toEqual({ n: 0 });
  }, 60_000);
  it("skips recently active sessions but admits an explicit SessionEnd", () => {
    add("active", "active ask", { seen: new Date(now).toISOString() });
    expect(filterInput(writer, project, params(), true, now)).toBeUndefined();
    add("ended", "finished ask", { seen: new Date(now).toISOString(), finished: true });
    expect(filterInput(writer, project, params(), true, now)?.messages.map(m => m.text)).toEqual(["finished ask"]);
  });
  it("caps Unicode by characters, keeps provenance marks, and supplies delivered notes", () => {
    add("s", "🦊".repeat(1300), { marks: "pasted,scripted" });
    hooks.prepare("INSERT INTO epochs(session_id,epoch,started_at) VALUES('s',0,?)").run(old);
    hooks.prepare("INSERT INTO deliveries(id,session_id,epoch,ts,moment,entry_id,form,tokens,action) VALUES('d','s',0,?,'start','mx_given00','full',20,'given')").run(old);
    const value = filterInput(writer, project, params(), true, now)!;
    expect(Array.from(value.messages[0]!.text)).toHaveLength(1200);
    expect(value.messages[0]).toMatchObject({ marks: "pasted,scripted", delivered: ["mx_given00"] });
    expect(value.delivered_notes).toEqual([{ id: "mx_given00", text: null }]);
  });
  it.each(["fabricated quote", "another session's words"])("drops %s and saves the valid sibling", async quote => {
    add("s", "actual user words"); add("other", "another session's words");
    deps.model = vi.fn(async request => { const result = answer(request); const parsed = JSON.parse(result.text); parsed.items[0].quote = quote; return { ...result, text: JSON.stringify(parsed) }; });
    const id = queue(); expect((await run(id)).results).toBe(1);
    expect(batches()[0]).toMatchObject({ phase: "complete", dropped: { "unverified quote": 1 }, candidates: [{ source_id: "m2", quote: "another session's words" }] });
    expect(writer.setting(project, "journal.consumed")).toBe("2");
  });
  it("records checks using the real evaluator and saves candidates without writing notes", async () => {
    add("s", "Tests use vitest because the project chose it.");
    const before = readFileSync(join(root, "package.json"), "utf8"), id = queue();
    expect((await run(id)).results).toBe(1);
    expect(batches()[0]).toMatchObject({ phase: "complete", candidates: [{ label: "lasting", needs_checks: false,
      checks: [{ saw: { value: "vitest" }, files: { "package.json": hash(before) } }], source: { session: "s", row: 1, marks: "" } }] });
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
    expect(writer.setting(project, "journal.consumed")).toBe("1");
    expect((await run(id)).state).toBe("done"); expect(calls).toHaveLength(1);
  });
  it("writes aliases and asks in the same call, keeping only the ones the alias filter keeps", async () => {
    add("s", "Tests use vitest because the project chose it.");
    deps.model = vi.fn(async request => { calls.push(request); const r = answer(request); const body = JSON.parse(r.text);
      body.items[0].aliases = ["flaky unit runs", "deploys failing"]; body.items[0].asks = ["why do the unit tests hang?"];
      return { ...r, text: JSON.stringify(body) }; });
    // Scripted ranker: "deploys" already sends another entry; everything else finds the candidate first.
    deps.aids = (entries, queries) => new Map(queries.map(q => [q.id, q.id.startsWith("b") && q.text.includes("deploys")
      ? [{ id: "mx_deploys1", score: 1, sent: true }] : [{ id: entries[0].mex.id, score: 1 }]]));
    await run(queue());
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("doesn't know the entry exists");
    expect(batches()[0].candidates[0]).toMatchObject({ aliases: ["flaky unit runs"], asks: ["why do the unit tests hang?"] });
  });
  it("leaves the aids out when the ranker can't check them", async () => {
    add("s", "Tests use vitest because the project chose it.");
    deps.model = vi.fn(async request => { calls.push(request); const r = answer(request); const body = JSON.parse(r.text);
      body.items[0].aliases = ["flaky unit runs"]; return { ...r, text: JSON.stringify(body) }; });
    deps.aids = () => { throw new Error("no ranker"); };
    await run(queue());
    expect(batches()[0].candidates[0].aliases).toBeUndefined();
    expect(batches()[0].candidates[0].label).toBe("lasting");
  });
  it("drops task items and never persists their text", async () => {
    add("s", "do a temporary thing");
    deps.model = vi.fn(async request => { const r = answer(request), data = JSON.parse(r.text); data.items[0].label = "task"; return { ...r, text: JSON.stringify(data) }; });
    expect((await run(queue())).results).toBe(0);
    expect(batches()[0].answers).toEqual([]); expect(batches()[0].candidates).toEqual([]);
    expect(JSON.stringify(batches())).not.toContain("do a temporary thing"); expect(writer.setting(project, "journal.consumed")).toBe("1");
  });
  it("does not prune skipped older messages when later sessions finish", async () => {
    add("active", "older but active", { seen: new Date(now).toISOString() }); add("done", "later and finished");
    const id = queue(); await run(id); expect(writer.setting(project, "journal.consumed")).toBeUndefined(); await run(id);
    hooks.prepare("UPDATE sessions SET last_seen_at=? WHERE session_id='active'").run(old);
    await run(queue()); expect(writer.setting(project, "journal.consumed")).toBe("2");
    expect(hooks.prepare("SELECT count(*) n FROM journal").get()!.n).toBe(2); // Node never writes Go's journal.
    expect(calls).toHaveLength(2);
  });
  it("continues bounded scans past a full page of active or acknowledged sessions", async () => {
    add("active", "first active ask", { seen: new Date(now).toISOString() });
    const insert = hooks.prepare("INSERT INTO journal(session_id,ts,kind,text,marks) VALUES('active',?,'typed','active ask','')");
    hooks.exec("BEGIN"); for (let n = 1; n < 4096; n++) insert.run(old); hooks.exec("COMMIT");
    add("later", "Tests use vitest because the project chose it.");
    const id = queue(); await run(id); expect(calls).toHaveLength(0);
    expect(JSON.parse(row(id).checkpoint!).scanAfter).toBe(4096);
    await run(id); expect(calls).toHaveLength(1); expect(batches()[0].candidates[0].source.session).toBe("later");
    expect(writer.setting(project, "journal.consumed")).toBeUndefined();
  });
  it("counts the expensive-run threshold across scan pages without storing message text in checkpoints", async () => {
    for (let n = 0; n < 19; n++) add("old", `typed ${n}`);
    add("active", "first active ask", { seen: new Date(now).toISOString() });
    const insert = hooks.prepare("INSERT INTO journal(session_id,ts,kind,text,marks) VALUES('active',?,'typed','active ask','')");
    hooks.exec("BEGIN"); for (let n = 20; n < 4096; n++) insert.run(old); hooks.exec("COMMIT");
    add("later", "twentieth eligible message"); deps.cheap = false;
    const id = queue(); await run(id); expect(calls).toHaveLength(0);
    expect(JSON.parse(row(id).checkpoint!).carry).toHaveLength(19); expect(row(id).checkpoint).not.toContain("typed");
    await run(id); expect(calls).toHaveLength(1); expect(inputOf(calls[0]!).messages).toHaveLength(20);
  });
  it("enriches an unchecked note under its original id and leaves its file alone", async () => {
    const saved = note({ text: "Tests use vitest because the project chose it." }, { projectPath: root, home });
    const path = join(home, "projects", project, "notes", `${saved.entry.mex.id}.md`), original = readFileSync(path, "utf8");
    await run(queue());
    expect(batches()[0].candidates[0]).toMatchObject({ source: { note_id: saved.entry.mex.id, note_hash: hash(original) }, needs_checks: false });
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(filterInput(writer, project, params(), true, now)).toBeUndefined();
  });
  it("keeps valid items and counts each dropped item by its failing gate", async () => {
    const text = "Tests use vitest because the project chose it.";
    add("s", text);
    const secret = "fixture_only_" + "s".repeat(20);
    deps.model = vi.fn(async request => {
      const result = answer(request), [good] = JSON.parse(result.text).items;
      const items = [good, { ...good, kind: "unknown" }, { ...good, quote: "words from the agent" }, { ...good, scope: ["../outside"] },
        { ...good, checks: [{ ...check, target: { file: "x".repeat(70 << 10) } }] },
        { ...good, text: `password=${secret}` }, { ...good, text: `pass\u200bword=${secret}` }, null, good,
        { ...good, text: "Use the test script.", one_line: "Use the test script." }];
      return { ...result, text: JSON.stringify({ items }) };
    });
    const id = queue();
    expect((await run(id)).results).toBe(2);
    expect(batches()[0]).toMatchObject({ phase: "complete", dropped: { "invalid kind": 1, "unverified quote": 1, "invalid entry": 2, secret: 2, "item shape": 1, duplicate: 1 } });
    expect(JSON.stringify(batches())).not.toContain(secret);
    const summary = writer.db.prepare("SELECT summary FROM job_results WHERE job_id=?").get(id)?.summary;
    expect(summary).toContain("invalid kind 1");
    expect(summary).not.toContain(secret);
    expect(filterInput(writer, project, params(), true, now)).toBeUndefined();
  });
  it.each(["malformed response", '{"items":{}}', '{"items":[],"extra":true}'])("fails the call for an invalid envelope %s", async text => {
    add("s", "Tests use vitest.");
    deps.model = vi.fn(async () => ({ selectedModel: "fake-cheap", usage, text }));
    expect((await run(queue())).reason).toBe("The filter did not return valid structured items.");
    expect(batches()).toEqual([]);
    expect(writer.setting(project, "journal.consumed")).toBeUndefined();
  });
  it("defers only the failed explicit note, stops after three batches, and restarts it on sync", async () => {
    vi.stubEnv("MEX_BACKGROUND", "0");
    vi.stubEnv("CODEX_THREAD_ID", "");
    vi.stubEnv("CLAUDECODE", "");
    const bad = note({ text: "Keep the current parser." }, { projectPath: root, home }).entry;
    const good = note({ text: "Use the project test script." }, { projectPath: root, home }).entry;
    const path = join(home, "projects", project, "notes", `${bad.mex.id}.md`), original = readFileSync(path, "utf8");
    const attemptKey = `filter.note-retry.${bad.mex.id}`;
    add("s", "Tests use vitest.");
    let attempt = 0, afterSync = false;
    deps.model = vi.fn(async request => {
      calls.push(request);
      const result = answer(request);
      if (afterSync) return result;
      const items = JSON.parse(result.text).items.filter((item: { source_id: string }) => item.source_id !== bad.mex.id);
      const badAnswer = item(bad.mex.id, bad.mex.source.quote!);
      if (request.prompt.includes("\nRepair only")) items.push({ ...badAnswer, one_line: "This would change the claim." });
      else if (++attempt === 1) items.push(badAnswer, { ...badAnswer, quote: "A fabricated quote." });
      else if (attempt === 3) items.push({ ...badAnswer, checks: [] });
      return { ...result, text: JSON.stringify({ items }) };
    });

    const id = queue();
    expect((await run(id)).results).toBe(2);
    expect(batches()[0].candidates.map((candidate: { source_id: string }) => candidate.source_id)).toEqual(["m1", good.mex.id]);
    expect(batches()[0]).toMatchObject({ notes_deferred: 1, dropped: { "unverified quote": 1, duplicate: 1 } });
    for (const failures of [2, 3]) {
      expect(filterInput(writer, project, params(), true, now)?.notes.map(note => note.id)).toEqual([bad.mex.id]);
      await run(id);
      expect(JSON.parse(writer.setting(project, attemptKey)!)).toMatchObject({ failures, hash: hash(original) });
    }
    expect(batches().find(batch => batch.notes_waiting_for_sync === 1)?.dropped).toEqual({ "changed repair claim": 1, "unrecordable checks": 1 });
    expect(filterInput(writer, project, params(), true, now)).toBeUndefined();
    expect((await run(id)).state).toBe("done");
    expect(calls).toHaveLength(4);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(writer.setting(project, `filter.note.${bad.mex.id}`)).toBeUndefined();

    const syncDeps = { available: (agent: string) => agent === "codex", budgetMs: 0, write: vi.fn(),
      evaluate: async () => ({ ok: true as const, stored: false, items: [], results: [], problems: [] }) };
    await runJudgeSync({ home, projectPath: root, dryRun: true }, syncDeps);
    expect(JSON.parse(writer.setting(project, attemptKey)!).failures).toBe(3);
    await runJudgeSync({ home, projectPath: root }, syncDeps);
    expect(JSON.parse(writer.setting(project, attemptKey)!)).toMatchObject({ failures: 0 });
    const retry = writer.db.prepare("SELECT id FROM jobs WHERE kind='filter' AND state='queued'").get();
    expect(retry?.id).toBeTypeOf("string");
    afterSync = true;
    expect((await run(String(retry!.id))).results).toBe(1);
    expect(calls).toHaveLength(5);
    expect(writer.setting(project, attemptKey)).toBeUndefined();
    expect(writer.setting(project, `filter.note.${bad.mex.id}`)).toBe(hash(original));
    expect(readFileSync(path, "utf8")).toBe(original);
  });
  it("repairs checks once, and leaves an unrecordable claim unresolved", async () => {
    add("s", "Tests use vitest because the project chose it."); deps.recordChecks = vi.fn(async () => undefined);
    const id = queue(); await run(id);
    expect(calls).toHaveLength(2); expect(batches()[0].candidates[0]).toMatchObject({ checks: [], needs_checks: true });
    await run(id); expect(calls).toHaveLength(2);
  });
  it("refuses recorded checks that do not match the proposed kind, role and target", async () => {
    add("s", "Tests use vitest because the project chose it.");
    const baseline = hash(readFileSync(join(root, "package.json"), "utf8"));
    deps.recordChecks = vi.fn(async () => [{ kind: "source" as const, role: "complete" as const, target: { file: "package.json" }, saw: { hash: baseline }, files: { "package.json": baseline } }]);
    await run(queue()); expect(calls).toHaveLength(2); expect(batches()[0].candidates[0].needs_checks).toBe(true);
  });
  it("uses a valid repair even when another repair changes its claim", async () => {
    add("s", "Tests use vitest."); add("s", "Use the test script.");
    deps.model = vi.fn(async request => {
      const result = answer(request), items: ReturnType<typeof item>[] = JSON.parse(result.text).items;
      if (request.prompt.includes("\nRepair only")) items[0]!.kind = "recipe";
      else for (const item of items) item.checks = [{ ...check, target: { ...check.target, pointer: "/missing" } }];
      return { ...result, text: JSON.stringify({ items }) };
    });
    await run(queue());
    expect(batches()[0]).toMatchObject({ dropped: { "changed repair claim": 1 }, candidates: [
      { kind: "rule", needs_checks: true, checks: [] }, { kind: "rule", needs_checks: false, checks: [check] },
    ] });
  });
  it("retains the first paid result across a budget wait on check repair", async () => {
    add("s", "Tests use vitest because the project chose it."); deps.recordChecks = vi.fn(async () => undefined);
    let n = 0;
    deps.model = vi.fn(async request => { calls.push(request); if (++n === 2) throw new ModelWaitError("cap"); return answer(request); });
    const id = queue(); expect((await run(id)).state).toBe("waiting"); expect(batches()[0].phase).toBe("draft");
    expect(writer.setting(project, "journal.consumed")).toBeUndefined();
    writer.db.prepare("UPDATE jobs SET state='queued',reason=NULL WHERE id=?").run(id);
    await run(id); expect(calls).toHaveLength(3); expect(calls.filter(c => !c.prompt.includes("\nRepair only"))).toHaveLength(1);
  });
  it.each(["code", "activity", "consent", "delivery"])("discards results after in-flight %s changes", async change => {
    add("s", "Tests use vitest because the project chose it.");
    deps.model = vi.fn(async request => {
      if (change === "code") writeFileSync(join(root, "package.json"), '{"scripts":{"test":"changed"}}');
      if (change === "activity") hooks.prepare("UPDATE sessions SET last_seen_at=?").run(new Date(now).toISOString());
      if (change === "consent") writer.db.prepare("UPDATE checkouts SET state='off'").run();
      if (change === "delivery") { hooks.prepare("INSERT INTO epochs(session_id,epoch,started_at) VALUES('s',0,?)").run(old); hooks.prepare("INSERT INTO deliveries(id,session_id,epoch,ts,moment,entry_id,form,tokens,action) VALUES('d','s',0,?,'start','mx_echo000','full',1,'given')").run(old); }
      return answer(request);
    });
    const id = queue(); await run(id); expect(row(id).results).toBe(0); expect(batches().filter(b => b.phase === "complete")).toHaveLength(0);
    expect(writer.setting(project, "journal.consumed")).toBeUndefined();
  });
  it("reuses saved candidates after the generic job checkpoint is lost", async () => {
    add("s", "Tests use vitest because the project chose it."); const id = queue(); await run(id);
    writer.db.prepare("UPDATE jobs SET checkpoint=NULL WHERE id=?").run(id); await run(id);
    expect(calls).toHaveLength(1); expect(batches()).toHaveLength(1);
  });
  it("serializes workers and queues newer generations after the previous job finishes", async () => {
    add("s", "Tests use vitest because the project chose it."); const id = queue();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    deps.model = vi.fn(async request => { await gate; return answer(request); }); registerJobKind(createFilterKind(deps));
    const first = run(id); await vi.waitFor(() => expect(deps.model).toHaveBeenCalledTimes(1));
    expect(await runOneBatch(writer, "other-worker")).toBe("idle"); release(); await first;
    const directory = join(writer.location.directory, "filter-pending"); mkdirSync(directory);
    const path = join(directory, `${shortHash(root)}.json`);
    const mark = (generation: string) => writeFileSync(path, JSON.stringify({ version: 1, project_id: project, checkout: root, agent: "codex", generation }));
    mark("one"); await run(id); expect(queuePendingFilters(writer, enqueueJob)).toBe(1);
    mark("two"); expect(queuePendingFilters(writer, enqueueJob)).toBe(0);
  });
  it("uses the real automatic cap without spawning a model", async () => {
    add("s", "Tests use vitest because the project chose it.");
    writer.db.prepare("INSERT INTO settings VALUES('own-usage','status.claude',?)").run(JSON.stringify({ agent: "claude", status: "readable" }));
    for (let i = 0; i < 7; i++) {
      const admission = enqueueModelBatch(writer, { agent: "claude", model: "opus", projectPath: root, automatic: { estimate: REFERENCE_BATCH } });
      expect(claimModelBatch(writer, admission)).toBeUndefined();
      settleModelBatch(writer, admission, { ...REFERENCE_BATCH, model: "opus", estimated: false });
    }
    const spawn = vi.fn(() => { throw new Error("must not launch"); }); deps.model = request => runModel({ ...request, __internal: { spawn: spawn as never } });
    const result = await run(queue());
    expect(result.state).toBe("waiting"); expect(result.reason).toContain("allowance is used up"); expect(spawn).not.toHaveBeenCalled();
    expect(JSON.parse(result.checkpoint!)).toHaveProperty("position");
    expect(requeueReadyJobs(writer)).toBe(0);
  });
  it("rolls back completion, retries and acknowledgements together and reuses its draft after a save failure", async () => {
    add("s", "Tests use vitest because the project chose it.");
    const saved = note({ text: "Use the parser's default." }, { projectPath: root, home });
    const attemptKey = `filter.note-retry.${saved.entry.mex.id}`;
    deps.model = vi.fn(async request => {
      calls.push(request);
      const result = answer(request);
      return { ...result, text: JSON.stringify({ items: JSON.parse(result.text).items.slice(0, 1) }) };
    });
    writer.db.exec("CREATE TRIGGER reject_ack BEFORE INSERT ON settings WHEN new.key LIKE 'filter.latest-batch.%' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    const id = queue(); await run(id);
    expect(batches()[0].phase).toBe("draft"); expect(writer.setting(project, "journal.consumed")).toBeUndefined();
    expect(writer.setting(project, attemptKey)).toBeUndefined();
    expect(readStatus({ cwd: root, home, now }).learning.latestBatch).toBeNull();
    writer.db.exec("DROP TRIGGER reject_ack"); await run(id);
    expect(batches()[0].phase).toBe("complete"); expect(calls).toHaveLength(1);
    expect(JSON.parse(writer.setting(project, attemptKey)!).failures).toBe(1);
    expect(readStatus({ cwd: root, home, now }).learning.latestBatch).toMatchObject({ itemsKept: 1, notesDeferred: 1 });
  });
  it("does not repeat a malformed check-repair call after recovery", async () => {
    add("s", "Tests use vitest because the project chose it."); deps.recordChecks = vi.fn(async () => undefined);
    let n = 0;
    deps.model = vi.fn(async request => { calls.push(request); return ++n === 1 ? answer(request) : { ...answer(request), text: "invalid private response" }; });
    const id = queue(); await run(id); await run(id);
    expect(calls).toHaveLength(2); expect(batches()[0].candidates[0].needs_checks).toBe(true);
    expect(row(id).reason ?? "").not.toContain("private response");
  });
  it("uses the existing heartbeat to exclude activity after an old finish marker", () => {
    add("s", "the session resumed", { finished: true });
    const directory = join(home, "heartbeats", "codex"); mkdirSync(directory, { recursive: true });
    const path = join(directory, "s"); writeFileSync(path, JSON.stringify({ agent: "codex", session_id: "s" })); utimesSync(path, new Date(now), new Date(now));
    expect(filterInput(writer, project, params(), true, now)).toBeUndefined();
  });
  it("admits a finished session with a sub-millisecond heartbeat, but rejects subsequent activity", () => {
    add("s", "finished with nanoseconds", { finished: true });
    const directory = join(home, "heartbeats", "codex"); mkdirSync(directory, { recursive: true });
    const path = join(directory, "s"); writeFileSync(path, JSON.stringify({ agent: "codex", session_id: "s" }));
    utimesSync(path, now / 1000 + 0.0005, now / 1000 + 0.0005);
    const ns = lstatSync(path, { bigint: true }).mtimeNs;
    const seen = new Date(Number(ns / 1_000_000n)).toISOString().replace(/\.\d{3}Z$/u, `.${String(ns % 1_000_000_000n).padStart(9, "0")}Z`);
    const meta = join(writer.location.directory, "filter-sessions", `${shortHash(project + "\0s")}.json`);
    writeFileSync(meta, JSON.stringify({ ...JSON.parse(readFileSync(meta, "utf8")), seen_at: seen }));
    expect(filterInput(writer, project, params(), true, now)?.messages).toHaveLength(1);
    utimesSync(path, now / 1000 + 0.002, now / 1000 + 0.002);
    expect(filterInput(writer, project, params(), true, now)).toBeUndefined();
  });
  it("ignores corrupt cached data without exposing its private contents in an error", async () => {
    add("s", "Tests use vitest because the project chose it."); await run(queue());
    const key = String(writer.db.prepare("SELECT key FROM settings WHERE key LIKE 'filter.batch.%'").get()!.key);
    writer.db.prepare("UPDATE settings SET value=? WHERE scope=? AND key=?").run('{broken private material', project, key);
    expect(readFilterBatch(writer, project, key.slice("filter.batch.".length))).toBeUndefined();
  });
  it("wakes a valid request even if another request is malformed", () => {
    const dir = join(writer.location.directory, "filter-pending"); mkdirSync(dir);
    writeFileSync(join(dir, `${"0".repeat(24)}.json`), "{invalid");
    writeFileSync(join(dir, `${shortHash(root)}.json`), JSON.stringify({ version: 1, project_id: project, checkout: root, agent: "codex", generation: "1" }));
    expect(filterPending(writer.location.directory, writer)).toBe(true);
    registerJobKind(createFilterKind(deps)); expect(queuePendingFilters(writer, enqueueJob)).toBe(1);
  });
  it("automatically resumes when consolidation makes room in the candidate store", async () => {
    add("s", "Tests use vitest because the project chose it.");
    for (let n = 0; n < 128; n++) writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, `filter.batch.full${n}`, "{}");
    const id = queue(); expect((await run(id)).state).toBe("waiting"); expect(calls).toHaveLength(0);
    writer.db.prepare("DELETE FROM settings WHERE scope=? AND key='filter.batch.full0'").run(project);
    expect(requeueReadyJobs(writer)).toBe(1);
  });
  it("lets a new agent replace an automatically waiting host without acknowledging unread input", async () => {
    add("s", "Tests use vitest because the project chose it.");
    const previous = queue();
    writer.db.prepare("UPDATE jobs SET state='waiting',reason=? WHERE id=?").run("Sign in to the selected agent CLI before retrying.", previous);
    const dir = join(writer.location.directory, "filter-pending"); mkdirSync(dir);
    writeFileSync(join(dir, `${shortHash(root)}.json`), JSON.stringify({ version: 1, project_id: project, checkout: root, agent: "claude-code", generation: "new" }));
    expect(queuePendingFilters(writer, enqueueJob)).toBe(1);
    expect(row(previous).state).toBe("cancelled"); expect(writer.setting(project, "journal.consumed")).toBeUndefined();
    const next = writer.db.prepare("SELECT * FROM jobs WHERE state='queued'").get()!;
    expect(JSON.parse(String(next.params)).agent).toBe("claude");
    await run(String(next.id)); expect(calls).toHaveLength(1); expect(writer.setting(project, "journal.consumed")).toBe("1");
  });
  it.each(["running", "paused"])("does not replace a waiting job that became %s during dispatch", state => {
    const previous = queue(); writer.db.prepare("UPDATE jobs SET state='waiting',reason='held' WHERE id=?").run(previous);
    const dir = join(writer.location.directory, "filter-pending"); mkdirSync(dir);
    writeFileSync(join(dir, `${shortHash(root)}.json`), JSON.stringify({ version: 1, project_id: project, checkout: root, agent: "claude-code", generation: "new" }));
    expect(queuePendingFilters(writer, (w, options) => {
      const snapshot = enqueueJob(w, options);
      writer.db.prepare("UPDATE jobs SET state=? WHERE id=?").run(state, previous);
      return snapshot;
    })).toBe(0);
    expect(row(previous)).toMatchObject({ state, request: null });
  });
  it("respects capture switches and preserves completed request generations", async () => {
    add("s", "Tests use vitest because the project chose it.");
    writer.db.prepare("INSERT INTO settings VALUES(?, 'capture.enabled', 'false')").run(project);
    const id = queue(); expect((await run(id)).state).toBe("waiting"); expect(calls).toHaveLength(0);
    writer.db.prepare("DELETE FROM settings WHERE key='capture.enabled'").run();
    expect(requeueReadyJobs(writer)).toBe(1); await run(id); await run(id);
    const dir = join(writer.location.directory, "filter-pending"); mkdirSync(dir);
    const path = join(dir, `${shortHash(root)}.json`);
    const mark = (generation: string) => writeFileSync(path, JSON.stringify({ version: 1, project_id: project, checkout: root, agent: "codex", generation }));
    mark("one"); queuePendingFilters(writer, enqueueJob); await runOneBatch(writer, "request-worker");
    expect(queuePendingFilters(writer, enqueueJob)).toBe(0);
    mark("two"); expect(queuePendingFilters(writer, enqueueJob)).toBe(1);
  });
  it("holds older captured input while the requesting session is paused", async () => {
    add("source", "Tests use vitest because the project chose it.");
    hooks.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,0)").run("current", "codex", project, root, old, old);
    const directory = join(writer.location.directory, "hook-paused"); mkdirSync(directory);
    const mirror = join(directory, shortHash("codex\0current")); writeFileSync(mirror, "");
    registerJobKind(createFilterKind(deps));
    const id = enqueueJob(writer, { kind: "filter", projectId: project, params: { ...params(), sessionId: "current" } }).job.id;
    expect((await run(id)).state).toBe("waiting"); expect(calls).toHaveLength(0);
    expect(writer.setting(project, "journal.consumed")).toBeUndefined();
    rmSync(mirror); expect(requeueReadyJobs(writer)).toBe(1);
    await run(id); expect(calls).toHaveLength(1);
  });
  it("lets a fresh unpaused session replace an older session's automatic pause hold", async () => {
    add("source", "Tests use vitest because the project chose it.");
    const paused = join(writer.location.directory, "hook-paused"); mkdirSync(paused);
    writeFileSync(join(paused, shortHash("codex\0old")), "");
    registerJobKind(createFilterKind(deps));
    const id = enqueueJob(writer, { kind: "filter", projectId: project, params: { ...params(), sessionId: "old" } }).job.id;
    expect((await run(id)).state).toBe("waiting");
    const dir = join(writer.location.directory, "filter-pending"); mkdirSync(dir);
    writeFileSync(join(dir, `${shortHash(root)}.json`), JSON.stringify({ version: 1, project_id: project, checkout: root, agent: "codex", generation: "new", session_id: "fresh" }));
    expect(queuePendingFilters(writer, enqueueJob)).toBe(1); expect(row(id).state).toBe("cancelled");
    const next = writer.db.prepare("SELECT * FROM jobs WHERE state='queued'").get()!;
    expect(JSON.parse(String(next.params)).sessionId).toBe("fresh");
    await run(String(next.id)); expect(calls).toHaveLength(1);
  });
});

it("uses assistant tails only as transient context from a contained host transcript", () => {
  const codex = join(base, "codex"), sessions = join(codex, "sessions"); mkdirSync(sessions, { recursive: true }); vi.stubEnv("CODEX_HOME", codex);
  const file = join(sessions, "session.jsonl");
  writeFileSync(file, [
    { type: "response_item", payload: { role: "assistant", content: [{ type: "output_text", text: "I suggest the old parser." }] } },
    { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "no, the other one" }] } },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  add("s", "no, the other one"); const messages = filterInput(writer, project, params(), true, now)!.messages;
  replyContexts(file, "codex", messages); expect(messages[0]!.previous_reply).toBe("I suggest the old parser.");
  const outside = join(base, "outside.jsonl"); writeFileSync(outside, readFileSync(file));
  messages[0]!.previous_reply = null; replyContexts(outside, "codex", messages); expect(messages[0]!.previous_reply).toBeNull();
});

it("reads a previous host's reply when the next session uses another agent", () => {
  const claude = join(base, "claude"), sessions = join(claude, "projects"); mkdirSync(sessions, { recursive: true }); vi.stubEnv("CLAUDE_CONFIG_DIR", claude);
  const transcript = join(sessions, "previous.jsonl");
  writeFileSync(transcript, 'null\n' + [
    { type: "assistant", message: { content: [{ type: "text", text: "The old implementation?" }] } },
    { type: "user", message: { content: "no, the other one" } },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  add("s", "no, the other one", { finished: true });
  const path = join(writer.location.directory, "filter-sessions", `${shortHash(project + "\0s")}.json`);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), agent: "claude-code", transcript }));
  expect(filterInput(writer, project, params(), true, now)?.messages[0]?.previous_reply).toBe("The old implementation?");
});

function codexTranscript(session: string, content: string): string {
  const codex = join(base, "codex"), sessions = join(codex, "sessions");
  mkdirSync(sessions, { recursive: true });
  vi.stubEnv("CODEX_HOME", codex);
  const path = join(sessions, `${session}.jsonl`);
  writeFileSync(path, content);
  return path;
}

const codexRow = (role: "user" | "assistant", content: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role, content } });

describe("finished-session verdicts", () => {
  const batchInput = (request: ModelRequest): Pick<FilterInput, "messages" | "delivered_notes"> => inputOf(request);
  const stageBatch = (first: number) => readStageOneBatch(writer, project, root, first);
  function stageModel(label: (messages: FilterInput["messages"]) => unknown[]) {
    deps.stageOne = true;
    deps.model = vi.fn(async request => {
      calls.push(request);
      return { selectedModel: "fixture-cheap", usage, text: JSON.stringify({ verdicts: label(batchInput(request).messages) }) };
    });
  }
  const received = () => calls.map(request => batchInput(request).messages.map(message => message.text));

  it("makes a single cheap request per finished session and excludes active and non-person rows", async () => {
    const text = "For this release, keep uploads local.", first = add("ended", text, { finished: true });
    add("idle", "An old session with no finish receipt");
    const other = add("other", "Run the tests now", { finished: true });
    const pasted = add("ended", "Text from somewhere else", { marks: "pasted", finished: true });
    add("ended", "Use a smaller fixture", { finished: true });
    stageModel(messages => messages.map(({ id, text }) => text.startsWith("For this release")
      ? { id, verdict: "candidate", quote: text, kind: "instruction", lasts: "release", marker: "For this release", reason: null }
      : { id, verdict: "task" }));
    deps.recordChecks = vi.fn(recordChecks);
    const id = queue();
    expect((await run(id)).results).toBe(2);
    expect((await run(id)).results).toBe(3);
    expect((await run(id)).state).toBe("done");
    expect(received()).toEqual([[text, "Use a smaller fixture"], ["Run the tests now"]]);
    expect(calls.every(request => request.role === "cheap" && request.automatic)).toBe(true);
    expect(stageBatch(first)).toMatchObject({ skipped: [pasted], verdicts: [{ verdict: "candidate" }, { verdict: "task" }] });
    expect(verbatimNote(stageBatch(first)!.verdicts[0]!)).toEqual({ lasts: "release", text: "[you said, " + old.slice(0, 10) + '] "' + text + '"' });
    expect(stageBatch(other)?.verdicts).toEqual([{ id: "m" + other, verdict: "task" }]);
    expect(writer.setting(project, "journal.consumed")).toBe(String(first));
    expect(acknowledged(writer, project, "idle")).toBe(0);
    expect(deps.recordChecks).not.toHaveBeenCalled();
    expect(batches()).toEqual([]);
    expect(readdirSync(root)).toEqual(["package.json"]);
  });

  it("keeps valid rows and retries only missing IDs across a cancelled and recreated job", async () => {
    const first = add("ended", "First", { finished: true }), missing = add("ended", "Missing at first", { finished: true });
    const unresolved = add("ended", "Never returned", { finished: true }), last = add("ended", "Last", { finished: true });
    stageModel(messages => messages.filter(message => !["Missing at first", "Never returned"].includes(message.text))
      .map(({ id }) => ({ id, verdict: "none" })));
    const id = queue();
    expect((await run(id)).results).toBe(2);
    expect(stageBatch(first)).toMatchObject({ retry: [missing, unresolved], unresolved: [], verdicts: [{ id: "m" + first }, { id: "m" + last }],
      attempts: [{ coverage: { missing: 2 } }] });
    expect(acknowledged(writer, project, "ended")).toBe(0);
    expect(writer.setting(project, "journal.consumed")).toBeUndefined();
    expect(requestJob(writer, id, "cancel").state).toBe("cancelled");
    stageModel(messages => messages.filter(message => message.text === "Missing at first").map(({ id }) => ({ id, verdict: "unsure" })));
    const retry = queue();
    expect((await run(retry)).results).toBe(1);
    expect((await run(retry)).state).toBe("done with gaps");
    expect(received()).toEqual([["First", "Missing at first", "Never returned", "Last"], ["Missing at first", "Never returned"]]);
    expect(stageBatch(first)).toMatchObject({ retry: [], unresolved: [unresolved],
      verdicts: [{ id: "m" + first, verdict: "none" }, { id: "m" + missing, verdict: "unsure" }, { id: "m" + last, verdict: "none" }],
      attempts: [{ coverage: { missing: 2 } }, { coverage: { missing: 1 } }] });
    expect(writer.setting(project, "journal.consumed")).toBe(String(last));
  });

  it("does not silently acknowledge rows beyond the per-call limit", async () => {
    const ids = Array.from({ length: FILTER_LIMITS.messages + 1 }, (_, index) => add("long", "Prompt " + index, { finished: true }));
    stageModel(messages => messages.map(({ id }) => ({ id, verdict: "none" })));
    const id = queue();
    await run(id);
    expect(stageBatch(ids[0]!)?.rows).toEqual(ids.slice(0, FILTER_LIMITS.messages));
    expect(acknowledged(writer, project, "long")).toBe(ids.at(-2));
    await run(id);
    expect(stageBatch(ids.at(-1)!)?.rows).toEqual(ids.slice(-1));
    expect(received().map(messages => messages.length)).toEqual([FILTER_LIMITS.messages, 1]);
  });

  it("retains a verified option pointer and keeps the agent's reply out of the batch", async () => {
    const typed = "Yes, option 2", options = "1. Use the shared cache\n2. Keep the cache local";
    const file = codexTranscript("options", [codexRow("assistant", options), codexRow("user", typed)].join("\n"));
    const first = add("options", typed, { finished: true, transcript: file });
    stageModel(([message]) => {
      expect(message?.previous_options).toMatchObject([{ row: 0, option: 1 }, { row: 0, option: 2 }]);
      return [{ id: message!.id, verdict: "candidate", kind: "approval", lasts: "repo", quote: typed, marker: null, reason: null, approval: { row: 0, option: 2 } }];
    });
    await run(queue());
    const saved = stageBatch(first);
    expect(saved?.verdicts).toMatchObject([{ outcome: "unsure", approval: { row: 0, option: 2 } }]);
    expect(JSON.stringify(saved)).not.toContain("Keep the cache local");
  });

  it("carries a next-session verdict via the existing position-guarded continuity", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
    git("init", "-q", "-b", "work");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture");
    const typed = "Continue the parser migration next session.";
    add("ended", typed, { finished: true });
    const path = join(writer.location.directory, "filter-sessions", shortHash(project + "\0ended") + ".json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), branch: "work", head: git("rev-parse", "HEAD"), position_at: old }));
    stageModel(messages => messages.map(({ id, text }) => ({ id, verdict: "next-session", quote: text })));
    await run(queue());
    expect(readContinuityItems(writer, project, root, "work")?.items).toMatchObject([{ text: typed }]);
  });

  it("retires a captured branch note after merge and deletion without another model call", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
    const commit = (message: string) => git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", message);
    git("init", "-q", "-b", "main");
    commit("initial");
    git("switch", "-qc", "work");
    commit("note source");
    const typed = "On this branch, keep uploads local.";
    add("ended", typed, { finished: true });
    const path = join(writer.location.directory, "filter-sessions", shortHash(project + "\0ended") + ".json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), branch: "work", head: git("rev-parse", "HEAD"), position_at: old }));
    stageModel(messages => messages.map(({ id, text }) => ({ id, verdict: "candidate", quote: text, kind: "instruction",
      lasts: "branch", marker: "On this branch", reason: null })));
    const id = queue();
    await run(id);
    expect((await run(id)).state).toBe("done");
    const [stored] = sessionNoteHistory(writer, project);
    expect(stored?.scope).toMatchObject({ kind: "branch", origin: { name: "work", unmerged_head: git("rev-parse", "HEAD") } });
    if (stored?.scope.kind !== "branch") throw new Error("Expected a branch note");
    const facts = await observeLifetimeGit(root, [stored.scope.origin], false);
    expect(sessionNoteQuotes(writer, project, await position(root), now, facts)).toMatchObject([{ lasts: "branch" }]);
    git("switch", "-q", "main");
    git("merge", "--ff-only", "work");
    git("branch", "-d", "work");
    const next = queue();
    await run(next);
    expect((await run(next)).state).toBe("done");
    expect(sessionNoteHistory(writer, project)).toMatchObject([{ quote: typed, retired: { reason: "branch-merged" } }]);
    expect(sessionNoteQuotes(writer, project, await position(root), now, { branches: new Map() })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("rolls back the verdict and cursor if the note history write fails", async () => {
    const typed = "In this repo, keep uploads local.", first = add("ended", typed, { finished: true });
    stageModel(messages => messages.map(({ id, text }) => ({ id, verdict: "candidate", quote: text, kind: "instruction",
      lasts: "repo", marker: "In this repo", reason: null })));
    writer.db.exec("CREATE TEMP TRIGGER fail_history BEFORE INSERT ON settings WHEN NEW.key LIKE 'learning.session-note.%' BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    const id = queue();
    expect((await run(id)).results).toBe(0);
    expect(stageBatch(first)).toBeUndefined();
    expect(acknowledged(writer, project, "ended")).toBe(0);
    expect(sessionNoteHistory(writer, project)).toEqual([]);
    writer.db.exec("DROP TRIGGER fail_history");
    expect((await run(id)).results).toBe(1);
    expect(sessionNoteHistory(writer, project)).toHaveLength(1);
  });

  it("discards in-flight verdicts if typed-learning consent changes", async () => {
    const first = add("ended", "A decision", { finished: true });
    stageModel(messages => {
      writer.db.prepare("DELETE FROM settings WHERE scope='global' AND key='learning.statements'").run();
      return messages.map(({ id }) => ({ id, verdict: "none" }));
    });
    const id = queue();
    expect((await run(id)).results).toBe(0);
    expect(stageBatch(first)).toBeUndefined();
    expect(acknowledged(writer, project, "ended")).toBe(0);
    expect((await run(id)).state).toBe("done");
    expect(calls).toHaveLength(1);
  });

  it("keeps a stable response when a different session finishes during its request", async () => {
    const earlier = add("earlier", "One session", { finished: false });
    const later = add("later", "Another session", { finished: true });
    const path = join(writer.location.directory, "filter-sessions", shortHash(project + "\0earlier") + ".json");
    stageModel(messages => {
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), finished: true }));
      return messages.map(({ id }) => ({ id, verdict: "none" }));
    });
    const id = queue();
    expect((await run(id)).results).toBe(1);
    expect(stageBatch(later)?.verdicts).toEqual([{ id: "m" + later, verdict: "none" }]);
    expect((await run(id)).results).toBe(2);
    expect(stageBatch(earlier)?.verdicts).toEqual([{ id: "m" + earlier, verdict: "none" }]);
    expect(received()).toEqual([["Another session"], ["One session"]]);
  });
});

it("records completed filter counts in the job summary and checkout status", async () => {
  const first = "Use the other option.", next = "Tests use vitest.", outside = JSON.stringify({ type: "response_item", payload: { type: "web_search_call" } });
  add("outside", first, { finished: true, transcript: codexTranscript("outside", [outside, codexRow("assistant", "A result from outside"), codexRow("user", first)].join("\n")) });
  add("clean", next, { finished: true, transcript: codexTranscript("clean", codexRow("user", next)) });
  const held = note({ text: "Keep the current test command." }, { projectPath: root, home }).entry;
  deps.model = vi.fn(async request => {
    const result = answer(request), [outside, valid] = JSON.parse(result.text).items;
    return { ...result, text: JSON.stringify({ items: [{ ...outside, kind: "unknown" }, valid] }) };
  });
  const id = queue(); await run(id);
  const status = { cwd: root, home, now };
  const expected = { batch: 1, itemsKept: 1, itemsDropped: { "invalid kind": 1 }, notesDeferred: 1, notesWaitingForSync: 0, messagesWithheld: 1 };
  const summary = writer.db.prepare("SELECT summary FROM job_results WHERE job_id=? AND batch=0").get(id)?.summary;
  expect(summary).toBe("Filter batch 1 kept 1 item · dropped 1 item (invalid kind 1) · deferred 1 explicit note · withheld context for 1 message");
  const reader = openRecordReadOnly({ home })!;
  try { expect(listJobs(reader).find(job => job.id === id)?.summary).toBe(summary); }
  finally { reader.close(); }

  // The filter's output cache can be released after consolidation.
  writer.db.prepare("DELETE FROM settings WHERE scope=? AND key LIKE 'filter.batch.%'").run(project);
  const firstStatus = readStatus(status);
  expect(firstStatus.learning.latestBatch).toEqual(expected);
  expect(formatStatus(firstStatus)).toContain(`Latest filter batch${String(summary).slice("Filter batch".length)}`);

  deps.model = vi.fn(async request => answer(request));
  await run(id);
  expect(readStatus(status).learning.latestBatch).toEqual({ batch: 2, itemsKept: 1, itemsDropped: {}, notesDeferred: 0, notesWaitingForSync: 0, messagesWithheld: 0 });
  expect(writer.setting(project, `filter.note.${held.mex.id}`)).toBeDefined();
});

it.each(["x".repeat(205 << 10), "\\".repeat(110 << 10)])("keeps typed text when a full reply exceeds the input budget %#", reply => {
  const typed = "Use the second option.", scan: ScanWindow = { after: 0 };
  add("large", typed, { finished: true, transcript: codexTranscript("large", [codexRow("assistant", reply), codexRow("user", typed)].join("\n")) });
  const input = filterInput(writer, project, params(), true, now, scan, "full");
  expect(input?.messages).toMatchObject([{ text: typed, previous_reply: null }]);
  expect(scan.messagesWithheld).toBe(1);
  expect(filterInput(writer, project, params(), true, now, scan, "none")?.messages).toMatchObject([{ text: typed, previous_reply: null }]);
  expect(scan.messagesWithheld).toBe(0);
  expect(scan.contextIssues).toEqual([]);
});

it("masks delivered note text and one-line forms in the session that received the note", async () => {
  const noteText = "This is the longer body of the note.", noteLine = "Use the team's test runner.", originalLine = "Previously delivered headline.";
  const received = note({ text: noteText }, { home, projectPath: root }).entry;
  received.mex.one_line = noteLine;
  const noteBytes = serializeEntry(received), id = received.mex.id;
  writeFileSync(join(home, "projects", project, "notes", id + ".md"), noteBytes);
  const reply = `${noteLine}\n${noteText}\n${originalLine}\nChoose the first or second option.`;
  for (const session of ["received", "other"]) {
    const typed = "use option two";
    const transcript = codexTranscript(session, [codexRow("assistant", reply), codexRow("user", typed)].join("\n"));
    add(session, typed, { finished: true, transcript });
  }
  hooks.prepare("INSERT INTO epochs(session_id,epoch,started_at) VALUES('received',0,?)").run(old);
  hooks.prepare("INSERT INTO deliveries(id,session_id,epoch,ts,moment,entry_id,form,tokens,action,detail,title) VALUES('d','received',0,?,'start',?,'full',20,'replaced',?,?)")
    .run(old, id, JSON.stringify({ entry_hash: hash(noteBytes) }), originalLine);
  await run(queue());

  const expected = "[MEX note]\n[MEX note]\n[MEX note]\nChoose the first or second option.";
  const [masked, other] = inputOf(calls[0]!).messages;
  expect(masked).toMatchObject({ previous_reply: expected, text: "use option two", delivered: [id] });
  expect(other).toMatchObject({ previous_reply: reply, delivered: [] });
  const candidate = batches()[0].candidates.find((value: { source: { session: string } }) => value.source.session === "received");
  expect(candidate).toMatchObject({ quote: "use option two", source: { reply_context_hash: hash(expected) } });
  expect(JSON.stringify(batches())).not.toContain(expected);
});

it("keeps typed text when a delivered version can no longer be masked", () => {
  const received = note({ text: "Updated note body." }, { home, projectPath: root }).entry;
  const transcript = codexTranscript("s", [codexRow("assistant", "Original note body."), codexRow("user", "yes")].join("\n"));
  add("s", "yes", { finished: true, transcript });
  hooks.prepare("INSERT INTO epochs(session_id,epoch,started_at) VALUES('s',0,?)").run(old);
  hooks.prepare("INSERT INTO deliveries(id,session_id,epoch,ts,moment,entry_id,form,tokens,action,detail) VALUES('d','s',0,?,'start',?,'full',20,'given',?)")
    .run(old, received.mex.id, JSON.stringify({ entry_hash: hash("historical note file") }));
  expect(filterInput(writer, project, params(), true, now)?.messages).toMatchObject([{ text: "yes", previous_reply: null }]);
});

it("keeps typed input and shows when transcript context is paused", async () => {
  const broken = codexTranscript("broken", "{broken transcript");
  const valid = codexTranscript("valid", [codexRow("assistant", "Do you prefer the newer parser?"), codexRow("user", "Use the newer parser")].join("\n"));
  add("broken", "Run tests before a release", { finished: true, transcript: broken });
  add("valid", "Use the newer parser", { finished: true, transcript: valid });
  deps.contextMode = "design";
  const id = queue();
  await run(id);
  expect(inputOf(calls[0]!).messages.map(({ text, previous_reply }) => [text, previous_reply])).toEqual([
    ["Run tests before a release", null], ["Use the newer parser", "Do you prefer the newer parser?"],
  ]);
  const reader = openRecordReadOnly({ home })!;
  try {
    expect(listJobs(reader).find(job => job.id === id)?.summary).toContain("Reply context paused for 1 session (invalid or unsupported transcript format)");
  } finally { reader.close(); }
  expect(JSON.stringify(batches())).not.toContain("Do you prefer the newer parser?");
});

it("leaves inputs over the prompt budget queued with the expanded reply mode", async () => {
  const prompts = Array.from({ length: 24 }, (_, i) => `Use option ${i + 1}`);
  const reply = "An option for this project. ".repeat(500);
  const path = codexTranscript("long", prompts.flatMap(prompt => [codexRow("assistant", reply), codexRow("user", prompt)]).join("\n"));
  for (const prompt of prompts) add("long", prompt, { finished: true, transcript: path });
  expect(filterInput(writer, project, params(), true, now, undefined, "tail600")?.messages).toHaveLength(prompts.length);
  deps.model = vi.fn(async request => {
    calls.push(request);
    return { selectedModel: "fake-cheap", usage, text: '{"items":[]}' };
  });

  await run(queue());
  const request = calls[0]!, kept = inputOf(request).messages.map(message => message.text);
  expect(kept.length).toBeGreaterThan(0);
  expect(kept.length).toBeLessThan(prompts.length);
  expect(kept).toEqual(prompts.slice(0, kept.length));
  expect(Buffer.byteLength(request.prompt)).toBeLessThanOrEqual(256 << 10);
  expect(filterInput(writer, project, params(), true, now, undefined, "design")?.messages.map(message => message.text)).toEqual(prompts.slice(kept.length));
});
