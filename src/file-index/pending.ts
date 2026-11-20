/**
 * After an edit the hook writes a line shift and touches `index-pending` in
 * the record directory. The background process turns that into a refresh of
 * each checkout with shifts waiting, which re-parses the edited files and
 * clears their shifts. Kept small: the background loop checks it often.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { queueJob } from "../record/background.js";
import type { RecordWriter } from "../record/index.js";
import type { IndexJobParams } from "./job.js";
import { automaticWorkEnabled } from "../controls/index.js";

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

/** Checkouts compared per pass; the background process passes once a minute. */
const MAX_HEAD_CHECKS = 32;

export type HeadOf = (checkout: string) => string | undefined;
const headOf: HeadOf = checkout => {
  try {
    return execFileSync("git", ["-C", checkout, "rev-parse", "-q", "--verify", "HEAD"],
      { encoding: "utf8", timeout: 5_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch { return undefined; }
};

/**
 * Queue a refresh for every indexed checkout whose HEAD moved since its index was built: a
 * commit, checkout or pull made outside a session. Until it lands, the hook reads counts over a
 * folder or glob as unsettled (native/check), so a rule is never held on a count the commit made
 * stale. An index from before HEAD was recorded is refreshed once to record it.
 */
export function queueBehindHead(writer: RecordWriter, head: HeadOf = headOf): number {
  const directory = writer.location.directory;
  let projects: string[] = [];
  try { projects = readdirSync(join(directory, "projects")); } catch { return 0; }
  let queued = 0, checked = 0;
  for (const projectId of projects) {
    const checkouts = join(directory, "projects", projectId, "index", "checkouts");
    let files: string[] = [];
    try { files = readdirSync(checkouts).filter(name => name.endsWith(".json")); } catch { continue; }
    if (files.length && !automaticWorkEnabled(writer, projectId)) continue;
    for (const file of files) {
      if (checked >= MAX_HEAD_CHECKS) return queued;
      let pointer: { root?: unknown; head?: unknown };
      try { pointer = JSON.parse(readFileSync(join(checkouts, file), "utf8")) as typeof pointer; } catch { continue; }
      if (typeof pointer.root !== "string" || !existsSync(pointer.root)) continue;
      checked++;
      const current = head(pointer.root);
      if (!current || current === pointer.head) continue;
      if (!queueJob(writer, { kind: "file-index", projectId, params: { checkout: pointer.root } satisfies IndexJobParams }).existing) queued++;
    }
  }
  return queued;
}
