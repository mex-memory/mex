import { lstatSync, opendirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { z } from "zod";
import { automaticWorkEnabled } from "../controls/index.js";
import { readBoundedTextFile, containedDirectory } from "../knowledge/files.js";
import type { RecordWriter } from "../record/index.js";
import type { EnqueueOptions, EnqueueResult } from "../record/jobs.js";
import { shortHash } from "../record/project.js";

export const REQUEST_DIRECTORY = "judge-pending";
export const JudgeRequestSchema = z.object({
  version: z.literal(1), project_id: z.string().regex(/^[gf]-[a-f0-9]{24}$/u),
  checkout: z.string().max(4096).refine(isAbsolute), agent: z.enum(["claude-code", "codex"]),
  reason: z.enum(["start", "edit", "idle"]), generation: z.string().regex(/^\d{1,24}$/u),
  near: z.array(z.string().max(512)).max(128), not_before: z.number().nonnegative(),
}).strict();
export type JudgeRequest = z.infer<typeof JudgeRequestSchema>;
export interface JudgeParams { checkout: string; agent: "claude" | "codex"; near: string[]; }

/** Cheap wake-up hint only. Registrations and controls are checked before queueing. */
export function judgePending(directory: string): boolean {
  try { return lstatSync(join(directory, REQUEST_DIRECTORY)).isDirectory(); } catch { return false; }
}

/** Go writes only bounded request files; Node remains the sole job-table writer. */
export function queuePendingJudgements(
  writer: RecordWriter,
  queue: (writer: RecordWriter, options: EnqueueOptions) => EnqueueResult,
  now = Date.now(),
): number {
  const directory = containedDirectory(writer.location.directory, [REQUEST_DIRECTORY]);
  if (!directory) return 0;
  let queued = 0;
  const names: string[] = [];
  const handle = opendirSync(directory);
  try {
    let file, visited = 0;
    while ((file = handle.readSync())) {
      if (++visited > 10_000) break;
      if (file.isFile() && /^[a-f0-9]{24}\.json$/u.test(file.name)) names.push(file.name);
    }
  } finally { handle.closeSync(); }
  names.sort();
  const after = writer.setting("judge", "requests.after") ?? "";
  const ordered = [...names.filter(n => n > after), ...names.filter(n => n <= after)].slice(0, 32);
  for (const name of ordered) {
    const path = join(directory, name);
    try {
      const content = readBoundedTextFile(path, 16 << 10);
      const request = JudgeRequestSchema.parse(JSON.parse(content ?? ""));
      if (name !== `${shortHash(request.checkout)}.json`) continue;
      const checkout = writer.db.prepare("SELECT project_id,state,off_until FROM checkouts WHERE path=?").get(request.checkout) as { project_id: string; state: string; off_until: string | null } | undefined;
      if (!checkout || checkout.project_id !== request.project_id) continue;
      if (checkout.state === "off" || (checkout.state === "off until" && Date.parse(checkout.off_until ?? "") > now)
        || !automaticWorkEnabled(writer, request.project_id, now) || request.not_before > now) continue;
      const params: JudgeParams = { checkout: request.checkout, agent: request.agent === "claude-code" ? "claude" : "codex", near: request.near };
      // Consume before queueing: an edit after this point leaves a fresh request.
      // The job re-reads all current inputs, even if a newer hint replaced ours
      // just before unlink. An unfinished project job keeps this checkout waiting.
      unlinkSync(path);
      let restore = true;
      try {
        const result = queue(writer, { kind: "judge", projectId: request.project_id, params });
        restore = result.existing;
        if (!result.existing) queued++;
      } finally {
        if (restore) {
          try { writeFileSync(path, content!, { flag: "wx", mode: 0o600 }); } catch { /* a newer request takes precedence */ }
        }
      }
    } catch { /* incomplete/unsafe requests remain for a later bounded pass */ }
  }
  if (ordered.length) writer.db.prepare("INSERT INTO settings VALUES('judge','requests.after',?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(ordered.at(-1)!);
  try { rmdirSync(directory); } catch { /* pending requests or a concurrent hook */ }
  return queued;
}
