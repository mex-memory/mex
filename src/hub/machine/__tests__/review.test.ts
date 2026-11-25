import { MachineHomeSchema, MachineReviewCardSchema, MachineReviewPreviewReplySchema, MachineReviewQueueSchema } from "@mex/hub-contracts/machine";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as repository from "../../../filter/repository.js";
import { hash } from "../../../judge/evidence.js";
import { parseEntry, serializeEntry, type EntryCheck, type KnowledgeEntry } from "../../../knowledge/entry.js";
import { openRecord, type RecordWriter } from "../../../record/index.js";
import { reviewAction } from "../../../review/actions.js";
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
const authority = vi.fn<typeof repository.repositoryPolicy>();
const observe = vi.fn(async ({ checkout }: Record<string, unknown>) => [observedCheck(checkout as string)]);

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
  authority.mockReset().mockResolvedValue({ visibility: "private", authorized: true });
  observe.mockClear();
  app = createMachineHubApp({
    ...location(), sessions, homeId: "review-fixture", version: "test", mode: "background", now,
    reviewDependencies: { repository: authority, recordChecks: observe },
  });
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

function observedCheck(checkout: string): EntryCheck {
  return {
    kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/test" },
    saw: { value: "vitest" }, files: { "package.json": hash(readFileSync(join(checkout, "package.json"), "utf8")) },
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
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(repo.id, "learning.note." + item.mex.id, JSON.stringify({
    at: time, holds: [], sessions: [], sources: [{ quote: item.mex.source.quote, label: "lasting",
      source: { session: null, row: null, at: time, marks: "", delivered: [], private_tag: false, note_id: item.mex.id } }],
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
  expect(authority).not.toHaveBeenCalled();
  expect(observe).not.toHaveBeenCalled();
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

function post(key: string, action: string, body: unknown, idempotencyKey = randomUUID() as string, headers?: HeadersInit) {
  return request(cardPath(key) + "/" + action, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "x-mex-csrf": csrfToken, "idempotency-key": idempotencyKey, ...headers },
    body: JSON.stringify(body),
  });
}

it("keeps card six through the service, queues its rule files and replays the request", async () => {
  const repo = project("tools");
  for (let index = 0; index < 6; index++) stage(repo, entry("fixture" + index, "run test " + index + "."), at(-6000 + index));
  const cards = (await settled()).cards;
  const card = await detail(cards[5].key);
  const body = { expectedRevision: card.revision };
  const [first, replay] = await Promise.all([post(card.key, "keep", body, "same-request"), post(card.key, "keep", body, "same-request")]);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ outcome: "kept", knowledgeKey: repo.id + ":onlyYou:mx_fixture5" });
  expect(await replay.json()).toMatchObject({ outcome: "kept" });
  expect(writer.db.prepare("SELECT count(*) n FROM jobs WHERE project_id=? AND kind='native-files'").get(repo.id)).toMatchObject({ n: 1 });
  expect((await queue()).total).toBe(5);
  const mismatch = await post(card.key, "keep", { ...body, expectedRevision: "different" }, "same-request");
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toMatchObject({ code: "REQUEST_KEY_USED" });
});

it("binds edits to the opened revision and keeps the submitted fields through Review", async () => {
  const repo = project("tools");
  const staged = stage(repo, entry("fixture", "run the linter."), at(-1000));
  const card = await detail(staged.key);
  const edited = { claim: "run checks locally", text: "run the test command locally.", kind: "procedure", scope: ["src/**"] };
  const body = { expectedRevision: "sha256:" + "d".repeat(64), edited, then: "keep" };
  const stale = await post(card.key, "edit", body);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: "STALE_PREVIEW", current: { key: card.key, revision: card.revision } });
  const result = await post(card.key, "edit", { ...body, expectedRevision: card.revision });
  expect(result.status).toBe(200);
  expect(parseEntry(readFileSync(staged.file, "utf8"))).toMatchObject({
    text: edited.text, mex: { one_line: edited.claim, kind: edited.kind, scope: edited.scope, checks: [] },
  });
});

it("keeps the current notes with sharing off", async () => {
  const repo = project("tools");
  writer.db.prepare("UPDATE projects SET shared=0 WHERE id=?").run(repo.id);
  const note = entry("current", "use the current formatter.");
  const { raw, file } = save(notes(repo.id), note);
  const id = stageConflict(writer, repo.id, {
    entry: entry("proposed", "use a new formatter."), checkout: repo.path, evidence: [],
    conflicts: [{ id: note.mex.id, level: "personal", revision: hash(raw) }],
  }, new Date(at(-1000)));
  const card = await detail(repo.id + ":" + id);
  const response = await post(card.key, "keepCurrent", { expectedRevision: card.revision });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ outcome: "keptCurrent", knowledgeKey: card.contradiction!.current[0].key });
  expect(readFileSync(file, "utf8")).toBe(raw);
  expect((await queue()).total).toBe(0);
});

it.each([["keep", "Kept"], ["edit", null]] as const)("recognizes a terminal %s from retained rows", async (action, outcome) => {
  const repo = project("tools");
  const { key } = stage(repo, entry("fixture", "run the linter."), at(-1000));
  const card = await detail(key);
  const options = { ...location(), projectPath: repo.path };
  const input = action === "edit" ? { text: "run the formatter." } : {};
  const { preview } = await reviewAction(card.cardId, action, options, input, { clock: now });
  await reviewAction(card.cardId, action, options, { ...input, apply: true, expect: preview.revision }, { clock: now });
  const response = await post(card.key, "keep", { expectedRevision: card.revision });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "ALREADY_HANDLED", outcome });
  expect((await queue()).total).toBe(0);
});

it("requires Origin, CSRF, an idempotency key, and a bounded POST body", async () => {
  const repo = project("tools");
  const card = await detail(stage(repo, entry("fixture", "run the linter."), at(-1000)).key);
  const body = { expectedRevision: card.revision };
  expect((await post(card.key, "keep", body, "valid", { origin: "https://elsewhere.example" })).status).toBe(403);
  expect((await post(card.key, "keep", body, "valid", { "x-mex-csrf": "" })).status).toBe(403);
  expect((await post(card.key, "keep", body, "")).status).toBe(400);
  expect((await post(card.key, "keep", { ...body, tooLong: "x".repeat((64 << 10) + 1) })).status).toBe(400);
  expect((await post("invalid-key", "keep", body)).status).toBe(400);
  expect((await post(repo.id + ":rv_" + "f".repeat(24), "keep", body)).status).toBe(404);
  expect((await queue()).total).toBe(1);
});

function shareable(repo: Repo) {
  const item = entry("forshare", "run the test suite.");
  item.mex.checks = [observedCheck(repo.path)];
  return { item, ...stage(repo, item, at(-1000)) };
}

async function preview(card: { key: string; revision: string }, action: string, extra: object = {}) {
  const response = await post(card.key, action, { expectedRevision: card.revision, ...extra });
  expect(response.status).toBe(200);
  return MachineReviewPreviewReplySchema.parse(await response.json()).preview;
}

it("previews and shares only an exact checked diff in the selected checkout", async () => {
  const repo = project("tools");
  const { key, item } = shareable(repo);
  const card = await detail(key);
  const planned = await preview(card, "share");
  const path = ".mex/learned/" + item.mex.id + ".md";
  expect(planned).toMatchObject({ path, checkout: repo.path, checks: [
    { id: "secrets", status: "pass" }, { id: "repository", status: "pass" }, { id: "checks", status: "pass" },
  ] });
  expect(planned.diff).toContain("+run the test suite.");
  const head = git(repo.path, "rev-parse", "HEAD");
  const noPreview = await post(key, "share", { expectedRevision: card.revision, apply: true, previewRevision: "made-up" });
  expect(await noPreview.json()).toMatchObject({ code: "STALE_PREVIEW", current: { key } });
  const apply = await post(key, "share", { expectedRevision: card.revision, apply: true, previewRevision: planned.revision });
  expect(apply.status).toBe(200);
  expect(await apply.json()).toMatchObject({ outcome: "shared", knowledgeKey: repo.id + ":team:" + item.mex.id });
  expect(parseEntry(readFileSync(join(repo.path, path), "utf8")).text).toBe(item.text);
  expect(git(repo.path, "rev-parse", "HEAD")).toEqual(head);
  expect(git(repo.path, "diff", "--cached", "--name-only")).toHaveLength(0);
  expect((await queue()).total).toBe(0);
  expect(authority).toHaveBeenCalledTimes(3);
  expect(writer.db.prepare("SELECT count(*) n FROM jobs WHERE kind='native-files'").get()).toMatchObject({ n: 0 });
});

it.each(["offline", "unknown", "unauthorized"])("returns a blocked Share preview for a %s repo", async (mode) => {
  const repo = project("tools");
  const { key } = shareable(repo);
  const card = await detail(key);
  if (mode === "offline") authority.mockRejectedValue(new Error("offline"));
  if (mode === "unknown") authority.mockResolvedValue({ visibility: "unknown", authorized: true });
  if (mode === "unauthorized") authority.mockResolvedValue({ visibility: "private", authorized: false });
  const planned = await preview(card, "share");
  expect(planned.checks).toContainEqual({
    id: "repository", status: "fail", label: "Couldn't check the repository. Sharing needs GitHub access (gh).",
  });
  expect(planned.diff).toBe("");
  expect(observe).not.toHaveBeenCalled();
  const attempted = await post(key, "share", { expectedRevision: card.revision, apply: true, previewRevision: planned.revision });
  expect(attempted.status).toBe(409);
  expect((await queue()).total).toBe(1);
});

it("serves another request while Share waits for its repository policy", async () => {
  const repo = project("tools");
  const card = await detail(shareable(repo).key);
  let release!: (policy: repository.RepositoryPolicy) => void;
  authority.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const pending = preview(card, "share");
  try {
    await vi.waitFor(() => expect(authority).toHaveBeenCalledOnce());
    expect((await queue()).total).toBe(1);
    const busy = await post(card.key, "keep", { expectedRevision: card.revision });
    expect(busy.status).toBe(503);
    expect(await busy.json()).toMatchObject({ code: "MEX_BUSY" });
  } finally { release({ visibility: "public", authorized: true }); }
  expect((await pending).checks).toContainEqual({ id: "repository", status: "warn", label: expect.stringContaining("public") });
});

it("blocks edited Share because the old checks no longer attest to the correction", async () => {
  const repo = project("tools");
  const { key, file, raw } = shareable(repo);
  const card = await detail(key);
  const planned = await preview(card, "edit", {
    edited: { claim: "run checks locally", text: "run the test command locally.", kind: "procedure", scope: ["src/**"] }, then: "share",
  });
  expect(planned.checks).toContainEqual({ id: "checks", status: "fail", label: expect.stringContaining("record its checks") });
  expect(readFileSync(file, "utf8")).toBe(raw);
  expect(authority).not.toHaveBeenCalled();
});

it("returns the current card for a stale Share preview and blocks apply when GitHub goes offline", async () => {
  const repo = project("tools");
  const { key } = shareable(repo);
  const card = await detail(key);
  const planned = await preview(card, "share");
  const apply = { expectedRevision: card.revision, apply: true, previewRevision: planned.revision };
  authority.mockResolvedValueOnce({ visibility: "unknown", authorized: false });
  const offline = await post(key, "share", apply);
  expect(offline.status).toBe(200);
  expect(MachineReviewPreviewReplySchema.parse(await offline.json()).preview.checks).toContainEqual({
    id: "repository", status: "fail", label: expect.stringContaining("GitHub"),
  });
  git(repo.path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "moved head");
  const stale = await post(key, "share", apply);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: "STALE_PREVIEW", current: { key, revision: card.revision } });
});

it("retries a real busy database with the same request key", async () => {
  const repo = project("tools");
  const card = await detail(stage(repo, entry("fixture", "run the linter."), at(-1000)).key);
  const body = { expectedRevision: card.revision };
  writer.db.exec("BEGIN IMMEDIATE");
  try {
    const busy = await post(card.key, "keep", body, "busy-retry");
    expect(busy.status).toBe(503);
    expect(await busy.json()).toMatchObject({ code: "MEX_BUSY" });
  } finally { writer.db.exec("ROLLBACK"); }
  const saved = await post(card.key, "keep", body, "busy-retry");
  expect(saved.status).toBe(200);
}, 15_000);
