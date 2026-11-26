import { globToRegExp } from "../file-index/glob.js";
import { repoPath } from "./git.js";
import { safePath, safeRaw } from "./harvest/evidence.js";

const REPO_GLOB = /^(?:\*\*\/)*\*\*$/u;
const GLOB = /[*?]|\{[^/}]*\}/u;
const RESERVED = ["", ".", "..", ".git", ".mex"];

/** Resolve one scope using regular paths from the pinned tree. */
export function pinnedScope(input: string, paths: Iterable<string>): string | undefined {
  const trailingSlash = input.endsWith("/");
  const bare = trailingSlash ? input.slice(0, -1) : input;
  // Check the path spelling without treating wildcards as illegal filename characters.
  const spelling = bare.replace(/[*?]+/gu, "_");
  if (!repoPath(spelling) || bare.includes("..") || safeRaw(input) !== input) return undefined;
  for (const part of spelling.split("/")) {
    if (!part.includes("{")) continue;
    // Alternatives can spell a reserved component even when the raw segment doesn't.
    const alternatives = globToRegExp(part.toLowerCase());
    if (RESERVED.some(name => alternatives.test(name))) return undefined;
  }

  const expanded = trailingSlash ? input + "**" : input;
  const glob = REPO_GLOB.test(expanded) ? "**" : expanded;
  if (Buffer.byteLength(glob) > 512) return undefined;
  // A final slash names a directory, so require a file below it.
  const pattern = globToRegExp(trailingSlash ? input + "**/*" : glob);
  const directory = !trailingSlash && !GLOB.test(glob) ? glob + "/**" : undefined;
  const descendants = directory && Buffer.byteLength(directory) <= 512 ? globToRegExp(directory) : undefined;
  let foundDirectory = false;
  for (const path of paths) {
    if (pattern.test(path) && safePath(path)) return glob;
    if (!foundDirectory && descendants?.test(path) && safePath(path)) foundDirectory = true;
  }
  return foundDirectory ? directory : undefined;
}
