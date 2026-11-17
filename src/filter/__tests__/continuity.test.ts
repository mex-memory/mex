import { beforeAll, afterAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openRecord, openHooksReadOnly, type RecordWriter } from "../../record/index.js";
import { realPath, shortHash } from "../../record/project.js";
import { hash, position } from "../../judge/evidence.js";
import { stageContinuity, readContinuityItems, continuityKey, CONTINUITY_TTL } from "../continuity.js";
import { filterSession } from "../input.js";
import type { FilterCandidate } from "../job.js";
import { draftHandoff } from "../../knowledge/handoff.js";
import { enqueueJob, type JobRow } from "../../record/jobs.js";
import { consolidateNext } from "../consolidation.js";
import { recordChecks } from "../../judge/native.js";
import "../job.js";

let suite: string, binary: string, base: string, root: string, home: string, user: string, project: string, writer: RecordWriter;
const words = "continue the parser migration.", session = "source";
const options = () => ({ home, projectPath: root, isNetwork: () => false });
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
function hook(event: string, id: string, extra: object = {}, agent = "claude-code") {
  return execFileSync(binary, [agent, event], { input: JSON.stringify({ session_id: id, hook_event_name: event, cwd: root, ...extra }),
    cwd: root, encoding: "utf8", env: { ...process.env, MEX_HOME: user, MEX_BACKGROUND: "0", MEX_OFF: "0", MEX_TELEMETRY: "0" } });
}
function candidate(): FilterCandidate {
  const reader = openHooksReadOnly(options())!;
  try {
    const row = reader.get<{ id: number; ts: string }>("SELECT id,ts FROM journal WHERE session_id=? AND kind='typed' ORDER BY id DESC LIMIT 1", session)!;
    return { source_id: `m${row.id}`, quote: words, text: words, one_line: words, label: "next-session", kind: "rule", scope: ["**"], checks: [], needs_checks: false, private: false,
      source: { session, row: row.id, at: row.ts, marks: "", delivered: [], private_tag: false, message_hash: hash(words) } };
  } finally { reader.close(); }
}
beforeAll(() => {
  suite = realPath(mkdtempSync(join(tmpdir(), "mex-filter-continuity-"))); binary = join(suite, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));
beforeEach(() => {
  base = realPath(mkdtempSync(join(suite, "case-"))); root = join(base, "repo"); user = join(base, "user"); home = join(user, ".mex"); mkdirSync(root);
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "README.md"), words + "\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture"); git("switch", "-qc", "work");
  writer = openRecord(options()); project = writer.checkout(root)!.project_id;
  // These cases exercise learning from typed statements, which is opt-in.
  writer.db.prepare("INSERT OR REPLACE INTO settings(scope,key,value) VALUES('global','learning.statements','on')").run();
  hook("UserPromptSubmit", session, { prompt: words });
});
afterEach(() => { writer.close(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

it("carries a filtered item through the real hook once, across agents' new sessions, never on resume", async () => {
  const item = candidate(), meta = filterSession(writer, project, root, session)!;
  expect(meta.branch).toBe("work"); expect(meta.position_at).toBeDefined();
  expect(stageContinuity(writer, project, root, await position(root), [item]).size).toBe(1);
  expect(hook("SessionStart", "resume", { source: "resume" })).not.toContain("Next session on work");
  const first = hook("SessionStart", "next", { source: "startup" }, "codex"); expect(first).toContain("Next session on work"); expect(first).toContain(words);
  expect(hook("SessionStart", "later", { source: "startup" })).not.toContain("Next session on work");
  expect(hook("SessionStart", "source", { source: "startup" })).not.toContain("Next session on work");
});
it("deduplicates items and keeps only the latest three short items", async () => {
  const item = candidate(), at = await position(root);
  const items = Array.from({ length: 6 }, (_, i) => ({ ...item, text: `continue task ${i}.`, source: { ...item.source, row: item.source.row! + i } }));
  expect(stageContinuity(writer, project, root, at, items).size).toBe(6);
  expect(readContinuityItems(writer, project, root, "work")!.items).toHaveLength(3);
  const before = writer.setting(project, continuityKey(root, "work")); stageContinuity(writer, project, root, at, items);
  expect(writer.setting(project, continuityKey(root, "work"))).toBe(before);
});
it("does not attribute an earlier message to a branch switched in the same session", async () => {
  const item = candidate(); git("switch", "-qc", "other"); hook("UserPromptSubmit", session, { prompt: "work on the other branch." });
  expect(stageContinuity(writer, project, root, await position(root), [item]).size).toBe(0);
  git("switch", "-q", "work"); hook("UserPromptSubmit", session, { prompt: "returned to work." });
  expect(stageContinuity(writer, project, root, await position(root), [item]).size).toBe(0);
});
it("leaves legacy unknown-position, future, pasted and delivered sources private", async () => {
  const item = candidate(), at = await position(root), now = Date.now();
  for (const changed of [ { ...item, source: { ...item.source, marks: "pasted" } }, { ...item, source: { ...item.source, delivered: ["mx_echo00"] } },
    { ...item, source: { ...item.source, at: new Date(now + 86400000).toISOString() } } ]) expect(stageContinuity(writer, project, root, at, [changed], now).size).toBe(0);
  const path = join(writer.location.directory, "filter-sessions", shortHash(project + "\0" + session) + ".json"), meta = JSON.parse(readFileSync(path, "utf8"));
  delete meta.branch; delete meta.head; delete meta.position_at; writeFileSync(path, JSON.stringify(meta));
  expect(stageContinuity(writer, project, root, at, [item], now).size).toBe(0);
});
it("withholds after expiry, on another branch, or after a later clean commit", async () => {
  const item = candidate(); stageContinuity(writer, project, root, await position(root), [item]);
  git("switch", "-qc", "other"); expect(hook("SessionStart", "other", { source: "startup" })).not.toContain("Next session on work"); git("switch", "-q", "work");
  const key = continuityKey(root, "work"), value = readContinuityItems(writer, project, root, "work")!;
  value.items[0]!.at = new Date(Date.now() - CONTINUITY_TTL - 1000).toISOString(); writer.db.prepare("UPDATE settings SET value=? WHERE scope=? AND key=?").run(JSON.stringify(value), project, key);
  expect(hook("SessionStart", "expired", { source: "startup" })).not.toContain("Next session on work");
  value.items[0]!.at = item.source.at; writer.db.prepare("UPDATE settings SET value=? WHERE scope=? AND key=?").run(JSON.stringify(value), project, key);
  git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "finished");
  expect(hook("SessionStart", "clean", { source: "startup" })).not.toContain("Next session on work");
});
it("includes live filtered continuity in the explicit handoff preview", async () => {
  stageContinuity(writer, project, root, await position(root), [candidate()]);
  expect(draftHandoff({}, options()).content).toContain(`- Next session: ${words}`);
});
it("retires filtered continuity after a fast-forward merge, even with remaining dirty files", async () => {
  writeFileSync(join(root, "work.txt"), "branch work"); git("add", "work.txt"); git("-c", "commit.gpgsign=false", "commit", "-qm", "work");
  hook("UserPromptSubmit", session, { prompt: words }); stageContinuity(writer, project, root, await position(root), [candidate()]);
  git("switch", "-q", "main"); git("merge", "--ff-only", "work"); git("switch", "-q", "work"); writeFileSync(join(root, "loose.txt"), "still dirty");
  expect(hook("SessionStart", "merged", { source: "startup" })).not.toContain("Next session on work");
});
it("publishes consolidation continuity transactionally and consumes retained eligible items", async () => {
  const c = candidate(), at = await position(root), key = "a".repeat(64);
  const job = enqueueJob(writer, { kind: "filter", projectId: project, params: { checkout: root, agent: "claude" } }).job;
  writer.db.prepare("UPDATE jobs SET state='running',owner='fixture' WHERE id=?").run(job.id);
  const running = { ...job, state: "running", owner: "fixture" } as JobRow;
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, `filter.batch.${key}`, JSON.stringify({ version: 1, phase: "complete", input_hash: key, position: at, answers: [], candidates: [c], model: "fixture", tokens: 0 }));
  const deps = { clock: Date.now, recordChecks: vi.fn(async () => []), model: vi.fn(async () => ({ selectedModel: "fixture", usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, model: "fixture", estimated: false }, text: JSON.stringify({ groups: [{ members: [0], target: null, relation: "duplicate" }] }) })) };
  await consolidateNext(writer, project, { checkout: root, agent: "claude" }, running, deps, at);
  expect(readContinuityItems(writer, project, root, "work")!.items[0]!.text).toBe(words);
  expect(writer.setting(project, `learning.pending.${key}`)).toBeUndefined();
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, `learning.pending.${key}`, JSON.stringify({ version: 1, reason: "continuity-or-gates", candidates: [c] }));
  await consolidateNext(writer, project, { checkout: root, agent: "claude" }, running, deps, at);
  expect(writer.setting(project, `learning.pending.${key}`)).toBeUndefined(); expect(deps.model).toHaveBeenCalledTimes(1);
});
it("records the approved membership contract through the real Node-to-Go interface", async () => {
  vi.stubEnv("MEX_HOOK_BINARY", binary);
  writeFileSync(join(root, "pyproject.toml"), "[project]\ndependencies = ['colorama>=0.4', 'click']\n");
  const checks = await recordChecks({ checkout: root, mex_home: home, project_id: project, record_directory: writer.location.directory },
    [{ kind: "key", role: "complete", target: { file: "pyproject.toml", pointer: "/project/dependencies", member: "colorama" } }]);
  expect(checks).toHaveLength(1); expect(checks![0]!.saw).toEqual({ value: true }); expect(checks![0]!.target).toMatchObject({ member: "colorama" });
});
