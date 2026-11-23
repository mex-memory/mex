import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { rebaselineFailedCheck } from "../../judge/replies.js";
import { openRecord } from "../../record/index.js";
import { clearLearningRows, learningRunPrefix } from "../../record/learning-rows.js";
import { dispositionKey, mergeDispositions, readDispositions } from "../dispositions.js";
import { linterRuleEnabled } from "../linter-config.js";
import { preserveWaiting, reviewBoundaryNotes } from "../review-policy.js";
import { learnedStatus } from "../route.js";
import { trialFollowCounts } from "../trial-outcomes.js";
import { VERIFY_CEILING, verifyRule, verifySpend } from "../verify.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("keeps a waiting lesson proposed when later evidence supports it", () => {
  const cluster = preserveWaiting({ earlier: "mx_wait01", waiting: false }, new Set(["mx_wait01"]));
  expect(cluster.waiting).toBe(true);
  expect(learnedStatus(cluster.waiting, true, true, false)).toBe("proposed");
  expect(learnedStatus(false, true, true, false)).toBe("active");
});

it("says when a shared copy or a loaded rule file still has the old text", () => {
  expect(reviewBoundaryNotes(["mx_team01"], true).join(" ")).toContain("mx_team01");
  expect(reviewBoundaryNotes([], false).join(" ")).toContain("rebuilt when no agent session");
  expect(reviewBoundaryNotes([], true).join(" ")).toContain("already loaded");
});

it("keeps per-candidate dispositions after the run's raw rows are deleted", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-disposition-")));
  roots.push(root);
  const checkout = join(root, "repo");
  mkdirSync(checkout);
  const writer = openRecord({ projectPath: checkout, home: join(root, "home"), create: true });
  try {
    const project = writer.checkout(checkout)!.project_id;
    const job = "job-1";
    const rawKey = `${learningRunPrefix(job)}candidates`;
    writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?)").run(project, rawKey, "secret review text");
    writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?)").run(project, dispositionKey(job), JSON.stringify([{ id: "gh:pr:1", disposition: "dropped" }]));
    const merged = mergeDispositions(readDispositions(writer.setting(project, dispositionKey(job))), [{ id: "gh:pr:1", disposition: "interrupted" }]);
    writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(project, dispositionKey(job), JSON.stringify(merged));
    clearLearningRows(writer.db, project, job);
    expect(writer.setting(project, rawKey)).toBeUndefined();
    expect(readDispositions(writer.setting(project, dispositionKey(job)))).toEqual([{ id: "gh:pr:1", disposition: "interrupted" }]);
  } finally { writer.close(); }
});

it("reads a linter rule from a rules table and ignores a bare name", () => {
  expect(linterRuleEnabled(`{ "rules": { "eqeqeq": "error" } }`, "no-console")).toBe(false);
  expect(linterRuleEnabled(`{ "rules": { "no-console": "error" } }`, "no-console")).toBe(true);
  expect(linterRuleEnabled(`{ "rules": { "no-console": "off" } }`, "no-console")).toBe(false);
  expect(linterRuleEnabled("// no-console\n", "no-console")).toBeUndefined();
});

it("counts follow and ignore only after the delivery settles", () => {
  expect(trialFollowCounts([
    { entryId: "mx_a", kind: "linter", acted: 1, settled: 1 },
    { entryId: "mx_b", kind: "issues", acted: 0, settled: 1 },
    { entryId: "mx_c", kind: "alternatives", acted: 1, settled: 0 },
  ])).toEqual({ "trial.linter.followed": 1, "trial.issues.ignored": 1 });
});

it("rebaselines a failed check and leaves a passing check alone", () => {
  const hash = `sha256:${"a".repeat(64)}`;
  const next = `sha256:${"b".repeat(64)}`;
  const check = { kind: "pattern" as const, role: "supporting" as const, target: { scope: "src/**", pattern: "fallback(", match: "literal" as const, expect: "at-most" as const },
    saw: { count: 1 }, files: { "src/a.ts": hash } };
  expect(rebaselineFailedCheck(check, { status: "pass", now: 9 }, { "src/a.ts": next })).toBe(check);
  const failed = rebaselineFailedCheck(check, { status: "fail", now: 4, files_changed: ["src/a.ts"] }, { "src/a.ts": next });
  expect(failed.saw).toEqual({ count: 4 });
  expect(failed.files).toMatchObject({ "src/a.ts": next });
});

it("discards a verify answer that spent over the ceiling and keeps one with no usage", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-verify-")));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "api.ts"), "export const ok = 1;\n");
  const over = async () => ({ text: JSON.stringify({ verdict: "keep", evidence: ["src/api.ts:1"] }), selectedModel: "fixture",
    usage: { input: VERIFY_CEILING + 1, output: 0, cache_read: 0, cache_write: 0, model: "fixture", estimated: false } });
  expect(verifySpend({ input: VERIFY_CEILING + 1 })).toBe(VERIFY_CEILING + 1);
  expect(await verifyRule({ claim: "Use the pooled client.", why: "The review asked for it.", scope: ["src/**"] }, root, "claude", over as never)).toBeUndefined();
  const quiet = async () => ({ text: JSON.stringify({ verdict: "keep", evidence: ["src/api.ts:1"] }), selectedModel: "fixture",
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, model: "fixture", estimated: false } });
  expect(await verifyRule({ claim: "Use the pooled client.", why: "The review asked for it.", scope: ["src/**"] }, root, "claude", quiet as never)).toMatchObject({ verdict: "keep" });
});
