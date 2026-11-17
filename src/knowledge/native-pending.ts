/**
 * The hook asks for a rule-file rebuild when a note the agent loads from
 * MEX's own rule files no longer matches the code. It writes one small
 * request per checkout under `<record directory>/native-pending/`; Node, the
 * only writer of the job table, turns each into a `native-files` job, which
 * runs between sessions and writes the files from current verdicts.
 */
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { queueJob } from "../record/background.js";
import type { RecordWriter } from "../record/index.js";
import { readBoundedTextFile } from "./files.js";
import "./native-job.js";

export const NATIVE_PENDING_DIRECTORY = "native-pending";
const Request = z.object({
  version: z.literal(1),
  project_id: z.string().regex(/^[gf]-[a-f0-9]{24}$/u),
  checkout: z.string().max(4096).refine(isAbsolute),
}).strict();

/** Whether a request is waiting (one stat; the background loop checks it often). */
export function nativePending(recordDirectory: string): boolean {
  try { return lstatSync(join(recordDirectory, NATIVE_PENDING_DIRECTORY)).isDirectory() && readdirSync(join(recordDirectory, NATIVE_PENDING_DIRECTORY)).some(name => name.endsWith(".json")); }
  catch { return false; }
}

/** Queue a rebuild for every waiting request. Returns how many were queued. */
export function queuePendingNative(writer: RecordWriter): number {
  const directory = join(writer.location.directory, NATIVE_PENDING_DIRECTORY);
  try { if (!lstatSync(directory).isDirectory()) return 0; } catch { return 0; }
  let names: string[] = [];
  try { names = readdirSync(directory).filter(name => name.endsWith(".json")); } catch { return 0; }
  let queued = 0;
  for (const name of names.slice(0, 256)) {
    const file = join(directory, name);
    const text = readBoundedTextFile(file, 16 << 10);
    // Remove first: a later request from the hook writes a new file.
    try { unlinkSync(file); } catch { continue; }
    if (text === undefined) continue;
    let request: z.infer<typeof Request>;
    try { request = Request.parse(JSON.parse(text)); } catch { continue; }
    queueRebuild(writer, request.project_id, request.checkout);
    queued++;
  }
  return queued;
}

/**
 * A stale note is already in a file the agent loads, so this rebuild does not
 * wait for the session to end: it rewrites the files from current verdicts,
 * which only drops what the code no longer supports. The job is idempotent.
 */
export function queueRebuild(writer: RecordWriter, projectId: string, checkout: string): void {
  try { queueJob(writer, { kind: "native-files", projectId, params: { checkout, stale: true } }); } catch { /* a later pass asks again */ }
}
