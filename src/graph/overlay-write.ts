import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { openSqlite, type SqliteDatabase } from "./db/sqlite.js";
import { GraphStore } from "./db/store.js";
import { incrementalStateIsCurrent } from "./publication-delta.js";
import { OVERLAY_REF_OFFSET, OWNED_TABLES } from "./overlay.js";

/** Writing overlays (see `overlay.ts` for the format and how readers use it). */

const FTS_TABLES = new Set(["nodes_fts", "source_chunks_fts"]);
const FTS_SHADOW = /^(nodes_fts|source_chunks_fts)_(data|idx|content|docsize|config)$/;
/** `files` columns that describe the file's content; times are left out. */
const FILE_IDENTITY = "content_hash, language, size, parse_status, diagnostic_count, missing_count, error_coverage, errors, node_count, extractor_version";

function uri(file: string): string { return `${pathToFileURL(file).href}?immutable=1`; }
function hasTable(db: SqliteDatabase, schema: string, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(table);
}

/**
 * An overlay ref: shifted past every base ref. A ref already past the offset
 * came from an earlier overlay (the warm path writes from base plus overlay)
 * and keeps its value, so refs never grow from one overlay to the next.
 */
function shifted(column: string): string {
  return `CASE WHEN ${column} < ${OVERLAY_REF_OFFSET} THEN ${column} + ${OVERLAY_REF_OFFSET} ELSE ${column} END`;
}

/** A table's stored columns, quoted: generated columns can't be inserted. */
function stored(db: SqliteDatabase, table: string, schema = "c"): string {
  const columns = db.prepare(`SELECT name, hidden FROM pragma_table_xinfo(?, ?)`).all(table, schema) as Array<{ name: string; hidden: number }>;
  return columns.filter(column => column.hidden === 0).map(column => `"${column.name.replaceAll('"', '""')}"`).join(", ");
}

export interface OverlayPlan {
  files: string[];
  total: number;
  /** Whether a table no file owns (project metadata, aliases, grounding) differs from the base. */
  whole: boolean;
}

/**
 * The files whose rows differ between a refreshed graph and the base it
 * started from, or a reason no overlay can be trusted (no row digests on one
 * side). Reads both files immutably.
 */
export function planOverlay(base: string, refreshed: string): OverlayPlan | { reason: string } {
  const db = openSqlite(refreshed, { readOnly: true, immutable: true });
  try {
    db.exec(`ATTACH DATABASE '${uri(base).replaceAll("'", "''")}' AS b`);
    for (const [schema, label] of [["main", "the refreshed graph"], ["b", "the base"]] as const) {
      for (const table of ["file_row_digests", "files", "coverage"]) {
        if (!hasTable(db, schema, table)) return { reason: `${label} has no ${table}` };
      }
    }
    if (!incrementalStateIsCurrent(new GraphStore(db))) return { reason: "no row digests describe the refreshed graph" };
    if (!digestsCurrent(base)) return { reason: "no row digests describe the base" };
    const rows = db.prepare(`
      WITH paths(path) AS (
        SELECT path FROM main.files UNION SELECT path FROM b.files
        UNION SELECT path FROM main.file_row_digests UNION SELECT path FROM b.file_row_digests
        UNION SELECT path FROM main.coverage UNION SELECT path FROM b.coverage)
      SELECT path FROM paths p WHERE
        (SELECT digest FROM main.file_row_digests WHERE path = p.path) IS NOT (SELECT digest FROM b.file_row_digests WHERE path = p.path)
        OR (SELECT json_array(${FILE_IDENTITY}) FROM main.files WHERE path = p.path) IS NOT (SELECT json_array(${FILE_IDENTITY}) FROM b.files WHERE path = p.path)
        OR (SELECT reason FROM main.coverage WHERE path = p.path) IS NOT (SELECT reason FROM b.coverage WHERE path = p.path)
      ORDER BY path`).all() as Array<{ path: string }>;
    const total = (db.prepare("SELECT count(*) AS n FROM main.files").get() as { n: number }).n;
    return { files: rows.map(row => row.path), total, whole: wholeTablesDiffer(db) };
  } finally { db.close(); }
}

/** Tables copied whole into an overlay; `project_metadata` is compared without its write times. */
function wholeTablesDiffer(db: SqliteDatabase): boolean {
  const owned = new Set(OWNED_TABLES.map(entry => entry.table));
  const tables = (db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map(row => row.name)
    .filter(name => !owned.has(name) && !FTS_TABLES.has(name) && !FTS_SHADOW.test(name) && !name.startsWith("sqlite_"));
  for (const table of tables) {
    if (!hasTable(db, "b", table)) return true;
    const list = table === "project_metadata" ? "key, value" : stored(db, table, "main");
    const name = `"${table.replaceAll('"', '""')}"`;
    const differs = db.prepare(`SELECT 1 FROM (SELECT ${list} FROM main.${name} EXCEPT SELECT ${list} FROM b.${name})
      UNION ALL SELECT 1 FROM (SELECT ${list} FROM b.${name} EXCEPT SELECT ${list} FROM main.${name}) LIMIT 1`).get();
    if (differs) return true;
  }
  return false;
}

function digestsCurrent(file: string): boolean {
  const db = openSqlite(file, { readOnly: true, immutable: true });
  try { return incrementalStateIsCurrent(new GraphStore(db)); } finally { db.close(); }
}

/** Whether a change of this size should rebuild the base instead (design: max(200 files, 10%)). */
export function overlayTooLarge(plan: OverlayPlan): boolean {
  return plan.files.length > Math.max(200, Math.ceil(plan.total * 0.1));
}

/**
 * Write the overlay of `refreshed` against `base` into `target` (a new,
 * empty temporary file). `root` is the checkout, read only to rebuild the
 * source-chunk search rows; returns a reason when a file changed on disk
 * since the refresh, in which case the caller publishes a full base.
 */
export function writeOverlay(input: { base: string; refreshed: string; target: string; root: string; files: readonly string[] }): { reason: string } | undefined {
  const db = openSqlite(input.target);
  try {
    db.exec("PRAGMA foreign_keys = OFF; PRAGMA journal_mode = DELETE;");
    db.exec(`ATTACH DATABASE '${uri(input.refreshed).replaceAll("'", "''")}' AS c`);
    db.exec(`ATTACH DATABASE '${uri(input.base).replaceAll("'", "''")}' AS b`);
    const schema = db.prepare("SELECT type, name, sql FROM c.sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, rowid").all() as Array<{ type: string; name: string; sql: string }>;
    db.exec("BEGIN");
    for (const entry of schema) {
      if (entry.name.startsWith("sqlite_") || FTS_SHADOW.test(entry.name)) continue;
      db.exec(entry.sql);
    }
    db.exec(`
      CREATE TABLE overlay_info(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE shadow_files(path TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE shadow_nodes(id TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE shadow_refs(ref INTEGER PRIMARY KEY);
      CREATE TEMP TABLE changed_nodes(id TEXT PRIMARY KEY) WITHOUT ROWID;`);
    db.prepare("INSERT INTO overlay_info VALUES ('base', ?), ('ref_offset', ?)").run(basename(input.base), String(OVERLAY_REF_OFFSET));
    const shadow = db.prepare("INSERT INTO shadow_files VALUES (?)");
    for (const path of input.files) shadow.run(path);
    db.exec(`
      INSERT INTO shadow_nodes SELECT id FROM b.nodes WHERE file_path IN (SELECT path FROM shadow_files);
      INSERT INTO shadow_refs SELECT ref FROM b.node_fingerprints WHERE node_id IN (SELECT id FROM shadow_nodes);
      INSERT INTO temp.changed_nodes SELECT id FROM c.nodes WHERE file_path IN (SELECT path FROM shadow_files);`);
    const owned = new Set(OWNED_TABLES.map(entry => entry.table));
    for (const { table, column, owner } of OWNED_TABLES) {
      if (table === "source_chunks" || !hasTable(db, "c", table)) continue;
      if (table === "node_fingerprints") {
        db.exec(`INSERT INTO main.node_fingerprints (ref, node_id, minhash, neighbors, token_count)
          SELECT ${shifted("ref")}, node_id, minhash, neighbors, token_count FROM c.node_fingerprints
          WHERE node_id IN (SELECT id FROM temp.changed_nodes)`);
        continue;
      }
      if (table === "lsh_buckets") {
        db.exec(`INSERT INTO main.lsh_buckets (band, band_hash, ref)
          SELECT band, band_hash, ${shifted("ref")} FROM c.lsh_buckets
          WHERE ref IN (SELECT ref FROM c.node_fingerprints WHERE node_id IN (SELECT id FROM temp.changed_nodes))`);
        continue;
      }
      const filter = owner === "file" ? "SELECT path FROM shadow_files" : "SELECT id FROM temp.changed_nodes";
      // `nodes` inserts fire the schema's triggers, which fill `nodes_fts`.
      const list = stored(db, table);
      db.exec(`INSERT INTO main.${table} (${list}) SELECT ${list} FROM c.${table} WHERE ${column} IN (${filter})`);
    }
    // Tables no file owns come whole from the refreshed graph.
    for (const entry of schema) {
      if (entry.type !== "table" || owned.has(entry.name) || FTS_TABLES.has(entry.name)
        || entry.name.startsWith("sqlite_") || FTS_SHADOW.test(entry.name)) continue;
      const name = `"${entry.name.replaceAll('"', '""')}"`;
      const list = stored(db, entry.name);
      db.exec(`INSERT INTO main.${name} (${list}) SELECT ${list} FROM c.${name}`);
    }
    // Source-chunk search rows hold text the database doesn't keep: rebuild
    // them from the file, provided it still has the content that was indexed.
    const store = new GraphStore(db);
    const indexed = db.prepare("SELECT DISTINCT file_path AS path, content_hash AS hash FROM c.source_chunks WHERE file_path IN (SELECT path FROM shadow_files)").all() as Array<{ path: string; hash: string }>;
    for (const { path, hash } of indexed) {
      let text: string;
      try { text = readFileSync(join(input.root, path), "utf8"); } catch { db.exec("ROLLBACK"); return { reason: `${path} changed on disk during the refresh` }; }
      if (createHash("sha256").update(text).digest("hex") !== hash) { db.exec("ROLLBACK"); return { reason: `${path} changed on disk during the refresh` }; }
      store.replaceSourceChunks(path, text, hash);
    }
    db.exec("COMMIT");
    db.exec("DETACH DATABASE c; DETACH DATABASE b;");
  } finally { db.close(); }
  return undefined;
}

