import { closeSync, existsSync, lstatSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { git } from "./workspace.mjs";
import { shellSegments } from "./classify.mjs";

/** Transfer exactly the reachable object closure, without a remote, alternates or a future reflog. */
export function clipRepository(subjectRoot, workspace, base) {
  mkdirSync(workspace, { recursive: true });
  git(workspace, ["init", "-q"]);
  git(workspace, ["config", "core.autocrlf", git(subjectRoot, ["config", "--get", "core.autocrlf"], { allowFailure: true }).stdout.trim() || "false"]);
  const pack = join(workspace, ".git", "base.pack.tmp");
  const fd = openSync(pack, "w");
  try {
    const r = spawnSync("git", ["-C", subjectRoot, "pack-objects", "--stdout", "--revs"], { input: `${base}\n`, stdio: ["pipe", fd, "pipe"], env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" } });
    if (r.status !== 0) throw new Error(`base pack failed: ${r.stderr}`);
  } finally { closeSync(fd); }
  const input = openSync(pack, "r");
  try {
    const r = spawnSync("git", ["-C", workspace, "index-pack", "--stdin"], { stdio: [input, "pipe", "pipe"] });
    if (r.status !== 0) throw new Error(`base unpack failed: ${r.stderr}`);
  } finally { closeSync(input); rmSync(pack, { force: true }); }
  git(workspace, ["checkout", "-q", "--detach", base]);
  return verifyClippedHistory(workspace, base);
}
export function verifyClippedHistory(workspace, base, forbidden = [], setupCommits = []) {
  const gitDir = git(workspace, ["rev-parse", "--absolute-git-dir"]).stdout.trim();
  if (existsSync(join(gitDir, "objects", "info", "alternates"))) throw new Error("history leak: object alternates");
  if (git(workspace, ["remote"]).stdout.trim()) throw new Error("history leak: remote");
  if (git(workspace, ["for-each-ref", "--format=%(refname)"]).stdout.trim()) throw new Error("history leak: extra refs");
  for (const sha of forbidden.filter(Boolean)) if (git(workspace, ["cat-file", "-e", `${sha}^{commit}`], { allowFailure: true }).code === 0) throw new Error(`history leak: forbidden fix ${sha}`);
  const ancestors = new Set(git(workspace, ["rev-list", base]).stdout.trim().split("\n"));
  const allowed = new Set([...ancestors, ...setupCommits]);
  const commits = git(workspace, ["rev-list", "--all"]).stdout.trim().split("\n").filter(Boolean);
  const reflog = git(workspace, ["reflog", "--all", "--format=%H"]).stdout.trim().split("\n").filter(Boolean);
  if ([...commits, ...reflog].some((sha) => !allowed.has(sha))) throw new Error("history leak: commit beyond base");
  // Include unreachable commit objects: an accidentally copied pack is a leak even with no ref.
  const objects = git(workspace, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"]).stdout.trim().split("\n");
  if (objects.some((line) => line.endsWith(" commit") && !allowed.has(line.split(" ")[0]))) throw new Error("history leak: unreachable commit beyond base");
  return { base, commits: commits.length, ancestors: ancestors.size, forbiddenAbsent: forbidden.filter(Boolean), noAlternates: true, noRemotes: true, noOtherRefs: true, objectClosureVerified: true };
}
/** Gold files enter only after the agent exits; no fix commit objects enter its repository. */
export function restoreFiles(source, workspace, ref, files) {
  const modes = new Map(git(source, ["ls-tree", "-rz", ref, "--", ...files]).stdout.split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t"); return [line.slice(tab + 1), line.slice(0, tab).split(" ")[0]];
  }));
  for (const file of files) {
    if (file.split(/[\\/]/).includes("..") || /^(?:\/|[a-z]:)/i.test(file)) throw new Error("unsafe restoration path");
    const r = spawnSync("git", ["-C", source, "show", `${ref}:${file}`], { maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`cannot restore ${file}: ${r.stderr}`);
    let component = workspace;
    for (const part of file.split(/[\\/]/)) {
      component = join(component, part);
      try { if (lstatSync(component).isSymbolicLink()) throw new Error(`symlink restoration path refused: ${file}`); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const blob = spawnSync("git", ["-C", workspace, "hash-object", "-w", "--stdin"], { input: r.stdout, encoding: "utf8" });
    if (blob.status !== 0) throw new Error(`cannot write restored blob: ${blob.stderr}`);
    git(workspace, ["update-index", "--add", "--cacheinfo", `${modes.get(file) ?? "100644"},${blob.stdout.trim()},${file}`]);
    // Apply the checkout's line-ending/attribute policy without importing the source commit.
    git(workspace, ["checkout-index", "--force", "--", file]);
  }
}
export function historyViolations(calls, workspace, base) {
  const ancestors = new Set(git(workspace, ["rev-list", base]).stdout.trim().split("\n"));
  const violations = [];
  for (const call of calls) {
    if (call.name !== "Bash") continue;
    for (const command of shellSegments(call.input?.command ?? "")) {
      if (!/\bgit\s/.test(command)) continue;
      if (/\s--all\b|\b(?:cat-file|fsck|reflog)\b/.test(command)) violations.push(`history probe: ${command}`);
      else if (/\b(?:show|log)\b/.test(command)) {
        for (const sha of command.match(/\b[0-9a-f]{7,40}\b/gi) ?? []) if (![...ancestors].some((a) => a.startsWith(sha.toLowerCase()))) violations.push(`non-ancestor history probe: ${sha}`);
      }
    }
  }
  return [...new Set(violations)];
}
