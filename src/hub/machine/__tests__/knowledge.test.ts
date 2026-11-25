import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KNOWLEDGE_LIMITS, serializeEntry, type KnowledgeEntry } from "../../../knowledge/entry.js";
import { readHints, refreshHints } from "../../../knowledge/hints.js";
import { openRecord, projectIdentity, type RecordWriter } from "../../../record/index.js";
import { knowledgeKey, takeKnowledgeSnapshot, type Audience } from "../knowledge-snapshot.js";

const NOW = Date.parse("2026-11-24T18:00:00.000Z");
const at = (offset = 0) => new Date(NOW + offset).toISOString();
const DAY = 86_400_000;
const PRIVATE = "The explanation remains available only in the detail.";
let base: string, home: string, env: NodeJS.ProcessEnv;
let writer: RecordWriter;
let hooks: DatabaseSync;

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
});

afterEach(() => {
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
