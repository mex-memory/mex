import { spawn } from "node:child_process";
import simpleGit, { type SimpleGit, type LogResult } from "simple-git";

let _git: SimpleGit | null = null;

export function getGit(cwd?: string): SimpleGit {
  if (!_git || cwd) {
    _git = simpleGit(cwd ?? process.cwd());
  }
  return _git;
}

/** Get days since a file was last modified in git */
export async function daysSinceLastChange(
  filePath: string,
  cwd?: string
): Promise<number | null> {
  try {
    const git = getGit(cwd);
    const log = await git.log({ file: filePath, maxCount: 1 });
    if (!log.latest?.date) return null;
    const lastDate = new Date(log.latest.date);
    const now = new Date();
    return Math.floor(
      (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)
    );
  } catch {
    return null;
  }
}

/** Get number of commits since a file was last modified */
export async function commitsSinceLastChange(
  filePath: string,
  cwd?: string
): Promise<number | null> {
  try {
    const git = getGit(cwd);
    const fileLog = await git.log({ file: filePath, maxCount: 1 });
    if (!fileLog.latest?.hash) return null;

    const allLog = await git.log();
    const totalCommits = allLog.all.length;
    const fileIndex = allLog.all.findIndex(
      (c) => c.hash === fileLog.latest!.hash
    );
    return fileIndex === -1 ? null : fileIndex;
  } catch {
    return null;
  }
}

/**
 * Commits since a file was last modified that touched any of `paths` (#237).
 *
 * The pathspecs go to `git rev-list --stdin` after `--`, so a file that
 * references hundreds of paths never meets the Windows command-line limit.
 * Ordinary pathspec rules apply: a directory matches everything below it and
 * a path that never existed matches nothing.
 */
export async function commitsTouchingPathsSinceLastChange(
  filePath: string,
  paths: readonly string[],
  cwd?: string
): Promise<number | null> {
  try {
    const git = getGit(cwd);
    const fileLog = await git.log({ file: filePath, maxCount: 1 });
    if (!fileLog.latest?.hash) return null;
    if (paths.length === 0) return 0;
    const input = ["HEAD", `^${fileLog.latest.hash}`, "--", ...paths, ""].join("\n");
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn("git", ["rev-list", "--count", "--stdin"], {
        cwd: cwd ?? process.cwd(),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolveOutput(stdout) : reject(new Error(`git rev-list exited ${code}`)));
      child.stdin.on("error", reject);
      child.stdin.end(input);
    });
    const count = Number.parseInt(output.trim(), 10);
    return Number.isNaN(count) ? null : count;
  } catch {
    return null;
  }
}

/** Get git diff for specific paths */
export async function getGitDiff(
  paths: string[],
  cwd?: string
): Promise<string> {
  try {
    const git = getGit(cwd);
    return await git.diff(["HEAD~5", "HEAD", "--", ...paths]);
  } catch {
    return "";
  }
}

/** Get full git log */
export async function getLog(
  cwd?: string,
  maxCount = 50
): Promise<LogResult> {
  const git = getGit(cwd);
  return git.log({ maxCount });
}
