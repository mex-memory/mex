import { lstatSync, opendirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { RecordWriter } from "../record/index.js";
import { requestJob, type EnqueueOptions, type EnqueueResult } from "../record/jobs.js";
import { shortHash } from "../record/project.js";
import { containedDirectory, readBoundedTextFile } from "../knowledge/files.js";
import { filterAllowed, type FilterParams } from "./input.js";

const Request = z.object({ version: z.literal(1), project_id: z.string().regex(/^[gf]-[a-f0-9]{24}$/u),
  checkout: z.string().max(4096).refine(isAbsolute), agent: z.enum(["claude-code", "codex"]), generation: z.string().min(1).max(128) }).strict();
export function filterPending(directory: string, writer?: RecordWriter): boolean {
  try {
    const s = lstatSync(join(directory, "filter-pending"));
    if (!s.isDirectory() || s.isSymbolicLink()) return false;
    if (!writer) return true;
    const root = containedDirectory(directory, ["filter-pending"])!, handle = opendirSync(root);
    try {
      let child, visited = 0;
      while ((child = handle.readSync())) {
        if (++visited > 32) return true; // The rotating consumer handles larger sets.
        if (!child.isFile() || !/^[a-f0-9]{24}\.json$/u.test(child.name)) continue;
        try {
          const raw = readBoundedTextFile(join(root, child.name), 16 << 10);
          const parsed = Request.safeParse(JSON.parse(raw ?? "null"));
          if (parsed.success && writer.setting("filter", `finished.${shortHash(parsed.data.checkout)}`) !== parsed.data.generation) return true;
        } catch { /* An invalid request must not hide another checkout's work. */ }
      }
      return false;
    } finally { handle.closeSync(); }
  } catch { return false; }
}
/** Requests remain until their exact generation finishes. No destructive claim window. */
export function queuePendingFilters(writer: RecordWriter, queue: (writer: RecordWriter, options: EnqueueOptions) => EnqueueResult): number {
  const directory = containedDirectory(writer.location.directory, ["filter-pending"]);
  if (!directory) return 0;
  const files: string[] = [], handle = opendirSync(directory);
  try {
    let f, count = 0;
    while ((f = handle.readSync()) && ++count <= 10_000) if (f.isFile() && /^[a-f0-9]{24}\.json$/u.test(f.name)) files.push(f.name);
  } finally { handle.closeSync(); }
  files.sort();
  const cursor = writer.setting("filter", "requests.after") ?? "";
  const ordered = [...files.filter(f => f > cursor), ...files.filter(f => f <= cursor)].slice(0, 32);
  let queued = 0;
  for (const name of ordered) try {
    const raw = readBoundedTextFile(join(directory, name), 16 << 10);
    const r = Request.parse(JSON.parse(raw ?? ""));
    if (writer.setting("filter", `finished.${shortHash(r.checkout)}`) === r.generation) continue;
    const params: FilterParams = { checkout: r.checkout, agent: r.agent === "claude-code" ? "claude" : "codex", generation: r.generation };
    if (name !== `${shortHash(r.checkout)}.json` || !filterAllowed(writer, r.project_id, params)) continue;
    let result = queue(writer, { kind: "filter", projectId: r.project_id, params });
    // A host/account or checkout hold must not pin this repo to an older
    // session forever. A fresh eligible request can replace automatic waiting
    // work; running and explicitly paused jobs retain their owner's intent.
    if (result.existing && result.job.state === "waiting") {
      const previous = JSON.parse(result.job.params) as FilterParams;
      if (previous.checkout !== params.checkout || previous.agent !== params.agent) {
        const cancelled = requestJob(writer, result.job.id, "cancel", { state: "waiting", params: result.job.params });
        if (cancelled.state !== "cancelled") continue;
        finishRequest(writer, previous);
        result = queue(writer, { kind: "filter", projectId: r.project_id, params });
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
  const path = join(directory, `${shortHash(params.checkout)}.json`);
  // A replacement can race a read/unlink. Keep requests as idempotent hints and
  // acknowledge their generation in Node instead of deleting a hook's newer file.
  const raw = readBoundedTextFile(path, 16 << 10);
  if (!raw) return;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return; }
  const parsed = Request.safeParse(value);
  if (!parsed.success) return;
  const r = parsed.data;
  if (r.generation === params.generation && r.checkout === params.checkout && r.project_id === writer.checkout(params.checkout)?.project_id)
    writer.db.prepare("INSERT INTO settings VALUES('filter',?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
      .run(`finished.${shortHash(params.checkout)}`, r.generation);
}
