import { appendFileSync } from "node:fs";

/**
 * Opt-in per-phase wall-clock timing for graph maintenance.
 *
 * Disabled unless `MEX_GRAPH_PHASE_TIMINGS` names a file. When enabled, each
 * flush appends one JSON line of accumulated phase totals to that file. A flag
 * value is not a path: `1`, `true`, `yes` or `on` keeps timings off and prints
 * one warning, instead of writing to a file named `1` in the working directory,
 * and `0`, `false`, `no` or `off` keeps them off silently. Nothing else is
 * printed, and no path or source content enters a record: phase names are fixed
 * labels and values are milliseconds or counts.
 */
const PHASE_TIMINGS_ENV = "MEX_GRAPH_PHASE_TIMINGS";
const ON_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);
const OFF_FLAG_VALUES = new Set(["0", "false", "no", "off"]);

const totals = new Map<string, number>();
let warnedAboutFlagValue = false;

function timingsPath(): string | undefined {
  const value = process.env[PHASE_TIMINGS_ENV];
  if (value === undefined || value === "") return undefined;
  const flag = value.trim().toLowerCase();
  if (OFF_FLAG_VALUES.has(flag)) return undefined;
  if (ON_FLAG_VALUES.has(flag)) {
    if (!warnedAboutFlagValue) {
      warnedAboutFlagValue = true;
      process.stderr.write(`mex: ${PHASE_TIMINGS_ENV} must name a file, not "${value}"; phase timings are off.\n`);
    }
    return undefined;
  }
  return value;
}

function enabled(): boolean {
  return timingsPath() !== undefined;
}

export function recordGraphPhase(phase: string, milliseconds: number): void {
  if (!enabled()) return;
  totals.set(phase, (totals.get(phase) ?? 0) + milliseconds);
}

export function timeGraphPhase<T>(phase: string, run: () => T): T {
  if (!enabled()) return run();
  const started = performance.now();
  try {
    return run();
  } finally {
    recordGraphPhase(phase, performance.now() - started);
  }
}

export async function timeGraphPhaseAsync<T>(phase: string, run: () => Promise<T>): Promise<T> {
  if (!enabled()) return run();
  const started = performance.now();
  try {
    return await run();
  } finally {
    recordGraphPhase(phase, performance.now() - started);
  }
}

/** Append the accumulated totals under one fixed label, then reset them. */
export function flushGraphPhaseTimings(label: string): void {
  const path = timingsPath();
  if (path === undefined) {
    totals.clear();
    return;
  }
  const phases = Object.fromEntries([...totals.entries()].map(([phase, ms]) => [phase, Math.round(ms * 10) / 10]));
  totals.clear();
  try {
    appendFileSync(path, `${JSON.stringify({ label, pid: process.pid, phases })}\n`);
  } catch {
    // Diagnostics must never change the outcome of a maintenance operation.
  }
}
