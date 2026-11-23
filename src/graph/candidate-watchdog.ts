import { Worker } from "node:worker_threads";

/**
 * Only the lifeline runs in a Worker; graph construction stays in the disposable
 * process. EOF is an OS-owned parent-lifetime signal, not a PID liveness guess
 * that could accept a reused PID. It works during a blocked extraction or SQLite call.
 */
export async function startGraphCandidateWatchdog(): Promise<() => Promise<void>> {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    const { Socket } = require("node:net");
    const lifeline = new Socket({ fd: 4, readable: true, writable: false });
    const stop = () => process.kill(process.pid, "SIGKILL");
    lifeline.on("end", stop);
    lifeline.on("error", stop);
    lifeline.on("close", stop);
    lifeline.resume();
    parentPort.postMessage("ready");
  `, { eval: true, execArgv: [] });
  await new Promise<void>((resolve, reject) => {
    worker.once("message", () => resolve());
    worker.once("error", reject);
    worker.once("exit", (code) => { if (code !== 0) reject(new Error("Graph watchdog failed.")); });
  });
  // Losing the watchdog while construction is active fails closed. Normal
  // termination removes these handlers before deliberately stopping it.
  const failed = () => process.kill(process.pid, "SIGKILL");
  worker.on("error", failed);
  worker.on("exit", failed);
  return async () => {
    worker.removeListener("error", failed);
    worker.removeListener("exit", failed);
    await worker.terminate();
  };
}
