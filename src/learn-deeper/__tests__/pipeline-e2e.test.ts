import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { parseEntry, serializeEntry } from "../../knowledge/entry.js";
import { snapshotNotes } from "../../knowledge/personal-store.js";
import { buildIndex } from "../../file-index/build.js";
import type { runModel } from "../../model-runner/index.js";
import { queueJob } from "../../record/background.js";
import { openRecord } from "../../record/index.js";
import { ownerId, registerJobKind, runOneBatch, type JobRow } from "../../record/jobs.js";
import { ZERO } from "../../record/usage.js";
import { saveTombstone } from "../../knowledge/state.js";
import { forget, learnedRefusalKey } from "../../knowledge/mutations.js";
import { reviewLearned } from "../../repo-start/review-list.js";
import { runRepoStart } from "../../repo-start/command.js";
import { ForgeClient } from "../forge.js";
import { PinnedTree } from "../git.js";
import { planHarvest } from "../harvest/index.js";
import { createLearnKind } from "../job.js";
import { LEARN_KIND, Plan } from "../plan.js";
import { CURSOR_KEY, reviewRows } from "../pipeline.js";
import { noteKey } from "../coverage.js";

// This repo and the recorded thread are the seed for the joined fixture test (release-01).
const recorded = readFileSync(new URL("./fixtures/harvest/changes.json", import.meta.url), "utf8");
const reviewed: string[] = JSON.parse(recorded).originalLines;
const path = "src/changed.ts";
const origin = { host: "github.com" as const, slug: "acme/app" };
const candidateId = "gh:thread:PRRT_fixture1";
const repeatedId = "gh:thread:PRRT_fixture_repeat";
const claim = "Use the stable adapter for changedEntry instead of calling fallback.";
let suite: string, binary: string, fixture: string, repo: string, originalHead: string, mergedHead: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function commit(message: string, date: string) {
  git("add", ".");
  git("-c", "commit.gpgsign=false", "-c", `user.name=Fixture`, "-c", "user.email=fixture@example.invalid",
    "commit", "-qm", message, "--date", date);
  return git("rev-parse", "HEAD");
}

beforeAll(() => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), "mex-learn-e2e-")));
  binary = join(suite, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));
beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(suite, "case-")));
  repo = join(fixture, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git("init", "-qb", "main");
  git("remote", "add", "origin", "https://github.com/acme/app.git");
  for (const [key, value] of Object.entries({ MEX_HOME: fixture, MEX_BACKGROUND: "0", MEX_OFFLINE: "1", MEX_HOOK_BINARY: binary,
    CLAUDE_CONFIG_DIR: join(fixture, "claude"), CODEX_HOME: join(fixture, "codex") })) vi.stubEnv(key, value);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node test.js" } }));
  vi.stubEnv("GIT_COMMITTER_DATE", "2026-11-11T10:00:00Z");
  writeFileSync(join(repo, path), reviewed.join("\n") + "\n");
  originalHead = commit("Prepare the adapter change", "2026-11-11T10:00:00Z");
  vi.stubEnv("GIT_COMMITTER_DATE", "2026-11-13T10:00:00Z");
  writeFileSync(join(repo, path), reviewed.join("\n").replace("fallback(label)", "stable(label)") + "\n");
  mergedHead = commit("Wire the adapters (#31)", "2026-11-13T10:00:00Z");
});
afterEach(() => {
  registerJobKind(createLearnKind());
  vi.unstubAllEnvs();
  rmSync(fixture, { recursive: true, force: true });
});

function recordedForge(numbers = [31, 40], repeatedAt = "2026-11-13T09:59:59Z") {
  const { merged } = JSON.parse(recorded.replaceAll("OID_ORIGINAL", originalHead).replaceAll("OID_MERGE", mergedHead));
  merged.changedFiles = 1;
  merged.files.nodes = [{ path }];
  merged.reviewThreads.nodes = merged.reviewThreads.nodes.slice(0, 1);
  merged.reviewThreads.totalCount = 1;
  const repeated = structuredClone(merged);
  repeated.number = 40;
  repeated.mergedAt = repeated.closedAt = repeatedAt;
  repeated.body = "";
  const thread = repeated.reviewThreads.nodes[0];
  thread.id = "PRRT_fixture_repeat";
  const comment = thread.comments.nodes[0];
  comment.id = "PRRC_fixture_repeat";
  comment.fullDatabaseId = "2040";
  comment.body = comment.body.replace("Fern Example", "Cedar Example");
  comment.author = { __typename: "User", login: "cedar-owner", name: "Cedar Example" };
  comment.pullRequestReview.author.login = "cedar-owner";
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/acme/app") return Response.json({ full_name: "acme/app", private: false });
    if (url.pathname !== "/graphql") throw Error(`Unexpected fixture path ${url.pathname}`);
    const { query, variables }: { query: string; variables: Record<string, string> } = JSON.parse(String(init?.body));
    if (query.includes("HarvestSearch(")) {
      return Response.json({ data: Object.fromEntries(Object.entries(variables).filter(([key]) => /^q\d+$/u.test(key)).map(([key, term]) => {
        const dates = /merged:([^ ]+)\.\.([^ ]+)$/u.exec(term);
        const nodes = [merged, repeated].filter(pr => numbers.includes(pr.number) && dates
          && Date.parse(pr.mergedAt) >= Date.parse(dates[1]!) && Date.parse(pr.mergedAt) <= Date.parse(dates[2]!));
        return [`s${key.slice(1)}`, { issueCount: nodes.length, nodes, pageInfo: { hasNextPage: false } }];
      })) });
    }
    expect(query).toMatch(/p0:pullRequest\(number:(?:31|40)\)/u);
    return Response.json({ data: { repository: { p0: query.includes("number:40") ? repeated : merged } } });
  });
  return { fetch, client: new ForgeClient(origin, "fixture-login", fetch) };
}

const reply = (value: unknown) => ({ text: JSON.stringify(value), selectedModel: "fixture", usage: { ...ZERO, model: "fixture-2026-11", estimated: false } });

it.each([
  { area: "quiet scope", gap: "none" },
  { area: "40 HEAD occurrences in large text alongside binary data", gap: "common" },
  { area: "unread oversized and private files, then scope repair", gap: "unread" },
])("learns from a recorded review and stops an edit before the fix is gone ($area)", async ({ gap }) => {
  const noisy = gap === "common";
  const unread = gap === "unread";
  let head = mergedHead;
  if (gap !== "none") {
    vi.stubEnv("GIT_COMMITTER_DATE", "2026-11-14T10:00:00Z");
    if (noisy) {
      // A text file with a binary-looking extension still counts, even after 96 KiB.
      writeFileSync(join(repo, "src", "legacy.exe"), "// padding\n".repeat(12_000) + "fallback('legacy');\n".repeat(40));
      // A file with a code extension can be binary even when it exceeds the native limit.
      writeFileSync(join(repo, "src", "archive.ts"), Buffer.alloc(600 << 10));
    } else {
      writeFileSync(join(repo, "src", "oversize.ts"), "//" + "x".repeat(512 << 10));
      writeFileSync(join(repo, "src", "private.ts"), "// <private>Withheld fixture text</private>\nfallback('private');\n");
    }
    head = commit("Keep the existing legacy callers", "2026-11-14T10:00:00Z");
  }
  if (noisy) {
    const tree = (await PinnedTree.open(repo, head))!;
    await tree.withCheckTree(fixture, "c".repeat(36), ["src/legacy.exe"], async (_checkout, files) => {
      expect(files.has("src/legacy.exe")).toBe(false);
    });
  }
  await runRepoStart({ cwd: repo, write: () => {}, caller: "script", install: false, wait: false });
  const writer = openRecord();
  try {
    const real = realpathSync(repo);
    const { path: checkout, project_id: project } = writer.checkout(real)!;
    writer.db.prepare("UPDATE checkouts SET state='on' WHERE path=?").run(checkout);
    const index = () => buildIndex({ root: real, projectId: project, recordDirectory: writer.location.directory, workers: 0 });
    await index();
    const forge = recordedForge();
    const window = { since: "2026-11-01T00:00:00.000Z", until: "2026-11-20T00:00:00.000Z" };
    const harvest = await planHarvest({ checkout, head, source: origin, agent: "codex", ...window }, { client: forge.client });
    const plan = Plan.parse({ checkout, head, origin, source: origin, visibility: "public", agent: "codex", setup: "best-only",
      ...window, preferred: [], pulls: [], docs: [], gaps: [], estimate: harvest.estimate, ceiling: harvest.ceiling, harvest });
    const job = queueJob(writer, { kind: LEARN_KIND, projectId: project, params: plan }).job;
    const model = vi.fn<typeof runModel>(async request => {
      expect(request.prompt).not.toMatch(/Fern Example|Cedar Example/u);
      expect(request.prompt).not.toContain("Withheld fixture text");
      if (request.purpose === "learn-deeper-filter") {
        expect(request.prompt).not.toContain("return fallback(label);");
        const items = JSON.parse(request.prompt.split("\nItems:\n")[1]!) as Array<{ id: string }>;
        return reply({ results: items.map(({ id }) => ({ id, keep: id === candidateId || id === repeatedId, category: "api-use", lesson: claim })) });
      }
      const cluster = /"cluster":"([a-f0-9]{24})"/u.exec(request.prompt)![1];
      expect(request.prompt).toContain("3|   return fallback(label);");
      expect(request.prompt).toContain("3|   return stable(label);");
      const repeat = request.prompt.includes(repeatedId);
      const repair = request.prompt.includes("Your earlier entries for these clusters failed verification");
      if (repair) {
        expect(gap !== "none" && !repeat).toBe(true);
        if (noisy) expect(request.prompt).toContain("40 occurrences in 1 of 2 scoped files");
        if (unread) {
          expect(request.prompt).toContain("Could not read 2 scoped files");
          expect(request.prompt).toContain("src/oversize.ts");
          expect(request.prompt).toContain("src/private.ts");
        }
        expect(request.prompt).toContain("Narrow the scope");
      }
      return reply({ entries: [{ cluster, route: "code-rule", kind: "rule", claim,
        // As the prompt asks: a quote from every member that says it.
        clauses: [{ text: claim, quotes: [candidateId, repeatedId].filter(id => request.prompt.includes(id)).map(id => ({ id, quote: "Prefer the stable adapter over the fallback." })) }],
        scope: gap !== "none" && !repair ? ["src/**"] : [path], ...(!repeat || noisy ? { when: [{ type: "anti", match: "literal", pattern: "fallback(" }],
          fix: { pair: 0, start: 3, end: 3 }, examples: { flag: "return fallback(label);", ok: "return stable(label);" } } : {}) }] });
    });
    registerJobKind(createLearnKind({ model, client: async () => forge.client }));
    const row = () => writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id) as unknown as JobRow;
    const owner = ownerId("foreground");
    await runOneBatch(writer, owner, { only: new Set([job.id]) }); // harvest
    expect(model).not.toHaveBeenCalled();
    expect(forge.fetch.mock.calls.some(([, init]) => String(init?.body).includes("p0:pullRequest(number:31)"))).toBe(true);
    await runOneBatch(writer, owner, { only: new Set([job.id]) }); // triage and early publication
    expect(row()).toMatchObject({ state: "queued", results: 1 });
    expect(JSON.parse(row().checkpoint!).v2.phase).toBe("harvest");
    const [early] = reviewRows(writer, project, job.id);
    expect(early).toMatchObject({ support: 1, reviewers: 1, proven: true });
    const firstRule = parseEntry(snapshotNotes(writer, project).files.get(early!.entryId)!);
    expect(firstRule.mex.scope).toEqual([path]);
    expect(firstRule.mex.checks).toContainEqual(expect.objectContaining({
      kind: "pattern", target: expect.objectContaining({ pattern: "fallback(", expect: "at-most" }), saw: { count: 0 },
    }));
    expect(forge.fetch.mock.calls.some(([, init]) => String(init?.body).includes("p0:pullRequest(number:40)"))).toBe(false);
    for (let i = 0; i < 8 && row().state === "queued"; i++) await runOneBatch(writer, owner, { only: new Set([job.id]) });
    const done = row();
    expect(done.state, String(done.reason)).toMatch(/^done/u);
    expect(model).toHaveBeenCalledTimes(gap !== "none" ? 5 : 4);
    expect(model.mock.calls.filter(([request]) => request.prompt.includes("Your earlier entries for these clusters failed verification"))).toHaveLength(gap !== "none" ? 1 : 0);
    expect(JSON.parse(done.checkpoint!).v2.counts).toMatchObject({ "harvested.review-thread": 2, "triage-kept": 2, saved: 2 });
    const learned = [...snapshotNotes(writer, project).files.values()].map(parseEntry).filter(entry => entry.mex.id.startsWith("mx_deep"));
    expect(learned).toHaveLength(1);
    const rule = learned[0]!;
    expect(rule.mex.id).toBe(early!.entryId);
    expect(rule.mex.status).toBe("active");
    expect(rule.mex.when).toEqual([{ type: "anti", match: "literal", pattern: "fallback(" }]);
    if (noisy) {
      expect(rule.mex.scope).toEqual(["src/**"]);
      expect(rule.mex.source.label).toContain("migration in progress");
      expect(rule.mex.checks).toContainEqual(expect.objectContaining({
        kind: "pattern", target: expect.objectContaining({ pattern: "fallback(", expect: "at-most" }), saw: { count: 40 },
      }));
    }
    expect(rule.mex.fix).toMatchObject({ snippet: "  return stable(label);", path, lines: "3-3" });
    expect(rule.mex.checks.map(check => `${check.kind}:${check.role}`)).toEqual(expect.arrayContaining(["fixture:complete", "pattern:complete", "scope:complete", "source:supporting"]));
    expect(rule.mex.source.quote).toBe("Prefer the stable adapter over the fallback.");
    expect(reviewRows(writer, project, job.id)).toMatchObject([{ entryId: early!.entryId, claim, proven: true, support: 2, reviewers: 2,
      status: "active", route: "code-rule", signal: "strong" }]);
    expect(writer.db.prepare("SELECT count(*) n FROM settings WHERE key LIKE ?").get(`learning.deep.v2.${job.id}.%`)?.n).toBe(0);

    const hook = (session: string, event: string, payload: Record<string, unknown> = {}) => execFileSync(binary, ["claude-code", event], {
      encoding: "utf8", timeout: 20_000, input: JSON.stringify({ session_id: session, cwd: real, hook_event_name: event, ...payload }),
    });
    const edit = (from: string) => ({ tool_name: "Edit", tool_input: { file_path: join(real, path), old_string: `  return ${from}(label);`, new_string: "  return fallback(label);" } });
    expect(hook("first", "SessionStart", { source: "startup" })).not.toContain(claim);
    const stopped = hook("first", "PreToolUse", edit("stable"));
    expect(stopped).toContain("deny");
    expect(stopped).toContain("Do this instead");
    expect(stopped).toContain("return stable(label);");

    vi.stubEnv("GIT_COMMITTER_DATE", "2026-11-19T10:00:00Z");
    writeFileSync(join(repo, path), reviewed.join("\n").replace("fallback(label)", "transport(label)") + "\n");
    commit("Switch adapters", "2026-11-19T10:00:00Z");
    await index();
    hook("second", "SessionStart", { source: "startup" });
    expect(hook("second", "PreToolUse", edit("transport"))).not.toContain("deny");
  } finally { writer.close(); }
}, 120_000);

it("writes a review that backs nothing as its own lesson, and leaves the rule it was grouped with alone", async () => {
  await runRepoStart({ cwd: repo, write: () => {}, caller: "script", install: false, wait: false });
  const writer = openRecord();
  try {
    const { path: checkout, project_id: project } = writer.checkout(realpathSync(repo))!;
    writer.db.prepare("UPDATE checkouts SET state='on' WHERE path=?").run(checkout);
    await buildIndex({ root: checkout, projectId: project, recordDirectory: writer.location.directory, workers: 0 });
    const forge = recordedForge();
    const window = { since: "2026-11-01T00:00:00.000Z", until: "2026-11-20T00:00:00.000Z" };
    const harvest = await planHarvest({ checkout, head: mergedHead, source: origin, agent: "codex", ...window }, { client: forge.client });
    const plan = Plan.parse({ checkout, head: mergedHead, origin, source: origin, visibility: "public", agent: "codex", setup: "best-only",
      ...window, preferred: [], pulls: [], docs: [], gaps: [], estimate: harvest.estimate, ceiling: harvest.ceiling, harvest });
    const other = "Name the adapter's caller in the label.";
    const model = vi.fn<typeof runModel>(async request => {
      if (request.purpose === "learn-deeper-filter") {
        const items = JSON.parse(request.prompt.split("\nItems:\n")[1]!) as Array<{ id: string }>;
        return reply({ results: items.map(({ id }) => ({ id, keep: id === candidateId || id === repeatedId, category: "api-use", lesson: claim })) });
      }
      const cluster = /"cluster":"([a-f0-9]{24})"/u.exec(request.prompt)![1];
      // Grouped together, the writer rests the rule on the first review only. Alone, the second says something else.
      const alone = request.prompt.includes(repeatedId) && !request.prompt.includes(candidateId);
      return reply({ entries: [{ cluster, route: "code-rule", kind: "rule", claim: alone ? other : claim, scope: [path],
        clauses: [{ text: alone ? other : claim, quotes: [{ id: alone ? repeatedId : candidateId, quote: "Prefer the stable adapter over the fallback." }] }] }] });
    });
    const { job } = queueJob(writer, { kind: LEARN_KIND, projectId: project, params: plan });
    registerJobKind(createLearnKind({ model, client: async () => forge.client }));
    const row = () => writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id) as unknown as JobRow;
    for (let i = 0; i < 12 && row().state === "queued"; i++) await runOneBatch(writer, ownerId("foreground"), { only: new Set([job.id]) });
    expect(row().state, row().reason ?? "").toMatch(/^done/u);
    const counts = JSON.parse(row().checkpoint!).v2.counts;
    const learned = [...snapshotNotes(writer, project).files.values()].map(parseEntry).filter(entry => entry.mex.id.startsWith("mx_deep"));
    expect(learned.map(entry => entry.mex.one_line).sort()).toEqual([claim, other].sort());
    expect(counts).toMatchObject({ "cluster.unbacked": 1 });
    // Neither rule may claim the other's review.
    expect(reviewRows(writer, project, job.id).map(item => [item.claim, item.support]).sort()).toEqual([[claim, 1], [other, 1]].sort());
    // Saved raw rows are gone, and the leftover was written once.
    expect(model.mock.calls.filter(([request]) => request.purpose === LEARN_KIND && request.prompt.includes(repeatedId) && !request.prompt.includes(candidateId))).toHaveLength(1);
    expect(writer.db.prepare("SELECT count(*) n FROM settings WHERE key LIKE ?").get(`learning.deep.v2.${job.id}.%`)?.n).toBe(0);
  } finally { writer.close(); }
}, 120_000);

it.each(["forget", "legacy forget", "untick", "legacy untick", "leave waiting", "forget, then a different lesson", "forget, then the same trigger"] as const)("honors %s when a different PR teaches something", async decision => {
  await runRepoStart({ cwd: repo, write: () => {}, caller: "script", install: false, wait: false });
  const writer = openRecord();
  try {
    const { path: checkout, project_id: project } = writer.checkout(realpathSync(repo))!;
    writer.db.prepare("UPDATE checkouts SET state='on' WHERE path=?").run(checkout);
    await buildIndex({ root: checkout, projectId: project, recordDirectory: writer.location.directory, workers: 0 });

    async function learn(second: boolean) {
      const start = second ? "2026-11-14" : "2026-11-01";
      const end = second ? "2026-11-20" : "2026-11-13";
      const window = { since: `${start}T00:00:00.000Z`, until: `${end}T23:59:59.000Z` };
      const pr = second ? 40 : 31;
      const forge = recordedForge([pr], "2026-11-14T10:00:00Z");
      const id = second ? repeatedId : candidateId;
      const wording = !second ? claim
        : decision === "forget, then a different lesson" ? "Validate the label before changedEntry builds the response."
        : decision === "forget, then the same trigger" ? "Keep the transport name out of changedEntry labels."
        : "In changedEntry, route fallback calls through the stable adapter.";
      const pattern = !second ? "fallback(" : decision === "forget, then a different lesson" ? "return fallback"
        : decision === "forget, then the same trigger" ? "fallback(label)" : "fallback(";
      const proven = second || decision !== "leave waiting";
      const model = vi.fn<typeof runModel>(async request => {
        if (request.purpose === "learn-deeper-filter") {
          const items = JSON.parse(request.prompt.split("\nItems:\n")[1]!) as Array<{ id: string }>;
          return reply({ results: items.map(item => ({ id: item.id, keep: item.id === id, category: "api-use", lesson: wording })) });
        }
        const cluster = /"cluster":"([a-f0-9]{24})"/u.exec(request.prompt)![1];
        return reply({ entries: [{ cluster, route: "code-rule", kind: "rule", claim: wording, scope: [path],
          clauses: [{ text: wording, quotes: [{ id, quote: "Prefer the stable adapter over the fallback." }] }],
          ...(proven ? { when: [{ type: "anti", match: "literal", pattern }],
            fix: { pair: 0, start: 3, end: 3 }, examples: { flag: "return fallback(label);", ok: "return stable(label);" } } : {}) }] });
      });
      // Separate quotes for the two windows. Neither a cursor nor a seen-source receipt can hide PR 40.
      writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?").run(project, CURSOR_KEY);
      const harvest = await planHarvest({ checkout, head: mergedHead, source: origin, agent: "codex", ...window }, { client: forge.client });
      const plan = Plan.parse({ checkout, head: mergedHead, origin, source: origin, visibility: "public", agent: "codex", setup: "best-only",
        ...window, preferred: [], pulls: [], docs: [], gaps: [], estimate: harvest.estimate, ceiling: harvest.ceiling, harvest });
      const { job } = queueJob(writer, { kind: LEARN_KIND, projectId: project, params: plan });
      registerJobKind(createLearnKind({ model, client: async () => forge.client }));
      const row = () => writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id) as unknown as JobRow;
      const owner = ownerId("foreground");
      for (let i = 0; i < 12 && row().state === "queued"; i++) await runOneBatch(writer, owner, { only: new Set([job.id]) });
      const result = row();
      expect(result.state, result.reason ?? "").toMatch(/^done/u);
      const counts = JSON.parse(result.checkpoint!).v2.counts;
      expect(counts).toMatchObject({ "harvested.review-thread": 1, "triage-kept": 1 });
      expect(forge.fetch.mock.calls.some(([, init]) => String(init?.body).includes(`p0:pullRequest(number:${pr})`))).toBe(true);
      return { result, counts, model, rows: reviewRows(writer, project, job.id), wording };
    }

    const first = await learn(false);
    expect(first.rows).toHaveLength(1);
    const id = first.rows[0]!.entryId;
    expect(first.rows[0]).toMatchObject({ support: 1, status: decision === "leave waiting" ? "proposed" : "active" });
    if (decision.startsWith("forget")) {
      forget(id, "Dropped the lesson", { projectPath: checkout, home: writer.location.home });
      expect(writer.setting(project, `knowledge.retired.${id}`)).toBeTruthy();
    } else if (decision === "legacy forget") {
      const entry = parseEntry(snapshotNotes(writer, project).files.get(id)!);
      writer.db.exec("BEGIN IMMEDIATE");
      saveTombstone(writer, project, entry, { reason: "Dropped before the entry was updated", by: "mex forget", at: "2026-11-14" });
      writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?").run(project, noteKey(id));
      writer.db.exec("COMMIT");
    } else if (decision === "legacy untick") {
      const entry = parseEntry(snapshotNotes(writer, project).files.get(id)!);
      writeFileSync(join(writer.location.home, "projects", project, "notes", `${id}.md`),
        serializeEntry({ ...entry, mex: { ...entry.mex, status: "proposed" } }));
    } else {
      const keys = decision === "untick" ? ["1", "enter"] : ["enter"];
      expect(await reviewLearned({ root: checkout, projectId: project, write: () => {}, mode: { plain: true, ascii: true, color: false, width: 80 },
        interactive: true, env: process.env, home: writer.location.home, keys: async () => keys.shift() ?? "quit" })).toEqual({ kept: 0, waiting: 1, dropped: 0 });
      expect(!!writer.setting(project, learnedRefusalKey(id))).toBe(decision === "untick");
    }

    const before = [...snapshotNotes(writer, project).files];
    const later = await learn(true);
    expect(later.wording).not.toBe(claim);
    const after = [...snapshotNotes(writer, project).files];
    const edited = () => {
      const hook = (event: string, payload: Record<string, unknown>) => execFileSync(binary, ["claude-code", event], {
        encoding: "utf8", timeout: 20_000, input: JSON.stringify({ session_id: "after-drop", cwd: checkout, hook_event_name: event, ...payload }),
      });
      hook("SessionStart", { source: "startup" });
      return hook("PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(checkout, path),
        old_string: "  return stable(label);", new_string: "  return fallback(label);" } });
    };
    const written = later.model.mock.calls.filter(([request]) => request.purpose === LEARN_KIND);
    if (decision === "forget, then a different lesson") {
      // Kept, because it is another lesson; not switched on, because the person refused one about the same thing.
      expect(written).toHaveLength(1);
      expect(written[0]![0].prompt).toContain(`"refusedByTeam":${JSON.stringify([claim])}`);
      expect(later.counts).toMatchObject({ "cluster.near-refused": 1, saved: 1, proposed: 1 });
      expect(later.rows).toMatchObject([{ claim: later.wording, proven: true, status: "proposed" }]);
      expect(later.rows[0]!.entryId).not.toBe(id);
      expect(edited()).not.toContain("deny");
    } else if (decision === "forget, then the same trigger") {
      expect(written).toHaveLength(1);
      expect(later.counts).toMatchObject({ "cluster.forgotten": 1 });
      expect(later.rows).toEqual([]);
      expect(after).toEqual(before);
      expect(edited()).not.toContain("deny");
    } else if (decision === "leave waiting") {
      expect(later.rows).toMatchObject([{ entryId: id, claim: later.wording, support: 2, status: "active" }]);
      expect(later.model.mock.calls.some(([request]) => request.purpose === LEARN_KIND)).toBe(true);
      expect(parseEntry(new Map(after).get(id)!).mex.status).toBe("active");
    } else {
      expect(later.model.mock.calls.map(([request]) => request.purpose)).toEqual(["learn-deeper-filter"]);
      expect(later.counts).toMatchObject({ "cluster.forgotten": 1 });
      expect(later.counts["tokens.write"] ?? 0).toBe(0);
      expect(later.result.results).toBe(0);
      expect(later.rows).toEqual([]);
      expect(after).toEqual(before);
      expect(parseEntry(new Map(after).get(id)!).mex.status).toBe(
        decision === "forget" ? "retired" : decision === "legacy forget" ? "active" : "proposed");

      const hook = (event: string, payload: Record<string, unknown>) => execFileSync(binary, ["claude-code", event], {
        encoding: "utf8", timeout: 20_000, input: JSON.stringify({ session_id: "after-review", cwd: checkout, hook_event_name: event, ...payload }),
      });
      hook("SessionStart", { source: "startup" });
      expect(hook("PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(checkout, path),
        old_string: "  return stable(label);", new_string: "  return fallback(label);" } })).not.toContain("deny");
    }
  } finally { writer.close(); }
}, 120_000);
