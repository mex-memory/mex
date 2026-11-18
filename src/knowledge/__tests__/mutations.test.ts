import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecordReadOnly, projectIdentity } from "../../record/index.js";
import { note, recall, expand } from "../store.js";
import { edit, forget, wrong } from "../mutations.js";
import { parseEntry, serializeEntry } from "../entry.js";

let root: string, repo: string, home: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe", timeout: 5000 });
const options = () => ({ home, projectPath: repo, isNetwork: () => false });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-note-mutations-")); repo = join(root, "repo"); home = join(root, "home"); mkdirSync(repo);
  git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.test");
  writeFileSync(join(repo, "README.md"), "# Fixture\n"); git(repo, "add", "README.md"); git(repo, "commit", "-m", "Fixture");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const entryPath = (id: string) => join(home, "projects", projectIdentity(repo).id, "notes", `${id}.md`);

describe("explicit personal note changes", () => {
  it("keeps identity, scope and creation date while replacing the human claim and dropping obsolete checks", () => {
    const saved = note({ text: "Tests use fixtures for reproducibility.", scope: ["test/**"] }, options(), new Date("2026-11-01"));
    const id = saved.entry.mex.id;
    saved.entry.mex.checks = [{ kind: "source", role: "supporting", target: { file: "README.md" }, saw: { hash: `sha256:${"a".repeat(64)}` }, files: {} }];
    saved.entry.mex.when = [{ type: "required", match: "literal", pattern: "fixtures" }];
    writeFileSync(entryPath(id), serializeEntry(saved.entry));
    const changed = edit(id, { text: "Tests use seeded fixtures because randomness is reproducible." }, options(), new Date("2026-11-14"));
    expect(changed.entry.mex).toMatchObject({ id, created: "2026-11-01", scope: ["test/**"], checks: [], evidence: "person", source: { quote: changed.entry.text } });
    expect(changed.entry.mex).not.toHaveProperty("when");
    expect(expand(id, options()).entry).toEqual(changed.entry);
    expect(recall("seeded", options()).entries[0].id).toBe(id);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("never revives a forgotten id even if its old active file is restored, across worktrees and clones", () => {
    const saved = note({ text: "Old fixture behavior remains only until it is forgotten." }, options());
    const id = saved.entry.mex.id, original = readFileSync(entryPath(id), "utf8");
    const worktree = join(root, "worktree"), clone = join(root, "clone");
    git(repo, "worktree", "add", "-b", "other", worktree);
    execFileSync("git", ["clone", "--no-local", repo, clone], { stdio: "pipe", timeout: 5000 });
    expect(forget(id, "The behavior changed.", options(), new Date("2026-11-14"))).toMatchObject({ id, retired: { reason: "The behavior changed.", by: "mex forget", at: "2026-11-14" } });
    writeFileSync(entryPath(id), original);
    for (const projectPath of [repo, worktree, clone]) {
      expect(recall("fixture", { ...options(), projectPath }).entries).toEqual([]);
      expect(() => expand(id, { ...options(), projectPath })).toThrow(/No active/);
      expect(() => edit(id, { text: "Restored." }, { ...options(), projectPath })).toThrow();
    }
    const reader = openRecordReadOnly(options())!;
    expect(reader.setting(projectIdentity(repo).id, `knowledge.retired.${id}`)).toContain("The behavior changed."); reader.close();
    // Runtime suppression lives in the local record, never in the entry contract.
    expect(parseEntry(readFileSync(entryPath(id), "utf8"))).toEqual(saved.entry);
    expect(note({ text: saved.entry.text }, options()).entry.mex.id).not.toBe(id);
  });

  it("records wrong as an explicit retirement without evaluating or delivering the claim", () => {
    const saved = note({ text: "An incorrect claim." }, options());
    expect(wrong(saved.entry.mex.id, "Contradicted by current behavior.", options()).retired.by).toBe("mex wrong");
    expect(recall("incorrect", options()).entries).toEqual([]);
  });

  it("validates edits and retirement reasons before changing bytes or creating state", () => {
    expect(() => edit("mx_absent1", { text: "A fact." }, options())).toThrow();
    expect(() => forget("../outside", "Bad id.", options())).toThrow();
    expect(existsSync(home)).toBe(false);
    const saved = note({ text: "A fact with its reason." }, options());
    const before = readFileSync(entryPath(saved.entry.mex.id), "utf8");
    expect(() => edit(saved.entry.mex.id, { text: " " }, options())).toThrow();
    expect(() => forget(saved.entry.mex.id, "", options())).toThrow();
    expect(() => forget(saved.entry.mex.id, "gh\u200bp_" + "x".repeat(36), options())).toThrow(/possible secret/);
    expect(readFileSync(entryPath(saved.entry.mex.id), "utf8")).toBe(before);
    expect(expand(saved.entry.mex.id, options()).entry).toEqual(saved.entry);
  });
});
