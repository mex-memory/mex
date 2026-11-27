import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { setCheckoutEnabled, setPolicy } from "../../controls/index.js";
import { buildIndex } from "../../file-index/build.js";
import { runCheck } from "../../knowledge/check.js";
import { parseEntry } from "../../knowledge/entry.js";
import { propose } from "../../knowledge/gate.js";
import { LEARNED_ALWAYS_ON_SETTING } from "../../knowledge/learned-scope.js";
import { forget, tickLearned } from "../../knowledge/mutations.js";
import { snapshotNotes } from "../../knowledge/personal-store.js";
import type { runModel } from "../../model-runner/index.js";
import { queueJob } from "../../record/background.js";
import { openRecord } from "../../record/index.js";
import { ownerId, registerJobKind, runOneBatch, type JobRow } from "../../record/jobs.js";
import { ZERO } from "../../record/usage.js";
import { runRepoStart } from "../../repo-start/command.js";
import { reviewLearned } from "../../repo-start/review-list.js";
import { ForgeClient } from "../forge.js";
import { PinnedTree } from "../git.js";
import { planHarvest, previewHarvest } from "../harvest/index.js";
import { createLearnKind } from "../job.js";
import { gateReply, isGatePrompt } from "./fixtures/gate.js";
import { readObservations } from "../observations.js";
import { learnedTrialKey, reviewRows, trialReceiptKey } from "../pipeline.js";
import { LEARN_KIND, Plan } from "../plan.js";
import { SCHEDULE, WEEKLY_KIND } from "../weekly-schedule.js";
import { LEARNED_TRIAL_LABEL } from "../trial-outcomes.js";

const reply = (value: unknown) => ({ text: JSON.stringify(value), selectedModel: "fixture", usage: { ...ZERO, model: "fixture-2026-11", estimated: false } });
const adapter = "src/changed.ts";
const proofClaim = "Use the stable adapter for changedEntry instead of calling fallback.";
const guidance = "Use `queueTransport` for retry dispatch in `src/changed.ts`.";
const repeatGuidance = "Leave this on `queueTransport` because retry dispatch must stay serialized.";
const policyClaim = "Route retry dispatch through `queueTransport` in `src/changed.ts`.";
const docQuote = "Keep the verification report in `src/verification.txt` when changing the renderer.";
const docClaim = "Keep the renderer verification report in `src/verification.txt`.";
const docScope = "src/**/verification.{txt,md}";
const submissionQuote = "Please read our [AI policy](AI_POLICY.md) if you use AI on a pull request.";
const submissionClaim = "Read `AI_POLICY.md` if you use AI on a pull request.";
const duplicate = "Use `renderFrame` for all adapter frames.";
const weeklyHint = "Keep `MAX_ATTEMPTS` at three in the retry package.";
const weeklyRepeat = "Leave `MAX_ATTEMPTS` at three, since a fourth attempt repeats an external write.";
const weeklyClaim = "Keep the retry limit at three in `MAX_ATTEMPTS`.";
const missingQuote = "Keep `dispatchReceipt` calls outside the adapter transaction.";
const missingClaim = "Call `dispatchReceipt` outside adapter transactions.";

let binary: string, built: string | undefined;
beforeAll(() => {
  binary = process.env.MEX_HOOK_BINARY ?? "";
  if (binary) return;
  built = mkdtempSync(join(tmpdir(), "mex-learn-e2e-hook-"));
  binary = join(built, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterEach(() => {
  vi.unstubAllEnvs();
  registerJobKind(createLearnKind());
  registerJobKind(createLearnKind({}, true));
});
afterAll(() => { if (built) rmSync(built, { recursive: true, force: true }); });

const recorded = readFileSync(new URL("./fixtures/harvest/changes.json", import.meta.url), "utf8");
const reviewed: string[] = JSON.parse(recorded).originalLines;
const source = { host: "github.com" as const, slug: "acme/app" };
function discussion(id: number, body: string, createdAt: string, maintainer = true) {
  return { id: "IC_fixture" + id, fullDatabaseId: id, body, createdAt, isMinimized: false,
    authorAssociation: maintainer ? "OWNER" : "CONTRIBUTOR",
    author: { __typename: "User", login: maintainer ? "cedar-owner" : "iris-dev", name: maintainer ? "Cedar Example" : "Iris Example" } };
}
function pull(number: number, at: string, texts: ReturnType<typeof discussion>[], commits: { before: string; after: string }, thread = false) {
  const pr = JSON.parse(recorded.replaceAll("OID_ORIGINAL", commits.before).replaceAll("OID_MERGE", commits.after)).merged;
  pr.number = number;
  pr.mergedAt = pr.closedAt = at;
  pr.changedFiles = 1;
  pr.files = { nodes: [{ path: adapter }] };
  pr.body = "";
  pr.comments = { nodes: texts, totalCount: texts.length };
  pr.reviews = { nodes: [{
    ...discussion(900 + number, "", at), submittedAt: at, authorCanPushToRepository: true,
  }], totalCount: 1 };
  pr.reviewThreads.nodes = thread ? pr.reviewThreads.nodes.slice(0, 1) : [];
  pr.reviewThreads.totalCount = pr.reviewThreads.nodes.length;
  if (thread) {
    const original = pr.reviewThreads.nodes[0].comments.nodes[0];
    original.body = proofClaim;
    pr.reviewThreads.nodes[0].comments.nodes = [original];
    pr.reviewThreads.nodes[0].comments.totalCount = 1;
  }
  return pr;
}

it("delivers checked trial rules, withholds removed evidence, and learns a repeated policy weekly", async () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "mex-learn-e2e-")));
  const home = join(fixture, ".mex"), root = join(fixture, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  function commit(message: string, date: string) {
    vi.stubEnv("GIT_COMMITTER_DATE", date);
    git("add", ".");
    git("-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", message, "--date", date);
    return git("rev-parse", "HEAD");
  }
  for (const [name, value] of Object.entries({ MEX_HOME: fixture, MEX_HOOK_BINARY: binary, MEX_BACKGROUND: "0", MEX_OFF: "", MEX_OFFLINE: "1",
    CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), GH_TOKEN: "forge-fixture-token" })) vi.stubEnv(name, value);
  git("init", "-qb", "main");
  git("remote", "add", "origin", "https://github.com/acme/app.git");
  writeFileSync(join(root, "AGENTS.md"), duplicate + "\n");
  writeFileSync(join(root, "src", "verification.txt"), "Fixture\n");
  writeFileSync(join(root, "CONTRIBUTING.md"), "# Development\n\n" + docQuote + "\n\n" + submissionQuote + "\n");
  writeFileSync(join(root, "AI_POLICY.md"), "# AI Usage Policy\n\nDisclose assistance in the pull request.\n");
  writeFileSync(join(root, adapter), reviewed.join("\n") + "\n");
  const before = commit("Prepare the adapter change", "2026-11-11T10:00:00Z");
  writeFileSync(join(root, adapter), reviewed.join("\n").replace("fallback(label)", "stable(label)") + "\n");
  const after = commit("Wire the stable adapter (#31)", "2026-11-13T10:00:00Z");
  const first = pull(31, "2026-11-13T10:00:00Z", [
    discussion(101, guidance, "2026-11-12T12:00:00Z"), discussion(102, weeklyHint, "2026-11-12T13:00:00Z"),
    discussion(103, duplicate, "2026-11-12T14:00:00Z"), discussion(104, missingQuote, "2026-11-12T15:00:00Z"),
    discussion(105, "Please delete the verification report.", "2026-11-12T16:00:00Z", false),
  ], { before, after }, true);
  const second = pull(40, "2026-11-19T10:00:00Z", [discussion(201, repeatGuidance, "2026-11-18T10:00:00Z")], { before, after });
  const later = pull(53, "2026-11-24T10:00:00Z", [discussion(301, weeklyRepeat, "2026-11-23T10:00:00Z")], { before, after });
  let head = after, pulls = [first, second], now = Date.parse("2026-11-20T10:00:00Z");
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/repos/acme/app") return Response.json({ full_name: "acme/app", default_branch: "main", private: false });
    if (path === "/repos/acme/app/branches/main") return Response.json({ commit: { sha: head } });
    if (path === "/repos/acme/app/collaborators/cedar-owner/permission") return Response.json({ permission: "write" });
    if (path !== "/graphql") throw Error("Unexpected fixture path " + path);
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
    if (query.includes("HarvestSearch(")) {
      return Response.json({ data: Object.fromEntries(Object.entries(variables).flatMap(([key, term]) => {
        const match = /^q(\d+)$/u.exec(key);
        if (!match) return [];
        const dates = /merged:([^ ]+)\.\.([^ ]+)$/u.exec(term);
        const nodes = dates ? pulls.filter(pr => Date.parse(pr.mergedAt) >= Date.parse(dates[1]!) && Date.parse(pr.mergedAt) <= Date.parse(dates[2]!)) : [];
        return [["s" + match[1], { issueCount: nodes.length, nodes, pageInfo: { hasNextPage: false } }]];
      })) });
    }
    const repository = Object.fromEntries([...query.matchAll(/(p\d+):pullRequest\(number:(\d+)\)/gu)]
      .map(([, alias, number]) => [alias, pulls.find(pr => pr.number === Number(number)) ?? null]));
    return Response.json({ data: { repository } });
  });
  const client = new ForgeClient(source, "fixture-login", fetch);
  const model = vi.fn<typeof runModel>(async request => {
    const { prompt } = request;
    expect(prompt).not.toMatch(/Iris Example|Cedar Example|Fern Example/u);
    if (request.role === "cheap") {
      const observations = [...prompt.matchAll(/^\[(i\d+)\] (?:maintainer(?: \(PR author\))?)(?: \([^\n]+\))?: ([^\n]+)/gmu)].flatMap(([, item, quote]) => {
        if (quote === guidance || quote === repeatGuidance) return [{ item, quote, norm: policyClaim, kind: "placement", scope: [adapter],
          form: quote === guidance ? "stated" : "decision", why: quote === guidance ? "" : "Retry dispatch must stay serialized.",
          stated_as_rule: false, response: "unknown" }];
        if (quote === weeklyHint || quote === weeklyRepeat) return [{ item, quote, norm: weeklyClaim, kind: "api-design", scope: [adapter],
          form: "decision", why: "A fourth attempt repeats an external write.", stated_as_rule: false, response: "unknown" }];
        if (quote === proofClaim || quote === missingQuote || quote === duplicate) return [{ item, quote, norm: quote === missingQuote ? missingClaim : quote,
          kind: "api-design", scope: [adapter], form: "stated", why: "", stated_as_rule: true, response: "changed" }];
        return [];
      });
      return reply({ observations });
    }
    if (prompt.startsWith("You turn observations")) {
      const items = prompt.split("\n").filter(line => line.startsWith('{"id":"sha256:')).map(line => JSON.parse(line));
      const groups = new Map<string, Array<{ id: string; norm: string; kind: string; stated_as_rule: boolean }>>();
      for (const item of items) {
        const group = groups.get(item.norm) ?? [];
        group.push(item);
        groups.set(item.norm, group);
      }
      return reply({ policies: [], norms: [...groups].flatMap(([text, items]) => items.length > 1 || items[0].stated_as_rule ? [{
        text, kind: items[0].kind, scope: [adapter], support: items.map(item => item.id), patternable: text === proofClaim,
      }] : []) });
    }
    if (prompt.startsWith("You read the contributor documentation")) {
      if (!prompt.includes(docQuote)) return reply({ rules: [] });
      expect(prompt).toContain("=== FILE AI_POLICY.md");
      return reply({ rules: [{ text: docClaim, kind: "docs-comments", scope: [docScope], source: "CONTRIBUTING.md", quote: docQuote }] });
    }
    if (prompt.startsWith("Find a code pattern")) {
      const items = JSON.parse(prompt.split("\n").at(-1)!);
      expect(items).toHaveLength(1);
      return reply({ patterns: [{ id: items[0].id, when: [{ type: "anti", match: "literal", pattern: "fallback(" }],
        fix: { pair: 0, start: 3, end: 3 }, examples: { flag: "return fallback(label);", ok: "return stable(label);" } }] });
    }
    expect(isGatePrompt(prompt)).toBe(true);
    return reply(gateReply(prompt, rule => {
      if (rule.text === submissionClaim) expect(prompt).toContain(JSON.stringify({ path: "CONTRIBUTING.md", quote: submissionQuote }));
      if (rule.text.startsWith(missingClaim)) return undefined;
      return rule.text.startsWith(duplicate) ? { verdict: "drop-duplicate", duplicateOf: "AGENTS.md:1" } : { verdict: "keep" };
    }));
  });
  await runRepoStart({ cwd: root, write: () => {}, caller: "script", install: false, wait: false });
  const writer = openRecord({ projectPath: root, home });
  try {
    const { path: checkout, project_id: project } = writer.checkout(root)!;
    setCheckoutEnabled(writer, checkout, true);
    const index = () => buildIndex({ root: checkout, projectId: project, recordDirectory: writer.location.directory, workers: 0 });
    await index();
    registerJobKind(createLearnKind({ client: async () => client, model, now: () => now }));
    registerJobKind(createLearnKind({ client: async () => client, model, now: () => now }, true));
    const window = { since: "2026-11-01T00:00:00.000Z", until: new Date(now).toISOString() };
    const tree = (await PinnedTree.open(checkout, head))!;
    const harvest = await previewHarvest(await planHarvest({ checkout, head, source, agent: "codex", ...window }, { client, tree }), { client, tree });
    const plan = Plan.parse({ checkout, head, origin: source, source, agent: "codex", setup: "mixed", visibility: "public", ...window,
      preferred: [], pulls: [], docs: [], gaps: [], refresh: true, estimate: harvest.estimate, ceiling: harvest.ceiling, harvest });
    async function run(kind: string, params: unknown) {
      const { job } = queueJob(writer, { kind, projectId: project, params });
      const get = () => writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id) as unknown as JobRow;
      for (let i = 0; i < 55 && get().state === "queued"; i++) await runOneBatch(writer, ownerId("foreground"), { only: new Set([job.id]) });
      const row = get();
      expect(row.state, String(row.reason)).toMatch(/^done/u);
      return { job, rows: reviewRows(writer, project, job.id), receipt: JSON.parse(writer.setting(project, trialReceiptKey(job.id))!) };
    }
    const initial = await run(LEARN_KIND, plan);
    expect(initial.rows.map(row => row.claim).sort()).toEqual([policyClaim, proofClaim, docClaim, missingClaim, submissionClaim].sort());
    const rule = initial.rows.find(row => row.claim === proofClaim)!;
    const doc = initial.rows.find(row => row.claim === docClaim)!;
    const policy = initial.rows.find(row => row.claim === policyClaim)!;
    expect(policy).toMatchObject({ support: 2, status: "active" });
    expect(rule).toMatchObject({ support: 1, status: "active", proven: true });
    expect(doc).toMatchObject({ status: "active" });
    const submission = initial.rows.find(row => row.claim === submissionClaim)!;
    const savedSubmission = parseEntry(snapshotNotes(writer, project).files.get(submission.entryId)!);
    expect(savedSubmission.mex).toMatchObject({ status: "active", kind: "rule", scope: ["**"],
      source: { type: "docs", ref: "CONTRIBUTING.md" } });
    expect(initial.rows.find(row => row.claim === missingClaim)?.status).toBe("proposed");
    expect(initial.receipt.counts).toMatchObject({ "gate.drop-duplicate": 1, "gate.missing": 1, "calls.gate": 2, "proven-code-norms": 1 });
    expect(writer.db.prepare("SELECT count(*) n FROM settings WHERE key LIKE ?").get("learning.deep.v2." + initial.job.id + ".%")?.n).toBe(0);
    expect(readObservations(writer.db, project, window.since, true).some(item => item.norm === weeklyClaim)).toBe(true);
    expect(writer.setting(project, learnedTrialKey(policy.entryId))).toBe("trial");
    await index();
    function hook(session: string, event: string, payload: Record<string, unknown> = {}) {
      return execFileSync(binary, ["claude-code", event], { cwd: root, encoding: "utf8", timeout: 20_000,
        input: JSON.stringify({ session_id: session, cwd: root, hook_event_name: event, ...payload }) });
    }
    function read(session: string, path: string) {
      hook(session, "SessionStart", { source: "startup" });
      return hook(session, "PostToolBatch", { tool_calls: [{ tool_name: "Read", tool_input: { file_path: join(checkout, path) },
        tool_use_id: path, tool_response: readFileSync(join(checkout, path), "utf8") }] });
    }
    expect(runCheck({ home, projectPath: checkout }).entries.find(item => item.id === policy.entryId)?.verdict).toBe("held");
    const delivered = read("policy", adapter);
    expect(delivered).toContain(policyClaim);
    expect(delivered).toContain("[learned, trial]");
    const edit = (current: string) => ({ tool_name: "Edit", tool_input: { file_path: join(checkout, adapter),
      old_string: "  return " + current + "(label);", new_string: "  return fallback(label);" } });
    expect(hook("bump", "SessionStart", { source: "startup" })).not.toContain(proofClaim);
    const deny = hook("bump", "PreToolUse", edit("stable"));
    expect(deny).toContain("deny");
    expect(deny).toContain("return stable(label);");
    expect(deny).toContain("learned, trial");
    expect(runCheck({ home, projectPath: checkout }).entries.find(item => item.id === doc.entryId)?.verdict).toBe("held");
    expect(parseEntry(snapshotNotes(writer, project).files.get(doc.entryId)!).mex.scope).toEqual([docScope]);
    expect(read("doc-outside", adapter)).not.toContain(docClaim);
    expect(read("doc-in-scope", "src/verification.txt")).toContain(docClaim);
    const keys = ["enter"];
    const reviewLines: string[] = [];
    const reviewed = await reviewLearned({ root: checkout, projectId: project, write: line => reviewLines.push(line), home, env: process.env,
      interactive: true, mode: { width: 80, plain: true, ascii: true, color: false }, keys: async () => keys.shift() ?? "quit" });
    expect(reviewed).toEqual({ kept: 0, trials: 4, waiting: 1, dropped: 0 });
    expect(reviewLines.join(" ")).toContain(policyClaim);
    expect(reviewLines).toContain("Repo-wide trials");
    expect(writer.setting(project, learnedTrialKey(policy.entryId))).toBe("trial");
    expect(parseEntry(snapshotNotes(writer, project).files.get(policy.entryId)!).mex).toMatchObject({
      status: "active", source: { label: expect.stringContaining(LEARNED_TRIAL_LABEL) },
    });
    tickLearned(initial.rows.find(row => row.claim === missingClaim)!.entryId, { home, projectPath: checkout });
    writeFileSync(join(checkout, adapter), readFileSync(join(checkout, adapter), "utf8").replace("stable(label)", "transport(label)"));
    writeFileSync(join(checkout, "CONTRIBUTING.md"), "# Development\n\nRenderer rules moved.\n");
    head = commit("Remove the old adapter and renderer guidance", "2026-11-23T10:00:00Z");
    await index();
    hook("after", "SessionStart", { source: "startup" });
    expect(hook("after", "PreToolUse", edit("transport"))).not.toContain("deny");
    expect(read("doc-after", "src/verification.txt")).not.toContain(docClaim);
    expect(runCheck({ home, projectPath: checkout }).entries.find(item => item.id === doc.entryId)?.verdict).toBe("broken");
    forget(policy.entryId, "The rule was withdrawn.", { home, projectPath: checkout });
    expect(readObservations(writer.db, project, window.since).filter(item => item.normId === policy.entryId).map(item => item.forgotten)).toEqual([true, true]);

    // The hook stamps sessions with the wall clock, so "a week later" must also be past the real session
    // idle window, or the weekly run waits for agents that are only this test's own hook calls.
    now = Math.max(Date.parse("2026-11-27T10:00:00Z"), Date.now() + 11 * 60_000);
    pulls = [first, second, later];
    const weekly = await run(WEEKLY_KIND, JSON.parse(writer.setting(project, SCHEDULE)!));
    expect(weekly.rows).toMatchObject([{ claim: weeklyClaim, support: 2, status: "active" }]);
    expect(weekly.receipt.counts).toMatchObject({ "observations.conversation": 1, "gate.keep": 1 });

    const aging = await propose([{
      producer: "learn-deeper", key: "old-trial", kind: "rule", text: "Run the sparrow migration before refreshing the manifest.",
      source: { type: "review", ref: "https://github.com/acme/app/pull/57" },
      evidenceClass: "review", model: "none", label: LEARNED_TRIAL_LABEL + "Fixture",
      anchors: { scope: ["**"] }, checks: [{ kind: "scope", role: "complete", target: { glob: "**" } }],
    }, {
      producer: "learn-deeper", key: "old-broad-trial", kind: "rule", text: "Keep dispatch receipts in their own TypeScript module.",
      source: { type: "review", ref: "https://github.com/acme/app/pull/58" },
      evidenceClass: "review", model: "none", label: LEARNED_TRIAL_LABEL + "Fixture",
      anchors: { scope: ["**/*.ts"] }, checks: [{ kind: "scope", role: "complete", target: { glob: "**" } }],
    }, {
      producer: "learn-deeper", key: "old-anchored-trial", kind: "rule", text: "Restrict dispatch receipts to the sparrow queue.",
      source: { type: "mined", ref: "fixture" }, evidenceClass: "mined", model: "none", label: LEARNED_TRIAL_LABEL + "Fixture",
      anchors: { scope: [adapter] }, checks: [{ kind: "scope", role: "complete", target: { glob: adapter } }],
    }], { home, projectPath: checkout, now: new Date(now - 90 * 86_400_000) });
    const [old, broad, anchored] = aging;
    if (old?.status !== "accepted" || broad?.status !== "accepted" || anchored?.status !== "accepted") throw new Error(JSON.stringify(aging));
    const ageReview = (id: string) => writer.db.prepare("SELECT reason, state FROM review WHERE project_id=? AND id GLOB ?").get(project, `learning.upkeep.age.${id}.*`);
    const calls = model.mock.calls.length;
    expect(writer.setting(project, LEARNED_ALWAYS_ON_SETTING)).toBeUndefined();
    now += 7 * 86_400_000;
    await run(WEEKLY_KIND, JSON.parse(writer.setting(project, SCHEDULE)!));
    expect(ageReview(old.entryId)).toBeUndefined();
    expect(ageReview(broad.entryId)).toBeUndefined();
    expect(parseEntry(snapshotNotes(writer, project).files.get(old.entryId)!).mex.status).toBe("active");
    expect(parseEntry(snapshotNotes(writer, project).files.get(broad.entryId)!).mex.status).toBe("active");

    setPolicy(writer, project, LEARNED_ALWAYS_ON_SETTING, true);
    now += 7 * 86_400_000;
    await run(WEEKLY_KIND, JSON.parse(writer.setting(project, SCHEDULE)!));
    const notes = snapshotNotes(writer, project).files;
    for (const { entryId } of [old, broad]) {
      expect(ageReview(entryId)).toMatchObject({ reason: "This rule has gone 90 days without verification.", state: "pending" });
      expect(parseEntry(notes.get(entryId)!).mex.status).toBe("active");
      expect(writer.setting(project, `knowledge.retired.${entryId}`)).toBeUndefined();
    }
    expect(ageReview(anchored.entryId)).toBeUndefined();
    expect(parseEntry(notes.get(anchored.entryId)!).mex.status).toBe("active");
    expect(model).toHaveBeenCalledTimes(calls);
  } finally {
    writer.close();
    rmSync(fixture, { recursive: true, force: true });
  }
}, 180_000);
