import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { enqueueJob, type JobRow } from "../../record/jobs.js";
import { realPath, shortHash } from "../../record/project.js";
import { entry } from "../../knowledge/__tests__/fixtures.js";
import { parseEntry, serializeEntry, type EntryCheck } from "../../knowledge/entry.js";
import type { NativeReport } from "../../knowledge/check.js";
import { hash, position, type Candidate } from "../evidence.js";
import type { Judgement } from "../result.js";
import { existingFixBranch, fixPreviewReady, routeFixes, stageFixes } from "../routing.js";
import "../job.js";
import * as teamWrites from "../../knowledge/team.js";
import { judgeActor } from "../ownership.js";

let base: string, root: string, home: string, writer: RecordWriter, projectId: string, hooks: DatabaseSync;
const id = "mx_route00", oldCode = "old behavior\n", newCode = "new behavior\n";
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const check = (baseline: string): EntryCheck => ({ kind: "source", role: "complete", target: { file: "api.ts" }, saw: { hash: hash(baseline) }, files: { "api.ts": hash(baseline) } });
beforeEach(() => {
  base = realPath(mkdtempSync(join(tmpdir(), "mex-fix-routing-"))); root = join(base, "repo"); home = join(base, "home"); mkdirSync(root);
  git("init", "-q", "-b", "work"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  write(join(root, "api.ts"), oldCode); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "baseline");
  write(join(root, "api.ts"), newCode);
  writer = openRecord({ home, projectPath: root, isNetwork: () => false }); projectId = writer.checkout(root)!.project_id;
  hooks = new DatabaseSync(writer.location.hooks);
  hooks.exec("CREATE TABLE notices_shown(notice_id TEXT PRIMARY KEY,session_id TEXT,ts TEXT); CREATE TABLE sessions(session_id TEXT PRIMARY KEY,agent TEXT,paused INTEGER); PRAGMA user_version=6");
  hooks.prepare("INSERT INTO sessions VALUES('session','claude-code',0)").run();
});
afterEach(() => { vi.restoreAllMocks(); hooks.close(); writer.close(); rmSync(base, { recursive: true, force: true }); });

async function staged(level: "team" | "personal" = "team", outcome: "rewritten" | "cannot-tell" = "rewritten") {
  const beforeEntry = entry(id, { kind: "fact", checks: [check(oldCode)] }, "The API uses the old behavior.");
  const before = serializeEntry(beforeEntry), rewrite = { ...beforeEntry, text: "The API uses the new behavior.", mex: { ...beforeEntry.mex, one_line: "New API behavior.", checks: [check(newCode)] } };
  const path = level === "team" ? join(root, ".mex/learned", `${id}.md`) : join(home, "projects", projectId, "notes", `${id}.md`);
  write(path, before);
  if (level === "team") { git("add", ".mex"); git("-c", "commit.gpgsign=false", "commit", "-qm", "knowledge baseline"); }
  const at = await position(root);
  const observation = { entry_id: id, verdict: "broken" as const, checks: [{ index: 0, kind: "source", role: "complete" as const, status: "fail" as const }], inputs: { "api.ts": hash(newCode) } };
  const item = { id, path, level, status: "active" as const, kind: "fact", verdict: "broken" as const, entry_hash: hash(before) };
  const report: NativeReport = { ok: true, stored: false, items: [item], results: [observation], problems: [] };
  const judgement: Judgement = { version: 1, id, inputs_hash: hash(before+JSON.stringify(at)), checkout: root, position: at, entry_hash: hash(before),
    checks_hash: hash(JSON.stringify({ verdict: item.verdict, checks: observation.checks, inputs: observation.inputs })), files: [{ path: "api.ts", hash: hash(newCode) }],
    result: outcome, label: "checked by model", model: "fixture-cheap", at: new Date().toISOString(), ...(outcome === "rewritten" ? { rewrite } : {}) };
  const queued = enqueueJob(writer, { kind: "judge", projectId, params: {} }).job;
  writer.db.prepare("UPDATE jobs SET state='running',owner='fixture' WHERE id=?").run(queued.id);
  const job = writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(queued.id) as unknown as JobRow;
  stageFixes(writer, job, [judgement], [{ item, entry: beforeEntry, content: before, files: ["api.ts"], checks: observation.checks, spare: false, distance: 0 } as Candidate],
    { checkout: root, agent: "claude", near: ["api.ts"] }, "session");
  const proof = (over: Record<string, unknown> = {}) => write(join(writer.location.directory, "judge-edits", `${shortHash(root)}.json`), JSON.stringify({
    version: 1, project_id: projectId, checkout: root, agent: "claude-code", session_id: "session", position: at,
    edits: [{ path: "api.ts", before: hash(oldCode), after: hash(newCode) }], ...over,
  }));
  const preview = () => writer.db.prepare("SELECT id,text FROM notices WHERE kind LIKE 'judge-preview.%'").get() as { id: string; text: string } | undefined;
  const acknowledge = (session = "session") => hooks.prepare("INSERT OR REPLACE INTO notices_shown VALUES(?,?,?)").run(preview()!.id, session, new Date().toISOString());
  const reviews = () => writer.db.prepare("SELECT * FROM review").all();
  return { job, report, path, before, after: serializeEntry(rewrite), proof, preview, acknowledge, reviews };
}

describe("where judge fixes land", () => {
  it("shows the exact team diff before changing tracked bytes, then updates this working tree once", async () => {
    const f = await staged(); f.proof();
    expect(await routeFixes(writer, f.job, f.report)).toEqual({ waiting: true, gaps: false });
    expect(readFileSync(f.path, "utf8")).toBe(f.before); expect(f.reviews()).toHaveLength(0);
    const notice = JSON.parse(f.preview()!.text); expect(notice.text).toContain("-The API uses the old behavior."); expect(notice.text).toContain("+The API uses the new behavior.");
    expect(fixPreviewReady(writer, f.job)).toBe(false); f.acknowledge(); expect(fixPreviewReady(writer, f.job)).toBe(true);
    expect(await routeFixes(writer, f.job, f.report)).toEqual({ waiting: false, gaps: false });
    expect(readFileSync(f.path, "utf8")).toBe(f.after); expect(git("status", "--porcelain")).toContain("M .mex/learned/");
    expect(writer.db.prepare("SELECT text FROM notices WHERE kind LIKE 'judge-updated.%'").get()!.text).toContain("same PR");
    await routeFixes(writer, f.job, f.report); expect(f.reviews()).toHaveLength(0);
  });
  it("updates pulled personal entries only in local storage", async () => {
    const f = await staged("personal"); expect(await routeFixes(writer, f.job, f.report)).toEqual({ waiting: false, gaps: false });
    expect(readFileSync(f.path, "utf8")).toBe(f.after); expect(git("status", "--porcelain")).toBe("M api.ts"); expect(f.preview()).toBeUndefined();
  });
  it.each(["missing", "other-session", "other-checkout", "other-host", "unpaired", "wrong-before", "wrong-after", "wrong-head"])("keeps a team fix in Review with %s ownership", async what => {
    const f = await staged();
    if (what !== "missing") f.proof(what === "other-session" ? { session_id: "other" } : what === "other-checkout" ? { checkout: `${root}-other` } : what === "other-host" ? { agent: "codex" }
      : what === "unpaired" ? { pending: { tool: hash("tool"), files: [] } } : what === "wrong-head" ? { position: { branch: "refs/heads/work", head: "0".repeat(40) } }
      : { edits: [{ path: "api.ts", before: hash(what === "wrong-before" ? "pulled stale code\n" : oldCode), after: hash(what === "wrong-after" ? "another edit\n" : newCode) }] });
    expect(await routeFixes(writer, f.job, f.report)).toEqual({ waiting: false, gaps: true });
    expect(readFileSync(f.path, "utf8")).toBe(f.before); expect(f.reviews()).toHaveLength(1); expect(f.preview()).toBeUndefined();
    await routeFixes(writer, f.job, f.report); expect(f.reviews()).toHaveLength(1);
    const row = f.reviews()[0]!; expect(row.reason).toContain("checked by model");
    expect(JSON.parse(writer.setting(projectId, row.id as string)!).judgement.rewrite.text).toContain("new behavior");
  });
  it.each(["branch", "head", "source", "entry", "checks", "ownership", "retired", "consent", "cancelled", "other-receipt", "fix-branch"])("re-proves %s after showing a preview", async what => {
    const f = await staged(); f.proof(); await routeFixes(writer, f.job, f.report); f.acknowledge(what === "other-receipt" ? "other-session" : "session");
    if (what === "branch") git("switch", "-c", "unrelated");
    if (what === "head") git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "new head");
    if (what === "source") write(join(root, "api.ts"), "changed again\n");
    if (what === "entry") write(f.path, f.before+"Someone edited this.\n");
    if (what === "checks") f.report.results![0]!.checks[0]!.now = "new index observation";
    if (what === "ownership") f.proof({ session_id: "other-session" });
    if (what === "retired") writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(projectId, `knowledge.retired.${id}`, "{}");
    if (what === "consent") writer.db.prepare("UPDATE checkouts SET state='off' WHERE path=?").run(root);
    if (what === "cancelled") writer.db.prepare("UPDATE jobs SET request='cancel' WHERE id=?").run(f.job.id);
    if (what === "fix-branch") git("branch", `mex/fix-${id}`);
    await routeFixes(writer, f.job, f.report);
    expect(readFileSync(f.path, "utf8")).toBe(what === "entry" ? f.before+"Someone edited this.\n" : f.before);
    if (["consent", "cancelled", "other-receipt", "retired"].includes(what)) expect(f.reviews()).toHaveLength(0); else expect(f.reviews()).toHaveLength(1);
  });
  it.each(["local", "remote", "nested-remote"])("checks existing %s fix branches before any personal or team fix", async where => {
    const f = await staged("personal");
    git("update-ref", where === "local" ? `refs/heads/mex/fix-${id}` : `refs/remotes/${where === "nested-remote" ? "team/origin" : "origin"}/mex/fix-${id}`, "HEAD");
    expect(await existingFixBranch(root, id)).toContain(`/mex/fix-${id}`);
    await routeFixes(writer, f.job, f.report); expect(readFileSync(f.path, "utf8")).toBe(f.before); expect(f.reviews()).toHaveLength(1);
  });
  it("puts cannot-tell in Review and never edits an entry", async () => {
    const f = await staged("personal", "cannot-tell"); await routeFixes(writer, f.job, f.report);
    expect(f.reviews()).toHaveLength(1); expect(readFileSync(f.path, "utf8")).toBe(f.before);
  });
  it("moves an undelivered preview to Review after its bounded wait", async () => {
    const f = await staged(); f.proof(); await routeFixes(writer, f.job, f.report);
    const key = writer.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'judge.fix.%'").get()!;
    writer.db.prepare("UPDATE settings SET value=? WHERE scope=? AND key=?").run(JSON.stringify({ ...JSON.parse(key.value as string), previewAt: new Date(Date.now() - 301_000).toISOString() }), projectId, key.key!);
    expect(await routeFixes(writer, f.job, f.report)).toEqual({ waiting: false, gaps: true });
    expect(f.reviews()).toHaveLength(1); expect(f.preview()).toBeUndefined(); expect(readFileSync(f.path, "utf8")).toBe(f.before);
  });
  it("refuses a receipted diff when repository write-gate context changes", async () => {
    const f = await staged(); f.proof();
    const key = writer.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'judge.fix.%'").get()!;
    const fix = JSON.parse(key.value as string); fix.judgement.rewrite.text += " Run `npm test`.";
    writer.db.prepare("UPDATE settings SET value=? WHERE scope=? AND key=?").run(JSON.stringify(fix), projectId, key.key!);
    write(join(root, "package.json"), '{"scripts":{"test":"echo fixture"}}');
    expect((await routeFixes(writer, f.job, f.report)).waiting).toBe(true); f.acknowledge();
    write(join(root, "package.json"), '{"scripts":{}}');
    await routeFixes(writer, f.job, f.report);
    expect(f.reviews()).toHaveLength(1); expect(readFileSync(f.path, "utf8")).toBe(f.before);
  });
  it("recovers exact after-bytes left by a crash without applying twice", async () => {
    const f = await staged("personal"); write(f.path, f.after); await routeFixes(writer, f.job, f.report);
    expect(f.reviews()).toHaveLength(0); expect(parseEntry(readFileSync(f.path, "utf8")).text).toContain("new behavior");
  });
  it("requires ownership for every evaluator input, including reads absent from authored baselines", async () => {
    const f = await staged(); f.proof();
    write(join(root, "other.ts"), "a pulled dependency\n");
    const observation = f.report.results![0]!;
    observation.inputs!["other.ts"] = hash("a pulled dependency\n");
    const key = writer.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'judge.fix.%'").get()!;
    const fix = JSON.parse(key.value as string);
    fix.judgement.checks_hash = hash(JSON.stringify({ verdict: "broken", checks: observation.checks, inputs: observation.inputs }));
    fix.judgement.files.push({ path: "other.ts", hash: hash("a pulled dependency\n") });
    writer.db.prepare("UPDATE settings SET value=? WHERE scope=? AND key=?").run(JSON.stringify(fix), projectId, key.key!);
    expect(await routeFixes(writer, f.job, f.report)).toEqual({ waiting: false, gaps: true });
    expect(f.reviews()).toHaveLength(1); expect(f.preview()).toBeUndefined(); expect(readFileSync(f.path, "utf8")).toBe(f.before);
  });
  it.each(["record", "mirror"])("honors a session pause in the %s after its preview was shown", async where => {
    const f = await staged(); f.proof(); await routeFixes(writer, f.job, f.report); f.acknowledge();
    if (where === "record") hooks.prepare("UPDATE sessions SET paused=1 WHERE session_id='session'").run();
    else write(join(writer.location.directory, "hook-paused", shortHash("claude-code\0session")), "");
    expect((await routeFixes(writer, f.job, f.report)).waiting).toBe(true);
    expect(fixPreviewReady(writer, f.job)).toBe(false);
    expect(readFileSync(f.path, "utf8")).toBe(f.before);
  });
  it("removes dead notice hints before admitting a new preview", async () => {
    const f = await staged(); f.proof();
    const marker = join(writer.location.directory, "judge-notices", `${judgeActor(root, "claude", "session")}.json`);
    const dead = Array.from({ length: 16 }, (_, i) => `judge.fix.${i.toString(16).padStart(24, "0")}.preview`);
    write(marker, JSON.stringify(dead));
    await routeFixes(writer, f.job, f.report);
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual([f.preview()!.id]);
  });
  it("admits a required preview when old live status lines fill the hints", async () => {
    const f = await staged(); f.proof();
    const actor = judgeActor(root, "claude", "session");
    const marker = join(writer.location.directory, "judge-notices", `${actor}.json`);
    const statuses = Array.from({ length: 16 }, (_, i) => `judge.fix.${i.toString(16).padStart(24, "0")}.updated`);
    for (const status of statuses) writer.db.prepare("INSERT INTO notices VALUES(?,?,?,?)").run(status, `judge-updated.${actor}`, "{}", new Date().toISOString());
    write(marker, JSON.stringify(statuses));
    await routeFixes(writer, f.job, f.report);
    const hints = JSON.parse(readFileSync(marker, "utf8"));
    expect(hints).toHaveLength(16); expect(hints).toContain(f.preview()!.id);
  });
  it("protects publication from a concurrent Git branch switch", async () => {
    const f = await staged(); f.proof(); await routeFixes(writer, f.job, f.report); f.acknowledge();
    const apply = teamWrites.applyTeamWrite;
    let switched = false;
    vi.spyOn(teamWrites, "applyTeamWrite").mockImplementationOnce((...args) => {
      try { git("switch", "-c", "unrelated"); switched = true; } catch { /* publication owns Git's HEAD lock */ }
      return apply(...args);
    });
    await routeFixes(writer, f.job, f.report);
    expect(switched).toBe(false); expect(git("branch", "--show-current")).toBe("work");
    expect(readFileSync(f.path, "utf8")).toBe(f.after);
  });
  it("re-proves edit ownership after preparing the exact write", async () => {
    const f = await staged(); f.proof(); await routeFixes(writer, f.job, f.report); f.acknowledge();
    const prepare = teamWrites.prepareTeamWrite;
    vi.spyOn(teamWrites, "prepareTeamWrite").mockImplementationOnce((...args) => {
      const preview = prepare(...args); f.proof({ session_id: "another session" }); return preview;
    });
    await routeFixes(writer, f.job, f.report);
    expect(readFileSync(f.path, "utf8")).toBe(f.before); expect(f.reviews()).toHaveLength(1);
  });
});
