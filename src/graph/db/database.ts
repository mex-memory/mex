// ============================================================================
// mex code-graph — database open / schema init  (A3)
// ============================================================================
//
// Opens the graph SQLite DB, loads the FROZEN `src/graph/schema.sql` (resolved
// from the install location via `assets.ts`), applies the connection-level
// PRAGMAs, and guarantees a `schema_versions` row exists.
//
// PRAGMA notes (must be applied in code on EVERY open — spec / schema.sql):
//   * busy_timeout FIRST, before any pragma that touches the file, so a
//     concurrent writer is waited out instead of throwing "database is locked".
//   * foreign_keys is PER-CONNECTION and MUST be re-asserted every open — the
//     per-file replace path (sync) relies on ON DELETE CASCADE.
//   * journal_mode=WAL persists in the file header; re-asserting is harmless.

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { schemaPath } from "../assets.js";
import { GraphRebuildRequiredError } from "../errors.js";
import { openSqlite, type SqliteDatabase } from "./sqlite.js";

/** The schema version this build writes/expects (matches schema.sql's seed). */
export const DB_SCHEMA_VERSION = 2;
/** @deprecated Prefer the explicit DB_SCHEMA_VERSION name. */
export const CURRENT_SCHEMA_VERSION = DB_SCHEMA_VERSION;

export interface OpenGraphDatabaseOptions {
  /** Builders may open a migrated database in order to replace its derived rows. */
  allowRebuild?: boolean;
  /** Reader-only commands must not mutate pragmas, schema, or version metadata. */
  readOnly?: boolean;
}

function configureConnection(db: SqliteDatabase): void {
  db.pragma("busy_timeout = 5000"); // MUST be first
  db.pragma("foreign_keys = ON"); // per-connection; required for ON DELETE CASCADE
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL"); // safe under WAL
  db.pragma("temp_store = MEMORY");
}

function configureReadOnlyConnection(db: SqliteDatabase): void {
  db.pragma("busy_timeout = 5000");
  db.pragma("query_only = ON");
}

/**
 * Open the graph DB at `dbPath`, creating the file + parent dir and applying the
 * schema when absent. Idempotent: re-opening an existing DB re-applies PRAGMAs
 * and re-asserts the schema (all statements are `IF NOT EXISTS`).
 */
export function openGraphDatabase(
  dbPath: string,
  options: OpenGraphDatabaseOptions = {},
): SqliteDatabase {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    if (options.readOnly) throw new GraphRebuildRequiredError("The graph index does not exist. Run `mex graph` first.");
    mkdirSync(dir, { recursive: true });
  }

  if (options.readOnly) {
    return openReadOnlyGraphDatabase(dbPath);
  }
  const db = openSqlite(dbPath);
  configureConnection(db);

  const schema = readFileSync(schemaPath(), "utf-8");
  const hasVersions = tableExists(db, "schema_versions");
  if (!hasVersions) {
    db.exec(schema);
  } else {
    const current = readSchemaVersion(db) ?? 1;
    if (current > DB_SCHEMA_VERSION) {
      db.close();
      throw new GraphRebuildRequiredError(
        `This mex build supports graph schema ${DB_SCHEMA_VERSION}, but the index uses ${current}.`,
      );
    }
    if (current < DB_SCHEMA_VERSION) migrateV1ToV2(db, schema);
    else db.exec(schema);
  }

  // Belt-and-suspenders: guarantee the version row exists even if the SQL seed
  // is ever changed, so the schema_versions table is never dead (migration
  // safety — Phase 0 shipped this table for exactly this reason).
  writeSchemaVersion(db, DB_SCHEMA_VERSION);

  if (!options.allowRebuild && graphRequiresRebuild(db)) {
    db.close();
    throw new GraphRebuildRequiredError();
  }

  return db;
}

function openReadOnlyGraphDatabase(dbPath: string): SqliteDatabase {
  const validate = (db: SqliteDatabase): SqliteDatabase => {
    configureReadOnlyConnection(db);
    if (!tableExists(db, "schema_versions") || readSchemaVersion(db) !== DB_SCHEMA_VERSION) {
      throw new GraphRebuildRequiredError();
    }
    if (graphRequiresRebuild(db)) throw new GraphRebuildRequiredError();
    return db;
  };

  let db = openSqlite(dbPath, { readOnly: true });
  try {
    return validate(db);
  } catch (error) {
    db.close();
    const message = error instanceof Error ? error.message : String(error);
    if (!/read.?only/i.test(message)) throw error;
    const walPath = `${dbPath}-wal`;
    if (existsSync(walPath) && statSync(walPath).size > 0) {
      throw new Error(
        "The graph has uncheckpointed WAL data and cannot be opened in this read-only sandbox. "
        + "Run `mex graph` outside the sandbox and retry.",
      );
    }
    // A checkpointed WAL-mode database can still ask SQLite to create -shm on
    // first read. Immutable mode is safe only when no WAL payload exists.
    db = openSqlite(dbPath, { readOnly: true, immutable: true });
    try {
      return validate(db);
    } catch (immutableError) {
      db.close();
      throw immutableError;
    }
  }
}

/** Ensure a `schema_versions` row for `version` exists (no-op if already there). */
export function writeSchemaVersion(db: SqliteDatabase, version: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)",
  ).run(version, Date.now(), "mex code-graph schema (Track A build)");
}

/** The highest recorded schema version, or null if none is recorded. */
export function readSchemaVersion(db: SqliteDatabase): number | null {
  const row = db
    .prepare("SELECT version FROM schema_versions ORDER BY version DESC LIMIT 1")
    .get() as { version: number } | undefined;
  return row ? row.version : null;
}

/** Mark a successfully validated graph snapshot safe for readers. */
export function markGraphReady(db: SqliteDatabase, manifestHash: string): void {
  setMetadata(db, "rebuild_required", "0");
  setMetadata(db, "manifest_hash", manifestHash);
}

/** Force readers to abstain until a full build publishes a compatible graph. */
export function markGraphRebuildRequired(db: SqliteDatabase, reason: string): void {
  setMetadata(db, "rebuild_required", "1");
  setMetadata(db, "rebuild_reason", reason);
}

export function graphRequiresRebuild(db: SqliteDatabase): boolean {
  if (!tableExists(db, "project_metadata")) return false;
  const row = db.prepare("SELECT value FROM project_metadata WHERE key = 'rebuild_required'").get() as
    | { value: string }
    | undefined;
  return row?.value === "1";
}

function setMetadata(db: SqliteDatabase, key: string, value: string): void {
  db.prepare(
    `INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function columns(db: SqliteDatabase, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
}

function addColumn(db: SqliteDatabase, table: string, name: string, definition: string): void {
  if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

/**
 * Schema v1 graph facts are not trustworthy under the v2 identity/resolution
 * contract. The migration is additive so grounding snapshots can be retained,
 * then marks the derived graph for a mandatory full rebuild.
 */
function migrateV1ToV2(db: SqliteDatabase, schema: string): void {
  db.transaction(() => {
    addColumn(db, "nodes", "container_id", "TEXT");
    addColumn(db, "nodes", "identity_key", "TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE nodes SET identity_key = id WHERE identity_key = ''");

    addColumn(db, "edges", "confidence", "REAL NOT NULL DEFAULT 1.0");
    addColumn(db, "edges", "resolution_method", "TEXT");
    addColumn(db, "edges", "evidence", "TEXT");

    addColumn(db, "files", "parse_status", "TEXT NOT NULL DEFAULT 'ok'");
    addColumn(db, "files", "diagnostic_count", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "files", "missing_count", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "files", "error_coverage", "REAL NOT NULL DEFAULT 0");
    addColumn(db, "files", "extractor_version", "TEXT NOT NULL DEFAULT 'legacy-v1'");

    addColumn(db, "unresolved_refs", "ref_key", "TEXT NOT NULL DEFAULT ''");
    addColumn(db, "unresolved_refs", "receiver", "TEXT");
    addColumn(db, "unresolved_refs", "qualifier", "TEXT");
    addColumn(db, "unresolved_refs", "import_source", "TEXT");
    addColumn(db, "unresolved_refs", "metadata", "TEXT");
    addColumn(db, "unresolved_refs", "status", "TEXT NOT NULL DEFAULT 'pending'");
    addColumn(db, "unresolved_refs", "target_id", "TEXT");
    addColumn(db, "unresolved_refs", "confidence", "REAL");
    addColumn(db, "unresolved_refs", "resolver", "TEXT");
    db.exec("UPDATE unresolved_refs SET ref_key = 'legacy:' || id WHERE ref_key = ''");

    // Existing v1 builds can contain duplicate traversal edges. Retain one row
    // per semantic callsite so the v2 uniqueness invariant can be installed.
    db.exec(`DELETE FROM edges WHERE id NOT IN (
      SELECT MIN(id) FROM edges
      GROUP BY source, target, kind, IFNULL(line, -1), IFNULL(col, -1)
    )`);
  });

  // Creates all new tables and indexes after the old tables have the v2 columns.
  db.exec(schema);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_unresolved_ref_key ON unresolved_refs(ref_key)");
  writeSchemaVersion(db, DB_SCHEMA_VERSION);
  markGraphRebuildRequired(db, "schema-v1");
}
