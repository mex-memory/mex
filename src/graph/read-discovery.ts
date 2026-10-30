import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GlobOptions } from "glob";
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
 * glob automaton per entry. This is a new walk on every call, with no Git or
 * stat-based freshness cache. The original walk handles custom policies,
 * symlinks, unusual filesystems and options we cannot reproduce exactly.
 */
export function discoverGraphReadPaths(
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
    const root = resolve(options.cwd);
    const pending = [""];
    const paths: string[] = [];
    while (pending.length) {
      const directory = pending.pop()!;
      const stats = lstatSync(join(root, directory));
      if (!stats.isDirectory() || stats.isSymbolicLink()) return discoverBoundedGraphPaths(pattern, options, maxFiles);
      for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const normalized = insensitive ? entry.name.toLowerCase() : entry.name;
        if (entry.isDirectory() && ignoredDirectories.has(normalized)) continue;
        // A junction to node_modules must never be traversed, even on fallback.
        if (ignoredDirectories.has(normalized) && entry.isSymbolicLink()) continue;
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
          return discoverBoundedGraphPaths(pattern, options, maxFiles);
        }
        const path = directory ? directory + "/" + entry.name : entry.name;
        if (entry.isDirectory()) pending.push(path);
        else if (matchesName(entry.name, kind)) {
          paths.push(path);
          if (paths.length > maxFiles) throw new GraphCorpusLimitError(
            maxFiles === GRAPH_CORPUS_LIMITS.maxConfigFiles ? "maxConfigFiles" : "maxSourceFiles",
          );
        }
      }
    }
    return paths.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  } catch (error) {
    if (error instanceof GraphCorpusLimitError) throw error;
    return discoverBoundedGraphPaths(pattern, options, maxFiles);
  }
}
