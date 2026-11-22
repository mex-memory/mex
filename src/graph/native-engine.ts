// The Node side of the Rust graph engine's contract (OSS-73).
// docs/design/graph-engine-contract.md is the interface; this module finds the
// `mex-graph` binary, checks its contract version, and runs one job through
// the start barrier, streaming its events.
//
// Loaded on demand: graph reads never import it.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { GraphCoverageHistogram } from "./corpus-policy.js";
import type { ImportBindingRecord, UnresolvedRefRecord } from "./db/store.js";
import type { GraphEdge, GraphNode, Language } from "./types.js";

/** The contract version this module speaks; the engine must report the same. */
export const GRAPH_ENGINE_CONTRACT = 3;
/** Points at a specific engine binary, for development and tests. */
export const GRAPH_ENGINE_ENV = "MEX_GRAPH_ENGINE";
export { GRAPH_ENGINE_LANGUAGES_ENV, graphEngineLanguages } from "./engine-languages.js";

export interface GraphEngineBuildMetadata {
  indexedAt: number;
  indexedBranch: string | null;
  indexedHead: string | null;
  compilerVersion: string;
  extractorVersion: string;
  resolverVersion: string;
  grammarHash: string;
  configHash: string;
  manifestHash: string;
  sourceCorpusDigest: string;
  coverage: (GraphCoverageHistogram & {
    policyHash: string;
    directories: Array<{ path: string; stamp: string }>;
  }) | null;
  skipped: Array<{ path: string; reason: string }>;
}

export interface EngineRequest {
  mode: "build" | "refresh" | "stage";
  root: string;
  files: Array<{
    path: string;
    size?: number;
    modifiedAt?: number;
    contentHash?: string;
    staged?: string;
    extractorVersion?: string;
  }>;
  sourceDirectory?: string;
  buildMetadata?: GraphEngineBuildMetadata;
  configs?: Array<string | { path: string; source: string }>;
  languages: string[];
  /** Ask stage to include framework rows when the binary supports them. */
  frameworks?: boolean;
  /** The candidate database; `stage` writes none. */
  output?: string;
  base?: string | null;
  changed?: string[];
  factsCache?: string;
  limits: { memoryMb: number; deadlineMs: number; threads?: number };
}

/** One file's rows for today's (schema v4) writer, from `mex-graph stage`. */
export interface EngineStagedFile {
  type: "staged";
  path: string;
  contentHash: string;
  size: number;
  language: Language;
  parseStatus: "ok" | "partial" | "failed";
  frameworksResolved?: boolean;
  health: {
    status: "ok" | "partial" | "failed";
    diagnosticCount: number;
    missingCount: number;
    errorCoverage: number;
    diagnostics: Array<{ type: string; startLine: number; endLine: number }>;
  };
  nodes: Array<Omit<GraphNode, "updatedAt"> & { minhash?: number[]; tokenCount?: number }>;
  edges: GraphEdge[];
  unresolved: UnresolvedRefRecord[];
  imports?: ImportBindingRecord[];
}

export type EngineEvent =
  | { type: "progress"; phase: string; done: number; total: number }
  | { type: "file"; path: string; status: string; reason?: string }
  | EngineStagedFile
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
 * Run one job. The request file is written beside the candidate (or in
 * `requestDir` for `stage`, which writes no candidate); `start` is sent once
 * the engine is up, and the candidate is removed on any outcome other than a
 * clean exit, including a crash the engine couldn't clean up.
 */
export function runGraphEngine(
  binary: string,
  request: EngineRequest,
  options: { onEvent?: (event: EngineEvent) => void; signal?: AbortSignal; requestDir?: string } = {},
): Promise<EngineRun> {
  const requestPath = request.output
    ? `${request.output}.request.json`
    : join(options.requestDir ?? tmpdir(), `mex-graph-request-${process.pid}-${randomBytes(6).toString("hex")}.json`);
  writeFileSync(requestPath, JSON.stringify({ contract: GRAPH_ENGINE_CONTRACT, ...request }), { mode: 0o600, flag: "wx" });
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
      try { options.onEvent?.(event); }
      catch (error) {
        run.error = { type: "error", code: "graph_engine_parent_error", message: String(error) };
        child.kill("SIGKILL");
      }
    });
    child.stderr.resume();
    const abort = (): void => { child.kill("SIGKILL"); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    // An engine that refuses the request exits before reading start; the
    // write then meets a closed pipe, which the exit code already explains.
    child.stdin.on("error", () => {});
    child.stdin.write("start\n");
    child.on("close", (code, signal) => {
      options.signal?.removeEventListener("abort", abort);
      run.exitCode = code;
      run.signal = signal;
      rmSync(requestPath, { force: true });
      if (code !== 0 && request.output) removeCandidate(request.output);
      resolvePromise(run);
    });
    child.on("error", (error) => {
      run.error = { type: "error", code: "graph_engine_unavailable", message: error.message };
    });
  });
}
