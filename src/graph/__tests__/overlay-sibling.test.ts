import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ensureGraphCurrent, rebuildGraph, refreshGraph } from "../maintenance.js";
import { openGraphRead } from "../overlay-open.js";
import { graphLocation, readGraphPointer } from "../storage.js";

/**
 * One base per repository: a worktree that leaves for a branch too different
 * for an overlay gets a base of its own, and when it comes back near a
 * sibling's base its next refresh overlays that base again and the extra base
 * is collected.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) {
    try { git(root, "worktree", "prune"); } catch { /* not a repository */ }
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
}
async function inHome<T>(home: string, work: () => Promise<T> | T): Promise<T> {
  vi.stubEnv("MEX_HOME", home);
  try { return await work(); } finally { vi.unstubAllEnvs(); }
}
const TABLES: Record<string, string> = {
  nodes: "SELECT id, kind, name, qualified_name, file_path, start_line, end_line, body_hash FROM nodes",
  edges: "SELECT source, target, kind, line, col FROM edges",
  files: "SELECT path, content_hash, parse_status, node_count FROM files",
  file_row_digests: "SELECT * FROM file_row_digests",
};
function images(root: string): Record<string, string[]> {
  const db = openGraphRead(root)!;
  try {
    return Object.fromEntries(Object.entries(TABLES).map(([table, sql]) =>
      [table, (db.prepare(sql).all() as unknown[]).map((row) => JSON.stringify(Object.values(row as object))).sort()]));
  } finally { db.close(); }
}

const FILES = 210;
const source = (index: number, tag: string): string => `def f${index}():\n    return ${index}  # ${tag}\n`;

describe("a worktree returns to its sibling's base", () => {
  it("overlays the closest base after a large branch switch", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mex-sibling-"));
    const home = mkdtempSync(join(tmpdir(), "mex-sibling-home-"));
    const fresh = mkdtempSync(join(tmpdir(), "mex-sibling-fresh-"));
    roots.push(parent, home, fresh);
    const main = join(parent, "main"), side = join(parent, "side");
    mkdirSync(join(main, "pkg"), { recursive: true });
    git(main, "init", "-q", "-b", "main", ".");
    for (let index = 0; index < FILES; index++) writeFileSync(join(main, "pkg", `m${index}.py`), source(index, "main"));
    git(main, "add", "-A"); git(main, "commit", "-q", "-m", "main");
    git(main, "checkout", "-q", "-b", "large");
    for (let index = 0; index < FILES; index++) writeFileSync(join(main, "pkg", `m${index}.py`), source(index, "large"));
    git(main, "commit", "-q", "-am", "large");
    git(main, "checkout", "-q", "main");
    git(main, "checkout", "-q", "-b", "small");
    writeFileSync(join(main, "pkg", "m0.py"), source(0, "small"));
    git(main, "commit", "-q", "-am", "small");
    git(main, "checkout", "-q", "main");

    await inHome(home, () => rebuildGraph(main));
    const shared = (await inHome(home, () => readGraphPointer(graphLocation(main))))!.base;
    git(main, "worktree", "add", "-q", "--detach", side, "main");
    await inHome(home, () => ensureGraphCurrent(side));
    expect((await inHome(home, () => readGraphPointer(graphLocation(side))))?.base).toBe(shared);

    git(side, "checkout", "-q", "--detach", "large");
    await inHome(home, () => refreshGraph(side));
    const own = (await inHome(home, () => readGraphPointer(graphLocation(side))))!;
    expect(own.base).not.toBe(shared);
    expect(own.overlay).toBeNull();

    git(side, "checkout", "-q", "--detach", "small");
    await inHome(home, () => refreshGraph(side));
    const back = (await inHome(home, () => readGraphPointer(graphLocation(side))))!;
    expect(back.base).toBe(shared);
    expect(back.overlay).toBeTruthy();
    expect((back.build as { overlayFiles?: number }).overlayFiles).toBe(1);
    // Nothing points at the large branch's base any more.
    expect(existsSync(join(graphLocation(side).directory, own.base))).toBe(false);

    await inHome(fresh, () => rebuildGraph(side));
    const overlaid = await inHome(home, () => images(side));
    const built = await inHome(fresh, () => images(side));
    for (const table of Object.keys(TABLES)) expect(overlaid[table], table).toEqual(built[table]);
    git(main, "worktree", "remove", side);
  }, 240_000);
});
