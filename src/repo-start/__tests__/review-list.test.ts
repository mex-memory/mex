import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEntry } from "../../knowledge/entry.js";
import { propose, type Proposal } from "../../knowledge/gate.js";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { enqueueJob } from "../../record/jobs.js";
import { reviewRowsKey, type ReviewRow } from "../../learn-deeper/pipeline.js";
import { parseEdits } from "../../learn-deeper/would-fire.js";
import { parseVerify } from "../../learn-deeper/verify.js";
import { ZERO } from "../../record/usage.js";
import { reviewLearned } from "../review-list.js";

let suite: string, binary: string, base: string, root: string, home: string, project: string, writer: RecordWriter;
const options = () => ({ home, projectPath: root, isNetwork: () => false });
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
const notePath = (id: string) => join(home, "projects", project, "notes", `${id}.md`);

beforeAll(() => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), "mex-review-list-")));
  binary = join(suite, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(suite, "case-"))); root = join(base, "repo"); home = join(base, "home");
  mkdirSync(join(root, "src"), { recursive: true });
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "package.json"), '{"scripts":{"test":"vitest"}}\n');
  writeFileSync(join(root, "src", "api.ts"), "export const ok = 1;\n");
  git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  vi.stubEnv("MEX_HOOK_BINARY", binary); vi.stubEnv("MEX_HOME", home);
  writer = openRecord(options()); project = writer.checkout(root)!.project_id;
});
afterEach(() => { vi.unstubAllEnvs(); writer.close(); rmSync(base, { recursive: true, force: true }); });

const learned = (key: string, claim: string, pattern: string, status: "active" | "proposed"): Proposal => ({
  producer: "learn-deeper", key, kind: "rule", text: `${claim} The reviewers asked for it.`, oneLine: claim, evidenceClass: "review",
  source: { type: "review", ref: "https://github.com/acme/app/pull/1" }, model: { id: "fixture", version: "fixture-1" },
  anchors: { scope: ["src/**"], when: [{ type: "anti", match: "literal", pattern }] },
  checks: [{ kind: "source", role: "supporting", target: { file: "package.json" } }], status, label: "Learned from 2 PRs, 1 maintainer",
});

async function finishedRun(rows: Array<{ id: string; claim: string; status: "active" | "proposed" }>): Promise<string> {
  await import("../../learn-deeper/job.js");
  const { job } = enqueueJob(writer, { kind: "learn-deeper", projectId: project, params: {} });
  writer.db.prepare("UPDATE jobs SET state='done', finished_at=? WHERE id=?").run(new Date().toISOString(), job.id);
  const review: ReviewRow[] = rows.map(row => ({ entryId: row.id, claim: row.claim, label: "Learned from 2 PRs, 1 maintainer", support: 2, reviewers: 1,
    proven: true, status: row.status, route: "code-rule", signal: "strong", link: "https://github.com/acme/app/pull/1" }));
  writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?)").run(project, reviewRowsKey(job.id), JSON.stringify(review));
  return job.id;
}

it("reads past commits' added lines with their line numbers", () => {
  const edits = parseEdits(["\u0000commit abc", "diff --git a/src/x.ts b/src/x.ts", "--- a/src/x.ts", "+++ b/src/x.ts", "@@ -3,0 +4,2 @@",
    "+console.log(a)", "+keep()", "\u0000commit def", "diff --git a/old.ts b/old.ts", "+++ /dev/null"].join("\n"));
  expect(edits).toEqual([{ commit: "abc", path: "src/x.ts", added: "console.log(a)\nkeep()\n", removed: "", addedLines: [{ line: 4, text: "console.log(a)" }, { line: 5, text: "keep()" }] }]);
});

it("lists learned rules, shows what would have stopped the person's own commits, and applies ticks", async () => {
  const [a, b] = await propose([learned("a", "Log through apiLogger, not console.log.", "console.log(", "active"),
    learned("b", "Read config through loadConfig, not process.env.", "process.env.", "proposed")], options());
  if (a?.status !== "accepted" || b?.status !== "accepted") throw new Error(JSON.stringify([a, b]));
  writeFileSync(join(root, "src", "api.ts"), "export const ok = 1;\nconsole.log(ok);\n");
  git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "debug");
  await finishedRun([{ id: a.entryId, claim: "Log through apiLogger, not console.log.", status: "active" },
    { id: b.entryId, claim: "Read config through loadConfig, not process.env.", status: "proposed" }]);
  const lines: string[] = [];
  const keys = ["2", "enter"];
  const result = await reviewLearned({ root, projectId: project, write: line => lines.push(line), mode: { color: false, ascii: true } as never,
    interactive: true, env: process.env, home, keys: async () => keys.shift()! });
  expect(result).toEqual({ kept: 2, waiting: 0, dropped: 0 });
  const text = lines.join("\n");
  expect(text).toContain("[x] 1. Log through apiLogger");
  expect(text).toContain("[ ] 2. Read config");
  expect(text).toMatch(/Would have stopped your own last commits:\n\s+[0-9a-f]{7} src\/api\.ts:2 · rule 1/u);
  expect(parseEntry(readFileSync(notePath(b.entryId), "utf8")).mex.status).toBe("active");
  // Reviewed once: the next `mex` doesn't ask again.
  expect(await reviewLearned({ root, projectId: project, write: () => {}, mode: { color: false, ascii: true } as never, interactive: true, env: process.env, home, keys: async () => "enter" })).toBeUndefined();
});

it("drops the unticked rules, and asks nothing without a terminal", async () => {
  const [a] = await propose([learned("c", "Use the pooled client in src.", "new Client(", "proposed")], options());
  if (a?.status !== "accepted") throw new Error(JSON.stringify(a));
  await finishedRun([{ id: a.entryId, claim: "Use the pooled client in src.", status: "proposed" }]);
  const quiet: string[] = [];
  expect(await reviewLearned({ root, projectId: project, write: line => quiet.push(line), mode: { color: false, ascii: true } as never, interactive: false, env: process.env, home })).toBeUndefined();
  expect(quiet.join("\n")).toContain("1 learned rule waits for your review");
  expect(parseEntry(readFileSync(notePath(a.entryId), "utf8")).mex.status).toBe("proposed");
  const result = await reviewLearned({ root, projectId: project, write: () => {}, mode: { color: false, ascii: true } as never, interactive: true, env: process.env, home, keys: async () => "d" });
  expect(result).toEqual({ kept: 0, waiting: 0, dropped: 1 });
  // Retired with a tombstone: hidden everywhere, and never proposed again.
  expect(writer.setting(project, `knowledge.retired.${a.entryId}`)).toBeTruthy();
});

it("leaves everything as it is when the person decides later", async () => {
  const [a] = await propose([learned("d", "Use the pooled client in src.", "new Client(", "proposed")], options());
  if (a?.status !== "accepted") throw new Error(JSON.stringify(a));
  await finishedRun([{ id: a.entryId, claim: "Use the pooled client in src.", status: "proposed" }]);
  expect(await reviewLearned({ root, projectId: project, write: () => {}, mode: { color: false, ascii: true } as never, interactive: true, env: process.env, home, keys: async () => "q" })).toBeUndefined();
  expect(parseEntry(readFileSync(notePath(a.entryId), "utf8")).mex.status).toBe("proposed");
});

it("checks a waiting rule with the person's agent, read-only, only after they approve the estimate", async () => {
  const [a] = await propose([learned("e", "Use the pooled client in src.", "new Client(", "proposed")], options());
  if (a?.status !== "accepted") throw new Error(JSON.stringify(a));
  await finishedRun([{ id: a.entryId, claim: "Use the pooled client in src.", status: "proposed" }]);
  vi.spyOn(await import("../../learn-deeper/offer.js"), "chooseAgent").mockReturnValue("claude");
  const model = vi.fn(async (request: { readOnlyTools?: unknown; executionDirectory?: string }) => {
    expect(request.readOnlyTools).toEqual({ maxTurns: 8 });
    expect(request.executionDirectory).toBe(root);
    return { text: JSON.stringify({ verdict: "keep", evidence: ["src/api.ts:1"] }), selectedModel: "fixture", usage: { ...ZERO, model: "fixture", estimated: false } };
  });
  const keys = ["v", "1", "enter", "enter"], lines: string[] = [];
  const result = await reviewLearned({ root, projectId: project, write: line => lines.push(line), mode: { color: false, ascii: true } as never,
    interactive: true, env: process.env, home, keys: async () => keys.shift()!, model: model as never });
  expect(lines.join(" ")).toMatch(/About 40,000 tokens of your plan, estimated/u);
  expect(model).toHaveBeenCalledTimes(1);
  expect(result).toEqual({ kept: 1, waiting: 0, dropped: 0 });
  expect(parseEntry(readFileSync(notePath(a.entryId), "utf8")).mex.status).toBe("active");
});

it("ignores a verify answer that cites no real place in the code", () => {
  expect(parseVerify(JSON.stringify({ verdict: "drop", evidence: ["src/missing.ts:3"] }), root)).toBeUndefined();
  expect(parseVerify(JSON.stringify({ verdict: "drop", evidence: ["package.json:1"] }), root)).toMatchObject({ verdict: "drop", evidence: ["package.json:1"] });
  expect(parseVerify("not json", root)).toBeUndefined();
});
