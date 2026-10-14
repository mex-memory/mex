/**
 * Read-only lookups in the disposable code graph.
 *
 * The composer never builds, refreshes or repairs the graph. It opens
 * `.mex/graph.db` read-only through the graph's own opener (which refuses an
 * incompatible or rebuild-required index), reads a handful of rows, and closes
 * it. When the graph is absent or unusable every caller degrades: health reads
 * `unchecked` and linked-code tokens fall back to the files the Markdown named.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openGraphDatabase } from "../graph/db/database.js";
import type { SqliteDatabase } from "../graph/db/sqlite.js";

export interface GraphNodeRow {
  id: string;
  name: string;
  file: string;
  start: number;
  end: number;
  bodyHash: string | null;
}

export interface GraphReader {
  /** Hash of the metadata that identifies the published graph snapshot. */
  identity(): string;
  nodes(ids: readonly string[]): Map<string, GraphNodeRow>;
  close(): void;
}

const IDENTITY_KEYS = ["manifest_hash", "graph_snapshot_v1", "incremental_state_snapshot"] as const;

export function graphDatabasePath(scaffoldRoot: string): string {
  return join(scaffoldRoot, "graph.db");
}

/** Open the graph read-only, or return null (with the reason) when it cannot be used. */
export function openGraphReader(scaffoldRoot: string): { reader: GraphReader | null; reason?: string } {
  const path = graphDatabasePath(scaffoldRoot);
  if (!existsSync(path)) return { reader: null, reason: "No code graph has been built (.mex/graph.db is missing)." };
  let db: SqliteDatabase;
  try {
    db = openGraphDatabase(path, { readOnly: true });
  } catch (error) {
    return { reader: null, reason: error instanceof Error ? error.message.split("\n")[0]! : String(error) };
  }
  const lookup = db.prepare(
    "SELECT id, name, file_path AS file, start_line AS start, end_line AS end, body_hash AS bodyHash FROM nodes WHERE id = ?",
  );
  return {
    reader: {
      identity() {
        const rows = db
          .prepare(
            `SELECT key, value FROM project_metadata WHERE key IN (${IDENTITY_KEYS.map(() => "?").join(", ")}) ORDER BY key`,
          )
          .all(...IDENTITY_KEYS) as Array<{ key: string; value: string }>;
        const hash = createHash("sha256");
        hash.update("context-graph-identity-v1\0");
        for (const row of rows) hash.update(`${row.key}\0${row.value}\0`);
        return hash.digest("hex");
      },
      nodes(ids) {
        const found = new Map<string, GraphNodeRow>();
        for (const id of new Set(ids)) {
          const row = lookup.get(id) as GraphNodeRow | undefined;
          if (row) found.set(id, { ...row, bodyHash: row.bodyHash ?? null });
        }
        return found;
      },
      close() {
        db.close();
      },
    },
  };
}
