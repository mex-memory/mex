import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { withCheckoutPublication } from "../publication.js";

let root: string, bundleRoot: string, bundle: string;
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
beforeAll(() => {
  bundleRoot = mkdtempSync(join(tmpdir(), "mex-guard-worker-")); bundle = join(bundleRoot, "worker.mjs");
  buildSync({ stdin: { contents: `
    import {execFileSync} from 'node:child_process';
    import {withCheckoutPublication} from ${JSON.stringify(resolve("src/judge/publication.ts"))};
    const root=process.argv[2];
    const head=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
    await withCheckoutPublication(root,{branch:'refs/heads/work',head},()=>process.exit(17));
  `, resolveDir: resolve("."), sourcefile: "guard-worker.ts" }, outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node22" });
});
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }));
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "mex-publication-")));
  git("init", "-q", "-b", "work"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "baseline");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("team fix publication", () => {
  it.each(["normal", "linked"])("holds Git's HEAD/ref locks for a %s checkout and aborts after failure", async kind => {
    const linked = join(root, "linked");
    if (kind === "linked") git("worktree", "add", "-b", "linked", linked);
    const checkout = kind === "linked" ? linked : root;
    const directory = execFileSync("git", ["-C", checkout, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
    const at = { branch: `refs/heads/${kind === "linked" ? "linked" : "work"}`, head: git("rev-parse", "HEAD") };
    try {
      await expect(withCheckoutPublication(checkout, at, () => {
        expect(existsSync(join(directory, "HEAD.lock"))).toBe(true);
        expect(() => execFileSync("git", ["-C", checkout, "switch", "-c", "unrelated"], { stdio: "pipe" })).toThrow();
        throw new Error("publication interrupted");
      })).rejects.toThrow("publication interrupted");
      expect(existsSync(join(directory, "HEAD.lock"))).toBe(false);
      expect(git("rev-parse", "HEAD")).toBe(at.head);
      expect(git("diff", "--cached", "--name-only")).toBe("");
    } finally { if (kind === "linked") git("worktree", "remove", linked); }
  });
  it.each(["HEAD.lock", "refs/heads/work.lock"])("preserves an existing %s and refuses publication", async name => {
    const path = join(root, ".git", name); writeFileSync(path, "another Git operation\n");
    let published = false;
    await expect(withCheckoutPublication(root, { branch: "refs/heads/work", head: git("rev-parse", "HEAD") }, () => { published = true; })).rejects.toThrow("Git could not guard");
    expect(published).toBe(false); expect(readFileSync(path, "utf8")).toBe("another Git operation\n");
  });
  it("aborts Git's transaction when the worker exits without cleanup", async () => {
    const child = spawnSync(process.execPath, [bundle, root], { encoding: "utf8", timeout: 10_000 });
    expect(child.status, child.stderr).toBe(17);
    await expect.poll(() => existsSync(join(root, ".git/HEAD.lock")) || existsSync(join(root, ".git/refs/heads/work.lock")), { timeout: 5000, interval: 10 }).toBe(false);
    git("switch", "-c", "after-crash");
    expect(git("branch", "--show-current")).toBe("after-crash");
  });
  it("never runs reference hooks or changes refs or the index", async () => {
    const hook = join(root, ".git/hooks/reference-transaction");
    writeFileSync(hook, "#!/bin/sh\necho hook-ran > hook-ran\n"); chmodSync(hook, 0o700);
    const head = git("rev-parse", "HEAD"), reflog = git("reflog", "--format=%H");
    await withCheckoutPublication(root, { branch: "refs/heads/work", head }, () => undefined);
    expect(existsSync(join(root, "hook-ran"))).toBe(false); expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("reflog", "--format=%H")).toBe(reflog); expect(git("diff", "--cached", "--name-only")).toBe("");
  });
  it.each(["another branch", "detached HEAD"])("rejects %s at the same commit before publishing", async kind => {
    const at = { branch: "refs/heads/work", head: git("rev-parse", "HEAD") };
    if (kind === "another branch") git("switch", "-c", "unrelated"); else git("checkout", "--detach", "HEAD");
    let published = false;
    await expect(withCheckoutPublication(root, at, () => { published = true; })).rejects.toThrow("branch changed");
    expect(published).toBe(false); expect(existsSync(join(root, ".git/HEAD.lock"))).toBe(false);
  });
});
