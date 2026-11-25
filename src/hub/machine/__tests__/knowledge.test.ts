import { MachineChangeEventSchema, MachineForgottenPageSchema, MachineKnowledgeConflictSchema, MachineKnowledgeDetailSchema, MachineKnowledgePreviewReplySchema, MachineKnowledgeLandingSchema, MachineKnowledgePageSchema } from "@mex/hub-contracts/machine";
import { setImmediate } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hash } from "../../../judge/evidence.js";
import { ruleChangeKey } from "../../../judge/rule-change.js";
import { KNOWLEDGE_LIMITS, serializeEntry, type KnowledgeEntry } from "../../../knowledge/entry.js";
import { readHints, refreshHints } from "../../../knowledge/hints.js";
import { saveTombstone } from "../../../knowledge/state.js";
import { openRecord, projectIdentity, type RecordWriter } from "../../../record/index.js";
import { createMachineHubApp } from "../app.js";
import { HubSessions } from "../security.js";
import { usageRange } from "../knowledge-usage.js";
import { knowledgeKey, takeKnowledgeSnapshot, type Audience } from "../knowledge-snapshot.js";

const NOW = Date.parse("2026-11-24T18:00:00.000Z");
const at = (offset = 0) => new Date(NOW + offset).toISOString();
const DAY = 86_400_000;
const PRIVATE = "The explanation remains available only in the detail.";
let base: string, home: string, env: NodeJS.ProcessEnv;
let writer: RecordWriter;
let hooks: DatabaseSync;
let app: ReturnType<typeof createMachineHubApp>;
let cookie: string, csrf: string, clock: number;
const ORIGIN = "http://127.0.0.1:41917";

const location = () => ({ home, isNetwork: () => false });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", timeout: 5_000 });

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-hub-knowledge-")));
  home = join(base, "home");
  env = { MEX_OFF: "1", CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex") };
  writer = openRecord(location());
  hooks = new DatabaseSync(writer.location.hooks);
  const schema = resolve("native/record/schema/hooks");
  for (const file of readdirSync(schema).filter((name) => name.endsWith(".sql")).sort()) {
    hooks.exec(readFileSync(join(schema, file), "utf8"));
    hooks.exec(`PRAGMA user_version=${Number(file.slice(0, 4))}`);
  }
  hooks.exec("PRAGMA journal_mode=WAL");
  clock = NOW;
  const sessions = new HubSessions(home, () => clock);
  const signed = sessions.create();
  cookie = `${sessions.cookieName}=${signed.cookie}`;
  csrf = signed.session.csrfToken;
  app = createMachineHubApp({ ...location(), sessions, homeId: "test-home", version: "test", mode: "terminal", env, now: () => clock });
});

afterEach(async () => {
  app.close();
  await setImmediate();
  hooks.close();
  writer.close();
  rmSync(base, { recursive: true, force: true });
});

function project(name: string, track = false) {
  const path = join(base, name);
  mkdirSync(path);
  if (track) {
    git(path, "init", "-b", "main");
    git(path, "config", "user.name", "Test Author");
    git(path, "config", "user.email", "test-author@example.test");
    git(path, "commit", "--allow-empty", "-m", "Initial commit for " + name);
  }
  const { id } = writer.register(projectIdentity(path));
  return { id, path };
}

function entry(id: string, oneLine: string, metadata: Partial<KnowledgeEntry["mex"]> = {}, text = PRIVATE): KnowledgeEntry {
  return {
    mex: { id, one_line: oneLine, kind: "rule", scope: ["**"], source: { type: "person", ref: "mex note 2026-11-23", quote: text },
      evidence: "person", checks: [], status: "active", created: "2026-11-23", ...metadata },
    text,
  };
}

function save(repo: ReturnType<typeof project>, audience: "onlyYou" | "team", value: KnowledgeEntry, subfolder = "") {
  const root = audience === "team" ? join(repo.path, ".mex", "learned", subfolder) : join(home, "projects", repo.id, "notes");
  const path = join(root, value.mex.id + ".md");
  mkdirSync(root, { recursive: true });
  writeFileSync(path, serializeEntry(value));
  return path;
}

function hint(repo: ReturnType<typeof project>, text = "Build outputs are disposable because source files are canonical.") {
  const path = join(env.CLAUDE_CONFIG_DIR!, "projects", repo.path.replace(/[^a-zA-Z0-9]/gu, "-"), "memory", "build.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  utimesSync(path, NOW / 1_000, NOW / 1_000);
  const options = { ...location(), projectPath: repo.path, env, consumerAgent: "codex" };
  expect(refreshHints(options, new Date(NOW)).imported).toBe(1);
  return readHints(options, new Date(NOW)).entries[0].entry;
}

function verdict(repo: ReturnType<typeof project>, id: string, value: string, path = repo.path) {
  hooks.prepare("INSERT INTO verdicts VALUES(?,?,?,?,?,?)").run(repo.id, path, id, value, "inputs", at(-DAY));
}

function key(repo: ReturnType<typeof project>, audience: Audience, id: string) {
  return knowledgeKey(repo.id, audience, id);
}

const snapshot = () => takeKnowledgeSnapshot(location(), undefined, () => NOW, new AbortController().signal, env);

describe("Knowledge snapshot", () => {
  it("loads compact metadata from each audience and the representative checkout", async () => {
    const repo = project("repo");
    const worktree = join(base, "worktree");
    mkdirSync(worktree);
    writer.db.prepare("INSERT INTO checkouts(project_id,path,state) VALUES(?,?,'on')").run(repo.id, worktree);
    hooks.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,0)").run("latest", "codex", repo.id, worktree, at(), at());

    save(repo, "onlyYou", entry("mx_personal", "ＡＰＩ boundaries", { scope: ["apps/api/**", "tests/**"] }, "x".repeat(505) + " Hidden search tail"));
    save(repo, "onlyYou", entry("mx_proposed", "Proposed decision", { kind: "decision", status: "proposed" }));
    save(repo, "team", entry("mx_default", "Another checkout"));
    save({ ...repo, path: worktree }, "team", entry("mx_teamrule", "A shared rule"), "rule");
    const observed = hint(repo);
    // Hint sources belong to the selected project; make them discoverable from the other worktree too.
    const claude = env.CLAUDE_CONFIG_DIR!;
    writeFileSync(join(claude, "settings.json"), JSON.stringify({ autoMemoryDirectory: join(claude, "projects", repo.path.replace(/[^a-zA-Z0-9]/gu, "-"), "memory") }));
    verdict(repo, "mx_personal", "held", worktree);
    verdict(repo, "mx_teamrule", "changed", worktree);
    verdict(repo, "mx_proposed", "broken", worktree);
    verdict(repo, observed.mex.id, "unknown", worktree);

    const result = (await snapshot()).projects.get(repo.id)!;
    const { rows } = result;
    expect(result.partial).toBeUndefined();
    expect(rows.size).toBe(4);
    expect(rows.get(key(repo, "onlyYou", "mx_personal"))).toMatchObject({ status: "upToDate", scope: ["apps/api/**", "tests/**"], revision: /^[\da-f]{64}$/u });
    const personal = rows.get(key(repo, "onlyYou", "mx_personal"))!;
    expect(personal.search).toMatch(/^api boundaries x/u);
    expect(personal.search).not.toContain("Hidden search tail");
    expect(personal).not.toHaveProperty("text");
    expect(rows.get(key(repo, "onlyYou", "mx_proposed"))?.status).toBe("outOfDate");
    expect(rows.get(key(repo, "team", "mx_teamrule"))).toMatchObject({ checkout: worktree, status: "codeChanged" });
    expect(rows.get(key(repo, "hint", observed.mex.id))?.status).toBe("notChecked");
  });

  it("returns the rows read before the byte limit and labels the repo partial", async () => {
    const repo = project("large");
    for (let i = 0; i < 600; i++) {
      const value = entry("mx_large" + i, "A large note", {}, "y".repeat(KNOWLEDGE_LIMITS.textCharacters));
      save(repo, "onlyYou", value);
    }
    const result = (await snapshot()).projects.get(repo.id)!;
    expect(result.partial).toMatch(/reading limit/u);
    expect(result.rows.size).toBeGreaterThan(0);
    expect(result.rows.size).toBeLessThan(600);
  });
});


function get(path: string, signed = true) {
  return app.request(ORIGIN + "/api/v1/knowledge" + path, {
    headers: { host: new URL(ORIGIN).host, ...(signed ? { cookie } : {}) },
  });
}

async function page(query = "", wait = true) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await get(query);
    expect(response.status).toBe(200);
    const data = MachineKnowledgePageSchema.parse(await response.json());
    if (!wait || !data.updatingSince) return data;
    await setImmediate();
  }
  throw new Error("Snapshot did not finish");
}

let delivery = 0;
function receipt(repo: ReturnType<typeof project>, id: string, time: string, action = "given", moment = "read") {
  const session = "session-" + repo.id;
  hooks.prepare("INSERT OR IGNORE INTO sessions VALUES(?,?,?,?,?,?,0)").run(session, "codex", repo.id, repo.path, at(), at());
  hooks.prepare("INSERT OR IGNORE INTO epochs(session_id,agent_id,epoch,started_at) VALUES(?,'codex',0,?)").run(session, at());
  hooks.prepare(`INSERT INTO deliveries(id,session_id,agent_id,epoch,ts,moment,entry_id,form,tokens,action,project_id,checkout)
    VALUES(?,?,'codex',0,?,?,?,'one-line',0,?,?,?)`).run(String(delivery++), session, time, moment, id, action, repo.id, repo.path);
}

describe("Knowledge list", () => {
  it("combines filters and body search while keeping totals for the selected repo", async () => {
    const repo = project("repo");
    const other = project("other");
    save(repo, "onlyYou", entry("mx_personal", "ＡＰＩ boundaries", { scope: ["apps/api/**", "tests/**"] }, "Normalize the request first."));
    save(repo, "team", entry("mx_teamrule", "Different rule", { kind: "fact", scope: ["apps/api/exact.ts"] }));
    save(other, "onlyYou", entry("mx_otherrepo", "Another repo"));
    verdict(repo, "mx_personal", "changed");
    const query = `?repo=${repo.id}&q=Api%20Normalize&status=needs-look&kind=rule&audience=onlyYou&area=tests%2F**`;
    const initial = await page(query, false);
    expect(initial.updatingSince).toBe(at());
    const result = await page(query);
    expect(result.items.map(({ id }) => id)).toEqual(["mx_personal"]);
    expect(result.counts).toEqual({
      status: { upToDate: 0, codeChanged: 1, outOfDate: 0, notChecked: 1 },
      kind: { rule: 1, fact: 1 }, audience: { onlyYou: 1, team: 1 },
    });
    expect((await page(`?repo=${repo.id}&audience=team`)).items.map(({ id }) => id)).toEqual(["mx_teamrule"]);
    expect((await page("?kind=fact")).items.map(({ id }) => id)).toEqual(["mx_teamrule"]);
    expect((await page("?status=codeChanged")).total).toBe(1);
    expect((await page("?area=apps%2Fapi%2F**")).total).toBe(1);
    expect((await page("?q=unrelated")).total).toBe(0);
  });

  it("sorts the full list by last use before paging and rejects a stale cursor", async () => {
    const repo = project("repo");
    const other = project("other");
    save(repo, "onlyYou", entry("mx_personal", "Zebra"));
    save(repo, "team", entry("mx_teamrule", "Aardvark"));
    save(other, "onlyYou", entry("mx_otherrepo", "Another repo"));
    receipt(repo, "mx_personal", at(-DAY).replace(".000Z", ".1Z"));
    receipt(repo, "mx_personal", at(-DAY).replace(".000Z", ".101Z"), "replaced");
    receipt(repo, "mx_personal", at(), "shadow");
    receipt(repo, "mx_personal", at(), "given", "correction");
    receipt(repo, "mx_personal", at(-31 * DAY));
    receipt(repo, "mx_personal", at(1));
    receipt(repo, "mx_teamrule", at(-DAY).replace(".000Z", "") + "Z");
    receipt(other, "mx_personal", at(-DAY));
    const first = await page("?limit=1");
    expect(first.nextCursor).toBeTruthy();
    expect(first.items[0]).toMatchObject({ id: "mx_personal", useCount30Days: 2, lastUsedAt: at(-DAY).replace(".000Z", ".101000000Z") });
    const second = "?limit=1&cursor=" + first.nextCursor;
    const result = await page(second);
    expect(result.items[0]).toMatchObject({ id: "mx_teamrule", useCount30Days: 1 });
    expect((await page("?limit=1&cursor=" + result.nextCursor)).items[0]).toMatchObject({ id: "mx_otherrepo", useCount30Days: 0, lastUsedAt: null });
    expect(await (await get(second + "&kind=rule")).json()).toMatchObject({ status: 400 });
    clock += 120_001;
    await page("?limit=1");
    expect(await (await get(second)).json()).toMatchObject({ status: 409, code: "KNOWLEDGE_CHANGED" });
  });

  it("keeps the last good page during a refresh and a pending note directory swap", async () => {
    const repo = project("repo");
    const id = "mx_personal";
    const file = save(repo, "onlyYou", entry(id, "Original claim"));
    await page();
    clock += 120_001;
    const pending = join(dirname(dirname(file)), "notes.pending");
    writeFileSync(pending, "Changing notes");
    const updating = await page("", false);
    expect(updating.items[0].oneLine).toBe("Original claim");
    expect(updating.updatingSince).toBeDefined();
    const preserved = await page();
    expect(preserved.items[0].oneLine).toBe("Original claim");
    expect(preserved.partial).toEqual([{ repoId: repo.id, note: "Some items in this repo couldn’t be read." }]);
    rmSync(pending);
    save(repo, "onlyYou", entry(id, "New claim"));
    clock += 120_001;
    expect((await page()).items[0].oneLine).toBe("New claim");
  });

  it("uses the time index to cap receipt reads before grouping", () => {
    const plan = hooks.prepare(`EXPLAIN QUERY PLAN WITH ${usageRange} SELECT count(*) FROM recent`)
      .all(at(-30 * DAY), at(), 100, 100_000);
    expect(plan.some((row) => String(row.detail).includes("SEARCH deliveries USING INDEX deliveries_ts (ts>? AND ts<?)"))).toBe(true);
    expect(plan.some((row) => String(row.detail).includes("TEMP B-TREE FOR ORDER BY"))).toBe(false);
  });

  it("requires a session and rejects invalid or unregistered repo and limit values", async () => {
    expect((await get("", false)).status).toBe(401);
    expect((await get("?repo=../elsewhere")).status).toBe(400);
    expect((await get("?repo=f-" + "a".repeat(24))).status).toBe(404);
    expect((await get("?limit=101")).status).toBe(400);
  });
});

it("groups by kind and all scopes and reads a reason bound to the current team file", async () => {
  const repo = project("repo");
  const other = project("other");
  const file = save(repo, "team", entry("mx_teamrule", "Code detail", { scope: ["apps/api/**", "tests/**", "tests/**"] }));
  save(repo, "onlyYou", entry("mx_personal", "Broken note"));
  save(repo, "onlyYou", entry("mx_otherrule", "Aardvark"));
  save(repo, "onlyYou", entry("mx_evenmore", "Zebra"));
  save(other, "onlyYou", entry("mx_another", "Rule from another repo", { scope: ["tests/**"] }));
  verdict(repo, "mx_teamrule", "changed");
  verdict(repo, "mx_personal", "broken");
  receipt(repo, "mx_teamrule", at(-1_000));
  receipt(repo, "mx_evenmore", at(-2_000));
  writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?)").run(repo.id, ruleChangeKey(repo.path), JSON.stringify({
    version: 1, checkout: repo.path,
    entries: [{ id: "mx_teamrule", entry_hash: hash(readFileSync(file, "utf8")), reasons: ["Code changed in apps/api/main.ts"] }],
  }));
  await page();
  const data = MachineKnowledgeLandingSchema.parse(await (await get("/landing")).json());
  expect(data.needsLook.total).toBe(2);
  expect(data.needsLook.items.map(({ why }) => why)).toEqual(["A check no longer holds", "Code changed in apps/api/main.ts"]);
  expect(data.groups.byKind[0].topItems.map(({ id }) => id)).toEqual(["mx_teamrule", "mx_evenmore", "mx_otherrule"]);
  expect(data.groups.byArea.map(({ pattern, repoId, count }) => [pattern, repoId, count])).toEqual([
    ["**", undefined, 3], ["apps/api/**", repo.id, 1], ...[repo.id, other.id].sort().map((id) => ["tests/**", id, 1]),
  ]);
  const scoped = MachineKnowledgeLandingSchema.parse(await (await get("/landing?repo=" + other.id)).json());
  expect(scoped.groups.byKind[0].count).toBe(1);
  expect(scoped.needsLook.total).toBe(0);
});

const itemPath = (repo: ReturnType<typeof project>, audience: Audience, id: string) =>
  "/items/" + encodeURIComponent(key(repo, audience, id));

async function detail(repo: ReturnType<typeof project>, audience: Audience, id: string) {
  const response = await get(itemPath(repo, audience, id));
  expect(response.status).toBe(200);
  return MachineKnowledgeDetailSchema.parse(await response.json());
}

describe("Knowledge detail", () => {
  it("reads the open file, shows definitions with one saved status, and projects personal history", async () => {
    const repo = project("repo");
    const id = "mx_personal";
    const checks: KnowledgeEntry["mex"]["checks"] = [
      { kind: "section", role: "complete", target: { file: "README.md", heading: "Install" }, saw: { hash: hash("Install") }, files: {} },
      { kind: "source", role: "supporting", target: { file: "docs/setup.md" }, saw: { hash: hash("Setup") }, files: {} },
    ];
    const value = entry(id, "A scoped note", {
      scope: ["apps/api/**", "tests/check.ts"], checks,
      source: { type: "person", ref: "mex edit 2026-11-24", quote: PRIVATE },
    });
    const file = save(repo, "onlyYou", value);
    // Exact revisions preserve CRLF and a BOM, even though the parser ignores both.
    writeFileSync(file, "\ufeff" + readFileSync(file, "utf8").replace(/\n/gu, "\r\n"));
    verdict(repo, id, "held");
    receipt(repo, id, at(-5_000));
    writer.db.prepare("INSERT INTO judgements VALUES(?,?,?,?,?)").run(repo.id, id, "inputs", "still-true", at(-2_000));
    writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?)").run(repo.id, "learning.note." + id, JSON.stringify({ at: at(-DAY), sessions: ["private-session-id"] }));

    const result = await detail(repo, "onlyYou", id);
    expect(result).toMatchObject({
      oneLine: "A scoped note", text: PRIVATE, evidence: PRIVATE, checkSummary: { status: "upToDate", checkedAt: at(-DAY) },
      checks: [{ kind: "section", target: "Install in README.md", result: null }, { kind: "source", target: "docs/setup.md", result: null }],
      source: { type: "note", edited: true }, useCount30Days: 1,
      history: [{ type: "added" }, { type: "edited" }, { type: "learned" }, { type: "model-check", outcome: "still true" }],
      revision: hash(readFileSync(file, "utf8")).slice(7),
    });
    expect(JSON.stringify(result)).not.toContain("private-session-id");
  });

  it("uses real git history through a rename, and still shows a team note when git fails", async () => {
    const repo = project("repo", true);
    const id = "mx_teamrule";
    const original = save(repo, "team", entry(id, "A shared rule"));
    git(repo.path, "add", "--", original);
    git(repo.path, "commit", "-m", "Add a shared rule");
    mkdirSync(join(dirname(original), "rule"));
    const moved = join(dirname(original), "rule", id + ".md");
    git(repo.path, "mv", "--", original, moved);
    git(repo.path, "commit", "-m", "Move the shared rule");
    const result = await detail(repo, "team", id);
    expect(result).toMatchObject({
      checkout: repo.path, source: { type: "team", checkout: repo.path, path: ".mex/learned/rule/mx_teamrule.md" },
      history: [{ type: "git", actor: "Test Author", action: "edited" }, { type: "git", actor: "Test Author", action: "added" }],
    });
    expect(JSON.stringify(result)).not.toContain("test-author@example.test");
    rmSync(join(repo.path, ".git"), { recursive: true });
    expect((await detail(repo, "team", id)).history).toEqual([{ type: "added", at: "2026-11-23T00:00:00.000Z" }]);
  });

  it("reads an observed hint from its verified source and rejects unknown and malformed IDs", async () => {
    const repo = project("repo");
    const observed = hint(repo);
    const result = await detail(repo, "hint", observed.mex.id);
    expect(result).toMatchObject({ text: observed.text, source: { type: "agent-memory", agent: "claude-code", observations: 1 } });
    expect((await get(itemPath(repo, "hint", "mx_missing"))).status).toBe(404);
    expect((await get(itemPath(repo, "onlyYou", "../mx_missing"))).status).toBe(400);
  });

  it("serves GETs without changing either database, WAL, or the entry files", async () => {
    const repo = project("repo");
    const file = save(repo, "onlyYou", entry("mx_personal", "A note"));
    const team = save(repo, "team", entry("mx_teamrule", "A team note"));
    const observed = hint(repo);
    const hintFile = join(home, "projects", repo.id, "hints", observed.mex.id + ".md");
    receipt(repo, "mx_personal", at());
    const paths = [file, team, hintFile, writer.location.record, writer.location.record + "-wal", writer.location.hooks, writer.location.hooks + "-wal"];
    const before = paths.map((path) => readFileSync(path));
    await page();
    await get("/landing");
    await get("/forgotten");
    await detail(repo, "onlyYou", "mx_personal");
    await detail(repo, "team", "mx_teamrule");
    await detail(repo, "hint", observed.mex.id);
    expect(paths.map((path) => readFileSync(path))).toEqual(before);
  });
});

it("pages across dated retirement markers and retired team files, with metadata only", async () => {
  const repo = project("repo");
  const other = project("other");
  const retirement = { reason: "Private reason", by: "mex forget", at: "2026-11-22" };
  const observed = hint(repo);
  saveTombstone(writer, repo.id, observed, retirement);
  save(repo, "team", entry("mx_zzzzteam", "A retired team claim", { status: "retired", retired: retirement }));
  for (let i = 0; i < 51; i++) {
    saveTombstone(writer, repo.id, entry("mx_retired" + String(i).padStart(2, "0"), "A retired personal claim"), retirement);
  }
  saveTombstone(writer, other.id, entry("mx_otherrepo", "Forgotten elsewhere"), retirement);
  expect((await page()).items).toEqual([]);
  const firstQuery = "/forgotten?repo=" + repo.id;
  const first = MachineForgottenPageSchema.parse(await (await get(firstQuery)).json());
  expect(first.items).toHaveLength(50);
  expect(first.nextCursor).toBeTruthy();
  expect(first.items.find(({ id }) => id === observed.mex.id)).toEqual({
    id: observed.mex.id, repoId: repo.id, audience: "hint", at: "2026-11-22T00:00:00.000Z",
  });
  const response = await get(firstQuery + "&cursor=" + first.nextCursor);
  const second = MachineForgottenPageSchema.parse(await response.json());
  expect(second.items).toHaveLength(3);
  expect(second.items.at(-1)).toEqual({ id: "mx_zzzzteam", repoId: repo.id, audience: "team", at: "2026-11-22T00:00:00.000Z" });
  expect(second.nextCursor).toBeNull();
  expect(JSON.stringify([first, second])).not.toMatch(/Private reason|retired (?:team|personal) claim|claim_hash|revision/u);
});

function post(path: string, body: unknown, idempotency?: string, overrides: Record<string, string> = {}) {
  return app.request(ORIGIN + "/api/v1/knowledge" + path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { host: new URL(ORIGIN).host, origin: ORIGIN, cookie, "x-mex-csrf": csrf, "content-type": "application/json",
      ...(idempotency ? { "Idempotency-Key": idempotency } : {}), ...overrides },
  });
}

describe("Knowledge writes", () => {
  it("creates a note in the selected home and replays identical concurrent requests once", async () => {
    const repo = project("repo");
    const payload = { repoId: repo.id, text: "Keep fixtures in the package that uses them.", kind: "rule", scope: ["tests/**"] };
    const [first, replay] = await Promise.all([post("/notes", payload, "create"), post("/notes", payload, "create")]);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    const saved = MachineKnowledgeDetailSchema.parse(await first.json());
    expect(await replay.json()).toEqual(saved);
    expect(saved).toMatchObject({ ...payload, revision: /^[a-f0-9]{64}$/u, audience: "onlyYou" });
    expect(readdirSync(join(home, "projects", repo.id, "notes"))).toEqual([saved.id + ".md"]);
    expect((await page()).items.map(({ id }) => id)).toEqual([saved.id]);
    expect(writer.db.prepare("SELECT project_id FROM jobs WHERE kind='native-files'").all()).toContainEqual({ project_id: repo.id });
    expect((await post("/notes", { ...payload, text: "Different." }, "create")).status).toBe(409);
  });

  it("edits a personal note and returns the current bytes when the file changes between open and save", async () => {
    const repo = project("repo");
    const id = "mx_editme";
    const file = save(repo, "onlyYou", entry(id, "First version"));
    const opened = await detail(repo, "onlyYou", id);
    save(repo, "onlyYou", entry(id, "Newer version", {}, "This change was saved by the terminal."));
    const path = itemPath(repo, "onlyYou", id) + "/edit";
    const request = { expectedRevision: opened.revision, text: "My browser edit.", oneLine: "Keep the new rule" };
    const response = await post(path, request, "conflict");
    expect(response.status).toBe(409);
    const conflict = MachineKnowledgeConflictSchema.parse(await response.json());
    expect(conflict).toMatchObject({ code: "REVISION_CONFLICT", current: { oneLine: "Newer version" }, attempted: request });
    expect(readFileSync(file, "utf8")).toContain("This change was saved by the terminal.");
    const success = await post(path, { ...request, expectedRevision: conflict.current.revision }, "resolve");
    expect(success.status).toBe(200);
    expect(MachineKnowledgeDetailSchema.parse(await success.json())).toMatchObject({ text: request.text, oneLine: request.oneLine, source: { edited: true } });
  });

  it("previews exact team bytes, then applies only the approved revision in a registered checkout", async () => {
    const repo = project("repo", true);
    const other = project("another", true);
    const id = "mx_editteam";
    const file = save(repo, "team", entry(id, "Current rule"), "rule");
    writeFileSync(file, "\ufeff" + readFileSync(file, "utf8"));
    const before = readFileSync(file);
    const opened = await detail(repo, "team", id);
    const path = itemPath(repo, "team", id) + "/edit";
    const body = { expectedRevision: opened.revision, text: "The reviewed rule and its explanation.", checkout: repo.path };
    const unregistered = await post(path, { ...body, checkout: other.path });
    expect(unregistered.status).toBe(404);
    const preview = MachineKnowledgePreviewReplySchema.parse(await (await post(path, body, "preview")).json()).preview;
    expect(preview).toMatchObject({ path: ".mex/learned/rule/mx_editteam.md", checkout: repo.path });
    expect(preview.diff).toContain("+  one_line: The reviewed rule and its explanation.");
    expect(readFileSync(file)).toEqual(before);

    const apply = { ...body, apply: true, previewRevision: preview.revision };
    const success = await post(path, apply, "apply");
    expect(success.status).toBe(200);
    expect(MachineKnowledgeDetailSchema.parse(await success.json()).text).toBe(body.text);
    const updated = await detail(repo, "team", id);
    const next = { ...body, expectedRevision: updated.revision, text: "A second reviewed change." };
    const nextPreview = MachineKnowledgePreviewReplySchema.parse(await (await post(path, next)).json()).preview;
    save(repo, "team", entry(id, "Terminal update"), "rule");
    const stale = await post(path, { ...next, apply: true, previewRevision: nextPreview.revision });
    expect(stale.status).toBe(409);
    expect(MachineKnowledgeConflictSchema.parse(await stale.json())).toMatchObject({ code: "STALE_PREVIEW", current: { oneLine: "Terminal update" } });
  });

  it("confirms hints as personal notes through the hint service", async () => {
    const repo = project("repo");
    const id = hint(repo).mex.id;
    const opened = await detail(repo, "hint", id);
    const response = await post(itemPath(repo, "hint", id) + "/edit", { expectedRevision: opened.revision, text: "Keep build outputs disposable." });
    expect(response.status).toBe(200);
    expect(MachineKnowledgeDetailSchema.parse(await response.json())).toMatchObject({ id, audience: "onlyYou", kind: "rule" });
    expect((await get(itemPath(repo, "hint", id))).status).toBe(404);
  });

  it("forgets personal notes and hints and reviews a team retirement before applying", async () => {
    const repo = project("repo");
    const personalId = "mx_personal", teamId = "mx_teamrule";
    const file = save(repo, "onlyYou", entry(personalId, "A personal note"));
    const raw = readFileSync(file);
    const hintId = hint(repo).mex.id;
    const teamFile = save(repo, "team", entry(teamId, "A team note"));
    for (const [audience, id] of [["onlyYou", personalId], ["hint", hintId], ["team", teamId]] as const) {
      const opened = await detail(repo, audience, id);
      const path = itemPath(repo, audience, id) + "/forget";
      const body = { reason: "Private retirement reason.", expectedRevision: opened.revision };
      let response = await post(path, body);
      if (audience === "team") {
        const { preview } = MachineKnowledgePreviewReplySchema.parse(await response.json());
        expect(preview.diff).toContain("+  status: retired");
        expect(readFileSync(teamFile, "utf8")).toContain("status: active");
        response = await post(path, { ...body, apply: true, previewRevision: preview.revision });
      }
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id, repoId: repo.id, audience, at: "2026-11-24T00:00:00.000Z" });
      expect((await get(itemPath(repo, audience, id))).status).toBe(404);
    }
    expect(readFileSync(file)).toEqual(raw);
    expect(readFileSync(teamFile, "utf8")).toContain("status: retired");
    expect((await page()).total).toBe(0);
    const forgotten = MachineForgottenPageSchema.parse(await (await get("/forgotten")).json());
    expect(forgotten.items.map(({ audience }) => audience).sort()).toEqual(["hint", "onlyYou", "team"]);
    expect(JSON.stringify(forgotten)).not.toContain("Private retirement reason.");
  });

  it("maps a real busy writer to a retryable 503 and lets the same key try again", async () => {
    const repo = project("repo");
    const id = "mx_personal";
    save(repo, "onlyYou", entry(id, "A personal note"));
    const opened = await detail(repo, "onlyYou", id);
    const path = itemPath(repo, "onlyYou", id) + "/edit";
    const body = { expectedRevision: opened.revision, text: "Keep the scoped note." };
    writer.db.exec("BEGIN IMMEDIATE");
    try {
      const response = await post(path, body, "retry");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "MEX_BUSY", detail: "MEX is busy. Try again in a moment." });
    } finally { writer.db.exec("ROLLBACK"); }
    expect((await post(path, body, "retry")).status).toBe(200);
  });

  it("requires cookie, same-origin CSRF, valid IDs and bounded JSON on writes", async () => {
    const repo = project("repo");
    const body = { repoId: repo.id, kind: "fact", text: "A test note" };
    expect((await post("/notes", body, undefined, { cookie: "" })).status).toBe(401);
    expect((await post("/notes", body, undefined, { origin: "https://example.test" })).status).toBe(403);
    expect((await post("/notes", body, undefined, { "x-mex-csrf": "" })).status).toBe(403);
    expect((await post("/notes", { ...body, repoId: "f-" + "a".repeat(24) })).status).toBe(404);
    expect((await post("/notes", { ...body, repoId: "../elsewhere" })).status).toBe(400);
    expect((await post("/notes", { ...body, text: "A".repeat(70_000) })).status).toBe(400);
    expect((await post(itemPath(repo, "onlyYou", "../outside") + "/forget", {})).status).toBe(400);
  });
});

it("publishes knowledge after a snapshot and a write to every open tab", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const repo = project("repo");
  const open = () => app.request(ORIGIN + "/api/v1/events", { headers: { host: new URL(ORIGIN).host, cookie } });
  const a = (await open()).body!.getReader();
  const b = (await open()).body!.getReader();
  const read = async (reader: ReadableStreamDefaultReader<Uint8Array>) => new TextDecoder().decode((await reader.read()).value);
  const nextChange = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const message = (await read(reader)).split("\n").find((line) => line.startsWith("data: "));
    return MachineChangeEventSchema.parse(JSON.parse(message!.slice(6))).topics;
  };
  try {
    for (const tab of [a, b]) expect(await read(tab)).toContain(": connected");
    await page();
    await vi.advanceTimersByTimeAsync(2_000);
    for (const tab of [a, b]) expect(await nextChange(tab)).toContain("knowledge");
    expect((await post("/notes", { repoId: repo.id, text: "Keep fixture inputs small.", kind: "rule" }, "stream-write")).status).toBe(201);
    for (const tab of [a, b]) expect(await nextChange(tab)).toEqual(["knowledge"]);
    expect((await page()).total).toBe(1);
  } finally {
    await Promise.all([a.cancel(), b.cancel()]);
    vi.useRealTimers();
  }
});
