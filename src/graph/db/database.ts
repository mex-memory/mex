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

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { schemaPath } from "../assets.js";
import { openSqlite, type SqliteDatabase } from "./sqlite.js";

/** The schema version this build writes/expects (matches schema.sql's seed). */
export const CURRENT_SCHEMA_VERSION = 1;

function configureConnection(db: SqliteDatabase): void {
  db.pragma("busy_timeout = 5000"); // MUST be first
  db.pragma("foreign_keys = ON"); // per-connection; required for ON DELETE CASCADE
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL"); // safe under WAL
  db.pragma("temp_store = MEMORY");
}

/**
 * Open the graph DB at `dbPath`, creating the file + parent dir and applying the
 * schema when absent. Idempotent: re-opening an existing DB re-applies PRAGMAs
 * and re-asserts the schema (all statements are `IF NOT EXISTS`).
 */
export function openGraphDatabase(dbPath: string): SqliteDatabase {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = openSqlite(dbPath);
  configureConnection(db);

  // Load + apply the frozen schema (creates tables/indexes/triggers, and — via
  // its own INSERT OR IGNORE — seeds the schema_versions row).
  db.exec(readFileSync(schemaPath(), "utf-8"));

  // Belt-and-suspenders: guarantee the version row exists even if the SQL seed
  // is ever changed, so the schema_versions table is never dead (migration
  // safety — Phase 0 shipped this table for exactly this reason).
  writeSchemaVersion(db, CURRENT_SCHEMA_VERSION);

  return db;
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
