import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { absolutePath, realPath } from "../record/project.js";
export { displayPath } from "../record/project.js";

/**
 * Where `mex` runs. Only read-only, bounded git commands; nothing is created.
 *
 * - `git`: inside a work tree. `root` is its top level, `excludeFile` the
 *   repository's shared `info/exclude` (the same file for every worktree), and
 *   `commonDir` the `.git` folder every worktree shares.
 * - `folder`: no git work tree. Turning it on needs a question (a later step).
 * - `refused`: the home folder, a folder above it, or a drive root. Hooks fire
 *   in every session below such a folder, so MEX never turns on there.
 */
export type Place =
  | { kind: "git"; root: string; excludeFile: string; shallow: boolean; commonDir: string }
  | { kind: "folder"; root: string }
  | { kind: "refused"; root: string; reason: "home" | "above-home" | "drive-root" };

export type PlaceGit = (directory: string, args: string[]) => string;

const runGit: PlaceGit = (directory, args) => execFileSync("git", ["-C", directory, ...args], {
  encoding: "utf8", timeout: 1500, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
}).trim();

function within(base: string, path: string): boolean {
  const rel = relative(base, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The home folder, any folder above it, or a filesystem root. */
export function refusedReason(path: string, home: string): "home" | "above-home" | "drive-root" | undefined {
  if (dirname(path) === path) return "drive-root";
  if (path === home) return "home";
  if (within(path, home)) return "above-home";
  return undefined;
}

export function classifyPlace(directory: string = process.cwd(), options: { git?: PlaceGit; home?: string } = {}): Place {
  const git = options.git ?? runGit;
  const start = realPath(directory);
  let home: string;
  try { home = realPath(options.home ?? homedir()); } catch { home = resolve(options.home ?? homedir()); }
  let root: string | undefined, excludeFile: string | undefined, commonDir: string | undefined, shallow = false;
  try {
    // One git process for every answer: each start costs tens of milliseconds on Windows.
    // Outside a work tree (a bare repository, inside .git) --show-toplevel fails, and so does the call.
    const [inside, top, exclude, isShallow, common] = git(start, ["rev-parse", "--is-inside-work-tree", "--show-toplevel",
      "--git-path", "info/exclude", "--is-shallow-repository", "--git-common-dir"]).split(/\r?\n/u);
    if (inside === "true" && top && exclude && common) {
      root = realPath(top);
      // Both relative to the directory git ran in. Spelled like `root` (Windows paths are compared
      // lowercased), so every worktree names the same exclude file.
      excludeFile = absolutePath(resolve(start, exclude));
      commonDir = absolutePath(resolve(start, common));
      shallow = isShallow === "true";
    }
  } catch { root = undefined; }
  const target = root ?? start;
  const reason = refusedReason(target, home);
  if (reason) return { kind: "refused", root: target, reason };
  if (root && excludeFile && commonDir) return { kind: "git", root, excludeFile, shallow, commonDir };
  return { kind: "folder", root: start };
}
