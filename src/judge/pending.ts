import { lstatSync, opendirSync, rmdirSync, unlinkSync, linkSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, isAbsolute } from "node:path";
import { z } from "zod";
import { automaticWorkEnabled } from "../controls/index.js";
import { readBoundedTextFile, containedDirectory } from "../knowledge/files.js";
import type { RecordWriter } from "../record/index.js";
import type { EnqueueOptions, EnqueueResult } from "../record/jobs.js";
import { shortHash } from "../record/project.js";
import { sessionWorkEnabled } from "./session.js";

export const REQUEST_DIRECTORY = "judge-pending";
export const JudgeRequestSchema = z.object({
  version: z.literal(1), project_id: z.string().regex(/^[gf]-[a-f0-9]{24}$/u),
  checkout: z.string().max(4096).refine(isAbsolute), agent: z.enum(["claude-code", "codex"]),
  reason: z.enum(["start", "edit", "idle"]), generation: z.string().regex(/^\d{1,24}$/u),
  session_id: z.string().min(1).max(512).optional(),
  near: z.array(z.string().max(512)).max(128), not_before: z.number().nonnegative(),
}).strict();
export type JudgeRequest = z.infer<typeof JudgeRequestSchema>;
export interface JudgeParams { checkout: string; agent: "claude" | "codex"; near: string[]; generation?: string; sessionId?: string; report?: true; }

export function pendingJudgeRequest(directory: string, checkout: string): JudgeRequest | undefined {
  const root = containedDirectory(directory, [REQUEST_DIRECTORY]);
  if (!root) return undefined;
  const content = readBoundedTextFile(join(root, `${shortHash(checkout)}.json`), 16 << 10);
  if (content === undefined) return undefined;
  const request = JudgeRequestSchema.parse(JSON.parse(content));
  return request.checkout === checkout ? request : undefined;
}

function restoreClaim(claim: string, target: string): boolean {
  try { linkSync(claim, target); unlinkSync(claim); return true; }
  catch { return false; } // A newer original wins; keep the claim for recovery.
}

/** Queue first. Claim afterwards so a crash can never remove the only intent. */
function consume(directory: string, name: string, expected: string): void {
  const original = join(directory, name), claim = `${original}.${randomUUID()}.claim`;
  renameSync(original, claim);
  // An atomic Go replacement between our read and rename may be a newer edit.
  if (readBoundedTextFile(claim, 16 << 10) === expected) unlinkSync(claim);
  else restoreClaim(claim, original);
}

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
  const names = new Set<string>(), claims: Array<{ claim: string; name: string }> = [];
  const handle = opendirSync(directory);
  try {
    let file, visited = 0;
    while ((file = handle.readSync())) {
      if (++visited > 10_000) break;
      if (!file.isFile()) continue;
      if (/^[a-f0-9]{24}\.json$/u.test(file.name)) names.add(file.name);
      const claimed = /^([a-f0-9]{24}\.json)\.[a-f0-9-]{36}\.claim$/u.exec(file.name);
      if (claimed) claims.push({ claim: file.name, name: claimed[1]! });
    }
  } finally { handle.closeSync(); }
  // A process killed after rename leaves a recoverable claim. Never replace a
  // newer hook request, and bound recovery independently from normal dispatch.
  claims.sort((a, b) => a.claim.localeCompare(b.claim));
  const claimAfter = writer.setting("judge", "claims.after") ?? "";
  const recovering = [...claims.filter(c => c.claim > claimAfter), ...claims.filter(c => c.claim <= claimAfter)].slice(0, 32);
  for (const item of recovering) {
    if (restoreClaim(join(directory, item.claim), join(directory, item.name))) names.add(item.name);
  }
  if (recovering.length) writer.db.prepare("INSERT INTO settings VALUES('judge','claims.after',?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(recovering.at(-1)!.claim);
  const sorted = [...names].sort();
  const after = writer.setting("judge", "requests.after") ?? "";
  const ordered = [...sorted.filter(n => n > after), ...sorted.filter(n => n <= after)].slice(0, 32);
  for (const name of ordered) {
    const path = join(directory, name);
    try {
      const content = readBoundedTextFile(path, 16 << 10);
      const request = JudgeRequestSchema.parse(JSON.parse(content ?? ""));
      if (name !== `${shortHash(request.checkout)}.json`) continue;
      const checkout = writer.db.prepare("SELECT project_id,state,off_until FROM checkouts WHERE path=?").get(request.checkout) as { project_id: string; state: string; off_until: string | null } | undefined;
      if (!checkout || checkout.project_id !== request.project_id) continue;
      if (checkout.state === "off" || (checkout.state === "off until" && Date.parse(checkout.off_until ?? "") > now)
        || !automaticWorkEnabled(writer, request.project_id, now) || request.not_before > now
        || !sessionWorkEnabled(writer, request.agent === "claude-code" ? "claude" : "codex", request.session_id)) continue;
      const params: JudgeParams = { checkout: request.checkout, agent: request.agent === "claude-code" ? "claude" : "codex", near: request.near,
        generation: request.generation, ...(request.session_id ? { sessionId: request.session_id } : {}) };
      const result = queue(writer, { kind: "judge", projectId: request.project_id, params });
      if (!result.existing) queued++;
      const accepted = JSON.parse(result.job.params) as JudgeParams;
      // A crash after enqueue replays the same generation; a later generation
      // (or another worktree) stays pending behind the unfinished project job.
      if (!result.existing || (accepted.checkout === request.checkout && accepted.generation === request.generation)) consume(directory, name, content!);
    } catch { /* incomplete/unsafe requests remain for a later bounded pass */ }
  }
  if (ordered.length) writer.db.prepare("INSERT INTO settings VALUES('judge','requests.after',?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(ordered.at(-1)!);
  try { rmdirSync(directory); } catch { /* pending requests or a concurrent hook */ }
  return queued;
}
