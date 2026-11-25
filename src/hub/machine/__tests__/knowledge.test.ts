import { MachineKnowledgePageSchema } from "@mex/hub-contracts/machine";
import { setImmediate } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KNOWLEDGE_LIMITS, serializeEntry, type KnowledgeEntry } from "../../../knowledge/entry.js";
import { readHints, refreshHints } from "../../../knowledge/hints.js";
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
    git(path, "commit", "--allow-empty", "-m", "Initial commit");
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
