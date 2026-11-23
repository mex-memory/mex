import { existsSync } from "node:fs";
import { join } from "node:path";
import { skippedByRule } from "../file-index/discover.js";
import type { SqliteDatabase } from "./db/sqlite.js";
import { gitignoreMatcher } from "./gitignore.js";
import { isSupportedSourceFile } from "./extraction/grammars.js";
import { BASIC_RESOLUTION } from "./types.js";

export type GraphCoverage = { indexed: true; reason?: typeof BASIC_RESOLUTION } | { indexed: false; reason: string };

export function coverageAllowsNodes(reason: string | undefined): boolean {
  return reason === undefined || reason === BASIC_RESOLUTION;
}

/**
 * One path's coverage. A basic file has declarations and name-only hints.
 * Other coverage rows explain why a file lacks declarations.
 */
export function graphCoverage(path: string, reason: string | undefined, indexed: boolean, root?: string): GraphCoverage {
  if (reason === BASIC_RESOLUTION && indexed) return { indexed: true, reason };
  if (reason !== undefined) return { indexed: false, reason };
  if (indexed) return { indexed: true };
  if (!root) return { indexed: false, reason: "not indexed" };
  if (!isSupportedSourceFile(path)) return { indexed: false, reason: "unsupported language" };
  if (skippedByRule(path) || gitignoreMatcher(root)(path)) return { indexed: false, reason: "excluded" };
  return { indexed: false, reason: existsSync(join(root, path)) ? "not indexed yet" : "missing" };
}

/**
 * Files that failed to parse are filtered by the read API (`coverageFor`),
 * so a graph with one bad file still reads its tables directly, without views.
 */
export function installGraphReadCoverage(_db: SqliteDatabase): void { /* see above */ }
