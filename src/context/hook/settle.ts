/**
 * The settle worker: what happens to the graph and the Wiki after a session.
 *
 * The Stop hook starts it detached, so the agent is not kept waiting. It
 * takes a lock (a second Stop while it runs leaves an "again" marker, and the
 * worker loops once more instead of running two at a time), then:
 *
 *   1. works out which touched entities are vouched for (see `review.ts`);
 *   2. runs one `mex graph refresh`;
 *   3. re-records the vouched-for entities with ONE batch `mex wiki reground`;
 *   4. leaves every other touched entity flagged "changed, re-check";
 *   5. rebuilds the context index and logs what it did.
 *
 * It never decides that code still matches a fact: only prose the agent
 * edited, or `mex context confirm`, does that.
 */

import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { readRefreshWork, type RefreshWorkSummary } from "../../graph/refresh-work.js";
import { mutateFlags } from "../flags.js";
import { proseHash } from "./base.js";
import { openGraphReader } from "../graph-reader.js";
import { ensureContextIndex } from "../index-store.js";
import { removeLocalFile, writeTextAtomic, writeTextExclusive } from "../local-state.js";
import { resolveContextRoot, type ContextRoot } from "../root.js";
import { recordReview, reviewSession, type Review } from "../review.js";
import { appendLog, describeError } from "./run.js";

export const SETTLE_LOCK_NAME = "context-settle.lock";
export const SETTLE_AGAIN_NAME = "context-settle.again";
/** Windows sometimes fails to start a child in a console-less process with STATUS_DLL_INIT_FAILED. */
const DLL_INIT_FAILED = 0xc0000142;
/** The most ids one `wiki reground` call receives; the rest go in the next call. */
export const REGROUND_BATCH = 80;
const REFRESH_TIMEOUT_MS = 30 * 60 * 1000;
const REGROUND_TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_TAIL = 1500;
const MAX_LOOPS = 4;

const lockPathOf = (localDir: string): string => join(localDir, SETTLE_LOCK_NAME);
const againPathOf = (localDir: string): string => join(localDir, SETTLE_AGAIN_NAME);

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and is not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether a settle worker holds the lock right now. */
export function settleRunning(localDir: string): boolean {
  try {
    return pidAlive(Number(readFileSync(lockPathOf(localDir), "utf8").trim()));
  } catch {
    return false;
  }
}

export type SettleStart = "started" | "queued" | "failed";

export interface StartOptions {
  /** The script the worker runs (`dist/hook.js`); defaults to this bundle's entry. */
  entry?: string;
  /** Extra environment for the worker (tests). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Start the settle worker, or tell the running one to go round again.
 *
 * The lock is created exclusively and holds the pid of whoever owns it. A lock
 * whose pid is gone (a crashed worker) is taken over.
 */
export async function startSettle(root: ContextRoot, sessionId: string | null, options: StartOptions = {}): Promise<SettleStart> {
  const lock = lockPathOf(root.localDir);
  if (!writeTextExclusive(root.localDir, lock, `${process.pid}\n`)) {
    if (settleRunning(root.localDir)) {
      writeTextAtomic(root.localDir, againPathOf(root.localDir), `${new Date().toISOString()}\n`);
      return "queued";
    }
    removeLocalFile(root.localDir, lock);
    if (!writeTextExclusive(root.localDir, lock, `${process.pid}\n`)) {
      writeTextAtomic(root.localDir, againPathOf(root.localDir), `${new Date().toISOString()}\n`);
      return "queued";
    }
  }
  const entry = options.entry ?? process.argv[1] ?? "";
  const args = [entry, "settle", "--project", root.projectRoot, ...(sessionId === null ? [] : ["--session", sessionId])];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = await spawnDetached(args, root.projectRoot, options.env);
    if (outcome.kind === "running") {
      // The worker writes its own pid over this one as soon as it starts.
      if (outcome.pid !== undefined) writeTextAtomic(root.localDir, lock, `${outcome.pid}\n`);
      return "started";
    }
    if (outcome.kind === "exited") {
      // A worker that finished within the wait has already released the lock.
      removeLocalFile(root.localDir, lock);
      return "started";
    }
    if (outcome.kind === "dll-init") continue;
    break;
  }
  removeLocalFile(root.localDir, lock);
  return "failed";
}

type SpawnOutcome = { kind: "running"; pid: number | undefined } | { kind: "exited" } | { kind: "dll-init" } | { kind: "failed" };

/** Start the child, wait a moment to see it did not die at once, then let go of it. */
function spawnDetached(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv | undefined): Promise<SpawnOutcome> {
  return new Promise((resolveSpawn) => {
    let settled = false;
    const done = (outcome: SpawnOutcome): void => {
      if (settled) return;
      settled = true;
      resolveSpawn(outcome);
    };
    try {
      const child = spawn(process.execPath, [...args], {
        cwd,
        env: { ...process.env, ...env },
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", () => done({ kind: "failed" }));
      child.once("exit", (code) => done(code === DLL_INIT_FAILED ? { kind: "dll-init" } : code === 0 ? { kind: "exited" } : { kind: "failed" }));
      setTimeout(() => {
        if (settled) return;
        child.unref();
        done({ kind: "running", pid: child.pid });
      }, 300).unref();
    } catch {
      done({ kind: "failed" });
    }
  });
}

// ---------------------------------------------------------------------------
// Running mex
// ---------------------------------------------------------------------------

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Run one `mex` command to completion. */
export type CliRunner = (args: readonly string[], timeoutMs: number) => CliResult;

/** The CLI bundle next to this hook bundle, or null when it is not there. */
export function findCliEntry(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, "cli.js"), join(here, "..", "cli.js"), join(here, "..", "..", "dist", "cli.js")].find((path) => existsSync(path)) ?? null;
}

export function defaultCliRunner(projectRoot: string): CliRunner {
  const entry = process.env["MEX_CLI"] ?? findCliEntry();
  return (args, timeoutMs) => {
    const started = performance.now();
    let result: SpawnSyncReturns<string> | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      result = entry === null
        ? spawnSync("mex", [...args], { cwd: projectRoot, encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" })
        : spawnSync(process.execPath, [entry, ...args], { cwd: projectRoot, encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
      // The child never ran when it died of 0xC0000142, so running it again is safe.
      if (result.status !== DLL_INIT_FAILED) break;
    }
    return {
      code: result?.status ?? null,
      stdout: result?.stdout ?? "",
      stderr: `${result?.stderr ?? ""}${result?.error ? `\n${result.error.message}` : ""}`,
      ms: Math.round(performance.now() - started),
    };
  };
}

const tail = (text: string): string => text.trim().slice(-STDERR_TAIL);

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

export interface SettleOptions {
  sessionId: string | null;
  runCli?: CliRunner;
  now?: () => Date;
}

export interface SettlePass {
  touched: number;
  eligible: number;
  flagged: number;
  /** `mode`, `reason`, `changed` and `reextracted` say how the graph refresh worked, when it said. */
  refresh: ({ code: number | null; ms: number } & Partial<RefreshWorkSummary>) | null;
  /** `refused` names each id the reground did not re-record, with the first reason it gave. */
  reground: { ids: number; ok: number; failed: number; ms: number; refused?: Array<{ id: string; error: string }> } | null;
  skipped?: string;
  timings?: { reviewMs: number; indexMs: number; totalMs: number };
}

interface RegroundOutcome {
  id: string;
  ok: boolean;
  error?: string;
}

/** Read the per-id outcome out of `wiki reground --json`, for one id or a batch. */
export function parseRegroundOutput(stdout: string, requested: readonly string[]): RegroundOutcome[] {
  try {
    const envelope = JSON.parse(stdout) as { data?: Record<string, unknown>; diagnostics?: Array<{ message?: string }> };
    const data = envelope.data ?? {};
    const entities = data["entities"];
    if (Array.isArray(entities)) {
      return (entities as Array<{ entityId?: string; ok?: boolean; diagnostics?: Array<{ message?: string }> }>).map((entry) => ({
        id: String(entry.entityId),
        ok: entry.ok === true,
        ...(entry.ok === true ? {} : { error: entry.diagnostics?.[0]?.message ?? "refused" }),
      }));
    }
    const applied = (data["apply"] as { applied?: boolean } | null | undefined)?.applied === true;
    return [{ id: String(data["entityId"] ?? requested[0]), ok: applied, ...(applied ? {} : { error: envelope.diagnostics?.[0]?.message ?? "refused" }) }];
  } catch {
    return requested.map((id) => ({ id, ok: false, error: "unreadable reground output" }));
  }
}

async function freshReview(root: ContextRoot, sessionId: string | null): Promise<Review | null> {
  const { index } = await ensureContextIndex(root, "if-stale");
  const { reader } = openGraphReader(root.scaffoldRoot);
  try {
    return reviewSession({ root, index, reader, sessionId });
  } finally {
    reader?.close();
  }
}

/** One pass: review, refresh, re-record the vouched-for entities, rebuild the index. */
export async function settleOnce(root: ContextRoot, options: SettleOptions): Promise<SettlePass> {
  const started = performance.now();
  const runCli = options.runCli ?? defaultCliRunner(root.projectRoot);
  const now = options.now ?? (() => new Date());
  const review = await freshReview(root, options.sessionId);
  const reviewMs = Math.round(performance.now() - started);
  if (review === null || (review.entries.length === 0 && !review.sourceDigest)) {
    return { touched: 0, eligible: 0, flagged: 0, refresh: null, reground: null, skipped: review === null ? "no-git" : "nothing-touched" };
  }
  // Flag first: from here on, packets show these entities as changed even though the graph is not refreshed yet.
  recordReview(root.localDir, review, now());
  const timings = { reviewMs, indexMs: 0, totalMs: 0 };
  const pass: SettlePass = { touched: review.entries.length, eligible: review.eligible.length, flagged: review.flagged.length, refresh: null, reground: null,
    timings };

  const refresh = runCli(["graph", "refresh", "--json"], REFRESH_TIMEOUT_MS);
  pass.refresh = { code: refresh.code, ms: refresh.ms, ...(refresh.code === 0 ? readRefreshWork(refresh.stdout) : null) };
  if (refresh.code !== 0) {
    appendLog(root, { event: "settle-refresh-failed", code: refresh.code, ms: refresh.ms, stderr: tail(refresh.stderr || refresh.stdout) });
    pass.skipped = "refresh-failed";
    timings.totalMs = Math.round(performance.now() - started);
    return pass;
  }

  if (review.eligible.length > 0) {
    const ids = review.eligible.map((entry) => entry.entity.id);
    const outcomes: RegroundOutcome[] = [];
    let ms = 0;
    for (let i = 0; i < ids.length; i += REGROUND_BATCH) {
      const chunk = ids.slice(i, i + REGROUND_BATCH);
      const result = runCli(["wiki", "reground", ...chunk, "--apply", "--json", "--reason", "Re-recorded after the session: the entity's prose was edited or confirmed with `mex context confirm`"], REGROUND_TIMEOUT_MS);
      ms += result.ms;
      const parsed = parseRegroundOutput(result.stdout, chunk);
      if (result.code !== 0 && parsed.every((entry) => entry.ok)) {
        // The command failed as a whole; trust the exit status over a half-readable result.
        parsed.forEach((entry) => {
          entry.ok = false;
          entry.error = tail(result.stderr) || "wiki reground failed";
        });
      }
      outcomes.push(...parsed);
    }
    const at = now().toISOString();
    const digestOf = new Map(review.eligible.map((entry) => [entry.entity.id, entry.digest]));
    const entryOf = new Map(review.eligible.map((entry) => [entry.entity.id, entry]));
    mutateFlags(root.localDir, (flags) => {
      for (const outcome of outcomes) {
        if (outcome.ok) {
          delete flags.entities[outcome.id];
          flags.reconciled[outcome.id] = digestOf.get(outcome.id) ?? at;
          // Current links again, so `check` sees no drift; the prose still awaits a review.
          const entry = entryOf.get(outcome.id);
          if (entry !== undefined) {
            flags.review[outcome.id] = {
              title: entry.entity.title, file: entry.entity.file, line: entry.entity.line, why: entry.why,
              basis: entry.basis ?? "confirmed", since: at, prose: proseHash(entry.entity),
            };
          }
        } else if (flags.entities[outcome.id] !== undefined) {
          flags.entities[outcome.id]!.error = (outcome.error ?? "refused").slice(0, 300);
        }
      }
    });
    const refused = outcomes.filter((o) => !o.ok).map((o) => ({ id: o.id, error: (o.error ?? "refused").slice(0, 300) }));
    pass.reground = { ids: ids.length, ok: outcomes.length - refused.length, failed: refused.length, ms, ...(refused.length ? { refused } : {}) };
  }

  // The index must describe the refreshed graph and the re-recorded links.
  const indexStarted = performance.now();
  await ensureContextIndex(root, "if-stale");
  timings.indexMs = Math.round(performance.now() - indexStarted);
  timings.totalMs = Math.round(performance.now() - started);
  return pass;
}

/** The detached worker's entry: hold the lock, settle, go round again if another Stop asked. */
export async function runSettleWorker(projectDir: string, options: SettleOptions): Promise<void> {
  const root = resolveContextRoot(projectDir);
  if (root === null) return;
  const lock = lockPathOf(root.localDir);
  writeTextAtomic(root.localDir, lock, `${process.pid}\n`);
  const started = performance.now();
  try {
    for (let loop = 0; loop < MAX_LOOPS; loop += 1) {
      removeLocalFile(root.localDir, againPathOf(root.localDir));
      try {
        const pass = await settleOnce(root, options);
        appendLog(root, { event: "settle", loop, ms: Math.round(performance.now() - started), ...pass });
      } catch (error) {
        appendLog(root, { event: "settle-error", loop, error: describeError(error) });
      }
      if (!existsSync(againPathOf(root.localDir))) break;
    }
  } finally {
    removeLocalFile(root.localDir, lock);
    removeLocalFile(root.localDir, againPathOf(root.localDir));
  }
}
