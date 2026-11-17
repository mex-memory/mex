/**
 * Folders that aren't git repos (plan sheet 59): turned on per folder with one
 * question, never in the home folder or a drive root (place.ts refuses those).
 * The project id is the folder's real path. A small marker, `.mex/project.json`,
 * records the id so a later ticket can offer to reattach a moved folder; it is
 * journaled so `mex uninstall` removes it.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckoutRow, RecordWriter } from "../record/index.js";
import { projectIdentity } from "../record/project.js";

/** Sheet 59's question, unchanged. */
export const FOLDER_QUESTION = [
  "Not a git repo. MEX can remember notes, rules and recipes for agents here,",
  "but can't learn from history, index code by git, or share. Turn on here? [y/n]",
] as const;
export const FOLDER_COMMAND = "mex --folder";
export const FOLDER_MARKER = ".mex/project.json";
export const MARKER_JOURNAL_KEY = "marker-v1:folder";

export interface FolderTurnOn { projectId: string; checkout: CheckoutRow; registered: boolean; }

/** Register this folder (and only this folder; subfolders are not covered yet). */
export function turnOnFolder(writer: RecordWriter, root: string): FolderTurnOn {
  const existing = writer.db.prepare("SELECT * FROM checkouts WHERE path=?").get(root) as unknown as CheckoutRow | undefined;
  if (existing && !existing.provisional) return { projectId: existing.project_id, checkout: existing, registered: false };
  const project = writer.register(projectIdentity(root));
  return { projectId: project.id, checkout: writer.db.prepare("SELECT * FROM checkouts WHERE path=?").get(root) as unknown as CheckoutRow, registered: true };
}

function markerText(projectId: string): string { return `${JSON.stringify({ version: 1, project_id: projectId })}\n`; }

/**
 * Write the marker once. A marker holding another id (a moved or copied
 * folder) is kept for the reattach question, never overwritten.
 */
export function writeFolderMarker(writer: RecordWriter, root: string, projectId: string): "written" | "present" | "kept" | "skipped" {
  const directory = join(root, ".mex"), file = join(root, FOLDER_MARKER), text = markerText(projectId);
  let createdDirectory = false;
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "skipped";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "skipped";
    createdDirectory = true;
  }
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return "skipped";
    return readFileSync(file, "utf8") === text ? "present" : "kept";
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "skipped"; }
  const intent = writer.db.prepare("INSERT INTO installs(agent,path,key,old_value,new_value,ts) VALUES(?,?,?,?,?,?)")
    .run("mex", file, MARKER_JOURNAL_KEY, JSON.stringify({ createdDirectory }), text, new Date().toISOString());
  try {
    if (createdDirectory) mkdirSync(directory);
    writeFileSync(file, text, { flag: "wx", mode: 0o644 });
  } catch (error) {
    writer.db.prepare("UPDATE installs SET key=? WHERE id=?").run(`cancelled:${MARKER_JOURNAL_KEY}`, intent.lastInsertRowid);
    throw error;
  }
  return "written";
}

/** Marker files uninstall would remove, for its dry-run list. */
export function journaledMarkers(reader: { all<T>(sql: string, ...values: (string | number)[]): T[] }): string[] {
  return reader.all<{ path: string }>("SELECT DISTINCT path FROM installs WHERE key=? ORDER BY path LIMIT 4096", MARKER_JOURNAL_KEY).map(row => row.path);
}

/** Remove markers MEX wrote and still match, and the `.mex` folder MEX made if it is empty. */
export function restoreFolderMarkers(writer: RecordWriter): { restored: string[]; conflicts: string[] } {
  const result = { restored: [] as string[], conflicts: [] as string[] };
  const rows = writer.db.prepare("SELECT id,path,old_value,new_value FROM installs WHERE key=? ORDER BY id DESC LIMIT 4096").all(MARKER_JOURNAL_KEY) as Array<{ id: number; path: string; old_value: string; new_value: string }>;
  for (const row of rows) {
    try {
      let current: string | undefined;
      try { current = readFileSync(row.path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (current !== undefined && current !== row.new_value) { result.conflicts.push(row.path); continue; }
      if (current !== undefined) unlinkSync(row.path);
      const { createdDirectory } = JSON.parse(row.old_value) as { createdDirectory?: boolean };
      const directory = join(row.path, "..");
      if (createdDirectory) { try { if (readdirSync(directory).length === 0) rmdirSync(directory); } catch { /* already gone */ } }
      writer.db.prepare("UPDATE installs SET key=? WHERE id=?").run(`restored:${MARKER_JOURNAL_KEY}`, row.id);
      result.restored.push(row.path);
    } catch { result.conflicts.push(row.path); }
  }
  return result;
}
