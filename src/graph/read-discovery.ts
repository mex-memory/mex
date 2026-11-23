import { skippedByRule } from "../file-index/discover.js";
import { gitignoreMatcher } from "./gitignore.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GlobOptions } from "glob";
import { recallWalk, recordingWalkFs, rememberWalk } from "./source-memo.js";
import {
  discoverBoundedGraphPaths, GRAPH_CONFIG_GLOBS, GRAPH_CORPUS_IGNORE_GLOBS,
  GRAPH_SUPPORTED_SOURCE_GLOB, GraphCorpusLimitError, GRAPH_CORPUS_LIMITS,
} from "./corpus-policy.js";

const fullDiscovery = new AsyncLocalStorage<boolean>();

/** @internal Differential-test oracle; never changes the persisted corpus policy. */
export function withFullGraphDiscovery<T>(run: () => T): T {
  return fullDiscovery.run(true, run);
}

const insensitive = process.platform === "win32" || process.platform === "darwin";
const sourceExtensions = new Set(GRAPH_SUPPORTED_SOURCE_GLOB.slice(
  GRAPH_SUPPORTED_SOURCE_GLOB.indexOf("{") + 1, GRAPH_SUPPORTED_SOURCE_GLOB.indexOf("}"),
).split(",").map(extension => "." + extension));
function matchesName(name: string, kind: "source" | "config"): boolean {
  if (insensitive) name = name.toLowerCase();
  return kind === "source" ? sourceExtensions.has(name.slice(name.lastIndexOf(".")))
    : name === "package.json" || ((name.startsWith("tsconfig") || name.startsWith("jsconfig")) && name.endsWith(".json"));
}
const ignoredDirectories = new Set(GRAPH_CORPUS_IGNORE_GLOBS.map(pattern => pattern.slice(3, -3)));

/**
 * Enumerate the standard corpus with dirents and suffix checks instead of a
 * glob automaton per entry. Maintenance can reuse a walk while each listed
 * directory holds its identity. The original walk handles custom policies,
 * symlinks, unusual filesystems and options we cannot reproduce exactly.
 */
function discoverGraphReadPathsUnfiltered(
  pattern: string | readonly string[], options: GlobOptions, maxFiles: number,
): string[] {
  const kind = pattern === GRAPH_SUPPORTED_SOURCE_GLOB ? "source"
    : Array.isArray(pattern) && JSON.stringify(pattern) === JSON.stringify(GRAPH_CONFIG_GLOBS) ? "config" : null;
  if (fullDiscovery.getStore() || !kind || typeof options.cwd !== "string"
    || options.absolute !== false || options.dot !== false || options.follow !== false || options.nodir !== true
    || Object.keys(options).some(key => !["cwd", "absolute", "dot", "follow", "nodir", "ignore"].includes(key))
    || JSON.stringify(options.ignore) !== JSON.stringify(GRAPH_CORPUS_IGNORE_GLOBS)) {
    return discoverBoundedGraphPaths(pattern, options, maxFiles);
  }
  try {
    const key = JSON.stringify([pattern, options, maxFiles]);
    const remembered = recallWalk(key);
    if (remembered) return remembered;
    const directories = new Map<string, string>();
    const walkFs = recordingWalkFs(directories);
    const root = resolve(options.cwd);
    const pending = [""];
    const paths: string[] = [];
    const sibling = kind === "source" ? "config" : "source";
    const otherPaths: string[] = [];
    const otherLimit = sibling === "config" ? GRAPH_CORPUS_LIMITS.maxConfigFiles : GRAPH_CORPUS_LIMITS.maxSourceFiles;
    let rememberSibling = !!walkFs;
    while (pending.length) {
      const directory = pending.pop()!;
      const absolute = join(root, directory);
      const stats = lstatSync(absolute);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return discoverBoundedGraphPaths(pattern, options, maxFiles);
      for (const entry of (walkFs?.readdirSync ?? readdirSync)(absolute, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const normalized = insensitive ? entry.name.toLowerCase() : entry.name;
        if (entry.isDirectory() && ignoredDirectories.has(normalized)) continue;
        // A junction to node_modules must never be traversed, even on fallback.
        if (ignoredDirectories.has(normalized) && entry.isSymbolicLink()) continue;
        // Both supported patterns start with globstar and have follow:false.
        // A link can match the final filename, and cannot supply descendants.
        if (entry.isSymbolicLink() && !matchesName(entry.name, kind)) {
          if (matchesName(entry.name, sibling)) rememberSibling = false;
          continue;
        }
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
          return discoverBoundedGraphPaths(pattern, options, maxFiles);
        }
        const path = directory ? directory + "/" + entry.name : entry.name;
        if (entry.isDirectory()) pending.push(path);
        else {
          if (matchesName(entry.name, kind)) {
            paths.push(path);
            if (paths.length > maxFiles) throw new GraphCorpusLimitError(
              maxFiles === GRAPH_CORPUS_LIMITS.maxConfigFiles ? "maxConfigFiles" : "maxSourceFiles",
            );
          }
          if (rememberSibling && matchesName(entry.name, sibling)) {
            otherPaths.push(path);
            if (otherPaths.length > otherLimit) rememberSibling = false;
          }
        }
      }
    }
    paths.sort();
    if (walkFs) rememberWalk(key, paths, directories);
    if (rememberSibling) {
      const otherPattern = sibling === "config" ? GRAPH_CONFIG_GLOBS : GRAPH_SUPPORTED_SOURCE_GLOB;
      rememberWalk(JSON.stringify([otherPattern, options, otherLimit]), otherPaths.sort(), directories);
    }
    return paths;
  } catch (error) {
    if (error instanceof GraphCorpusLimitError) throw error;
    return discoverBoundedGraphPaths(pattern, options, maxFiles);
  }
}

/** The corpus walk, minus what `.gitignore` excludes and what the file index never reads. */
export function discoverGraphReadPaths(
  pattern: string | readonly string[],
  options: GlobOptions,
  maxFiles: number,
  includeTrackedConfigs = false,
): string[] {
  const paths = discoverGraphReadPathsUnfiltered(pattern, options, maxFiles);
  if (typeof options.cwd !== "string") return paths;
  const root = resolve(options.cwd);
  const ignored = gitignoreMatcher(root);
  let trackedConfigs: Set<string> | undefined;
  return paths.filter(path => {
    const posix = path.replaceAll("\\", "/");
    return !skippedByRule(posix) && (!ignored(posix)
      || (includeTrackedConfigs && (trackedConfigs ??= trackedGraphConfigs(root)).has(posix)));
  });
}

/** A tracked manifest can match ignore rules for generated files in the same workspace. */
function trackedGraphConfigs(root: string): Set<string> {
  try {
    const paths = execFileSync("git", [
      "ls-files", "--cached", "-z", "--", ...GRAPH_CONFIG_GLOBS.map((glob) => `:(glob)${glob}`),
    ], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 2_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    return new Set(paths.split("\0"));
  } catch {
    return new Set();
  }
}
