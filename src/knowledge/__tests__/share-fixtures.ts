import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, vi } from "vitest";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
/** A git repo on main with one commit, and MEX_HOME beside it. */
export function shareRepo(): { root: string; git: (...args: string[]) => string } {
  const base = mkdtempSync(join(tmpdir(), "mex-share-"));
  dirs.push(base);
  const root = join(base, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", "repo"], { cwd: base });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("config", "user.email", "t@example.test"); git("config", "user.name", "T");
  writeFileSync(join(root, "README.md"), "# Demo\n");
  git("add", "."); git("commit", "-qm", "base");
  vi.stubEnv("MEX_HOME", join(base, "home"));
  return { root, git };
}

