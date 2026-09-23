import { appendFileSync } from "node:fs";

/**
 * Opt-in per-phase wall-clock timing for graph maintenance.
 *
 * Disabled unless `MEX_GRAPH_PHASE_TIMINGS` names a file. When enabled, each
 * flush appends one JSON line of accumulated phase totals to that file. Nothing
 * is ever printed, and no path or source content enters a record: phase names
 * are fixed labels and values are milliseconds or counts.
 */
const PHASE_TIMINGS_ENV = "MEX_GRAPH_PHASE_TIMINGS";

const totals = new Map<string, number>();

function enabled(): boolean {
  return typeof process.env[PHASE_TIMINGS_ENV] === "string" && process.env[PHASE_TIMINGS_ENV] !== "";
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
  if (!enabled()) {
    totals.clear();
    return;
  }
  const phases = Object.fromEntries([...totals.entries()].map(([phase, ms]) => [phase, Math.round(ms * 10) / 10]));
  totals.clear();
  try {
    appendFileSync(process.env[PHASE_TIMINGS_ENV]!, `${JSON.stringify({ label, pid: process.pid, phases })}\n`);
  } catch {
    // Diagnostics must never change the outcome of a maintenance operation.
  }
}
