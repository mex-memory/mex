import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runSync } from "../../compare/lib/process.mjs";
import { clipRepository, verifyClippedHistory } from "./history.mjs";

const NO_HOOKS = process.platform === "win32" ? "NUL" : "/dev/null";

export function git(cwd, args, { allowFailure = false, env, encoding } = {}) {
  const result = runSync("git", ["-c", "core.hooksPath=" + NO_HOOKS, ...args], { cwd, env, encoding });
  if (result.code !== 0 && !allowFailure) throw new Error("Git failed: " + args[0] + ": " + result.stderr);
  return result;
}

export function resolveCommit(subjectRoot, ref) {
  return git(subjectRoot, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]).stdout.trim();
}
function dependencyPaths(workspace) {
  return ["node_modules", ...git(workspace, ["ls-tree", "-r", "--name-only", "HEAD"]).stdout.split("\n")
    .filter((p) => p.endsWith("/package.json") && !p.includes("node_modules/"))
    .map((p) => `${p.slice(0, -"package.json".length)}node_modules`)];
}

const DEPENDENCY_OVERLAY = ".arm-shared-dependencies.json";

// Keep local package imports bound to this checkout while sharing external modules.
function dependencyOverlay(source, target, installRoot, workspace) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) dependencyOverlay(from, to, installRoot, workspace);
    else if (statSync(from).isDirectory()) {
      const actual = realpathSync(from), rel = relative(installRoot, actual);
      const local = !isAbsolute(rel) && !rel.startsWith("..") && !rel.split(sep).includes("node_modules");
      symlinkSync(local ? join(workspace, rel) : from, to, process.platform === "win32" ? "junction" : "dir");
    } else copyFileSync(from, to);
  }
}

function removeDependencyOverlay(path, workspace) {
  const absolute = resolve(path);
  if (!absolute.startsWith(`${resolve(workspace)}${sep}`)) throw new Error("dependency cleanup escaped workspace");
  if (lstatSync(path).isSymbolicLink()) { unlinkSync(path); return; }
  if (!statSync(path).isDirectory()) { unlinkSync(path); return; }
  for (const entry of readdirSync(path)) removeDependencyOverlay(join(path, entry), workspace);
  rmdirSync(path);
}

export function linkDependencies(workspace, depsDir) {
  if (!depsDir) return;
  const multiPackage = existsSync(join(dirname(depsDir), "pnpm-workspace.yaml"));
  for (const path of multiPackage ? dependencyPaths(workspace) : ["node_modules"]) {
    const source = path === "node_modules" ? depsDir : join(dirname(depsDir), path);
    if (!existsSync(source)) continue;
    const target = join(workspace, path);
    if (existsSync(target)) throw new Error(`${target} already exists`);
    mkdirSync(dirname(target), { recursive: true });
    if (multiPackage) {
      dependencyOverlay(source, target, dirname(depsDir), workspace);
      writeFileSync(join(target, DEPENDENCY_OVERLAY), JSON.stringify({ source }));
    } else symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
  }
}

/** Unlink the dependency junction itself; never recurse through it. */
export function unlinkDependencies(workspace) {
  for (const path of dependencyPaths(workspace)) {
    const target = join(workspace, path);
    try {
      if (lstatSync(target).isSymbolicLink()) unlinkSync(target);
      else if (existsSync(join(target, DEPENDENCY_OVERLAY))) removeDependencyOverlay(target, workspace);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existsSync(target)) throw new Error(`refusing to continue: ${target} is not a removable link`);
  }
}

export function createWorkspace({ subjectRoot, workspace, base, forbidden, depsDir }) {
  if (existsSync(workspace)) throw new Error("Workspace already exists");
  clipRepository(subjectRoot, workspace, base);
  verifyClippedHistory(workspace, base, forbidden);
  linkDependencies(workspace, depsDir);
}
