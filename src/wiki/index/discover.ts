/**
 * Finding the Markdown a scaffold is made of.
 *
 * Two things here are load-bearing far out of proportion to their size.
 *
 * **The walk order is explicitly sorted.** `readdirSync` returns entries in
 * filesystem order, which differs between a Windows dev box, an ext4 CI runner
 * and an APFS laptop. Nothing downstream would notice — until the determinism
 * test compares a clean rebuild against an incremental refresh and finds two
 * dumps that differ in row order, which reads as a refresh bug and is not one.
 *
 * **Paths leaving here are scaffold-relative and POSIX.** They become primary
 * keys. A `\`-separated key indexes the same scaffold differently on Windows
 * than on Linux, and every join against it silently returns nothing.
 */

import { lstatSync, opendirSync, realpathSync, type Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { toPosix } from "../../paths.js";
import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import { WIKI_CORPUS_LIMITS, WikiCorpusLimitError } from "./corpus-policy.js";
import { isLogOwnedPath } from "../model/log-owned-paths.js";

export interface DiscoveredFile {
  /** Scaffold-relative, POSIX separators. The database key. */
  path: string;
  /** Absolute path, for reading. Never stored. */
  absolutePath: string;
}

export interface DiscoveryResult {
  files: DiscoveredFile[];
  diagnostics: WikiDiagnostic[];
}

export interface DiscoverOptions {
  /** Absolute path to the scaffold root. */
  root: string;
  /** Ordered globs, matched against scaffold-relative POSIX paths. */
  exclude?: readonly string[];
}

const MARKDOWN = /\.mdx?$/i;

/**
 * Translate a glob to an anchored regular expression.
 *
 * Deliberately small, and deliberately not a dependency. The only patterns that
 * reach it are `wiki.exclude` and `wiki.readOnly`, which are directory prefixes
 * and `**` tails; a full matcher would be more surface than the feature has.
 *
 * - `**` crosses separators, `*` and `?` do not;
 * - a leading double-star segment also matches the root itself, so the default
 *   exclusion covers a top-level `node_modules` as well as a nested one;
 * - everything else is literal.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      const isDouble = pattern[index + 1] === "*";
      if (isDouble) {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          // `**/` matches any number of leading segments, including none.
          source += "(?:[^/]+/)*";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** True when `path` matches any pattern. */
export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

/**
 * Is `absolute` strictly inside `root`?
 *
 * Exported because the read side and the write side must give **one** answer
 * for one path (handoff §29.9). It was a closure inside the walk until P5
 * needed it, which is precisely the shape that drifts: two containment rules
 * written months apart disagree on a trailing separator or a case-different
 * drive letter, and the disagreement shows up as a file the index refuses to
 * read but an operation is happy to write.
 *
 * Purely lexical, and deliberately so — resolving symlinks is the caller's
 * step, because the two sides resolve *different* things (the walk resolves
 * entries it walked over; a write resolves a path that may not exist yet).
 * `root` itself is not inside itself.
 */
export function insideRoot(root: string, absolute: string): boolean {
  const rel = relative(root, absolute);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * True when every path under `directory` is excluded, so the walk can prune it.
 *
 * Derived from the patterns rather than probed with a fake filename: a pattern
 * ending in `/**` excludes a directory's whole subtree exactly when its prefix
 * matches that directory.
 */
function prunes(directory: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (globToRegExp(pattern).test(directory)) return true;
    if (!pattern.endsWith("/**")) return false;
    return globToRegExp(pattern.slice(0, -3)).test(directory);
  });
}

/**
 * Walk the scaffold for Markdown, in a deterministic order.
 *
 * Symlinks are resolved and confined to the root. One escaping the scaffold is
 * a diagnostic and is skipped, matching the rule P5 applies to writes — a read
 * side and a write side that disagree about what "inside the scaffold" means is
 * its own class of bug. A directory symlink pointing back *inside* the root is
 * skipped without a diagnostic: its files are already reachable by their real
 * path, and following it would index every one of them twice under two keys.
 */
export function discoverMarkdownFiles(options: DiscoverOptions): DiscoveryResult {
  const root = resolve(options.root);
  const exclude = options.exclude ?? [];
  const files: DiscoveredFile[] = [];
  const diagnostics: WikiDiagnostic[] = [];
  let directoryEntries = 0;
  let omittedDiagnostics = 0;

  const report = (entry: WikiDiagnostic): void => {
    if (diagnostics.length < WIKI_CORPUS_LIMITS.maxDiagnostics - 1) diagnostics.push(entry);
    else omittedDiagnostics += 1;
  };

  const relativeToRoot = (absolute: string): string => toPosix(relative(root, absolute));

  const walk = (directory: string, depth: number): void => {
    if (depth > WIKI_CORPUS_LIMITS.maxDirectoryDepth) {
      throw new WikiCorpusLimitError("maxDirectoryDepth");
    }
    const entries: Dirent[] = [];
    try {
      const handle = opendirSync(directory);
      try {
        for (;;) {
          const entry = handle.readSync();
          if (entry === null) break;
          directoryEntries += 1;
          if (directoryEntries > WIKI_CORPUS_LIMITS.maxDirectoryEntries) {
            throw new WikiCorpusLimitError("maxDirectoryEntries");
          }
          entries.push(entry);
        }
      } finally {
        try {
          handle.closeSync();
        } catch {
          // A completed Dir read may already have closed the descriptor.
        }
      }
    } catch (error) {
      if (error instanceof WikiCorpusLimitError) throw error;
      report(
        diagnostic("WIKI_PARSE_ERROR", `Could not read directory ${relativeToRoot(directory) || "."}: ${message(error)}`, {
          file: relativeToRoot(directory),
        }),
      );
      return;
    }

    // Sorted by name, and by name only: the walk must not depend on the order
    // the filesystem happened to return.
    for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const absolute = join(directory, entry.name);
      const rel = relativeToRoot(absolute);
      // Prune before following links or consuming the note corpus; case aliases
      // must not expose authored entity-marker examples to the Wiki binder.
      if (isLogOwnedPath(rel)) continue;

      if (entry.isSymbolicLink()) {
        const target = resolveSymlink(absolute);
        if (target === null) {
            report(
              diagnostic("WIKI_PARSE_ERROR", `Broken symlink at ${rel}.`, { file: rel }),
          );
          continue;
        }
        if (!insideRoot(root, target)) {
          report(escapedSymlinkDiagnostic(rel, target));
          continue;
        }
        if (lstatSync(target).isDirectory()) continue;
        if (!MARKDOWN.test(entry.name) || matchesAnyGlob(rel, exclude)) continue;
        files.push({ path: rel, absolutePath: absolute });
        if (files.length > WIKI_CORPUS_LIMITS.maxMarkdownFiles) {
          throw new WikiCorpusLimitError("maxMarkdownFiles");
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (prunes(rel, exclude)) continue;
        walk(absolute, depth + 1);
        continue;
      }

      if (!entry.isFile() || !MARKDOWN.test(entry.name)) continue;
      if (matchesAnyGlob(rel, exclude)) continue;
      files.push({ path: rel, absolutePath: absolute });
      if (files.length > WIKI_CORPUS_LIMITS.maxMarkdownFiles) {
        throw new WikiCorpusLimitError("maxMarkdownFiles");
      }
    }
  };

  walk(root, 0);

  // The walk is depth-first and already ordered, but sorting the result makes
  // the guarantee a property of the return value rather than of the traversal.
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (omittedDiagnostics > 0) {
    diagnostics.push(diagnostic(
      "WIKI_PARSE_ERROR",
      `${omittedDiagnostics} additional Wiki discovery diagnostic(s) were omitted.`,
      {
        severity: "info",
        remediation: "Resolve the visible diagnostics, then inspect again for any remaining issues.",
      },
    ));
  }
  return { files, diagnostics };
}

/**
 * The scaffold-escape report, as a function of two paths.
 *
 * Split out so the rule can be exercised without creating a symlink: Windows
 * refuses those without developer mode, and a check that only runs on some
 * machines is a check that rots on the others.
 */
export function escapedSymlinkDiagnostic(relativePath: string, resolvedTarget: string): WikiDiagnostic {
  return diagnostic(
    "PATH_OUTSIDE_SCAFFOLD",
    `${relativePath} is a symlink to ${toPosix(resolvedTarget)}, which is outside the scaffold. It is not indexed.`,
    { file: relativePath },
  );
}

function resolveSymlink(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
