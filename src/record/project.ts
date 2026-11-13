import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

export function shortHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 24);
}
export function absolutePath(path: string): string {
  const absolute = resolve(path);
  // Full Unicode lowercasing differs across runtimes and can change a valid filename.
  return process.platform === "win32" ? absolute.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) : absolute;
}
export function realPath(path: string): string { return absolutePath(realpathSync.native(path)); }
export interface ProjectIdentity { id: string; kind: "git" | "folder"; rootPath: string; provisional?: "unborn" | "shallow"; }
export type GitRunner = (directory: string, args: string[]) => string;
const runGit: GitRunner = (directory, args) => execFileSync("git", ["-C", directory, ...args], {
  encoding: "utf8", timeout: 1500, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
}).trim();

/** Shallow and unborn repositories cannot prove their historical root: use a folder id. */
export function projectIdentity(directory: string, git: GitRunner = runGit): ProjectIdentity {
  let rootPath = realPath(directory);
  try {
    rootPath = realPath(git(rootPath, ["rev-parse", "--show-toplevel"]));
    if (git(rootPath, ["rev-parse", "--is-shallow-repository"]) === "true") {
      return { id: `f-${shortHash(rootPath)}`, kind: "folder", rootPath, provisional: "shallow" };
    }
    try {
      const roots = git(rootPath, ["rev-list", "--max-parents=0", "HEAD"]).split(/\s+/)
        .filter((hash) => /^[0-9a-f]{40,64}$/.test(hash)).sort();
      if (roots.length) return { id: `g-${shortHash(roots[0])}`, kind: "git", rootPath };
    } catch {
      const ref = git(rootPath, ["symbolic-ref", "--quiet", "HEAD"]);
      const refs = git(rootPath, ["for-each-ref", "--format=%(refname)", "--", ref]).split(/\r?\n/);
      if (ref.startsWith("refs/heads/") && !refs.includes(ref)) {
        return { id: `f-${shortHash(rootPath)}`, kind: "folder", rootPath, provisional: "unborn" };
      }
    }
  } catch { /* Missing git, no commits, permissions or timeout: honest folder identity. */ }
  return { id: `f-${shortHash(rootPath)}`, kind: "folder", rootPath };
}
