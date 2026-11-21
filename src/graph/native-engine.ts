// The Node side of the Rust graph engine's contract (OSS-73).
// docs/design/graph-engine-contract.md is the interface; this module finds the
// `mex-graph` binary, checks its contract version, and runs one job through
// the start barrier, streaming its events.
//
// Loaded on demand: graph reads never import it.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** The contract version this module speaks; the engine must report the same. */
export const GRAPH_ENGINE_CONTRACT = 1;
/** Points at a specific engine binary, for development and tests. */
export const GRAPH_ENGINE_ENV = "MEX_GRAPH_ENGINE";

export interface EngineRequest {
  mode: "build" | "refresh";
  root: string;
  files: Array<{ path: string; size?: number }>;
  configs?: string[];
  languages: string[];
  output: string;
  base?: string | null;
  changed?: string[];
  factsCache?: string;
  limits: { memoryMb: number; deadlineMs: number; threads?: number };
}

export type EngineEvent =
  | { type: "progress"; phase: string; done: number; total: number }
  | { type: "file"; path: string; status: string; reason?: string }
  | { type: "result"; files: number; nodes: number; edges: number; coverageGaps?: number; usage: { wallMs: number; peakRssMb: number; cpuMs?: number } }
  | { type: "error"; code: string; message: string };

export interface EngineRun {
  /** The process's exit code, or null when a signal killed it. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  result?: Extract<EngineEvent, { type: "result" }>;
  error?: Extract<EngineEvent, { type: "error" }>;
}

/**
 * The engine binary: `MEX_GRAPH_ENGINE`, else a development build in this
 * checkout (`native/engine/target/{release,debug}`). Platform packages are M6.
 */
export function graphEngineBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env[GRAPH_ENGINE_ENV]?.trim();
  if (fromEnv) return existsSync(fromEnv) ? resolve(fromEnv) : undefined;
  const exe = process.platform === "win32" ? "mex-graph.exe" : "mex-graph";
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    for (const profile of ["release", "debug"]) {
      const candidate = join(dir, "native", "engine", "target", profile, exe);
      if (existsSync(candidate)) return candidate;
    }
    dir = dirname(dir);
  }
  return undefined;
}

/** The engine's version, or why it can't be used. */
export function graphEngineVersion(binary: string): { version: string; contract: number } | { problem: string } {
  const run = spawnSync(binary, ["version"], { encoding: "utf8", timeout: 10_000, windowsHide: true, env: engineEnv() });
  if (run.status !== 0) return { problem: `mex-graph version exited ${run.status ?? run.signal}` };
  try {
    const parsed = JSON.parse(run.stdout) as { version: string; contract: number };
    if (parsed.contract !== GRAPH_ENGINE_CONTRACT) {
      return { problem: `the engine speaks contract ${parsed.contract}, MEX needs ${GRAPH_ENGINE_CONTRACT}` };
    }
    return parsed;
  } catch {
    return { problem: "mex-graph version printed something that isn't JSON" };
  }
}

/** The engine gets an allowlisted environment, never the caller's whole one. */
function engineEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "LC_ALL"];
  return Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
}

function removeCandidate(output: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(output + suffix, { force: true });
}

/**
 * Run one job. The request file is written beside the candidate; `start` is
 * sent once the engine is up, and the candidate is removed on any outcome
 * other than a clean exit, including a crash the engine couldn't clean up.
 */
export function runGraphEngine(
  binary: string,
  request: EngineRequest,
  options: { onEvent?: (event: EngineEvent) => void; signal?: AbortSignal } = {},
): Promise<EngineRun> {
  const requestPath = `${request.output}.request.json`;
  writeFileSync(requestPath, JSON.stringify({ contract: GRAPH_ENGINE_CONTRACT, ...request }));
  return new Promise((resolvePromise) => {
    const child = spawn(binary, [request.mode, "--request", requestPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: engineEnv(),
    });
    const run: EngineRun = { exitCode: null, signal: null };
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let event: EngineEvent;
      try { event = JSON.parse(line) as EngineEvent; } catch { return; }
      if (event.type === "result") run.result = event;
      if (event.type === "error") run.error = event;
      options.onEvent?.(event);
    });
    child.stderr.resume();
    const abort = (): void => { child.kill("SIGKILL"); };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdin.write("start\n");
    child.on("close", (code, signal) => {
      options.signal?.removeEventListener("abort", abort);
      run.exitCode = code;
      run.signal = signal;
      rmSync(requestPath, { force: true });
      if (code !== 0) removeCandidate(request.output);
      resolvePromise(run);
    });
    child.on("error", (error) => {
      run.error = { type: "error", code: "graph_engine_unavailable", message: error.message };
    });
  });
}
