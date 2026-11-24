import { parentPort, workerData } from "node:worker_threads";
import { startMachineHub, type RunningMachineHub } from "./serve.js";

/**
 * The Hub inside the background process, on its own thread, so a long job batch never
 * stalls a page load. It talks to the background loop only to say it is ready or to stop.
 */

interface HubWorkerData { home?: string; cache?: string }

let hub: RunningMachineHub | undefined;
const data = (workerData ?? {}) as HubWorkerData;

parentPort?.on("message", (message: unknown) => {
  if (message === "stop") void stop();
});

void (async () => {
  try {
    hub = await startMachineHub({ home: data.home, cache: data.cache, mode: "background" });
    parentPort?.postMessage({ type: "ready", port: hub.port });
  } catch (error) {
    parentPort?.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
})();

async function stop(): Promise<void> {
  try { await hub?.close(); } finally { process.exit(0); }
}
