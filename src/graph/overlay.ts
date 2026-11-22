/**
 * Overlays: one checkout's difference from its project's shared base graph.
 *
 * Every derived graph row is owned by exactly one file (see
 * `publication-delta.ts`). An overlay holds the complete rows of each file
 * whose rows differ from the base, and lists those files in `shadow_files`
 * (deleted files included). A reader opens the overlay, attaches the base and
 * creates TEMP views with the base table names: base rows of unshadowed files
 * plus the overlay's rows. SQLite resolves unqualified names in `temp` first,
 * so existing queries read the union unchanged. Tables no file owns
 * (`project_metadata`, `node_aliases`, `_mex_grounded_source`,
 * `schema_versions`) are copied whole from the refreshed graph.
 *
 * Both files are immutable once published. The full-text indexes can't go
 * through a view, so search queries both sides (see `GraphStore`).
 */
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { hasV5GraphSchema, installV5GraphViews, readsV5Graph } from "./db/v5.js";
import type { SqliteDatabase } from "./db/sqlite.js";

export const OVERLAY_NAME = /^graph-o-[a-f0-9]{24}-[a-z0-9-]+\.db$/;
/** Overlay fingerprint refs are shifted past any base ref so the two never collide. */
export const OVERLAY_REF_OFFSET = 2 ** 40;

type Owner = "file" | "node" | "ref";
/** Tables owned row by row, and the column that names each row's owner. */
export const OWNED_TABLES: ReadonlyArray<{ table: string; column: string; owner: Owner }> = [
  { table: "nodes", column: "file_path", owner: "file" },
  { table: "edges", column: "source", owner: "node" },
  { table: "unresolved_refs", column: "from_node_id", owner: "node" },
  { table: "import_bindings", column: "file_path", owner: "file" },
  { table: "source_chunks", column: "file_path", owner: "file" },
  { table: "files", column: "path", owner: "file" },
  { table: "file_row_digests", column: "path", owner: "file" },
  { table: "file_extraction_cache", column: "path", owner: "file" },
  { table: "coverage", column: "path", owner: "file" },
  { table: "node_fingerprints", column: "node_id", owner: "node" },
  { table: "lsh_buckets", column: "ref", owner: "ref" },
];

function uri(file: string): string { return `${pathToFileURL(file).href}?immutable=1`; }
function hasTable(db: SqliteDatabase, schema: string, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(table);
}

/** The base a published overlay was written against, read from the overlay itself. */
export function overlayBase(db: SqliteDatabase): string | undefined {
  if (!hasTable(db, "main", "overlay_info")) return undefined;
  return (db.prepare("SELECT value FROM main.overlay_info WHERE key = 'base'").get() as { value: string } | undefined)?.value;
}

/**
 * Make a connection to an overlay read the union with its base. `overlayPath`
 * is where the overlay lives (the connection may have been opened through a
 * descriptor path). A connection that isn't an overlay is left unchanged.
 * `uncovered` hides further files (sources that drifted since the build).
 */
export function installGraphViews(db: SqliteDatabase, overlayPath: string | undefined, uncovered: readonly string[] = []): void {
  if (readsV5Graph(db) || hasV5GraphSchema(db)) {
    if (overlayBase(db) || (overlayPath && OVERLAY_NAME.test(basename(overlayPath)))) {
      throw new Error("Schema v5 graphs require a standalone base.");
    }
    installV5GraphViews(db, uncovered);
    return;
  }
  const attached = readsOverlay(db);
  const base = overlayPath || attached ? overlayBase(db) : undefined;
  if (!base && uncovered.length === 0) return;
  if (base && !attached && !overlayPath) throw new Error("An overlay needs its path to attach its base");
  const queryOnly = (db.prepare("PRAGMA query_only").get() as { query_only: number }).query_only;
  if (queryOnly) db.exec("PRAGMA query_only = OFF");
  try {
    if (base && !attached) {
      if (basename(base) !== base || !/^graph-base-[a-z0-9-]+\.db$/.test(base)) throw new Error("Invalid overlay base");
      db.exec(`ATTACH DATABASE '${uri(join(dirname(overlayPath!), base)).replaceAll("'", "''")}' AS base`);
      const version = db.prepare("PRAGMA base.user_version").get() as { user_version: number };
      if (version.user_version !== 0) throw new Error("A schema v4 overlay requires a schema v4 base.");
    }
    db.exec("CREATE TEMP TABLE IF NOT EXISTS graph_uncovered(path TEXT PRIMARY KEY) WITHOUT ROWID");
    const insert = db.prepare("INSERT OR IGNORE INTO temp.graph_uncovered VALUES (?)");
    for (const path of uncovered) insert.run(path);
    for (const { table, column, owner } of OWNED_TABLES) {
      if (!hasTable(db, "main", table)) continue;
      db.exec(`DROP VIEW IF EXISTS temp.${table}`);
      const hidden = owner === "file" ? `${column} NOT IN (SELECT path FROM temp.graph_uncovered)`
        : owner === "node" ? `${column} NOT IN (SELECT id FROM main.nodes WHERE file_path IN (SELECT path FROM temp.graph_uncovered))`
        : "1";
      const uncoveredFilter = uncovered.length > 0 ? ` AND ${hidden}` : "";
      if (!base) {
        if (uncovered.length > 0 && owner !== "ref") db.exec(`CREATE TEMP VIEW ${table} AS SELECT * FROM main.${table} WHERE ${hidden}`);
        continue;
      }
      const shadowed = owner === "file" ? `${column} NOT IN (SELECT path FROM main.shadow_files)`
        : owner === "node" ? `${column} NOT IN (SELECT id FROM main.shadow_nodes)`
        : `${column} NOT IN (SELECT ref FROM main.shadow_refs)`;
      const baseHidden = uncovered.length > 0 && owner === "node"
        ? ` AND ${column} NOT IN (SELECT id FROM base.nodes WHERE file_path IN (SELECT path FROM temp.graph_uncovered))`
        : uncoveredFilter;
      db.exec(`CREATE TEMP VIEW ${table} AS
        SELECT * FROM base.${table} WHERE ${shadowed}${baseHidden}
        UNION ALL SELECT * FROM main.${table} WHERE 1${uncoveredFilter}`);
    }
  } finally { if (queryOnly) db.exec("PRAGMA query_only = ON"); }
}

/** Whether a connection reads through an overlay (its base is attached). */
export function readsOverlay(db: SqliteDatabase): boolean {
  return (db.prepare("PRAGMA database_list").all() as Array<{ name: string }>).some(row => row.name === "base");
}
