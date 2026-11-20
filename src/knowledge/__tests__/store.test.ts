import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openRecord, openRecordReadOnly, projectIdentity } from "../../record/index.js";
import { recordLocation } from "../../record/location.js";
import { knowledgeProject } from "../context.js";
import { entryVerdict, expand, note, recall } from "../store.js";
import { KNOWLEDGE_LIMITS, parseEntry, serializeEntry } from "../entry.js";
import { createEntryFile, readEntryFile } from "../files.js";

let root: string, repo: string, home: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-knowledge-")); repo = join(root, "repo"); home = join(root, "user", ".mex");
  mkdirSync(repo);
  git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.test");
  writeFileSync(join(repo, "README.md"), "# Fixture\n"); git(repo, "add", "README.md"); git(repo, "commit", "-m", "Initial fixture");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const options = () => ({ projectPath: repo, home, isNetwork: () => false });
const folder = () => join(home, "projects", projectIdentity(repo).id, "notes");
describe("personal knowledge", () => {
  it("is available from a second worktree and a full clone without registering reads", () => {
    const worktree = join(root, "second"); const clone = join(root, "clone");
    git(repo, "worktree", "add", "-b", "feature", worktree);
    const bundle = join(root, "fixture.bundle");
    git(repo, "bundle", "create", bundle, "--all");
    execFileSync("git", ["clone", bundle, clone], { stdio: "pipe", timeout: 5000 });
    const saved = note({ text: "Tests use fixtures because they are reproducible.", kind: "recipe", scope: ["tests/**"] }, options(), new Date("2026-11-13T10:00:00Z"));
    expect(saved.entry.mex.source.producer).toBe("note");
    for (const projectPath of [worktree, clone]) {
      expect(recall("TESTS fixtures", { ...options(), projectPath }).entries).toMatchObject([{ id: saved.entry.mex.id, label: "[you said, 13 Nov]" }]);
      expect(expand(saved.entry.mex.id, { ...options(), projectPath }).entry).toEqual(saved.entry);
    }
    const reader = openRecordReadOnly({ home })!;
    expect(reader.all("SELECT path FROM checkouts")).toHaveLength(1);
    reader.close();
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(worktree, "status", "--porcelain")).toBe("");
    expect(readdirSync(folder())).toEqual([`${saved.entry.mex.id}.md`]);
  });
  it("keeps empty reads and invalid writes noninitializing", () => {
    expect(recall("tests", options())).toEqual({ entries: [], truncated: false, ranking: { engine: "legacy", reason: "native-binary-unavailable" } });
    expect(() => expand("mx_absent1", options())).toThrow(/No active/);
    expect(() => note({ text: "   " }, options())).toThrow();
    expect(() => note({ text: "A fact.", scope: ["../escape"] }, options())).toThrow();
    expect(existsSync(join(root, "user"))).toBe(false);
    expect(existsSync(join(repo, ".mex"))).toBe(false);
  });
  it("uses a registered identity even after HEAD switches to unrelated history", () => {
    const before = projectIdentity(repo).id;
    const saved = note({ text: "Notes survive a history switch because project registration is pinned." }, options());
    git(repo, "checkout", "--orphan", "unrelated"); git(repo, "commit", "-m", "Different root");
    expect(projectIdentity(repo).id).not.toBe(before);
    expect(expand(saved.entry.mex.id, options()).entry).toEqual(saved.entry);
  });
  it("finds notes below a registered repository but isolates a nested repository", () => {
    const saved = note({ text: "Fixtures make tests reproducible." }, options());
    const child = join(repo, "nested"); mkdirSync(child);
    expect(recall("fixtures", { ...options(), projectPath: child }).entries[0].id).toBe(saved.entry.mex.id);
    git(child, "init", "-b", "main");
    expect(recall("fixtures", { ...options(), projectPath: child }).entries).toEqual([]);
  });
  it("searches complete normalized words and returns short forms in stable order", () => {
    note({ text: "Testing has café fixtures.", oneLine: "Café fixtures are reproducible." }, options(), new Date("2026-11-12"));
    const newest = note({ text: "Café tests use reusable fixtures.", kind: "recipe" }, options(), new Date("2026-11-13"));
    expect(recall("CAFÉ fixtures", options(), 1)).toMatchObject({ entries: [{ id: newest.entry.mex.id }], truncated: true });
    expect(recall("test", options()).entries).toEqual([]);
    expect(recall("recipe fixtures", options()).entries).toHaveLength(1);
    expect(recall("café", options()).entries[0]).not.toHaveProperty("text");
    expect(recall("café", options()).entries[0]).not.toHaveProperty("entry");
  });
  it("does not return retired files or reuse ids", () => {
    const saved = note({ text: "Fixtures make tests reproducible." }, options());
    const entry = saved.entry;
    entry.mex.status = "retired"; entry.mex.retired = { reason: "Replaced", by: "maintainer", at: "2026-11-13" };
    const file = join(folder(), `${entry.mex.id}.md`); writeFileSync(file, serializeEntry(entry));
    expect(recall("fixtures", options()).entries).toEqual([]);
    expect(() => expand(entry.mex.id, options())).toThrow(/No active/);
    expect(() => createEntryFile(folder(), entry.mex.id, "replacement")).toThrow();
    expect(parseEntry(readFileSync(file, "utf8")).mex.status).toBe("retired");
    expect(readdirSync(folder())).toEqual([`${entry.mex.id}.md`]);
  });
  it("rejects invalid ids and filename mismatches", () => {
    expect(() => expand("../outside", options())).toThrow(/stable entry id/);
    const saved = note({ text: "Fixtures make tests reproducible." }, options());
    writeFileSync(join(folder(), "mx_other1.md"), serializeEntry(saved.entry));
    expect(() => expand("mx_other1", options())).toThrow(/filename/);
  });
  it("refuses redirected directories and symlink note files", () => {
    const saved = note({ text: "Fixtures make tests reproducible." }, options());
    const outside = join(root, "outside"); mkdirSync(outside);
    const noteFolder = folder(); rmSync(noteFolder, { recursive: true });
    symlinkSync(outside, noteFolder, "junction");
    expect(() => recall("fixtures", options())).toThrow(/redirected/);
    expect(() => note({ text: "Another fixture fact." }, options())).toThrow(/redirected/);
    expect(readdirSync(outside)).toEqual([]);
    unlinkSync(noteFolder); mkdirSync(noteFolder);
    const target = join(outside, "fact.md"); writeFileSync(target, serializeEntry(saved.entry));
    symlinkSync(target, join(noteFolder, `${saved.entry.mex.id}.md`));
    expect(() => expand(saved.entry.mex.id, options())).toThrow(/regular file/);
  });
  it("checks the project-data parent before calling the record directory factory", () => {
    const writer = openRecord(options()); writer.close();
    const outside = join(root, "outside"); mkdirSync(outside);
    symlinkSync(outside, join(home, "projects"), "junction");
    expect(() => note({ text: "Fixtures make tests reproducible." }, options())).toThrow(/redirected/);
    expect(readdirSync(outside)).toEqual([]);
  });
  it("refuses too-large or malformed UTF-8 files before decoding them as entries", () => {
    const saved = note({ text: "Fixtures make tests reproducible." }, options());
    const file = join(folder(), `${saved.entry.mex.id}.md`);
    writeFileSync(file, Buffer.alloc(KNOWLEDGE_LIMITS.entryBytes + 1));
    expect(() => readEntryFile(file)).toThrow(/size/);
    writeFileSync(file, Buffer.from([0xff, 0xfe]));
    expect(() => readEntryFile(file)).toThrow(/UTF-8/);
  });
  it("refuses incompatible records on reads without migrating or writing", () => {
    const writer = openRecord(options()); writer.db.exec("PRAGMA user_version=999"); writer.close();
    expect(() => recall("fixtures", options())).toThrow(/newer than supported/);
    const reader = openRecordReadOnly({ home })!; expect(reader.version).toBe(999); reader.close();
  });
  it("counts retired file bytes toward the scan bound and never returns a partial search", () => {
    const saved = note({ text: `Fixtures are reproducible. ${"x".repeat(7900)}`, oneLine: "Fixtures are reproducible." }, options());
    const directory = folder();
    saved.entry.mex.status = "retired";
    saved.entry.mex.retired = { reason: "Replaced", by: "maintainer", at: "2026-11-13" };
    for (let i = 0; i < 600; i++) {
      saved.entry.mex.id = `mx_bulk${String(i).padStart(6, "0")}`;
      writeFileSync(join(directory, `${saved.entry.mex.id}.md`), serializeEntry(saved.entry));
    }
    expect(() => recall("fixtures", options())).toThrow(/byte scan limit/);
  });
  it("rejects empty searches, oversized queries and invalid result bounds", () => {
    for (const query of ["", "!!!", "x".repeat(257)]) expect(() => recall(query, options())).toThrow();
    for (const limit of [0, 101, 1.5, NaN]) expect(() => recall("fixtures", options(), limit)).toThrow();
    expect(existsSync(home)).toBe(false);
  });
});

const realRanker = process.env.MEX_TEST_REAL_HOOK_BINARY === "1" && spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
describe.skipIf(!realRanker)("recall through the real ranker", () => {
  let previous: string | undefined, bin: string;
  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), "mex-recall-bin-"));
    const binary = join(bin, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
    execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve(__dirname, "../../../native"), timeout: 240_000, stdio: "pipe" });
    previous = process.env.MEX_HOOK_BINARY; process.env.MEX_HOOK_BINARY = binary;
  }, 300_000);
  afterAll(() => { if (previous === undefined) delete process.env.MEX_HOOK_BINARY; else process.env.MEX_HOOK_BINARY = previous; rmSync(bin, { recursive: true, force: true }); });
  it("finds notes by a word they all share", () => {
    const password = note({ text: "The staging database password rotates every Monday." }, options());
    const payments = note({ text: "Payments use the Razorpay sandbox key in staging." }, options());
    const found = recall("staging", options());
    expect(found.entries.map(e => e.id).sort()).toEqual([password.entry.mex.id, payments.entry.mex.id].sort());
    expect(recall("Razorpay", options())).toMatchObject({ entries: [{ id: payments.entry.mex.id }], ranking: { engine: "native" } });
  });
});

describe("the truth gate on pulled knowledge", () => {
  it("leaves out what the code no longer matches and marks what changed", () => {
    const at = new Date("2026-11-20T10:00:00Z");
    const broken = note({ text: "Deploys run from the release branch because QA signs it off there.", kind: "rule", scope: ["**"] }, options(), at);
    const changed = note({ text: "Deploys need the staging smoke test because production broke once.", kind: "rule", scope: ["**"] }, options(), at);
    const held = note({ text: "Deploys tag the commit because rollbacks need the tag.", kind: "rule", scope: ["**"] }, options(), at);
    const project = knowledgeProject(options());
    const hooks = recordLocation({ home }).hooks;
    mkdirSync(dirname(hooks), { recursive: true });
    const db = new DatabaseSync(hooks);
    db.exec("CREATE TABLE verdicts(project_id TEXT, checkout TEXT, entry_id TEXT, verdict TEXT, inputs_hash TEXT, checked_at TEXT, PRIMARY KEY(project_id,checkout,entry_id))");
    const put = db.prepare("INSERT INTO verdicts VALUES(?,?,?,?,'x','2026-11-20T10:00:00Z')");
    put.run(project.projectId, project.root, broken.entry.mex.id, "broken");
    put.run(project.projectId, project.root, changed.entry.mex.id, "changed");
    put.run(project.projectId, project.root, held.entry.mex.id, "held");
    db.close();

    const found = recall("deploys", options());
    expect(found.entries.map(e => e.id).sort()).toEqual([changed.entry.mex.id, held.entry.mex.id].sort());
    expect(found.entries.find(e => e.id === changed.entry.mex.id)?.verdict).toBe("changed");
    expect(found.entries.find(e => e.id === held.entry.mex.id)?.verdict).toBeUndefined();
    expect(found.stale).toBe(1);
    expect(entryVerdict(broken.entry.mex.id, options())).toBe("broken");
  });
});
