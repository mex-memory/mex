import { currentGraphPath } from "../src/graph/storage.js";
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rebuildGraph } from "../src/graph/maintenance.js";

/**
 * Issue #110: `mex graph` in a checkout that had never run `mex setup` left
 * `graph.db`, `-wal` and `-shm` untracked, so the reporter's next `git add -A`
 * would have committed a database. The graph now lives in the MEX home, not
 * the checkout, so a graph build leaves nothing in the repository to stage
 * and writes no ignore rules there either.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-store-ignore-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export function hello(): number {\n  return 1;\n}\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "probe", version: "0.0.0" }));
  return root;
}

describe("local store protection outside mex setup (#110)", () => {
  it("builds the graph outside the checkout and writes nothing into it", async () => {
    const root = scratchRepo();
    const before = readdirSync(root).sort();

    await rebuildGraph(root);

    expect(existsSync(currentGraphPath(root))).toBe(true);
    expect(currentGraphPath(root).toLowerCase().startsWith(root.toLowerCase())).toBe(false);
    expect(readdirSync(root).sort()).toEqual(before);
  });

  it("leaves `git add -A` nothing of MEX's to stage, which is the actual complaint", async () => {
    const root = scratchRepo();

    await rebuildGraph(root);
    execFileSync("git", ["add", "-A"], { cwd: root });
    const staged = execFileSync("git", ["ls-files", "--cached"], { cwd: root, encoding: "utf-8" });

    expect(staged.split(/\r?\n/).filter(Boolean).sort()).toEqual(["package.json", "src/a.ts"]);
  });

  it("does not touch an existing .mex/.gitignore", async () => {
    const root = scratchRepo();
    mkdirSync(join(root, ".mex"));
    writeFileSync(join(root, ".mex", ".gitignore"), "# hand written\nscratch/\n");

    await rebuildGraph(root);

    expect(readFileSync(join(root, ".mex", ".gitignore"), "utf-8")).toBe("# hand written\nscratch/\n");
  });
});
