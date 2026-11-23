// The Node side of the Rust graph engine's contract (OSS-73).
// docs/design/graph-engine-contract.md is the interface; this module finds the
// `mex-graph` binary, checks its contract version, and runs one job through
// the start barrier, streaming its events.
//
// Loaded on demand: graph reads never import it.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { GraphCoverageHistogram } from "./corpus-policy.js";
import type { ImportBindingRecord, UnresolvedRefRecord } from "./db/store.js";
import { GraphEngineMemoryLimitError } from "./engine-memory.js";
import { graphPlatformPackage } from "./engine-platform.js";
import { phaseTimingsWorkerEnv } from "./phase-timing.js";
import type { BASIC_RESOLUTION, GraphEdge, GraphNode, Language } from "./types.js";
import { addEngineUsage } from "./process-stats.js";
import { currentGraphMachine, graphEngineMemoryMb } from "./sizing.js";

/** The contract version this module speaks; the engine must report the same. */
export const GRAPH_ENGINE_CONTRACT = 3;
export const GRAPH_ENGINE_IDENTITY = `mex-graph-contract-${GRAPH_ENGINE_CONTRACT}`;
/** Points at a specific engine binary, for development and tests. */
export const GRAPH_ENGINE_ENV = "MEX_GRAPH_ENGINE";
export { GRAPH_ENGINE_LANGUAGES_ENV, graphEngineLanguages } from "./engine-languages.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_PACKAGE = createRequire(import.meta.url);
export const NO_NATIVE_ENGINE = "no mex-graph binary was found";
const WASI_RUNNER = join(HERE, "wasi-engine.mjs");
// uvwasi can allocate during a filesystem call. Disable the V8 fast-call
// path, which has crashed during the resulting GC on Node 22.
const WASI_ARGS = ["--no-turbo-fast-api-calls", WASI_RUNNER];

export type GraphEngineRunner = { kind: "native" | "wasi"; path: string; nativeUnavailable?: string };
export interface GraphEngineUsage { wallMs: number; peakRssMb: number; cpuMs?: number }

export interface GraphEngineBuildMetadata {
  indexedAt: number;
  indexedBranch: string | null;
  indexedHead: string | null;
  /** The engine identifier in the v5 contract's required legacy slot. */
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

export interface EngineRequestFile {
  path: string;
  size?: number;
  modifiedAt?: number;
  contentHash?: string;
  staged?: string;
  extractorVersion?: string;
  sourceIdentity?: string;
  utf8Size?: number;
}

export type EngineRequestConfig = string | { path: string; source: string };

export interface EngineRequest {
  mode: "build" | "refresh" | "stage";
  root: string;
  /** Original path for absolute module references when WASI remaps root. */
  moduleRoot?: string;
  files: EngineRequestFile[];
  sourceDirectory?: string;
  observationRoot?: string;
  walkObservation?: string;
  buildMetadata?: GraphEngineBuildMetadata;
  configs?: EngineRequestConfig[];
  languages: string[];
  /** Ask stage to include framework rows when the binary supports them. */
  frameworks?: boolean;
  /** The candidate database; `stage` writes none. */
  output?: string;
  base?: string | null;
  overlay?: string;
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
  coverage?: typeof BASIC_RESOLUTION;
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
  | { type: "progress"; phase: string; done: number; total: number; usage?: GraphEngineUsage }
  | { type: "file"; path: string; status: string; reason?: string }
  | EngineStagedFile
  | { type: "result"; files: number; nodes: number; edges: number; coverageGaps?: number;
    filesReextracted?: number; shadowedFiles?: number | null; usage: GraphEngineUsage }
  | { type: "usage"; usage: GraphEngineUsage }
  | { type: "error"; code: string; message: string; usage?: GraphEngineUsage };

export interface EngineRun {
  /** The process's exit code, or null when a signal killed it. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  result?: Extract<EngineEvent, { type: "result" }>;
  error?: Extract<EngineEvent, { type: "error" }>;
  usage?: GraphEngineUsage;
}

function hitMemoryLimit(run: EngineRun): boolean {
  // The native guard exits with code 3 even if its error frame could not be sent.
  return run.error?.code === "graph_memory_limit" || run.exitCode === 3;
}

/** Run one maintenance job, with a serial retry if parallel extraction hits the cap. */
export async function runResolvedGraphEngine(
  runner: GraphEngineRunner,
  request: Omit<EngineRequest, "limits">,
  options?: NonNullable<Parameters<typeof runGraphEngine>[2]> & { onAttempt?: () => void },
): Promise<EngineRun & { runner: GraphEngineRunner; memoryRetryMb?: number }> {
  const machine = currentGraphMachine();
  const limitsForRunner = () => ({
    memoryMb: graphEngineMemoryMb(runner.kind, machine),
    deadlineMs: 30 * 60_000,
    // Match the engine's default bound on concurrent compression workspaces.
    threads: runner.kind === "wasi" ? 1 : request.factsCache ? Math.min(machine.cores, 5) : machine.cores,
  });
  const attempt = (limits: EngineRequest["limits"]) => {
    options?.onAttempt?.();
    return runGraphEngine(runner, { ...request, limits }, options);
  };
  let limits = limitsForRunner();
  let run = await attempt(limits);
  if (runner.kind === "native" && !options?.signal?.aborted && run.error?.code === "graph_engine_unavailable") {
    const wasi = resolveWasiGraphEngine("the mex-graph binary could not be executed");
    if (!("problem" in wasi)) {
      runner = wasi;
      limits = limitsForRunner();
      run = await attempt(limits);
    }
  }
  if (!hitMemoryLimit(run) || options?.signal?.aborted) return { ...run, runner };

  const { memoryMb } = limits;
  if (limits.threads === 1) throw new GraphEngineMemoryLimitError(memoryMb);
  try {
    run = await attempt({ ...limits, threads: 1 });
  } catch (cause) {
    throw new GraphEngineMemoryLimitError(memoryMb, { cause });
  }
  if (run.error || run.exitCode !== 0 || !run.result) throw new GraphEngineMemoryLimitError(memoryMb);
  return { ...run, runner, memoryRetryMb: memoryMb };
}

/** Native executable selected by override, platform package, or checkout build. */
export function graphEngineBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env[GRAPH_ENGINE_ENV]?.trim();
  if (fromEnv) return !fromEnv.endsWith(".wasm") && existsSync(fromEnv) ? resolve(fromEnv) : undefined;
  const exe = process.platform === "win32" ? "mex-graph.exe" : "mex-graph";
  const pkg = graphPlatformPackage();
  if (pkg) {
    try {
      const binary = join(dirname(HOST_PACKAGE.resolve(`${pkg}/package.json`)), "bin", exe);
      if (existsSync(binary)) return binary;
    } catch { /* Optional dependency absent. */ }
  }
  let dir = HERE;
  for (let i = 0; i < 6; i++) {
    for (const profile of ["release", "debug"]) {
      const candidate = join(dir, "native", "engine", "target", profile, exe);
      if (existsSync(candidate)) return candidate;
    }
    dir = dirname(dir);
  }
  return undefined;
}

function graphEngineWasi(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env[GRAPH_ENGINE_ENV]?.trim();
  if (fromEnv?.endsWith(".wasm")) return existsSync(fromEnv) ? resolve(fromEnv) : undefined;
  return [
    join(HERE, "mex-graph.wasm"),
    join(HERE, "../../dist/mex-graph.wasm"),
    join(HERE, "../native/engine/target/wasm32-wasip1/release/mex-graph.wasm"),
    join(HERE, "../../native/engine/target/wasm32-wasip1/release/mex-graph.wasm"),
  ].find(path => existsSync(path));
}

export function hasGraphEngine(): boolean {
  return !!(graphEngineBinary() || graphEngineWasi());
}

export function resolveWasiGraphEngine(nativeUnavailable?: string): GraphEngineRunner | { problem: string } {
  const path = graphEngineWasi();
  if (!path) return { problem: nativeUnavailable ?? NO_NATIVE_ENGINE };
  const runner: GraphEngineRunner = { kind: "wasi", path, nativeUnavailable };
  const version = graphEngineVersion(runner);
  return "problem" in version ? { problem: "the WASI graph engine could not start" } : runner;
}

export function resolveGraphEngine(): GraphEngineRunner | { problem: string } {
  const path = graphEngineBinary();
  if (!path) return resolveWasiGraphEngine(process.env[GRAPH_ENGINE_ENV]?.trim().endsWith(".wasm") ? undefined : NO_NATIVE_ENGINE);
  const version = graphEngineVersion(path);
  return "problem" in version ? resolveWasiGraphEngine(version.problem) : { kind: "native", path };
}

/** The engine's version, or why it can't be used. */
export function graphEngineVersion(binary: string | GraphEngineRunner): { version: string; contract: number } | { problem: string } {
  const runner = typeof binary === "string" ? { kind: "native", path: binary } : binary;
  const options = {
    encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", windowsHide: true, env: engineEnv(),
  } as const;
  const run = runner.kind === "wasi"
    ? spawnSync(process.execPath, [...WASI_ARGS, runner.path, "version"], options)
    : spawnSync(runner.path, ["version"], options);
  if (run.error) return { problem: "the mex-graph binary could not be executed" };
  if (run.status !== 0) return { problem: `mex-graph version exited ${run.status ?? run.signal}` };
  try {
    const parsed = JSON.parse(run.stdout) as { version: string; contract: number };
    if (!Number.isSafeInteger(parsed?.contract)) return { problem: "mex-graph version did not identify a contract" };
    if (parsed.contract !== GRAPH_ENGINE_CONTRACT) {
      return { problem: `the engine speaks contract ${parsed.contract}, MEX needs ${GRAPH_ENGINE_CONTRACT}` };
    }
    return parsed;
  } catch {
    return { problem: "mex-graph version printed something that isn't JSON" };
  }
}

/** Keep raw engine output and local paths out of the published report. */
export function graphEngineFailureReason(run: EngineRun): string {
  const code = run.error?.code;
  const detail = typeof code === "string" && /^graph_[a-z0-9_]{1,64}$/u.test(code)
    ? code
    : run.signal ?? (run.exitCode ? `exit ${run.exitCode}` : "missing or invalid result");
  return `the engine stopped (${detail})`;
}

/** The engine gets an allowlisted environment, never the caller's whole one. */
function engineEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "LC_ALL"];
  return Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
}

export function writeEngineRequest(path: string, request: EngineRequest | (Omit<EngineRequest, "mode"> & {
  mode: "serve"; overlay?: string;
})): void {
  writeFileSync(path, JSON.stringify({ contract: GRAPH_ENGINE_CONTRACT, ...request }), { mode: 0o600, flag: "wx" });
}

export function spawnGraphEngine(binary: string, mode: EngineRequest["mode"] | "serve", requestPath: string) {
  return spawn(binary, [mode, "--request", requestPath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...engineEnv(),
      MEX_GRAPH_PHASE_TIMINGS: process.env.MEX_GRAPH_PHASE_TIMINGS,
      ...phaseTimingsWorkerEnv(),
    },
  });
}

function spawnWasiGraphEngine(module: string, request: EngineRequest, requestPath: string) {
  // WASI canonicalization needs mounts directly under /.
  const root = realpathSync.native(request.root);
  const job = dirname(requestPath);
  const preopens: Record<string, string> = { "/checkout": root, "/job": job };
  function inGuest(path: string | null | undefined): string | undefined {
    if (!path) return undefined;
    const directory = dirname(path);
    if (directory === job) return `/job/${basename(path)}`;
    const mount = `/db-${Object.keys(preopens).length}`;
    preopens[mount] = directory;
    return `${mount}/${basename(path)}`;
  }
  if (request.sourceDirectory) preopens["/sources"] = request.sourceDirectory;
  writeEngineRequest(requestPath, {
    ...request, root: "/checkout", moduleRoot: root, output: inGuest(request.output), base: inGuest(request.base),
    overlay: inGuest(request.overlay), factsCache: undefined,
    sourceDirectory: request.sourceDirectory ? "/sources" : undefined,
  });
  const options = JSON.stringify({
    request: `/job/${basename(requestPath)}`, hostRequest: requestPath, output: request.output,
    preopens, ...request.limits,
  });
  return spawn(process.execPath, [...WASI_ARGS, module, request.mode, options], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: engineEnv(),
  });
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
  binary: string | GraphEngineRunner,
  request: EngineRequest,
  options: { onEvent?: (event: EngineEvent) => void; signal?: AbortSignal; requestDir?: string } = {},
): Promise<EngineRun> {
  const requestPath = request.output
    ? `${request.output}.request.json`
    : join(options.requestDir ?? tmpdir(), `mex-graph-request-${process.pid}-${randomBytes(6).toString("hex")}.json`);
  const runner = typeof binary === "string" ? { kind: "native", path: binary } : binary;
  let child;
  if (runner.kind === "wasi") {
    child = spawnWasiGraphEngine(runner.path, request, requestPath);
  } else {
    writeEngineRequest(requestPath, request);
    child = spawnGraphEngine(runner.path, request.mode, requestPath);
  }
  return new Promise((resolvePromise) => {
    const run: EngineRun = { exitCode: null, signal: null };
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let event: EngineEvent;
      try { event = JSON.parse(line) as EngineEvent; } catch { return; }
      if (!event || typeof event !== "object") return;
      if (event.type === "result") run.result = event;
      if (event.type === "error") run.error = event;
      if ("usage" in event && event.usage && Number.isFinite(event.usage.wallMs) && Number.isFinite(event.usage.peakRssMb)) {
        const sample = event.usage;
        const cpuMs = typeof sample.cpuMs === "number" && Number.isFinite(sample.cpuMs) ? sample.cpuMs : undefined;
        run.usage = {
          wallMs: Math.max(run.usage?.wallMs ?? 0, sample.wallMs),
          peakRssMb: Math.max(run.usage?.peakRssMb ?? 0, sample.peakRssMb),
          ...(cpuMs !== undefined || run.usage?.cpuMs !== undefined
            ? { cpuMs: Math.max(run.usage?.cpuMs ?? 0, cpuMs ?? 0) } : {}),
        };
      }
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
      if ((code !== 0 || !run.result || hitMemoryLimit(run)) && request.output) removeCandidate(request.output);
      if (run.result && run.usage) run.result.usage = run.usage;
      if (run.usage) addEngineUsage(run.usage);
      resolvePromise(run);
    });
    child.on("error", (error) => {
      run.error = { type: "error", code: "graph_engine_unavailable", message: error.message };
    });
  });
}
