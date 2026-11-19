import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as cliTools from "../../cli-tools.js";
import { literalPattern } from "../../file-index/classify.js";
import { openIndex } from "../../file-index/read.js";
import { indexDirectory, writePatterns } from "../../file-index/store.js";
import { parseEntry, serializeEntry } from "../../knowledge/entry.js";
import { snapshotNotes } from "../../knowledge/personal-store.js";
import { prepareShare } from "../../knowledge/share-plan.js";
import { writeSharedKnowledgeFiles } from "../../knowledge/share.js";
import { claimHash } from "../../knowledge/state.js";
import { runModel } from "../../model-runner/index.js";
import { CEILING_WAIT, recordedModelSpend } from "../../model-runner/consent.js";
import { claimModelBatch, enqueueModelBatch, recoverModelBatches, withModelJob } from "../../model-runner/budget-queue.js";
import { ModelRunError } from "../../model-runner/errors.js";
import { queueJob } from "../../record/background.js";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { enqueueJob, listJobs, ownerId, recoverInterruptedJobs, registerJobKind, requeueReadyJobs, runOneBatch, type JobRow } from "../../record/jobs.js";
import { ZERO } from "../../record/usage.js";
import { runRepoStart } from "../../repo-start/command.js";
import { approvedCoverage, coverageKey, noteKey, parseManifest, readTeamCoverage, sourceRead, type SourceRef } from "../coverage.js";
import { ForgeClient } from "../forge.js";
import { createLearnKind } from "../job.js";
import { offerLearning } from "../offer.js";
import { LEARN_KIND, Plan } from "../plan.js";
import { sourceDigest } from "../source.js";
import { DAY_MS, nextWeeklyAt, queueDueWeekly, saveWeeklySchedule, WEEKLY_KIND, weeklySchedule, weeklyWakeDue } from "../weekly-schedule.js";

let suite: string, binary: string, fixture: string, repo: string;
const quote = "The verify script detects when generated snapshots change.";
const review = "Always verify generated snapshots before changing the renderer.";
const goTest = "go test ./...";
const answer = {
  kind: "recipe", scope: ["**"], text: "The verification script detects changed snapshots before release.",
  one_line: "Verify generated snapshots before release.", evidence: [{ id: "doc:README.md", quote }],
  checks: [{ kind: "command", role: "complete", target: { file: "package.json", pointer: "/scripts/verify", run: "npm run verify" } }],
};
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

beforeAll(() => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), "mex-learn-vertical-")));
  binary = join(suite, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));
beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(suite, "case-")));
  repo = join(fixture, "repo"); mkdirSync(repo);
  git("init", "-qb", "main");
  git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("remote", "add", "origin", "https://github.com/example/memory.git");
  writeFileSync(join(repo, "README.md"), `# Verification\n${quote}\n`);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", scripts: { verify: "node verify.js" } }));
  git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  vi.stubEnv("MEX_HOME", fixture);
  vi.stubEnv("MEX_BACKGROUND", "0");
  vi.stubEnv("MEX_OFFLINE", "1");
  vi.stubEnv("MEX_HOOK_BINARY", binary);
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(fixture, "claude"));
  vi.stubEnv("CODEX_HOME", join(fixture, "codex"));
  vi.stubEnv("GH_TOKEN", "forge-fixture-token");
  vi.spyOn(cliTools, "isCliAvailable").mockImplementation(name => name === "codex");
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  registerJobKind(createLearnKind());
  rmSync(fixture, { recursive: true, force: true });
});

function mockGithub() {
  const at = new Date(Date.now() - 86_400_000).toISOString();
  return vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.github.com");
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer forge-fixture-token");
    if (url.pathname === "/repos/example/memory") return Response.json({ full_name: "example/memory", private: true });
    if (url.pathname === "/repos/example/memory/issues") return Response.json([]);
    if (url.pathname === "/graphql") {
      const { query } = JSON.parse(String(options?.body));
      if (query.includes("LearningInventory")) return Response.json({ data: Object.fromEntries(Array.from({ length: 6 }, (_, i) =>
        [`b${i}`, { issueCount: i === 0 ? 2 : 0, nodes: i === 0 ? [{ number: 1, mergedAt: at }, { number: 2, mergedAt: at }] : [] }])) });
      const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false } });
      const pr = (id: number) => ({ number: id, mergedAt: at, comments: page([]), reviewThreads: page([]), reviews: page([
        { fullDatabaseId: id, body: `${review} Run ${goTest} to exercise the user flow. Thanks, Test User (@testuser).`,
          submittedAt: at, author: { login: "testuser", name: "Test User", __typename: "User" }, authorCanPushToRepository: true },
        { fullDatabaseId: id + 10, body: "password=fixtureSecret123 before running this", submittedAt: at,
          author: { login: "testuser", name: "Test User", __typename: "User" }, authorCanPushToRepository: true },
      ]) });
      return Response.json({ data: { repository: { p0: pr(1), p1: pr(2) } } });
    }
    throw new Error(`Unexpected fixture request ${url.pathname}`);
  });
}

it("quotes first, uses one logged model batch, and delivers a private rule through the real session hook", async () => {
  const tech = "The Test User fixture uses @types/node, @scope/pkg, @Override, and @media.";
  writeFileSync(join(repo, "README.md"), `# Verification\n${quote}\n${tech}\nContact @testuser or fixture@example.invalid.\n`);
  git("add", "README.md"); git("-c", "commit.gpgsign=false", "commit", "-qm", "Add technical terms and identities to docs");
  const fetch = mockGithub(); vi.stubGlobal("fetch", fetch);
  const screen: string[] = [];
  const confirm = vi.fn(async (lines: readonly string[]) => {
    expect(lines.join("\n")).toMatch(/ceiling .*tokens/u);
    expect(lines.join("\n")).toContain("private repo");
    expect(screen.join("\n")).toContain("$0");
    return true;
  });
  const start = await runRepoStart({ cwd: repo, write: line => screen.push(line), caller: "person", ask: confirm, install: false, wait: false });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls).toHaveLength(2);
  const writer = openRecord();
  try {
    const job = writer.db.prepare("SELECT * FROM jobs WHERE kind=?").get(LEARN_KIND) as unknown as JobRow;
    expect(job.project_id).toBe(start.projectId);
    const plan = Plan.parse(JSON.parse(job.params));
    expect(plan.ceiling).toBe(Math.floor(plan.estimate * 1.5));
    const model = vi.fn<typeof runModel>(async request => {
      expect(request.prompt).toContain(`${review} Run ${goTest} to exercise the user flow. Thanks, [reviewer] ([reviewer]).`);
      expect(request.prompt).toContain(`${tech}\\nContact [reviewer] or [reviewer].`);
      for (const privateText of ["@testuser", "fixture@example.invalid", "fixtureSecret123", "forge-fixture-token"]) expect(request.prompt).not.toContain(privateText);
      const proposal = { ...answer, evidence: [...answer.evidence, { id: "github:pullrequestreview-:1", quote: goTest }] };
      return runModel({ ...request, __internal: { spawn: (_file, _args, options) => {
        expect(options.env?.GH_TOKEN).toBeUndefined();
        return spawn(process.execPath, ["-e", `process.stdin.resume(); process.stdin.on('end', () => {
          console.log(JSON.stringify({type: 'thread.started', thread_id: 'fixture'}));
          console.log(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: process.argv[1]}}));
          console.log(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 1000, cached_input_tokens: 100, output_tokens: 200}}));
        });`, JSON.stringify({ entries: [proposal] })], options);
      } } });
    });
    registerJobKind(createLearnKind({ model }));
    expect(await runOneBatch(writer, ownerId("foreground"), { only: new Set([job.id]) })).toBe("ran");
    expect(model).toHaveBeenCalledTimes(1);
    const completed = writer.db.prepare("SELECT state,reason,results,tokens_used FROM jobs WHERE id=?").get(job.id);
    expect(completed, String(completed?.reason ?? "")).toMatchObject({ state: "done with gaps", results: 1, tokens_used: 1200 });
    expect(writer.db.prepare("SELECT count(*) n FROM model_batches WHERE job_id=? AND state='done'").get(job.id)?.n).toBe(1);
    const schedule = JSON.parse(weeklySchedule(writer, start.projectId!)!);
    expect(schedule.due).toBeGreaterThanOrEqual(Date.parse(plan.until) + 7 * DAY_MS);
    expect(weeklyWakeDue(writer.location.home)).toBe(false);
    expect(weeklyWakeDue(writer.location.home, schedule.due + 10)).toBe(true);
    const notes = [...snapshotNotes(writer, start.projectId!).files.values()];
    expect(notes).toHaveLength(1);
    expect(parseEntry(notes[0]!).mex.source).toEqual({ type: "docs", ref: "README.md" });
    expect(notes[0]).not.toContain(quote);
    const receipt = writer.db.prepare("SELECT value FROM settings WHERE key LIKE 'learning.deep.batch.%'").get()?.value;
    expect(String(receipt)).not.toContain(review);
    expect(JSON.parse(String(receipt)).sources).toHaveLength(3);
    expect(readdirSync(join(writer.location.home, "learn-checks"))).toEqual([]);
    const hook = execFileSync(binary, ["codex", "SessionStart"], {
      cwd: repo, encoding: "utf8", input: JSON.stringify({ cwd: repo, source: "startup", hook_event_name: "SessionStart", session_id: "new-session" }),
      env: { ...process.env, MEX_BACKGROUND: "0" },
    });
    expect(hook).toContain("[learned, not shared] Verify generated snapshots before release.");
    expect(existsSync(join(repo, ".mex", "learned"))).toBe(false);
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe("");
  } finally { writer.close(); }
}, 25_000);

it("a script gets the command without fetching or queuing a paid job", async () => {
  const fetch = mockGithub(); vi.stubGlobal("fetch", fetch);
  const lines: string[] = [], ask = vi.fn(async () => true);
  await runRepoStart({ cwd: repo, write: line => lines.push(line), caller: "script", ask, install: false, wait: false });
  expect(lines.join("\n")).toContain("run `mex learn` in a terminal");
  expect(ask).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  const writer = openRecord();
  try { expect(writer.db.prepare("SELECT 1 FROM jobs WHERE kind=?").get(LEARN_KIND)).toBeUndefined(); }
  finally { writer.close(); }
});

function jobRow(writer: RecordWriter): JobRow {
  return writer.db.prepare("SELECT * FROM jobs WHERE kind=?").get(LEARN_KIND) as unknown as JobRow;
}
function reply(value: object) {
  return { text: JSON.stringify(value), selectedModel: "fixture", usage: { ...ZERO, model: "fixture", estimated: false } };
}
async function accept(ask = vi.fn(async () => true)) {
  vi.stubGlobal("fetch", mockGithub());
  const lines: string[] = [];
  const result = await runRepoStart({ cwd: repo, write: line => lines.push(line), caller: "person", ask, install: false, wait: false });
  return { result, lines, ask };
}
const only = (job: JobRow) => ({ only: new Set([job.id]) });

it("reports a long doc as partial in the batch, note proof, and written source manifest", async () => {
  const end = "This is beyond the excerpt.";
  const raw = `# Verification\n${quote}\n\n${"Verification details. ".repeat(210)}\n${end}\n`;
  writeFileSync(join(repo, "README.md"), raw);
  git("add", "README.md"); git("-c", "commit.gpgsign=false", "commit", "-qm", "Add a long doc");
  const { result } = await accept();
  const model = vi.fn<typeof runModel>(async request => {
    expect(request.prompt).toContain(`"coverage":"partial","text":"# Verification\\n${quote}`);
    expect(request.prompt).not.toContain(end);
    return reply({ entries: [answer] });
  });
  registerJobKind(createLearnKind({ model }));
  const writer = openRecord();
  try {
    const job = jobRow(writer), project = result.projectId!;
    const plan = Plan.parse(JSON.parse(job.params));
    await runOneBatch(writer, ownerId("foreground"), only(job));
    expect(model).toHaveBeenCalledTimes(1);
    expect(jobRow(writer)).toMatchObject({ state: "done with gaps", results: 1 });
    const jobs = listJobs({ all: (sql, ...args) => writer.db.prepare(sql).all(...args) as never });
    expect(jobs.find(item => item.id === job.id)?.summary).toContain("Some long docs were only partly read.");
    const partial = { id: "doc:README.md", hash: sourceDigest(raw), link: `https://github.com/example/memory/blob/${plan.head}/README.md`, coverage: "partial" } as const;
    const receipt = JSON.parse(writer.setting(project, `learning.deep.batch.${job.id}.0`)!);
    expect(receipt.sources).toContainEqual(partial);
    expect(sourceRead(writer, project, plan, partial)).toBe(true);
    expect(sourceRead(writer, project, plan, { ...partial, coverage: "full" })).toBe(false);

    const [note] = snapshotNotes(writer, project).files.values();
    const entry = parseEntry(note!);
    const coverage = approvedCoverage(entry, note!, writer.setting(project, noteKey(entry.mex.id)), plan.origin);
    expect(coverage.sources).toEqual([partial]);
    mkdirSync(join(repo, ".mex"), { recursive: true });
    writeSharedKnowledgeFiles({ projectPath: repo, home: fixture }, [coverage]);
    const manifest = parseManifest(readFileSync(join(repo, ".mex", "sources.json"), "utf8"));
    expect(manifest?.learn_deeper?.[0]?.sources).toEqual([partial]);
  } finally { writer.close(); }
}, 25_000);

const typed = "Always verify snapshots before a release to catch generated changes.";
function history(agent: "claude" | "codex", id: string, rows: object[]) {
  const path = agent === "claude" ? join(fixture, "claude", "projects", repo.replace(/[^a-z0-9]/giu, "-"), `${id}.jsonl`)
    : join(fixture, "codex", "sessions", "2026", "11", "19", `rollout-2026-11-19T08-00-00-${id}.jsonl`);
  const time = new Date(Date.now() - 2 * 60 * 60_000);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map(row => JSON.stringify({ timestamp: time.toISOString(), ...row })).join("\n") + "\n");
  utimesSync(path, time, time);
  return path;
}

const claudeId = "11111111-1111-4111-8111-111111111111";
const codexId = "22222222-2222-4222-8222-222222222222";
const claudeTurn = (cwd: string, content: string, more = {}) => ({ type: "user", cwd, sessionId: claudeId, message: { role: "user", content }, ...more });
const codexMeta = (cwd: string) => ({ type: "session_meta", payload: { id: codexId, cwd, source: "cli" } });
const codexTurn = (message: unknown) => ({ type: "event_msg", payload: { type: "user_message", message } });

it("previews eligible past sessions, skips drift and non-user rows, and delivers the consented note", async () => {
  history("claude", claudeId, [claudeTurn(repo, typed), claudeTurn(repo, "PRIVATE_META", { isMeta: true }),
    claudeTurn(repo, "Credential password=fixtureSecret123"), claudeTurn(repo, "Ask private@example.invalid about secrets"),
    claudeTurn(fixture, "OUTSIDE_REPO_DATA"), claudeTurn(repo, "PRIVATE_ASSISTANT_DATA", { type: "assistant" })]);
  history("codex", codexId, [codexMeta(repo), codexTurn({ new_shape: "UNKNOWN_CODEX_DATA" })]);
  const { result, ask } = await accept(vi.fn(async (lines: readonly string[]) => {
    expect(lines.join("\n")).toContain("1 past session and 1 eligible prompt");
    expect(lines.join("\n")).toContain("Codex capture paused");
    expect(lines.join("\n")).not.toContain(typed);
    return true;
  }));
  const remote = vi.fn(async () => { throw new Error("Dry run attempted network"); });
  vi.stubGlobal("fetch", remote);
  const preview: string[] = [];
  await offerLearning({ root: repo, projectId: result.projectId!, interactive: false, dryRun: true, write: line => preview.push(line) });
  expect(preview.join("\n")).toContain("1 past session");
  expect(preview.join("\n")).toContain("capture paused");
  expect(remote).not.toHaveBeenCalled();
  expect(ask).toHaveBeenCalledTimes(1);
  vi.stubGlobal("fetch", mockGithub());
  const model = vi.fn<typeof runModel>(async request => {
    if (!request.prompt.includes(typed)) return reply({ entries: [] });
    for (const withheld of ["PRIVATE_META", "PRIVATE_ASSISTANT_DATA", "OUTSIDE_REPO_DATA", "UNKNOWN_CODEX_DATA", "fixtureSecret123", "private@example.invalid"])
      expect(request.prompt).not.toContain(withheld);
    const id = /"id":"(session:[^"]+)"/u.exec(request.prompt)?.[1];
    expect(id).toBeDefined();
    return reply({ entries: [{ ...answer, lasting: true, evidence: [{ id, quote: typed }] }] });
  });
  registerJobKind(createLearnKind({ model }));
  const writer = openRecord();
  try {
    const job = jobRow(writer);
    expect(job.params).not.toContain(typed);
    expect(Plan.parse(JSON.parse(job.params)).sessions).toHaveLength(1);
    await runOneBatch(writer, ownerId("foreground"), only(job));
    await runOneBatch(writer, ownerId("foreground"), only(job));
    expect(model).toHaveBeenCalledTimes(2);
    expect(jobRow(writer)).toMatchObject({ state: "done with gaps", results: 1 });
    const [note] = [...snapshotNotes(writer, result.projectId!).files.values()];
    expect(parseEntry(note!).mex.source).toMatchObject({ type: "person", quote: typed });
    const hook = execFileSync(binary, ["codex", "SessionStart"], {
      cwd: repo, encoding: "utf8", input: JSON.stringify({ cwd: repo, source: "startup", hook_event_name: "SessionStart", session_id: "real-hook" }),
      env: { ...process.env, MEX_BACKGROUND: "0" },
    });
    expect(hook).toContain("[learned, not shared] Verify generated snapshots before release.");
    const repeated: string[] = [];
    await offerLearning({ root: repo, projectId: result.projectId!, interactive: false, dryRun: true, write: line => repeated.push(line) });
    expect(repeated.join("\n")).toContain("0 past sessions");
  } finally { writer.close(); }
}, 25_000);

it("leaves changed sessions out of the approved batch and supports a reviews-only quote", async () => {
  history("codex", codexId, [codexMeta(repo), codexTurn(typed)]);
  const ask = vi.fn(async () => false);
  const { result } = await accept(ask);
  const lines: string[] = [];
  await offerLearning({ root: repo, projectId: result.projectId!, interactive: true, explicit: true, sessions: false, write: line => lines.push(line),
    confirm: async shown => { expect(shown.join("\n")).not.toContain("Past-session dry run"); return false; } });
  await accept();
  history("codex", codexId, [codexMeta(repo), codexTurn("REPLACED_AFTER_CONSENT")]);
  const model = vi.fn<typeof runModel>(async () => reply({ entries: [] }));
  registerJobKind(createLearnKind({ model }));
  const writer = openRecord();
  try {
    const job = jobRow(writer);
    await runOneBatch(writer, ownerId("foreground"), only(job));
    await runOneBatch(writer, ownerId("foreground"), only(job));
    expect(model).toHaveBeenCalledTimes(1);
    expect(jobRow(writer)).toMatchObject({ state: "done with gaps", results: 0 });
    expect(JSON.parse(jobRow(writer).checkpoint!).gaps.join(" ")).toContain("sessions changed");
  } finally { writer.close(); }
});

const original = { host: "github.com" as const, slug: "example/memory" };
const weeklyJob = (writer: RecordWriter) => writer.db.prepare("SELECT * FROM jobs WHERE kind=? ORDER BY rowid DESC LIMIT 1").get(WEEKLY_KIND) as unknown as JobRow;
function due(writer: RecordWriter, project: string, head: string, now: number) {
  saveWeeklySchedule(writer, project, { checkout: repo, origin: original, source: original, visibility: "private", agent: "codex", setup: "best-only",
    preferred: [], head, since: new Date(now - DAY_MS * 8).toISOString(), due: now });
  queueDueWeekly(writer, queueJob, now);
  return weeklyJob(writer);
}

function weeklyForge(head: () => string, seen?: string[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    seen?.push(path);
    if (path === "/repos/example/memory") return Response.json({ full_name: "example/memory", default_branch: "main", private: true });
    if (path.endsWith("/branches/main")) return Response.json({ commit: { sha: head() } });
    if (path === "/graphql") return Response.json({ data: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`b${i}`, { issueCount: 0, nodes: [] }])) });
    throw new Error(`Unexpected source fixture path ${path}`);
  });
}

it("two due machines can both fetch, converge on one rule ID, and offer only one team publication", async () => {
  const now = Date.now(), old = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "README.md"), `# New instructions\n${quote}\n`);
  writeFileSync(join(repo, "fixture.js"), "export const snapshots = [];\n");
  git("add", "README.md", "fixture.js"); git("-c", "commit.gpgsign=false", "commit", "-qm", "Update documentation");
  const head = git("rev-parse", "HEAD"), requests: string[] = [];
  const fetch = weeklyForge(() => head, requests);
  const model = vi.fn<typeof runModel>(async request => {
    expect(request.automatic?.measuredUsageOnly).toBe(true);
    expect(request.consented).toBeUndefined();
    expect(request.prompt).toContain(quote);
    return reply({ entries: [answer] });
  });
  registerJobKind(createLearnKind({ client: async () => new ForgeClient(original, "fixture-login", fetch), model, now: () => now,
    next: time => nextWeeklyAt(time, () => 0.5) }, true));
  const machines = [openRecord({ home: join(fixture, "machine-a"), projectPath: repo, isNetwork: () => false }),
    openRecord({ home: join(fixture, "machine-b"), projectPath: repo, isNetwork: () => false })];
  try {
    const project = machines[0]!.checkout(repo)!.project_id;
    const pattern = literalPattern("snapshots");
    writePatterns(indexDirectory(machines[0]!.location.directory, project), [pattern]);
    const jobs = machines.map(writer => due(writer, project, old, now));
    expect(jobs.every(job => job.state === "queued")).toBe(true);
    await Promise.all(machines.map(async (writer, i) => {
      const job = jobs[i]!;
      await runOneBatch(writer, ownerId("foreground"), only(job));
      await runOneBatch(writer, ownerId("foreground"), only(job));
      expect(weeklyJob(writer)).toMatchObject({ state: "done", results: 1 });
      expect(JSON.parse(weeklySchedule(writer, project)!).due).toBe(now + 10.5 * DAY_MS);
    }));
    expect(requests.filter(path => path === "/graphql")).toHaveLength(2);
    expect(model).toHaveBeenCalledTimes(2);
    const stable = machines.map(writer => [...snapshotNotes(writer, project).files]);
    expect(stable.map(entries => entries.length)).toEqual([1, 1]);
    expect(stable[0]![0]![0]).toBe(stable[1]![0]![0]);
    const [id, raw] = stable[0]![0]!;
    const coverage = approvedCoverage(parseEntry(raw), raw, machines[0]!.setting(project, noteKey(id)), original);
    expect(coverage.sources).toEqual([{ id: "doc:README.md", hash: sourceDigest(`# New instructions\n${quote}\n`), coverage: "full",
      link: `https://github.com/example/memory/blob/${head}/README.md` }]);
    const recount = machines[0]!.db.prepare("SELECT * FROM jobs WHERE kind='file-index'").get() as unknown as JobRow;
    expect(recount.params).toBe(JSON.stringify({ checkout: repo, full: true }));
    await runOneBatch(machines[0]!, ownerId("foreground"), only(recount));
    const index = openIndex({ recordDirectory: machines[0]!.location.directory, projectId: project, checkout: repo });
    try { expect(index?.patternCounts("fixture.js", [pattern.id])).toEqual({ [pattern.id]: 1 }); }
    finally { index?.close(); }
    expect(git("status", "--porcelain")).toBe("");

    // Simulate the first person's reviewed share landing on the default branch.
    mkdirSync(join(repo, ".mex", "learned"), { recursive: true });
    writeFileSync(join(repo, ".mex", "learned", `${id}.md`), raw);
    writeFileSync(join(repo, ".mex", "sources.json"), JSON.stringify({ version: 1, rule_files: [], learn_deeper: [coverage] }));
    git("add", "-f", ".mex"); git("-c", "commit.gpgsign=false", "commit", "-qm", "Approved share");
    const plan = prepareShare({ projectPath: repo, home: machines[1]!.location.home });
    expect(plan.share).toEqual([]);
    expect(plan.skipped).toContainEqual({ id, reason: "already shared on main" });
    expect(git("ls-tree", "-r", "--name-only", "HEAD", "--", ".mex/learned").split("\n")).toHaveLength(1);
  } finally { machines.forEach(writer => writer.close()); }
}, 25_000);

it("uses shared receipts before model selection and respects a deleted legacy rule", async () => {
  const now = Date.now(), old = git("rev-parse", "HEAD");
  const legacy = parseEntry(serializeEntry({ mex: { id: "mx_legacy001", kind: "rule", scope: ["**"], source: { type: "docs", ref: "README.md" },
    evidence: "docs", one_line: answer.one_line, checks: [], status: "active", created: new Date(now).toISOString().slice(0, 10) }, text: answer.text }));
  const relative = `.mex/learned/${legacy.mex.id}.md`;
  mkdirSync(join(repo, ".mex", "learned"), { recursive: true });
  writeFileSync(join(repo, relative), serializeEntry(legacy));
  git("add", "-f", relative); git("-c", "commit.gpgsign=false", "commit", "-qm", "Old shared rule");
  git("rm", relative);
  const shared = `# Already read\n${quote}\n`;
  const newDocs = `# New docs\n${quote}\n`;
  writeFileSync(join(repo, "README.md"), shared);
  writeFileSync(join(repo, "ARCHITECTURE.md"), newDocs);
  git("add", "README.md", "ARCHITECTURE.md"); git("-c", "commit.gpgsign=false", "commit", "-qm", "Remove obsolete rule and add docs");
  const docsHead = git("rev-parse", "HEAD");
  const proof: SourceRef = { id: "doc:README.md", hash: sourceDigest(shared), link: `https://github.com/example/memory/blob/${docsHead}/README.md`, coverage: "full" };
  const partial: SourceRef = { id: "doc:ARCHITECTURE.md", hash: sourceDigest(newDocs), link: `https://github.com/example/memory/blob/${docsHead}/ARCHITECTURE.md`, coverage: "partial" };
  mkdirSync(join(repo, ".mex"), { recursive: true });
  writeFileSync(join(repo, ".mex", "sources.json"), JSON.stringify({ version: 1, rule_files: [], learn_deeper: [
    { id: "mx_sharereceipt", claim: claimHash("A different shared claim."), sources: [proof, partial] },
  ] }));
  git("add", "-f", ".mex/sources.json"); git("-c", "commit.gpgsign=false", "commit", "-qm", "Add team receipts");
  const head = git("rev-parse", "HEAD");
  const team = await readTeamCoverage(repo, head, new Date(now - DAY_MS).toISOString());
  expect(team.retired.has(claimHash(legacy.text))).toBe(true);
  expect(team.read.has(coverageKey(proof))).toBe(true);
  expect(team.read.has(coverageKey(partial))).toBe(true);
  expect(team.read.has(coverageKey({ ...partial, coverage: "full" }))).toBe(false);
  const model = vi.fn<typeof runModel>(async request => {
    expect(request.prompt).not.toContain('"id":"doc:README.md"');
    expect(request.prompt).toContain('"id":"doc:ARCHITECTURE.md"');
    return reply({ entries: [{ ...answer, evidence: [{ id: "doc:ARCHITECTURE.md", quote }] }] });
  });
  const fetch = weeklyForge(() => head);
  registerJobKind(createLearnKind({ client: async () => new ForgeClient(original, "fixture-login", fetch), model, now: () => now }, true));
  const writer = openRecord({ projectPath: repo, isNetwork: () => false });
  try {
    const project = writer.checkout(repo)!.project_id, job = due(writer, project, old, now);
    await runOneBatch(writer, ownerId("foreground"), only(job));
    await runOneBatch(writer, ownerId("foreground"), only(job));
    expect(model).toHaveBeenCalledTimes(1);
    expect(weeklyJob(writer)).toMatchObject({ state: "done", results: 0 });
    expect(snapshotNotes(writer, project).files.size).toBe(0);
  } finally { writer.close(); }
}, 25_000);

it("defers while another agent session is active and needs a forge login before any weekly fetch", async () => {
  let now = Date.now();
  const fetch = vi.fn(async () => { throw new Error("Unexpected anonymous fetch"); });
  const model = vi.fn<typeof runModel>();
  registerJobKind(createLearnKind({ client: async () => new ForgeClient(original, undefined, fetch), model, now: () => now }, true));
  const writer = openRecord({ projectPath: repo, isNetwork: () => false });
  try {
    const project = writer.checkout(repo)!.project_id;
    const job = due(writer, project, git("rev-parse", "HEAD"), now);
    execFileSync(binary, ["codex", "SessionStart"], {
      cwd: repo, encoding: "utf8", input: JSON.stringify({ cwd: repo, source: "startup", hook_event_name: "SessionStart", session_id: "active-session" }),
      env: { ...process.env, MEX_BACKGROUND: "0" },
    });
    await runOneBatch(writer, ownerId("foreground"), only(job));
    expect(weeklyJob(writer)).toMatchObject({ state: "waiting", reason: "Waiting for agent sessions to go idle" });
    expect(requeueReadyJobs(writer)).toBe(0);
    now += 10 * 60_000 + 1000;
    expect(requeueReadyJobs(writer)).toBe(1);
    await runOneBatch(writer, ownerId("foreground"), only(job));
    expect(weeklyJob(writer)).toMatchObject({ state: "done with gaps", results: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
    expect(JSON.parse(weeklySchedule(writer, project)!).due).toBe(now + DAY_MS);
  } finally { writer.close(); }
});

it("joins an unfinished job on a second mex, then uses the pinned docs across a branch switch", async () => {
  const { ask } = await accept();
  const again = await accept(ask);
  expect(again.lines.join("\n")).toContain("Learn deeper");
  expect(ask).toHaveBeenCalledTimes(1);
  git("switch", "-qc", "other");
  writeFileSync(join(repo, "README.md"), "This is the other branch.\n");
  git("add", "README.md"); git("-c", "commit.gpgsign=false", "commit", "-qm", "changed docs");
  const model = vi.fn<typeof runModel>(async request => {
    expect(request.prompt).toContain(quote);
    expect(request.prompt).not.toContain("This is the other branch");
    return reply({ entries: [answer] });
  });
  registerJobKind(createLearnKind({ model }));
  const writer = openRecord();
  try {
    const job = jobRow(writer);
    await runOneBatch(writer, ownerId("foreground"), only(job));
    expect(model).toHaveBeenCalledTimes(1);
    expect(jobRow(writer).results).toBe(1);
    expect(git("status", "--porcelain")).toBe("");
  } finally { writer.close(); }
});

it.each(["offline", "expired login"] as const)("waits and continues the same batch after %s", async problem => {
  await accept();
  const request = mockGithub();
  let available = false, now = Date.now();
  const model = vi.fn<typeof runModel>(async () => reply({ entries: [answer] }));
  registerJobKind(createLearnKind({ model, now: () => now, client: async plan => new ForgeClient(plan.origin, "forge-fixture-token", async (input, init) => {
    if (available) return request(input, init);
    if (problem === "expired login") return new Response(null, { status: 401 });
    throw new TypeError("fixture network failure");
  }, 0) }));
  const writer = openRecord();
  try {
    const job = jobRow(writer), self = ownerId("foreground");
    await runOneBatch(writer, self, only(job));
    expect(jobRow(writer)).toMatchObject({ state: "waiting", batch: 0, failures: 0 });
    expect(jobRow(writer).reason).toMatch(problem === "offline" ? /could not be reached/u : /sign in/iu);
    expect(model).not.toHaveBeenCalled();
    expect(requeueReadyJobs(writer)).toBe(0);
    available = true; now += 61_000;
    expect(requeueReadyJobs(writer)).toBe(1);
    await runOneBatch(writer, self, only(job));
    expect(jobRow(writer)).toMatchObject({ state: "done with gaps", batch: 1, results: 1 });
    expect(model).toHaveBeenCalledTimes(1);
  } finally { writer.close(); }
});

it("keeps the cheap shortlist through a provider plan limit and an application restart", async () => {
  const setup = await accept();
  let now = Date.now(), limited = true;
  const model = vi.fn<typeof runModel>(async request => {
    if (request.role === "cheap") return reply({ ids: ["doc:README.md"] });
    if (limited) throw new ModelRunError("usage_limit", "codex", new Date(now + 2000).toISOString());
    expect(request.prompt).not.toContain(review);
    return reply({ entries: [answer] });
  });
  registerJobKind(createLearnKind({ model, now: () => now }));
  let writer = openRecord();
  try {
    const first = jobRow(writer);
    const plan = Plan.parse(JSON.parse(first.params));
    writer.db.prepare("UPDATE jobs SET params=? WHERE id=?").run(JSON.stringify({ ...plan, setup: "mixed", ceiling: plan.ceiling * 2 }), first.id);
    const self = ownerId("foreground");
    await runOneBatch(writer, self, only(first));
    expect(jobRow(writer)).toMatchObject({ state: "waiting", batch: 0 });
    expect(jobRow(writer).reason).toContain("usage limit");
    expect(model.mock.calls.map(([request]) => request.role)).toEqual(["cheap", "best"]);
    writer.close(); writer = openRecord();
    expect(requeueReadyJobs(writer)).toBe(0);
    now += 3000; limited = false;
    expect(requeueReadyJobs(writer)).toBe(1);
    await runOneBatch(writer, self, only(first));
    expect(model.mock.calls.map(([request]) => request.role)).toEqual(["cheap", "best", "best"]);
    expect(jobRow(writer)).toMatchObject({ state: "done with gaps", batch: 1, results: 1 });
    expect(writer.db.prepare("SELECT 1 FROM settings WHERE scope=? AND key LIKE 'learning.deep.shortlist.%'").get(setup.result.projectId!)).toBeUndefined();
  } finally { writer.close(); }
});

it("recovers a published batch without a second model call after its runner dies", async () => {
  await accept();
  const model = vi.fn<typeof runModel>(async () => reply({ entries: [answer, answer] }));
  const kind = createLearnKind({ model });
  registerJobKind(kind);
  let writer = openRecord();
  try {
    const job = jobRow(writer), dead = ownerId("background", 989898);
    writer.db.prepare("UPDATE jobs SET state='running',owner=? WHERE id=?").run(dead, job.id);
    const claimed = jobRow(writer), params = Plan.parse(JSON.parse(job.params));
    const scratch = join(writer.location.home, "learn-checks", job.id, "batch-ABC123");
    mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, "abandoned.txt"), "abandoned fixture");
    await kind.runBatch({ writer, job: claimed, params, checkpoint: undefined });
    expect(existsSync(scratch)).toBe(false);
    expect(jobRow(writer)).toMatchObject({ state: "running", batch: 0 });
    expect(snapshotNotes(writer, job.project_id!).files.size).toBe(1);
    writer.close(); writer = openRecord();
    const self = ownerId("background");
    expect(recoverInterruptedJobs(writer, self, () => false)).toBe(1);
    expect(jobRow(writer).progress).toBe("Finishing the saved batch after interruption");
    await runOneBatch(writer, self, only(job));
    expect(model).toHaveBeenCalledTimes(1);
    expect(jobRow(writer)).toMatchObject({ state: "done with gaps", batch: 1, results: 1 });
    expect(snapshotNotes(writer, job.project_id!).files.size).toBe(1);
  } finally { writer.close(); }
});

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
