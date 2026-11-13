/**
 * After an edit the hook writes a line shift and touches `index-pending` in
 * the record directory. The background process turns that into a refresh of
 * each checkout with shifts waiting, which re-parses the edited files and
 * clears their shifts. Kept small: the background loop checks it often.
 */
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { queueJob } from "../record/background.js";
import type { RecordWriter } from "../record/index.js";
import type { IndexJobParams } from "./job.js";

export function indexPendingMarker(recordDirectory: string): string { return join(recordDirectory, "index-pending"); }

/** Whether edits are waiting for a re-parse (one stat). */
export function indexPending(recordDirectory: string): boolean { return existsSync(indexPendingMarker(recordDirectory)); }

/** Queue a refresh for every checkout with shifts waiting. Returns how many were queued. */
export function queuePendingRefreshes(writer: RecordWriter): number {
  const directory = writer.location.directory;
  const marker = indexPendingMarker(directory);
  if (!existsSync(marker)) return 0;
  // Remove the marker first: an edit after this point leaves a new one.
  try { unlinkSync(marker); } catch { return 0; }
  let queued = 0, waiting = false;
  let projects: string[] = [];
  try { projects = readdirSync(join(directory, "projects")); } catch { return 0; }
  for (const projectId of projects) {
    const index = join(directory, "projects", projectId, "index");
    let keys: string[] = [];
    try { keys = readdirSync(join(index, "shifts")); } catch { continue; }
    for (const key of keys) {
      try { if (readdirSync(join(index, "shifts", key)).length === 0) continue; } catch { continue; }
      let root: string;
      try { root = (JSON.parse(readFileSync(join(index, "checkouts", `${key}.json`), "utf8")) as { root: string }).root; } catch { continue; }
      const { existing } = queueJob(writer, { kind: "file-index", projectId, params: { checkout: root } satisfies IndexJobParams });
      // One refresh per project is open at a time; this checkout waits for the next pass.
      if (existing) waiting = true; else queued++;
    }
  }
  if (waiting) { try { writeFileSync(marker, ""); } catch { /* the next edit leaves one */ } }
  return queued;
}
