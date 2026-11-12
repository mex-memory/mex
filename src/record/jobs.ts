import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { JOB_STATES, type JobState, type RecordWriter, type RecordReader } from "./index.js";

/**
 * One job model for the whole machine, stored in record.db `jobs` / `job_results`.
 *
 * A job kind does its work in batches. The runner commits a batch's results, its
 * checkpoint, its cost and the job's next state in one transaction, so a process
 * killed at any point redoes at most the batch in flight and never leaves half a
 * batch recorded. Rules for job kinds:
 *  - `runBatch` returns what the batch produced and the next checkpoint; the runner
 *    writes it. A kind with `sideEffects: "idempotent"` may also change things
 *    outside the job rows (files, other tables), and must make each batch safe to
 *    run twice from the same checkpoint.
 *  - A batch that throws counts as a failure. The same cause three times in a row
 *    stops the job as failed, with the cause in plain words.
 *  - A batch can ask to wait (usage window, logged out, offline...) with one reason;
 *    `ready` says when the job can continue, and the runner requeues it by itself.
 */

export const TERMINAL_STATES: readonly JobState[] = ["done", "done with gaps", "failed", "cancelled"];

/** Every allowed transition, in one place. Anything else is refused. */
export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ["running", "paused", "cancelled"],
  running: ["queued", "done", "done with gaps", "failed", "waiting", "paused", "cancelled"],
  paused: ["queued", "cancelled"],
  waiting: ["queued", "paused", "cancelled"],
  failed: ["queued", "cancelled"],
  done: [],
  "done with gaps": [],
  cancelled: [],
};
export function canTransition(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from]?.includes(to) ?? false;
}

export const MAX_SAME_FAILURES = 3;

export interface JobRow {
  id: string; project_id: string | null; kind: string; state: JobState; reason: string | null;
  progress: string | null; checkpoint: string | null; tokens_used: number; tokens_estimate: number | null;
  created_at: string; updated_at: string; params: string; batch: number; results: number; failures: number;
  request: "pause" | "cancel" | null; owner: string | null; finished_at: string | null;
}

export interface BatchContext<P = unknown, C = unknown> {
  job: JobRow; params: P; checkpoint: C | undefined; writer: RecordWriter;
}
export interface BatchResult<C = unknown> {
  checkpoint: C;
  /** What this batch finished or skipped, kept in job_results. */
  summary?: string;
  /** Results added by this batch. */
  results?: number;
  /** Model tokens this batch spent. */
  tokens?: number;
  /** What the job is doing now, in plain words ("batch 3 of 10"). Shown only while it is active. */
  progress?: string;
  done?: boolean;
  /** Finished, but some parts couldn't be done. */
  gaps?: boolean;
  /** Stop and wait, with one reason in plain words. */
  wait?: string;
}
export interface JobKind<P = unknown, C = unknown> {
  name: string;
  /** Plain words for lists: "Usage refresh". */
  label: string;
  /** Project jobs run at most one at a time per project; machine jobs have no project. */
  scope: "project" | "machine";
  /** At most one running job of this kind on the machine (learning jobs). */
  machineExclusive?: boolean;
  sideEffects: "none" | "idempotent";
  runBatch(context: BatchContext<P, C>): Promise<BatchResult<C>> | BatchResult<C>;
  /** For a waiting job: true when it can continue. Default: continue on the next pass. */
  ready?(job: JobRow): boolean;
}

const kinds = new Map<string, JobKind<any, any>>();
export function registerJobKind<P, C>(kind: JobKind<P, C>): void { kinds.set(kind.name, kind as JobKind<any, any>); }
export function jobKind(name: string): JobKind | undefined { return kinds.get(name); }
export function registeredJobKinds(): string[] { return [...kinds.keys()]; }

function now(): string { return new Date().toISOString(); }
function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const value = work(); db.exec("COMMIT"); return value; }
  catch (error) { try { db.exec("ROLLBACK"); } catch { /* already closed */ } throw error; }
}
function getJob(db: DatabaseSync, id: string): JobRow | undefined {
  return db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as unknown as JobRow | undefined;
}

export class JobTransitionError extends Error {
  constructor(readonly from: JobState, readonly to: JobState) { super(`A ${from} job can't become ${to}.`); }
}
/** The only place a job's state changes. Must run inside a write transaction. */
function setState(db: DatabaseSync, job: JobRow, to: JobState, fields: Partial<JobRow> = {}): JobRow {
  if (job.state !== to && !canTransition(job.state, to)) throw new JobTransitionError(job.state, to);
  const next: JobRow = { ...job, ...fields, state: to, updated_at: now() };
  if (TERMINAL_STATES.includes(to)) { next.finished_at = next.updated_at; next.owner = null; next.request = null; }
  if (to === "queued" || to === "paused" || to === "waiting") next.owner = null;
  db.prepare(`UPDATE jobs SET state=?,reason=?,progress=?,checkpoint=?,tokens_used=?,tokens_estimate=?,updated_at=?,
    batch=?,results=?,failures=?,request=?,owner=?,finished_at=? WHERE id=?`).run(
    next.state, next.reason, next.progress, next.checkpoint, next.tokens_used, next.tokens_estimate, next.updated_at,
    next.batch, next.results, next.failures, next.request, next.owner, next.finished_at, next.id);
  return next;
}

export interface EnqueueOptions { kind: string; projectId?: string | null; params?: unknown; tokensEstimate?: number; }
export type EnqueueResult = { job: JobRow; existing: boolean };
/**
 * Queue a job. A project job whose kind already has an unfinished job for that project
 * returns that job instead of a second one ("Already running in another window").
 */
export function enqueueJob(writer: RecordWriter, options: EnqueueOptions): EnqueueResult {
  const kind = kinds.get(options.kind);
  if (!kind) throw new Error(`Unknown job kind: ${options.kind}`);
  const projectId = kind.scope === "project" ? options.projectId ?? null : null;
  if (kind.scope === "project" && !projectId) throw new Error(`${kind.label} needs a project.`);
  return inTransaction(writer.db, () => {
    const open = writer.db.prepare(`SELECT * FROM jobs WHERE kind=? AND project_id IS ? AND state NOT IN ('done','done with gaps','failed','cancelled')
      ORDER BY created_at LIMIT 1`).get(kind.name, projectId) as unknown as JobRow | undefined;
    if (open) return { job: open, existing: true };
    const ts = now();
    const id = randomUUID();
    writer.db.prepare(`INSERT INTO jobs(id,project_id,kind,state,progress,checkpoint,tokens_used,tokens_estimate,created_at,updated_at,params)
      VALUES(?,?,?,'queued',NULL,NULL,0,?,?,?,?)`).run(id, projectId, kind.name, options.tokensEstimate ?? null, ts, ts,
      JSON.stringify(options.params ?? {}));
    return { job: getJob(writer.db, id)!, existing: false };
  });
}

/** Pause, cancel or resume. A running job is asked, and stops after its current batch. */
export function requestJob(writer: RecordWriter, id: string, action: "pause" | "cancel" | "resume"): JobRow {
  return inTransaction(writer.db, () => {
    const job = getJob(writer.db, id);
    if (!job) throw new Error("That job no longer exists.");
    if (action === "resume") {
      if (job.state === "paused" || job.state === "waiting" || job.state === "failed") {
        // Resuming a failed job starts its failure count again; learned results and position stay.
        return setState(writer.db, job, "queued", { failures: 0, reason: null, request: null });
      }
      if (job.state === "running" && job.request === "pause") return setState(writer.db, job, "running", { request: null });
      throw new Error(`A ${job.state} job can't be resumed.`);
    }
    // A failed job can still be cancelled (or resumed); the others are final.
    if (job.state === "done" || job.state === "done with gaps" || job.state === "cancelled") throw new Error(`The job is already ${job.state}.`);
    if (job.state === "running") return setState(writer.db, job, "running", { request: action });
    if (action === "pause") return setState(writer.db, job, "paused");
    return setState(writer.db, job, "cancelled", { reason: null });
  });
}

/** Process ids in owner strings let recovery tell a dead runner from a live one. */
export function ownerId(role: "background" | "foreground", pid = process.pid): string {
  return `${role}:${pid}:${randomUUID().slice(0, 8)}`;
}
export function ownerPid(owner: string): number | undefined {
  const pid = Number(owner.split(":")[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * A job left running by a runner that died goes back to the queue. Its last committed
 * checkpoint is where it resumes, so at most the batch in flight is redone.
 */
export function recoverInterruptedJobs(writer: RecordWriter, self: string, alive: (pid: number) => boolean = processAlive): number {
  return inTransaction(writer.db, () => {
    const running = writer.db.prepare("SELECT * FROM jobs WHERE state='running'").all() as unknown as JobRow[];
    let recovered = 0;
    for (const job of running) {
      if (job.owner === self) continue;
      const pid = job.owner ? ownerPid(job.owner) : undefined;
      if (pid !== undefined && pid !== process.pid && alive(pid)) continue;
      if (job.request === "cancel") setState(writer.db, job, "cancelled", { reason: null });
      else if (job.request === "pause") setState(writer.db, job, "paused", { request: null });
      else setState(writer.db, job, "queued");
      recovered++;
    }
    return recovered;
  });
}

/** Waiting jobs whose condition cleared go back to the queue. */
export function requeueReadyJobs(writer: RecordWriter): number {
  const waiting = writer.db.prepare("SELECT * FROM jobs WHERE state='waiting'").all() as unknown as JobRow[];
  let moved = 0;
  for (const job of waiting) {
    const kind = kinds.get(job.kind);
    let ready = false;
    try { ready = kind ? (kind.ready ? kind.ready(job) : true) : false; } catch { ready = false; }
    if (!ready) continue;
    inTransaction(writer.db, () => {
      const current = getJob(writer.db, job.id);
      if (current?.state === "waiting") { setState(writer.db, current, "queued", { reason: null }); moved++; }
    });
  }
  return moved;
}

/**
 * Claim the next job this runner may run, honouring the concurrency rules: one running
 * job per project, and one running job per machine for machine-exclusive kinds.
 */
function claim(writer: RecordWriter, self: string): JobRow | undefined {
  return inTransaction(writer.db, () => {
    const queued = writer.db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY updated_at,created_at").all() as unknown as JobRow[];
    for (const job of queued) {
      const kind = kinds.get(job.kind);
      if (!kind) continue; // A kind from a newer MEX: leave it for that version.
      if (job.project_id) {
        const busy = writer.db.prepare("SELECT 1 FROM jobs WHERE state='running' AND project_id=? AND id!=?").get(job.project_id, job.id);
        if (busy) continue;
      }
      if (kind.machineExclusive) {
        const busy = writer.db.prepare("SELECT 1 FROM jobs WHERE state='running' AND kind=? AND id!=?").get(job.kind, job.id);
        if (busy) continue;
      }
      return setState(writer.db, job, "running", { owner: self });
    }
    return undefined;
  });
}

/** Why a queued job isn't running, in plain words, for callers that queue work. */
export function blockedReason(reader: Pick<RecordReader, "all">, job: JobRow): string | undefined {
  const kind = kinds.get(job.kind);
  if (job.project_id) {
    const other = reader.all<JobRow & { root_path: string | null }>(`SELECT jobs.*,projects.root_path FROM jobs LEFT JOIN projects ON projects.id=jobs.project_id
      WHERE jobs.state='running' AND jobs.project_id=? AND jobs.id!=? LIMIT 1`, job.project_id, job.id)[0];
    if (other) return `Waiting: ${kinds.get(other.kind)?.label ?? "another job"} is running in ${projectName(other.root_path)}`;
  }
  if (kind?.machineExclusive) {
    const other = reader.all<JobRow & { root_path: string | null }>(`SELECT jobs.*,projects.root_path FROM jobs LEFT JOIN projects ON projects.id=jobs.project_id
      WHERE jobs.state='running' AND jobs.kind=? AND jobs.id!=? LIMIT 1`, job.kind, job.id)[0];
    if (other) return `Waiting: ${kind.label.toLowerCase()} is running${other.root_path ? ` in ${projectName(other.root_path)}` : ""}`;
  }
  return undefined;
}

export type BatchOutcome = "ran" | "idle";
/**
 * Run one batch of one job. Returns "idle" when nothing could run. Never throws for a
 * job's own failure; storage errors propagate to the runner, which stops safely.
 */
export async function runOneBatch(writer: RecordWriter, self: string): Promise<BatchOutcome> {
  const job = claim(writer, self);
  if (!job) return "idle";
  const kind = kinds.get(job.kind)!;
  let result: BatchResult | undefined;
  let failure: string | undefined;
  try {
    result = await kind.runBatch({
      job, writer,
      params: JSON.parse(job.params || "{}"),
      checkpoint: job.checkpoint === null ? undefined : JSON.parse(job.checkpoint),
    });
  } catch (error) {
    failure = plainCause(error);
  }
  inTransaction(writer.db, () => {
    const current = getJob(writer.db, job.id);
    // Taken over while this batch ran (this runner was presumed dead): discard the batch.
    if (!current || current.owner !== self || current.state !== "running") return;
    if (failure !== undefined) {
      const failures = current.reason === failure ? current.failures + 1 : 1;
      if (failures >= MAX_SAME_FAILURES) setState(writer.db, current, "failed", { reason: failure, failures });
      else if (current.request === "cancel") setState(writer.db, current, "cancelled", { reason: null, failures });
      else if (current.request === "pause") setState(writer.db, current, "paused", { reason: failure, failures, request: null });
      else setState(writer.db, current, "queued", { reason: failure, failures });
      return;
    }
    const r = result!;
    if (r.wait && !r.done) {
      // Waiting isn't a batch: nothing is recorded and the position doesn't move.
      const waitFields: Partial<JobRow> = { checkpoint: JSON.stringify(r.checkpoint ?? null), progress: r.progress ?? current.progress, failures: 0 };
      if (current.request === "cancel") setState(writer.db, current, "cancelled", { ...waitFields, reason: null });
      else if (current.request === "pause") setState(writer.db, current, "paused", { ...waitFields, reason: null, request: null });
      else setState(writer.db, current, "waiting", { ...waitFields, reason: r.wait });
      return;
    }
    writer.db.prepare("INSERT INTO job_results(job_id,batch,summary) VALUES(?,?,?)").run(current.id, current.batch, r.summary ?? "");
    const fields: Partial<JobRow> = {
      checkpoint: JSON.stringify(r.checkpoint ?? null), batch: current.batch + 1,
      results: current.results + Math.max(0, Math.floor(r.results ?? 0)),
      tokens_used: current.tokens_used + Math.max(0, Math.floor(r.tokens ?? 0)),
      progress: r.progress ?? current.progress, failures: 0, reason: null,
    };
    if (r.done) setState(writer.db, current, r.gaps ? "done with gaps" : "done", { ...fields, progress: null });
    else if (current.request === "cancel") setState(writer.db, current, "cancelled", fields);
    else if (current.request === "pause") setState(writer.db, current, "paused", { ...fields, request: null });
    else setState(writer.db, current, "queued", fields);
  });
  return "ran";
}

/** Plain, single-line, bounded cause. Never a stack trace. */
export function plainCause(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split(/\r?\n/)[0]!.trim() || "The job stopped with an unknown error.";
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/** Work that a runner could do now or later: queued or waiting jobs of known kinds. */
export function hasPendingWork(reader: Pick<RecordReader, "all">): boolean {
  const rows = reader.all<{ kind: string }>("SELECT DISTINCT kind FROM jobs WHERE state IN ('queued','waiting','running')");
  return rows.some((row) => kinds.has(row.kind));
}

// ── Listing ──

export interface JobListItem {
  /** Position in the list, newest first: what `mex jobs pause 2` refers to. */
  position: number;
  kind: string; label: string; state: JobState;
  project: { name: string; path: string } | null;
  /** The waiting reason or the failure cause. */
  reason: string | null;
  /** What it's doing; only for queued, running, paused and waiting jobs. */
  doing: string | null;
  batches: number; results: number;
  tokens: { used: number; estimate: number | null };
  createdAt: string; updatedAt: string; finishedAt: string | null;
  /** Pause or cancel asked and not yet applied (the job stops after its current batch). */
  pending: "pause" | "cancel" | null;
}

export function projectName(path: string | null): string {
  if (!path) return "this machine";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function runnerGone(owner: string | null): boolean {
  const pid = owner ? ownerPid(owner) : undefined;
  return pid === undefined || (pid !== process.pid && !processAlive(pid));
}

export function listJobs(reader: Pick<RecordReader, "all">, limit = 50): Array<JobListItem & { id: string }> {
  const rows = reader.all<JobRow & { root_path: string | null }>(`SELECT jobs.*,projects.root_path FROM jobs
    LEFT JOIN projects ON projects.id=jobs.project_id ORDER BY jobs.created_at DESC, jobs.id DESC LIMIT ?`, limit);
  return rows.map((row, index) => {
    const kind = kinds.get(row.kind);
    const active = !TERMINAL_STATES.includes(row.state);
    return {
      id: row.id,
      position: index + 1,
      kind: row.kind,
      label: kind?.label ?? "Unknown job (needs a newer MEX)",
      state: row.state,
      project: row.project_id ? { name: projectName(row.root_path), path: row.root_path ?? "" } : null,
      reason: row.reason,
      doing: !active ? null : row.state === "running" && runnerGone(row.owner)
        ? "interrupted; resumes from its last batch when the background process starts again" : row.progress,
      batches: row.batch, results: row.results,
      tokens: { used: row.tokens_used, estimate: row.tokens_estimate },
      createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at,
      pending: row.state === "running" ? row.request : null,
    };
  });
}

function count(n: number): string { return n.toLocaleString("en-US"); }
export function describeJob(item: JobListItem): string {
  const where = item.project ? `${item.project.name} (${item.project.path})` : "this machine";
  const parts: string[] = [item.state];
  if (item.state === "waiting" && item.reason) parts[0] = `waiting: ${item.reason}`;
  if (item.state === "failed" && item.reason) parts[0] = `failed: ${item.reason}`;
  if (item.state === "queued" && item.reason) parts[0] = `queued (last try: ${item.reason})`;
  if (item.pending) parts.push(item.pending === "pause" ? "pausing after this batch" : "cancelling after this batch");
  if (item.doing?.startsWith("interrupted")) parts[0] = item.doing;
  else if (item.doing) parts.push(item.doing);
  const finished = TERMINAL_STATES.includes(item.state);
  parts.push(`${count(item.results)} result${item.results === 1 ? "" : "s"}${finished ? "" : " so far"}`);
  if (item.tokens.estimate) parts.push(`${count(item.tokens.used)} of about ${count(item.tokens.estimate)} tokens`);
  else if (item.tokens.used) parts.push(`${count(item.tokens.used)} tokens`);
  return `${String(item.position).padStart(2)}  ${item.label} · ${where}\n    ${parts.join(" · ")}`;
}

export { JOB_STATES };
