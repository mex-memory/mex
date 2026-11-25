import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { hash } from "../../judge/evidence.js";
import { recordChecks } from "../../judge/native.js";
import { parseEntry } from "../../knowledge/entry.js";
import { readHints, refreshHints } from "../../knowledge/hints.js";
import { readNotes } from "../../knowledge/personal-store.js";
import { prepareTeamWrite } from "../../knowledge/team.js";
import { reviewQueue } from "../../review/queue.js";
import { ModelWaitError, type ModelRequest, type ModelResult } from "../../model-runner/index.js";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { enqueueJob, registerJobKind, requeueReadyJobs, runOneBatch, type JobRow } from "../../record/jobs.js";
import { shortHash } from "../../record/project.js";
import { createFilterKind } from "../job.js";
import type { FilterInput } from "../input.js";
import { HOST_MEMORY_LABEL } from "../metadata.js";
import { sessionNoteHistory } from "../session-notes.js";
import { readStageOneBatch } from "../stage-one.js";
import { STAGE_TWO_WAIT } from "../pending.js";
import { createSessionImportKind } from "../import-job.js";
import { offerSessionImport, offerSessionRunner } from "../import-offer.js";
import { setSessionLearning } from "../../controls/index.js";
import { SESSION_LEARN_KIND, sessionRunner, setSessionRunner, SESSION_RUNNER_WAIT } from "../../knowledge/session-learning.js";
import { readSetupSteps } from "../../repo-start/steps.js";
import { runSessionApi } from "../../model-runner/session-api.js";
import { SESSION_API_AGENT, SESSION_API_CAP_WAIT, SESSION_API_DAILY_UNITS, SESSION_API_KEY, SESSION_API_KEY_WAIT,
  SESSION_API_MODEL } from "../../model-runner/session-api-policy.js";

vi.mock("../../knowledge/producers.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../knowledge/producers.js")>();
  return { ...actual, producer(id: Parameters<typeof actual.producer>[0]) {
    const producer = actual.producer(id);
    return id === "session-ongoing" || id === "session-import" ? { ...producer, active: true } : producer;
  } };
});

const day = 86_400_000;
const check = { kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/test" } };
const payload = (request: ModelRequest) => JSON.parse(request.prompt.split("Input follows as JSON:\n")[1]!);
type WriterInput = { sources: Array<{ id: string; typed: string; current: boolean; previous_reply: string | null }>;
  notes: Array<{ id: string; text: string; editable: boolean }>; host_matches: Array<{ id: string; text: string; hint_id?: string }> };
const writerInput = (request: ModelRequest): WriterInput => payload(request);
function write(members: string[], fact = "Tests use the project test runner.") {
  return { members, fact, action: "write", relation: "same", target: null, lasts: "repo", kind: "rule", reason: null,
    scope: ["package.json"], one_line: fact, private: false, checks: [check] };
}
function response(value: unknown): ModelResult {
  return { text: JSON.stringify(value), selectedModel: "fixture-cheap", usage: { input: 100, output: 20, cache_read: 0, cache_write: 0,
    model: "fixture", estimated: false } };
}

let suite: string, binary: string, base: string, checkout: string, home: string, project: string;
let writer: RecordWriter, hooks: DatabaseSync, now: number, calls: ModelRequest[];
let decide: (request: ModelRequest) => unknown;
const repository = vi.fn(async () => ({ visibility: "private" as const, authorized: true }));

beforeAll(() => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), "mex-stage-two-")));
  binary = join(suite, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000 });
}, 300_000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));
beforeEach(() => {
  base = mkdtempSync(join(suite, "case-")); checkout = join(base, "checkout"); home = join(base, ".mex");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "package.json"), '{"scripts":{"test":"vitest"}}\n');
  vi.stubEnv("MEX_HOME", base); vi.stubEnv("MEX_HOOK_BINARY", binary);
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(base, "claude")); vi.stubEnv("CODEX_HOME", join(base, "codex"));
  vi.stubEnv("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "0"); vi.stubEnv("CLAUDE_CODE_PROJECT_DIR_NAME", "");
  writer = openRecord({ home, projectPath: checkout, isNetwork: () => false }); project = writer.checkout(checkout)!.project_id;
  writer.db.prepare("INSERT OR REPLACE INTO settings VALUES('global','learning.statements','on')").run();
  hooks = new DatabaseSync(join(writer.location.directory, "hooks.db"));
  const schema = resolve("native/record/schema/hooks");
  for (const file of readdirSync(schema).filter(file => file.endsWith(".sql")).sort()) hooks.exec(readFileSync(join(schema, file), "utf8"));
  hooks.exec("PRAGMA user_version=6");
  now = Date.now(); calls = [];
  decide = request => ({ groups: [write(writerInput(request).sources.filter(source => source.current).map(source => source.id))] });
  repository.mockClear();
  registerFixture(false);
});
afterEach(() => { hooks.close(); writer.close(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

function registerFixture(useHostFiles: boolean) {
  registerJobKind(createFilterKind({ stageOne: true, stageTwo: useHostFiles ? {} : {
    hostMatches: sources => sources.slice(0, 1).map(source => ({ id: source.message.id, ref: "fixture", text: "Imported host context" })),
  }, clock: () => now, publication: { repository, clock: () => now }, recordChecks,
  aids: (entries, queries) => new Map(queries.map(query => [query.id, [{ id: entries[0]!.mex.id, score: 1, sent: true }]])),
  model: async request => {
    calls.push(request);
    if (request.purpose === "filter-stage-two") return response(decide(request));
    const { messages } = payload(request) as FilterInput;
    return response({ verdicts: messages.map(({ id, text }) => {
      const marker = ["Always", "From now on", "For this release"].find(prefix => text.startsWith(prefix)) ?? null;
      const reason = text.match(/\bbecause .+/u)?.[0] ?? null;
      return { id, verdict: "candidate", kind: marker === "From now on" ? "correction" : reason ? "fact" : "instruction",
        lasts: "repo", quote: text, marker, reason };
    }) });
  } }));
}

function capture(session: string, text: string, { agent = "codex", at = new Date(now - 20_000).toISOString(), transcript = "" } = {}) {
  hooks.prepare("INSERT OR IGNORE INTO sessions VALUES(?,?,?,?,?,?,0)").run(session, agent, project, checkout, at, at);
  const row = Number(hooks.prepare("INSERT INTO journal(session_id,ts,kind,text,marks) VALUES(?,?,'typed',?,'')").run(session, at, text).lastInsertRowid);
  const dir = join(writer.location.directory, "filter-sessions"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, shortHash(project + "\0" + session) + ".json"), JSON.stringify({ version: 1, project_id: project, checkout, agent,
    session_id: session, seen_at: at, finished: true, transcript }));
  return row;
}

const job = (id: string) => writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as unknown as JobRow;
const queue = () => enqueueJob(writer, { kind: "filter", projectId: project, params: { checkout, agent: "codex" } }).job.id;
const batch = async (id: string) => runOneBatch(writer, "stage-two-fixture", { only: new Set([id]) });
async function drain(id = queue()) {
  for (let index = 0; index < 16 && job(id).state === "queued"; index++) await batch(id);
  const current = job(id);
  expect(["waiting", "done"], current.reason ?? "filter did not finish").toContain(current.state);
  return current;
}
const writes = () => calls.filter(call => call.purpose === "filter-stage-two");
const notes = () => [...readNotes(home, project).files.values()].map(parseEntry);

function claudeTopic(name: string, text: string, modifiedAt: number) {
  const folder = join(base, "claude", "projects", checkout.replace(/[^a-zA-Z0-9]/gu, "-"), "memory");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, name + ".md");
  writeFileSync(path, text + "\n");
  utimesSync(path, new Date(modifiedAt), new Date(modifiedAt));
  return path;
}

function codexSummary(file: string, text: string, header: string) {
  const folder = join(base, "codex", "memories_v2", "rollout_summaries");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, file + ".md"), `${header}\ncwd: ${checkout}\nupdated_at: ${new Date(now).toISOString()}\n\n## Reusable knowledge\n- ${text}\n`);
}

const oneOff = (...ids: string[]) => ids.map(id => ({ action: "one-off", members: [id] }));

it("holds the first background run until the person chooses a runner, then honours the CLI choice", async () => {
  setSessionLearning(writer, "on");
  capture("first-consent", "Always use the configured test runner for all regression tests.");
  const model = vi.fn(async (request: ModelRequest) => response({ verdicts: payload(request).messages.map(({ id }: { id: string }) => ({ id, verdict: "none" })) }));
  registerJobKind(createFilterKind({ stageOne: true, consent: true, runner: () => "codex", clock: () => now, recordChecks, model }));
  const id = queue();
  await batch(id);
  expect(job(id)).toMatchObject({ state: "waiting", reason: SESSION_RUNNER_WAIT });
  expect(model).not.toHaveBeenCalled();
  const lines: string[] = [];
  await offerSessionRunner({ interactive: false, write: line => lines.push(line) });
  expect(lines.join("\n")).toMatch(/CLI.*tokens\/day[\s\S]*API key.*\$0\.11\/day[\s\S]*No AI.*0 model tokens\/day/u);
  expect(sessionRunner(writer)).toBeUndefined();
  await offerSessionRunner({ interactive: true, write: () => {}, ask: async () => "1" });
  expect(requeueReadyJobs(writer)).toBe(1);
  await drain(id);
  expect(model).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agent: "codex", automatic: expect.objectContaining({ sessionRunner: sessionRunner(writer) }) }));
});

it("runs the selected API path with its own credential, measured usage and daily allowance", async () => {
  setSessionLearning(writer, "on"); setSessionRunner(writer, "api");
  capture("api-session", "Always use the project test command for automated regression checks.");
  const model = vi.fn(async () => { throw new Error("The API choice used a CLI."); });
  const choose = vi.fn(() => "codex" as const);
  const key = "fixture_session_key_abcdefgh_123456";
  vi.stubEnv(SESSION_API_KEY, undefined); vi.stubEnv("OPENAI_API_KEY", "fixture_unrelated_key_123456789");
  const transport = vi.fn<typeof fetch>(async (endpoint, options) => {
    expect(endpoint).toBe("https://api.openai.com/v1/responses");
    expect(options).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: `Bearer ${key}` } });
    const input = JSON.parse(String(options?.body));
    expect(input).toMatchObject({ store: false, model: SESSION_API_MODEL, max_output_tokens: 8192 });
    expect(input.tools).toBeUndefined();
    const { messages } = JSON.parse(input.input.split("Input follows as JSON:\n")[1]);
    return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text",
      text: JSON.stringify({ verdicts: messages.map(({ id }: { id: string }) => ({ id, verdict: "none" })) }) }] }],
    usage: { input_tokens: 97, input_tokens_details: { cached_tokens: 21 }, output_tokens: 15 } });
  });
  registerJobKind(createFilterKind({ stageOne: true, consent: true, runner: choose, clock: () => now, recordChecks,
    model, api: request => runSessionApi(request, transport) }));
  const id = queue();
  await batch(id);
  expect(job(id)).toMatchObject({ state: "waiting", reason: SESSION_API_KEY_WAIT });
  expect(transport).not.toHaveBeenCalled();
  vi.stubEnv(SESSION_API_KEY, key);
  expect(requeueReadyJobs(writer)).toBe(1);
  await batch(id);
  expect(transport).toHaveBeenCalledOnce();
  expect(model).not.toHaveBeenCalled();
  expect(choose).not.toHaveBeenCalled();
  expect(writer.db.prepare("SELECT agent,model,input,output,cache_read,estimated FROM model_calls").all()).toMatchObject([
    { agent: SESSION_API_AGENT, model: SESSION_API_MODEL, input: 76, output: 15, cache_read: 21, estimated: 0 },
  ]);
  expect(JSON.stringify(writer.db.prepare("SELECT * FROM model_batches").all())).not.toContain(key);
  writer.db.prepare("UPDATE model_batches SET charged_units=? WHERE agent=?").run(SESSION_API_DAILY_UNITS, SESSION_API_AGENT);
  capture("api-too-much", "Always leave these copied fixture inputs available for regression checks.");
  await batch(id);
  expect(job(id)).toMatchObject({ state: "waiting", reason: SESSION_API_CAP_WAIT });
  expect(transport).toHaveBeenCalledOnce();
  setSessionRunner(writer, "none");
  expect(requeueReadyJobs(writer)).toBe(1);
  await drain(id);
  expect(transport).toHaveBeenCalledOnce();
  expect(model).not.toHaveBeenCalled();
});

it("keeps only exact lasting typed matches in no-AI mode, with no transport calls", async () => {
  setSessionLearning(writer, "on"); setSessionRunner(writer, "none");
  const typed = "Always use Vitest to run the repository regression tests.";
  const similar = "Always prefer another runner to run the repository regression tests.";
  const at = now - 10 * 60_000;
  capture("local-memory", typed, { agent: "claude-code", at: new Date(at).toISOString() });
  capture("uncorroborated", similar, { agent: "claude-code", at: new Date(at).toISOString() });
  claudeTopic("exact", typed, at + 1000);
  claudeTopic("foreign", "Always use unrelated wording from the host memory only.", at + 1000);
  const model = vi.fn(async () => { throw new Error("The no-AI choice called a model."); });
  const choose = vi.fn(() => "claude" as const);
  registerJobKind(createFilterKind({ stageOne: true, consent: true, stageTwo: {}, runner: choose, clock: () => now, recordChecks, model, api: model }));
  await drain();
  expect(model).not.toHaveBeenCalled();
  expect(choose).not.toHaveBeenCalled();
  expect(sessionNoteHistory(writer, project)).toMatchObject([{ quote: typed, scope: { kind: "repo" }, corroborated: "host-memory" }]);
  expect(notes()).toEqual([]);
  expect(reviewQueue({ home, projectPath: checkout }, now).waiting).toBe(0);
});

it("discards an in-flight label when runner consent changes before the result returns", async () => {
  setSessionLearning(writer, "on"); setSessionRunner(writer, "cli");
  const typed = "Always use Vitest to run the repository regression tests.";
  capture("changed-consent", typed);
  const model = vi.fn(async (request: ModelRequest) => {
    const { messages } = payload(request);
    setSessionRunner(writer, "none");
    return response({ verdicts: [{ id: messages[0].id, verdict: "candidate", kind: "instruction", lasts: "repo", marker: "Always", reason: null, quote: typed }] });
  });
  registerJobKind(createFilterKind({ stageOne: true, consent: true, runner: () => "codex", clock: () => now, recordChecks, model }));
  const id = queue();
  await batch(id);
  expect(model).toHaveBeenCalledOnce();
  expect(readStageOneBatch(writer, project, checkout, 1)).toBeUndefined();
  expect(sessionNoteHistory(writer, project)).toEqual([]);
  await drain(id);
  expect(model).toHaveBeenCalledOnce();
  expect(readStageOneBatch(writer, project, checkout, 1)?.attempts[0]?.model).toBeNull();
});

function pastSession(typed: string) {
  const folder = join(base, "claude", "projects", checkout.replace(/[^a-zA-Z0-9]/gu, "-"));
  mkdirSync(folder, { recursive: true });
  const sessionId = "a0000000-0000-4000-8000-000000000001", file = join(folder, sessionId + ".jsonl");
  const timestamp = new Date(now - 60 * 60_000).toISOString();
  writeFileSync(file, [
    { type: "assistant", message: { content: [{ type: "text", text: "Vitest is available in this repository." }] } },
    { type: "user", cwd: checkout, sessionId, timestamp, message: { role: "user", content: typed } },
    { type: "user", cwd: checkout, sessionId, timestamp, entrypoint: "sdk", message: { role: "user", content: "SCRIPTED_PAST_FIXTURE" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  utimesSync(file, new Date(timestamp), new Date(timestamp));
  return file;
}

it("previews past sessions and runs the approved import through both production stages", async () => {
  const typed = "Always use Vitest to run the repository regression tests.";
  pastSession(typed);
  const lines: string[] = [], print = (line: string) => lines.push(line);
  const confirm = vi.fn(async () => "yes");
  const options = { root: checkout, projectId: project, interactive: true, write: print, now, wake: false };
  const model = vi.fn(async (request: ModelRequest) => {
    expect(request.prompt).not.toContain("SCRIPTED_PAST_FIXTURE");
    if (request.purpose === "filter") {
      const data = payload(request).messages;
      expect(data).toMatchObject([{ text: typed, previous_reply: "Vitest is available in this repository." }]);
      return response({ verdicts: [{ id: data[0].id, verdict: "candidate", kind: "instruction", lasts: "repo", marker: "Always", reason: null, quote: typed }] });
    }
    expect(request.purpose).toBe("filter-stage-two");
    const data = writerInput(request).sources;
    expect(data).toMatchObject([{ typed, current: true }]);
    return response({ groups: [write([data[0]!.id], "Regression tests run with Vitest.")] });
  });
  registerJobKind(createSessionImportKind({ model, choose: () => "codex", clock: () => now, recordChecks, checksReady: () => true }));
  await offerSessionImport({ ...options, dryRun: true, ask: confirm });
  expect(lines.join("\n")).toContain("1 session and 1 eligible prompt");
  expect(lines.join("\n")).not.toContain(typed);
  expect(confirm).not.toHaveBeenCalled();
  expect(sessionRunner(writer)).toBeUndefined();
  expect(writer.db.prepare("SELECT * FROM jobs").all()).toEqual([]);
  setSessionRunner(writer, "cli");
  await offerSessionImport({ ...options, ask: confirm });
  expect(confirm).toHaveBeenCalledOnce();
  const queued = writer.db.prepare("SELECT * FROM jobs WHERE kind=?").get(SESSION_LEARN_KIND) as unknown as JobRow;
  expect(queued.params).not.toContain(typed);
  const reader = { all: <T>(sql: string, ...args: SQLInputValue[]) => writer.db.prepare(sql).all(...args) as T[] };
  expect(readSetupSteps(reader, project)).toMatchObject([{ kind: SESSION_LEARN_KIND, state: "queued" }]);
  await drain(queued.id);
  expect(model.mock.calls.map(([request]) => request.purpose)).toEqual(["filter", "filter-stage-two"]);
  expect(notes()).toMatchObject([{ text: "Regression tests run with Vitest.", mex: { source: { producer: "session-import", quote: typed } } }]);
  expect(hooks.prepare("SELECT * FROM journal").all()).toEqual([]);
  expect(writer.setting(project, "journal.consumed")).toBeUndefined();
  lines.length = 0;
  await offerSessionImport({ ...options, dryRun: true });
  expect(lines.join("\n")).toContain("0 sessions");
});

it("reports drift in an approved transcript, including a change to assistant context", async () => {
  const file = pastSession("Always use Vitest to run the repository regression tests.");
  setSessionRunner(writer, "cli");
  const model = vi.fn(async () => { throw new Error("Drifted transcript reached the runner."); });
  registerJobKind(createSessionImportKind({ model, choose: () => "codex", clock: () => now, checksReady: () => true }));
  await offerSessionImport({ root: checkout, projectId: project, interactive: true, now, wake: false, write: () => {}, ask: async () => "yes" });
  const queued = writer.db.prepare("SELECT * FROM jobs WHERE kind=?").get(SESSION_LEARN_KIND) as unknown as JobRow;
  const before = new Date(now - 60 * 60_000);
  writeFileSync(file, readFileSync(file, "utf8").replace("Vitest is available", "Different context is available"));
  utimesSync(file, before, before);
  for (let i = 0; i < 4 && job(queued.id).state === "queued"; i++) await batch(queued.id);
  expect(job(queued.id).state).toBe("done with gaps");
  expect(model).not.toHaveBeenCalled();
  expect(notes()).toEqual([]);
});
function onlyHostHint(request: ModelRequest, message: string, text: string) {
  const { host_matches } = writerInput(request);
  expect(host_matches).toEqual([{ id: message, text, hint_id: expect.stringMatching(/^hint:[a-f0-9]{24}$/u), ref: expect.any(String) }]);
  return host_matches[0]!.hint_id;
}

it("uses Claude's typed session window and sends the checked note to Review without sharing it", async () => {
  registerFixture(true);
  writer.db.prepare("UPDATE projects SET shared=1 WHERE id=?").run(project);
  const typed = "run the regression tests with vitest.";
  const at = now - 30 * 60_000;
  capture("claude-source", typed, { agent: "claude-code", at: new Date(at).toISOString() });
  capture("other-one", "set aside the temporary branch");
  capture("other-two", "fold in this last edit");
  const hint = "use vitest for regression tests. memory-only detail.";
  claudeTopic("early", "too early for the session", at - 1000);
  claudeTopic("late", "too late for the session", at + 15 * 60_000 + 1000);
  claudeTopic("matched", hint, at + 15 * 60_000);
  decide = request => ({ groups: [
    { ...write(["m1"], "memory-only wording is not a source."), host_hint: onlyHostHint(request, "m1", hint) },
    ...oneOff("m2", "m3"),
  ] });
  await drain();
  const [entry] = notes();
  expect(entry).toMatchObject({ text: typed, mex: { evidence: "observed", source: { type: "person", label: HOST_MEMORY_LABEL, quote: typed } } });
  expect(sessionNoteHistory(writer, project).find(note => note.row === "m1")).toMatchObject({ quote: typed, corroborated: "host-memory", scope: { kind: "repo" } });
  const options = { home, projectPath: checkout };
  expect(reviewQueue(options, now)).toMatchObject({ waiting: 1, items: [{ reason: "host memory corroborated the person's typed words",
    entry: { text: typed, mex: { source: { quote: typed } } } }] });
  expect(() => prepareTeamWrite(entry!, options, typed)).toThrow(/Unconfirmed observations/u);
  expect(repository).not.toHaveBeenCalled();
  expect(existsSync(join(checkout, ".mex", "learned"))).toBe(false);
  expect(refreshHints(options).imported).toBe(3);
  expect(readHints({ ...options, consumerAgent: "claude" }).entries).toEqual([]);
  expect(readHints({ ...options, consumerAgent: "codex" }).entries.map(item => item.entry.text)).toContain("too late for the session");
});

it.each(["thread id", "rollout path"])("binds a Codex memory to its captured %s", async reference => {
  registerFixture(true);
  const typed = "use the vitest test runner.";
  const folder = join(base, "codex", "sessions"); mkdirSync(folder, { recursive: true });
  const transcript = join(folder, "rollout.jsonl"), session = "codex-source";
  writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id: session } }) + "\n");
  capture(session, typed, { transcript });
  const missing = join(folder, "missing.jsonl");
  capture("other-one", "rename this fixture file", { transcript: missing });
  capture("other-two", "inspect the temporary config");
  const hint = "the project test runner is vitest";
  codexSummary("matches", hint, reference === "thread id" ? `thread_id: ${session}` : `rollout_path: ${transcript}`);
  codexSummary("foreign-session", "a different session's test runner", "thread_id: other-unrecorded-session");
  codexSummary("foreign-path", "a different rollout's test runner", `rollout_path: ${missing}`);
  decide = request => ({ groups: [{ ...write(["m1"]), host_hint: onlyHostHint(request, "m1", hint) }, ...oneOff("m2", "m3")] });
  await drain();
  expect(notes()).toMatchObject([{ text: typed, mex: { source: { label: HOST_MEMORY_LABEL, quote: typed } } }]);
});

it("can corroborate a deferred claim when its Codex summary arrives before a later daily pass", async () => {
  registerFixture(true);
  const typed = "use the vitest test runner.";
  capture("codex-source", typed);
  capture("other-one", "edit this one line");
  capture("other-two", "move the current patch");
  decide = request => ({ groups: [{ action: "defer", members: ["m1"] }, ...oneOff("m2", "m3")] });
  await drain();
  expect(notes()).toEqual([]);
  now += day;
  const hint = "vitest runs the repository checks";
  codexSummary("late", hint, "thread_id: codex-source");
  capture("unchecked", "Always write short test descriptions.");
  decide = request => {
    expect(writerInput(request).sources).toContainEqual(expect.objectContaining({ id: "m1", current: false }));
    return { groups: [{ ...write(["m1"]), host_hint: onlyHostHint(request, "m1", hint) }, ...oneOff("m4")] };
  };
  await drain();
  expect(notes()).toMatchObject([{ text: typed, mex: { source: { label: HOST_MEMORY_LABEL } } }]);
});

it.each(["uncheckable", "changed"])("keeps host corroboration safe when it is %s", async variant => {
  registerFixture(true);
  const typed = "use the project test runner.";
  capture("claude-source", typed, { agent: "claude-code" });
  capture("other-one", "finish this task");
  capture("other-two", "review this diff");
  const hint = "prefer the project test runner";
  const path = claudeTopic("runner", hint, now - 1000);
  decide = request => {
    if (request.prompt.startsWith("Repair checks only")) return { repairs: [] };
    const host_hint = onlyHostHint(request, "m1", hint);
    if (variant === "changed") writeFileSync(path, "changed while the model ran\n");
    return { groups: [{ ...write(["m1"]), checks: [], host_hint }, ...oneOff("m2", "m3")] };
  };
  await drain();
  expect(notes()).toEqual([]);
  const note = sessionNoteHistory(writer, project).find(note => note.row === "m1");
  expect(note).toMatchObject(variant === "uncheckable" ? { quote: typed, corroborated: "host-memory", scope: { kind: "repo" } } : { scope: { kind: "seen" } });
  expect(reviewQueue({ home, projectPath: checkout }, now).waiting).toBe(0);
});

it("requires three distinct sessions for weak candidates and merges recurring typed evidence", async () => {
  const first = capture("first", "Run code verification with the project test runner.");
  capture("first", "Add a scratch comment for this change.");
  await drain();
  capture("second", "Use the project test runner to verify code.");
  await drain();
  expect(writes()).toHaveLength(0);
  capture("third", "Move this local commit.");
  decide = request => {
    const input = writerInput(request);
    expect(input.host_matches).toEqual([{ id: "m1", ref: "fixture", text: "Imported host context" }]);
    return { groups: [write(["m1", "m3"]), ...["m2", "m4"].map(id => ({ action: "one-off", members: [id] }))] };
  };
  await drain();
  expect(writes()).toHaveLength(1);
  expect(writes()[0]!.role).toBe("cheap");
  expect(notes()).toMatchObject([{ text: "Tests use the project test runner.", mex: { source: { type: "person", producer: "session-ongoing",
    quote: "Use the project test runner to verify code." }, checks: [{ saw: { value: "vitest" } }] } }]);
  expect(readStageOneBatch(writer, project, checkout, first)?.verdicts).toHaveLength(2);
  expect(sessionNoteHistory(writer, project).find(note => note.row === "m1")?.retired?.reason).toBe("restated");
  expect(sessionNoteHistory(writer, project).find(note => note.row === "m3")?.scope.kind).toBe("repo");
  expect(sessionNoteHistory(writer, project).find(note => note.row === "m4")?.retired?.reason).toBe("one-off");
});

it("runs for one unchecked note, retries checks once, and writes the original reason and ranked search aids", async () => {
  const typed = "Tests use Vitest because the fixtures share setup.";
  capture("fact", typed);
  decide = request => {
    if (request.prompt.startsWith("Repair checks only")) {
      const { items } = payload(request) as { items: Array<{ id: string; text: string }> };
      expect(items.map(item => item.text)).toEqual([typed]);
      return { repairs: [{ id: items[0]!.id, checks: [check] }] };
    }
    return { groups: [{ ...write(["m1"], "Tests use Vitest."), aliases: ["test runner"], asks: ["which runner tests the project?"],
      checks: [{ ...check, target: { ...check.target, pointer: "/scripts/missing" } }] }] };
  };
  await drain();
  expect(writes()).toHaveLength(2);
  expect(notes()).toMatchObject([{ text: typed, mex: { aliases: ["test runner"], asks: ["which runner tests the project?"],
    source: { quote: typed }, checks: [{ files: { "package.json": hash(readFileSync(join(checkout, "package.json"), "utf8")) }, saw: { value: "vitest" } }] } }]);
});

it("waits until the rolling day opens and uses the gate to retire a corrected note", async () => {
  capture("initial", "Always use Vitest for this project's tests.");
  await drain();
  const original = notes()[0]!;
  expect(original.mex.status).toBe("active");
  now += day - 1;
  const correction = "From now on, use Node's runner for this project's tests.";
  capture("correction", correction);
  writeFileSync(join(checkout, "package.json"), '{"scripts":{"test":"node --test"}}\n');
  decide = request => {
    expect(writerInput(request).notes).toContainEqual(expect.objectContaining({ id: original.mex.id, editable: true }));
    return { groups: [{ ...write(["m2"], "Tests use Node's runner."), relation: "correction", target: original.mex.id }] };
  };
  const waiting = await drain();
  expect(waiting.reason).toBe(STAGE_TWO_WAIT);
  expect(writes()).toHaveLength(1);
  expect(requeueReadyJobs(writer)).toBe(0);
  ++now;
  expect(requeueReadyJobs(writer)).toBe(1);
  await drain(waiting.id);
  expect(writes()).toHaveLength(2);
  expect(notes()).toEqual(expect.arrayContaining([expect.objectContaining({ mex: expect.objectContaining({ id: original.mex.id, status: "retired" }) }),
    expect.objectContaining({ text: "Tests use Node's runner.", mex: expect.objectContaining({ status: "active", source: expect.objectContaining({ quote: correction }) }) })]));
  expect(sessionNoteHistory(writer, project).find(note => note.row === "m1")?.retired?.reason).toBe("corrected");
});

it("keeps a checked release draft in its private lifetime record", async () => {
  const typed = "For this release, use Vitest for the release tests.";
  capture("release", typed);
  await drain();
  expect(writes()).toHaveLength(1);
  expect(notes()).toHaveLength(0);
  const drafts = () => writer.db.prepare("SELECT value FROM settings WHERE scope=? AND key LIKE 'stage-two.checked.%'").all(project)
    .map(({ value }) => JSON.parse(String(value)));
  expect(drafts()).toMatchObject([{ lasts: "release", draft: { mex: { source: { quote: typed },
    checks: [{ saw: { value: "vitest" } }] } } }]);
  now += 61 * day;
  capture("later-release", typed);
  await drain();
  expect(drafts()).toHaveLength(2);
  expect(new Set(drafts().map(draft => draft.note)).size).toBe(2);
  expect(sessionNoteHistory(writer, project).find(note => note.row === "m1")?.retired?.reason).toBe("release-age");
});

it("withholds a lone weak claim and an invented reason while keeping the checked sibling", async () => {
  capture("weak", "Switch to the alternate runner.");
  capture("other", "Always use Vitest for this project's tests.");
  capture("fact", "The fixtures share state because they load project setup.");
  decide = () => ({ groups: [write(["m1"], "The project uses the alternate runner."), write(["m2"]),
    { ...write(["m3"], "The fixtures share state."), reason: "because they load cached network data." }] });
  await drain();
  expect(writes()).toHaveLength(1);
  expect(notes()).toMatchObject([{ mex: { source: { quote: "Always use Vitest for this project's tests." } } }]);
});

it("keeps the daily allowance available when admission waits and discards changed typed evidence", async () => {
  const row = capture("typed", "Always use the project test runner.");
  decide = () => { throw new ModelWaitError("cap"); };
  const held = await drain();
  expect(held.state).toBe("waiting");
  expect(writer.setting(project, "stage-two.started-at")).toBeUndefined();
  decide = () => {
    hooks.prepare("UPDATE journal SET text='An edited message' WHERE id=?").run(row);
    return { groups: [write(["m1"])] };
  };
  writer.db.prepare("UPDATE jobs SET state='queued',reason=NULL WHERE id=?").run(held.id);
  await batch(held.id);
  expect(job(held.id).state).toBe("queued");
  expect(writer.db.prepare("SELECT summary FROM job_results WHERE job_id=? ORDER BY batch DESC LIMIT 1").get(held.id))
    .toEqual({ summary: "Stage 2 discarded the response after inputs or consent changed" });
  expect(notes()).toHaveLength(0);
  expect(writer.setting(project, "stage-two.started-at")).toBe(String(now));
});
