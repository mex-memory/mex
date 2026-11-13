import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../version.js";
import { openRecord, type RecordWriter } from "./index.js";
import { recordLocation, type LocationOptions } from "./location.js";
import { enqueueJob, hasPendingWork, ownerId, processAlive, recoverInterruptedJobs, requeueReadyJobs, runOneBatch, type EnqueueOptions, type EnqueueResult } from "./jobs.js";
import "./job-kinds.js";
import { indexPending, queuePendingRefreshes } from "../file-index/pending.js";

/**
 * The background process: started on demand, one per user, runs jobs batch by batch.
 * It talks to everything else only through record.db (job rows, requests, the lease);
 * it opens no network listener. Hooks never wait on it, and everything works without it:
 * pending work runs in the foreground (`mex jobs run`) or at the next start.
 */

export const BACKGROUND_DEFAULTS = {
  idleMs: 15 * 60_000,
  memoryMb: 1024,
  /** A lease whose heartbeat is older than this is taken over. */
  leaseMs: 15_000,
  heartbeatMs: 3_000,
  pollMs: 1_000,
  /** How long a new process waits for an old one to hand over. */
  takeoverMs: 30_000,
} as const;
export const LOG_LIMIT_BYTES = 1024 * 1024;

export interface BackgroundSettings {
  idleMs: number; memoryMb: number; leaseMs: number; heartbeatMs: number; pollMs: number; takeoverMs: number;
}
interface LeaseRow { owner: string | null; pid: number | null; version: string | null; started_at: string | null; heartbeat_at: string | null; request: "exit" | null; hub_until: string | null; }

function envNumber(name: string): number | undefined {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}
function setting(writer: RecordWriter, key: string): string | undefined { return writer.setting("background", key); }

/** Settings live in record.db (scope `background`); MEX_BACKGROUND_* variables override them for tests. */
export function backgroundSettings(writer?: RecordWriter): BackgroundSettings {
  const minutes = writer ? Number(setting(writer, "idle_minutes")) : NaN;
  const memory = writer ? Number(setting(writer, "memory_mb")) : NaN;
  return {
    idleMs: envNumber("MEX_BACKGROUND_IDLE_MS") ?? (minutes > 0 ? minutes * 60_000 : BACKGROUND_DEFAULTS.idleMs),
    memoryMb: envNumber("MEX_BACKGROUND_MEMORY_MB") ?? (memory > 0 ? memory : BACKGROUND_DEFAULTS.memoryMb),
    leaseMs: envNumber("MEX_BACKGROUND_LEASE_MS") ?? BACKGROUND_DEFAULTS.leaseMs,
    heartbeatMs: envNumber("MEX_BACKGROUND_HEARTBEAT_MS") ?? BACKGROUND_DEFAULTS.heartbeatMs,
    pollMs: envNumber("MEX_BACKGROUND_POLL_MS") ?? BACKGROUND_DEFAULTS.pollMs,
    takeoverMs: envNumber("MEX_BACKGROUND_TAKEOVER_MS") ?? BACKGROUND_DEFAULTS.takeoverMs,
  };
}

/** Off when MEX_BACKGROUND=0 or the `background.enabled` setting is "false". */
export function backgroundEnabled(writer?: RecordWriter): boolean {
  if (process.env.MEX_BACKGROUND === "0") return false;
  return !writer || setting(writer, "enabled") !== "false";
}
/** True inside MEX's own background process (and the agent runs it starts): never trigger MEX from there. */
export function insideBackground(): boolean { return process.env.MEX_BACKGROUND === "1"; }

function lease(writer: RecordWriter): LeaseRow {
  return writer.db.prepare("SELECT owner,pid,version,started_at,heartbeat_at,request,hub_until FROM background WHERE id=1").get() as unknown as LeaseRow;
}
export function leaseLive(row: LeaseRow, settings: Pick<BackgroundSettings, "leaseMs">, at = Date.now(), alive = processAlive): boolean {
  if (!row.owner || !row.heartbeat_at) return false;
  if (row.pid && !alive(row.pid)) return false;
  return at - Date.parse(row.heartbeat_at) < settings.leaseMs;
}

export interface BackgroundStatus { running: boolean; pid?: number; version?: string; startedAt?: string; enabled: boolean; }
export function backgroundStatus(writer: RecordWriter): BackgroundStatus {
  const row = lease(writer);
  const running = leaseLive(row, backgroundSettings(writer));
  return { running, enabled: backgroundEnabled(writer), ...(running ? { pid: row.pid ?? undefined, version: row.version ?? undefined, startedAt: row.started_at ?? undefined } : {}) };
}

// ── The marker the CLI checks cheaply ──

/** A file next to the record that says "jobs are waiting", so any `mex` command can restart the process without opening the database. */
export function pendingMarker(options: LocationOptions = {}): string {
  return join(recordLocation({ ...options, create: false }).home, "jobs-pending");
}
export function markPending(writer: RecordWriter): void {
  try { writeFileSync(join(writer.location.home, "jobs-pending"), ""); } catch { /* best effort */ }
}
function clearPending(writer: RecordWriter): void {
  try { unlinkSync(join(writer.location.home, "jobs-pending")); } catch { /* already gone */ }
}

/** Queue a job and leave the marker, so the next `mex` command or session start runs it. */
export function queueJob(writer: RecordWriter, options: EnqueueOptions): EnqueueResult {
  const result = enqueueJob(writer, options);
  markPending(writer);
  return result;
}

// ── Starting it ──

export interface EnsureOptions extends LocationOptions {
  /** The script to run with `__background`; defaults to the running CLI. */
  entry?: string;
  /** Extra arguments after the entry (the CLI passes `__background`). */
  args?: string[];
  /** Start even with no pending work (demos and tests). */
  force?: boolean;
  env?: NodeJS.ProcessEnv;
}
export type EnsureResult =
  | { started: true; pid: number; replacing?: string }
  | { started: false; reason: "inside-background" | "disabled" | "running" | "starting" | "no-work" | "no-entry" | "failed" };
/** A process spawned less than this long ago counts as starting. */
const STARTING_MS = 10_000;

/**
 * Make sure the background process runs when work is waiting. Returns at once and never
 * waits for the process; safe to call from any command or a session start.
 */
export function ensureBackground(options: EnsureOptions = {}): EnsureResult {
  if (insideBackground()) return { started: false, reason: "inside-background" };
  let writer: RecordWriter | undefined;
  try {
    writer = openRecord(options);
    if (!backgroundEnabled(writer)) return { started: false, reason: "disabled" };
    const settings = backgroundSettings(writer);
    const row = lease(writer);
    const live = leaseLive(row, settings);
    if (live && row.version === VERSION) return { started: false, reason: "running" };
    if (!options.force && !hasPendingWork({ all: (sql, ...args) => writer!.db.prepare(sql).all(...args) as never }) && !indexPending(writer.location.directory)) {
      clearPending(writer);
      return { started: false, reason: "no-work" };
    }
    // Another command started one moments ago and it hasn't taken the lease yet.
    const spawned = writer.db.prepare("SELECT spawned_at FROM background WHERE id=1").get() as { spawned_at: string | null };
    if (!live && spawned.spawned_at && Date.now() - Date.parse(spawned.spawned_at) < STARTING_MS) return { started: false, reason: "starting" };
    let replacing: string | undefined;
    if (live) {
      // Version handshake: ask the old process to finish its batch and hand over.
      writer.db.prepare("UPDATE background SET request='exit' WHERE id=1 AND owner=?").run(row.owner);
      replacing = row.version ?? "unknown";
    }
    const entry = options.entry ?? process.argv[1];
    if (!entry) return { started: false, reason: "no-entry" };
    const log = openLog(writer.location.home);
    try {
      const child = spawn(process.execPath, [`--max-old-space-size=${settings.memoryMb}`, entry, ...(options.args ?? ["__background"])], {
        detached: true, windowsHide: true, stdio: ["ignore", log, log],
        env: { ...(options.env ?? process.env), MEX_BACKGROUND: "1", ...(options.home ? { MEX_RECORD_HOME: options.home } : {}) },
      });
      child.on("error", () => { /* reported through the lease never appearing */ });
      child.unref();
      if (!child.pid) return { started: false, reason: "failed" };
      writer.db.prepare("UPDATE background SET spawned_at=? WHERE id=1").run(new Date().toISOString());
      return { started: true, pid: child.pid, ...(replacing ? { replacing } : {}) };
    } finally { closeSync(log); }
  } catch {
    return { started: false, reason: "failed" };
  } finally { try { writer?.close(); } catch { /* observation only */ } }
}

function openLog(home: string): number {
  const file = join(home, "background.log");
  try { if (statSync(file).size > LOG_LIMIT_BYTES) renameSync(file, `${file}.1`); } catch { /* new log */ }
  return openSync(file, "a");
}
function log(message: string): void {
  try { process.stdout.write(`${new Date().toISOString()} ${message}\n`); } catch { /* log is best effort */ }
}

// ── Running it ──

export interface RunOptions extends LocationOptions {
  settings?: Partial<BackgroundSettings>;
  /** Test seam for the memory reading, in bytes. */
  memory?: () => number;
  clock?: () => number;
}
export type ExitReason = "lease-held" | "handover" | "idle" | "memory" | "lease-lost" | "error";

/** The background process's main loop. Resolves with why it stopped. */
export async function runBackground(options: RunOptions = {}): Promise<ExitReason> {
  const home = options.home ?? process.env.MEX_RECORD_HOME;
  const writer = openRecord({ ...options, ...(home ? { home } : {}) });
  const settings = { ...backgroundSettings(writer), ...options.settings };
  const clock = options.clock ?? Date.now;
  const memory = options.memory ?? (() => process.memoryUsage().rss);
  const self = ownerId("background");
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let heartbeat: NodeJS.Timeout | undefined;
  let held = false;
  const stamp = () => new Date(clock()).toISOString();

  /** true: acquired; false: an older version is handing over, keep trying; "duplicate": a same-version process already runs. */
  const tryAcquire = (): boolean | "duplicate" => {
    writer.db.exec("BEGIN IMMEDIATE");
    try {
      const row = lease(writer);
      if (leaseLive(row, settings, clock()) && row.owner !== self) {
        writer.db.exec("COMMIT");
        return row.version === VERSION && row.request !== "exit" ? "duplicate" : false;
      }
      writer.db.prepare("UPDATE background SET owner=?,pid=?,version=?,started_at=?,heartbeat_at=?,request=NULL,spawned_at=NULL WHERE id=1")
        .run(self, process.pid, VERSION, stamp(), stamp());
      writer.db.exec("COMMIT");
      return true;
    } catch (error) { try { writer.db.exec("ROLLBACK"); } catch { /* closed */ } throw error; }
  };
  const beat = (): boolean => {
    const changed = writer.db.prepare("UPDATE background SET heartbeat_at=? WHERE id=1 AND owner=?").run(stamp(), self).changes;
    return Number(changed) === 1;
  };
  const release = () => {
    if (heartbeat) clearInterval(heartbeat);
    if (held) {
      try { writer.db.prepare("UPDATE background SET owner=NULL,pid=NULL,heartbeat_at=NULL,request=NULL WHERE id=1 AND owner=?").run(self); } catch { /* lease expires */ }
      held = false;
    }
  };
  const stop = (reason: ExitReason): ExitReason => {
    log(`stopping: ${reason}`);
    release();
    try { writer.close(); } catch { /* closing */ }
    return reason;
  };

  try {
    const deadline = clock() + settings.takeoverMs;
    for (let acquired = tryAcquire(); acquired !== true; acquired = tryAcquire()) {
      if (acquired === "duplicate" || clock() >= deadline) return stop("lease-held");
      await sleep(Math.min(250, settings.pollMs));
    }
    held = true;
    log(`started pid ${process.pid}, version ${VERSION}`);
    heartbeat = setInterval(() => { try { if (!beat()) held = false; } catch { /* next beat */ } }, settings.heartbeatMs);
    heartbeat.unref();
    const recovered = recoverInterruptedJobs(writer, self);
    if (recovered) log(`resumed ${recovered} interrupted job${recovered === 1 ? "" : "s"}`);
    let lastWork = clock();
    for (;;) {
      if (!held || !beat()) return stop("lease-lost");
      const row = lease(writer);
      if (row.request === "exit") return stop("handover");
      if (memory() > settings.memoryMb * 1024 * 1024) return stop("memory");
      requeueReadyJobs(writer);
      // Files the hook saw edited get re-parsed.
      queuePendingRefreshes(writer);
      const outcome = await runOneBatch(writer, self);
      if (outcome === "ran") { lastWork = clock(); continue; }
      const hubOpen = row.hub_until !== null && Date.parse(row.hub_until) > clock();
      const pending = hasPendingWork({ all: (sql, ...args) => writer.db.prepare(sql).all(...args) as never });
      if (!pending && !hubOpen) {
        clearPending(writer);
        if (clock() - lastWork >= settings.idleMs) return stop("idle");
      } else if (hubOpen) lastWork = clock();
      await sleep(settings.pollMs);
    }
  } catch (error) {
    log(`error: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    return stop("error");
  }
}

/** The seam for the Hub (a later ticket): an open Hub tab keeps the process alive until `untilMs`. */
export function noteHubActivity(writer: RecordWriter, untilMs: number): void {
  writer.db.prepare("UPDATE background SET hub_until=? WHERE id=1").run(new Date(untilMs).toISOString());
}

/**
 * Without the background process: run pending batches in this process until nothing can
 * run or the time budget is spent. Used by `mex jobs run` and when the process can't start.
 */
export async function runPendingInForeground(writer: RecordWriter, budgetMs = 60_000, onBatch?: () => void): Promise<number> {
  const self = ownerId("foreground");
  recoverInterruptedJobs(writer, self);
  const end = Date.now() + budgetMs;
  let batches = 0;
  while (Date.now() < end) {
    requeueReadyJobs(writer);
    if (await runOneBatch(writer, self) === "idle") break;
    batches++;
    onBatch?.();
  }
  return batches;
}

/** The marker check the CLI runs after a command: no database open unless the marker exists. */
export function restartIfPending(options: EnsureOptions = {}): EnsureResult | undefined {
  if (insideBackground()) return undefined;
  try { if (!existsSync(pendingMarker(options))) return undefined; } catch { return undefined; }
  return ensureBackground(options);
}
