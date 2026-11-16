import { existsSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearShareState, firstLink, readShareState, removeWorktree, saveShareState } from "../share-state.js";
import { shareRepo } from "./share-fixtures.js";

describe("share state and cleanup", () => {
  it("records, reads and clears a share in progress", () => {
    const dir = mkdtempSync(join(tmpdir(), "mex-share-state-"));
    expect(readShareState(dir)).toBeUndefined();
    const state = { version: 1 as const, branch: "mex/share-2026-11-15", base: "abc", worktree: "/tmp/x", step: "written" as const, ids: ["mx_aaaaaa"], started: "2026-11-15" };
    saveShareState(dir, state);
    expect(readShareState(dir)).toEqual(state);
    clearShareState(dir);
    expect(readShareState(dir)).toBeUndefined();
  });

  it("removes a clean worktree without forcing, and refuses a dirty one", () => {
    const { root, git } = shareRepo();
    const wt = join(root, "..", "wt-clean");
    git("worktree", "add", "-q", "-b", "tmp1", wt);
    removeWorktree(root, wt);
    expect(existsSync(wt)).toBe(false);
    const dirty = join(root, "..", "wt-dirty");
    git("worktree", "add", "-q", "-b", "tmp2", dirty);
    writeFileSync(join(dirty, "README.md"), "changed\n");
    expect(() => removeWorktree(root, dirty)).toThrow(/without forcing/u);
    expect(existsSync(join(dirty, "README.md"))).toBe(true);
  });

  it("stops at a link inside the worktree", () => {
    const { root, git } = shareRepo();
    const wt = join(root, "..", "wt-link");
    git("worktree", "add", "-q", "-b", "tmp3", wt);
    const target = mkdtempSync(join(tmpdir(), "mex-link-target-"));
    mkdirSync(join(wt, "sub"));
    try { symlinkSync(target, join(wt, "sub", "out"), "junction"); } catch { return; }
    expect(firstLink(wt)).toBe(join(wt, "sub", "out"));
    expect(() => removeWorktree(root, wt)).toThrow(/holds a link/u);
    expect(existsSync(target)).toBe(true);
  });

  it("accepts a symlink the repository itself tracks, unchanged, and still stops at any other", () => {
    const { root, git } = shareRepo();
    try { symlinkSync("README.md", join(root, "CLAUDE.md")); } catch { return; }
    git("config", "core.symlinks", "true");
    git("add", "CLAUDE.md"); git("commit", "-qm", "tracked link");
    if (git("ls-files", "-s", "CLAUDE.md").split(" ")[0] !== "120000") return;
    const wt = join(root, "..", "wt-tracked");
    git("worktree", "add", "-q", "-b", "tmp4", wt);
    expect(firstLink(wt)).toBeUndefined();
    removeWorktree(root, wt);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(join(root, "README.md"))).toBe(true);

    const edited = join(root, "..", "wt-edited");
    git("worktree", "add", "-q", "-b", "tmp5", edited);
    unlinkSync(join(edited, "CLAUDE.md")); symlinkSync(tmpdir(), join(edited, "CLAUDE.md"));
    expect(firstLink(edited)).toBe(join(edited, "CLAUDE.md"));

    const extra = join(root, "..", "wt-extra");
    git("worktree", "add", "-q", "-b", "tmp6", extra);
    symlinkSync(tmpdir(), join(extra, "untracked-link"));
    expect(firstLink(extra)).toBe(join(extra, "untracked-link"));
  });
});
