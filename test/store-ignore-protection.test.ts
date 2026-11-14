import { currentGraphPath } from "../src/graph/storage.js";
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rebuildGraph } from "../src/graph/maintenance.js";
import { SETUP_IGNORE_RULES } from "../src/setup/ignore.js";

/**
 * Issue #110: `mex graph` in a checkout that had never run `mex setup` left
 * `graph.db`, `-wal` and `-shm` untracked, so the reporter's next `git add -A`
 * would have committed a database. Setup writes `.mex/.gitignore` at step 2,
 * but a store writer invoked on its own never passed through setup.
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
  it("writes .mex/.gitignore before a graph rebuild creates the store", async () => {
    const root = scratchRepo();

    await rebuildGraph(root);

    const ignorePath = join(root, ".mex", ".gitignore");
    expect(existsSync(currentGraphPath(root))).toBe(true);
    expect(existsSync(ignorePath)).toBe(true);
    const rules = readFileSync(ignorePath, "utf-8").split(/\r?\n/);
    for (const rule of SETUP_IGNORE_RULES) expect(rules).toContain(rule);
  });

  it("leaves `git add -A` unable to stage the store, which is the actual complaint", async () => {
    const root = scratchRepo();

    await rebuildGraph(root);
    execFileSync("git", ["add", "-A"], { cwd: root });
    const staged = execFileSync("git", ["ls-files", "--cached"], { cwd: root, encoding: "utf-8" });

    expect(staged).toContain(".mex/.gitignore");
    expect(staged).not.toMatch(/graph\.db/);
  });

  it("does not disturb an existing ignore file's own rules", async () => {
    const root = scratchRepo();
    mkdirSync(join(root, ".mex"));
    writeFileSync(join(root, ".mex", ".gitignore"), "# hand written\nscratch/\n");

    await rebuildGraph(root);

    const content = readFileSync(join(root, ".mex", ".gitignore"), "utf-8");
    expect(content).toContain("# hand written");
    expect(content).toContain("scratch/");
    for (const rule of SETUP_IGNORE_RULES) expect(content).toContain(rule);
  });
});
