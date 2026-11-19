import type { SqliteDatabase } from "./db/sqlite.js";
import { GraphStore } from "./db/store.js";
import { OWNED_TABLES } from "./overlay.js";

/**
 * Turn a writable copy of an overlay's base into base plus overlay: exactly
 * the rows a reader sees through the views. Used where a writer needs the
 * whole graph in one file (a rebuild's continuity clone, a warm checkout's
 * private copy). Returns the files the overlay shadows.
 *
 * Source-chunk search rows hold text the database does not keep: with
 * `sourceChunks`, the overlay's files get them again from their text (the
 * callback must check the text still has the stored hash); without it, they
 * have no chunks, which suits a copy whose rows are about to be replaced.
 */
export function materializeOverlay(
  db: SqliteDatabase,
  overlay: string,
  sourceChunks?: (path: string, hash: string) => string,
): string[] {
  const store = new GraphStore(db);
  const foreignKeys = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
  // Rows other files own point at shadowed nodes that come back from the
  // overlay; a cascade would delete them.
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`ATTACH DATABASE '${overlay.replaceAll("'", "''")}' AS o`);
  try {
    db.exec("BEGIN");
    const shadowed = (db.prepare("SELECT path FROM o.shadow_files").all() as Array<{ path: string }>).map((row) => row.path);
    db.exec("CREATE TEMP TABLE IF NOT EXISTS materialize_shadow(path TEXT PRIMARY KEY) WITHOUT ROWID; DELETE FROM temp.materialize_shadow;");
    const add = db.prepare("INSERT INTO temp.materialize_shadow VALUES (?)");
    for (const path of shadowed) add.run(path);
    const shadowedNodes = "SELECT id FROM main.nodes WHERE file_path IN (SELECT path FROM temp.materialize_shadow)";
    db.exec(`
      DELETE FROM main.lsh_buckets WHERE ref IN (SELECT ref FROM main.node_fingerprints WHERE node_id IN (${shadowedNodes}));
      DELETE FROM main.node_fingerprints WHERE node_id IN (${shadowedNodes});
      DELETE FROM main.edges WHERE source IN (${shadowedNodes});
      DELETE FROM main.unresolved_refs WHERE from_node_id IN (${shadowedNodes});`);
    for (const path of shadowed) store.deleteSourceChunks(path);
    for (const { table, column, owner } of OWNED_TABLES) {
      if (owner !== "file" || table === "source_chunks" || table === "nodes") continue;
      db.exec(`DELETE FROM main.${table} WHERE ${column} IN (SELECT path FROM temp.materialize_shadow)`);
    }
    db.exec("DELETE FROM main.nodes WHERE file_path IN (SELECT path FROM temp.materialize_shadow)");
    const columns = (table: string): string => (db.prepare("SELECT name, hidden FROM pragma_table_xinfo(?, 'o')").all(table) as Array<{ name: string; hidden: number }>)
      .filter((column) => column.hidden === 0).map((column) => `"${column.name.replaceAll('"', '""')}"`).join(", ");
    // Nodes first: their insert triggers fill the node search index.
    for (const table of ["nodes", ...OWNED_TABLES.map((entry) => entry.table).filter((table) => table !== "nodes" && table !== "source_chunks")]) {
      const list = columns(table);
      if (list) db.exec(`INSERT INTO main.${table} (${list}) SELECT ${list} FROM o.${table}`);
    }
    // Tables no file owns come whole from the overlay.
    for (const table of ["project_metadata", "node_aliases", "_mex_grounded_source"]) {
      const list = columns(table);
      if (!list) continue;
      db.exec(`DELETE FROM main.${table}; INSERT INTO main.${table} (${list}) SELECT ${list} FROM o.${table}`);
    }
    if (sourceChunks) {
      for (const row of db.prepare("SELECT path, content_hash AS hash FROM o.files").all() as Array<{ path: string; hash: string }>) {
        store.replaceSourceChunks(row.path, sourceChunks(row.path, row.hash), row.hash);
      }
    }
    db.exec("COMMIT");
    return shadowed;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* none open */ }
    throw error;
  } finally {
    db.exec("DETACH DATABASE o");
    if (foreignKeys) db.exec("PRAGMA foreign_keys = ON");
  }
}
