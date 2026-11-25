import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { hash } from "../../judge/evidence.js";
import { recordChecks } from "../../judge/native.js";
import { parseEntry } from "../../knowledge/entry.js";
import { readNotes } from "../../knowledge/personal-store.js";
import { ModelWaitError, type ModelRequest, type ModelResult } from "../../model-runner/index.js";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { enqueueJob, registerJobKind, requeueReadyJobs, runOneBatch, type JobRow } from "../../record/jobs.js";
import { shortHash } from "../../record/project.js";
import { createFilterKind } from "../job.js";
import type { FilterInput } from "../input.js";
import { sessionNoteHistory } from "../session-notes.js";
import { readStageOneBatch } from "../stage-one.js";
import { STAGE_TWO_WAIT } from "../pending.js";

vi.mock("../../knowledge/producers.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../knowledge/producers.js")>();
  return { ...actual, producer(id: Parameters<typeof actual.producer>[0]) {
    const producer = actual.producer(id);
    return id === "session-ongoing" ? { ...producer, active: true } : producer;
  } };
});

const day = 86_400_000;
const check = { kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/test" } };
const payload = (request: ModelRequest) => JSON.parse(request.prompt.split("Input follows as JSON:\n")[1]!);
type WriterInput = { sources: Array<{ id: string; typed: string; current: boolean; previous_reply: string | null }>;
  notes: Array<{ id: string; text: string; editable: boolean }>; host_matches: Array<{ id: string; text: string }> };
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

beforeAll(() => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), "mex-stage-two-")));
  binary = join(suite, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000 });
}, 300_000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));
beforeEach(() => {
  base = mkdtempSync(join(suite, "case-")); checkout = join(base, "checkout"); home = join(base, "home");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "package.json"), '{"scripts":{"test":"vitest"}}\n');
  vi.stubEnv("MEX_HOME", home); vi.stubEnv("MEX_HOOK_BINARY", binary);
  writer = openRecord({ home, projectPath: checkout, isNetwork: () => false }); project = writer.checkout(checkout)!.project_id;
  writer.db.prepare("INSERT OR REPLACE INTO settings VALUES('global','learning.statements','on')").run();
  hooks = new DatabaseSync(join(writer.location.directory, "hooks.db"));
  const schema = resolve("native/record/schema/hooks");
  for (const file of readdirSync(schema).filter(file => file.endsWith(".sql")).sort()) hooks.exec(readFileSync(join(schema, file), "utf8"));
  hooks.exec("PRAGMA user_version=6");
  now = Date.now(); calls = [];
  decide = request => ({ groups: [write(writerInput(request).sources.filter(source => source.current).map(source => source.id))] });
  registerJobKind(createFilterKind({ stageOne: true, stageTwo: {
    hostMatches: sources => sources.slice(0, 1).map(source => ({ id: source.message.id, ref: "fixture", text: "Imported host context" })),
  }, clock: () => now, recordChecks, aids: (entries, queries) => new Map(queries.map(query => [query.id, [{ id: entries[0]!.mex.id, score: 1, sent: true }]])),
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
});
afterEach(() => { hooks.close(); writer.close(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

function capture(session: string, text: string) {
  const at = new Date(now - 20_000).toISOString();
  hooks.prepare("INSERT OR IGNORE INTO sessions VALUES(?,?,?,?,?,?,0)").run(session, "codex", project, checkout, at, at);
  const row = Number(hooks.prepare("INSERT INTO journal(session_id,ts,kind,text,marks) VALUES(?,?,'typed',?,'')").run(session, at, text).lastInsertRowid);
  const dir = join(writer.location.directory, "filter-sessions"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, shortHash(project + "\0" + session) + ".json"), JSON.stringify({ version: 1, project_id: project, checkout, agent: "codex",
    session_id: session, seen_at: at, finished: true, transcript: "" }));
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
