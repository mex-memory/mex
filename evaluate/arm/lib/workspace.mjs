// Per-session subject checkouts for the agent-arm test.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { runSync } from "../../compare/lib/process.mjs";

// Line endings follow the subject clone's core.autocrlf: grounding baselines hash the
// checked-out bytes, so checkouts must match the platform the scaffold was written on.
const GIT_IDENTITY = ["-c", "user.name=mex-eval", "-c", "user.email=eval@localhost"];
const SCAFFOLD_PATHS = [".mex", "CLAUDE.md", ".claude"];
const INDEX_FILES = ["graph.db", "wiki.db"];

export function git(cwd, args, { allowFailure = false } = {}) {
  const result = runSync("git", [...GIT_IDENTITY, ...args], { cwd });
  if (result.code !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result;
}

export function resolveCommit(subjectRoot, ref) {
  return git(subjectRoot, ["rev-parse", "--verify", `${ref}^{commit}`]).stdout.trim();
}

/** PATH for an arm: the frozen MEX bin first for the MEX arm; no other mex anywhere. */
export function armPath(basePath, { cliBin = null, withMex }) {
  const entries = String(basePath ?? "").split(delimiter).filter(Boolean)
    .filter((entry) => !/[\\/]AppData[\\/]Roaming[\\/]npm[\\/]?$/i.test(entry));
  return [...(withMex && cliBin ? [cliBin] : []), ...entries].join(delimiter);
}

/** The installed CLI entry point behind the frozen `mex` shim in `cliBin`. */
export function mexEntrypoint(cliBin) {
  return join(cliBin, "..", "mex-agent", "dist", "cli.js");
}

export function runMex(cliBin, args, cwd, env) {
  return runSync(process.execPath, [mexEntrypoint(cliBin), ...args], { cwd, env });
}

function linkDependencies(workspace, depsDir) {
  if (!depsDir) return;
  const target = join(workspace, "node_modules");
  if (existsSync(target)) throw new Error(`${target} already exists`);
  symlinkSync(depsDir, target, "junction");
}

/** Unlink the dependency junction itself; never recurse through it. */
export function unlinkDependencies(workspace) {
  const target = join(workspace, "node_modules");
  try {
    if (lstatSync(target).isSymbolicLink()) unlinkSync(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existsSync(target)) throw new Error(`refusing to continue: ${target} is not a removable link`);
}

/** Every arm: drop a marked section (from the line starting `deleteFrom` up to the line equal to `deleteTo`). */
function applyBasePatch(workspace, patch) {
  const path = join(workspace, patch.file);
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith(patch.deleteFrom));
  if (start < 0) return;
  const end = lines.findIndex((line, i) => i > start && line.trim() === patch.deleteTo);
  lines.splice(start, (end < 0 ? lines.length : end) - start);
  writeFileSync(path, lines.join("\n"));
  git(workspace, ["add", "--", patch.file]);
}

/**
 * Check out the task base, add the scaffold for the MEX arm, link the shared
 * dependencies, and commit, so the session diff is exactly the agent's work.
 */
export function createWorkspace({ subjectRoot, workspace, base, scaffoldCommit = null, depsDir = null, appendInstructions = false, basePatches = [] }) {
  if (existsSync(workspace)) throw new Error(`workspace already exists: ${workspace}`);
  mkdirSync(dirname(workspace), { recursive: true });
  git(subjectRoot, ["worktree", "add", "--detach", workspace, base]);
  // `appendInstructions` keeps the base's own CLAUDE.md and appends the
  // scaffold's MEX block, as `mex setup` does for an existing file.
  const ownInstructions = join(workspace, "CLAUDE.md");
  const baseInstructions = appendInstructions && existsSync(ownInstructions) ? readFileSync(ownInstructions, "utf8") : null;
  for (const path of SCAFFOLD_PATHS) {
    if (baseInstructions !== null && path === "CLAUDE.md") continue;
    if (existsSync(join(workspace, path))) git(workspace, ["rm", "-r", "-q", "--", path]);
  }
  for (const patch of basePatches) applyBasePatch(workspace, patch);
  if (scaffoldCommit) {
    const present = git(workspace, ["ls-tree", "--name-only", scaffoldCommit, "--", ...SCAFFOLD_PATHS]).stdout.split("\n").filter(Boolean);
    if (!present.includes(".mex")) throw new Error(`scaffold commit ${scaffoldCommit} has no .mex directory`);
    git(workspace, ["checkout", scaffoldCommit, "--", ...present]);
    if (baseInstructions !== null && present.includes("CLAUDE.md")) {
      writeFileSync(ownInstructions, `${baseInstructions.trimEnd()}\n\n${readFileSync(ownInstructions, "utf8")}`);
      git(workspace, ["add", "--", "CLAUDE.md"]);
    }
  }
  git(workspace, ["commit", "-q", "--allow-empty", "-m", scaffoldCommit ? "eval: base with MEX scaffold" : "eval: base without MEX"]);
  linkDependencies(workspace, depsDir);
  return { head: git(workspace, ["rev-parse", "HEAD"]).stdout.trim() };
}

/** Stop processes an agent left running inside the workspace (e.g. orphaned test workers). */
function stopStrayProcesses(workspace) {
  if (process.platform !== "win32") return;
  // Match the workspace's last path segment: shells spell the path with either slash style.
  const needle = workspace.split(/[\\/]/).filter(Boolean).pop().replace(/'/g, "''");
  runSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]);
}

export function removeWorkspace(subjectRoot, workspace) {
  if (!existsSync(workspace)) return;
  stopStrayProcesses(workspace);
  unlinkDependencies(workspace);
  git(subjectRoot, ["worktree", "remove", "--force", workspace], { allowFailure: true });
  try {
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 });
  } catch (error) {
    // Windows: node's rm fails with EPERM on read-only test baselines that Remove-Item -Force clears.
    if (process.platform !== "win32") throw error;
    runSync("powershell", ["-NoProfile", "-Command", `Remove-Item -LiteralPath '${workspace.replace(/'/g, "''")}' -Recurse -Force`]);
    if (existsSync(workspace)) throw error;
  }
  git(subjectRoot, ["worktree", "prune"], { allowFailure: true });
}

/** Build Graph and Wiki indexes once per base and scaffold, in a template checkout. */
export function buildIndexCache({ subjectRoot, cacheDir, key, base, scaffoldCommit, cliBin, env, depsDir = null }) {
  const target = join(cacheDir, key);
  if (INDEX_FILES.every((name) => existsSync(join(target, name)))) return target;
  mkdirSync(target, { recursive: true });
  const template = join(cacheDir, `${key}.template`);
  removeWorkspace(subjectRoot, template);
  try {
    // Sessions link the dependencies, so the template must too: the compiler
    // reads their declarations, and a graph built without them makes every
    // session's first refresh fall back to a full extraction.
    createWorkspace({ subjectRoot, workspace: template, base, scaffoldCommit, depsDir });
    for (const args of [["graph"], ["wiki", "rebuild-index"]]) {
      const result = runMex(cliBin, args, template, env);
      if (result.code !== 0) throw new Error(`mex ${args.join(" ")} failed for ${key}: ${result.stderr || result.stdout}`);
    }
    // The clean-state check report every session's loop-close result is diffed against.
    writeFileSync(join(target, "check-baseline.json"), runMex(cliBin, ["check", "--json"], template, env).stdout);
    for (const name of INDEX_FILES) copyFileSync(join(template, ".mex", name), join(target, name));
  } finally {
    removeWorkspace(subjectRoot, template);
  }
  return target;
}

/** Copy cached indexes into a session checkout; rebuild there if they are not fresh. */
export function installIndexes({ workspace, cachePath, cliBin, env }) {
  for (const name of INDEX_FILES) copyFileSync(join(cachePath, name), join(workspace, ".mex", name));
  const status = runMex(cliBin, ["graph", "status", "--json"], workspace, env);
  let fresh = false;
  try { fresh = JSON.parse(status.stdout).status === "fresh"; } catch { fresh = false; }
  if (!fresh) {
    for (const args of [["graph"], ["wiki", "rebuild-index"]]) {
      const result = runMex(cliBin, args, workspace, env);
      if (result.code !== 0) throw new Error(`mex ${args.join(" ")} failed in ${workspace}`);
    }
  }
  return { copiedFresh: fresh };
}
