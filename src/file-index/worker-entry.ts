/** Worker thread for the file index build: runs one batch per message. Built to dist/file-index-worker.js. */
import { parentPort } from "node:worker_threads";
import { processBatch, type BatchInput } from "./batch.js";

parentPort?.on("message", (message: { id: number; input: BatchInput }) => {
  processBatch(message.input).then(
    (output) => parentPort!.postMessage({ id: message.id, output }),
    (error: unknown) => parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) }),
  );
});
