import { spawn } from "node:child_process";
import { readDriftAlertState } from "./alert-state.js";
import { privateEntrypoint } from "./detect-process.js";

const CHECK_INTERVAL_MS = 10 * 60_000;

export interface DriftAlertRunner {
  run(): void;
}

/** Runs passes in a private process, at most one at a time from this Hub. */
export function createDriftAlertRunner(projectRoot: string): DriftAlertRunner {
  let running = false;
  return {
    run() {
      if (running) return;
      running = true;
      try {
        const child = spawn(process.execPath, [privateEntrypoint("drift-alert"), projectRoot], {
          cwd: projectRoot,
          windowsHide: true,
          stdio: "ignore",
          env: { ...process.env, MEX_TELEMETRY: "0", DO_NOT_TRACK: "1" },
        });
        child.once("error", () => { running = false; });
        child.once("close", () => { running = false; });
        child.unref();
      } catch { running = false; }
    },
  };
}

/** Check now and then on an interval. With alerts off, this only reads the setting. */
export function startDriftAlertSchedule(
  projectRoot: string,
  runner: DriftAlertRunner,
  intervalMs = CHECK_INTERVAL_MS,
): () => void {
  const tick = () => {
    try {
      if (readDriftAlertState(projectRoot).enabled) runner.run();
    } catch { /* Settings shows a malformed state; the schedule stays quiet. */ }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
