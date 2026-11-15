/**
 * The background job that refreshes one checkout's working set, and the queue
 * the hook feeds. At session start the hook finds the cached set missing or
 * behind and leaves a request file plus the `working-set-pending` marker; it
 * never runs git itself. The background loop turns requests into jobs.
 */
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { queueJob } from "../record/background.js";
import type { RecordWriter } from "../record/index.js";
import { registerJobKind } from "../record/jobs.js";

export interface WorkingSetJobParams { checkout: string }

export function workingSetPendingMarker(recordDirectory: string): string { return join(recordDirectory, "working-set-pending"); }
export function workingSetRequests(recordDirectory: string): string { return join(recordDirectory, "working-set-requests"); }

/** Whether the hook asked for a refresh (one stat). */
export function workingSetPending(recordDirectory: string): boolean { return existsSync(workingSetPendingMarker(recordDirectory)); }

const PROJECT = /^[gf]-[0-9a-f]{8,64}$/;

/** Queue a refresh for each requested checkout. Returns how many were queued. */
export function queueWorkingSetRequests(writer: RecordWriter): number {
  const directory = writer.location.directory;
  const marker = workingSetPendingMarker(directory);
  if (!existsSync(marker)) return 0;
  // Remove the marker first: a request after this point leaves a new one.
  try { unlinkSync(marker); } catch { return 0; }
  let names: string[] = [];
  try { names = readdirSync(workingSetRequests(directory)).slice(0, 256); } catch { return 0; }
  let queued = 0, waiting = false;
  for (const name of names) {
    const file = join(workingSetRequests(directory), name);
    let request: { project?: unknown; root?: unknown };
    try { request = JSON.parse(readFileSync(file, "utf8")) as typeof request; } catch { try { unlinkSync(file); } catch { /* gone */ } continue; }
    if (typeof request.project !== "string" || !PROJECT.test(request.project) || typeof request.root !== "string" || !request.root) {
      try { unlinkSync(file); } catch { /* gone */ }
      continue;
    }
    const { existing } = queueJob(writer, { kind: "working-set", projectId: request.project, params: { checkout: request.root } satisfies WorkingSetJobParams });
    // One refresh per project is open at a time; keep the request for the next pass.
    if (existing) { waiting = true; continue; }
    try { unlinkSync(file); } catch { /* the job runs anyway */ }
    queued++;
  }
  if (waiting) { try { writeFileSync(marker, ""); } catch { /* the next session start leaves one */ } }
  return queued;
}

registerJobKind<WorkingSetJobParams, { runs: number }>({
  name: "working-set",
  label: "Working set",
  scope: "project",
  // It only replaces a cache file; running it twice is harmless.
  sideEffects: "idempotent",
  async runBatch({ job, params, checkpoint, writer }) {
    const { writeWorkingSet } = await import("./compute.js");
    const set = await writeWorkingSet({ root: params.checkout, projectId: job.project_id!, recordDirectory: writer.location.directory, home: writer.location.home, location: writer.location });
    return {
      checkpoint: { runs: (checkpoint?.runs ?? 0) + 1 },
      done: true,
      results: set.seeds.length + set.hops.length,
      summary: `${set.seeds.length} files in progress, ${set.hops.length} related`,
    };
  },
});
