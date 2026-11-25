import { MachineJobsSchema, MachineSetupAnswerResultSchema, MachineSetupLearningSchema,
  MachineSetupSnapshotSchema, MachineSetupStepSchema, type MachineSetupQuestion, type MachineSetupStep } from "@mex/hub-contracts/machine";
import * as children from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cliTools from "../../../cli-tools.js";
import * as checker from "../../../knowledge/check.js";
import { refreshRuleFiles } from "../../../knowledge/rule-cache.js";
import { expand } from "../../../knowledge/store.js";
import { hosts } from "../../../learn-deeper/hosts.js";
import { offerLearning } from "../../../learn-deeper/offer.js";
import { BACKFILL_PULLS_PER_BATCH, Plan, quoteCeiling, quoteTokens } from "../../../learn-deeper/plan.js";
import * as learningQuote from "../../../learn-deeper/quote.js";
import { LEARNING_DISMISSED } from "../../../learn-deeper/queue.js";
import * as model from "../../../model-runner/index.js";
import { openRecord, openRecordReadOnly, projectIdentity, type RecordWriter } from "../../../record/index.js";
import { blockedReason, enqueueJob, jobKind, registerJobKind, requestJob, runOneBatch, type JobRow } from "../../../record/jobs.js";
import { writeFactFile, type SetupRun } from "../../../repo-start/facts.js";
import { skippedFacts } from "../../../repo-start/history/job.js";
import { readAnswers } from "../../../repo-start/questions/answers.js";
import { createMachineHubApp } from "../app.js";
import { HubSessions } from "../security.js";

vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile), execFileSync: vi.fn(actual.execFileSync),
    execSync: vi.fn(actual.execSync), spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync) };
});

const ORIGIN = "http://127.0.0.1:41887";
const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const childCalls = [children.execFile, children.execFileSync, children.execSync, children.spawn, children.spawnSync];

let base: string, writer: RecordWriter, hooks: DatabaseSync, sessions: HubSessions, auth: ReturnType<typeof signIn>;
let clock: number, app: ReturnType<typeof createMachineHubApp>;
const location = () => ({ home: join(base, ".mex"), isNetwork: () => false });

function signIn() {
  const { session, cookie } = sessions.create();
  return { csrf: session.csrfToken, cookie: `${sessions.cookieName}=${cookie}` };
}

function connect() {
  return createMachineHubApp({ ...location(), sessions, homeId: "setup-test-home", version: "test",
    mode: "terminal", now: () => clock, env: process.env });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-machine-setup-")));
  clock = NOW;
  vi.stubEnv("MEX_HOME", base);
  vi.stubEnv("MEX_OFF", "0");
  vi.stubEnv("MEX_BACKGROUND", "0");
  vi.stubEnv("GH_TOKEN", "fixture-access");
  vi.stubEnv("CODEX_HOME", join(base, "codex"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(base, "claude"));
  writer = openRecord(location());
  hooks = new DatabaseSync(writer.location.hooks);
  const directory = resolve("native/record/schema/hooks");
  for (const file of readdirSync(directory).filter(name => name.endsWith(".sql")).sort()) {
    hooks.exec(readFileSync(join(directory, file), "utf8"));
    hooks.exec(`PRAGMA user_version=${Number(file.slice(0, 4))}`);
  }
  hooks.prepare("PRAGMA journal_mode=WAL").get();
  sessions = new HubSessions(writer.location.home, () => clock);
  auth = signIn();
  app = connect();
});

afterEach(() => {
  app.close();
  hooks.close();
  writer.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true, maxRetries: 5 });
});

function request(path: string, init: RequestInit = {}, login: typeof auth | null = auth) {
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", new URL(ORIGIN).host);
  if (login) headers.set("cookie", login.cookie);
  return app.request(ORIGIN + "/api/v1" + path, { ...init, headers });
}

function post(path: string, body: unknown, key: string | null = randomUUID(), overrides: Record<string, string> = {}, login: typeof auth | null = auth) {
  return request(path, {
    method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "x-mex-csrf": login?.csrf ?? auth.csrf,
      "content-type": "application/json", ...(key === null ? {} : { "idempotency-key": key }), ...overrides },
    body: JSON.stringify(body),
  }, login);
}

function git(cwd: string, ...args: string[]) {
  return children.execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.test", "-c", "user.name=Tester",
    "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: "pipe", timeout: 5_000 }).trim();
}

type Repo = { id: string; path: string };
const setupPath = (repo: Repo, suffix: string) => "/setup/" + repo.id + "/" + suffix;

function setRun(repo: Repo, fields: Partial<SetupRun> = {}) {
  writeFactFile(writer.location, repo.id, "setup.json", {
    version: 1, last_run: iso(), caller: "person", checkout: repo.path, ms: 314, commands_saved: true,
    found: { packages: 2, recipes: 3, rule_files: 2, rule_conflicts: 1, hints: 3 },
    exclude: { file: null, block: true }, ...fields,
  } satisfies SetupRun);
}

function project(name = "repo") {
  const path = join(base, name);
  mkdirSync(path);
  git(path, "init", "-q");
  writeFileSync(join(path, "README.md"), "# " + name + "\n");
  writeFileSync(join(path, "package.json"), '{"scripts":{"test":"node --test"}}\n');
  writeFileSync(join(path, "Makefile"), "test:\n\ttrue\n");
  git(path, "add", ".");
  git(path, "commit", "-qm", "Initial files");
  git(path, "remote", "add", "origin", "https://github.com/example/setup-docs.git");
  const { id } = writer.register(projectIdentity(path));
  const repo = { id, path };
  setRun(repo);
  return repo;
}

function ruleQuestion(repo: Repo) {
  writeFileSync(join(repo.path, "AGENTS.md"), "## Testing\n\nRun `npm test` before pushing.\n");
  writeFileSync(join(repo.path, "CLAUDE.md"), "## Testing\n\nRun `make test` before pushing.\n");
  refreshRuleFiles({ ...location(), projectPath: repo.path }, new Date(NOW));
}

function moreQuestions(repo: Repo) {
  const names = ["first.ts", "second.ts"];
  for (const name of names) writeFileSync(join(repo.path, name), "// generated file\n");
  writeFactFile(writer.location, repo.id, "code-facts.json", {
    ...skippedFacts("no commits"), checkout: repo.path, skipped: null,
    generated: names.map(path => ({ path, signal: "marker" })),
    hand_edited: names.map(path => ({ path, commits: 3 })),
  });
}

function seedJob(repo: Repo, kind: string, fields: Partial<JobRow> = {}) {
  const id = fields.id ?? randomUUID(), created = fields.created_at ?? iso(-1_000);
  writer.db.prepare(`INSERT INTO jobs(id,project_id,kind,state,reason,request,created_at,updated_at,finished_at,progress,params)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, repo.id, kind, fields.state ?? "queued", fields.reason ?? null, fields.request ?? null,
    created, created, fields.finished_at ?? null, fields.progress ?? null, fields.params ?? JSON.stringify({ checkout: repo.path }));
  return id;
}

function readJob(id: string) {
  return writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as unknown as JobRow | undefined;
}

function consent(repo: Repo) {
  return writer.db.prepare("SELECT key,value FROM settings WHERE scope=? AND key LIKE 'hub.setup.consent.%'").all(repo.id)
    .map(({ value }) => JSON.parse(String(value)));
}

async function snapshot(path: string, ready: (data: ReturnType<typeof MachineSetupSnapshotSchema.parse>) => boolean) {
  return vi.waitFor(async () => {
    const response = await request(path);
    expect(response.status).toBe(200);
    const data = MachineSetupSnapshotSchema.parse(await response.json());
    expect(!data.updatingSince && ready(data), JSON.stringify(data).slice(0, 650)).toBe(true);
    return data;
  }, { interval: 20, timeout: 2_500 });
}

async function setup(repo: Repo) {
  return (await snapshot("/setup?repo=" + repo.id, data => !!data.repo)).repo!;
}

function offerInventory() {
  vi.spyOn(cliTools, "isCliAvailable").mockImplementation(name => name === "codex");
  const evaluator = join(base, "evaluator");
  writeFileSync(evaluator, "stand-in");
  vi.stubEnv("MEX_HOOK_BINARY", evaluator);
  return vi.spyOn(hosts["github.com"], "inventory").mockResolvedValue({
    anonymous: false, more: false, pulls: [{ number: 1, at: iso(-86_400_000) }],
    source: { host: "github.com", slug: "example/setup-docs" }, visibility: "private",
  });
}

async function quote(repo: Repo) {
  const { offerRevision } = await setup(repo);
  const response = await post(setupPath(repo, "quote"), { expectedRevision: offerRevision });
  expect(response.status).toBe(200);
  const data = MachineSetupLearningSchema.parse(await response.json());
  if (data.state !== "offered" || !data.quote.revision) throw new Error("Expected a bound quote: " + JSON.stringify(data));
  return { ...data.quote, revision: data.quote.revision };
}

function act(repo: Repo, step: MachineSetupStep, action: "pause" | "resume" | "cancel", key?: string) {
  return post(setupPath(repo, "steps/" + step.jobId), { action, expectedRevision: step.revision }, key);
}

function ref({ id, revision }: MachineSetupQuestion) { return { id, revision }; }

describe("machine Setup reads", () => {
  it("reads both snapshots and an older job without changing bytes, spawning, or preparing a quote", async () => {
    const repo = project();
    ruleQuestion(repo);
    moreQuestions(repo);
    const old = seedJob(repo, "graph-build", { state: "done", finished_at: iso(-5_000), created_at: iso(-6_000) });
    writer.db.prepare("INSERT INTO job_results VALUES(?,0,?)").run(old, "Code map built: 12 files");
    for (let i = 0; i < 101; i++) seedJob(repo, "graph-refresh", { created_at: iso(i) });
    writer.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const files = [writer.location.record, writer.location.hooks, ...readdirSync(repo.path, { recursive: true, withFileTypes: true })
      .filter(file => file.isFile()).map(file => join(file.parentPath, file.name)),
      ...readdirSync(join(writer.location.home, "projects", repo.id)).map(file => join(writer.location.home, "projects", repo.id, file))];
    const before = files.map(file => readFileSync(file));
    const quotePath = vi.spyOn(learningQuote, "prepareLearningQuote");
    const runModel = vi.spyOn(model, "runModel");
    const network = vi.fn(() => { throw new Error("network on GET"); });
    vi.stubGlobal("fetch", network);
    for (const call of childCalls) vi.mocked(call).mockClear();

    expect((await snapshot("/setup", data => !!data.repos)).repos).toEqual([
      { repoId: repo.id, checkout: repo.path, status: "done" },
    ]);
    const data = await setup(repo);
    expect(data).toMatchObject({ checkout: repo.path, summary: { elapsedMs: 314, commandsSaved: true },
      steps: [{ jobId: old, state: "done", summary: "Code map built: 12 files" }] });
    expect(data.questions).toHaveLength(3);
    expect(data.questions[0]).toMatchObject({ type: "rule-conflict" });
    expect(data.questions[0]?.suggested).toBeUndefined();
    expect(data.offerRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(data.learnDeeper).toBeUndefined();
    expect(MachineJobsSchema.parse(await (await request("/jobs")).json()).some(job => job.id === old)).toBe(false);
    const focused = MachineJobsSchema.parse(await (await request("/jobs?job=" + old)).json());
    expect(focused).toHaveLength(100);
    expect(focused.at(-1)).toMatchObject({ id: old, repoId: repo.id, state: { phase: "done" } });

    expect(files.map(file => readFileSync(file))).toEqual(before);
    for (const call of [...childCalls, network, quotePath, runModel]) expect(call).not.toHaveBeenCalled();
    expect((await request("/setup?repo=../repo")).status).toBe(400);
    expect((await request("/setup?repo=" + repo.id + "&other=1")).status).toBe(400);
    expect((await request("/setup", {}, null)).status).toBe(401);
  });

  it("shows the most recent setup worktree and preserves each step's checkout", async () => {
    const repo = project();
    const worktree = join(base, "later worktree");
    git(repo.path, "worktree", "add", "-qb", "later", worktree);
    writer.register(projectIdentity(worktree));
    seedJob(repo, "file-index", { state: "done", finished_at: iso(-900) });
    const map = seedJob({ ...repo, path: worktree }, "graph-build", { created_at: iso(-100), progress: "41 of 72 files" });
    setRun(repo, { checkout: worktree });
    const data = await setup(repo);
    expect(data.checkout).toBe(worktree);
    expect(data.steps).toMatchObject([{ scope: repo.path }, { jobId: map, scope: worktree, progress: { done: 41, total: 72 } }]);

    app.close();
    setRun(repo, { checkout: undefined });
    app = connect();
    expect((await setup(repo)).checkout).toBe(worktree);

    app.close();
    git(repo.path, "worktree", "remove", worktree);
    app = connect();
    const missing = await setup(repo);
    expect(missing).toMatchObject({ checkout: worktree, missingCheckout: true });
    expect(missing.offerRevision).toBeUndefined();
  });

  it("keeps the last good setup when a later sample cannot read the record", async () => {
    const repo = project();
    const job = seedJob(repo, "graph-build");
    const state = await setup(repo);
    const step = state.steps[0]!;
    expect((await act(repo, step, "pause")).status).toBe(200);
    writer.db.exec("PRAGMA user_version=999");
    try {
      const data = await snapshot("/setup?repo=" + repo.id, value => !!value.issue);
      expect(data.issue).toMatch(/record\.db schema version 999/u);
      expect(data.repo?.steps[0]).toMatchObject({ jobId: job, state: "paused" });
    } finally {
      writer.db.exec("PRAGMA user_version=" + (await import("../../../record/schema.js")).RECORD_SCHEMA_VERSION);
    }
  });
});

describe("machine Setup job controls", () => {
  it("pauses, replays, resumes and cancels a real code map row and publishes the change", async () => {
    const repo = project();
    const { job } = enqueueJob(writer, { kind: "graph-build", projectId: repo.id, params: { checkout: repo.path } });
    const before = (await setup(repo)).steps[0]!;
    const stream = (await request("/events")).body!.getReader();
    try {
      await stream.read();
      const response = await act(repo, before, "pause", "pause");
      expect(response.status).toBe(200);
      const paused = MachineSetupStepSchema.parse(await response.json());
      expect(paused.state).toBe("paused");
      const change = new TextDecoder().decode((await stream.read()).value);
      expect(change).toContain('event: change\ndata: {"topics":["setup","jobs"]}');
      expect(await (await act(repo, before, "pause", "pause")).json()).toEqual(paused);
      expect((await act(repo, before, "cancel")).status).toBe(409);
      const resumed = MachineSetupStepSchema.parse(await (await act(repo, paused, "resume")).json());
      expect(resumed.state).toBe("queued");
      expect(await (await act(repo, resumed, "cancel")).json()).toMatchObject({ state: "cancelled" });
      expect(readJob(job.id)?.state).toBe("cancelled");
    } finally { await stream.cancel(); }
  });

  it.each(["graph-build", "learn-deeper"])("honours pending pause and cancel for the %s stand-in", async kind => {
    const repo = project();
    const original = jobKind(kind)!;
    let started!: () => void, finish!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const finishBatch = new Promise<void>(resolve => { finish = resolve; });
    registerJobKind({ name: kind, label: original.label, scope: "project", sideEffects: "none", async runBatch({ progress }) {
      progress?.("1 of 4 batches");
      started();
      await finishBatch;
      return { checkpoint: { done: 1 }, done: false, progress: "1 of 4 batches" };
    } });
    const { job } = enqueueJob(writer, { kind, projectId: repo.id, params: { checkout: repo.path } });
    const batch = runOneBatch(writer, "stand-in", { only: new Set([job.id]) });
    try {
      await running;
      const step = (await setup(repo)).steps[0]!;
      expect(step.state).toBe("running");
      expect(await (await act(repo, step, "pause")).json()).toMatchObject({ state: "running", pending: "pause" });
      expect(readJob(job.id)?.request).toBe("pause");
      finish();
      await batch;
      const paused = (await setupAfterChange(repo, "paused")).steps[0]!;
      const resumed = MachineSetupStepSchema.parse(await (await act(repo, paused, "resume")).json());
      expect(resumed.state).toBe("queued");
      expect(await (await act(repo, resumed, "cancel")).json()).toMatchObject({ state: "cancelled" });
    } finally {
      finish();
      await batch;
      registerJobKind(original);
    }
  }, 18_000);

  it("rejects unsafe writes and caps the body before changing a job", async () => {
    const repo = project();
    const jobId = seedJob(repo, "file-index");
    const step = (await setup(repo)).steps[0]!;
    const path = setupPath(repo, "steps/" + jobId);
    const body = { action: "pause", expectedRevision: step.revision };
    for (const [headers, status] of [
      [{ host: "example.test" }, 400], [{ origin: "http://example.test" }, 403],
      [{ "sec-fetch-site": "cross-site" }, 403], [{ "x-mex-csrf": "wrong" }, 403],
    ] as const) expect((await post(path, body, undefined, headers)).status).toBe(status);
    expect((await post(path, body, undefined, {}, null)).status).toBe(401);
    expect((await post(path, body, null)).status).toBe(400);
    const large = await post(path, { ...body, extra: "x".repeat(64 << 10) });
    expect(large.status).toBe(400);
    expect(await large.json()).toMatchObject({ detail: expect.stringContaining("64 KiB") });
    expect(readJob(jobId)?.state).toBe("queued");
  });

  it("returns a retryable 503 when the record stays busy", async () => {
    const repo = project();
    seedJob(repo, "graph-build");
    const step = (await setup(repo)).steps[0]!;
    writer.db.exec("BEGIN IMMEDIATE");
    try {
      const response = await act(repo, step, "pause", "retryable");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "MEX_BUSY" });
    } finally { writer.db.exec("ROLLBACK"); }
    expect((await act(repo, step, "pause", "retryable")).status).toBe(200);
  });
});

async function setupAfterChange(repo: Repo, state: JobRow["state"]) {
  return vi.waitFor(async () => {
    const response = await request("/setup?repo=" + repo.id);
    const { repo: data } = MachineSetupSnapshotSchema.parse(await response.json());
    expect(data?.steps[0]?.state).toBe(state);
    return data!;
  }, { interval: 75, timeout: 12_000 });
}

describe("learning approval", () => {
  it("binds the terminal plan, records consent, queues one job and waits for the earlier map", async () => {
    const repo = project();
    const graph = seedJob(repo, "graph-build");
    const inventory = offerInventory();
    const shown = await quote(repo);
    const expected = quoteTokens(1, 1, "codex", "best-only", [], BACKFILL_PULLS_PER_BATCH);
    expect(shown).toMatchObject({ agent: "Codex", tokens: expected, ceilingTokens: quoteCeiling(expected), weekly: true, privateRepo: true });
    expect(consent(repo)).toEqual([]);
    const body = { quoteRevision: shown.revision };
    const response = await post(setupPath(repo, "learn"), body, "learn");
    expect(response.status).toBe(200);
    const step = MachineSetupStepSchema.parse(await response.json());
    expect(step).toMatchObject({ state: "queued", kind: "learn-deeper", scope: repo.path });
    expect(await (await post(setupPath(repo, "learn"), body, "learn")).json()).toEqual(step);
    expect(inventory).toHaveBeenCalledTimes(2);
    expect(writer.db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='learn-deeper'").get()?.n).toBe(1);
    expect(consent(repo)).toEqual([expect.objectContaining({ version: 1, source: "from the Hub", at: iso(), checkout: repo.path, jobId: step.jobId,
      agent: "codex", tokensEstimate: shown.tokens, ceilingTokens: shown.ceilingTokens, revision: shown.revision, weekly: true })]);
    const job = readJob(step.jobId)!;
    expect(Plan.parse(JSON.parse(job.params))).toMatchObject({ agent: "codex", refresh: true, waitForSetup: true, docs: ["README.md"], head: git(repo.path, "rev-parse", "HEAD") });
    const only = new Set([job.id]);
    expect(await runOneBatch(writer, "test", { only })).toBe("idle");
    requestJob(writer, graph, "pause");
    expect(await runOneBatch(writer, "test", { only })).toBe("idle");
    requestJob(writer, graph, "resume");
    expect(await runOneBatch(writer, "test", { only })).toBe("idle");
    requestJob(writer, graph, "cancel");
    const reader = openRecordReadOnly(location())!;
    try { expect(blockedReason(reader, job)).toBeUndefined(); } finally { reader.close(); }
  });

  it("rolls consent back if writing the paid job fails", async () => {
    const repo = project();
    offerInventory();
    const shown = await quote(repo);
    writer.db.exec("CREATE TRIGGER refuse_learning BEFORE INSERT ON jobs WHEN new.kind='learn-deeper' BEGIN SELECT raise(ABORT, 'test failure'); END");
    expect((await post(setupPath(repo, "learn"), { quoteRevision: shown.revision })).status).toBe(500);
    expect(consent(repo)).toEqual([]);
    expect(writer.db.prepare("SELECT id FROM jobs WHERE kind='learn-deeper'").all()).toEqual([]);
  });

  it("rejects another session and a quote whose sources changed at the same price", async () => {
    const repo = project();
    const inventory = offerInventory();
    const shown = await quote(repo);
    const body = { quoteRevision: shown.revision };
    expect((await post(setupPath(repo, "learn"), body, undefined, {}, signIn())).status).toBe(409);
    inventory.mockResolvedValue({ anonymous: false, more: false, pulls: [{ number: 2, at: iso(-86_400_000) }],
      source: { host: "github.com", slug: "example/setup-docs" }, visibility: "private" });
    const stale = await post(setupPath(repo, "learn"), body);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "REVISION_CONFLICT" });
    expect(consent(repo)).toEqual([]);
    const next = await quote(repo);
    expect(next.tokens).toBe(shown.tokens);
    expect(next.revision).not.toBe(shown.revision);
  });

  it("keeps unsupported remotes free and refuses non-person and turned-off setups", async () => {
    const noRemote = project("no-remote");
    git(noRemote.path, "remote", "remove", "origin");
    const revision = (await setup(noRemote)).offerRevision;
    const inventory = offerInventory();
    const rejected = await post(setupPath(noRemote, "quote"), { expectedRevision: revision });
    expect(await rejected.json()).toEqual({ state: "no-review-remote" });
    expect(inventory).not.toHaveBeenCalled();
    expect((await post(setupPath(noRemote, "learn"), { quoteRevision: "a".repeat(64) })).status).toBe(409);

    const script = project("script");
    setRun(script, { caller: "script" });
    expect((await setup(script)).offerRevision).toBeUndefined();
    expect((await post(setupPath(script, "quote"), { expectedRevision: "a".repeat(64) })).status).toBe(409);

    const off = project("off");
    const quoted = await quote(off);
    writer.db.prepare("UPDATE checkouts SET state='off' WHERE project_id=?").run(off.id);
    expect((await post(setupPath(off, "learn"), { quoteRevision: quoted.revision })).status).toBe(409);
    expect(consent(off)).toEqual([]);
  });

  it("remembers Not now after restart and clears it when the terminal starts learning", async () => {
    const repo = project();
    const inventory = offerInventory();
    const shown = await quote(repo);
    const body = { quoteRevision: shown.revision };
    const skip = () => post(setupPath(repo, "skip-learning"), body, "skip");
    expect(await (await skip()).json()).toEqual({ saved: true });
    expect(await (await skip()).json()).toEqual({ saved: true });
    expect(writer.setting(repo.id, LEARNING_DISMISSED)).toBe("true");
    expect(consent(repo)).toEqual([]);
    expect((await post(setupPath(repo, "learn"), body)).status).toBe(409);

    app.close();
    app = connect();
    expect((await setup(repo)).learnDeeper).toEqual({ state: "skipped" });
    inventory.mockClear();
    const messages: string[] = [];
    vi.stubEnv("MEX_SETUP_BACKGROUND_AGENTS", undefined);
    await offerLearning({ root: repo.path, projectId: repo.id, interactive: false, write: line => messages.push(line) });
    expect(inventory).not.toHaveBeenCalled();
    expect(messages).toContain("To approve learning from reviews and docs, run `mex learn` in a terminal.");
    expect(writer.setting(repo.id, LEARNING_DISMISSED)).toBe("true");
    const confirm = vi.fn(async () => true);
    await offerLearning({ root: repo.path, projectId: repo.id, interactive: true, explicit: true, confirm, write: line => messages.push(line) });
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]).toEqual([expect.arrayContaining([
      `Estimate ${shown.tokens.toLocaleString("en-US")} tokens · ceiling ${shown.ceilingTokens.toLocaleString("en-US")} tokens.`,
      expect.stringContaining("every 7–14 days"),
    ]), expect.any(Array)]);
    const queued = writer.db.prepare("SELECT params FROM jobs WHERE project_id=? AND kind='learn-deeper'").get(repo.id);
    expect(Plan.parse(JSON.parse(String(queued?.params)))).toMatchObject({ refresh: true, estimate: shown.tokens, ceiling: shown.ceilingTokens });
    expect(JSON.parse(String(queued?.params)).waitForSetup).toBeUndefined();
    expect(writer.setting(repo.id, LEARNING_DISMISSED)).toBeUndefined();
    expect(consent(repo)).toEqual([]);
  });
});

describe("machine Setup question decisions", () => {
  it("saves one checked answer through the gate and remembers all remaining skips", async () => {
    const repo = project();
    ruleQuestion(repo);
    moreQuestions(repo);
    const check = vi.spyOn(checker, "runNative").mockImplementation((_binary, request) => ({
      ok: true, results: (request.items as Array<Record<string, unknown>>).map(item => ({
        ok: true, check: { ...item, files: {}, saw: { hash: "sha256:" + "a".repeat(64) } },
      })),
    }) as unknown as ReturnType<typeof checker.runNative>);
    vi.stubEnv("MEX_HOOK_BINARY", join(repo.path, "README.md"));
    const [first, ...rest] = (await setup(repo)).questions;
    expect(rest).toHaveLength(2);
    const path = setupPath(repo, "questions");
    const requestBody = { action: "answer", question: ref(first!), choice: "1" };
    const response = await post(path, requestBody, "answer");
    expect(response.status).toBe(200);
    const result = MachineSetupAnswerResultSchema.parse(await response.json());
    expect(result.questions).toMatchObject([{ outcome: { status: "saved", line: 'Saved: your agents get it as "you said"' } }]);
    expect(check).toHaveBeenCalledOnce();
    expect(await (await post(path, requestBody, "answer")).json()).toEqual(result);
    expect((await post(path, requestBody)).status).toBe(409);
    const saved = readAnswers(writer.location, repo.id).answers[first!.id]!;
    const { entry } = expand(saved.entries![0]!, { ...location(), projectPath: repo.path });
    expect(entry.mex.source).toMatchObject({ type: "person", label: "you said, at setup", producer: "setup-question" });
    expect(entry.mex.checks.map(({ kind }) => kind)).toEqual(["section", "section"]);
    expect((await post(path, { action: "skipAll", questions: [ref(rest[0]!)] })).status).toBe(409);
    const skipped = await post(path, { action: "skipAll", questions: rest.map(ref) });
    expect(skipped.status).toBe(200);
    expect((await skipped.json()).questions.map((question: MachineSetupQuestion) => question.outcome)).toEqual([
      { status: "skipped" }, { status: "skipped" },
    ]);
    app.close();
    app = connect();
    expect((await setup(repo)).questions).toEqual([]);
    expect(Object.values(readAnswers(writer.location, repo.id).answers).map(answer => answer.choice)).toEqual(["1", "skip", "skip"]);
  });

  it("skips one question using the same answer file, and refuses stale evidence", async () => {
    const repo = project();
    ruleQuestion(repo);
    moreQuestions(repo);
    const [first, one, other] = (await setup(repo)).questions;
    writeFileSync(join(repo.path, "AGENTS.md"), "## Testing\n\nUse the current CI checks.\n");
    expect((await post(setupPath(repo, "questions"), { action: "answer", question: ref(first!), choice: "skip" })).status).toBe(409);
    expect((await post(setupPath(repo, "questions"), { action: "answer", question: ref(one!), choice: "skip" })).status).toBe(200);
    app.close();
    app = connect();
    expect((await setup(repo)).questions.map(({ id }) => id)).toEqual([other!.id]);
    expect(readAnswers(writer.location, repo.id).answers).toMatchObject({ [one!.id]: { choice: "skip" } });
  });
});
