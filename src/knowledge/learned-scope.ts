import { globToRegExp, normalizeGlob } from "../file-index/glob.js";
import { openIndex, type OpenOptions } from "../file-index/read.js";

export const LEARNED_ALWAYS_ON_SETTING = "learning.alwaysOn";
export const BROAD_LEARNED_REASON = `Covers most of the code. Loads every session only with ${LEARNED_ALWAYS_ON_SETTING} on.`;

// The index groups Go and other languages with prose under "other".
// Keep the source suffixes and cutoff in step with native/delivery/entries/broad.go.
const SOURCE = /\.(?:[cm]?[jt]sx?|pyi?|rs|cs|go|java|kts?|scala|rb|php|swift|c|cc|cpp|cxx|h|hh|hpp|m|mm|exs?|erl|hs|ml|fs|dart|lua|r|jl|clj|vue|svelte|zig|sol)$/iu;
const MIN_SOURCE_FILES_FOR_SHARE = 20;

export function coversMostCode(scopes: readonly string[], sourcePaths: () => readonly string[]): boolean {
  let hasGlob = false;
  let fallback = false;
  for (const scope of scopes) {
    const glob = normalizeGlob(scope);
    const name = glob.replace(/^(?:\*\*\/)+/u, "");
    if (name === "**") return true;
    hasGlob ||= /[*?{]/u.test(glob);
    fallback ||= !name.includes("/") && /[*?{]/u.test(name);
  }
  if (!hasGlob) return false;
  const paths = sourcePaths();
  if (paths.length < MIN_SOURCE_FILES_FOR_SHARE) return fallback;
  const patterns = scopes.map(globToRegExp);
  const needed = Math.ceil(paths.length * 3 / 10);
  let hits = 0, misses = 0;
  for (const path of paths) {
    if (patterns.some(pattern => pattern.test(path))) {
      if (++hits === needed) return true;
    } else if (++misses > paths.length - needed) return false;
  }
  return false;
}

export function indexedSourcePaths(paths: readonly string[]): string[] {
  return paths.filter(path => SOURCE.test(path));
}

/** Read at most one snapshot for a selection, and only if it has a scoped learned candidate. */
export function learnedScopeClassifier(options: OpenOptions): (scopes: readonly string[]) => boolean {
  let paths: string[] | undefined;
  return scopes => coversMostCode(scopes, () => {
    if (paths) return paths;
    const index = openIndex(options);
    try { return paths = index ? indexedSourcePaths(index.indexedPaths()) : []; }
    catch { return paths = []; }
    finally { index?.close(); }
  });
}
