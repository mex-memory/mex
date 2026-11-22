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

/** The background process's resident memory cap (`background.memory_mb`). */
export const GRAPH_NODE_CAP_MB = 1024;
/** The resident graph engines' memory cap. */
export const GRAPH_SERVER_CAP_MB = 1024;

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
    const value = Number(fields[key]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };
  const freeMb = number("freeMb", actual.freeMb);
  return { cores: number("cores", actual.cores), freeMb, totalMb: number("totalMb", Math.max(freeMb, Math.min(actual.totalMb, freeMb * 2))) };
}

export function graphSizing(machine: GraphMachine = currentGraphMachine()): GraphSizing {
  const budgetMb = clamp(machine.freeMb / 2, 512, GRAPH_NODE_CAP_MB + GRAPH_SERVER_CAP_MB);
  return {
    machine,
    budgetMb,
    readConcurrency: clamp(machine.cores * 2, 4, 16),
    sqliteCacheMb: clamp(budgetMb / 8, 16, 128),
    sqliteTempStore: budgetMb >= 1_536 ? "MEMORY" : "FILE",
  };
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
