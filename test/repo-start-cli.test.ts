import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realPath } from "../src/record/project.js";
import { KILL_AT_VARIABLE, KILL_POINTS } from "../src/repo-start/command.js";

const cli = resolve("dist/cli.js"), temps: string[] = [];
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
}
function fixture() {
  const base = realPath(mkdtempSync(join(tmpdir(), "mex-repo-start-"))); temps.push(base);
  const root = join(base, "repo"); mkdirSync(root);
  git(root, "init", "-q");
  writeFileSync(join(root, "README.md"), "# demo\n");
  git(root, "add", "."); git(root, "commit", "-qm", "init");
  const env: NodeJS.ProcessEnv = { ...process.env, MEX_HOME: base, HOME: base, USERPROFILE: base, MEX_TELEMETRY: "0", MEX_BACKGROUND: "0", MEX_INSTALL_AUTO: "0", MEX_OFFLINE: "1" };
  delete env.CLAUDECODE; delete env.CODEX_THREAD_ID; delete env.NO_COLOR;
  const exclude = join(root, ".git", "info", "exclude");
  return {
    base, root, env, exclude, home: join(base, ".mex"),
    run: (args: string[] = [], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
      spawnSync(process.execPath, [cli, ...args], { cwd: options.cwd ?? root, env: { ...env, ...options.env }, encoding: "utf8", timeout: 20_000 }),
    status: (cwd = root) => git(cwd, "status", "--porcelain", "--untracked-files=all"),
  };
}
/** What MEX and 0.8 setups leave under .mex/ in a checkout: all local. */
function localState(root: string): void {
  mkdirSync(join(root, ".mex", "local"), { recursive: true });
  writeFileSync(join(root, ".mex", "local", "state.json"), "{}\n");
  writeFileSync(join(root, ".mex", "graph.db"), "");
  writeFileSync(join(root, ".mex", "wiki.db-wal"), "");
}
function leftovers(f: ReturnType<typeof fixture>): string[] {
  const found = readdirSync(join(f.root, ".git", "info")).filter(name => name.startsWith(".mex-"));
  const projects = join(f.home, "projects");
  if (existsSync(projects)) for (const id of readdirSync(projects)) {
    found.push(...readdirSync(join(projects, id)).filter(name => /^\.(setup|recipes|code-facts)\.json\./u.test(name)));
  }
  return found;
}

describe("bare mex in a repository", () => {
  it("turns the repo on, shows the first screen and leaves nothing in git status", () => {
    const f = fixture();
    const before = readFileSync(f.exclude);
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^MEX - repo - \d+\.\d s - \$0 - nothing added to git$/u);
    expect(lines).toContain(".. Git history and the file index: in the background (`mex jobs`)");
    expect(lines).toContain("ok No test or build commands found in config");
    expect(result.stdout).not.toMatch(/\x1b\[/u);
    localState(f.root);
    expect(f.status()).toBe("");
    // What `mex share` commits stays visible.
    mkdirSync(join(f.root, ".mex", "learned"));
    writeFileSync(join(f.root, ".mex", "learned", "mx_1.md"), "note\n");
    writeFileSync(join(f.root, ".mex", "config.json"), "{}\n");
    expect(f.status().split("\n").sort()).toEqual(["?? .mex/config.json", "?? .mex/learned/mx_1.md"]);
    expect(readFileSync(f.exclude, "utf8").startsWith(before.toString("utf8"))).toBe(true);

    const setup = JSON.parse(readFileSync(join(f.home, "projects", readdirSync(join(f.home, "projects"))[0]!, "setup.json"), "utf8"));
    expect(setup).toMatchObject({ version: 1, caller: "script", exclude: { file: f.exclude, block: true } });
    expect(Number.isInteger(setup.ms)).toBe(true);

    // `mex setup` is an alias; a second run journals nothing new.
    const again = f.run(["setup"], { env: { CLAUDECODE: "1" } });
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout.split("\n")[0]).toMatch(/^MEX - repo - /u);

    // Uninstall gives the exclude file back byte for byte.
    const uninstall = f.run(["uninstall"]);
    expect(uninstall.status, uninstall.stderr).toBe(0);
    expect(uninstall.stdout).toContain(f.exclude);
    expect(readFileSync(f.exclude).equals(before)).toBe(true);
  });

  it("lists recipes from config on the screen and saves recipes.json outside the repo", () => {
    const f = fixture();
    writeFileSync(join(f.root, "package.json"), JSON.stringify({ name: "demo", workspaces: ["packages/*"], scripts: { test: "vitest run", build: "tsc -b" } }));
    mkdirSync(join(f.root, "packages", "core"), { recursive: true });
    mkdirSync(join(f.root, "packages", "web"), { recursive: true });
    writeFileSync(join(f.root, "packages", "core", "package.json"), JSON.stringify({ name: "@demo/core", scripts: { build: "tsc" } }));
    writeFileSync(join(f.root, "packages", "web", "package.json"), JSON.stringify({ name: "@demo/web", dependencies: { "@demo/core": "*" }, scripts: { test: "vitest" } }));
    git(f.root, "add", "."); git(f.root, "commit", "-qm", "workspace");
    const result = f.run([], { env: { MEX_HOOK_BINARY: join(f.base, "missing-hook") } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ok Test and build commands for 3 packages (build @demo/core first)");
    const projects = join(f.home, "projects");
    const recipes = JSON.parse(readFileSync(join(projects, readdirSync(projects)[0]!, "recipes.json"), "utf8"));
    expect(recipes).toMatchObject({ version: 1, manager: "npm", build_order: ["packages/core", "packages/web"], checks: "no evaluator" });
    expect(recipes.recipes.map((recipe: { command: string }) => recipe.command).sort()).toEqual([
      "npm run build", "npm run build --workspace packages/core", "npm run test", "npm run test --workspace packages/web",
    ]);
    const setup = JSON.parse(readFileSync(join(projects, readdirSync(projects)[0]!, "setup.json"), "utf8"));
    expect(setup.found).toMatchObject({ packages: 3, recipes: 4 });
    expect(f.status()).toBe("");
  });

  it("mines git history in the background; a job killed mid-batch is redone and leaves no half-written file", () => {
    const f = fixture();
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(f.root, "schema.ts"), `export const v = ${i};\n`);
      writeFileSync(join(f.root, "types.ts"), `export type V = ${i};\n`);
      git(f.root, "add", "."); git(f.root, "commit", "-qm", `change ${i}`);
    }
    expect(f.run().status).toBe(0);
    const projects = join(f.home, "projects");
    const facts = () => join(projects, readdirSync(projects)[0]!, "code-facts.json");
    const killed = f.run(["jobs", "run"], { env: { [KILL_AT_VARIABLE]: "code-facts" } });
    expect(killed.signal).toBe("SIGKILL");
    expect(existsSync(facts())).toBe(false);
    const again = f.run(["jobs", "run"]);
    expect(again.status, again.stderr).toBe(0);
    const mined = JSON.parse(readFileSync(facts(), "utf8"));
    expect(mined).toMatchObject({ version: 1, skipped: null, commits_read: 5 });
    expect(mined.change_together).toContainEqual({ a: "schema.ts", b: "types.ts", confidence: 1, support: 4 });
    expect(leftovers(f)).toEqual([]);
    expect(f.status()).toBe("");
  });

  it("says a shallow clone skips git history", () => {
    const f = fixture();
    writeFileSync(join(f.root, "b.txt"), "b\n"); git(f.root, "add", "."); git(f.root, "commit", "-qm", "second");
    const shallow = join(f.base, "shallow");
    git(f.base, "clone", "-q", "--depth", "1", `file://${f.root}`, shallow);
    const result = f.run([], { cwd: shallow });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("!! Git history: skipped, this is a shallow clone (`git fetch --unshallow` to add it)");
    expect(result.stdout).toContain(".. The file index: in the background (`mex jobs`)");
    const projects = join(f.home, "projects");
    expect(JSON.parse(readFileSync(join(projects, readdirSync(projects)[0]!, "code-facts.json"), "utf8"))).toMatchObject({ skipped: "shallow clone" });
  });

  it("covers the repository's other worktrees and keeps them clean", () => {
    const f = fixture();
    const wt = join(f.base, "wt");
    git(f.root, "worktree", "add", "-q", wt, "-b", "wt");
    expect(f.run([], { cwd: wt }).status).toBe(0);
    localState(f.root); localState(wt);
    expect(f.status()).toBe("");
    expect(f.status(wt)).toBe("");
    // Both checkouts are registered; `mex off` in one now works without "Run `mex` first".
    const off = f.run(["off"]);
    expect(off.status, off.stderr).toBe(0);
  });

  it("keeps a 0.8 scaffold's tracked files and hides its local ones, and points to the Hub", () => {
    const f = fixture();
    mkdirSync(join(f.root, ".mex", "context"), { recursive: true });
    writeFileSync(join(f.root, ".mex", "ROUTER.md"), "# Router\n");
    writeFileSync(join(f.root, ".mex", "context", "architecture.md"), "# Architecture\n");
    writeFileSync(join(f.root, ".mex", ".gitignore"), "graph.db*\nwiki.db*\nlocal/\n");
    git(f.root, "add", "."); git(f.root, "commit", "-qm", "0.8 scaffold");
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("This repo has MEX 0.8 project files; `mex hub` opens them.");
    localState(f.root);
    expect(f.status()).toBe("");
    writeFileSync(join(f.root, ".mex", "ROUTER.md"), "# Router, edited\n");
    expect(f.status()).toBe("M .mex/ROUTER.md");
  });

  it("never turns an off repo back on and leaves its exclude file alone", () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    expect(f.run(["off"]).status).toBe(0);
    const uninstall = f.run(["uninstall"]);
    expect(uninstall.status).toBe(0);
    const before = readFileSync(f.exclude);
    const result = f.run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("MEX is off for this repo. Run `mex on` to turn it back on.");
    expect(readFileSync(f.exclude).equals(before)).toBe(true);
  });

  it("refuses the home folder and does nothing in a folder that isn't a repo", () => {
    const f = fixture();
    const home = f.run([], { env: { HOME: f.root, USERPROFILE: f.root } });
    expect(home.status).toBe(1);
    expect(home.stdout).toContain("doesn't turn on in your home folder");
    const plain = join(f.base, "plain"); mkdirSync(plain);
    const folder = f.run([], { cwd: plain });
    expect(folder.status).toBe(0);
    expect(folder.stdout).toContain("isn't a git repo");
    expect(existsSync(join(f.home, "record.db"))).toBe(false);
  });

  it.skipIf(process.platform === "win32").each(KILL_POINTS)("an interruption after %s leaves a clean state and the next run finishes", (point) => {
    const f = fixture();
    const before = readFileSync(f.exclude);
    const killed = f.run([], { env: { [KILL_AT_VARIABLE]: point } });
    expect(killed.signal).toBe("SIGKILL");
    expect(leftovers(f)).toEqual([]);
    expect(f.status()).toBe("");
    const after = readFileSync(f.exclude);
    expect(after.equals(before) || after.toString("utf8").includes("# mex: repo-start end\n")).toBe(true);
    const next = f.run();
    expect(next.status, next.stderr).toBe(0);
    expect(next.stdout).toMatch(/^MEX - repo - .* - nothing added to git\n/u);
    localState(f.root);
    expect(f.status()).toBe("");
    expect(f.run(["uninstall"]).status).toBe(0);
    expect(readFileSync(f.exclude).equals(before)).toBe(true);
  });
});
