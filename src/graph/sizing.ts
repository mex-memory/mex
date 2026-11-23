// Machine sizing for graph builds.
//
// A build sizes itself to the machine it runs on: the cores it may use and
// the memory that is free when it starts. A small machine gets fewer
// parallel reads and a smaller SQLite cache, so it runs
// slower; it never skips work. The numbers are a pure function of the
// machine, so they can be computed for a simulated one
// (MEX_GRAPH_MACHINE="cores=4,freeMb=4096") and reported.

import { availableParallelism, freemem, totalmem } from "node:os";

export interface GraphMachine {
  cores: number;
  freeMb: number;
  totalMb: number;
}

export interface GraphSizing {
  machine: GraphMachine;
  /** Budget used to size SQLite caches. */
  budgetMb: number;
  /** Parallel file reads while discovering the corpus. */
  readConcurrency: number;
  /** SQLite page cache of the database being written, in MB. */
  sqliteCacheMb: number;
  /** Where SQLite sorts and builds temporary indexes. */
  sqliteTempStore: "MEMORY" | "FILE";
}

export const GRAPH_ENGINE_MAX_MEMORY_MB = 4096;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, Math.round(value)));

/** The machine as the OS reports it, or as MEX_GRAPH_MACHINE simulates it. */
export function currentGraphMachine(environment: NodeJS.ProcessEnv = process.env): GraphMachine {
  const actual: GraphMachine = {
    cores: availableParallelism(),
    freeMb: Math.floor(freemem() / 1024 ** 2),
    totalMb: Math.floor(totalmem() / 1024 ** 2),
  };
  const simulated = environment.MEX_GRAPH_MACHINE;
  if (!simulated) return actual;
  const fields = Object.fromEntries(simulated.split(",").map((pair) => pair.split("=").map((part) => part.trim())));
  const number = (key: string, fallback: number): number => {
    const value = Math.floor(Number(fields[key]));
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  };
  const freeMb = number("freeMb", actual.freeMb);
  return { cores: number("cores", actual.cores), freeMb, totalMb: number("totalMb", Math.max(freeMb, Math.min(actual.totalMb, freeMb * 2))) };
}

export function graphSizing(machine: GraphMachine = currentGraphMachine()): GraphSizing {
  const budgetMb = clamp(machine.freeMb / 2, 512, 2048);
  return {
    machine,
    budgetMb,
    readConcurrency: clamp(machine.cores * 2, 4, 16),
    sqliteCacheMb: clamp(budgetMb / 8, 16, 128),
    sqliteTempStore: budgetMb >= 1_536 ? "MEMORY" : "FILE",
  };
}

/** RSS cap for a short-lived engine or the whole warm registry, in MiB. */
export function graphEngineMemoryMb(
  kind: "native" | "wasi" | "resident",
  machine: GraphMachine = currentGraphMachine(),
): number {
  // Total RAM gives a stable ceiling even when reclaimable file caches leave
  // little memory reported as free. Allow one eighth for an isolated job
  // and one sixteenth for long-lived engines, with usable floors on small
  // hosts. Leave a GiB below wasm32's address space for the WASI runtime.
  if (kind === "resident") return clamp(machine.totalMb / 16, 128, 2048);
  return clamp(machine.totalMb / 8, 256, kind === "wasi" ? 3072 : GRAPH_ENGINE_MAX_MEMORY_MB);
}

let current: GraphSizing | undefined;

/** This process's sizing, computed once. */
export function processGraphSizing(): GraphSizing {
  current ??= graphSizing();
  return current;
}

/** Test seam: forget the cached sizing. */
export function resetGraphSizing(): void {
  current = undefined;
}
