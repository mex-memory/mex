import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KnowledgeError } from "../contract.js";
import { prepareShare } from "../share-plan.js";
import { discardShare, finishShare, runShare } from "../share.js";
import { note } from "../store.js";
import { shareRepo } from "./share-fixtures.js";

const now = new Date("2026-11-15T12:00:00Z");

/** A repo on main with a 0.8 config and Claude in use, you on a feature branch with work in progress. */
function setup() {
  const repo = shareRepo();
  const { root, git } = repo;
  mkdirSync(join(root, ".mex")); mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".mex", "config.json"), JSON.stringify({ scaffold_id: "keep-me" }));
  writeFileSync(join(root, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(root, "CLAUDE.md"), "# Ours\n\nRun the tests first.\n");
  git("add", "."); git("commit", "-qm", "setup");
  git("checkout", "-qb", "feature");
  writeFileSync(join(root, "work.txt"), "unsaved work\n");
  const saved = note({ text: "Use date-fns, not moment, because moment is unmaintained." }, { projectPath: root }).entry;
  return { ...repo, id: saved.mex.id };
}
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as KnowledgeError).code; } return "none"; };

describe("mex share", () => {
  it("commits to a new branch from main and leaves your branch alone", () => {
    const { root, git, id } = setup();
    const before = git("status", "--porcelain");
    const head = git("rev-parse", "HEAD");
    const plan = prepareShare({ projectPath: root }, { now });
    const result = runShare({ projectPath: root }, plan.revision, { now });

    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("status", "--porcelain")).toBe(before);
    expect(readFileSync(join(root, "work.txt"), "utf8")).toBe("unsaved work\n");
    expect(git("worktree", "list").split("\n")).toHaveLength(1);

    expect(result.branch).toBe("mex/share-2026-11-15");
    expect(git("rev-parse", `${result.branch}~1`)).toBe(git("rev-parse", "main"));
    expect(result.files.sort()).toEqual([".claude/rules/mex.md", ".mex/config.json", `.mex/learned/${id}.md`, ".mex/native.json", ".mex/sources.json"]);
    expect(JSON.parse(git("show", `${result.branch}:.mex/config.json`))).toEqual({ scaffold_id: "keep-me", knowledge: { version: 1, shared: true } });
    expect(JSON.parse(git("show", `${result.branch}:.mex/sources.json`)).rule_files.map((f: { path: string }) => f.path)).toEqual(["CLAUDE.md"]);
    expect(git("show", `${result.branch}:.claude/rules/mex.md`)).toContain(id);
    // Nothing left to share now that main... still lacks it: the branch isn't merged.
    expect(code(() => runShare({ projectPath: root }, plan.revision, { now }))).toBe("STALE_PREVIEW");
  });

  it("a killed share can be finished", () => {
    const { root, git, id } = setup();
    const plan = prepareShare({ projectPath: root }, { now });
    expect(code(() => runShare({ projectPath: root }, plan.revision, { now, stopAfter: "written" }))).toBe("SHARE_STOPPED");
    expect(code(() => runShare({ projectPath: root }, plan.revision, { now }))).toBe("SHARE_IN_PROGRESS");
    const done = finishShare({ projectPath: root }, { now });
    expect(git("show", `${done.branch}:.mex/learned/${id}.md`)).toContain("date-fns");
    expect(git("worktree", "list").split("\n")).toHaveLength(1);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
  });

  it("a share killed before writing can be finished too", () => {
    const { root, git } = setup();
    const plan = prepareShare({ projectPath: root }, { now });
    code(() => runShare({ projectPath: root }, plan.revision, { now, stopAfter: "worktree" }));
    const done = finishShare({ projectPath: root }, { now });
    expect(git("log", "--oneline", "-1", done.branch)).toContain("Share team knowledge: 1 entry");
  });

  it("a killed share can be discarded: worktree gone, empty branch gone, nothing forced", () => {
    const { root, git } = setup();
    const plan = prepareShare({ projectPath: root }, { now });
    code(() => runShare({ projectPath: root }, plan.revision, { now, stopAfter: "written" }));
    const result = discardShare({ projectPath: root });
    expect(result).toEqual({ branch: "mex/share-2026-11-15", branchKept: false });
    expect(git("worktree", "list").split("\n")).toHaveLength(1);
    expect(git("branch", "--list", "mex/*")).toBe("");
    expect(code(() => finishShare({ projectPath: root }))).toBe("SHARE_NONE");
  });

  it("a committed share that was killed keeps its branch when discarded", () => {
    const { root, git } = setup();
    const plan = prepareShare({ projectPath: root }, { now });
    code(() => runShare({ projectPath: root }, plan.revision, { now, stopAfter: "committed" }));
    expect(discardShare({ projectPath: root })).toEqual({ branch: "mex/share-2026-11-15", branchKept: true });
    expect(git("branch", "--list", "mex/*")).toContain("mex/share-2026-11-15");
  });
});
