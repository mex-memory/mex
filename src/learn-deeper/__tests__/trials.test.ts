import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { setCheckoutEnabled } from "../../controls/index.js";
import { buildIndex } from "../../file-index/build.js";
import { createJudgeKind } from "../../judge/job.js";
import { evaluate, nativeRequest, recordChecks } from "../../judge/native.js";
import { runJudgeSync } from "../../judge/sync.js";
import { propose } from "../../knowledge/gate.js";
import { parseEntry } from "../../knowledge/entry.js";
import { tickLearned } from "../../knowledge/mutations.js";
import { snapshotNotes } from "../../knowledge/personal-store.js";
import { recallLearned } from "../../knowledge/recall-learned.js";
import type { runModel } from "../../model-runner/index.js";
import { openHooksReadOnly, openRecord } from "../../record/index.js";
import { enqueueJob, ownerId, registerJobKind, runOneBatch, type JobRow } from "../../record/jobs.js";
import { shortHash } from "../../record/project.js";
import { ZERO } from "../../record/usage.js";
import type { Candidate, HarvestPlan } from "../harvest/types.js";
import { createLearnKind } from "../job.js";
import { initialState, reviewRows, trialReceiptKey } from "../pipeline.js";
import { prUnits } from "../pr-units.js";
import { sourceDigest } from "../source.js";
import { LEARN_KIND, Plan } from "../plan.js";
import { procedureEstimate, procedureGroups } from "../procedures.js";
import { createStopCheckKind, diffLocations, queueStopChecks, STOP_CHECK, stopCheckFlags } from "../stop-check.js";
import { setLearningTrial } from "../trial-settings.js";

let suite: string, binary: string;
beforeAll(() => {
  suite = mkdtempSync(join(tmpdir(), "mex-learning-trials-"));
  binary = process.env.MEX_HOOK_BINARY ?? join(suite, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  if (!process.env.MEX_HOOK_BINARY) execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 250_000);
afterAll(() => { if (suite) rmSync(suite, { recursive: true, force: true }); });

function fixture() {
  const base = mkdtempSync(join(suite, "case-"));
  const root = join(base, "repo"), home = join(base, ".mex");
  mkdirSync(root);
  const env = { ...process.env, MEX_HOME: base, MEX_HOOK_BINARY: binary, MEX_BACKGROUND: "0", MEX_OFFLINE: "1" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env }).trim();
  git("init", "-qb", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("remote", "add", "origin", "https://github.com/acme/service.git");
  for (const area of ["api", "sdk"]) mkdirSync(join(root, area));
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(root, "api", "endpoint.ts"), `export const endpoint = ${i};\n`);
    writeFileSync(join(root, "sdk", "client.ts"), `export const client = ${i};\n`);
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", `Update endpoint and client ${i}`);
  }
  vi.stubEnv("MEX_HOOK_BINARY", binary);
  vi.stubEnv("MEX_HOME", base);
  const writer = openRecord({ home, projectPath: root, isNetwork: () => false });
  const checkout = setCheckoutEnabled(writer, root, true);
  const project = checkout.project_id, head = git("rev-parse", "HEAD");
  const close = () => { writer.close(); vi.unstubAllEnvs(); };
  const index = () => buildIndex({ root, projectId: project, recordDirectory: writer.location.directory, workers: 0 });
  const hook = (session: string, name: string, extra: Record<string, unknown> = {}) => execFileSync(binary, ["claude-code", name], {
    env, cwd: root, encoding: "utf8", timeout: 20_000, input: JSON.stringify({ session_id: session, cwd: root, hook_event_name: name, ...extra }),
  });
  return { base, home, root, checkout: checkout.path, project, head, writer, index, close, hook, git };
}
type Fixture = ReturnType<typeof fixture>;
const modelReply = (value: unknown) => ({ text: JSON.stringify(value), selectedModel: "fixture", usage: { ...ZERO, model: "fixture", estimated: false } }) as Awaited<ReturnType<typeof runModel>>;
const knowledgeOptions = (f: Fixture) => ({ home: f.home, projectPath: f.checkout });
const judgeRequest = (f: Fixture) => ({ checkout: f.checkout, project_id: f.project, mex_home: f.home,
  record_directory: f.writer.location.directory });

it.each([
  ["unrelated edit", "held", 0],
  ["reworded passage", "changed", 1],
  ["removed passage", "broken", 1],
] as const)("checks a learned doc rule after an %s", async (change, verdict, calls) => {
  const f = fixture();
  try {
    const doc = "CONTRIBUTING.md", file = join(f.root, doc);
    const passage = "Route all public requests through the stable adapter so offline callers get the same response.";
    const claim = "Use the stable adapter for public requests.";
    const options = knowledgeOptions(f);
    const original = "# Adapters\n\n" + passage + "\n\n# Setup\n\nUse the sample workspace.\n";
    writeFileSync(file, original);
    f.git("add", doc);
    f.git("-c", "commit.gpgsign=false", "commit", "-qm", "Document the adapter");
    await f.index();
    const [saved] = await propose([{ producer: "learn-deeper", key: doc, kind: "rule", text: claim,
      source: { type: "docs", ref: doc }, evidenceClass: "docs", model: "none", anchors: { scope: [doc] },
      checks: [{ kind: "scope", role: "complete", target: { glob: doc } },
        { kind: "quote", role: "complete", target: { file: doc, exact: passage, heading: "Adapters", prefix: "", suffix: "" } }],
    }], options);
    expect(saved).toMatchObject({ status: "accepted" });
    if (saved?.status !== "accepted") throw Error(JSON.stringify(saved));
    const id = saved.entryId;
    expect(recallLearned(id, options)).toMatchObject({ verdict: "held", action: "given", claim });
    const updated = change === "unrelated edit" ? original.replace("sample workspace", "shared workspace")
      : original.replace(passage, change === "removed passage" ? "The examples below illustrate release tags." : passage.replace("same response", "same result"));
    writeFileSync(file, updated);
    await f.index();
    await nativeRequest({ ...judgeRequest(f), action: "evaluate", store: true });
    const action = verdict === "held" ? "given" : verdict === "changed" ? "replaced" : "withheld";
    expect(recallLearned(id, options)).toMatchObject({ verdict, action });
    f.hook("doc", "SessionStart", { source: "startup" });
    const advice = f.hook("doc", "PostToolBatch", { tool_calls: [{ tool_name: "Read", tool_input: { file_path: file }, tool_response: updated }] });
    if (verdict === "held") expect(advice).toContain(claim);
    else expect(advice).not.toContain(claim);
    if (verdict === "changed") expect(advice).toContain(`mex recall ${id}`);
    if (verdict === "broken") expect(advice).not.toContain(id);
    const model = vi.fn<typeof runModel>(async request => {
      expect(request.prompt).toContain(id);
      expect(request.prompt).toContain(verdict === "changed" ? "the quoted passage was edited" : "the quoted passage no longer exists");
      return modelReply({ results: [{ id, result: "cannot-tell" }] });
    });
    registerJobKind(createJudgeKind({ evaluate, recordChecks, model }));
    expect((await runJudgeSync(options, { available: () => true, write: () => {} }))?.state).toMatch(/^done/u);
    expect(model).toHaveBeenCalledTimes(calls);
  } finally { registerJobKind(createJudgeKind()); f.close(); }
}, 60_000);

it("updates the target and scope of a personal learned rule when its indexed symbol moves", async () => {
  const f = fixture();
  try {
    const original = "api/endpoint.ts", moved = "api/moved.ts", options = knowledgeOptions(f);
    await f.index();
    const [saved] = await propose([{ producer: "learn-deeper", key: "endpoint-move", kind: "rule",
      text: "Use the named endpoint so handlers share the same route.",
      source: { type: "review", ref: "https://github.com/acme/service/pull/1" }, evidenceClass: "review", model: "none",
      anchors: { scope: [original], symbols: [{ file: original, symbol: "endpoint" }] },
      checks: [{ kind: "scope", role: "complete", target: { glob: original } }],
    }], options);
    expect(saved).toMatchObject({ status: "accepted" });
    if (saved?.status !== "accepted") throw Error(JSON.stringify(saved));
    const id = saved.entryId;
    f.git("mv", original, moved);
    f.git("-c", "commit.gpgsign=false", "commit", "-qm", "Move the endpoint");
    await f.index();
    const report = await evaluate(judgeRequest(f));
    expect(report.results?.find(result => result.entry_id === id)?.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "symbol", status: "pass", relink: { file: moved, symbol: "endpoint" } }),
    ]));
    const model = vi.fn<typeof runModel>(async () => { throw Error("Relocation requires no judge call."); });
    registerJobKind(createJudgeKind({ evaluate, recordChecks, model }));
    expect((await runJudgeSync(options, { available: () => true, write: () => {} }))?.state).toBe("done");
    expect(model).not.toHaveBeenCalled();
    const refreshed = parseEntry(snapshotNotes(f.writer, f.project).files.get(id)!);
    expect(refreshed.mex.scope).toEqual([moved]);
    expect(refreshed.mex.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "symbol", target: { file: moved, symbol: "endpoint" } }),
      expect.objectContaining({ kind: "scope", target: { glob: moved } }),
    ]));
    expect(recallLearned(id, options)).toMatchObject({ verdict: "held", action: "given" });
  } finally { registerJobKind(createJudgeKind()); f.close(); }
}, 60_000);

async function runLearning(f: Fixture, model: typeof runModel, state: ReturnType<typeof initialState>, candidates: Candidate[] = [], procedures = false) {
  const { writer, project, checkout, head } = f;
  const repo = { host: "github.com", slug: "acme/service" } as const;
  const sources = { mode: "backfill", ...(candidates.some(candidate => candidate.kind === "issue") ? { issues: true } : {}) } as HarvestPlan;
  const plan = Plan.parse({ checkout, head, origin: repo, source: repo, visibility: "public", agent: "codex", setup: "best-only",
    since: "2026-01-01T00:00:00.000Z", until: new Date().toISOString(), preferred: [], pulls: [], docs: [],
    sessions: [], refresh: false, gaps: [], estimate: 100_000, ceiling: 150_000, harvest: sources, ...(procedures ? { procedures: true } : {}) });
  registerJobKind(createLearnKind({ model }));
  const job = enqueueJob(writer, { kind: LEARN_KIND, projectId: project, params: plan }).job;
  writer.db.prepare("UPDATE jobs SET checkpoint=? WHERE id=?").run(JSON.stringify({ pull: 0, doc: 0, gaps: [], v2: state }), job.id);
  if (candidates.length) {
    const put = writer.db.prepare("INSERT INTO settings VALUES(?,?,?)");
    put.run(project, `learning.deep.v2.${job.id}.cand.0`, JSON.stringify(candidates));
    put.run(project, `learning.deep.v2.${job.id}.triage.units.0`, JSON.stringify(prUnits(candidates)));
  }
  for (let i = 0; i < 8; i++) {
    if (await runOneBatch(writer, ownerId("foreground"), { only: new Set([job.id]) }) === "idle") break;
  }
  const result = writer.db.prepare("SELECT state,reason FROM jobs WHERE id=?").get(job.id) as unknown as JobRow;
  expect(result.state, String(result.reason)).toBe("done");
  const summary = String(writer.db.prepare("SELECT summary FROM job_results WHERE job_id=? ORDER BY batch DESC LIMIT 1").get(job.id)?.summary);
  const raw = writer.setting(project, trialReceiptKey(job.id));
  return { job, summary, receipt: raw ? JSON.parse(raw) : undefined };
}

it("uses one cheap call for an opted-in, three-commit procedure and leaves it unticked", async () => {
  const f = fixture();
  try {
    await f.index();
    const model = vi.fn<typeof runModel>(async request => {
      expect(request).toMatchObject({ purpose: "learn-deeper-procedure", setup: "mixed", role: "cheap", projectRoot: f.checkout, automatic: { measuredUsageOnly: true } });
      expect(readdirSync(request.executionDirectory!)).toEqual([]);
      expect(request.prompt).toContain("Update endpoint and client 2");
      expect(request.prompt).toContain("api/endpoint.ts");
      expect(request.prompt).not.toContain("export const");
      return modelReply({ name: "Update an endpoint", steps: ["Update the endpoint.", "Update the SDK client."] });
    });
    const start = { ...initialState(), phase: "finish" as const };
    expect((await runLearning(f, model, start)).receipt.entries).toEqual([]);
    expect(model).not.toHaveBeenCalled();
    expect(procedureEstimate("codex")).toBeGreaterThan(0);
    setLearningTrial(f.writer, "learning.procedures", "on", f.root);
    const result = await runLearning(f, model, start, [], true);
    expect(model).toHaveBeenCalledTimes(1);
    const post = [...snapshotNotes(f.writer, f.project).files.values()].map(parseEntry);
    const entry = post.find(entry => entry.mex.kind === "procedure");
    expect(entry?.mex).toMatchObject({ status: "proposed", source: { label: "Named by a model from 3 commits" },
      when: [{ type: "creates", match: "literal", pattern: "api/*.ts" }, { type: "creates", match: "literal", pattern: "sdk/*.ts" }],
      checks: [{ kind: "scope", role: "complete" }] });
    expect(reviewRows(f.writer, f.project, result.job.id)).toMatchObject([{ entryId: entry!.mex.id, status: "proposed", route: "procedure" }]);
    expect(result.receipt).toMatchObject({ counts: { "trial.procedures": 1 }, entries: [{ id: entry!.mex.id, procedure: true }] });
    expect(result.summary).toContain("Counted 1 procedure waiting for a tick.");

    const create = (session: string, path: string) => {
      const file = join(f.root, path);
      writeFileSync(file, "export {};\n");
      return f.hook(session, "PostToolBatch", { tool_calls: [{ tool_name: "Write", tool_input: { file_path: file, content: "export {};\n" },
        tool_response: "File created successfully", tool_use_id: path }] });
    };
    expect(create("unticked", "api/other.ts")).not.toContain("Update an endpoint");
    tickLearned(entry!.mex.id, { home: f.home, projectPath: f.checkout });
    f.hook("followed", "SessionStart", { source: "startup" });
    expect(create("followed", "api/new.ts")).toContain("Update an endpoint");
    create("followed", "sdk/new.ts");
    f.hook("followed", "SessionEnd", { reason: "other" });
    f.hook("ignored", "SessionStart", { source: "startup" });
    expect(create("ignored", "api/another.ts")).toContain("Update an endpoint");
    f.hook("ignored", "SessionEnd", { reason: "other" });
    const hooks = openHooksReadOnly({ home: f.home });
    try {
      expect(hooks?.all(`SELECT d.session_id,w.acted,w.settled FROM deliveries d JOIN surface_windows w ON w.delivery_id=d.id
        WHERE d.entry_id=? AND d.moment='create' AND d.action='given' ORDER BY d.session_id`, entry!.mex.id)).toEqual([
        { session_id: "followed", acted: 1, settled: 1 }, { session_id: "ignored", acted: 0, settled: 1 },
      ]);
    } finally { hooks?.close(); }
  } finally { f.close(); }
}, 60_000);

it("discards tests-only, lockfile and generated associations", () => {
  const commits = [1, 2, 3].map(n => ({ hash: String(n), files: ["tests/a.test.ts", "specs/b.spec.ts", "package-lock.json", "gen/a.ts"] }));
  expect(procedureGroups(commits, () => true, new Set(["gen/a.ts"]))).toEqual([]);
});

it("keeps a separate count of issue candidates that pass sorting", async () => {
  const f = fixture();
  try {
    const issue = (n: number): Candidate => ({ id: `gh:issue:${n}`, kind: "issue", link: `https://github.com/acme/service/issues/${n}`,
      hash: `sha256:${"a".repeat(64)}`, nodeIds: [], at: "2026-05-01T00:00:00Z", text: "The old protocol omits the version handshake.",
      signal: "weak", reviewers: [], weights: { actedOn: false, familiar: false, guidelineLink: false, generalising: false, smallPr: false, hotUnknown: false } });
    const model = vi.fn<typeof runModel>(async request => {
      if (request.role === "best") return modelReply({ policies: [], norms: [] });
      return modelReply({ observations: [{ item: "i1", quote: "The old protocol omits the version handshake.",
        kind: "api-design", scope: "repo", norm: "Require the version handshake.", why: "",
        form: "stated", stated_as_rule: false, response: "unknown" }] });
    });
    const result = await runLearning(f, model, { ...initialState(), phase: "triage", chunks: 1, batches: 1, harvestDone: true }, [issue(1), issue(2)]);
    expect(model).toHaveBeenCalledTimes(2);
    expect(result.summary).toContain("Counted 1 issue source kept.");
    expect(result.receipt).toMatchObject({ counts: { "trial.issues": 1 }, entries: [] });
  } finally { f.close(); }
}, 60_000);

it("receipts linter suggestions and alternatives only after the gate saves them", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, ".eslintrc.json"), '{"rules":{"eqeqeq":"error"}}\n');
    f.git("add", ".eslintrc.json");
    f.git("-c", "commit.gpgsign=false", "commit", "-qm", "Add lint settings");
    f.head = f.git("rev-parse", "HEAD");
    const review = (n: number, text: string, path: string): Candidate => ({ id: `gh:thread:${n}`, kind: "review-thread",
      link: `https://github.com/acme/service/pull/${n}#discussion_r${n}`, pull: n, hash: `sha256:${"a".repeat(64)}`, nodeIds: [],
      at: "2026-05-01T00:00:00Z", text, path, signal: "strong", reviewers: [sourceDigest("reviewer")],
      weights: { actedOn: false, familiar: false, guidelineLink: true, generalising: true, smallPr: true, hotUnknown: false } });
    const lint = review(1, "Avoid console output in `api/endpoint.ts`. It bypasses the structured log.", "api/endpoint.ts");
    const decision = review(2, "Use the local client in `sdk/client.ts`. The team ruled out a remote proxy because offline requests must work.", "sdk/client.ts");
    const model = vi.fn<typeof runModel>(async request => {
      if (request.role === "cheap") return modelReply({ observations: [lint, decision].map((item, i) => ({
        item: "i" + (i + 1), quote: item.text, norm: item.text.split(". ")[0] + ".", why: i ? "Offline requests must work." : "",
        kind: "api-design", scope: [item.path], form: i ? "decision" : "stated", stated_as_rule: true, response: "unknown",
      })) });
      if (request.prompt.startsWith("You turn observations")) {
        const observations = request.prompt.split("\n").filter(line => line.startsWith('{"id":"sha256:')).map(line => JSON.parse(line));
        return modelReply({ policies: [], norms: observations.map(item => ({
          text: item.norm, kind: item.kind, scope: item.scope, support: [item.id], patternable: false,
          ...(item.pr === 1 ? { lint: { config: ".eslintrc.json", rule: "no-console" } }
            : { alternatives: [{ option: "Remote proxy", reason: "offline requests must work" }] }),
        })) });
      }
      return modelReply({ verdicts: [] });
    });
    const result = await runLearning(f, model, { ...initialState(), phase: "triage", chunks: 1, batches: 1, harvestDone: true }, [lint, decision]);
    expect(result.receipt?.counts, JSON.stringify(result.receipt)).toMatchObject({ "trial.linter": 1, "trial.alternatives": 1 });
    expect(result.receipt.entries).toEqual(expect.arrayContaining([expect.objectContaining({ linter: true }), expect.objectContaining({ alternatives: 1 })]));
    expect(result.summary).toContain("Counted 1 linter suggestion saved.");
    expect(result.summary).toContain("Counted 1 alternative stored.");
  } finally { f.close(); }
}, 60_000);

it("checks a scoped diff only when idle and settles a once-delivered pointer by rule id", async () => {
  const f = fixture();
  try {
    // Keep api below the broad-scope cutoff so this exercises scoped prose.
    writeFileSync(join(f.root, "sdk", "config.ts"), "export const config = {};\n");
    writeFileSync(join(f.root, "sdk", "types.ts"), "export type Client = { id: string };\n");
    await f.index();
    const accepted = await propose([{ producer: "learn-deeper", key: "prose-rule", kind: "rule", text: "Use a named endpoint value so logs show the full route.",
      source: { type: "mined", ref: "api/endpoint.ts" }, evidenceClass: "mined", model: "none", anchors: { scope: ["api/**"] },
      checks: [{ kind: "scope", role: "complete", target: { glob: "api/**" } }] }], { home: f.home, projectPath: f.checkout });
    expect(accepted[0]).toMatchObject({ status: "accepted" });
    const id = (accepted[0] as { entryId: string }).entryId;
    const now = Date.now(), file = join(f.root, "api", "endpoint.ts");
    setLearningTrial(f.writer, "learning.stopCheck", "on", f.root);
    const payload = { tool_name: "Edit", tool_input: { file_path: file, old_string: "endpoint = 2", new_string: "endpoint = 3" }, tool_response: "Edited file" };
    f.hook("first", "SessionStart", { source: "startup" });
    f.hook("first", "PreToolUse", payload);
    writeFileSync(file, "export const endpoint = 3;\n");
    f.hook("first", "PostToolUse", payload);
    expect(f.hook("first", "Stop")).not.toContain("deny");
    let clock = now;
    const model = vi.fn<typeof runModel>(async request => {
      expect(request).toMatchObject({ purpose: STOP_CHECK, setup: "mixed", role: "cheap", automatic: { measuredUsageOnly: true } });
      expect(readdirSync(request.executionDirectory!)).toEqual([]);
      expect(request.prompt).toContain("+export const endpoint = 3;");
      return modelReply({ rules: [{ id, verdict: "likely-broken", line: "api/endpoint.ts:1" }] });
    });
    registerJobKind(createStopCheckKind(model, () => clock));
    queueStopChecks(f.writer, enqueueJob, now);
    const job = f.writer.db.prepare("SELECT id FROM jobs WHERE kind=?").get(STOP_CHECK);
    expect(job).toBeTruthy();
    const only = new Set([String(job!.id)]);
    await runOneBatch(f.writer, ownerId("foreground"), { only });
    expect(model).not.toHaveBeenCalled();
    clock += 11 * 60_000;
    f.writer.db.prepare("UPDATE jobs SET state='queued' WHERE id=?").run(job!.id);
    await runOneBatch(f.writer, ownerId("foreground"), { only });
    expect(model).toHaveBeenCalledTimes(1);
    const pointerDir = join(f.writer.location.directory, "learn-stop-pointers"), name = shortHash(f.checkout);
    const pointer = JSON.parse(readFileSync(join(pointerDir, `${name}.json`), "utf8"));
    expect(pointer.flags).toMatchObject([{ id, path: "api/endpoint.ts", line: 1 }]);
    expect(JSON.stringify(pointer)).not.toContain("export const");
    f.hook("next", "SessionStart", { source: "startup" });
    expect(f.hook("next", "UserPromptSubmit", { prompt: "Continue with the API" })).toContain(`mex recall ${id}`);
    expect(f.hook("next", "UserPromptSubmit", { prompt: "Continue with the API" })).not.toContain(`mex recall ${id}`);
    writeFileSync(file, "export const endpoint = 4;\n");
    f.hook("next", "SessionEnd", { reason: "other" });
    queueStopChecks(f.writer, enqueueJob, clock);
    const count = `learning.stopCheck.counts.${id}`;
    expect(JSON.parse(f.writer.setting(f.project, count)!)).toEqual({ followed: 1, ignored: 0 });
    writeFileSync(join(pointerDir, `${name}.shown`), JSON.stringify({ ...pointer, at: now, session: "ignored", agent: "claude-code",
      flags: [{ ...pointer.flags[0], hash: diffLocations("api/endpoint.ts", "@@ -1 +1 @@\n+export const endpoint = 4;\n").get("api/endpoint.ts:1") }] }));
    queueStopChecks(f.writer, enqueueJob, clock);
    expect(JSON.parse(f.writer.setting(f.project, count)!)).toEqual({ followed: 1, ignored: 1 });
  } finally { f.close(); }
}, 60_000);

it("rejects a likely break outside the supplied new-side diff and the rule's scope", () => {
  const id = "mx_deep" + "d".repeat(32);
  const lines = diffLocations("api/file.ts", "--- a/api/file.ts\n+++ b/api/file.ts\n@@ -4,2 +4 @@\n-removed\n-old\n+new\n");
  const flags = (line: string, paths = ["api/file.ts"]) => stopCheckFlags(JSON.stringify({ rules: [{ id, verdict: "likely-broken", line }] }), new Map([[id, paths]]), lines);
  expect(flags("api/file.ts:4")).toHaveLength(1);
  expect(flags("api/file.ts:5")).toEqual([]);
  expect(flags("api/file.ts:4", ["sdk/file.ts"])).toEqual([]);
});
