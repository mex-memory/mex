import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, utimesSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { enqueueJob, registerJobKind, runOneBatch, requeueReadyJobs, type JobRow } from "../../record/jobs.js";
import { shortHash } from "../../record/project.js";
import { ModelWaitError, runModel, type ModelRequest, type ModelResult } from "../../model-runner/index.js";
import { recordChecks } from "../../judge/native.js";
import { hash } from "../../judge/evidence.js";
import { enqueueModelBatch, claimModelBatch, settleModelBatch } from "../../model-runner/budget-queue.js";
import { REFERENCE_BATCH } from "../../model-runner/budget-prices.js";
import { note } from "../../knowledge/store.js";
import { createFilterKind, readFilterBatch, type FilterDependencies } from "../job.js";
import { filterInput, type FilterInput, type FilterParams } from "../input.js";
import { filterPending, queuePendingFilters } from "../pending.js";
import { replyContexts } from "../transcript.js";

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
function add(session: string, text: string, options: { seen?: string; at?: string; marks?: string; finished?: boolean } = {}) {
  const seen = options.seen ?? old;
  hooks.prepare("INSERT OR REPLACE INTO sessions VALUES(?,?,?,?,?,?,0)").run(session, "codex", project, root, old, seen);
  const id = Number(hooks.prepare("INSERT INTO journal(session_id,ts,kind,text,marks) VALUES(?,?,'typed',?,?)").run(session, options.at ?? old, text, options.marks ?? "").lastInsertRowid);
  if (options.finished !== undefined) {
    const dir = join(writer.location.directory, "filter-sessions"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${shortHash(project + "\0" + session)}.json`), JSON.stringify({ version: 1, project_id: project, checkout: root, agent: "codex", session_id: session, seen_at: seen, finished: options.finished, transcript: "" }));
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
  it.each(["fabricated quote", "another session's words"])("rejects %s without acknowledging text", async quote => {
    add("s", "actual user words"); add("other", "another session's words");
    deps.model = vi.fn(async request => { const result = answer(request); const parsed = JSON.parse(result.text); parsed.items[0].quote = quote; return { ...result, text: JSON.stringify(parsed) }; });
    const id = queue(); expect((await run(id)).reason).toBe("The filter quote was not found in its typed source.");
    expect(batches()).toHaveLength(0); expect(writer.setting(project, "journal.consumed")).toBeUndefined();
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
  it("rolls back completion and acknowledgements together and reuses its draft after a save failure", async () => {
    add("s", "Tests use vitest because the project chose it.");
    writer.db.exec("CREATE TRIGGER reject_ack BEFORE INSERT ON settings WHEN new.key LIKE 'filter.session.%' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    const id = queue(); await run(id);
    expect(batches()[0].phase).toBe("draft"); expect(writer.setting(project, "journal.consumed")).toBeUndefined();
    writer.db.exec("DROP TRIGGER reject_ack"); await run(id);
    expect(batches()[0].phase).toBe("complete"); expect(calls).toHaveLength(1);
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
