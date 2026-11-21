import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as cliTools from "../../cli-tools.js";
import { literalPattern } from "../../file-index/classify.js";
import { openIndex } from "../../file-index/read.js";
import { indexDirectory, writePatterns } from "../../file-index/store.js";
import { parseEntry, serializeEntry } from "../../knowledge/entry.js";
import { propose } from "../../knowledge/gate.js";
import { snapshotNotes } from "../../knowledge/personal-store.js";
import { prepareShare } from "../../knowledge/share-plan.js";
import { writeSharedKnowledgeFiles } from "../../knowledge/share.js";
import { claimHash } from "../../knowledge/state.js";
import { runModel } from "../../model-runner/index.js";
import { CEILING_WAIT, recordedModelSpend } from "../../model-runner/consent.js";
import { claimModelBatch, enqueueModelBatch, recoverModelBatches, withModelJob } from "../../model-runner/budget-queue.js";
import { ModelRunError } from "../../model-runner/errors.js";
import { DEFAULT_MODELS } from "../../model-runner/models.js";
import { queueJob } from "../../record/background.js";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { enqueueJob, listJobs, ownerId, recoverInterruptedJobs, registerJobKind, requeueReadyJobs, runOneBatch, type JobRow } from "../../record/jobs.js";
import { ZERO } from "../../record/usage.js";
import { runRepoStart } from "../../repo-start/command.js";
import { githubReviewLines, withVerifiedAnchors } from "../anchors.js";
import { approvedCoverage, coverageKey, noteKey, parseManifest, readTeamCoverage, sourceRead, type SourceRef } from "../coverage.js";
import { prepareEntries } from "../entries.js";
import { ForgeClient } from "../forge.js";
import { PinnedTree } from "../git.js";
import { createLearnKind } from "../job.js";
import { offerLearning } from "../offer.js";
import { LEARN_KIND, Plan } from "../plan.js";
import { sourceDigest, type DocSource, type ReviewSource } from "../source.js";
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

function mockGithub(verifiedPulls = 2) {
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
          submittedAt: at, author: { login: "testuser", name: "Test User", __typename: "User" }, authorCanPushToRepository: id <= verifiedPulls },
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
    expect(plan.pullsPerBatch).toBe(8);
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
    const learned = parseEntry(notes[0]!);
    const selected = DEFAULT_MODELS.codex.best;
    expect(learned.mex.source).toEqual({ type: "docs", ref: "README.md", producer: "learn-deeper",
      model: { id: selected, version: selected }, label: "Learned from 1 doc" });
    expect(learned.mex.scope).toEqual(["**"]);
    expect(writer.setting(start.projectId!, `knowledge.gate.${learned.mex.id}`)).toBeDefined();
    const results = listJobs({ all: (sql, ...args) => writer.db.prepare(sql).all(...args) as never });
    expect(results.find(item => item.id === job.id)?.summary).toContain(`Writer model ${selected} (${selected}) · Learned from 1 doc.`);
    expect(notes[0]).not.toContain(quote);
    const receipt = writer.db.prepare("SELECT value FROM settings WHERE key LIKE 'learning.deep.batch.%'").get()?.value;
    expect(String(receipt)).not.toContain(review);
    expect(JSON.parse(String(receipt)).sources).toHaveLength(3);
    expect(JSON.parse(String(receipt)).diagnostics.anchors).toEqual([{ id: learned.mex.id, kinds: ["command"] }]);
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
  return { text: JSON.stringify(value), selectedModel: "fixture", usage: { ...ZERO, model: "fixture-2026-11", estimated: false } };
}

/**
 * OSS-67 rules replayed at $0. Each row holds the doc excerpt its quotes come from and the pinned files the anchor
 * code reads: paths and globs the quote or claim names, and the files that mention each identifier the quote marks
 * (real content when at most 8 files do, stubs otherwise). The mex rows were rebuilt from mex at 515e034a; the pip and
 * go-git rows are the human-Correct rules kept from the earlier fixture.
 */
type ReplayRule = {
  repo: string; slug: string; revision: string; id: string; label: "Correct" | "Kept"; kind: string; text: string; oneLine: string;
  evidence: Array<{ path: string; link: string; quote: string }>; sources: Record<string, string>; files: Record<string, string>;
};
const replay: ReplayRule[] = JSON.parse(readFileSync(new URL("./fixtures/oss67-anchor-replay.json", import.meta.url), "utf8"));
const fixtureModel = { id: "fixture", version: "fixture-2026-11" };

async function fixturePlan(slug: string) {
  const pinned = (await PinnedTree.open(repo, git("rev-parse", "HEAD")))!;
  const origin = { host: "github.com", slug };
  const plan = Plan.parse({ checkout: repo, head: pinned.head, origin, source: origin, visibility: "public", agent: "codex", setup: "best-only",
    since: "2025-01-01T00:00:00.000Z", until: "2026-11-20T00:00:00.000Z", preferred: [], docs: [], pulls: [], gaps: [], estimate: 100, ceiling: 150 });
  return { pinned, plan };
}

// Frozen from the replay. Code anchors come only from paths the quotes name; every other rule is repo-wide.
const repoWide = ["repo-wide", "scope **"];
const REPLAY_KINDS: Record<string, string[]> = {
  mx_deep2d1ff0cb74224aa6b03a61c9ef574b45: ["code-scope", "scope .gitignore"], // mex: graph eval artifacts (evaluate/README.md)
  mx_deep397d4cd1b05b63f28b8fdd3af5825ea8: repoWide, // mex: watch hook cleanup
  mx_deep6be26c5dde592fb81485dc6aef0484c4: repoWide, // mex: automatic model work (`runModel` is in 16 files, so no symbol)
  mx_deep6ece297b313cc8b07f4e86df02992685: repoWide, // mex: team-entry evidence gates
  mx_deep753a7d851c8edcd528a9038da610293a: repoWide, // mex: runtime verdicts in the local record
  mx_deepe740d73545708cd2377e38419155a795: repoWide, // mex: pure single-file extractors
  mx_deepfc7b4569f40848e12bec69aac49486fe: repoWide, // mex: code-graph contribution scope
  mx_deepfecb873071b891fcc3247023d009f506: repoWide, // mex: block conversion on complete: false
  mx_deep4f78c5b8e89314355be98afe9f1f7fad: ["code-scope", "scope src/model-runner/models.ts"], // mex: model names (Correct)
  mx_deep4edf88f972f4debe2c227f63146d72f6: repoWide, // pip: news entries (Correct)
  mx_deep1a32010843b2eaf7111ef4d70586f935: repoWide, // go-git: AI policy (Correct)
};
const REPLAY_COUNTS = { rules: 11, codeScope: 2, when: 0, symbol: 0, command: 0, repoWide: 9 };

it("replays the OSS-67 rules through propose() and counts each anchor kind", async () => {
  const observed: Record<string, string[]> = {};
  for (const [i, row] of replay.entries()) {
    repo = join(fixture, `replay-${i}`); mkdirSync(repo);
    git("init", "-qb", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    for (const [path, content] of Object.entries({ ...row.files, ...row.sources })) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    git("add", "-f", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", `Pin ${row.repo} at ${row.revision.slice(0, 8)}`);
    const { pinned, plan } = await fixturePlan(row.slug);
    const sources: DocSource[] = Object.entries(row.sources).map(([path, text]) => ({ id: "doc:" + path, kind: "docs", path, text,
      hash: sourceDigest(text), coverage: "partial", link: row.evidence.find(item => item.path === path)!.link }));
    const prepared = await prepareEntries(reply({ entries: [{ kind: row.kind, scope: [], text: row.text, one_line: row.oneLine, checks: [],
      evidence: row.evidence.map(({ path, quote }) => ({ id: "doc:" + path, quote })) }] }).text, sources, plan, pinned, fixtureModel);
    expect(prepared.validation.rejected, row.id).toEqual([]);
    const saved = await withVerifiedAnchors(prepared.entries, pinned, fixture, randomUUID(), undefined, async ([proposal], check) => {
      if (!proposal || typeof proposal === "string") throw new Error(`${row.id} did not anchor: ${String(proposal)}`);
      observed[row.id] = [...proposal.anchorKinds, ...(proposal.anchors?.scope ?? []).map(glob => "scope " + glob),
        ...(proposal.anchors?.when ?? []).map(item => "when " + item.pattern),
        ...(proposal.checks ?? []).flatMap(item => item.kind === "symbol" ? ["symbol " + item.target.symbol] : [])];
      return propose([proposal], { ...check, home: fixture, projectPath: repo });
    });
    expect(saved, row.id).toEqual([{ status: "accepted", entryId: row.id, change: "new" }]);
  }
  expect(observed).toEqual(REPLAY_KINDS);
  const count = (kind: string) => Object.values(observed).filter(kinds => kinds.includes(kind)).length;
  expect({ rules: replay.length, codeScope: count("code-scope"), when: count("when"), symbol: count("symbol"), command: count("command"),
    repoWide: count("repo-wide") }).toEqual(REPLAY_COUNTS);
}, 120_000);

it.each([
  { name: "a cited code file", quote: "Commit a regression test when updating src/runtime.ts.",
    text: "Changes to the runtime need a regression test that checks stable snapshots.", modelScope: ["src/*.ts"], scope: ["src/*.ts"], kinds: ["code-scope"] },
  { name: "a cited code glob", quote: "Update the regression fixtures when modifying src/*.ts.",
    text: "Refresh the regression fixtures when editing a top-level runtime module.", scope: ["src/*.ts"], kinds: ["code-scope"] },
  { name: "a cited directory with a trailing slash", quote: "Update regression fixtures when modifying files under src/.",
    text: "Changes to source modules require a refresh of the regression fixtures.", scope: ["src/**"], kinds: ["code-scope"] },
  { name: "a model's trailing-slash scope", quote: "Commit a regression test when updating src/runtime.ts.",
    text: "Runtime changes need a regression test for stable snapshots.", modelScope: ["src/"], scope: ["src/**"], kinds: ["code-scope"] },
  { name: "a trailing-slash scope with no pinned file", quote: "Keep the examples under unpinned/ in sync.",
    text: "Update copied examples when their original behavior changes.", modelScope: ["unpinned/"], liveFile: "unpinned/example.ts",
    scope: ["**"], kinds: ["repo-wide"] },
  { name: "a pinned path elsewhere in the verified excerpt", quote: "Regression tests should cover runtime behavior.",
    body: "The implementation is in src/runtime.ts.", text: "Provide runtime regression tests when updating src/runtime.ts.",
    scope: ["src/runtime.ts"], kinds: ["code-scope"] },
  { name: "a named symbol", quote: "The function canonicalSnapshotId should preserve identifiers between releases.",
    text: "Keep snapshot IDs stable across releases in canonicalSnapshotId.", scope: ["src/ids.ts"], kinds: ["symbol"] },
  { name: "a declared Makefile target", quote: "Before release, run make verify-index to check generated fixtures.",
    text: "Verify the generated index before releases.", scope: ["**"], kinds: ["command", "repo-wide"] },
  { name: "no code anchor, so the doc rule is repo-wide", quote: "Record the intended audience and the reason when proposing a policy amendment.",
    text: "When proposing policy amendments, describe who the change affects and why it is needed.",
    scope: ["**"], kinds: ["repo-wide"] },
])("anchors a doc rule using $name through the real gate", async scenario => {
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "unrelated"));
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "src/runtime.ts"), "export function startRuntime() { return true; }\n");
  writeFileSync(join(repo, "src/ids.ts"), "export function canonicalSnapshotId() { return 'fixture'; }\n");
  writeFileSync(join(repo, "unrelated/other.ts"), "export const unrelated = true;\n");
  writeFileSync(join(repo, "Makefile"), "verify-index:\n\t@printf fixture\n");
  const path = "docs/guide.rst", content = [scenario.quote, scenario.body].filter(Boolean).join("\n\n");
  writeFileSync(join(repo, path), content);
  git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "Pin docs, definitions, and command targets");
  const { pinned, plan } = await fixturePlan("example/memory");
  // A model glob needs both a real pinned file and evidence linking it to the rule.
  const proposals = [{ kind: "rule", scope: [...(scenario.modelScope ?? []), "unrelated/**"],
    text: scenario.text, one_line: scenario.text, evidence: [{ id: "doc:" + path, quote: scenario.quote }], checks: [] }];
  const sources: DocSource[] = [{ id: "doc:" + path, kind: "docs", path, text: content, hash: sourceDigest(content), coverage: "full",
    link: `https://github.com/example/memory/blob/${plan.head}/${path}` }];
  const prepared = await prepareEntries(reply({ entries: proposals }).text, sources, plan, pinned, fixtureModel);
  expect(prepared.validation.rejected).toEqual([]);
  writeFileSync(join(repo, "src/ids.ts"), "export function renamedInTheWorkingTree() { return ''; }\n");
  if (scenario.liveFile) {
    mkdirSync(dirname(join(repo, scenario.liveFile)));
    writeFileSync(join(repo, scenario.liveFile), "export const example = true;\n");
  }
  await withVerifiedAnchors(prepared.entries, pinned, fixture, randomUUID(), undefined, async ([anchor], options) => {
    if (!anchor || typeof anchor === "string") throw new Error("Expected the doc proposal to anchor");
    expect(anchor.anchors?.scope).toEqual(scenario.scope);
    expect(anchor.anchorKinds).toEqual(scenario.kinds);
    expect(await propose([anchor], { ...options, home: fixture, projectPath: repo })).toEqual([expect.objectContaining({ status: "accepted" })]);
  });
});

it("uses pinned changed files from verified top-level reviews as code anchors", async () => {
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/runtime.ts"), "export const version = 1;\n");
  git("add", "src"); git("-c", "commit.gpgsign=false", "commit", "-qm", "Pin the changed code");
  const { pinned, plan } = await fixturePlan("example/memory");
  const sources: ReviewSource[] = [1, 2].map(pull => ({
    id: "review:" + pull, kind: "review", link: `https://github.com/example/memory/pull/${pull}`,
    hash: sourceDigest(review), text: review, writer: true, pull, at: plan.until, topLevel: true, outdated: false,
    changedPaths: ["src/runtime.ts", "src/deleted.ts"],
  }));
  const prepared = await prepareEntries(reply({ entries: [{ ...answer, kind: "rule", checks: [],
    evidence: sources.map(source => ({ id: source.id, quote: source.text })) }] }).text, sources, plan, pinned, fixtureModel);
  expect(prepared.validation.rejected).toEqual([]);
  await withVerifiedAnchors(prepared.entries, pinned, fixture, randomUUID(), undefined, async ([anchor]) => {
    expect(anchor).toMatchObject({ anchors: { scope: ["src/runtime.ts"] }, anchorKinds: ["code-scope"] });
  });
});

it("makes an ungrounded review rule repo-wide and drops an unverified symbol or an anchorless recipe", async () => {
  writeFileSync(join(repo, "unrelated.ts"), "export const actualName = 1;\n");
  git("add", "unrelated.ts"); git("-c", "commit.gpgsign=false", "commit", "-qm", "Pin the unrelated file");
  const { pinned, plan } = await fixturePlan("example/memory");
  const sources: ReviewSource[] = [1, 2].map(pull => ({
    id: "review:" + pull, kind: "review", link: `https://github.com/example/memory/pull/${pull}`,
    hash: sourceDigest(review), text: review, writer: true, pull, at: plan.until, topLevel: true, outdated: false,
  }));
  const rule = { kind: "rule", scope: ["**", "**/*", "unrelated.ts", "../README.md"], text: answer.text, one_line: answer.one_line,
    evidence: sources.map(source => ({ id: source.id, quote: source.text })), checks: [] };
  const prepared = await prepareEntries(reply({ entries: [
    rule,
    { ...rule, checks: [{ kind: "symbol", role: "supporting", target: { file: "unrelated.ts", symbol: "missingName" } }] },
    { ...rule, kind: "recipe", text: "Recipes from reviews still need a code or command anchor." },
  ] }).text, sources, plan, pinned, fixtureModel);
  expect(prepared.validation.rejected).toEqual([]);
  await withVerifiedAnchors(prepared.entries, pinned, fixture, randomUUID(), undefined, async anchors => {
    expect(anchors).toEqual([expect.objectContaining({ anchors: { scope: ["**"] }, anchorKinds: ["repo-wide"] }), "check-verification", "no-anchor"]);
  });
});

it("keeps only edit patterns verified on a review's actual lines and the pinned fix", async () => {
  const path = "src/renderer.ts", body = "Use the shared date formatting conventions inside the `render` function.";
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, path), "import { format } from 'date-fns';\nexport const render = format;\n");
  git("add", path); git("-c", "commit.gpgsign=false", "commit", "-qm", "Pin the code after the fix");
  const { pinned, plan } = await fixturePlan("example/memory");
  // A dirty file must not turn the reviewed pattern into current code.
  writeFileSync(join(repo, path), "import moment from 'moment';\n");
  const sources: ReviewSource[] = [1, 2].map(pull => ({
    id: `github:discussion_r:${pull}`, kind: "review", link: `https://github.com/example/memory/pull/${pull}#discussion_r${pull}`,
    hash: sourceDigest(body), text: body, writer: true, pull, at: plan.until, topLevel: false, outdated: true, path,
  }));
  const request = vi.fn(async (input: RequestInfo | URL) => {
    const id = String(input).split("/").at(-1);
    expect(["1", "2"]).toContain(id);
    return Response.json({ html_url: sources.find(source => source.id.endsWith(":" + id))!.link, path, body, side: "RIGHT", original_line: 2,
      diff_hunk: "@@ -1,0 +1,3 @@\n+import { helper } from 'another-lib';\n+import moment from 'moment';\n+export const render = moment;\n" });
  });
  const client = new ForgeClient(plan.source, "fixture-forge-token", request);
  const pattern = { type: "anti", match: "literal", pattern: "from 'moment'" };
  const prepared = await prepareEntries(reply({ entries: [{
    kind: "rule", scope: ["src/**", "unrelated/**"], text: "Centralize date handling in the shared formatter to keep renderer output consistent.",
    one_line: "Use the shared date formatter when updating the renderer.",
    evidence: sources.map(source => ({ id: source.id, quote: source.text })), when: [pattern, { ...pattern, pattern: "from 'another-lib'" }],
    checks: [{ kind: "symbol", role: "complete", target: { file: path, symbol: "render" } }],
  }] }).text, sources, plan, pinned, fixtureModel);
  expect(prepared.validation.rejected).toEqual([]);
  await withVerifiedAnchors(prepared.entries, pinned, fixture, randomUUID(), source => githubReviewLines(client, plan.source, source), async (anchors, check) => {
    const [proposal] = anchors;
    if (!proposal || typeof proposal === "string") throw new Error("Expected a verified review anchor");
    expect(proposal.anchors).toEqual({ scope: ["src/**"], when: [pattern] });
    expect(proposal.anchorKinds).toEqual(["code-scope", "symbol", "when"]);
    const accepted = await propose([proposal], { ...check, home: fixture, projectPath: repo });
    expect(accepted).toEqual([expect.objectContaining({ status: "accepted" })]);
    const writer = openRecord({ home: fixture, projectPath: repo });
    try {
      const note = parseEntry([...snapshotNotes(writer, writer.checkout(repo)!.project_id).files.values()][0]!);
      expect(note.mex.when).toEqual([pattern]);
      expect(note.mex.checks[0]).toMatchObject({ kind: "symbol", role: "complete", target: { file: path, symbol: "render" } });
      expect(note.mex.source).toMatchObject({ type: "review", producer: "learn-deeper", label: "Learned from 2 reviews" });
      expect(note.mex.source.quote).toBeUndefined();
    } finally { writer.close(); }
  });
  expect(request).toHaveBeenCalled();
});
async function accept(ask = vi.fn(async () => true)) {
  vi.stubGlobal("fetch", mockGithub());
  const lines: string[] = [];
  const result = await runRepoStart({ cwd: repo, write: line => lines.push(line), caller: "person", ask, install: false, wait: false });
  return { result, lines, ask };
}
const only = (job: JobRow) => ({ only: new Set([job.id]) });

it("learns from a scanned pinned excerpt and reports a doc whose secret leaves no safe excerpt", async () => {
  git("rm", "README.md");
  mkdirSync(join(repo, "docs"));
  const flagged = "https://fixture-user:fixture-password@example.invalid/simple/";
  const suffix = "Withheld material after the flagged example.";
  writeFileSync(join(repo, "docs/guide.rst"), quote + "\n\n" + flagged + "\n" + suffix + "\n");
  writeFileSync(join(repo, "docs/no-safe.rst"), flagged + "\n" + suffix + "\n");
  git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "Pin docs with a fixture credential-like example");
  await accept();
  const model = vi.fn<typeof runModel>(async request => {
    expect(request.prompt).toContain(quote);
    expect(request.prompt).not.toContain(flagged);
    expect(request.prompt).not.toContain(suffix);
    expect(request.prompt).not.toContain("docs/no-safe.rst");
    return reply({ entries: [
      { ...answer, evidence: [{ id: "doc:docs/guide.rst", quote }] },
      { ...answer, evidence: [{ id: "doc:docs/guide.rst", quote: suffix }] },
    ] });
  });
  registerJobKind(createLearnKind({ model }));
  const writer = openRecord();
  try {
    const job = jobRow(writer);
    await runOneBatch(writer, ownerId("foreground"), only(job));
    expect(model).toHaveBeenCalledTimes(1);
    expect(jobRow(writer)).toMatchObject({ state: "done with gaps", results: 1 });
    const receipt = JSON.parse(writer.setting(job.project_id!, `learning.deep.batch.${job.id}.0`)!);
    expect(receipt.sources).toContainEqual(expect.objectContaining({ id: "doc:docs/guide.rst", coverage: "partial" }));
    expect(receipt.diagnostics.docPrivacy).toEqual([
      { path: "docs/guide.rst", status: "excerpt", reason: "possible-secret" },
      { path: "docs/no-safe.rst", status: "skipped", reason: "possible-secret" },
    ]);
    expect(receipt.diagnostics.validation.rejected).toEqual([{ index: 2, reason: "quote-mismatch" }]);
    const summary = writer.db.prepare("SELECT summary FROM job_results WHERE job_id=?").get(job.id)?.summary;
    expect(summary).toContain("Some docs were skipped because no safe excerpt remained after secret scanning.");
  } finally { writer.close(); }
});

it("records insufficient review evidence without spending on the batch", async () => {
  git("rm", "README.md");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Use review sources only");
  vi.stubGlobal("fetch", mockGithub(1));
  const writer = openRecord({ projectPath: repo });
  try {
    const projectId = writer.checkout(repo)!.project_id;
    await offerLearning({ root: repo, projectId, write: () => {}, interactive: true,
      sessions: false, weekly: false, confirm: async () => true });
    const model = vi.fn<typeof runModel>();
    registerJobKind(createLearnKind({ model }));
    const job = jobRow(writer);
    expect(await runOneBatch(writer, ownerId("foreground"), only(job))).toBe("ran");
    expect(model).not.toHaveBeenCalled();
    expect(jobRow(writer)).toMatchObject({ state: "done with gaps", tokens_used: 0, results: 0 });
    const saved = writer.setting(projectId, `learning.deep.batch.${job.id}.0`)!;
    expect(JSON.parse(saved)).toMatchObject({
      checkpoint: { pull: 2, gaps: expect.arrayContaining(["Some review batches lacked verified reviews from two merged changes."]) },
      sources: [{ id: "github:pullrequestreview-:1" }, { id: "github:pullrequestreview-:2" }],
      diagnostics: { reviewSources: 2, verifiedReviewSources: 1, verifiedPulls: 1, docs: 0, skip: "insufficient-review-evidence" },
    });
  } finally { writer.close(); }
});

it("records the no-anchor drop and publishes no note for a corroborated but unanchored review claim", async () => {
  git("rm", "README.md");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Use top-level review sources only");
  await accept();
  const model = vi.fn<typeof runModel>(async () => reply({ entries: [{ ...answer, scope: ["**/*.js", "package.json"],
    evidence: [1, 2].map(pull => ({ id: `github:pullrequestreview-:${pull}`, quote: review })), checks: [],
  }] }));
  registerJobKind(createLearnKind({ model }));
  const writer = openRecord();
  try {
    const job = jobRow(writer);
    await runOneBatch(writer, ownerId("foreground"), only(job));
    expect(jobRow(writer)).toMatchObject({ state: "done with gaps", results: 0 });
    const saved = JSON.parse(writer.setting(job.project_id!, `learning.deep.batch.${job.id}.0`)!);
    expect(saved.diagnostics.validation.rejected).toEqual([{ index: 1, reason: "no-anchor" }]);
    expect(writer.db.prepare("SELECT summary FROM job_results WHERE job_id=?").get(job.id)?.summary).toContain("Rejected proposals (1 no-anchor).");
    expect(snapshotNotes(writer, job.project_id!).files.size).toBe(0);
  } finally { writer.close(); }
});

it("leaves no gate publication or learning receipt when the job loses its owner", async () => {
  await accept();
  const writer = openRecord();
  try {
    const job = jobRow(writer);
    const model = vi.fn<typeof runModel>(async () => {
      writer.db.prepare("UPDATE jobs SET owner=? WHERE id=?").run("other-runner", job.id);
      return reply({ entries: [answer] });
    });
    registerJobKind(createLearnKind({ model }));
    await runOneBatch(writer, ownerId("foreground"), only(job));
    expect(model).toHaveBeenCalledTimes(1);
    expect(snapshotNotes(writer, job.project_id!).files.size).toBe(0);
    expect(writer.setting(job.project_id!, `learning.deep.batch.${job.id}.0`)).toBeUndefined();
    expect(writer.db.prepare("SELECT key FROM settings WHERE key LIKE 'knowledge.gate.%'").all()).toEqual([]);
  } finally { writer.close(); }
});

it("compares a 112 KB AGENTS.md and finishes with a gap when a rule file can't be staged", async () => {
  const filler = Array.from({ length: 1600 }, (_, i) => `- Fixture guidance line ${i} keeps this rule file above the old staging bound.`).join("\n");
  writeFileSync(join(repo, "AGENTS.md"), `# Instructions\n\n${filler}\n- ${answer.one_line}\n`);
  expect(Buffer.byteLength(readFileSync(join(repo, "AGENTS.md")))).toBeGreaterThan(112 << 10);
  mkdirSync(join(repo, ".claude/rules"), { recursive: true });
  writeFileSync(join(repo, ".claude/rules/large.md"), "# Large\n" + "x".repeat(1 << 20) + "\n");
  git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "Add large rule files");
  await accept();
  const other = { ...answer, kind: "rule", text: "Generated snapshot changes must be verified before each release.",
    one_line: "Check generated snapshots before every release.", checks: [] };
  const model = vi.fn<typeof runModel>(async () => reply({ entries: [answer, other] }));
  registerJobKind(createLearnKind({ model }));
  const writer = openRecord();
  try {
    const job = jobRow(writer);
    expect(await runOneBatch(writer, ownerId("foreground"), only(job))).toBe("ran");
    expect(model).toHaveBeenCalledTimes(1);
    expect(jobRow(writer)).toMatchObject({ state: "done with gaps", results: 1 });
    const saved = JSON.parse(writer.setting(job.project_id!, `learning.deep.batch.${job.id}.0`)!);
    expect(saved.checkpoint.gaps).toContain("Some rule files could not be read, so duplicate checks skipped them.");
    expect(saved.diagnostics.unreadRules).toEqual([".claude/rules/large.md"]);
    // The 112 KB AGENTS.md was staged and compared: the proposal repeating its last line is dropped.
    expect(saved.gateSummary).toBe("1 saved, 0 to Review, 1 dropped (duplicate-rule-line 1)");
    const [learned] = [...snapshotNotes(writer, job.project_id!).files.values()].map(raw => parseEntry(raw));
    expect(learned).toMatchObject({ text: other.text, mex: { scope: ["**"] } });
  } finally { writer.close(); }
});

it("matches line endings in doc quotes and records only rejection reasons", async () => {
  const exact = "Keep snapshot IDs stable across releases.\nThe renderer uses their values as cache keys. Ask [reviewer] before rotating them.";
  git("config", "core.autocrlf", "false");
  writeFileSync(join(repo, "README.md"), exact.replace("[reviewer]", "@testuser").replace("\n", "\r\n"));
  git("add", "README.md");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Use CRLF in the documentation");
  await accept();
  const rule = { ...answer, kind: "rule", text: "Preserve snapshot identifiers to avoid invalidating the renderer cache.",
    evidence: [{ id: "doc:README.md", quote: exact }], checks: [] };
  const model = vi.fn<typeof runModel>(async request => {
    expect(request.prompt).toContain("releases.\\r\\nThe renderer uses");
    return reply({ entries: [
      rule,
      { ...rule, evidence: [{ id: "doc:README.md", quote: exact.replace("their values", "a different key") }] },
      { ...rule, evidence: [{ id: "doc:unseen.md", quote: exact }] },
      { ...rule, kind: "hint" },
      { ...rule, checks: [{ kind: "source", role: "supporting", target: { file: "docs/missing.md" } }] },
      { ...rule, evidence: [{ id: "github:pullrequestreview-:1", quote: review }] },
    ] });
  });
  registerJobKind(createLearnKind({ model }));
  const writer = openRecord();
  try {
    const job = jobRow(writer);
    expect(await runOneBatch(writer, ownerId("foreground"), only(job))).toBe("ran");
    expect(jobRow(writer)).toMatchObject({ state: "done with gaps", results: 1 });
    const saved = writer.setting(job.project_id!, `learning.deep.batch.${job.id}.0`)!;
    expect(JSON.parse(saved).diagnostics.validation).toEqual({ response: "valid", proposed: 6, rejected: [
      { index: 2, reason: "quote-mismatch" }, { index: 3, reason: "unknown-source" },
      { index: 4, reason: "non-rule-kind" }, { index: 5, reason: "check-target" },
      { index: 6, reason: "insufficient-evidence" },
    ] });
    expect(saved).not.toContain("The renderer uses");
    const learned = parseEntry([...snapshotNotes(writer, job.project_id!).files.values()][0]!);
    expect(learned.mex.source.model).toEqual(fixtureModel);
    expect(learned.mex.source.label).toBe("Learned from 1 doc");
    const summary = writer.db.prepare("SELECT summary FROM job_results WHERE job_id=?").get(job.id)?.summary;
    expect(summary).toContain("1 saved, 0 to Review, 0 dropped");
    expect(summary).toContain("Writer model fixture (fixture-2026-11) · Learned from 1 doc.");
  } finally { writer.close(); }
});

it("keeps pinned knowledge local and records duplicate proposals and skipped historical docs", async () => {
  const history = "The retired extractor procedure targets the legacy branch.";
  const canonical = "Extra context for local comparison only.";
  mkdirSync(join(repo, ".mex/context"), { recursive: true });
  mkdirSync(join(repo, "docs"));
  const conventions = join(repo, ".mex/context/conventions.md");
  writeFileSync(conventions, `# Rules\n\n${answer.text}\n\n${canonical}\n`);
  writeFileSync(join(repo, "AGENTS.md"), "> This branch is the 0.9 rebuild; `main` stays on 0.8 for fixes.\n");
  writeFileSync(join(repo, "docs/extractors.md"), `# Extractors\n\nThese interfaces are frozen for the 0.7.x contributor program.\n\n${history}\n`);
  git("add", "AGENTS.md", "docs", ".mex/context");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Add known and historical guidance");
  const { lines } = await accept(vi.fn(async (offer: readonly string[], details: readonly string[]) => {
    expect(details).toEqual(expect.arrayContaining(["Historical docs are screened out during the scan."]));
    return true;
  }));
  expect(lines.join("\n")).toContain("queued");
  writeFileSync(conventions, "The dirty worktree does not supply the approved knowledge.\n");
  const model = vi.fn<typeof runModel>(async request => {
    expect(request.prompt).toContain(quote);
    expect(request.prompt).not.toContain(history);
    expect(request.prompt).not.toContain(canonical);
    return reply({ entries: [
      answer,
      { ...answer, text: "Before a release, investigate any changed renderer output.", one_line: "Investigate changed renderer output." },
      { ...answer, checks: [{ kind: "source", role: "supporting", target: { file: ".mex/context/conventions.md" } }] },
    ] });
  });
  registerJobKind(createLearnKind({ model }));
  const writer = openRecord();
  try {
    const job = jobRow(writer);
    expect(await runOneBatch(writer, ownerId("foreground"), only(job))).toBe("ran");
    expect(model).toHaveBeenCalledTimes(1);
    expect(jobRow(writer)).toMatchObject({ state: "done with gaps", results: 1 });
    const receipt = JSON.parse(writer.setting(job.project_id!, `learning.deep.batch.${job.id}.0`)!);
    expect(receipt.diagnostics).toMatchObject({
      docs: 1, staleDocs: [{ path: "docs/extractors.md", reason: "version-scope" }],
      validation: { proposed: 3, rejected: [{ index: 1, reason: "duplicate-existing" }, { index: 3, reason: "proposal-format" }] },
    });
    expect(receipt.sources.map((item: SourceRef) => item.id)).not.toContain("doc:docs/extractors.md");
    const jobs = listJobs({ all: (sql, ...args) => writer.db.prepare(sql).all(...args) as never });
    expect(jobs.find(item => item.id === job.id)?.summary).toContain("Rejected proposals (1 proposal-format, 1 duplicate-existing). Skipped 1 historically scoped doc.");
  } finally { writer.close(); }
});

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
