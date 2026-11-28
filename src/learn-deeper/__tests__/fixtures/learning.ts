import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { parseEntry } from "../../../knowledge/entry.js";
import { snapshotNotes } from "../../../knowledge/personal-store.js";
import type { runModel } from "../../../model-runner/index.js";
import * as agents from "../../../model-runner/agents.js";
import { queueJob } from "../../../record/background.js";
import { openRecord, type RecordWriter } from "../../../record/index.js";
import { ownerId, registerJobKind, runOneBatch, type JobRow } from "../../../record/jobs.js";
import { ZERO } from "../../../record/usage.js";
import { runRepoStart } from "../../../repo-start/command.js";
import { createLearnKind } from "../../job.js";
import { LEARN_KIND } from "../../plan.js";
import { DAY_MS, queueDueWeekly, saveWeeklySchedule, WEEKLY_KIND } from "../../weekly-schedule.js";
import { gateReply, isGatePrompt } from "./gate.js";

let suite: string;
export let binary: string, fixture: string, repo: string;
export const original = { host: "github.com" as const, slug: "example/memory" };
export const path = "CONTRIBUTING.md";
export const sourceId = "doc:CONTRIBUTING.md#development";
export const quote = "Run npm run verify before cutting a release.";
export const claim = quote;
export const paraphrase = "Before cutting a release, run npm run verify.";
const detectAgents = agents.detectAgents;
export const doc = (body = quote) => `# Development\n\n${body}\n`;
export const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export function commit(message: string) {
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", message);
  return git("rev-parse", "HEAD");
}

export function useLearningFixture() {
  beforeAll(() => {
    suite = realpathSync(mkdtempSync(join(tmpdir(), "mex-learn-vertical-")));
    binary = process.env.MEX_HOOK_BINARY ?? join(suite, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
    if (!process.env.MEX_HOOK_BINARY) execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
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
      CLAUDE_CONFIG_DIR: join(fixture, "claude"), CODEX_HOME: join(fixture, "codex"), HOME: fixture,
      USERPROFILE: fixture, LOCALAPPDATA: join(fixture, "local"), GH_TOKEN: "forge-fixture-token" })) vi.stubEnv(key, value);
    fakeCli("codex");
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
}

export function fakeCli(...names: string[]) {
  const bin = join(fixture, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of names) writeFileSync(join(bin, name + (process.platform === "win32" ? ".cmd" : "")), "", { mode: 0o755 });
  vi.spyOn(agents, "detectAgents").mockImplementation(options => detectAgents({ ...options, userHome: fixture, env: { PATH: bin } }));
}

export function mockGithub(options: { head?: () => string; at?: string; pull?: { number: number }; fetches?: string[] } = {}) {
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
            ? [{ number: options.pull?.number ?? 1, mergedAt: options.at }] : [];
          return [`s${key.slice(1)}`, { issueCount: nodes.length, nodes, pageInfo: { hasNextPage: false } }];
        })) });
      if (query.includes("pullRequest(number:")) return Response.json({ data: { repository: { p0: options.pull ?? {
        number: 1, state: "MERGED", mergedAt: options.at, title: "Refresh the renderer", body: " ",
        comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [], totalCount: 0 }, files: { nodes: [] },
      } } } });
    }
    throw new Error(`Unexpected fixture request ${url.pathname}`);
  });
}
export const reply = (value: object) => ({ text: JSON.stringify(value), selectedModel: "fixture", usage: { ...ZERO, model: "fixture-2026-11", estimated: false } });
type ModelRequest = Parameters<typeof runModel>[0];
export function docReply(request: ModelRequest, id = sourceId, text = claim, citation = quote) {
  if (isGatePrompt(request.prompt)) return reply(gateReply(request.prompt));
  expect(request.role).toBe("best");
  expect(request.prompt).toContain("=== FILE " + id.slice(4).split("#", 1)[0]);
  return reply({ rules: [{ text, quote: citation, kind: "process", scope: "repo", source: id.slice(4).split("#", 1)[0] }] });
}

export async function accept(ask = vi.fn(async (_lines: readonly string[]) => true)) {
  const lines: string[] = [];
  const result = await runRepoStart({ cwd: repo, write: line => lines.push(line), caller: "person", ask, install: false, wait: false });
  return { result, lines, ask };
}
export const jobRow = (writer: RecordWriter, kind = LEARN_KIND) => writer.db.prepare("SELECT * FROM jobs WHERE kind=? ORDER BY rowid DESC LIMIT 1").get(kind) as unknown as JobRow;
export const only = (job: JobRow) => ({ only: new Set([job.id]) });
export const state = (job: JobRow) => JSON.parse(job.checkpoint ?? "{}");
export const rawRows = (writer: RecordWriter, job: JobRow) => writer.db.prepare("SELECT key,value FROM settings WHERE key LIKE ?").all(`learning.deep.v2.${job.id}.%`);
export const notes = (writer: RecordWriter, job: JobRow) => [...snapshotNotes(writer, job.project_id!).files.values()].map(parseEntry);
export async function advance(writer: RecordWriter, job: JobRow, condition: (row: JobRow) => boolean = row => row.state !== "queued") {
  const owner = ownerId("foreground");
  for (let i = 0; i < 20; i++) {
    const row = jobRow(writer, job.kind);
    if (condition(row)) return row;
    expect(await runOneBatch(writer, owner, only(job)), String(row.reason ?? "")).toBe("ran");
  }
  throw new Error(`Learning did not reach the expected state: ${JSON.stringify(jobRow(writer, job.kind))}`);
}
export function openWeekly(home?: string) {
  const writer = openRecord({ home, projectPath: repo, isNetwork: () => false });
  writer.db.prepare("UPDATE checkouts SET state='on' WHERE path=?").run(writer.checkout(repo)!.path);
  return writer;
}
export function due(writer: RecordWriter, head: string, now: number) {
  const checkout = writer.checkout(repo)!;
  saveWeeklySchedule(writer, checkout.project_id, { checkout: checkout.path, origin: original, source: original, visibility: "private",
    agent: "codex", setup: "best-only", preferred: [], head, since: new Date(now - DAY_MS * 8).toISOString(), due: now });
  queueDueWeekly(writer, queueJob, now);
  return jobRow(writer, WEEKLY_KIND);
}
export function hook(event: string, session_id: string, extra: object = {}) {
  return execFileSync(binary, ["codex", event], { cwd: repo, encoding: "utf8",
    input: JSON.stringify({ cwd: repo, hook_event_name: event, session_id, ...extra }) });
}
export function fixtureModel() {
  return vi.fn<typeof runModel>(async request => docReply(request));
}

