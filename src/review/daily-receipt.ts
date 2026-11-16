import { lstatSync, opendirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { containedDirectory, readBoundedTextFile } from "../knowledge/files.js";
import { realPath, absolutePath } from "../record/project.js";

const BODY = "MEX Review daily receipt v1\n";
/** Exclusive file creation arbitrates across processes and worktrees. */
export function claimDailyReview(recordDirectory: string, project: string, now: number): boolean {
  if (!/^[gf]-[a-f0-9]{24}$/u.test(project)) return false;
  const day = new Date(now).toISOString().slice(0, 10);
  // Only existing, local record storage can receive a receipt. Empty projects
  // and queue reads never initialize a directory, location pointer or database.
  let stat;
  try { stat = lstatSync(recordDirectory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || realPath(recordDirectory) !== absolutePath(recordDirectory)) return false;
  const root = recordDirectory;
  const directory = containedDirectory(root, ["review-daily", project], true)!;
  const handle = opendirSync(directory);
  try {
    let child, seen = 0;
    while ((child = handle.readSync())) {
      if (++seen > 64) return false;
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(child.name) || !child.isFile() || child.isSymbolicLink()) continue;
      const path = join(directory, child.name), stat = lstatSync(path);
      if (stat.nlink !== 1 || readBoundedTextFile(path, 128) !== BODY) continue;
      if (child.name < day && now - Date.parse(child.name) > 31 * 86400000) unlinkSync(path);
    }
  } finally { handle.closeSync(); }
  try { writeFileSync(join(directory, day), BODY, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  return true;
}
