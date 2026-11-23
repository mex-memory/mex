import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../file-index/store.js";
import type { Diagnostic } from "../team/contracts/shared.js";
import { GRAPH_ENGINE_MAX_MEMORY_MB } from "./sizing.js";
import { assertGraphDirectory, graphLocation, readGraphPointer, type GraphLocation } from "./storage.js";

export const GRAPH_ENGINE_MEMORY_LIMIT = "GRAPH_ENGINE_MEMORY_LIMIT";
const MAX_FAILURE_BYTES = 256;

export function graphEngineMemoryDiagnostic(memoryMb: number): Diagnostic {
  return {
    code: GRAPH_ENGINE_MEMORY_LIMIT,
    severity: "warning",
    message: `The Rust graph engine needed more memory than its ${memoryMb} MiB cap.`,
  };
}

export class GraphEngineMemoryLimitError extends Error {
  override readonly name = "GraphEngineMemoryLimitError";

  constructor(readonly memoryMb: number, options?: ErrorOptions) {
    super(graphEngineMemoryDiagnostic(memoryMb).message, options);
  }
}

function failureFile(location: GraphLocation): string {
  return join(location.directory, `graph-${location.key}-memory-limit.json`);
}

function currentPublication(location: GraphLocation): string | null {
  const pointer = readGraphPointer(location);
  return pointer?.overlay ?? pointer?.base ?? null;
}

/** Keep a checkout-local failure record beside the graph, under the writer lease. */
export function recordGraphMemoryFailure(location: GraphLocation, memoryMb: number): void {
  writeAtomic(failureFile(location), JSON.stringify({ memoryMb, publication: currentPublication(location) }));
}

/** Report the last cap failure for the current publication, even in a new process. */
export function readGraphMemoryFailure(root: string): number | undefined {
  try {
    const location = graphLocation(root);
    assertGraphDirectory(location.directory);
    const file = failureFile(location);
    const before = lstatSync(file, { bigint: true });
    if (!before.isFile() || before.size > MAX_FAILURE_BYTES) return undefined;
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let failure: { memoryMb: number; publication: string | null };
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) return undefined;
      const bytes = Buffer.alloc(MAX_FAILURE_BYTES + 1);
      const size = readSync(fd, bytes, 0, bytes.length, 0);
      if (size > MAX_FAILURE_BYTES) return undefined;
      failure = JSON.parse(bytes.toString("utf8", 0, size));
    } finally { closeSync(fd); }
    if (Number.isSafeInteger(failure.memoryMb) && failure.memoryMb > 0 && failure.memoryMb <= GRAPH_ENGINE_MAX_MEMORY_MB
      && failure.publication === currentPublication(location)) {
      return failure.memoryMb;
    }
  } catch { /* No readable failure record. */ }
  return undefined;
}
