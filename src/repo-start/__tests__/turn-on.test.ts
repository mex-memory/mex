import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecord } from "../../record/index.js";
import { realPath } from "../../record/project.js";
import { setCheckoutEnabled } from "../../controls/index.js";
import { classifyPlace, refusedReason } from "../place.js";
import { parseWorktrees, turnOnRepository } from "../turn-on.js";

const temps: string[] = [];
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
}
function repo() {
  const base = realPath(mkdtempSync(join(tmpdir(), "mex-turn-on-"))); temps.push(base);
  const root = join(base, "repo"); mkdirSync(root);
  git(root, "init", "-q"); writeFileSync(join(root, "a.txt"), "a\n"); git(root, "add", "."); git(root, "commit", "-qm", "init");
  return { base, root, home: join(base, "home") };
}

describe("where mex runs", () => {
  it("refuses the home folder, folders above it and drive roots", () => {
    expect(refusedReason("/Users/me", "/Users/me")).toBe("home");
    expect(refusedReason("/Users", "/Users/me")).toBe("above-home");
    expect(refusedReason("/", "/Users/me")).toBe("drive-root");
    expect(refusedReason("/Users/me/code", "/Users/me")).toBeUndefined();
  });

  it("finds the top level from a subfolder, and one shared exclude file for every worktree", () => {
    const r = repo();
    mkdirSync(join(r.root, "sub"));
    git(r.root, "worktree", "add", "-q", join(r.base, "wt"), "-b", "wt");
    const main = classifyPlace(join(r.root, "sub"), { home: r.home });
    const linked = classifyPlace(join(r.base, "wt"), { home: r.home });
    expect(main).toEqual({ kind: "git", root: r.root, excludeFile: join(r.root, ".git", "info", "exclude"), shallow: false });
    expect(linked).toMatchObject({ kind: "git", root: join(r.base, "wt"), excludeFile: join(r.root, ".git", "info", "exclude") });
    mkdirSync(join(r.base, "plain"));
    expect(classifyPlace(join(r.base, "plain"), { home: r.home })).toEqual({ kind: "folder", root: join(r.base, "plain") });
    expect(classifyPlace(r.base, { home: r.home })).toMatchObject({ kind: "refused", reason: "above-home" });
    expect(classifyPlace(r.root, { home: r.root })).toMatchObject({ kind: "refused", reason: "home" });
  });
});

describe("turning a repository on", () => {
  it("parses worktree lists, skipping bare and prunable entries", () => {
    const porcelain = "worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nbare\n\nworktree /c\nHEAD 2\nprunable gitdir file points to non-existent location\n\nworktree /d\nHEAD 3\ndetached\n";
    expect(parseWorktrees(porcelain)).toEqual(["/a", "/d"]);
  });

  it("registers every worktree once and never turns an off checkout back on", () => {
    const r = repo();
    const wt = join(r.base, "wt");
    git(r.root, "worktree", "add", "-q", wt, "-b", "wt");
    const writer = openRecord({ home: r.home, isNetwork: () => false });
    try {
      const first = turnOnRepository(writer, r.root);
      expect(first).toMatchObject({ registered: true, worktrees: 1 });
      expect(first.projectId).toMatch(/^g-/u);
      const rows = writer.db.prepare("SELECT project_id,path,state FROM checkouts ORDER BY path").all();
      expect(rows).toEqual([
        { project_id: first.projectId, path: r.root, state: "on" },
        { project_id: first.projectId, path: wt, state: "on" },
      ]);
      setCheckoutEnabled(writer, wt, false);
      const again = turnOnRepository(writer, r.root);
      expect(again).toMatchObject({ registered: false, worktrees: 0 });
      const fromWorktree = turnOnRepository(writer, wt);
      expect(fromWorktree.checkout.state).toBe("off");
    } finally { writer.close(); }
  });
});
