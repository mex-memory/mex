import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGraphEngine } from "../engine-impl.js";
import { loadFreshGraphReadSession } from "../read-session.js";
import { inspectGraphStatus } from "../status.js";
import { withFullGraphDiscovery } from "../read-discovery.js";

const roots: string[] = [];
const original = "def value():\n    return 1\n";
const changed = "def value():\n    return 2\n";
const stableMtime = new Date(1_700_000_000_000);
const now = new Date("2026-10-23T00:00:00.000Z");
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function put(root: string, file: string, content: string): void { const target = join(root, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content); if (file.endsWith(".py")) utimesSync(target, stableMtime, stableMtime); }
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "-c", "core.autocrlf=false", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
async function build(root: string): Promise<void> { const engine = createGraphEngine({ rootDir: root }); try { await engine.build(); } finally { engine.close(); } }
async function fixture(withGit = true): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "mex-exact-read-")); roots.push(root);
  put(root, "src/a.py", original); put(root, "src/b.py", "def caller():\n    return 3\n");
  put(root, "tsconfig.json", '{"compilerOptions":{"baseUrl":"."}}');
  put(root, ".gitignore", ".mex/\n");
  if (withGit) { git(root, "init", "-b", "fixture"); git(root, "add", "."); git(root, "commit", "-m", "fixture"); }
  await build(root); return root;
}
async function compare(root: string) {
  const fast = await inspectGraphStatus({ projectRoot: root, now });
  const full = await withFullGraphDiscovery(() => inspectGraphStatus({ projectRoot: root, now }));
  expect(fast).toEqual(full);
  return fast;
}

describe("graph read freshness equivalence", () => {
  const cases: Array<[string, (root: string) => void, boolean]> = [
    ["source edit", root => put(root, "src/a.py", changed + "# changed\n"), true],
    ["same-size source edit", root => put(root, "src/a.py", changed), true],
    ["same-size edit with restored mtime", root => { const before = statSync(join(root, "src/a.py")); put(root, "src/a.py", changed); utimesSync(join(root, "src/a.py"), before.atime, before.mtime); expect(statSync(join(root, "src/a.py")).mtimeMs).toBe(before.mtimeMs); }, true],
    ["source addition", root => put(root, "src/new.py", original), true],
    ["source deletion", root => rmSync(join(root, "src/a.py")), true],
    ["source rename", root => renameSync(join(root, "src/a.py"), join(root, "src/renamed.py")), true],
    ["case-only source rename", root => { renameSync(join(root, "src/a.py"), join(root, "src/temporary")); renameSync(join(root, "src/temporary"), join(root, "src/A.py")); }, true],
    ["gitignore change", root => put(root, ".gitignore", ".mex/\nsrc/a.py\n"), false],
    ["graph ignore configuration", root => put(root, ".mex/config.json", '{"graph":{"ignore":["src/a.py"]}}'), true],
    ["graph include configuration retains the existing policy", root => put(root, ".mex/config.json", '{"graph":{"include":["src/b.py"]}}'), false],
    ["project configuration edit", root => put(root, "tsconfig.json", '{"compilerOptions":{"baseUrl":"src"}}'), true],
    ["project configuration addition", root => put(root, "src/tsconfig.project.json", '{"extends":"../tsconfig.json"}'), true],
    ["project configuration deletion", root => rmSync(join(root, "tsconfig.json")), true],
    ["branch switch", root => git(root, "checkout", "-b", "other"), true],
    ["checkout changed source", root => { put(root, "src/a.py", changed); git(root, "add", "--renormalize", "src/a.py"); git(root, "commit", "-m", "changed"); git(root, "checkout", "HEAD~1", "--", "src/a.py"); put(root, "src/b.py", original); }, true],
    ["commit changed source", root => { put(root, "src/a.py", changed); git(root, "add", "--renormalize", "src/a.py"); git(root, "commit", "-m", "changed"); }, true],
    ["uncommitted source change", root => put(root, "src/a.py", changed), true],
    ["untracked source change", root => put(root, "untracked.py", original), true],
    ["staged source change", root => { put(root, "src/a.py", changed); git(root, "add", "--renormalize", "src/a.py"); }, true],
    ["index-only change with original worktree bytes", root => { put(root, "src/a.py", changed); git(root, "add", "--renormalize", "src/a.py"); put(root, "src/a.py", original); }, false],
    ["assume-unchanged source change", root => { git(root, "update-index", "--assume-unchanged", "src/a.py"); put(root, "src/a.py", changed); expect(git(root, "status", "--porcelain")).toBe(""); }, true],
    ["skip-worktree source change", root => { git(root, "update-index", "--skip-worktree", "src/a.py"); put(root, "src/a.py", changed); expect(git(root, "status", "--porcelain")).toBe(""); }, true],
  ];
  for (const [name, mutate, stale] of cases) it(name, async () => {
    const root = await fixture(); expect((await compare(root)).status).toBe("fresh");
    mutate(root); const status = await compare(root); if (stale) expect(status.status).not.toBe("fresh");
  });
  it("detects removal of a previously indexed ignore rule", async () => {
    const root = await fixture(); put(root, ".mex/config.json", '{"graph":{"ignore":["src/b.py"]}}');
    await build(root); expect((await compare(root)).status).toBe("fresh");
    rmSync(join(root, ".mex/config.json")); expect((await compare(root)).status).not.toBe("fresh");
  });
  it("hashes source hidden from Git by an ignore rule", async () => {
    const root = await fixture(); put(root, ".gitignore", ".mex/\nignored.py\n");
    put(root, "ignored.py", original); await build(root);
    expect((await compare(root)).status).toBe("fresh");
    expect(git(root, "status", "--porcelain")).not.toContain("ignored.py");
    const before = statSync(join(root, "ignored.py")); put(root, "ignored.py", changed);
    expect(statSync(join(root, "ignored.py")).mtimeMs).toBe(before.mtimeMs);
    const status = await compare(root); expect(status.status).not.toBe("fresh");
    expect(status.changes.modified).toContain("ignored.py");
  });
  it("walks a non-Git repository and detects restored-mtime edits", async () => {
    const root = await fixture(false); await compare(root);
    const before = statSync(join(root, "src/a.py")); put(root, "src/a.py", changed); utimesSync(join(root, "src/a.py"), before.atime, before.mtime);
    expect((await compare(root)).status).not.toBe("fresh");
  });
  it("revokes an open read when the database is replaced", async () => {
    const root = await fixture(); const path = join(root, ".mex/graph.db");
    const saved = join(root, ".mex/replacement.db"); copyFileSync(path, saved);
    const loaded = await loadFreshGraphReadSession(root); expect(loaded.session).not.toBeNull();
    try {
      const later = new Date(Date.now() + 2000); copyFileSync(saved, path); utimesSync(path, later, later);
      expect(await loaded.session!.revalidateFreshness()).toMatchObject({ valid: false, code: "GRAPH_INDEX_READER_SNAPSHOT_CHANGED" });
    } finally { loaded.session?.close(); }
  });
  it("revokes an open read when the graph is rebuilt", async () => {
    const root = await fixture(); const loaded = await loadFreshGraphReadSession(root); expect(loaded.session).not.toBeNull();
    try { put(root, "src/a.py", changed); await build(root); expect(await loaded.session!.revalidateFreshness()).toMatchObject({ valid: false, code: "GRAPH_INDEX_READER_SNAPSHOT_CHANGED" }); }
    finally { loaded.session?.close(); }
  });
  it("matches the full-walk verdict after every seeded random edit", async () => {
    const root = await fixture(); let seed = 282;
    const next = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    for (let step = 0; step < 40; step++) {
      const file = `src/random-${next() % 5}.py`;
      switch (next() % 6) {
        case 0: put(root, file, `def random_value():\n    return ${next() % 100}\n`); break;
        case 1: rmSync(join(root, file), { force: true }); break;
        case 2: { const before = statSync(join(root, "src/a.py")); put(root, "src/a.py", next() % 2 ? original : changed); utimesSync(join(root, "src/a.py"), before.atime, before.mtime); break; }
        case 3: put(root, "tsconfig.json", JSON.stringify({ include: [next() % 2 ? "src" : "lib"] })); break;
        case 4: put(root, ".mex/config.json", JSON.stringify({ graph: { ignore: next() % 2 ? ["src/random-0.py"] : [] } })); break;
        case 5: put(root, "src/a.py", original); break;
      }
      await compare(root);
      if (step % 8 === 7) { await build(root); expect((await compare(root)).status).toBe("fresh"); }
    }
  }, 60_000);
});
