import { openSqlite, type SqliteDatabase } from "./db/sqlite.js";
import { installGraphViews } from "./overlay.js";
import { currentGraphPath } from "./storage.js";

/**
 * Open a graph file read-only and immutable. An overlay is opened with its
 * base attached and the union views installed, so callers read one graph.
 */
export function openGraphFile(file: string): SqliteDatabase {
  const db = openSqlite(file, { readOnly: true, immutable: true });
  try { installGraphViews(db, file); }
  catch (error) { db.close(); throw error; }
  return db;
}

/** The checkout's current graph, base plus overlay, or undefined when none is published. */
export function openGraphRead(root: string): SqliteDatabase | undefined {
  let file: string;
  try { file = currentGraphPath(root); } catch { return undefined; }
  try { return openGraphFile(file); } catch { return undefined; }
}
