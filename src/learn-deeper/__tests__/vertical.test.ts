import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MEANING_PURPOSE } from "../meaning.js";
import { recordedMeaning } from "./fixtures/meaning.js";
import * as cliTools from "../../cli-tools.js";
import { literalPattern } from "../../file-index/classify.js";
import { buildIndex } from "../../file-index/build.js";
import { openIndex } from "../../file-index/read.js";
import { indexDirectory, writePatterns } from "../../file-index/store.js";
import { parseEntry, serializeEntry } from "../../knowledge/entry.js";
import * as gateEngine from "../../knowledge/gate.js";
import * as proofEngine from "../prove.js";
import { propose } from "../../knowledge/gate.js";
import { snapshotNotes } from "../../knowledge/personal-store.js";
import { prepareShare } from "../../knowledge/share-plan.js";
import { claimHash } from "../../knowledge/state.js";
import { runModel } from "../../model-runner/index.js";
import { CEILING_WAIT, recordedModelSpend } from "../../model-runner/consent.js";
import { claimModelBatch, enqueueModelBatch, recoverModelBatches, withModelJob } from "../../model-runner/budget-queue.js";
import { ModelRunError, ModelWaitError } from "../../model-runner/index.js";
import { queueJob } from "../../record/background.js";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { enqueueJob, listJobs, ownerId, recoverInterruptedJobs, registerJobKind, requestJob, requeueReadyJobs, runOneBatch, type JobRow } from "../../record/jobs.js";
import { ZERO } from "../../record/usage.js";
import { runRepoStart } from "../../repo-start/command.js";
import { approvedCoverage, coverageKey, noteKey, readTeamCoverage, type SourceRef } from "../coverage.js";
import { ForgeClient } from "../forge.js";
import { createLearnKind, writerModel } from "../job.js";
import { chooseAgent, offerLearning } from "../offer.js";
import { LEARN_KIND, Plan } from "../plan.js";
import { CURSOR_KEY, reviewRows } from "../pipeline.js";
import { sourceDigest } from "../source.js";
import { DAY_MS, nextWeeklyAt, queueDueWeekly, saveWeeklySchedule, WEEKLY_KIND, weeklySchedule, weeklyWakeDue } from "../weekly-schedule.js";

let suite: string, binary: string, fixture: string, repo: string;
const original = { host: "github.com" as const, slug: "example/memory" };
const path = "CONTRIBUTING.md";
const sourceId = "doc:CONTRIBUTING.md#development";
const quote = "Run npm run verify before cutting a release.";
const claim = quote;
const doc = (body = quote) => `# Development\n\n${body}\n`;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function commit(message: string) {
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", message);
  return git("rev-parse", "HEAD");
}

beforeAll(() => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), "mex-learn-vertical-")));
  binary = join(suite, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));
beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(suite, "case-")));
  repo = join(fixture, "repo");
  mkdirSync(repo);
  git("init", "-qb", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("remote", "add", "origin", "https://github.com/example/memory.git");
  writeFileSync(join(repo, path), doc());
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", scripts: { verify: "node verify.js" } }));
  commit("Add the contributor guide");
  for (const [key, value] of Object.entries({ MEX_HOME: fixture, MEX_BACKGROUND: "0", MEX_OFFLINE: "1", MEX_HOOK_BINARY: binary,
    CLAUDE_CONFIG_DIR: join(fixture, "claude"), CODEX_HOME: join(fixture, "codex"), GH_TOKEN: "forge-fixture-token" })) vi.stubEnv(key, value);
  vi.spyOn(cliTools, "isCliAvailable").mockImplementation(name => name === "codex");
  vi.stubGlobal("fetch", mockGithub());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  registerJobKind(createLearnKind());
  registerJobKind(createLearnKind({}, true));
  rmSync(fixture, { recursive: true, force: true, maxRetries: 4 });
});

function mockGithub(options: { head?: () => string; at?: string; fetches?: string[] } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    options.fetches?.push(url.pathname);
    expect(url.origin).toBe("https://api.github.com");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer forge-fixture-token");
    if (url.pathname === "/repos/example/memory") return Response.json({ full_name: "example/memory", default_branch: "main", private: true });
    if (url.pathname.endsWith("/branches/main") && options.head) return Response.json({ commit: { sha: options.head() } });
    if (url.pathname === "/graphql") {
      const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
      if (query.includes("HarvestSearch(")) return Response.json({ data: Object.fromEntries(Object.entries(variables).filter(([key]) => /^q\d+$/u.test(key))
        .map(([key, search]) => {
          const [start, end] = /merged:([^ ]+)\.\.([^ ]+)$/u.exec(search)?.slice(1) ?? [];
          const nodes = options.at && start && end && Date.parse(options.at) >= Date.parse(start) && Date.parse(options.at) <= Date.parse(end)
            ? [{ number: 1, mergedAt: options.at }] : [];
          return [`s${key.slice(1)}`, { issueCount: nodes.length, nodes, pageInfo: { hasNextPage: false } }];
        })) });
      if (query.includes("pullRequest(number:")) return Response.json({ data: { repository: { p0: {
        number: 1, state: "MERGED", mergedAt: options.at, title: "Refresh the renderer", body: " ",
        comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [], totalCount: 0 }, files: { nodes: [] },
      } } } });
    }
    throw new Error(`Unexpected fixture request ${url.pathname}`);
  });
}
const reply = (value: object) => ({ text: JSON.stringify(value), selectedModel: "fixture", usage: { ...ZERO, model: "fixture-2026-11", estimated: false } });
type ModelRequest = Parameters<typeof runModel>[0];
const clusters = (prompt: string) => [...prompt.matchAll(/"cluster":"([a-f0-9]{24})"/gu)].map(match => match[1]!);
function docReply(request: ModelRequest, id = sourceId, text = claim, citation = quote) {
  if (request.purpose === MEANING_PURPOSE) return reply(recordedMeaning(request.prompt));
  if (request.purpose === "learn-deeper-filter") {
    const items = JSON.parse(request.prompt.split("\nItems:\n")[1]!) as { id: string }[];
    return reply({ results: items.map(item => ({ id: item.id, keep: item.id === id, category: "process", lesson: text })) });
  }
  return reply({ entries: [{ cluster: clusters(request.prompt)[0], kind: "rule", route: "process-rule", claim: text,
    clauses: [{ text, quotes: [{ id, quote: citation }] }], scope: [] }] });
}

async function accept(ask = vi.fn(async (_lines: readonly string[]) => true)) {
  const lines: string[] = [];
  const result = await runRepoStart({ cwd: repo, write: line => lines.push(line), caller: "person", ask, install: false, wait: false });
  return { result, lines, ask };
}
const jobRow = (writer: RecordWriter, kind = LEARN_KIND) => writer.db.prepare("SELECT * FROM jobs WHERE kind=? ORDER BY rowid DESC LIMIT 1").get(kind) as unknown as JobRow;
const only = (job: JobRow) => ({ only: new Set([job.id]) });
const state = (job: JobRow) => JSON.parse(job.checkpoint ?? "{}");
const rawRows = (writer: RecordWriter, job: JobRow) => writer.db.prepare("SELECT key,value FROM settings WHERE key LIKE ?").all(`learning.deep.v2.${job.id}.%`);
const notes = (writer: RecordWriter, job: JobRow) => [...snapshotNotes(writer, job.project_id!).files.values()].map(parseEntry);
async function advance(writer: RecordWriter, job: JobRow, condition: (row: JobRow) => boolean = row => row.state !== "queued") {
  const owner = ownerId("foreground");
  for (let i = 0; i < 20; i++) {
    const row = jobRow(writer, job.kind);
    if (condition(row)) return row;
    expect(await runOneBatch(writer, owner, only(job)), String(row.reason ?? "")).toBe("ran");
  }
  throw new Error(`Learning did not reach the expected state: ${JSON.stringify(jobRow(writer, job.kind))}`);
}
function openWeekly(home?: string) {
  const writer = openRecord({ home, projectPath: repo, isNetwork: () => false });
  writer.db.prepare("UPDATE checkouts SET state='on' WHERE path=?").run(writer.checkout(repo)!.path);
  return writer;
}
function due(writer: RecordWriter, head: string, now: number) {
  const checkout = writer.checkout(repo)!;
  saveWeeklySchedule(writer, checkout.project_id, { checkout: checkout.path, origin: original, source: original, visibility: "private",
    agent: "codex", setup: "best-only", preferred: [], head, since: new Date(now - DAY_MS * 8).toISOString(), due: now });
  queueDueWeekly(writer, queueJob, now);
  return jobRow(writer, WEEKLY_KIND);
}
function hook(event: string, session_id: string, extra: object = {}) {
  return execFileSync(binary, ["codex", event], { cwd: repo, encoding: "utf8",
    input: JSON.stringify({ cwd: repo, hook_event_name: event, session_id, ...extra }) });
}
function fixtureModel() {
  return vi.fn<typeof runModel>(async request => docReply(request));
}

it("quotes the ceiling before any model call, accounts for sorting, writing and evidence, and saves a private process rule", async () => {
  const model = vi.fn<typeof runModel>(async request => runModel({ ...request, __internal: { spawn: (_file, _args, options) => {
    expect(options.env?.GH_TOKEN).toBeUndefined();
    return spawn(process.execPath, ["-e", `process.stdin.resume(); process.stdin.on("end", () => {
      console.log(JSON.stringify({type: "thread.started", thread_id: "fixture"}));
      console.log(JSON.stringify({type: "item.completed", item: {type: "agent_message", text: process.argv[1]}}));
      console.log(JSON.stringify({type: "turn.completed", usage: {input_tokens: 1000, cached_input_tokens: 100, output_tokens: 200}}));
    });`, docReply(request).text], options);
  } } }));
  registerJobKind(createLearnKind({ model }));
  const confirm = vi.fn(async (lines: readonly string[]) => {
    expect(lines.join("\n")).toMatch(/ceiling .*tokens/u);
    expect(lines.join("\n")).toContain("private repo");
    expect(model).not.toHaveBeenCalled();
    return true;
  });
  const { result } = await accept(confirm);
  expect(confirm).toHaveBeenCalledTimes(1);
  const writer = openRecord();
  try {
    const job = jobRow(writer), plan = Plan.parse(JSON.parse(job.params));
    expect(job.project_id).toBe(result.projectId);
    expect(plan.ceiling).toBe(Math.floor(plan.estimate * 1.5));
    const done = await advance(writer, job);
    expect(done, String(done.reason)).toMatchObject({ state: "done", results: 1, tokens_used: 3600 });
    expect(state(done).v2.counts).toMatchObject({ "tokens.triage": 1200, "tokens.write": 1200, "tokens.quotes": 1200, saved: 1 });
    expect(writer.db.prepare("SELECT count(*) n FROM model_batches WHERE job_id=? AND state='done'").get(job.id)?.n).toBe(3);
    const schedule = JSON.parse(weeklySchedule(writer, job.project_id!)!);
    expect(schedule.due).toBeGreaterThanOrEqual(Date.parse(plan.until) + 7 * DAY_MS);
    expect(weeklyWakeDue(writer.location.home, schedule.due - 1_000)).toBe(false);
    expect(weeklyWakeDue(writer.location.home, schedule.due + 1_000)).toBe(true);
    expect(notes(writer, job)).toHaveLength(1);
    const entry = notes(writer, job)[0]!;
    expect(entry.mex.source).toMatchObject({ producer: "learn-deeper", quote });
    expect(entry.mex.checks).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "quote", role: "complete" })]));
    expect(hook("SessionStart", "new", { source: "startup" })).not.toContain(claim);
    expect(existsSync(join(repo, ".mex", "learned"))).toBe(false);
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe("");
  } finally { writer.close(); }
}, 60_000);

it("prints the terminal command for a script without fetching or queuing model work", async () => {
  const fetch = mockGithub();
  vi.stubGlobal("fetch", fetch);
  const lines: string[] = [], ask = vi.fn(async () => true);
  await runRepoStart({ cwd: repo, write: line => lines.push(line), caller: "script", ask, install: false, wait: false });
  expect(lines.join("\n")).toContain("run `mex learn` in a terminal");
  expect(ask).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  const writer = openRecord();
  try { expect(jobRow(writer)).toBeUndefined(); }
  finally { writer.close(); }
});

it("joins the unfinished job and keeps its pinned docs across a branch switch", async () => {
  const { ask } = await accept();
  expect((await accept(ask)).lines.join("\n")).toContain("Learn deeper");
  expect(ask).toHaveBeenCalledTimes(1);
  git("switch", "-qc", "other");
  writeFileSync(join(repo, path), doc("This is the other branch."));
  commit("Change the guide on the other branch");
  const model = vi.fn<typeof runModel>(async request => {
    expect(request.prompt).toContain(quote);
    expect(request.prompt).not.toContain("This is the other branch");
    return docReply(request);
  });
  registerJobKind(createLearnKind({ model }));
  const writer = openRecord();
  try {
    expect(await advance(writer, jobRow(writer))).toMatchObject({ state: "done", results: 1 });
    expect(model).toHaveBeenCalledTimes(3);
    expect(git("status", "--porcelain")).toBe("");
  } finally { writer.close(); }
}, 60_000);

it.each(["offline", "expired login"] as const)("waits and resumes the same harvest after %s", async problem => {
  const fetch = mockGithub();
  vi.stubGlobal("fetch", fetch);
  await accept();
  let available = false, now = Date.now();
  const model = fixtureModel();
  registerJobKind(createLearnKind({ model, now: () => now, client: async plan => new ForgeClient(plan.origin, "forge-fixture-token", async (input, init) => {
    if (available) return fetch(input, init);
    if (problem === "expired login") return new Response(null, { status: 401 });
    throw new TypeError("fixture network failure");
  }, 0) }));
  const writer = openRecord();
  try {
    const job = jobRow(writer);
    const waiting = await advance(writer, job);
    expect(waiting).toMatchObject({ state: "waiting", batch: 0, failures: 0 });
    expect(waiting.reason).toMatch(problem === "offline" ? /could not be reached/u : /sign in/iu);
    expect(model).not.toHaveBeenCalled();
    expect(requeueReadyJobs(writer)).toBe(0);
    available = true;
    now += 61_000;
    expect(requeueReadyJobs(writer)).toBe(1);
    const done = await advance(writer, job);
    expect(done, String(done.reason)).toMatchObject({ state: "done", results: 1 });
    expect(state(done).v2.counts).toMatchObject({ "harvested.doc": 1, saved: 1 });
    expect(model).toHaveBeenCalledTimes(3);
  } finally { writer.close(); }
}, 60_000);

it("reuses completed triage when a provider limit stops the writer and the app restarts", async () => {
  await accept();
  let now = Date.now(), limited = true;
  const model = vi.fn<typeof runModel>(async request => {
    if (request.purpose === LEARN_KIND && limited) throw new ModelRunError("usage_limit", "codex", new Date(now + 2000).toISOString());
    return docReply(request);
  });
  registerJobKind(createLearnKind({ model, now: () => now }));
  let writer = openRecord();
  try {
    const job = jobRow(writer);
    const waiting = await advance(writer, job);
    expect(waiting.state).toBe("waiting");
    expect(waiting.reason).toContain("usage limit");
    expect(state(waiting).v2.phase).toBe("write");
    expect(model.mock.calls.map(([request]) => request.role)).toEqual(["cheap", "best"]);
    writer.close();
    writer = openRecord();
    expect(requeueReadyJobs(writer)).toBe(0);
    now += 3_000;
    limited = false;
    expect(requeueReadyJobs(writer)).toBe(1);
    expect(await advance(writer, job)).toMatchObject({ state: "done", results: 1 });
    expect(model.mock.calls.map(([request]) => request.role)).toEqual(["cheap", "best", "best", "cheap"]);
    expect(rawRows(writer, job)).toEqual([]);
  } finally { writer.close(); }
}, 60_000);


it("conserves unknown timed-out or killed usage, applies the window guard, and blocks an unaffordable retry", async () => {
  await accept();
  let writer = openRecord();
  try {
    const job = jobRow(writer), plan = Plan.parse(JSON.parse(job.params));
    const context = { jobId: job.id, batch: job.batch, projectId: job.project_id, recordHome: writer.location.home };
    const consented = { estimate: { ...ZERO, input: 100, output: 20 }, ceiling: 240 };
    const request = { agent: "codex" as const, projectRoot: plan.checkout, purpose: LEARN_KIND, prompt: "Fixture prompt", consented, timeoutMs: 75 };
    const newCall = () => enqueueModelBatch(writer, { agent: "codex", model: "gpt-6.1-sol", projectPath: repo, consented, job: context });
    writer.db.prepare("INSERT INTO usage_windows(agent,window,observed_at,used_percent,resets_at,status) VALUES(?,?,?,?,?,?)")
      .run("codex", "fixture", new Date().toISOString(), 75, new Date(Date.now() + 60_000).toISOString(), "allowed");
    const held = newCall();
    expect(claimModelBatch(writer, held)).toBe("usage-window");
    writer.db.prepare("UPDATE model_batches SET state='cancelled' WHERE id=?").run(held.id);
    writer.db.exec("DELETE FROM usage_windows");
    await expect(withModelJob(context, () => runModel({ ...request, __internal: { spawn: (_file, _args, options) =>
      spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"], options) } })))
      .rejects.toMatchObject({ category: "timeout" });
    expect(recordedModelSpend(writer, job.id)).toBe(120);
    const killed = newCall();
    expect(claimModelBatch(writer, killed)).toBeUndefined();
    writer.close(); writer = openRecord();
    recoverModelBatches(writer, Date.now(), () => false);
    expect(recordedModelSpend(writer, job.id)).toBe(240);
    expect(claimModelBatch(writer, newCall())).toBe("cap");
    await expect(withModelJob(context, () => runModel({ ...request, __internal: { spawn: () => { throw new Error("unexpected launch"); } } })))
      .rejects.toHaveProperty("message", CEILING_WAIT);
    const jobs = listJobs({ all: (sql, ...args) => writer.db.prepare(sql).all(...args) as never });
    expect(jobs.find(item => item.id === job.id)?.tokens.used).toBe(240);
    expect(enqueueJob(writer, { kind: LEARN_KIND, projectId: job.project_id }).existing).toBe(true);
  } finally { writer.close(); }
});

it("names the model with the most usage, or unknown, never the requested alias", () => {
  const usage = { ...ZERO, model: "mixed", estimated: false };
  expect(writerModel({ selectedModel: "best", usage: { ...usage, byModel: [
    { ...ZERO, input: 10, model: "small-2026", estimated: false }, { ...ZERO, input: 900, output: 50, model: "large-2026", estimated: false },
  ] } })).toEqual({ id: "best", version: "large-2026" });
  expect(writerModel({ selectedModel: "best", usage: { ...usage, model: "large-2026" } })).toEqual({ id: "best", version: "large-2026" });
  expect(writerModel({ selectedModel: "best", usage })).toEqual({ id: "best", version: "unknown" });
  expect(writerModel({ selectedModel: "best", usage: { ...usage, model: "unknown" } })).toEqual({ id: "best", version: "unknown" });
});

it("picks the runner from the last 7 days, this project first", () => {
  vi.spyOn(cliTools, "isCliAvailable").mockImplementation(() => true);
  const writer = openRecord({ projectPath: repo });
  const project = writer.checkout(repo)!.project_id;
  const hooks = new DatabaseSync(join(writer.location.directory, "hooks.db"));
  try {
    const schema = resolve("native/record/schema/hooks");
    for (const file of readdirSync(schema).filter(name => name.endsWith(".sql")).sort()) hooks.exec(readFileSync(join(schema, file), "utf8"));
    const at = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
    const add = (id: string, agent: string, projectId: string, days: number) =>
      hooks.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,0)").run(id, agent, projectId, repo, at(days), at(days));
    // Codex was used more, but only before the window.
    for (const id of ["c1", "c2", "c3"]) add(id, "codex", project, 20);
    add("k1", "claude-code", project, 2);
    expect(chooseAgent(project)).toBe("claude");
    // With no recent use here, recent use anywhere on the machine decides.
    hooks.exec("DELETE FROM sessions");
    add("o1", "codex", "g-other", 1);
    expect(chooseAgent(project)).toBe("codex");
  } finally { hooks.close(); writer.close(); }
});


it("two due machines converge on one rule id and offer one team publication", async () => {
  const old = git("rev-parse", "HEAD");
  writeFileSync(join(repo, path), doc(quote + " Keep the report with the release."));
  writeFileSync(join(repo, "fixture.js"), "export const snapshots = [];\n");
  const head = commit("Update the contributor guide"), now = Date.now() + 2_000, fetches: string[] = [];
  const fetch = mockGithub({ head: () => head, fetches });
  const model = vi.fn<typeof runModel>(async request => {
    expect(request.automatic?.measuredUsageOnly).toBe(true);
    expect(request.consented).toBeUndefined();
    expect(request.prompt).toContain(quote);
    return docReply(request);
  });
  registerJobKind(createLearnKind({ client: async () => new ForgeClient(original, "forge-fixture-token", fetch), model, now: () => now,
    next: time => nextWeeklyAt(time, () => 0.5) }, true));
  const machines = [openWeekly(join(fixture, "machine-a")), openWeekly(join(fixture, "machine-b"))];
  try {
    const project = machines[0]!.checkout(repo)!.project_id;
    const pattern = literalPattern("snapshots");
    writePatterns(indexDirectory(machines[0]!.location.directory, project), [pattern]);
    const jobs = machines.map(writer => due(writer, old, now));
    const learned = await Promise.all(machines.map(async (writer, i) => {
      const job = jobs[i]!;
      const done = await advance(writer, job);
      expect(done, String(done.reason)).toMatchObject({ state: "done", results: 1 });
      expect(state(done).weeklyPlan.harvest.mode).toBe("weekly");
      expect(JSON.parse(weeklySchedule(writer, project)!).due).toBe(now + 10.5 * DAY_MS);
      expect(JSON.parse(writer.setting(project, CURSOR_KEY)!).sources.doc.newest.id).toBe(path);
      expect(notes(writer, job)).toHaveLength(1);
      return [...snapshotNotes(writer, project).files][0]!;
    }));
    expect(fetches.filter(value => value.endsWith("/branches/main"))).toHaveLength(2);
    expect(model).toHaveBeenCalledTimes(6);
    expect(learned[0]![0]).toBe(learned[1]![0]);
    const [id, raw] = learned[0]!;
    const coverage = approvedCoverage(parseEntry(raw), raw, machines[0]!.setting(project, noteKey(id)), original);
    expect(coverage.sources).toEqual([{ id: sourceId, hash: sourceDigest(quote + " Keep the report with the release."),
      link: `https://github.com/example/memory/blob/${head}/${path}#development` }]);
    const recount = machines[0]!.db.prepare("SELECT * FROM jobs WHERE kind='file-index'").get() as unknown as JobRow;
    expect(JSON.parse(recount.params)).toEqual({ checkout: machines[0]!.checkout(repo)!.path, full: true });
    await runOneBatch(machines[0]!, ownerId("foreground"), only(recount));
    const index = openIndex({ recordDirectory: machines[0]!.location.directory, projectId: project, checkout: repo });
    try { expect(index?.patternCounts("fixture.js", [pattern.id])).toEqual({ [pattern.id]: 1 }); }
    finally { index?.close(); }
    expect(git("status", "--porcelain")).toBe("");

    const entry = parseEntry(raw);
    const { quote: _personalQuote, ...sharedSource } = entry.mex.source;
    mkdirSync(join(repo, ".mex", "learned"), { recursive: true });
    writeFileSync(join(repo, ".mex", "learned", `${id}.md`), serializeEntry({ ...entry, mex: { ...entry.mex, source: sharedSource } }));
    writeFileSync(join(repo, ".mex", "sources.json"), JSON.stringify({ version: 1, rule_files: [], learn_deeper: [coverage] }));
    git("add", "-f", ".mex");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "Publish the reviewed rule");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const plan = prepareShare({ projectPath: repo, home: machines[1]!.location.home });
    expect(plan.share).toEqual([]);
    expect(plan.skipped).toContainEqual({ id, reason: "already shared on origin/main" });
    expect(git("ls-tree", "-r", "--name-only", "HEAD", "--", ".mex/learned").split("\n")).toHaveLength(1);
  } finally { machines.forEach(writer => writer.close()); }
}, 75_000);

it("uses shared full receipts before triage and respects a deleted legacy rule", async () => {
  const now = Date.now() + 2_000, old = git("rev-parse", "HEAD");
  const legacy = parseEntry(serializeEntry({ mex: { id: "mx_legacy001", kind: "rule", scope: ["**"], source: { type: "docs", ref: path },
    evidence: "docs", one_line: claim, checks: [], status: "active", created: new Date(now).toISOString().slice(0, 10) }, text: claim }));
  const relative = `.mex/learned/${legacy.mex.id}.md`;
  mkdirSync(join(repo, ".mex", "learned"), { recursive: true });
  writeFileSync(join(repo, relative), serializeEntry(legacy));
  git("add", "-f", relative);
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Publish an old team rule");
  git("rm", relative);
  const shared = doc(quote + " Save the report with the build.");
  const fresh = doc();
  const other = "ARCHITECTURE.md", otherId = "doc:ARCHITECTURE.md#development";
  writeFileSync(join(repo, path), shared);
  writeFileSync(join(repo, other), fresh);
  const docHead = commit("Remove the old rule and amend the guides");
  const coverage = (file: string, body: string, extent: "full" | "partial"): SourceRef =>
    ({ id: `doc:${file}`, hash: sourceDigest(body), link: `https://github.com/example/memory/blob/${docHead}/${file}`, coverage: extent });
  const full = coverage(path, shared, "full"), partial = coverage(other, fresh, "partial");
  mkdirSync(join(repo, ".mex"), { recursive: true });
  writeFileSync(join(repo, ".mex", "sources.json"), JSON.stringify({ version: 1, rule_files: [], learn_deeper: [
    { id: "mx_sharereceipt", claim: claimHash("A different shared claim."), sources: [full, partial] },
  ] }));
  git("add", "-f", ".mex/sources.json");
  const head = commit("Record the team reads");
  const team = await readTeamCoverage(repo, head, new Date(now - DAY_MS).toISOString());
  expect(team.retired.has(claimHash(legacy.text))).toBe(true);
  expect(team.read.has(coverageKey(full))).toBe(true);
  expect(team.read.has(coverageKey(partial))).toBe(true);
  expect(team.read.has(coverageKey({ ...partial, coverage: "full" }))).toBe(false);
  const fetch = mockGithub({ head: () => head });
  const model = vi.fn<typeof runModel>(async request => {
    expect(request.prompt).not.toContain(sourceId);
    if (request.purpose !== MEANING_PURPOSE) expect(request.prompt).toContain(otherId);
    return docReply(request, otherId);
  });
  registerJobKind(createLearnKind({ client: async () => new ForgeClient(original, "forge-fixture-token", fetch), model, now: () => now }, true));
  const writer = openWeekly();
  try {
    const project = writer.checkout(repo)!.project_id;
    await buildIndex({ root: repo, projectId: project, recordDirectory: writer.location.directory, workers: 0 });
    const [seeded] = await propose([{ producer: "learn-deeper", key: "local-copy",
      kind: "rule", text: claim, oneLine: claim, source: { type: "docs", ref: path, quote, text: quote }, evidenceClass: "docs",
      anchors: { scope: [path] }, checks: [{ kind: "scope", role: "complete", target: { glob: path } }], model: { id: "fixture", version: "fixture-1" } }],
    { home: writer.location.home, projectPath: repo });
    expect(seeded).toMatchObject({ status: "accepted" });
    if (seeded?.status !== "accepted") throw Error("Could not seed the local copy");
    writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, noteKey(seeded.entryId), "{}");
    const job = due(writer, old, now);
    const done = await advance(writer, job);
    expect(done, String(done.reason)).toMatchObject({ state: "done", results: 0 });
    // The comparison confirms the retired rule before the writer is paid.
    expect(model.mock.calls.map(([request]) => request.purpose)).toEqual(["learn-deeper-filter", MEANING_PURPOSE]);
    expect(notes(writer, job).map(entry => entry.mex.status)).toEqual(["retired"]);
    expect(writer.setting(project, noteKey(seeded.entryId))).toBeUndefined();
    expect(state(done).v2.counts).toMatchObject({ "covered-sources": 1, "cluster.forgotten": 1 });
  } finally { writer.close(); }
}, 75_000);

it("waits for an active agent and requires a forge login before any weekly fetch", async () => {
  let now = Date.now();
  const fetch = vi.fn(async () => { throw new Error("Unexpected anonymous fetch"); });
  const model = vi.fn<typeof runModel>();
  registerJobKind(createLearnKind({ client: async () => new ForgeClient(original, undefined, fetch), model, now: () => now }, true));
  const writer = openWeekly();
  try {
    const project = writer.checkout(repo)!.project_id;
    const job = due(writer, git("rev-parse", "HEAD"), now);
    hook("SessionStart", "active-session", { source: "startup" });
    expect(await advance(writer, job)).toMatchObject({ state: "waiting", reason: "Waiting for agent sessions to go idle" });
    expect(requeueReadyJobs(writer)).toBe(0);
    now += 10 * 60_000 + 1000;
    expect(requeueReadyJobs(writer)).toBe(1);
    expect(await advance(writer, job)).toMatchObject({ state: "done with gaps", results: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
    expect(JSON.parse(weeklySchedule(writer, project)!).due).toBe(now + DAY_MS);
  } finally { writer.close(); }
});

it("finishes a published writer batch after its runner dies without another model call", async () => {
  await accept();
  const model = fixtureModel(), kind = createLearnKind({ model });
  registerJobKind(kind);
  let writer = openRecord();
  try {
    const job = jobRow(writer);
    const writing = await advance(writer, job, row => row.state !== "queued" || state(row).v2?.phase === "write");
    expect(writing.state).toBe("queued");
    const dead = ownerId("background", 989898);
    writer.db.prepare("UPDATE jobs SET state='running',owner=? WHERE id=?").run(dead, job.id);
    const claimed = jobRow(writer);
    const scratch = join(writer.location.home, "learn-checks", job.id, "batch-ABC123");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, "abandoned.txt"), "abandoned fixture");
    await kind.runBatch({ writer, job: claimed, params: JSON.parse(job.params), checkpoint: state(claimed) });
    expect(existsSync(scratch)).toBe(false);
    expect(jobRow(writer)).toMatchObject({ state: "running", batch: writing.batch, results: 0 });
    expect(notes(writer, job)).toHaveLength(1);
    writer.close();
    writer = openRecord();
    expect(recoverInterruptedJobs(writer, ownerId("background"), () => false)).toBe(1);
    expect(jobRow(writer).progress).toBe("Finishing the saved batch after interruption");
    expect(await advance(writer, job)).toMatchObject({ state: "done", results: 1 });
    expect(model).toHaveBeenCalledTimes(3);
    expect(reviewRows(writer, job.project_id!, job.id)).toHaveLength(1);
    expect(notes(writer, job)).toHaveLength(1);
    expect(rawRows(writer, job)).toEqual([]);
  } finally { writer.close(); }
}, 75_000);

it.each(["harvest", "triage", "cluster", "write", "finish"])("resumes after the %s runner dies before committing its checkpoint", async phase => {
  await accept();
  const model = fixtureModel(), kind = createLearnKind({ model });
  registerJobKind(kind);
  const writer = openRecord();
  try {
    const job = jobRow(writer);
    const at = await advance(writer, job, row => row.state !== "queued" || (state(row).v2?.phase ?? "harvest") === phase);
    expect(at.state).toBe("queued");
    writer.db.prepare("UPDATE jobs SET state='running',owner=? WHERE id=?").run(ownerId("background", 989898), job.id);
    const claimed = jobRow(writer);
    await kind.runBatch({ writer, job: claimed, params: JSON.parse(job.params), checkpoint: state(claimed) });
    expect(jobRow(writer).batch).toBe(at.batch);
    expect(recoverInterruptedJobs(writer, ownerId("background"), () => false)).toBe(1);
    const done = await advance(writer, job);
    expect(done, String(done.reason)).toMatchObject({ state: "done", results: 1 });
    expect(model.mock.calls.map(([request]) => request.purpose)).toEqual(["learn-deeper-filter", LEARN_KIND, MEANING_PURPOSE]);
    expect(state(done).v2.counts).toMatchObject({ "harvested.doc": 1, "triage-kept": 1, saved: 1 });
    expect(rawRows(writer, job)).toEqual([]);
  } finally { writer.close(); }
}, 60_000);

it.each(["cancelled", "failed"])("clears source text and model replies when the run is %s", async terminal => {
  await accept();
  const model = vi.fn<typeof runModel>(async request => {
    if (request.purpose === LEARN_KIND) throw new Error("Fixture writer stopped");
    return docReply(request);
  });
  registerJobKind(createLearnKind({ model }));
  const writer = openRecord();
  try {
    const job = jobRow(writer);
    const at = await advance(writer, job, row => row.state !== "queued" || state(row).v2?.phase === "write");
    expect(at.state).toBe("queued");
    expect(JSON.stringify(rawRows(writer, job))).toContain(quote);
    if (terminal === "cancelled") requestJob(writer, job.id, "cancel");
    else await advance(writer, job);
    expect(jobRow(writer).state).toBe(terminal);
    expect(rawRows(writer, job)).toEqual([]);
    expect(writer.setting(job.project_id!, CURSOR_KEY)).toBeUndefined();
    expect(notes(writer, job)).toEqual([]);
  } finally { writer.close(); }
}, 60_000);

it("does not publish or save a model reply after it loses the job owner", async () => {
  await accept();
  const writer = openRecord();
  try {
    const job = jobRow(writer);
    const model = vi.fn<typeof runModel>(async request => {
      if (request.purpose === LEARN_KIND) writer.db.prepare("UPDATE jobs SET owner=? WHERE id=?").run(ownerId("background", 989898), job.id);
      return docReply(request);
    });
    registerJobKind(createLearnKind({ model }));
    await advance(writer, job);
    expect(model).toHaveBeenCalledTimes(2);
    expect(notes(writer, job)).toEqual([]);
    expect(rawRows(writer, job).map(row => row.key)).not.toContain(`learning.deep.v2.${job.id}.reply.batch.0.write`);
    expect(reviewRows(writer, job.project_id!, job.id)).toEqual([]);
    expect(writer.db.prepare("SELECT key FROM settings WHERE key LIKE 'knowledge.gate.%'").all()).toEqual([]);
  } finally { writer.close(); }
}, 60_000);

it.each([false, true])("proves a repair only when the ceiling allows it (cap=%s)", async capped => {
  await accept();
  const writer = openRecord();
  try {
    const job = jobRow(writer);
    const model = vi.fn<typeof runModel>(async request => {
      if (request.prompt.includes("failed verification")) {
        expect(request.prompt).toContain("quote(s) not found in the cited evidence");
        return docReply(request);
      }
      if (request.purpose === LEARN_KIND) {
        if (capped) {
          const plan = Plan.parse(JSON.parse(job.params));
          const reserved = { ...ZERO, input: plan.ceiling - 1 };
          const spend = enqueueModelBatch(writer, { agent: "codex", model: "gpt-6.1-sol", projectPath: repo,
            consented: { estimate: reserved, ceiling: plan.ceiling }, job: { jobId: job.id, batch: jobRow(writer).batch,
              projectId: job.project_id, recordHome: writer.location.home } });
          expect(claimModelBatch(writer, spend)).toBeUndefined();
          recoverModelBatches(writer, Date.now(), () => false);
        }
        return docReply(request, sourceId, claim, "This sentence is absent from the guide.");
      }
      return docReply(request);
    });
    registerJobKind(createLearnKind({ model }));
    const done = await advance(writer, job);
    expect(done.state, JSON.stringify(state(done).gaps)).toBe(capped ? "done with gaps" : "done");
    expect(done.results).toBe(capped ? 0 : 1);
    expect(model).toHaveBeenCalledTimes(capped ? 2 : 4);
    if (capped) expect(state(done).gaps.join(" ")).toContain("allowance could not cover a repair");
    else expect(notes(writer, job)[0]?.mex.source.quote).toBe(quote);
  } finally { writer.close(); }
}, 60_000);

it("keeps past-session learning disabled without fetching or queuing a job", async () => {
  const fetch = mockGithub(), lines: string[] = [];
  vi.stubGlobal("fetch", fetch);
  const registered = await runRepoStart({ cwd: repo, write: () => {}, caller: "script", install: false, wait: false });
  const active = openWeekly();
  active.close();
  await offerLearning({ root: repo, projectId: registered.projectId!, write: line => lines.push(line), interactive: true, explicit: true, sessions: true, confirm: async () => false });
  expect(lines.join("\n")).toMatch(/past.session learning.*available/iu);
  expect(fetch).not.toHaveBeenCalled();
  const writer = openRecord();
  try { expect(jobRow(writer)).toBeUndefined(); }
  finally { writer.close(); }
});


it.each(["prove", "repair"] as const)("reuses paid replies if interrupted during %s", async phase => {
  await accept();
  const proves = vi.spyOn(proofEngine, "proveEntry");
  const gate = vi.spyOn(gateEngine, "propose");
  const model = vi.fn<typeof runModel>(async request => request.purpose === LEARN_KIND && phase === "repair" && !request.prompt.includes("failed verification")
    ? docReply(request, sourceId, claim, "A sentence the guide never says.")
    : docReply(request));
  const kind = createLearnKind({ model });
  registerJobKind(kind);
  const writer = openRecord();
  try {
    const job = jobRow(writer);
    const at = await advance(writer, job, row => row.state !== "queued" || state(row).v2?.phase === "write");
    expect(at.state).toBe("queued");
    if (phase === "prove") proves.mockRejectedValueOnce(new Error("Fixture interruption after the writer reply"));
    else gate.mockRejectedValueOnce(new Error("Fixture interruption after the repair reply"));
    writer.db.prepare("UPDATE jobs SET state='running',owner=? WHERE id=?").run(ownerId("background", 989898), job.id);
    const claimed = jobRow(writer);
    await expect(kind.runBatch({ writer, job: claimed, params: JSON.parse(job.params), checkpoint: state(claimed) }))
      .rejects.toThrow("Fixture interruption");
    expect(recoverInterruptedJobs(writer, ownerId("background"), () => false)).toBe(1);
    expect(await advance(writer, job)).toMatchObject({ state: "done", results: 1 });
    expect(model).toHaveBeenCalledTimes(phase === "prove" ? 3 : 4);
    expect(rawRows(writer, job)).toEqual([]);
  } finally { writer.close(); }
}, 60_000);

it("withholds private and historical docs and applies pinned duplicate checks", async () => {
  const duplicate = "Keep the release verification report beside the renderer snapshots.";
  const filler = Array.from({ length: 1600 }, (_, i) => `- Fixture guidance line ${i} keeps this rule file above the old staging bound.`).join("\n");
  writeFileSync(join(repo, "AGENTS.md"), `# Development\n\n${filler}\n- ${duplicate}\n`);
  expect(Buffer.byteLength(readFileSync(join(repo, "AGENTS.md")))).toBeGreaterThan(112 << 10);
  mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(join(repo, ".claude", "rules", "large.md"), "# Large\n" + "x".repeat(1 << 20) + "\n");
  mkdirSync(join(repo, "docs"));
  // A contributor guide (only those are read under docs/) that marks itself historical.
  writeFileSync(join(repo, "docs", "historical.md"), "# Historical development guide\n\nThis document is historical.\n\nNEVER_USE_OLD_RENDERER.\n");
  writeFileSync(join(repo, "docs", "private.md"), "# Development\n\n<private>WITHHOLD_THIS_TEXT</private>\n");
  writeFileSync(join(repo, path), doc(quote + "\n" + duplicate));
  commit("Pin the rules and contributor guides");
  await accept();
  const model = vi.fn<typeof runModel>(async request => {
    expect(request.prompt).not.toMatch(/WITHHOLD_THIS_TEXT|NEVER_USE_OLD_RENDERER/u);
    return docReply(request, sourceId, duplicate, duplicate);
  });
  registerJobKind(createLearnKind({ model }));
  const writer = openRecord();
  try {
    const job = jobRow(writer), done = await advance(writer, job);
    expect(done, String(done.reason)).toMatchObject({ state: "done with gaps", results: 0 });
    expect(model).toHaveBeenCalledTimes(3);
    expect(state(done).v2.counts).toMatchObject({ "historical-docs": 1, "gate-dropped.duplicate-rule-line": 1 });
    expect(state(done).gaps).toContain("Some rule files could not be read for duplicate checks.");
    expect(rawRows(writer, job)).toEqual([]);
    expect(notes(writer, job)).toEqual([]);
  } finally { writer.close(); }
}, 60_000);


it("keeps weekly repair inside automatic admission and preserves the schedule when refused", async () => {
  const now = Date.now() + 2_000, head = git("rev-parse", "HEAD");
  const fetch = mockGithub({ head: () => head });
  const model = vi.fn<typeof runModel>(async request => {
    expect(request.automatic?.measuredUsageOnly).toBe(true);
    expect(request.consented).toBeUndefined();
    if (request.prompt.includes("failed verification")) throw new ModelWaitError("cap");
    return docReply(request, sourceId, claim, "This quote is absent.");
  });
  registerJobKind(createLearnKind({ client: async () => new ForgeClient(original, "forge-fixture-token", fetch), model, now: () => now,
    next: at => at + 7 * DAY_MS }, true));
  const writer = openWeekly();
  try {
    const job = due(writer, head, now);
    const done = await advance(writer, job);
    expect(done, String(done.reason)).toMatchObject({ state: "done with gaps", results: 0 });
    expect(model).toHaveBeenCalledTimes(3);
    expect(state(done).gaps.join(" ")).toContain("allowance could not cover a repair");
    expect(JSON.parse(weeklySchedule(writer, job.project_id!)!).due).toBe(now + 7 * DAY_MS);
    expect(notes(writer, job)).toEqual([]);
  } finally { writer.close(); }
}, 60_000);

it.each(["allowance", "unreadable"] as const)("keeps a verbatim quote unbacked when the weekly judgment is %s", async failure => {
  const now = Date.now() + 2_000, head = git("rev-parse", "HEAD");
  const fetch = mockGithub({ head: () => head });
  const model = vi.fn<typeof runModel>(async request => {
    if (request.purpose !== MEANING_PURPOSE) return docReply(request);
    expect(request).toMatchObject({ setup: "mixed", role: "cheap", automatic: { measuredUsageOnly: true } });
    expect(request.consented).toBeUndefined();
    if (failure === "allowance") throw new ModelWaitError("cap");
    return reply({ results: [] });
  });
  registerJobKind(createLearnKind({ client: async () => new ForgeClient(original, "forge-fixture-token", fetch), model, now: () => now }, true));
  const writer = openWeekly();
  try {
    const job = due(writer, head, now);
    const done = await advance(writer, job);
    expect(done).toMatchObject({ state: "done with gaps", results: 0 });
    expect(model.mock.calls.map(([request]) => request.purpose)).toEqual(["learn-deeper-filter", LEARN_KIND, MEANING_PURPOSE]);
    expect(state(done).gaps).toContain("A lesson evidence batch could not be judged.");
    expect(notes(writer, job)).toEqual([]);
  } finally { writer.close(); }
}, 60_000);
