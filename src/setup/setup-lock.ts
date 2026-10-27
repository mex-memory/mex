import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { SetupError } from "./errors.js";

/** Checkout-local, inside the directory setup's ignore protection keeps out of Git. */
export const SETUP_LOCK_FILE = "local/setup.lock";

/** Serializes reclaiming an abandoned lock. */
const RECLAIM_GATE_FILE = "setup.lock.reclaim";

/**
 * How long an unreadable lock may be a lock still being written by its owner,
 * and how long a reclaim gate may exist before it is a crash leftover (it is
 * normally held for milliseconds).
 */
const UNREADABLE_LOCK_GRACE_MS = 10_000;

interface SetupLockOwner {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly startedAt: string;
  /** The .mex directory the lock was taken for; a lock file copied from another clone is not this one's. */
  readonly root?: string;
}

export interface SetupLock {
  release(): void;
}

interface ActiveSetup {
  readonly mexDir: string;
  released: boolean;
}

const activeSetup = new AsyncLocalStorage<ActiveSetup>();
const contexts = new WeakMap<SetupLock, ActiveSetup>();

/** A queue call may prepare through the shared engine while keeping its lease. */
export async function withSetupLock<T>(mexDir: string, run: () => Promise<T>): Promise<T> {
  const root = resolve(mexDir);
  const active = activeSetup.getStore();
  // A continuation inherited from a run that already released does not hold the lock.
  if (active?.mexDir === root && !active.released) return run();
  const lock = acquireSetupLock(root);
  try { return await activeSetup.run(contexts.get(lock)!, run); }
  finally { lock.release(); }
}

/**
 * Refuse at once, changing nothing, when a live setup holds this checkout. For
 * the entry of a flow, before a tool picker or a browser listener.
 */
export function assertSetupAvailable(mexDir: string, now: () => Date = () => new Date()): void {
  const path = resolve(mexDir, SETUP_LOCK_FILE);
  try { lstatSync(path); } catch { return; }
  const existing = readOwner(path);
  if (!isAbandoned(path, existing, now())) throw busy(existing);
}

/**
 * Hold this checkout's setup for one run (#310).
 *
 * Without it two setups (a terminal and a Hub, two terminals) ran side by side:
 * both placed and stamped the scaffold, and when the graph was current both
 * launched a population agent over the same files. The graph's maintenance
 * lease stopped the second run only when a build happened to be in progress.
 *
 * The lock is a file created exclusively. A lock whose owner is gone — same
 * host, process no longer running or a different process now using its pid —
 * is reclaimed, so a crashed or killed run never blocks the next one. A lock
 * from another host is never reclaimed: its process cannot be checked from
 * here, and the message says how to clear it.
 */
export function acquireSetupLock(mexDir: string, now: () => Date = () => new Date()): SetupLock {
  assertRegularDirectory(mexDir);
  const localDir = resolve(mexDir, "local");
  assertRegularDirectory(localDir);
  mkdirSync(localDir, { recursive: true });
  assertRegularDirectory(mexDir);
  assertRegularDirectory(localDir);
  const path = resolve(mexDir, SETUP_LOCK_FILE);
  const owner: SetupLockOwner = {
    pid: process.pid, host: hostname(), token: randomUUID(), startedAt: now().toISOString(), root: resolve(mexDir),
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let fd: number | null = null;
    try {
      const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
      fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
      writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      const context: ActiveSetup = { mexDir: resolve(mexDir), released: false };
      const lock: SetupLock = { release: () => { context.released = true; releaseSetupLock(path, owner.token); } };
      contexts.set(lock, context);
      return lock;
    } catch (error) {
      if (fd !== null) closeSync(fd);
      if (errorCode(error) !== "EEXIST") throw error;
      const existing = readOwner(path);
      if (attempt < 2 && isAbandoned(path, existing, now()) && reclaim(path, now)) continue;
      throw busy(existing);
    }
  }
  throw busy(readOwner(path));
}

function releaseSetupLock(path: string, token: string): void {
  // Only our own lock: never remove one a later run took after reclaiming.
  if (readOwner(path)?.token !== token) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone; a later run reclaims a leftover the same way.
  }
}

function isAbandoned(path: string, owner: SetupLockOwner | null, now: Date): boolean {
  if (owner === null) {
    // A run that has just created its lock may not have written it yet.
    try {
      return now.getTime() - lstatSync(path).mtimeMs > UNREADABLE_LOCK_GRACE_MS;
    } catch {
      return true;
    }
  }
  if (owner.root !== undefined && owner.root !== dirname(dirname(path))) return true;
  if (owner.host !== hostname()) return false;
  if (!processRunning(owner.pid)) return true;
  // A live pid that started after the lock was written is a reused pid, not the owner.
  const started = processStartedAt(owner.pid);
  return started !== null && Date.parse(started) > Date.parse(owner.startedAt) + 1000;
}

/** The start time of a running process, or null when it cannot be read. Only asked when a lock is contested. */
function processStartedAt(pid: number): string | null {
  try {
    const out = process.platform === "win32"
      ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
      { encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
      : execFileSync("ps", ["-p", String(pid), "-o", "lstart="],
        { encoding: "utf8", timeout: 5000, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } });
    const date = new Date(out.trim());
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * Remove an abandoned lock. Reclaimers take a gate and look again under it, so
 * one holding an old verdict cannot delete the live lock that a faster
 * reclaimer's successor created. Creators never delete, so nothing else can
 * interleave. Returns false when the lock is not (or no longer) abandoned or
 * another reclaimer is working.
 */
function reclaim(path: string, now: () => Date): boolean {
  const gate = resolve(dirname(path), RECLAIM_GATE_FILE);
  let fd: number;
  try {
    fd = openSync(gate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    try {
      if (now().getTime() - lstatSync(gate).mtimeMs > UNREADABLE_LOCK_GRACE_MS) unlinkSync(gate);
    } catch {
      // Another reclaimer finished.
    }
    return false;
  }
  try {
    closeSync(fd);
    if (!isAbandoned(path, readOwner(path), now())) return false;
    try { unlinkSync(path); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    return true;
  } finally {
    try { unlinkSync(gate); } catch { /* already gone */ }
  }
}

function busy(owner: SetupLockOwner | null): SetupError {
  const where = owner === null ? "" : owner.host === hostname()
    ? ` (process ${owner.pid}, started ${owner.startedAt})`
    : ` on ${owner.host} (process ${owner.pid}, started ${owner.startedAt})`;
  const clear = owner !== null && owner.host !== hostname()
    ? ` If no setup is running there, delete .mex/${SETUP_LOCK_FILE}.`
    : "";
  return new SetupError(
    `Another MEX setup is already running in this checkout${where}. Wait for it to finish or stop it, then rerun setup.${clear}`,
  );
}

function readOwner(path: string): SetupLockOwner | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_096) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { pid, host, token, startedAt, root } = parsed as Record<string, unknown>;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || typeof host !== "string" || typeof token !== "string"
      || typeof startedAt !== "string") return null;
    return { pid: pid as number, host, token, startedAt, ...(typeof root === "string" ? { root } : {}) };
  } catch {
    return null;
  }
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and belongs to someone else.
    return errorCode(error) === "EPERM";
  }
}

function assertRegularDirectory(path: string): void {
  let stats: ReturnType<typeof lstatSync> | undefined;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SetupError(".mex/local must be a regular directory. Replace it, then rerun setup.");
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}
