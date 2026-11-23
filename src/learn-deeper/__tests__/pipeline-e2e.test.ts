/**
 * Learn deeper v2 end to end, at $0: one harvested review thread (with the code as reviewed and the merged
 * fix) goes through triage, the first-rules-early write, clustering, the proof with the real native
 * matcher, routing and the producer gate. The published rule then stops an agent's edit through the real
 * speed bump with the team's fix, and is withheld once the code no longer has what the fix relies on.
 * This is the seed for the joined fixture test (release-01): it needs only the built hook and a git repo.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { parseEntry } from "../../knowledge/entry.js";
import { snapshotNotes } from "../../knowledge/personal-store.js";
import { buildIndex } from "../../file-index/build.js";
import type { runModel } from "../../model-runner/index.js";
import { queueJob } from "../../record/background.js";
import { openRecord } from "../../record/index.js";
import { ownerId, registerJobKind, runOneBatch, type JobRow } from "../../record/jobs.js";
import { ZERO } from "../../record/usage.js";
import { runRepoStart } from "../../repo-start/command.js";
import type { Candidate } from "../harvest/types.js";
import { createLearnKind } from "../job.js";
import { LEARN_KIND, Plan } from "../plan.js";
import { reviewRows } from "../pipeline.js";

let suite: string, binary: string, fixture: string, repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const USERS = "import { apiLogger } from \"./log\";\nexport function list() {\n  apiLogger.info(\"list\");\n}\n";
const REVIEWED = "import { apiLogger } from \"./log\";\nexport function list() {\n  console.log(\"list\");\n}";
const COMMENT = "Please don't use console.log in the API: it skips our structured logs. Use apiLogger instead.";

beforeAll(() => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), "mex-learn-e2e-")));
  binary = join(suite, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));
beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(suite, "case-")));
  repo = join(fixture, "repo"); mkdirSync(join(repo, "src", "api"), { recursive: true });
  git("init", "-qb", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("remote", "add", "origin", "https://github.com/acme/app.git");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node test.js" } }));
  writeFileSync(join(repo, "src", "api", "log.ts"), "export const apiLogger = { info(message: string) { return message; } };\n");
  writeFileSync(join(repo, "src", "api", "users.ts"), USERS);
  git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  for (const [key, value] of Object.entries({ MEX_HOME: fixture, MEX_BACKGROUND: "0", MEX_OFFLINE: "1", MEX_HOOK_BINARY: binary,
    CLAUDE_CONFIG_DIR: join(fixture, "claude"), CODEX_HOME: join(fixture, "codex") })) vi.stubEnv(key, value);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(fixture, { recursive: true, force: true }); });

function thread(head: string): Candidate {
  const region = (text: string, commit: string) => ({ path: "src/api/users.ts", commit, start: 1, end: text.split("\n").length, text, hash: sha(text) });
  const after = USERS.trimEnd();
  return {
    id: "gh:thread:7", kind: "review-thread", link: "https://github.com/acme/app/pull/7#discussion_r7", hash: sha(COMMENT), nodeIds: ["PRRC_7"],
    at: "2026-01-02T00:00:00Z", pull: 7, title: "List users", path: "src/api/users.ts", text: COMMENT,
    code: { before: region(REVIEWED, "a".repeat(40)), after: region(after, head), head: region(after, head), anchor: "  console.log(\"list\");" },
    reviewers: ["r1"], weights: { actedOn: true, familiar: true, guidelineLink: false, generalising: true, smallPr: true, hotUnknown: false },
    signal: "strong", commentHashes: { PRRC_7: sha(COMMENT) },
  };
}

const reply = (value: unknown) => ({ text: JSON.stringify(value), selectedModel: "fixture", usage: { ...ZERO, model: "fixture-2026-11", estimated: false } });

it("learns a rule from one review thread, stops an edit with the team's fix, and withholds it when the fix is gone", async () => {
  await runRepoStart({ cwd: repo, write: () => {}, caller: "script", install: false, wait: false });
  const writer = openRecord();
  try {
    const real = realpathSync(repo), head = git("rev-parse", "HEAD");
    // The record keeps the checkout's canonical path (lower-cased on Windows); plans use that path, as the offer does.
    const registered = writer.checkout(real)!, checkout = registered.path, project = registered.project_id;
    // A person's `mex` turns MEX on for the checkout; a script's only registers it.
    writer.db.prepare("UPDATE checkouts SET state='on' WHERE path=?").run(checkout);
    // Setup builds the file index in the background; build it here so scope and pattern checks can answer.
    const index = () => buildIndex({ root: real, projectId: project, recordDirectory: writer.location.directory, workers: 0 });
    await index();
    const plan = Plan.parse({ checkout, head, origin: { host: "github.com", slug: "acme/app" }, source: { host: "github.com", slug: "acme/app" },
      visibility: "public", agent: "codex", setup: "best-only", since: "2025-06-01T00:00:00.000Z", until: new Date().toISOString(),
      preferred: [], pulls: [], docs: [], sessions: [], refresh: false, gaps: [], estimate: 100_000, ceiling: 150_000, harvest: { mode: "backfill" } });
    const job = queueJob(writer, { kind: LEARN_KIND, projectId: project, params: plan }).job;
    // Start after the harvest (tested on its own): one chunk holding one review thread with its code.
    writer.db.prepare("UPDATE jobs SET checkpoint=? WHERE id=?").run(JSON.stringify({ pull: 0, doc: 0, gaps: [],
      v2: { phase: "triage", chunks: 1, triaged: 0, early: false, batches: 0, written: 0, counts: {} } }), job.id);
    writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?)").run(project, `learning.deep.v2.${job.id}.cand.0`, JSON.stringify([thread(head)]));
    const model = vi.fn<typeof runModel>(async request => {
      if (request.purpose === "learn-deeper-filter") {
        return reply({ results: [{ id: "gh:thread:7", keep: true, category: "api-use", lesson: "Log through `apiLogger` in src/api, not console.log." }] }) as never;
      }
      const cluster = /"cluster":"([a-f0-9]{24})"/u.exec(request.prompt)![1];
      // The writer sees the code as reviewed, numbered (inside the prompt's JSON, so quotes are escaped).
      expect(request.prompt).toContain('3|   console.log(\\"list\\");');
      return reply({ entries: [{ cluster, route: "code-rule", kind: "rule", claim: "Log through apiLogger in src/api, not console.log.",
        why: "console.log skips the structured logs.",
        clauses: [{ text: "Log through apiLogger in src/api, not console.log.", quotes: [{ id: "gh:thread:7", quote: "Use apiLogger instead." }] },
          { text: "console.log skips the structured logs.", quotes: [{ id: "gh:thread:7", quote: "it skips our structured logs" }] }],
        scope: ["src/api/**"], when: [{ type: "anti", match: "literal", pattern: "console.log(" }],
        fix: { pair: 0, start: 3, end: 3 }, examples: { flag: "console.log(user)", ok: "apiLogger.info(user)" }, aliases: ["api logging"] }] }) as never;
    });
    registerJobKind(createLearnKind({ model }));
    for (let i = 0; i < 8; i++) {
      const row = writer.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id) as unknown as JobRow;
      if (["done", "done with gaps", "failed"].includes(row.state)) break;
      await runOneBatch(writer, ownerId("foreground"), { only: new Set([job.id]) });
    }
    const done = writer.db.prepare("SELECT state,reason FROM jobs WHERE id=?").get(job.id) as unknown as JobRow;
    expect(done.state, String(done.reason)).toMatch(/^done/u);
    expect(model).toHaveBeenCalledTimes(2); // triage, then the early write; clustering found nothing new to write
    const learned = [...snapshotNotes(writer, project).files.values()].map(parseEntry).filter(entry => entry.mex.id.startsWith("mx_deep"));
    expect(learned).toHaveLength(1);
    const rule = learned[0]!;
    expect(rule.mex.status).toBe("active");
    expect(rule.mex.when).toEqual([{ type: "anti", match: "literal", pattern: "console.log(" }]);
    expect(rule.mex.fix).toMatchObject({ snippet: "  apiLogger.info(\"list\");", path: "src/api/users.ts", lines: "3-3" });
    expect(rule.mex.checks.map(check => `${check.kind}:${check.role}`)).toEqual(expect.arrayContaining(["fixture:complete", "pattern:complete", "scope:complete", "source:supporting"]));
    expect(rule.mex.source.quote).toBeTruthy();
    expect(reviewRows(writer, project, job.id)).toMatchObject([{ entryId: rule.mex.id, proven: true, status: "active" }]);
    // The run's raw text is gone; the rule and its proof stay.
    expect(writer.db.prepare("SELECT count(*) n FROM settings WHERE key LIKE ?").get(`learning.deep.v2.${job.id}.%`)?.n).toBe(0);

    const hook = (session: string, event: string, payload: Record<string, unknown> = {}) => execFileSync(binary, ["claude-code", event], {
      encoding: "utf8", timeout: 20_000, env: { ...process.env, MEX_BACKGROUND: "0" },
      input: JSON.stringify({ session_id: session, cwd: real, hook_event_name: event, ...payload }),
    });
    const edit = { tool_name: "Edit", tool_input: { file_path: join(real, "src", "api", "users.ts"), old_string: "  apiLogger.info(\"list\");", new_string: "  console.log(\"list\");" } };
    hook("first", "SessionStart", { source: "startup" });
    const stopped = hook("first", "PreToolUse", edit);
    expect(stopped).toContain("deny");
    expect(stopped).toContain("Do this instead");
    expect(stopped).toContain("apiLogger.info(\\\"list\\\")");

    // The team moves off apiLogger: what the fix relied on is gone, so the rule is withheld.
    writeFileSync(join(repo, "src", "api", "users.ts"), "import { log } from \"./log\";\nexport function list() {\n  log(\"list\");\n}\n");
    writeFileSync(join(repo, "src", "api", "log.ts"), "export function log(message: string) { return message; }\n");
    git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "switch loggers");
    await index(); // the background refresh after HEAD moves
    hook("second", "SessionStart", { source: "startup" });
    const later = { tool_name: "Edit", tool_input: { file_path: join(real, "src", "api", "users.ts"), old_string: "  log(\"list\");", new_string: "  console.log(\"list\");" } };
    expect(hook("second", "PreToolUse", later)).not.toContain("deny");
  } finally { writer.close(); }
}, 120_000);
