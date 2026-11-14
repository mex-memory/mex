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

/** A read connection hides only files whose absence is proven by its observation. */
export function installGraphReadCoverage(db: SqliteDatabase, excluded: readonly string[] = []): void {
  const hasCoverage = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='coverage'").get();
  const bad = hasCoverage ? db.prepare("SELECT path FROM main.coverage WHERE reason IS NOT NULL AND path IN (SELECT path FROM main.files)").all() as Array<{path:string}> : [];
  if (!bad.length && !excluded.length) return;
  db.exec("PRAGMA query_only=OFF");
  try {
  db.exec("CREATE TEMP TABLE IF NOT EXISTS graph_uncovered(path TEXT PRIMARY KEY) WITHOUT ROWID;");
  const insert = db.prepare("INSERT OR IGNORE INTO graph_uncovered VALUES(?)");
  for (const path of [...bad.map(row=>row.path), ...excluded]) insert.run(path);
  db.exec(`
    CREATE TEMP VIEW IF NOT EXISTS nodes AS SELECT * FROM main.nodes WHERE file_path NOT IN (SELECT path FROM graph_uncovered);
    CREATE TEMP VIEW IF NOT EXISTS edges AS SELECT * FROM main.edges
      WHERE source NOT IN (SELECT id FROM main.nodes WHERE file_path IN (SELECT path FROM graph_uncovered))
        AND target NOT IN (SELECT id FROM main.nodes WHERE file_path IN (SELECT path FROM graph_uncovered));
    CREATE TEMP VIEW IF NOT EXISTS source_chunks AS SELECT * FROM main.source_chunks WHERE file_path NOT IN (SELECT path FROM graph_uncovered);
  `);
  } finally { db.exec("PRAGMA query_only=ON"); }
}
