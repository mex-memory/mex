import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Opt-in per-phase wall-clock timing for graph maintenance.
 *
 * Disabled unless `MEX_GRAPH_PHASE_TIMINGS` is set to a truthy value. When
 * enabled, each flush appends one JSON line of accumulated phase totals to
 * the target file. Nothing is ever printed, and no path or source content
 * enters a record: phase names are fixed labels and values are milliseconds
 * or counts.
 *
 * The value selects the target file:
 * - `0`, `false`, `no`, or `off` keeps timing disabled. These used to be
 *   read as paths, so setting the flag to switch it off wrote to a file named
 *   after the value instead.
 * - `1`, `true`, `on`, or `yes` selects the default sink
 *   `.mex/local/graph-phase-timings.jsonl` under the project root:
 *   checkout-local and ignored by `.mex/.gitignore`, so the usual "turn the
 *   flag on" spelling cannot create a stray file in the repository, even
 *   when mex runs from a subdirectory with `--root`.
 * - anything else is taken verbatim as a path to append to; a relative path
 *   is relative to the directory the command was started in.
 */
const PHASE_TIMINGS_ENV = "MEX_GRAPH_PHASE_TIMINGS";
const DEFAULT_TIMINGS_FILE = join(".mex", "local", "graph-phase-timings.jsonl");

const totals = new Map<string, number>();
const memory: Array<{ phase: string; rss: number; heapUsed: number; external: number }> = [];

/** Bounded, opt-in worker memory samples; labels never contain source paths. */
export function recordGraphMemory(phase: string): void {
  if (!phaseTimingsEnabled() || memory.length >= 1024) return;
  const { rss, heapUsed, external } = process.memoryUsage();
  memory.push({ phase, rss, heapUsed, external });
}

/** Off (null), the default sink, or the operator's path, taken as written. */
function phaseTimingsTarget(value: string | undefined): { default: true } | { path: string } | null {
  if (typeof value !== "string") return null;
  const raw = value;
  if (raw.trim() === "") return null;
  const flag = raw.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "no" || flag === "off") return null;
  if (flag === "1" || flag === "true" || flag === "on" || flag === "yes") return { default: true };
  return { path: raw };
}

/**
 * Resolves the `MEX_GRAPH_PHASE_TIMINGS` value to the file timings are
 * appended to, or null when the flag means "disabled". An empty value and
 * the flag-off spellings stay off; a bare flag-on spelling picks the
 * checkout-local default sink under `projectRoot`; any other non-empty value
 * is the operator's path, taken as written.
 */
export function resolvePhaseTimingsFile(value: string | undefined, projectRoot?: string): string | null {
  const target = phaseTimingsTarget(value);
  return target === null ? null : targetFile(target, projectRoot);
}

function targetFile(target: { default: true } | { path: string }, projectRoot: string | undefined): string {
  if ("path" in target) return target.path;
  return projectRoot === undefined ? DEFAULT_TIMINGS_FILE : join(projectRoot, DEFAULT_TIMINGS_FILE);
}

/**
 * Environment overrides for a graph worker spawned in the project root. A
 * relative operator path is pinned to this process's working directory, so
 * the worker appends to the same file as its parent.
 */
export function phaseTimingsWorkerEnv(): Record<string, string> {
  const target = phaseTimingsTarget(process.env[PHASE_TIMINGS_ENV]);
  if (target === null || !("path" in target) || isAbsolute(target.path)) return {};
  return { [PHASE_TIMINGS_ENV]: resolve(target.path) };
}

/** Whether phase timings are switched on for this run. */
export function phaseTimingsEnabled(): boolean {
  return phaseTimingsTarget(process.env[PHASE_TIMINGS_ENV]) !== null;
}

export function recordGraphPhase(phase: string, milliseconds: number): void {
  if (!phaseTimingsEnabled()) return;
  totals.set(phase, (totals.get(phase) ?? 0) + milliseconds);
}

export function timeGraphPhase<T>(phase: string, run: () => T): T {
  if (!phaseTimingsEnabled()) return run();
  const started = performance.now();
  try {
    return run();
  } finally {
    recordGraphPhase(phase, performance.now() - started);
  }
}

export async function timeGraphPhaseAsync<T>(phase: string, run: () => Promise<T>): Promise<T> {
  if (!phaseTimingsEnabled()) return run();
  const started = performance.now();
  try {
    return await run();
  } finally {
    recordGraphPhase(phase, performance.now() - started);
  }
}

/**
 * Append the accumulated totals under one fixed label, then reset them. The
 * default sink lives under `projectRoot`, or the working directory without one.
 */
export function flushGraphPhaseTimings(label: string, projectRoot?: string): void {
  const target = phaseTimingsTarget(process.env[PHASE_TIMINGS_ENV]);
  if (target === null) {
    totals.clear();
    memory.length = 0;
    return;
  }
  const phases = Object.fromEntries([...totals.entries()].map(([phase, ms]) => [phase, Math.round(ms * 10) / 10]));
  totals.clear();
  const file = targetFile(target, projectRoot);
  try {
    // The default sink sits in a checkout-local directory that may not exist
    // yet. Diagnostics must never change the outcome of a maintenance
    // operation, so both this and the append swallow failures.
    if ("default" in target) {
      mkdirSync(dirname(file), { recursive: true });
    }
    appendFileSync(file, `${JSON.stringify({ label, pid: process.pid, phases, memory })}\n`);
  } catch {
    // Diagnostics must never change the outcome of a maintenance operation.
  }
  memory.length = 0;
}
