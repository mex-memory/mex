/**
 * Read-only lookups in the disposable code graph.
 *
 * The composer never builds, refreshes or repairs the graph. It opens
 * `.mex/graph.db` read-only, refuses an incompatible or rebuild-required
 * index the way the graph's own opener does, reads a handful of rows, and closes
 * it. It deliberately does not call that opener: its module graph pulls in the
 * parsers, the corpus walker and Git, and a hook pays for every import on every
 * tool call. A test pins the schema version below to the graph's. When the graph is absent or unusable every caller degrades: health reads
 * `unchecked` and linked-code tokens fall back to the files the Markdown named.
 */

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { openSqlite, type SqliteDatabase } from "../graph/db/sqlite.js";

/** The graph schema this reader understands; must equal `DB_SCHEMA_VERSION` (pinned by a test). */
export const READER_GRAPH_SCHEMA_VERSION = 4;

export interface GraphNodeRow {
  id: string;
  name: string;
  file: string;
  start: number;
  end: number;
  bodyHash: string | null;
  kind?: string;
}

export interface GraphReader {
  /** Hash of the metadata that identifies the published graph snapshot. */
  identity(): string;
  nodes(ids: readonly string[]): Map<string, GraphNodeRow>;
  /** The smallest symbol (never the file node) whose line range holds `line` of `file`, or null. */
  enclosing(file: string, line: number): GraphNodeRow | null;
  /** Up to `limit` callers of a node, found by its id (never by name). */
  callers(id: string, limit: number): GraphNodeRow[];
  callees(id: string, limit: number): GraphNodeRow[];
  exactName(name: string, limit: number): GraphNodeRow[];
  inRange(file: string, start: number, end: number, limit: number): GraphNodeRow[];
  callerCount(id: string): number;
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
    db = openReadOnly(path);
  } catch (error) {
    return { reader: null, reason: error instanceof Error ? error.message.split("\n")[0]! : String(error) };
  }
  const lookup = db.prepare(
    "SELECT id, name, file_path AS file, start_line AS start, end_line AS end, body_hash AS bodyHash, kind FROM nodes WHERE id = ?",
  );
  const enclosingStatement = db.prepare(
    `SELECT id, name, file_path AS file, start_line AS start, end_line AS end, body_hash AS bodyHash, kind FROM nodes
     WHERE file_path = ? AND start_line <= ? AND end_line >= ? AND kind <> 'file'
     ORDER BY (end_line - start_line) ASC, start_line DESC LIMIT 1`,
  );
  const columns = "n.id, n.name, n.file_path AS file, n.start_line AS start, n.end_line AS end, n.body_hash AS bodyHash, n.kind";
  // Rank before LIMIT: a popular symbol's test callbacks must not hide production callers.
  const testRank = `CASE WHEN ${["*/test/*", "*/tests/*", "*/spec/*", "*/specs/*", "*/e2e/*", "*/__tests__/*", "*/__mocks__/*", "*/testrunner/*", "*/unittests/*", "*.test.*", "*.spec.*"].map((pattern) => `('/' || lower(n.file_path)) GLOB '${pattern}'`).join(" OR ")} THEN 1 ELSE 0 END`;
  const order = `${testRank}, n.file_path, n.start_line, n.id`;
  const callerStatement = db.prepare(`SELECT DISTINCT ${columns} FROM edges e JOIN nodes n ON n.id = e.source
    WHERE e.target = ? AND e.kind = 'calls' AND e.source <> e.target ORDER BY ${order} LIMIT ?`);
  const calleeStatement = db.prepare(`SELECT DISTINCT ${columns} FROM edges e JOIN nodes n ON n.id = e.target
    WHERE e.source = ? AND e.kind = 'calls' AND e.source <> e.target ORDER BY ${order} LIMIT ?`);
  const exactStatement = db.prepare(`SELECT ${columns} FROM nodes n WHERE n.name = ? AND n.kind NOT IN ('file', 'import') ORDER BY ${order} LIMIT ?`);
  const rangeStatement = db.prepare(`SELECT ${columns} FROM nodes n WHERE n.file_path = ? AND n.start_line <= ? AND n.end_line >= ?
    AND n.kind NOT IN ('file', 'import') ORDER BY (n.end_line - n.start_line), n.start_line, n.id LIMIT ?`);
  const countStatement = db.prepare("SELECT count(DISTINCT source) AS count FROM edges WHERE target = ? AND kind = 'calls' AND source <> target");
  const cap = (limit: number): number => Number.isFinite(limit) ? Math.max(0, Math.min(100, Math.floor(limit))) : 0;
  return {
    reader: {
      enclosing(file, line) {
        const row = enclosingStatement.get(file, line, line) as GraphNodeRow | undefined;
        return row ? { ...row, bodyHash: row.bodyHash ?? null } : null;
      },
      callers(id, limit) {
        return (callerStatement.all(id, cap(limit)) as GraphNodeRow[]).map((row) => ({ ...row, bodyHash: row.bodyHash ?? null }));
      },
      callees(id, limit) { return calleeStatement.all(id, cap(limit)) as GraphNodeRow[]; },
      exactName(name, limit) { return exactStatement.all(name, cap(limit)) as GraphNodeRow[]; },
      inRange(file, start, end, limit) { return rangeStatement.all(file, end, start, cap(limit)) as GraphNodeRow[]; },
      callerCount(id) { return (countStatement.get(id) as { count: number }).count; },
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

const REBUILD_MESSAGE = "The graph index needs a rebuild. Run `mex graph` first.";

function tableExists(db: SqliteDatabase, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** Reject a graph this reader cannot trust: another schema version, or one marked for rebuild. */
function validate(db: SqliteDatabase): SqliteDatabase {
  db.pragma("busy_timeout = 5000");
  db.pragma("query_only = ON");
  if (!tableExists(db, "schema_versions")) throw new Error(REBUILD_MESSAGE);
  const version = db.prepare("SELECT version FROM schema_versions ORDER BY version DESC LIMIT 1").get() as { version?: unknown } | undefined;
  if (version?.version !== READER_GRAPH_SCHEMA_VERSION) throw new Error(REBUILD_MESSAGE);
  if (tableExists(db, "project_metadata")) {
    const flag = db.prepare("SELECT value FROM project_metadata WHERE key = 'rebuild_required'").get() as { value?: unknown } | undefined;
    if (flag?.value === "1") throw new Error(REBUILD_MESSAGE);
  }
  return db;
}

/** A checkpointed WAL-mode database can still ask SQLite to create `-shm`; in a read-only sandbox, read it immutably. */
function openReadOnly(path: string): SqliteDatabase {
  let db = openSqlite(path, { readOnly: true });
  try {
    return validate(db);
  } catch (error) {
    db.close();
    const message = error instanceof Error ? error.message : String(error);
    if (!/read.?only/i.test(message)) throw error;
    const wal = `${path}-wal`;
    if (existsSync(wal) && statSync(wal).size > 0) {
      throw new Error("The graph has uncheckpointed WAL data and cannot be opened in this read-only sandbox.");
    }
    db = openSqlite(path, { readOnly: true, immutable: true });
    try {
      return validate(db);
    } catch (immutableError) {
      db.close();
      throw immutableError;
    }
  }
}
