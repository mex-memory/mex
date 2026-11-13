import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
export function git(path: string, ...args: string[]): string {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
export function fixtureRepos(root: string): string[] {
  const repo = join(root, "repo"); mkdirSync(repo);
  git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture.invalid");
  git(repo, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "root");
  const clone = join(root, "clone"); git(root, "clone", repo, clone);
  const worktree = join(root, "worktree"); git(repo, "worktree", "add", "-b", "fixture-branch", worktree);
  git(repo, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "second");
  const shallow = join(root, "shallow"); git(root, "clone", "--depth", "1", `file:///${repo.replaceAll("\\", "/")}`, shallow);
  const empty = join(root, "empty"); mkdirSync(empty); git(empty, "init");
  const folder = join(root, "folder"); mkdirSync(folder);
  const nested = join(repo, "nested"); mkdirSync(nested);
  const unicode = join(root, "Unicode-ΟΣ-İ-ß"); mkdirSync(unicode);
  return [repo, clone, worktree, shallow, empty, folder, nested, unicode];
}
