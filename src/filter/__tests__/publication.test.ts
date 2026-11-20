import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, realpathSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { enqueueJob, type JobRow } from "../../record/jobs.js";
import { shortHash } from "../../record/project.js";
import { note } from "../../knowledge/store.js";
import { serializeEntry, type KnowledgeEntry } from "../../knowledge/entry.js";
import { teamEntry } from "../../knowledge/team.js";
import { evaluate } from "../../judge/native.js";
import { hash, position } from "../../judge/evidence.js";
import { publishNext, stagePromotion, publicationReady, PUBLICATION_WAIT, type PublicationDependencies } from "../publication.js";
import { typedQuote } from "../transcript.js";
import { setLearningSharing } from "../../controls/index.js";
import "../job.js";
import { claimHash, saveTombstone } from "../../knowledge/state.js";
import { stageReview, learningReviewId } from "../../review/state.js";
let suite: string, binary: string, base: string, root: string, home: string, project: string, writer: RecordWriter, hooks: DatabaseSync, job: JobRow;
let entry: KnowledgeEntry, path: string, transcript: string, deps: Partial<PublicationDependencies>;
const typed = "Tests use vitest because this project chose it.", at = "2026-11-15T10:00:00.000Z";
const params = () => ({ checkout: root, agent: "codex" as const, sessionId: "current" });
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
function saved() { return JSON.parse(writer.setting(project, `learning.offer.${entry.mex.id}`)!); }
function meta() { return JSON.parse(writer.setting(project, `learning.note.${entry.mex.id}`)!); }
function saveMeta(value: unknown) { writer.db.prepare("UPDATE settings SET value=? WHERE scope=? AND key=?").run(JSON.stringify(value), project, `learning.note.${entry.mex.id}`); }
async function run() { return publishNext(writer, project, params(), job, deps); }
function receipt(session = "current") { hooks.prepare("INSERT OR IGNORE INTO notices_shown VALUES(?,?,?)").run(saved().notice + ".preview", session, at); }
function teamPath() { return join(root, ".mex", "learned", `${entry.mex.id}.md`); }
beforeAll(() => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), "mex-promote-suite-"))); binary = join(suite, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));
beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(suite, "case-"))); root = join(base, "repo"); home = join(base, "home"); mkdirSync(root);
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  writeFileSync(join(root, "package.json"), '{"scripts":{"test":"vitest"}}\n'); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  vi.stubEnv("MEX_HOME", home); vi.stubEnv("MEX_HOOK_BINARY", binary);
  writer = openRecord({ home, projectPath: root, isNetwork: () => false }); project = writer.checkout(root)!.project_id;
  writer.db.prepare("UPDATE projects SET shared=1 WHERE id=?").run(project);
  hooks = new DatabaseSync(join(writer.location.directory, "hooks.db"));
  const schema = resolve("native/record/schema/hooks"); for (const file of readdirSync(schema).filter(f => f.endsWith(".sql")).sort()) hooks.exec(readFileSync(join(schema, file), "utf8")); hooks.exec("PRAGMA user_version=6");
  for (const session of ["source", "current", "other"]) hooks.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,0)").run(session, "codex", project, root, at, at);
  const row = Number(hooks.prepare("INSERT INTO journal(session_id,ts,kind,text,marks) VALUES('source',?,'typed',?,'')").run(at, typed).lastInsertRowid);
  const sessions = join(base, "codex", "sessions"); mkdirSync(sessions, { recursive: true }); vi.stubEnv("CODEX_HOME", join(base, "codex"));
  transcript = join(sessions, "source.jsonl"); writeFileSync(transcript, JSON.stringify({ type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: typed }] } }) + "\n");
  const dir = join(writer.location.directory, "filter-sessions"); mkdirSync(dir);
  writeFileSync(join(dir, shortHash(project + "\0source") + ".json"), JSON.stringify({ version: 1, project_id: project, checkout: root, session_id: "source", agent: "codex", seen_at: at, finished: true, transcript }));
  entry = note({ text: typed }, { home, projectPath: root }, new Date(at)).entry;
  entry.mex.checks = [{ kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/test" }, saw: { value: "vitest" }, files: { "package.json": hash(readFileSync(join(root, "package.json"), "utf8")) } }];
  path = join(home, "projects", project, "notes", entry.mex.id + ".md"); writeFileSync(path, serializeEntry(entry));
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, `learning.note.${entry.mex.id}`, JSON.stringify({ at, holds: [], sessions: ["source"], needs_checks: false, sources: [{ quote: typed, label: "lasting", source: { session: "source", row, at, marks: "", delivered: [], private_tag: false, message_hash: hash(typed) } }] }));
  job = enqueueJob(writer, { kind: "filter", projectId: project, params: params() }).job;
  writer.db.prepare("UPDATE jobs SET state='running',owner='fixture' WHERE id=?").run(job.id); job = { ...job, state: "running", owner: "fixture" };
  stagePromotion(writer, project, entry.mex.id, root, await position(root), hash(serializeEntry(entry)));
  deps = { repository: vi.fn(async () => ({ visibility: "private" as const, authorized: true })), evaluate, clock: Date.now };
});
afterEach(() => { hooks.close(); writer.close(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

it("shows the exact diff before adding a checked entry, with no staging or commit", async () => {
  const head = git("rev-parse", "HEAD"); expect((await run())?.wait).toBe(PUBLICATION_WAIT); expect(existsSync(teamPath())).toBe(false);
  const preview = writer.db.prepare("SELECT text FROM notices WHERE kind LIKE 'learning-preview.%'").get()!;
  expect(JSON.parse(String(preview.text)).text).toContain("+Tests use vitest"); expect(publicationReady(writer, job)).toBe(false);
  receipt(); expect(publicationReady(writer, job)).toBe(true); expect((await run())?.results).toBe(1);
  expect(readFileSync(teamPath(), "utf8")).toBe(serializeEntry(teamEntry(entry))); expect(saved().state).toBe("applied");
  expect(git("diff", "--cached", "--name-only")).toBe(""); expect(git("rev-parse", "HEAD")).toBe(head);
  expect(writer.db.prepare("SELECT id FROM notices WHERE kind LIKE 'learning-updated.%'").all()).toHaveLength(1);
  expect(await run()).toBeUndefined();
});
it.each(["public", "unknown"] as const)("keeps %s session rules for Review", async visibility => {
  deps.repository = async () => ({ visibility, authorized: true }); expect((await run())?.summary).toContain("public-session");
  expect(saved().state).toBe("review"); expect(existsSync(teamPath())).toBe(false);
});
it("does not automatically publish a claim kept for its person", async () => {
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, `review.keep.${claimHash(entry.text).slice(7)}`, '{"version":1}');
  expect((await run())?.summary).toContain("kept-for-me"); expect(existsSync(teamPath())).toBe(false);
});
it("does not automatically publish an unanswered expired Review claim", async () => {
  const key = learningReviewId(project, entry);
  writeFileSync(join(root, "README.md"), typed); git("add", "README.md");
  stageReview(writer, project, key, entry, { producer: "learning", key: `learning.offer.${entry.mex.id}`, checkout: root, level: "personal", path, original_hash: hash(serializeEntry(entry)) }, "checks", true, Date.now() - 31 * 86400000);
  expect((await run())?.summary).toContain("review-expired"); expect(existsSync(teamPath())).toBe(false);
});
it.each(["privacy", "permission", "checks", "manual", "not-shared", "repo-opt-out", "transcript", "assistant", "pasted", "echo", "missing-digest"])("holds %s without writing a team file", async change => {
  if (change === "privacy") saveMeta({ ...meta(), holds: ["model-private"] });
  if (change === "permission") deps.repository = async () => ({ visibility: "private", authorized: false });
  if (change === "checks") writeFileSync(join(root, "package.json"), '{"scripts":{"test":"other"}}');
  if (change === "manual") setLearningSharing(writer, "manual", root);
  if (change === "not-shared") writer.db.prepare("UPDATE projects SET shared=0").run();
  if (change === "repo-opt-out") { mkdirSync(join(root, ".mex"), { recursive: true }); writeFileSync(join(root, ".mex", "config.json"), '{"knowledge":{"version":1,"shared":false}}'); }
  if (change === "transcript") writeFileSync(transcript, "");
  if (change === "assistant") writeFileSync(transcript, JSON.stringify({ type: "response_item", payload: { role: "assistant", content: typed } }));
  if (change === "pasted" || change === "missing-digest") { const value = meta(); if (change === "pasted") value.sources[0].source.marks = "pasted"; else delete value.sources[0].source.message_hash; saveMeta(value); }
  if (change === "echo") { hooks.prepare("INSERT INTO epochs(session_id,epoch,started_at) VALUES('source',0,?)").run(at); hooks.prepare("INSERT INTO deliveries(id,session_id,epoch,ts,moment,entry_id,form,tokens,action) VALUES('d','source',0,?,'start',?,'full',1,'given')").run(at, entry.mex.id); }
  await run(); expect(["held", "review"]).toContain(saved().state); expect(existsSync(teamPath())).toBe(false);
});
it.each(["branch", "head", "note", "privacy", "pause", "off", "cancel", "source", "other-receipt", "checks", "forgotten-claim"])("rechecks %s after the preview", async change => {
  await run(); receipt(change === "other-receipt" ? "other" : "current");
  if (change === "branch") git("switch", "-c", "another");
  if (change === "head") git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "new head");
  if (change === "note") writeFileSync(path, serializeEntry({ ...entry, text: "Edited by a person." }));
  if (change === "privacy") saveMeta({ ...meta(), holds: ["private-tag"] });
  if (change === "pause") hooks.prepare("UPDATE sessions SET paused=1 WHERE session_id='current'").run();
  if (change === "off") writer.db.prepare("UPDATE checkouts SET state='off'").run();
  if (change === "cancel") writer.db.prepare("UPDATE jobs SET request='cancel'").run();
  if (change === "source") writeFileSync(transcript, "");
  if (change === "checks") writeFileSync(join(root, "package.json"), '{"scripts":{"test":"other"}}');
  if (change === "forgotten-claim") { const old = structuredClone(entry); old.mex.id = "mx_forgotold"; saveTombstone(writer, project, old, { reason: "Forgotten", by: "mex forget", at: "2026-11-15" }); }
  try { await run(); } catch (error) { expect(String(error)).toMatch(/ownership|consent/u); }
  expect(existsSync(teamPath())).toBe(false);
});
it("recovers a write before SQL receipt commit without a second file or duplicate line", async () => {
  await run(); receipt();
  writer.db.exec("CREATE TRIGGER fail_notice BEFORE INSERT ON notices WHEN new.kind LIKE 'learning-updated.%' BEGIN SELECT RAISE(ABORT,'injected'); END");
  await expect(run()).rejects.toThrow("injected"); expect(readFileSync(teamPath(), "utf8")).toBe(serializeEntry(teamEntry(entry))); expect(saved().state).toBe("preview");
  writer.db.exec("DROP TRIGGER fail_notice"); await run(); expect(saved().state).toBe("applied"); expect(readdirSync(join(root, ".mex", "learned"))).toEqual([entry.mex.id + ".md"]);
});
it("holds a possible recorded-decision conflict rather than rewriting it", async () => {
  const decision = structuredClone(entry); decision.mex.id = "mx_decision0"; decision.mex.kind = "decision"; decision.text = "The project uses a different runner.";
  mkdirSync(join(root, ".mex", "learned"), { recursive: true }); const file = join(root, ".mex", "learned", decision.mex.id + ".md"); writeFileSync(file, serializeEntry(decision));
  await run(); expect(saved().reason).toBe("team-conflict"); expect(readFileSync(file, "utf8")).toBe(serializeEntry(decision)); expect(existsSync(teamPath())).toBe(false);
});
it("does not add a duplicate shared claim under another personal id", async () => {
  const shared = structuredClone(entry); shared.mex.id = "mx_existing0";
  mkdirSync(join(root, ".mex", "learned"), { recursive: true }); writeFileSync(join(root, ".mex", "learned", shared.mex.id + ".md"), serializeEntry(shared));
  await run(); expect(saved().reason).toBe("already-shared-claim"); expect(existsSync(teamPath())).toBe(false);
  expect(readdirSync(join(root, ".mex", "learned"))).toEqual([shared.mex.id + ".md"]);
});
it("backfills a previous-slice learned note before fresh extraction", async () => {
  writer.db.prepare("DELETE FROM settings WHERE key=?").run(`learning.offer.${entry.mex.id}`);
  expect((await run())?.wait).toBe(PUBLICATION_WAIT); expect(existsSync(teamPath())).toBe(false);
});
it("holds a write gate that would change the verified source quote", async () => {
  const text = typed + " See https://unlisted.example.test/reference.";
  entry.text = text; entry.mex.source.quote = text; writeFileSync(path, serializeEntry(entry));
  const value = meta(); value.sources[0].quote = text; value.sources[0].source.message_hash = hash(text); saveMeta(value);
  hooks.prepare("UPDATE journal SET text=?").run(text); writeFileSync(transcript, JSON.stringify({ type: "response_item", payload: { role: "user", content: text } }));
  stagePromotion(writer, project, entry.mex.id, root, await position(root), hash(serializeEntry(entry)));
  await run(); expect(saved().reason).toBe("write-gates-changed"); expect(existsSync(teamPath())).toBe(false);
});
it("never restores a retired shared entry", async () => {
  const retired = structuredClone(entry); retired.mex.status = "retired"; retired.mex.retired = { reason: "Retired", by: "person", at: "2026-11-15" };
  mkdirSync(join(root, ".mex", "learned"), { recursive: true }); writeFileSync(teamPath(), serializeEntry(retired));
  await run(); expect(saved().reason).toBe("retired-team-entry"); expect(readFileSync(teamPath(), "utf8")).toBe(serializeEntry(retired));
});
it.each(["checks", "source", "decision", "authority"])("refuses an in-flight %s change at the write proof", async change => {
  await run(); receipt();
  if (change === "authority") {
    let calls = 0; deps.repository = async () => ({ visibility: "private", authorized: ++calls === 1 });
  } else {
    const real = deps.evaluate!;
    deps.evaluate = async request => {
      const report = await real(request);
      if (change === "checks") writeFileSync(join(root, "package.json"), '{"scripts":{"test":"changed"}}');
      if (change === "source") writeFileSync(transcript, "");
      if (change === "decision") {
        const decision = structuredClone(entry); decision.mex.id = "mx_newdec00"; decision.mex.kind = "decision"; decision.text = "An existing team decision.";
        mkdirSync(join(root, ".mex", "learned"), { recursive: true }); writeFileSync(join(root, ".mex", "learned", decision.mex.id + ".md"), serializeEntry(decision));
      }
      return report;
    };
  }
  try { await run(); } catch (error) { expect(String(error)).toMatch(/changed|inputs/u); }
  expect(existsSync(teamPath())).toBe(false);
});
it("never accepts a loose quote from a different user message", async () => {
  writeFileSync(transcript, JSON.stringify({ type: "response_item", payload: { role: "user", content: typed + " Different captured message." } }));
  await run(); expect(saved().reason).toBe("insufficient-evidence"); expect(existsSync(teamPath())).toBe(false);
});
it("refuses redirected or ambiguous transcript proofs", () => {
  const outside = join(base, "outside.jsonl"); writeFileSync(outside, readFileSync(transcript));
  expect(typedQuote(outside, "codex", typed, hash(typed))).toBe(false);
  const alias = join(base, "codex", "sessions", "alias.jsonl"); symlinkSync(outside, alias); expect(typedQuote(alias, "codex", typed, hash(typed))).toBe(false);
  writeFileSync(transcript, readFileSync(transcript, "utf8").repeat(2)); expect(typedQuote(transcript, "codex", typed, hash(typed))).toBe(false);
});
it("cannot redirect the team writer into a different repository through Git environment", async () => {
  const other = join(base, "unrelated"); mkdirSync(other); execFileSync("git", ["init", "-q", other], { stdio: "pipe" });
  vi.stubEnv("GIT_DIR", join(other, ".git")); vi.stubEnv("GIT_WORK_TREE", other);
  await run(); expect(saved().reason).toBe("checkout-identity-changed");
  expect(existsSync(teamPath())).toBe(false); expect(existsSync(join(other, ".mex", "learned"))).toBe(false);
});
