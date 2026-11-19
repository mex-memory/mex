import { existsSync } from "node:fs";
import { join } from "node:path";
import { skippedByRule } from "../file-index/discover.js";
import type { SqliteDatabase } from "./db/sqlite.js";
import { gitignoreMatcher } from "./gitignore.js";
import { isSupportedSourceFile } from "./extraction/grammars.js";

export type GraphCoverage = { indexed: true } | { indexed: false; reason: string };

/**
 * One path's coverage. `reason` is its coverage row (files the build saw and
 * did not index); without one, an indexed file is covered and any other path
 * says why it isn't in the graph.
 */
export function graphCoverage(path: string, reason: string | undefined, indexed: boolean, root: string): GraphCoverage {
  if (reason !== undefined) return { indexed: false, reason };
  if (indexed) return { indexed: true };
  if (!isSupportedSourceFile(path)) return { indexed: false, reason: "unsupported language" };
  if (skippedByRule(path) || gitignoreMatcher(root)(path)) return { indexed: false, reason: "excluded" };
  return { indexed: false, reason: existsSync(join(root, path)) ? "not indexed yet" : "missing" };
}

/**
 * Files that failed to parse are filtered by the read API (`coverageFor`),
 * so a graph with one bad file still reads its tables directly, without views.
 */
export function installGraphReadCoverage(_db: SqliteDatabase): void { /* see above */ }
