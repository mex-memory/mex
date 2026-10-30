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
import { GRAPH_CORPUS_LIMITS } from "../corpus-policy.js";
import { GraphRebuildRequiredError } from "../errors.js";
import { bandHashInts, bandHashes, decodeMinhash, encodeMinhash, indexedInLsh } from "../fingerprint.js";
import type { Fingerprint } from "../reconcile.js";
import {
  GRAPH_SNAPSHOT_METADATA_KEY,
  parseGraphSnapshot,
  serializeGraphSnapshot,
} from "../snapshot.js";
import { assertFts5Available, openSqlite, type SqliteDatabase } from "./sqlite.js";

// The FTS5 preflight lives with the SQLite adapter (it describes the SQLite
// build, not the graph) and is re-exported here for the callers and tests that
// already reach for it through this module.
export { assertFts5Available };

/** The schema version this build writes/expects (matches schema.sql's seed). */
export const DB_SCHEMA_VERSION = 4;
/** @deprecated Prefer the explicit DB_SCHEMA_VERSION name. */
export const CURRENT_SCHEMA_VERSION = DB_SCHEMA_VERSION;

export interface OpenGraphDatabaseOptions {
  /** Builders may open a migrated database in order to replace its derived rows. */
  allowRebuild?: boolean;
  /** Reader-only commands must not mutate pragmas, schema, or version metadata. */
  readOnly?: boolean;
  /**
   * Ignore SQLite WAL state and prohibit sidecar creation. Callers must first
   * establish that no non-empty WAL contains authoritative graph data.
   */
  immutable?: boolean;
}

function configureConnection(db: SqliteDatabase): void {
  db.pragma("busy_timeout = 5000"); // MUST be first
  db.pragma("foreign_keys = ON"); // per-connection; required for ON DELETE CASCADE
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL"); // safe under WAL
  db.pragma("temp_store = MEMORY");
  // A rebuild inserts millions of index entries (LSH buckets, edges); the
  // 2 MiB default page cache turns those into repeated page reads. Pages are
  // only allocated as they are used, so small graphs keep a small cache.
  db.pragma("cache_size = -131072");
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
  if (options.immutable && !options.readOnly) {
    throw new TypeError("Immutable graph access requires readOnly: true.");
  }
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    if (options.readOnly) throw new GraphRebuildRequiredError("The graph index does not exist. Run `mex graph` first.");
    mkdirSync(dir, { recursive: true });
  }

  // Every graph open needs FTS5: writers apply `schema.sql`'s virtual tables,
  // and readers query `nodes_fts` / `source_chunks_fts` (search, scope, impact,
  // and the grounding checker). A store built on an FTS5-capable machine and
  // copied to one without it fails on read, not on build, so the read-only and
  // immutable paths need this preflight just as much as the writable one.
  assertFts5Available();

  if (options.readOnly) {
    return options.immutable
      ? openImmutableGraphDatabase(dbPath)
      : openReadOnlyGraphDatabase(dbPath);
  }
  const db = openSqlite(dbPath);
  configureConnection(db);

  try {
    initializeWritableGraphDatabase(db, readFileSync(schemaPath(), "utf-8"), options);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function initializeWritableGraphDatabase(
  db: SqliteDatabase,
  schema: string,
  options: OpenGraphDatabaseOptions,
): void {
  const hasVersions = tableExists(db, "schema_versions");
  if (!hasVersions) {
    const userTable = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
    ).get();
    if (userTable) {
      throw incompatibleSchema("The graph index has tables but no schema version metadata.");
    }
    db.exec(schema);
    validateCombinedSchema(db);
  } else {
    const current = readSchemaVersion(db);
    if (current === null) {
      throw incompatibleSchema("the schema version table has no valid version row.");
    }
    if (current > DB_SCHEMA_VERSION) {
      throw incompatibleSchema(
        `This mex build supports graph schema ${DB_SCHEMA_VERSION}, but the index uses ${current}.`,
      );
    }
    if (current < DB_SCHEMA_VERSION) {
      if (!options.allowRebuild) {
        throw incompatibleSchema(
          `This mex build expects graph schema ${DB_SCHEMA_VERSION}; the index uses ${current}.`,
        );
      }
      migrate(db, schema, current);
    } else {
      // Never let CREATE IF NOT EXISTS conceal a partial database that merely
      // claims to be v4. Establish the complete shape before reasserting indexes.
      assertCombinedSchemaShape(db);
      db.exec(schema);
    }
  }

  // The schema seed may have inserted v4 while a lower migration rung was
  // running. The ladder trims that row after every rung; only this final,
  // fully-validated point is allowed to assert the current version.
  writeSchemaVersion(db, DB_SCHEMA_VERSION);

  if (!options.allowRebuild && graphRequiresRebuild(db)) {
    throw new GraphRebuildRequiredError();
  }
}

function validateReadOnlyGraphDatabase(db: SqliteDatabase): SqliteDatabase {
  configureReadOnlyConnection(db);
  if (!tableExists(db, "schema_versions") || readSchemaVersion(db) !== DB_SCHEMA_VERSION) {
    throw new GraphRebuildRequiredError();
  }
  assertCombinedSchemaShape(db);
  if (graphRequiresRebuild(db)) throw new GraphRebuildRequiredError();
  return db;
}

function openImmutableGraphDatabase(dbPath: string): SqliteDatabase {
  const db = openSqlite(dbPath, { readOnly: true, immutable: true });
  try {
    return validateReadOnlyGraphDatabase(db);
  } catch (error) {
    db.close();
    throw error;
  }
}

function openReadOnlyGraphDatabase(dbPath: string): SqliteDatabase {
  let db = openSqlite(dbPath, { readOnly: true });
  try {
    return validateReadOnlyGraphDatabase(db);
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
      return validateReadOnlyGraphDatabase(db);
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

/**
 * Record `version` as the highest schema this database has actually reached.
 *
 * Stamping is not a plain insert, because a migration step is allowed to
 * `exec` the frozen schema — and the schema seeds its own version row. Without
 * the delete, {@link migrateV1ToV2}'s schema exec would stamp the database with
 * the *current* version halfway up the ladder; a crash in the next step would
 * then leave a half-migrated database claiming to be finished, and the next
 * open would skip every remaining step. Trimming anything above the step that
 * actually completed is what makes the ladder resumable.
 */
function stampSchemaVersion(db: SqliteDatabase, version: number): void {
  writeSchemaVersion(db, version);
  db.prepare("DELETE FROM schema_versions WHERE version > ?").run(version);
}

/** The highest recorded schema version, or null if none is recorded. */
export function readSchemaVersion(db: SqliteDatabase): number | null {
  const row = db
    .prepare("SELECT version FROM schema_versions ORDER BY version DESC LIMIT 1")
    .get() as { version: unknown } | undefined;
  return typeof row?.version === "number"
    && Number.isSafeInteger(row.version)
    && row.version >= 1
    ? row.version
    : null;
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

/** Includes generated columns, which PRAGMA table_info intentionally omits. */
function allColumns(db: SqliteDatabase, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
}

function sameColumns(actual: Set<string>, expected: readonly string[]): boolean {
  return actual.size === expected.length && expected.every((column) => actual.has(column));
}

interface TableColumnShape {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  hidden: number;
}

function tableColumnShapes(db: SqliteDatabase, table: string): Map<string, TableColumnShape> {
  const rows = db.prepare(`PRAGMA table_xinfo(${table})`).all() as TableColumnShape[];
  return new Map(rows.map((row) => [row.name, { ...row, type: row.type.toUpperCase() }]));
}

function hasExactColumnShapes(
  db: SqliteDatabase,
  table: string,
  expected: Readonly<Record<string, { type: string; pk?: number; hidden?: number; notnull?: number }>>,
): boolean {
  const actual = tableColumnShapes(db, table);
  const entries = Object.entries(expected);
  return actual.size === entries.length && entries.every(([name, shape]) => {
    const column = actual.get(name);
    return Boolean(column
      && column.type === shape.type
      && (shape.pk === undefined || column.pk === shape.pk)
      && (shape.hidden === undefined || column.hidden === shape.hidden)
      && (shape.notnull === undefined || column.notnull === shape.notnull));
  });
}

function hasForeignKey(
  db: SqliteDatabase,
  table: string,
  from: string,
  targetTable: string,
  targetColumn: string,
): boolean {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  return rows.some((row) => row.table === targetTable
    && row.from === from
    && row.to === targetColumn
    && row.on_delete.toUpperCase() === "CASCADE");
}

function tableDefinition(db: SqliteDatabase, table: string): string {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) as { sql?: unknown } | undefined;
  return typeof row?.sql === "string" ? row.sql : "";
}

function indexHasColumns(
  db: SqliteDatabase,
  table: string,
  expected: readonly string[],
  options: { name?: string; unique?: boolean } = {},
): boolean {
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
    name: string;
    unique: number;
  }>;
  return indexes.some((index) => {
    if (options.name !== undefined && index.name !== options.name) return false;
    if (options.unique !== undefined && Boolean(index.unique) !== options.unique) return false;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(index.name)) return false;
    const columns = (db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{
      seqno: number;
      name: string;
    }>).sort((left, right) => left.seqno - right.seqno).map((entry) => entry.name);
    return columns.length === expected.length
      && expected.every((column, position) => columns[position] === column);
  });
}

function incompatibleSchema(message: string): GraphRebuildRequiredError {
  return new GraphRebuildRequiredError(`Unsupported graph schema: ${message}`);
}

function addColumn(db: SqliteDatabase, table: string, name: string, definition: string): void {
  if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

/**
 * One rung of the version ladder: what it upgrades from, and to.
 *
 * A step never writes its own version row — {@link migrate} stamps it after the
 * step returns, so a step that throws leaves the database at the version it
 * actually still has.
 */
interface MigrationStep {
  from: number;
  to: number;
  run(db: SqliteDatabase, schema: string): void;
}

/**
 * Every migration, in order, each applying to exactly one version.
 *
 * **This replaced a single `if`.** The dispatch used to read
 * `if (current < DB_SCHEMA_VERSION) migrateV1ToV2(db, schema)`, which is
 * correct only while there is exactly one migration. The moment a second one
 * exists, a v1 database runs the v1 step, is stamped with the current version,
 * and never sees the v2 step — silently mislabelled, with no error and no
 * rebuild prompt. A ladder cannot do that: it applies every step whose target
 * is above the version the database actually has.
 *
 * A test asserts this list is contiguous from 1 and ends at
 * {@link DB_SCHEMA_VERSION}, so adding a step without wiring it up fails
 * loudly rather than skipping a rung.
 */
const MIGRATIONS: readonly MigrationStep[] = [
  { from: 1, to: 2, run: migrateV1ToV2 },
  { from: 2, to: 3, run: migrateV2ToV3 },
  { from: 3, to: 4, run: migrateV3ToV4 },
];

/** The ladder, exposed for the test that checks it has no gaps. */
export function migrationSteps(): ReadonlyArray<{ from: number; to: number }> {
  return MIGRATIONS.map((step) => ({ from: step.from, to: step.to }));
}

/** Apply every migration above `current`, in order, stamping each as it lands. */
function migrate(db: SqliteDatabase, schema: string, current: number): void {
  detectGraphSchemaLineage(db, current);
  setAsideLegacyBaseline(db);
  let version = current;
  for (const step of MIGRATIONS) {
    if (version >= step.to) continue;
    step.run(db, schema);
    stampSchemaVersion(db, step.to);
    version = step.to;
  }
}

/** Where a file-keyed grounding baseline waits while the v4 table is created. */
const LEGACY_GROUNDED_SOURCE = "_mex_grounded_source_v2";

/**
 * Move a pre-v3 grounding baseline aside **before any step execs the schema**.
 *
 * This is not tidiness, it is an ordering constraint with teeth. Every
 * migration step ends by exec'ing the frozen schema, and the schema now
 * declares `idx_grounded_subject` over v3-only columns. Exec'ing it against a
 * table that still has the v2 (or v1) shape fails with `no such column:
 * subject_kind` — so a v1 database would die inside the *v1* step, before the
 * v3 step it needs ever runs. Renaming the old table first means every
 * subsequent `exec(schema)` finds no table there and creates the v3 one from
 * the single frozen definition, with no DDL duplicated into TypeScript.
 *
 * The rename is pure DDL and carries no dependency on the database's version,
 * which is what lets it sit before the ladder rather than inside a rung. The
 * rows are carried across in {@link migrateV2ToV3}, where they belong.
 *
 * Resumable by construction: if the process dies between the rename and the
 * copy, the next open finds no `_mex_grounded_source` at all — so this returns
 * early, the schema recreates the v3 table, and the v3 rung finds the legacy
 * rows still waiting and finishes the job.
 */
function setAsideLegacyBaseline(db: SqliteDatabase): void {
  if (!tableExists(db, "_mex_grounded_source")) return;
  if (columns(db, "_mex_grounded_source").has("subject_kind")) return;

  // The index has to go first: renaming a table does not rename its indexes, so
  // `idx_grounded_node` would stay attached to the renamed table, the schema's
  // `CREATE INDEX IF NOT EXISTS` would find the name taken and do nothing, and
  // dropping the legacy table would then take the index with it — leaving v3
  // without its reverse lookup and nothing failing.
  db.exec("DROP INDEX IF EXISTS idx_grounded_node");
  db.exec(`ALTER TABLE _mex_grounded_source RENAME TO ${LEGACY_GROUNDED_SOURCE}`);
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
  markGraphRebuildRequired(db, "schema-v1");
}

/**
 * Schema v2 → v3 keeps main's lossless compact fingerprint/LSH encoding as the
 * canonical storage baseline. Grounding remains staged until the v4 rung.
 */
function migrateV2ToV3(db: SqliteDatabase, _schema: string): void {
  const shape = fingerprintStorageShape(db);
  if (shape === "compact") return;
  if (shape !== "legacy") {
    throw incompatibleSchema("schema v2 has an incomplete fingerprint/LSH subsystem.");
  }
  db.transaction(() => convertLegacyFingerprintStorage(db));
}

/**
 * Schema v3 had two released lineages: main compacted fingerprints, while the
 * integration stack generalized grounding subjects. V4 is their validated
 * union. This step is deliberately shape-driven because the version number
 * alone cannot distinguish those incompatible v3 layouts.
 */
function migrateV3ToV4(db: SqliteDatabase, schema: string): void {
  db.transaction(() => {
    if (fingerprintStorageShape(db) === "legacy") convertLegacyFingerprintStorage(db);

    // The old table was moved aside before any current-schema indexes could be
    // asserted against it. The frozen schema is the single source of v4 DDL.
    db.exec(schema);
    if (tableExists(db, LEGACY_GROUNDED_SOURCE)) {
      const existing = allColumns(db, LEGACY_GROUNDED_SOURCE);
      const subjectId = existing.has("subject_id") ? "subject_id" : "scaffold_file";
      const carried = (column: string): string => (existing.has(column) ? column : "''");
      db.exec(
        `INSERT OR IGNORE INTO _mex_grounded_source
           (subject_kind, subject_id, node_id, source, body_hash, fingerprint)
         SELECT 'scaffold', ${subjectId}, node_id, ${carried("source")},
                ${carried("body_hash")}, ${carried("fingerprint")}
         FROM ${LEGACY_GROUNDED_SOURCE}`,
      );
      db.exec(`DROP TABLE ${LEGACY_GROUNDED_SOURCE}`);
    }

    updateSnapshotSchemaVersion(db);

    // V4 is stamped by the ladder only after all storage, relational, and
    // semantic invariants have passed inside this transaction.
    validateCombinedSchema(db);
  });
}

function updateSnapshotSchemaVersion(db: SqliteDatabase): void {
  if (!tableExists(db, "project_metadata")) return;
  const row = db.prepare(
    `SELECT value, typeof(value) AS storage_type,
            length(CAST(value AS BLOB)) AS byte_length
     FROM project_metadata WHERE key = ?`,
  ).get(GRAPH_SNAPSHOT_METADATA_KEY) as {
    value?: unknown;
    storage_type?: unknown;
    byte_length?: unknown;
  } | undefined;
  if (!row) return;
  if (
    row.storage_type !== "text"
    || typeof row.value !== "string"
    || typeof row.byte_length !== "number"
    || !Number.isSafeInteger(row.byte_length)
    || row.byte_length > GRAPH_CORPUS_LIMITS.maxSnapshotMetadataBytes
  ) {
    throw incompatibleSchema("graph snapshot metadata is not safely bounded for migration.");
  }
  const snapshot = parseGraphSnapshot(row.value);
  if (!snapshot || snapshot.schemaVersion < 1 || snapshot.schemaVersion > DB_SCHEMA_VERSION) {
    throw incompatibleSchema("graph snapshot metadata does not match a recognized older schema.");
  }
  // A structurally complete store can be left with an older highest version
  // row after an interrupted/manual stamp while its canonical snapshot already
  // names v4. Full schema and semantic validation still runs below; preserve
  // that already-current provenance byte-for-byte.
  if (snapshot.schemaVersion === DB_SCHEMA_VERSION) return;
  db.prepare("UPDATE project_metadata SET value = ? WHERE key = ?").run(
    serializeGraphSnapshot({ ...snapshot, schemaVersion: DB_SCHEMA_VERSION }),
    GRAPH_SNAPSHOT_METADATA_KEY,
  );
}

function validateLegacyFingerprintStorage(db: SqliteDatabase): void {
  const oversized = db.prepare(
    `SELECT 1 FROM node_fingerprints
     WHERE typeof(node_id) <> 'text' OR length(CAST(node_id AS BLOB)) > 4096
        OR typeof(minhash) <> 'text' OR length(CAST(minhash AS BLOB)) > 4096
        OR typeof(neighbors) <> 'text'
        OR length(CAST(neighbors AS BLOB)) > ${GRAPH_CORPUS_LIMITS.maxSnapshotMetadataBytes}
     LIMIT 1`,
  ).get() ?? db.prepare(
    `SELECT 1 FROM lsh_buckets
     WHERE typeof(node_id) <> 'text' OR length(CAST(node_id AS BLOB)) > 4096
        OR typeof(band_hash) <> 'text' OR length(CAST(band_hash AS BLOB)) > 128
     LIMIT 1`,
  ).get();
  if (oversized) throw incompatibleSchema("legacy fingerprint state exceeds its bounded value policy.");

  const buckets = db.prepare(
    `SELECT node_id, band, band_hash FROM lsh_buckets
     ORDER BY node_id COLLATE BINARY, band, band_hash, rowid`,
  ).iterate()[Symbol.iterator]() as IterableIterator<{
    node_id: unknown;
    band: unknown;
    band_hash: unknown;
  }>;
  let bucket = buckets.next();
  const fingerprints = db.prepare(
    `SELECT node_id, minhash, neighbors, token_count FROM node_fingerprints
     ORDER BY node_id COLLATE BINARY`,
  ).iterate() as IterableIterator<{
    node_id: unknown;
    minhash: unknown;
    neighbors: unknown;
    token_count: unknown;
  }>;
  for (const row of fingerprints) {
    if (typeof row.node_id !== "string"
      || typeof row.minhash !== "string"
      || typeof row.neighbors !== "string"
      || typeof row.token_count !== "number"
      || !Number.isSafeInteger(row.token_count)
      || row.token_count < 0) {
      throw incompatibleSchema("a legacy fingerprint row is malformed.");
    }
    let fingerprint: Fingerprint;
    try {
      fingerprint = {
        minhash: JSON.parse(row.minhash) as number[],
        neighbors: JSON.parse(row.neighbors) as string[],
        tokenCount: row.token_count,
      };
      bandHashInts(fingerprint);
    } catch {
      throw incompatibleSchema(`fingerprint ${JSON.stringify(row.node_id)} is not losslessly decodable.`);
    }
    if (!bucket.done) {
      if (typeof bucket.value.node_id !== "string") {
        throw incompatibleSchema("a legacy LSH bucket owner is malformed.");
      }
      if (Buffer.compare(Buffer.from(bucket.value.node_id), Buffer.from(row.node_id)) < 0) {
        throw incompatibleSchema("legacy LSH contains rows without a fingerprint owner.");
      }
    }
    const expected = bandHashes(fingerprint);
    for (let band = 0; band < expected.length; band += 1) {
      if (bucket.done
        || bucket.value.node_id !== row.node_id
        || bucket.value.band !== band
        || bucket.value.band_hash !== expected[band]) {
        throw incompatibleSchema(`legacy LSH buckets for ${JSON.stringify(row.node_id)} are not lossless.`);
      }
      bucket = buckets.next();
    }
    if (!bucket.done && bucket.value.node_id === row.node_id) {
      throw incompatibleSchema(`legacy LSH buckets for ${JSON.stringify(row.node_id)} contain duplicates.`);
    }
  }
  if (!bucket.done) throw incompatibleSchema("legacy LSH contains rows without a fingerprint owner.");
}

function convertLegacyFingerprintStorage(db: SqliteDatabase): void {
  validateLegacyFingerprintStorage(db);
  db.exec(`CREATE TABLE node_fingerprints_v4 (
    ref          INTEGER PRIMARY KEY,
    node_id      TEXT NOT NULL UNIQUE REFERENCES nodes(id) ON DELETE CASCADE,
    minhash      BLOB NOT NULL,
    neighbors    TEXT NOT NULL,
    token_count  INTEGER NOT NULL
  )`);
  const rows = db.prepare(
    "SELECT node_id, minhash, neighbors, token_count FROM node_fingerprints ORDER BY node_id",
  ).iterate() as IterableIterator<{
    node_id: string;
    minhash: string;
    neighbors: string;
    token_count: number;
  }>;
  const insertFingerprint = db.prepare(
    "INSERT INTO node_fingerprints_v4 (node_id, minhash, neighbors, token_count) VALUES (?, ?, ?, ?)",
  );
  for (const row of rows) {
    let fingerprint: Fingerprint;
    try {
      fingerprint = {
        minhash: JSON.parse(row.minhash) as number[],
        neighbors: JSON.parse(row.neighbors) as string[],
        tokenCount: row.token_count,
      };
      // Validates all decoded fields before a single legacy row can be lost.
      bandHashInts(fingerprint);
    } catch {
      throw incompatibleSchema(`fingerprint ${JSON.stringify(row.node_id)} is not losslessly decodable.`);
    }
    insertFingerprint.run(
      row.node_id,
      encodeMinhash(fingerprint.minhash),
      row.neighbors,
      row.token_count,
    );
  }

  db.exec("DROP TABLE lsh_buckets");
  db.exec("DROP TABLE node_fingerprints");
  db.exec("ALTER TABLE node_fingerprints_v4 RENAME TO node_fingerprints");
  db.exec(`CREATE TABLE lsh_buckets (
    band      INTEGER NOT NULL,
    band_hash INTEGER NOT NULL,
    ref       INTEGER NOT NULL REFERENCES node_fingerprints(ref) ON DELETE CASCADE,
    PRIMARY KEY (band, band_hash, ref)
  ) WITHOUT ROWID`);

  const insertBucket = db.prepare("INSERT INTO lsh_buckets (band, band_hash, ref) VALUES (?, ?, ?)");
  const compactRows = db.prepare(
    `SELECT ref, node_id, minhash, neighbors, token_count FROM node_fingerprints
     ORDER BY node_fingerprints.ref`,
  ).iterate() as IterableIterator<{
    ref: number | bigint;
    node_id: string;
    minhash: Uint8Array;
    neighbors: string;
    token_count: number;
  }>;
  for (const row of compactRows) {
    const ref = typeof row.ref === "bigint" ? row.ref : BigInt(row.ref);
    const fingerprint: Fingerprint = {
      minhash: decodeMinhash(row.minhash),
      neighbors: JSON.parse(row.neighbors) as string[],
      tokenCount: row.token_count,
    };
    bandHashInts(fingerprint).forEach((bandHash, band) => insertBucket.run(band, bandHash, ref));
  }
}

type FingerprintStorageShape = "missing" | "legacy" | "compact";
type GroundingStorageShape = "missing" | "legacy" | "generalized";

export type GraphSchemaLineage =
  | "v1"
  | "v2"
  | "main-v3"
  | "integration-v3"
  | "hybrid-v3"
  | "v4";

function fingerprintStorageShape(db: SqliteDatabase): FingerprintStorageShape {
  const fingerprints = tableExists(db, "node_fingerprints");
  const buckets = tableExists(db, "lsh_buckets");
  if (!fingerprints && !buckets) return "missing";
  if (!fingerprints || !buckets || tableExists(db, "node_fingerprints_v4")) {
    throw incompatibleSchema("fingerprint and LSH tables are only partially present.");
  }
  const legacy = hasExactColumnShapes(db, "node_fingerprints", {
    node_id: { type: "TEXT", pk: 1, hidden: 0 },
    minhash: { type: "TEXT", pk: 0, hidden: 0, notnull: 1 },
    neighbors: { type: "TEXT", pk: 0, hidden: 0, notnull: 1 },
    token_count: { type: "INTEGER", pk: 0, hidden: 0, notnull: 1 },
  }) && hasExactColumnShapes(db, "lsh_buckets", {
    band: { type: "INTEGER", pk: 0, hidden: 0, notnull: 1 },
    band_hash: { type: "TEXT", pk: 0, hidden: 0, notnull: 1 },
    node_id: { type: "TEXT", pk: 0, hidden: 0, notnull: 1 },
  }) && hasForeignKey(db, "node_fingerprints", "node_id", "nodes", "id")
    && hasForeignKey(db, "lsh_buckets", "node_id", "nodes", "id")
    && indexHasColumns(db, "lsh_buckets", ["band", "band_hash"], { name: "idx_lsh" });
  if (legacy) return "legacy";

  const compact = hasExactColumnShapes(db, "node_fingerprints", {
    ref: { type: "INTEGER", pk: 1, hidden: 0 },
    node_id: { type: "TEXT", pk: 0, hidden: 0, notnull: 1 },
    minhash: { type: "BLOB", pk: 0, hidden: 0, notnull: 1 },
    neighbors: { type: "TEXT", pk: 0, hidden: 0, notnull: 1 },
    token_count: { type: "INTEGER", pk: 0, hidden: 0, notnull: 1 },
  }) && hasExactColumnShapes(db, "lsh_buckets", {
    band: { type: "INTEGER", pk: 1, hidden: 0, notnull: 1 },
    band_hash: { type: "INTEGER", pk: 2, hidden: 0, notnull: 1 },
    ref: { type: "INTEGER", pk: 3, hidden: 0, notnull: 1 },
  }) && hasForeignKey(db, "node_fingerprints", "node_id", "nodes", "id")
    && hasForeignKey(db, "lsh_buckets", "ref", "node_fingerprints", "ref")
    && indexHasColumns(db, "node_fingerprints", ["node_id"], { unique: true })
    && /\bWITHOUT\s+ROWID\b/iu.test(tableDefinition(db, "lsh_buckets"));
  if (compact) return "compact";
  throw incompatibleSchema("fingerprint and LSH columns form an ambiguous or partial lineage.");
}

function groundingStorageShape(db: SqliteDatabase, allowEarlyLegacy: boolean): GroundingStorageShape {
  const active = tableExists(db, "_mex_grounded_source");
  const staged = tableExists(db, LEGACY_GROUNDED_SOURCE);
  if (active && staged) throw incompatibleSchema("both active and staged grounding tables are present.");
  if (!active && !staged) return "missing";
  const table = active ? "_mex_grounded_source" : LEGACY_GROUNDED_SOURCE;
  const actual = allColumns(db, table);
  const generalized = active && hasExactColumnShapes(db, table, {
    subject_kind: { type: "TEXT", pk: 1, hidden: 0, notnull: 1 },
    subject_id: { type: "TEXT", pk: 2, hidden: 0, notnull: 1 },
    node_id: { type: "TEXT", pk: 3, hidden: 0, notnull: 1 },
    source: { type: "TEXT", pk: 0, hidden: 0, notnull: 1 },
    body_hash: { type: "TEXT", pk: 0, hidden: 0, notnull: 1 },
    fingerprint: { type: "TEXT", pk: 0, hidden: 0, notnull: 1 },
    scaffold_file: { type: "TEXT", pk: 0, hidden: 2 },
  }) && /subject_kind\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'scaffold'/iu.test(tableDefinition(db, table))
    && /scaffold_file\s+TEXT\s+GENERATED\s+ALWAYS\s+AS\s*\(\s*CASE\s+WHEN\s+subject_kind\s*=\s*'scaffold'\s+THEN\s+subject_id\s+END\s*\)\s+VIRTUAL/iu
      .test(tableDefinition(db, table))
    && indexHasColumns(db, table, ["node_id"], { name: "idx_grounded_node" })
    && indexHasColumns(db, table, ["subject_kind", "subject_id"], { name: "idx_grounded_subject" });
  if (generalized) return "generalized";
  const legacy = hasExactColumnShapes(db, table, {
    scaffold_file: { type: "TEXT", pk: 1, hidden: 0, notnull: 1 },
    node_id: { type: "TEXT", pk: 2, hidden: 0, notnull: 1 },
    source: { type: "TEXT", pk: 0, hidden: 0, notnull: 1 },
    body_hash: { type: "TEXT", pk: 0, hidden: 0, notnull: 1 },
    fingerprint: { type: "TEXT", pk: 0, hidden: 0, notnull: 1 },
  }) && (!active || indexHasColumns(db, table, ["node_id"], { name: "idx_grounded_node" }));
  if (legacy) return "legacy";
  if (
    allowEarlyLegacy
    && actual.has("scaffold_file")
    && actual.has("node_id")
    && actual.has("body_hash")
    && !actual.has("subject_kind")
  ) return "legacy";
  throw incompatibleSchema("grounding columns form an ambiguous or partial lineage.");
}

/** Structurally identify exactly which historical schema is being upgraded. */
export function detectGraphSchemaLineage(db: SqliteDatabase, version: number): GraphSchemaLineage {
  if (version === 1) {
    fingerprintStorageShape(db);
    groundingStorageShape(db, true);
    return "v1";
  }
  if (version === 2) {
    const fingerprints = fingerprintStorageShape(db);
    const grounding = groundingStorageShape(db, true);
    if (fingerprints === "missing" || grounding === "missing") {
      throw incompatibleSchema("schema v2 is missing a required derived-storage table.");
    }
    return "v2";
  }
  if (version === 3) {
    const fingerprints = fingerprintStorageShape(db);
    const grounding = groundingStorageShape(db, false);
    if (fingerprints === "compact" && grounding === "legacy") return "main-v3";
    if (fingerprints === "legacy" && grounding === "generalized") return "integration-v3";
    if (fingerprints === "compact" && grounding === "generalized") return "hybrid-v3";
    throw incompatibleSchema("schema v3 does not match the main, integration, or complete hybrid lineage.");
  }
  if (version === DB_SCHEMA_VERSION) {
    assertCombinedSchemaShape(db);
    return "v4";
  }
  throw incompatibleSchema(`version ${version} is not a recognized migration source.`);
}

function assertCombinedSchemaShape(db: SqliteDatabase): void {
  if (fingerprintStorageShape(db) !== "compact") {
    throw incompatibleSchema("schema v4 does not use compact fingerprints and integer-ref LSH.");
  }
  if (groundingStorageShape(db, false) !== "generalized") {
    throw incompatibleSchema("schema v4 does not use subject-generalized grounding.");
  }
}

/** Full candidate validation performed before schema v4 can be stamped. */
function validateCombinedSchema(db: SqliteDatabase): void {
  assertCombinedSchemaShape(db);

  const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw incompatibleSchema(`SQLite integrity_check failed: ${integrity.map((row) => row.integrity_check).join("; ")}.`);
  }
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0) throw incompatibleSchema("foreign-key validation failed.");

  const bucketIterator = db.prepare(
    `SELECT CAST(ref AS TEXT) AS ref, band, CAST(band_hash AS TEXT) AS band_hash
     FROM lsh_buckets ORDER BY lsh_buckets.ref, band, band_hash`,
  ).iterate()[Symbol.iterator]() as IterableIterator<{ ref: string; band: number; band_hash: string }>;
  let bucketStep = bucketIterator.next();

  const fingerprints = db.prepare(
    `SELECT CAST(ref AS TEXT) AS ref, node_id, minhash, typeof(minhash) AS storage_type,
            neighbors, token_count
     FROM node_fingerprints ORDER BY node_fingerprints.ref`,
  ).iterate() as IterableIterator<{
    ref: string;
    node_id: string;
    minhash: Uint8Array;
    storage_type: string;
    neighbors: string;
    token_count: number;
  }>;
  for (const row of fingerprints) {
    let fingerprint: Fingerprint;
    try {
      if (row.storage_type !== "blob" || !(row.minhash instanceof Uint8Array)) throw new Error("not a BLOB");
      fingerprint = {
        minhash: decodeMinhash(row.minhash),
        neighbors: JSON.parse(row.neighbors) as string[],
        tokenCount: row.token_count,
      };
      bandHashInts(fingerprint);
    } catch {
      throw incompatibleSchema(`compact fingerprint ${JSON.stringify(row.node_id)} is invalid.`);
    }
    const expected = bandHashInts(fingerprint).map((hash, band) => ({ band, hash: hash.toString() }));
    if (!bucketStep.done && BigInt(bucketStep.value.ref) < BigInt(row.ref)) {
      throw incompatibleSchema("LSH contains rows without a fingerprint owner.");
    }
    // A small fingerprint may own no buckets (see `indexedInLsh`).
    if (!indexedInLsh(fingerprint) && (bucketStep.done || bucketStep.value.ref !== row.ref)) continue;
    for (const entry of expected) {
      if (
        bucketStep.done
        || bucketStep.value.ref !== row.ref
        || bucketStep.value.band !== entry.band
        || bucketStep.value.band_hash !== entry.hash
      ) {
        throw incompatibleSchema(`LSH buckets for ${JSON.stringify(row.node_id)} do not match its fingerprint.`);
      }
      bucketStep = bucketIterator.next();
    }
    if (!bucketStep.done && bucketStep.value.ref === row.ref) {
      throw incompatibleSchema(`LSH buckets for ${JSON.stringify(row.node_id)} do not match its fingerprint.`);
    }
  }
  if (!bucketStep.done) throw incompatibleSchema("LSH contains rows without a fingerprint owner.");

  const invalidGrounding = db.prepare(
    `SELECT 1 FROM _mex_grounded_source
     WHERE subject_kind NOT IN ('scaffold', 'entity') OR subject_id = '' OR node_id = ''
        OR (subject_kind = 'scaffold' AND scaffold_file IS NOT subject_id)
        OR (subject_kind = 'entity' AND scaffold_file IS NOT NULL)
     LIMIT 1`,
  ).get();
  if (invalidGrounding) throw incompatibleSchema("subject grounding projection is invalid.");
}

export interface GraphDatabaseUpgradeResult {
  fromVersion: number;
  toVersion: number;
  changed: boolean;
  requiresRebuild: boolean;
  lineage: GraphSchemaLineage;
}

/**
 * Upgrade and validate an already-isolated graph candidate. Publication and
 * maintenance locking remain the caller's responsibility.
 */
export function upgradeGraphDatabase(dbPath: string): GraphDatabaseUpgradeResult {
  if (!existsSync(dbPath)) throw incompatibleSchema("the graph upgrade candidate does not exist.");
  const probe = openSqlite(dbPath, { readOnly: true });
  let fromVersion: number;
  let lineage: GraphSchemaLineage;
  try {
    if (!tableExists(probe, "schema_versions")) {
      throw incompatibleSchema("the graph upgrade candidate has no schema version metadata.");
    }
    const recordedVersion = readSchemaVersion(probe);
    if (recordedVersion === null) {
      throw incompatibleSchema("the graph upgrade candidate has no valid schema version row.");
    }
    fromVersion = recordedVersion;
    lineage = detectGraphSchemaLineage(probe, fromVersion);
  } finally {
    probe.close();
  }

  const db = openGraphDatabase(dbPath, { allowRebuild: true });
  try {
    validateCombinedSchema(db);
    return {
      fromVersion,
      toVersion: DB_SCHEMA_VERSION,
      changed: fromVersion !== DB_SCHEMA_VERSION,
      requiresRebuild: graphRequiresRebuild(db),
      lineage,
    };
  } finally {
    db.close();
  }
}
