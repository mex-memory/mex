import { MachineHomeSchema, MachineReviewCardSchema, MachineReviewQueueSchema } from "@mex/hub-contracts/machine";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as repository from "../../../filter/repository.js";
import { hash } from "../../../judge/evidence.js";
import { serializeEntry, type KnowledgeEntry } from "../../../knowledge/entry.js";
import { openRecord, type RecordWriter } from "../../../record/index.js";
import { stageConflict } from "../../../review/conflicts.js";
import { groupId, learningReviewId, stageReview } from "../../../review/state.js";
import { createMachineHubApp } from "../app.js";
import { HubSessions } from "../security.js";

const ORIGIN = "http://127.0.0.1:41917";
const NOW = Date.parse("2026-11-24T18:00:00.000Z");
const at = (offset = 0) => new Date(NOW + offset).toISOString();
let base: string, home: string, clock: number, writer: RecordWriter, hooks: DatabaseSync;
let app: ReturnType<typeof createMachineHubApp>, cookie: string, csrfToken: string;
const location = () => ({ home, isNetwork: () => false });
const now = () => clock;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-hub-review-")));
  home = join(base, "home");
  clock = NOW;
  writer = openRecord(location());
  hooks = new DatabaseSync(writer.location.hooks);
  const schema = resolve("native/record/schema/hooks");
  for (const file of readdirSync(schema).filter((name) => name.endsWith(".sql")).sort()) {
    hooks.exec(readFileSync(join(schema, file), "utf8"));
    hooks.exec(`PRAGMA user_version=${Number(file.slice(0, 4))}`);
  }
  hooks.exec("PRAGMA journal_mode=WAL");
  const sessions = new HubSessions(home, now);
  const signed = sessions.create();
  cookie = `${sessions.cookieName}=${signed.cookie}`;
  csrfToken = signed.session.csrfToken;
  app = createMachineHubApp({ ...location(), sessions, homeId: "review-fixture", version: "test", mode: "background", now });
});

afterEach(async () => {
  app.close();
  await setImmediate();
  hooks.close();
  writer.close();
  rmSync(base, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function request(path: string, init: RequestInit = {}, signed = true) {
  const headers = new Headers(init.headers);
  headers.set("host", new URL(ORIGIN).host);
  if (signed) headers.set("cookie", cookie);
  return app.request(ORIGIN + "/api/v1" + path, { ...init, headers });
}

const git = (path: string, ...args: string[]) => execFileSync("git", ["-C", path, ...args], { stdio: "pipe" });
function project(name: string) {
  const path = join(base, name);
  mkdirSync(path);
  git(path, "init", "-q");
  writeFileSync(join(path, "package.json"), JSON.stringify({ name, scripts: { test: "vitest" } }));
  git(path, "add", ".");
  git(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", name);
  const registration = openRecord({ ...location(), projectPath: path });
  const id = registration.checkout(path)!.project_id;
  registration.close();
  writer.db.prepare("UPDATE projects SET shared=1 WHERE id=?").run(id);
  return { id, path };
}
type Repo = ReturnType<typeof project>;

function worktree(repo: Repo, name: string, state: "on" | "off" = "on") {
  const path = join(base, name);
  git(repo.path, "worktree", "add", "-qb", name, path);
  writer.db.prepare("INSERT INTO checkouts(project_id,path,state) VALUES(?,?,?)").run(repo.id, path, state);
  return path;
}

function entry(id: string, text: string, claim = text): KnowledgeEntry {
  return {
    mex: {
      id: `mx_${id}`, kind: "rule", scope: ["**"], source: { type: "person", ref: "fixture", quote: text, producer: "note" },
      evidence: "person", one_line: claim, checks: [], status: "active", created: at().slice(0, 10),
    },
    text,
  };
}

function save(folder: string, item: KnowledgeEntry) {
  mkdirSync(folder, { recursive: true });
  const file = join(folder, item.mex.id + ".md");
  const raw = serializeEntry(item);
  writeFileSync(file, raw);
  return { file, raw };
}

const notes = (repoId: string) => join(home, "projects", repoId, "notes");
const cardPath = (key: string) => "/review/cards/" + encodeURIComponent(key);

function stage(repo: Repo, item: KnowledgeEntry, time: string, checkout = repo.path) {
  const { file, raw } = save(notes(repo.id), item);
  const key = "learning.offer." + item.mex.id;
  const id = learningReviewId(repo.id, item);
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(repo.id, key, JSON.stringify({
    state: "review", id: item.mex.id, checkout, personal_hash: hash(raw), review_at: Date.parse(time),
  }));
  stageReview(writer, repo.id, id, item, { producer: "learning", key, checkout, level: "personal", path: file, original_hash: hash(raw) }, "public-session", true, Date.parse(time));
  return { id, file, raw, producerKey: key, key: repo.id + ":" + groupId(repo.id, item) };
}

async function queue(query = "") {
  const response = await request("/review" + query);
  expect(response.status).toBe(200);
  return MachineReviewQueueSchema.parse(await response.json());
}

async function settled(query = "") {
  let result = await queue(query);
  for (let attempt = 0; result.updatingSince && attempt < 40; attempt++) {
    await setImmediate();
    result = await queue(query);
  }
  expect(result.updatingSince).toBeUndefined();
  return result;
}

async function detail(key: string) {
  const response = await request(cardPath(key));
  expect(response.status).toBe(200);
  return MachineReviewCardSchema.parse(await response.json());
}

it("deduplicates worktrees, puts contradictions first and shares counts with Home", async () => {
  const repo = project("shop"), other = project("docs");
  const linked = worktree(repo, "latest");
  const off = worktree(repo, "switched-off", "off");
  hooks.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,0)").run("latest", "codex", repo.id, linked, at(-1000), at(-500));
  const item = entry("original", "run the type check.");
  const original = stage(repo, item, at(-4000));
  stage(repo, entry("sameclaim", item.text), at(-3900), linked);
  stage(repo, entry("thirdnote", "run the test suite."), at(-2000));
  stage(other, entry("othernote", item.text), at(-9000));
  const conflict = (checkout: string) => stageConflict(writer, repo.id, {
    entry: entry("proposal", "run lint as well."), checkout, evidence: [],
    conflicts: [{ id: item.mex.id, level: "personal", revision: hash(original.raw) }],
  }, new Date(at(-1000)));
  const conflictId = conflict(linked);
  conflict(off);

  expect((await queue()).updatingSince).toBeTruthy();
  const result = await settled();
  expect(result.cards.map(({ claim }) => claim)).toEqual(["run lint as well.", item.text, item.text, "run the test suite."]);
  expect(result.cards[0]).toMatchObject({
    cardId: conflictId, checkout: linked, contradiction: { current: [{ claim: item.text, audience: "onlyYou", key: repo.id + ":onlyYou:" + item.mex.id }] },
  });
  expect(result.cards[2]).toMatchObject({
    key: original.key, checkout: linked, sources: { count: 2, producer: "Notes", checkouts: [linked, repo.path] },
    actions: ["share", "keep", "edit"], disabled: { share: "Record the checks before sharing this rule." },
    reason: "this repository is public or its visibility is unknown",
  });
  expect(result.oldest).toBe(at(-9000));
  expect(result.byRepo).toEqual({ [repo.id]: 3, [other.id]: 1 });
  const landing = MachineHomeSchema.parse(await (await request("/home")).json());
  expect(landing.needsCount).toEqual({ [repo.id]: { count: 3, oldest: at(-4000) }, [other.id]: { count: 1, oldest: at(-9000) } });
  expect(landing.needs.map(({ id }) => id)).toEqual(result.cards.map(({ cardId }) => cardId));
  const scoped = await queue("?repo=" + repo.id);
  expect(scoped.total).toBe(3);
  expect(scoped.oldest).toBe(at(-4000));
});

it("pages one generation and rejects a stale cursor after a terminal change", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const repo = project("tools");
  const first = stage(repo, entry("firstnote", "run the linter."), at(-3000));
  const second = stage(repo, entry("secondnote", "run the compiler."), at(-2000));
  stage(repo, entry("thirdnote", "run the formatter."), at(-1000));
  const page = await settled("?limit=1");
  expect(page.cards.map(({ key }) => key)).toEqual([first.key]);
  expect(page.total).toBe(3);
  const cursor = encodeURIComponent(page.nextCursor!);
  expect((await queue("?limit=1&cursor=" + cursor)).cards.map(({ key }) => key)).toEqual([second.key]);
  expect((await request("/review?cursor=" + cursor + "&repo=" + repo.id)).status).toBe(400);
  writer.db.prepare("UPDATE review SET state='dismissed' WHERE id=?").run(first.id);
  writer.db.prepare("UPDATE settings SET value=json_set(value,'$.state','applied') WHERE scope=? AND key=?").run(repo.id, first.producerKey);
  clock += 15_000;
  vi.advanceTimersByTime(15_000);
  await settled();
  const stale = await request("/review?cursor=" + cursor);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: "REVIEW_CHANGED" });
  expect((await queue("?limit=1")).cards.map(({ key }) => key)).toEqual([second.key]);
});

it("reads full detail without changing the databases, WALs or notes", async () => {
  const policy = vi.spyOn(repository, "repositoryPolicy");
  const repo = project("tools");
  const item = entry("firstnote", "run the linter.\n\nreview any warnings.", "run the linter.");
  const staged = stage(repo, item, at(-3000));
  hooks.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,0)").run("read-only", "codex", repo.id, repo.path, at(-1000), at(-500));
  const files = [writer.location.record, writer.location.record + "-wal", writer.location.hooks, writer.location.hooks + "-wal", staged.file];
  const before = files.map((file) => readFileSync(file));
  const card = await detail(staged.key);
  expect(card).toMatchObject({
    checkout: repo.path, text: item.text, claim: item.mex.one_line, kind: "rule", scope: ["**"], createdAt: at(-3000),
    expiresAt: at(30 * 86_400_000 - 3000),
  });
  const summaries = await settled();
  expect(summaries.cards[0]).not.toHaveProperty("text");
  expect(summaries.cards[0].revision).toBe(card.revision);
  expect(files.map((file) => readFileSync(file))).toEqual(before);
  expect(policy).not.toHaveBeenCalled();
  expect((await request(cardPath("../bad"))).status).toBe(400);
  expect((await request(cardPath(repo.id + ":rv_" + "f".repeat(24)))).status).toBe(404);
  expect((await request("/review?repo=unknown")).status).toBe(400);
  expect((await request("/review", {}, false)).status).toBe(401);
  expect((await request(cardPath(staged.key), {}, false)).status).toBe(401);
});

it("shows a partial repo past the scan cap and still serves other repos", async () => {
  const limited = project("limited"), other = project("other");
  writer.db.prepare(`INSERT INTO review
    SELECT 'fixture-' || value, ?, 'mx_fixture', 'checks', 'pending', ? FROM json_each(?)`)
    .run(limited.id, at(-1000), JSON.stringify(Array.from({ length: 10_001 }, (_, index) => index)));
  stage(other, entry("othernote", "run the tests."), at(-1000));
  const result = await settled();
  expect(result.total).toBe(1);
  expect(result.partial).toEqual([{ repoId: limited.id, note: expect.stringContaining("reading limit") }]);
  expect((await queue("?repo=" + limited.id)).partial).toEqual(result.partial);
});
