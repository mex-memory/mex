import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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
});
