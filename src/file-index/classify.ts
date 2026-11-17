import { createHash } from "node:crypto";
import type { IndexPattern, Lang } from "./types.js";

const EXTENSIONS: Record<string, Lang> = {
  ".ts": "ts", ".mts": "ts", ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "js",
  ".py": "py", ".pyi": "py",
  ".rs": "rs",
  ".cs": "cs",
};

export function langOf(path: string): Lang {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot <= slash + 1) return "other";
  return EXTENSIONS[path.slice(dot).toLowerCase()] ?? "other";
}

const TEST_DIRECTORY = /(^|\/)(__tests__|__test__|tests?|specs?|e2e|cypress)\//i;
const TEST_FILE = [
  /\.(test|spec|e2e-spec|e2e)\.[cm]?[jt]sx?$/i,
  /(^|\/)test_[^/]*\.pyi?$/i, /_tests?\.pyi?$/i, /(^|\/)conftest\.py$/i,
  /(^|\/)tests?\.rs$/i, /_tests?\.rs$/i,
  /tests?\.cs$/i,
];
const TEST_IMPORTS = new Set(["vitest", "@jest/globals", "jest", "mocha", "node:test", "@playwright/test", "ava", "tap", "uvu", "chai", "pytest", "unittest"]);
const CSHARP_TEST_PROJECT = /(^|\/)[^/]*\.(unit)?tests?\//i;

/** A test file by its path, or (for TS/JS/Python) by importing a test framework. */
export function isTestFile(path: string, importsFrom: readonly string[] = []): boolean {
  if (TEST_DIRECTORY.test(path) || CSHARP_TEST_PROJECT.test(path)) return true;
  if (TEST_FILE.some((pattern) => pattern.test(path))) return true;
  return importsFrom.some((from) => TEST_IMPORTS.has(from));
}

/** The content hash that keys a record: SHA-256 of the bytes, first 32 hex characters. */
export function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

/** A stable id for a literal pattern, the same in Go and Node. */
export function patternId(pattern: string): string {
  return "p" + createHash("sha256").update(`literal\n${pattern}`).digest("hex").slice(0, 15);
}

export function literalPattern(pattern: string): IndexPattern {
  return { id: patternId(pattern), match: "literal", pattern };
}

/** Non-overlapping occurrences of `needle` in `text`. */
export function countLiteral(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) count++;
  return count;
}

/** A NUL byte in the first 8 KiB means binary, as git decides it. */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8192);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Start offset of each line (index 0 is line 1). */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** 1-based line containing `offset`, by binary search over line starts. */
export function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}
