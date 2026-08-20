import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { runProcessSync } from "./process.mjs";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function fileHash(path) {
  return sha256(readFileSync(path));
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function objectHash(value) {
  return sha256(stableJson(value));
}

export function directoryHash(root, options = {}) {
  const absoluteRoot = resolve(root);
  const hash = createHash("sha256");
  const excluded = new Set(options.exclude ?? []);
  const visit = (path) => {
    const stat = lstatSync(path);
    const rel = relative(absoluteRoot, path).replaceAll("\\", "/");
    if (rel && excluded.has(rel)) return;
    if (stat.isSymbolicLink()) {
      hash.update(`L\0${rel}\0${stat.size}\0`);
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    if (!stat.isFile()) return;
    hash.update(`F\0${rel}\0${stat.mode}\0`);
    hash.update(readFileSync(path));
    hash.update("\0");
  };
  visit(absoluteRoot);
  return hash.digest("hex");
}

function git(root, args, optional = false) {
  const result = runProcessSync("git", args, { cwd: root });
  if (result.code !== 0 && !optional) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr).trim()}`);
  }
  return result.code === 0 ? String(result.stdout).trim() : null;
}

const GRAPH_DB_PATHS = [".mex/graph.db", ".mex/graph.db-shm", ".mex/graph.db-wal"];

function graphDbExclusionPathspecs() {
  return GRAPH_DB_PATHS.map((path) => `:(exclude)${path}`);
}

export function gitTreeStateHash(root) {
  // GraphDbGuard intentionally swaps and opens these generated files while an
  // evaluation is running. They are execution artifacts, not subject source,
  // even when the target repository does not ignore `.mex/` itself.
  const pathspec = ["--", ".", ...graphDbExclusionPathspecs()];
  const tracked = git(root, ["diff", "--binary", "HEAD", ...pathspec], true) ?? "";
  const untracked = (git(root, ["ls-files", "--others", "--exclude-standard", ...pathspec], true) ?? "")
    .split("\n").filter(Boolean).sort();
  const hash = createHash("sha256").update(tracked);
  for (const path of untracked) {
    const absolute = join(root, path);
    hash.update(`\0${path}\0`);
    if (existsSync(absolute) && lstatSync(absolute).isFile()) hash.update(readFileSync(absolute));
  }
  return hash.digest("hex");
}

export function repositoryIdentity(root) {
  const absolute = resolve(root);
  const gitTopLevel = git(absolute, ["rev-parse", "--show-toplevel"], true);
  if (!gitTopLevel || resolve(gitTopLevel) !== absolute) {
    return {
      root: absolute,
      git: false,
      parentGitRoot: gitTopLevel ? resolve(gitTopLevel) : null,
      sha: null,
      remote: null,
      dirty: null,
      dirtyEntries: [],
      treeStateSha256: directoryHash(absolute, { exclude: GRAPH_DB_PATHS }),
    };
  }
  const sha = git(absolute, ["rev-parse", "HEAD"], true);
  const status = git(absolute, ["status", "--porcelain"], true) ?? "";
  const dirtyEntries = status.split("\n").filter(Boolean)
    .filter((line) => !/^\?\? \.mex(?:\/|$)/.test(line));
  return {
    root: absolute,
    git: true,
    sha,
    remote: git(absolute, ["remote", "get-url", "origin"], true),
    dirty: dirtyEntries.length > 0,
    dirtyEntries,
    treeStateSha256: gitTreeStateHash(absolute),
  };
}

export function commandBundleIdentity(command) {
  const [executable, script] = command;
  const executableName = executable ? basename(executable).toLowerCase() : "";
  const nodeLauncher = executable === process.execPath || executableName === "node" || executableName === "node.exe";
  const candidate = nodeLauncher && script ? script : executable;
  if (!candidate || !existsSync(candidate)) return { command, entrypoint: candidate ?? null, bundleSha256: null };
  const absolute = resolve(candidate);
  const stat = lstatSync(absolute);
  const bundleRoot = stat.isDirectory() ? absolute : dirname(absolute);
  return { command, entrypoint: absolute, bundleRoot, bundleSha256: directoryHash(bundleRoot) };
}
