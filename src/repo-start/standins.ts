/**
 * Stand-ins for setup's background steps (contracts/setup-jobs.md). Registered only when
 * MEX_SETUP_STANDINS=1 and only for a kind this build doesn't have yet, so the screen and
 * the Hub are built and tested against the same rows the real kinds write. A stand-in
 * advances its progress on a timer and writes nothing.
 */
import { jobKind, registerJobKind } from "../record/jobs.js";

export interface StandInParams { checkout: string; files?: number; delayMs?: number; }
const LABELS = { "graph-build": "Code map", "learn-deeper": "Learn deeper" } as const;
const UNITS = { "graph-build": "files", "learn-deeper": "batches" } as const;

export function standInsEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return env.MEX_SETUP_STANDINS === "1"; }

if (standInsEnabled()) {
  for (const name of ["graph-build", "learn-deeper"] as const) {
    if (jobKind(name)) continue;
    registerJobKind<StandInParams, { done: number }>({
      name, label: LABELS[name], scope: "project", sideEffects: "none",
      async runBatch({ params, checkpoint, progress }) {
        const total = Math.max(1, params.files ?? 4), step = Math.max(1, Math.ceil(total / 4));
        const done = Math.min(total, (checkpoint?.done ?? 0) + step);
        progress?.(`${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${UNITS[name]}`);
        await new Promise(resolve => setTimeout(resolve, Math.max(0, params.delayMs ?? 50)));
        return {
          checkpoint: { done }, results: step, done: done >= total,
          progress: `${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${UNITS[name]}`,
          summary: name === "graph-build" ? `Code map built: ${total.toLocaleString("en-US")} files (stand-in)` : `Learn deeper: ${done} of ${total} batches (stand-in)`,
        };
      },
    });
  }
}
