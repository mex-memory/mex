import { lstatSync, opendirSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { RecordWriter } from "../record/index.js";
import { requestJob, type EnqueueOptions, type EnqueueResult } from "../record/jobs.js";
import { shortHash } from "../record/project.js";
import { containedDirectory, readBoundedTextFile } from "../knowledge/files.js";
import { filterAllowed, filterSession, finishedCaptureSession, type FilterParams } from "./input.js";
import { ongoingLearningOn } from "../knowledge/session-learning.js";
import { typedCapture } from "./profiles.js";
import { sourceModelAgent } from "./runner.js";
import { timestampNs } from "./time.js";

export const STAGE_TWO_WAIT = "Waiting: the next daily session-note pass";

const Request = z.object({ version: z.literal(1), project_id: z.string().regex(/^[gf]-[a-f0-9]{24}$/u),
  checkout: z.string().max(4096).refine(isAbsolute), agent: z.string().refine(typedCapture), generation: z.string().min(1).max(128),
  session_id: z.string().min(1).max(512).optional(), session_learning: z.literal(true).optional(), ready_at: z.string().datetime({ offset: true }).optional(),
}).strict();
const REQUEST_NAME = /^[a-f0-9]{24}(?:\.[a-f0-9]{24}\.[0-9]{19})?\.json$/u;

function requestParams(writer: RecordWriter, directory: string, name: string, now: number) {
  const raw = readBoundedTextFile(join(directory, name), 16 << 10);
  if (!raw) return;
  const r = Request.parse(JSON.parse(raw));
  if (!typedCapture(r.agent)) return;
  const key = shortHash(r.checkout), runner = sourceModelAgent(r.agent);
  const learning = ongoingLearningOn(writer);
  if (!learning && (!runner || r.session_learning)) return;
  if (r.session_learning) {
    if (!r.session_id || name !== `${key}.${shortHash(r.agent + "\0" + r.session_id)}.${timestampNs(r.generation)}.json`) return;
    if (r.ready_at && Date.parse(r.ready_at) > now) return;
    const meta = filterSession(writer, r.project_id, r.checkout, r.session_id);
    if (!meta || meta.agent !== r.agent || meta.seen_at !== r.generation) {
      // The immutable hint belongs to a newer start or finish now. Only its own path is removed.
      try { unlinkSync(join(directory, name)); } catch { /* retry the stale hint later */ }
      return;
    }
    if (r.ready_at && !finishedCaptureSession(writer, r.project_id, r.checkout, r.session_id, now)) return;
  } else if (name !== `${key}.json` || writer.setting("filter", `finished.${key}`) === r.generation) return;
  const params: FilterParams = { checkout: r.checkout, agent: runner ?? "claude", generation: r.generation,
    ...(r.session_id ? { sessionId: r.session_id } : {}), ...(learning ? { sourceAgent: r.agent } : {}),
    ...(r.session_learning ? { request: name } : {}) };
  if (filterAllowed(writer, r.project_id, params)) return { params, project: r.project_id };
}

export function filterPending(directory: string, writer?: RecordWriter): boolean {
  try {
    const s = lstatSync(join(directory, "filter-pending"));
    if (!s.isDirectory() || s.isSymbolicLink()) return false;
    if (!writer) return true;
    const root = containedDirectory(directory, ["filter-pending"])!, handle = opendirSync(root);
    try {
      let child, visited = 0;
      const now = Date.now();
      while ((child = handle.readSync()) && ++visited <= 10_000) {
        if (!child.isFile() || !REQUEST_NAME.test(child.name)) continue;
        try { if (requestParams(writer, root, child.name, now)) return true; }
        catch { /* An invalid request must not hide another checkout's work. */ }
      }
      return false;
    } finally { handle.closeSync(); }
  } catch { return false; }
}
/** Requests remain until their exact generation finishes. No destructive claim window. */
export function queuePendingFilters(writer: RecordWriter, queue: (writer: RecordWriter, options: EnqueueOptions) => EnqueueResult, now = Date.now()): number {
  const directory = containedDirectory(writer.location.directory, ["filter-pending"]);
  if (!directory) return 0;
  const files: string[] = [], handle = opendirSync(directory);
  try {
    let f, count = 0;
    while ((f = handle.readSync()) && ++count <= 10_000) if (f.isFile() && REQUEST_NAME.test(f.name)) files.push(f.name);
  } finally { handle.closeSync(); }
  files.sort();
  const cursor = writer.setting("filter", "requests.after") ?? "";
  const ordered = [...files.filter(f => f > cursor), ...files.filter(f => f <= cursor)].slice(0, 32);
  let queued = 0;
  for (const name of ordered) try {
    const request = requestParams(writer, directory, name, now);
    if (!request) continue;
    const { params, project } = request;
    let result = queue(writer, { kind: "filter", projectId: project, params });
    // A host/account or checkout hold must not pin this repo to an older
    // session forever. A fresh eligible request can replace automatic waiting
    // work; running and explicitly paused jobs retain their owner's intent.
    if (result.existing && result.job.state === "waiting") {
      const previous = JSON.parse(result.job.params) as FilterParams;
      if (previous.checkout !== params.checkout || previous.agent !== params.agent || previous.sourceAgent !== params.sourceAgent || previous.sessionId !== params.sessionId
        || result.job.reason === STAGE_TWO_WAIT && previous.generation !== params.generation) {
        const cancelled = requestJob(writer, result.job.id, "cancel", { state: "waiting", params: result.job.params });
        if (cancelled.state !== "cancelled") continue;
        finishRequest(writer, previous);
        result = queue(writer, { kind: "filter", projectId: project, params });
      }
    }
    if (!result.existing) queued++;
  } catch { /* A bounded later pass retries unavailable requests. */ }
  if (ordered.length) writer.db.prepare("INSERT INTO settings VALUES('filter','requests.after',?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(ordered.at(-1)!);
  return queued;
}
export function finishRequest(writer: RecordWriter, params: FilterParams): void {
  const directory = containedDirectory(writer.location.directory, ["filter-pending"]);
  if (!directory) return;
  const key = shortHash(params.checkout);
  if (params.request && (!REQUEST_NAME.test(params.request) || !params.request.startsWith(key + "."))) return;
  const path = join(directory, params.request ?? `${key}.json`);
  // A replacement can race a read/unlink. Keep requests as idempotent hints and
  // acknowledge their generation in Node instead of deleting a hook's newer file.
  const raw = readBoundedTextFile(path, 16 << 10);
  if (!raw) return;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return; }
  const parsed = Request.safeParse(value);
  if (!parsed.success) return;
  const r = parsed.data;
  if (r.generation === params.generation && r.checkout === params.checkout && r.project_id === writer.checkout(params.checkout)?.project_id) {
    if (params.request && r.session_learning) {
      // The generation is part of the name. A concurrent finish creates a new path.
      try { unlinkSync(path); } catch { /* the next pass can retry it */ }
      return;
    }
    writer.db.prepare("INSERT INTO settings VALUES('filter',?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
      .run(`finished.${key}`, r.generation);
  }
}
