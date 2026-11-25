import { setTimeout } from "node:timers/promises";
import { openRecord, WRITER_TIMEOUT_MS } from "./index.js";
import type { LocationOptions } from "./location.js";

export function recordBusy(error: unknown): boolean {
  const sqlite = error as { errcode?: number; code?: string } | undefined;
  return (sqlite?.errcode !== undefined && [5, 6].includes(sqlite.errcode & 0xff)) || sqlite?.code === "SQLITE_BUSY";
}

/** A browser write can wait for the usual record deadline without blocking the Hub thread. */
export async function waitForRecordWriter(options: LocationOptions) {
  const deadline = performance.now() + WRITER_TIMEOUT_MS;
  while (true) {
    try { return openRecord({ ...options, create: false, busyTimeoutMs: 0 }); }
    catch (error) {
      const remaining = deadline - performance.now();
      if (!recordBusy(error) || remaining <= 0) throw error;
      await setTimeout(Math.min(150, remaining));
    }
  }
}
