// Corpus enumeration + token counting for the MEX graph eval harness.
//
// Frozen to match the prior ad-hoc benchmark (see
// claude-talks/graph/EVAL_HARNESS_BUILD_PLAN.md §3): source files are
// .ts/.tsx/.js/.jsx, excluding a fixed set of build/vendor dirs, and the
// approximate token count is ceil(chars / 4).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
export const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".mex", "coverage", ".next", "out",
]);

/** Approximate token count, matching the benchmark's ceil(chars / 4). */
export function approxTokens(text) {
  return Math.ceil(text.length / 4);
}

function hasSourceExtension(name) {
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** All source file paths under `root`, excluding build/vendor dirs. */
export function enumerateSource(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && hasSourceExtension(entry.name)) {
        out.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return out;
}

/** { sourceFiles, sourceTokensApprox } across the whole corpus. */
export function corpusStats(root) {
  const files = enumerateSource(root);
  let tokens = 0;
  for (const file of files) {
    if (statSync(file).isFile()) tokens += approxTokens(readFileSync(file, "utf-8"));
  }
  return { sourceFiles: files.length, sourceTokensApprox: tokens };
}
