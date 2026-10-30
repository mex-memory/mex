import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, totalmem, freemem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildResult } from "./engine.js";
import {
  boundedCandidateMessage,
  type GraphCandidateProgress,
  type GraphCandidateRequest,
} from "./candidate-protocol.js";
import { phaseTimingsWorkerEnv } from "./phase-timing.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTUP_TIMEOUT_MS = 15_000;
const TERMINATE_GRACE_MS = 500;
// A hang guard, not a resource/performance promise for a particular repository.
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
export const GRAPH_CANDIDATE_DIAGNOSTIC_BYTES = 8 * 1024;
const NODE_HEAP_FAILURE = /^FATAL ERROR: (?:Reached heap limit|Ineffective mark-compacts near heap limit) Allocation failed - JavaScript heap out of memory\s*$/mu;

/**
 * Keep explicit user heap flags; otherwise allow a share of machine memory, leaving room for
 * native/compiler work. The heap is a ceiling: free memory at spawn does not cap it, because a
 * large repository that needs more than is free would otherwise fail outright instead of paging.
 */
export function graphWorkerHeap(input: {
  totalBytes: number; freeBytes: number; defaultHeapMb: number;
  nodeOptions?: string; execArgv: readonly string[];
}): { args: string[]; heapMb: number; totalMemoryMb: number; freeMemoryMb: number } {
  const mb = 1024 ** 2;
  const flag = /--max[-_]old[-_]space[-_]size(?:=|\s+)["']?(\d+)/u;
  const args: string[] = [];
  for (let i = 0; i < input.execArgv.length; i++) {
    const arg = input.execArgv[i]!;
    if (!/^--max[-_]old[-_]space[-_]size(?:=|$)/u.test(arg)) continue;
    args.push(arg);
    if (!arg.includes("=") && input.execArgv[i + 1] !== undefined) args.push(input.execArgv[++i]!);
  }
  const lastFlag = (text: string) => [...text.matchAll(new RegExp(flag.source, "gu"))].at(-1);
  const inherited = lastFlag(args.join(" "));
  const environment = lastFlag(input.nodeOptions ?? "");
  const explicit = inherited ?? environment;
  const heapMb = explicit ? Number(explicit[1]) : Math.max(input.defaultHeapMb,
    Math.floor(Math.min(input.totalBytes * 0.6 / mb, 16 * 1024)));
  return {
    args: inherited ? args : environment ? [] : [`--max-old-space-size=${heapMb}`],
    heapMb, totalMemoryMb: Math.floor(input.totalBytes / mb), freeMemoryMb: Math.floor(input.freeBytes / mb),
  };
}

export function graphHeapRecovery(diagnostic: Pick<GraphCandidateProcessDiagnostic, "heapMb" | "totalMemoryMb" | "freeMemoryMb">): string {
  const used = diagnostic.heapMb ?? 4096;
  const next = Math.ceil(used * 1.5 / 1024) * 1024;
  return `The graph worker reached Node's JavaScript heap limit (${used} MB heap; ${diagnostic.totalMemoryMb ?? "unknown"} MB machine memory, ${diagnostic.freeMemoryMb ?? "unknown"} MB free at spawn). Close other programs and retry, or set NODE_OPTIONS=--max-old-space-size=${next} with enough available memory, then rerun the command.`;
}

export interface GraphCandidateProcessDiagnostic {
  readonly reason: "entrypoint-missing" | "spawn" | "startup-timeout" | "build-timeout"
    | "protocol" | "ipc-disconnected" | "worker-error" | "exit" | "observer" | "cancelled";
  readonly heapMb?: number;
  readonly totalMemoryMb?: number;
  readonly freeMemoryMb?: number;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  /** Signal requested by MEX after an already diagnosed worker failure. */
  readonly supervisorSignal?: NodeJS.Signals;
  readonly elapsedMs?: number;
  readonly progress?: GraphCandidateProgress;
  /** Only set when Node prints its explicit fatal JavaScript heap-limit marker. */
  readonly resourceFailure?: "heap-limit";
  /** Bounded local terminal diagnostics. Never project this field into GraphPort/Hub responses. */
  readonly stderr?: string;
}

export class GraphCandidateProcessError extends Error {
  override readonly name = "GraphCandidateProcessError";
  constructor(
    readonly category: "cancelled" | "compatibility" | "staging" | "failed" | "unsafe",
    readonly diagnostic?: GraphCandidateProcessDiagnostic,
  ) {
    super(`Graph worker category: ${category}. ${diagnostic ? diagnosticMessage(diagnostic) : category === "cancelled"
      ? "Setup itself cancelled graph candidate construction; the worker did not fail."
      : "The isolated graph candidate could not be completed safely (no worker diagnostic was returned)."}`);
  }
}

export interface GraphCandidateProcessOptions {
  projectRoot: string;
  candidatePath: string;
  operation: "refresh" | "rebuild";
  signal?: AbortSignal;
  onProgress?: (progress: GraphCandidateProgress) => void;
  /** Deterministic subprocess fault seams; never exposed by the GraphPort. */
  __internal?: {
    entrypoint?: string;
    onSpawn?: (pid: number, workspace: string) => void;
    buildTimeoutMs?: number;
    startupTimeoutMs?: number;
  };
}

function identity(path: string): GraphCandidateRequest["workspaceIdentity"] {
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new GraphCandidateProcessError("unsafe");
  return { realPath: realpathSync(path), dev: String(stats.dev), ino: String(stats.ino) };
}

function sameDirectory(path: string, expected: ReturnType<typeof identity>): boolean {
  try {
    const current = identity(path);
    return current.realPath === expected.realPath && current.dev === expected.dev && current.ino === expected.ino;
  } catch {
    return false;
  }
}

function candidateEntrypoint(): string {
  // Bundled CLI and library use the sibling asset. Source-based Hub tests/dev
  // use the installed build; no TypeScript loader or public CLI is spawned.
  const candidates = [join(HERE, "graph-candidate.js"), join(HERE, "../../dist/graph-candidate.js")];
  const entrypoint = candidates.find((path) => existsSync(path));
  if (!entrypoint) throw new GraphCandidateProcessError("failed", { reason: "entrypoint-missing" });
  return entrypoint;
}

/** Construct only the parent's candidate. Lease and publication stay in maintenance. */
export async function runGraphCandidateProcess(options: GraphCandidateProcessOptions): Promise<BuildResult> {
  if (options.signal?.aborted) throw new GraphCandidateProcessError("cancelled");
  const workspace = mkdtempSync(join(tmpdir(), "mex-graph-candidate-"));
  const workspaceIdentity = identity(workspace);
  try {
    const request: GraphCandidateRequest = {
      version: 1,
      operation: options.operation,
      projectRoot: options.projectRoot,
      candidatePath: options.candidatePath,
      workspace,
      workspaceIdentity,
      mexIdentity: identity(dirname(options.candidatePath)),
    };
    return await superviseCandidate(options, request);
  } finally {
    // Never remove a replaced/symlinked directory. Wait for `close` (not just an
    // IPC result or `exit`) before deleting anything: SQLite/WASM may hold files
    // until the OS has closed the child's handles, particularly on Windows.
    if (!sameDirectory(workspace, workspaceIdentity)) throw new GraphCandidateProcessError("unsafe");
    rmSync(workspace, { recursive: true, force: false });
  }
}

function superviseCandidate(options: GraphCandidateProcessOptions, request: GraphCandidateRequest): Promise<BuildResult> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const stderr = boundedWorkerDiagnostic();
    const heap = graphWorkerHeap({ totalBytes: totalmem(), freeBytes: freemem(),
      defaultHeapMb: Math.ceil(getHeapStatistics().heap_size_limit / 1024 ** 2),
      nodeOptions: process.env.NODE_OPTIONS, execArgv: process.execArgv });
    let child: ChildProcess;
    try {
      // --expose-gc lets extraction collect each released compiler program.
      child = spawn(process.execPath, [...heap.args, "--expose-gc", options.__internal?.entrypoint ?? candidateEntrypoint()], {
        cwd: options.projectRoot,
        env: { ...process.env, ...phaseTimingsWorkerEnv(), MEX_TELEMETRY: "0", DO_NOT_TRACK: "1" },
        // FD 4 is a lifeline. A watchdog in the child observes EOF even while
        // its main thread is inside synchronous TypeScript or SQLite work.
        // Overlapped enables asynchronous reads on the inherited Windows
        // lifeline handle; it is identical to `pipe` on Unix.
        stdio: ["ignore", "ignore", "pipe", "ipc", "overlapped"],
        serialization: "json",
        windowsHide: true,
      });
    } catch (error) {
      reject(error instanceof GraphCandidateProcessError ? error : new GraphCandidateProcessError("failed", {
        reason: "spawn", stderr: boundedDiagnosticText(error instanceof Error ? error.message : String(error)),
      }));
      return;
    }
    let ready = false;
    let result: BuildResult | undefined;
    let failure: GraphCandidateProcessError | undefined;
    let lastProgress: GraphCandidateProgress | undefined;
    const sentSignals = new Set<NodeJS.Signals>();
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
    const fail = (reason: GraphCandidateProcessDiagnostic["reason"], category: GraphCandidateProcessError["category"] = "failed") =>
      new GraphCandidateProcessError(category, { reason });
    const kill = (signal: NodeJS.Signals) => {
      if (child.kill(signal)) sentSignals.add(signal);
    };
    let terminateTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: GraphCandidateProcessError) => {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      terminateTimer = setTimeout(() => kill("SIGKILL"), TERMINATE_GRACE_MS);
      terminateTimer.unref();
    };
    const cancelled = () => stop(fail("cancelled", "cancelled"));
    const parentExit = () => child.kill("SIGKILL");
    const startupTimer = setTimeout(() => stop(fail("startup-timeout")), options.__internal?.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
    const buildTimer = setTimeout(
      () => stop(fail("build-timeout")),
      options.__internal?.buildTimeoutMs ?? BUILD_TIMEOUT_MS,
    );
    startupTimer.unref();
    buildTimer.unref();
    process.once("exit", parentExit);
    options.signal?.addEventListener("abort", cancelled, { once: true });
    child.on("error", (error) => {
      stderr.append(Buffer.from(`${error.name}: ${error.message}\n`));
      stop(fail("spawn"));
    });
    child.on("disconnect", () => {
      // A live parent keeps FD4 open, so the parent-death watchdog cannot help
      // when only IPC is lost. A disconnected writer without a terminal result
      // must be stopped promptly instead of holding the lease until timeout.
      if (!result && !failure) stop(fail("ipc-disconnected"));
    });
    child.on("message", (raw: unknown) => {
      if (failure) return;
      const message = boundedCandidateMessage(raw);
      if (!message || result) return stop(fail("protocol"));
      if (message.type === "ready") {
        if (ready) return stop(fail("protocol"));
        ready = true;
        clearTimeout(startupTimer);
        child.send(request, (error) => { if (error) stop(fail("ipc-disconnected")); });
      } else if (!ready) {
        stop(fail("protocol"));
      } else if (message.type === "progress") {
        lastProgress = message.progress;
        try {
          options.onProgress?.(message.progress);
        } catch (error) {
          stderr.append(Buffer.from(`Graph progress observer failed: ${boundedDiagnosticText(error instanceof Error ? error.message : String(error))}\n`));
          stop(fail("observer"));
        }
      } else if (message.type === "complete") {
        result = message.result;
      } else {
        stop(fail("worker-error", message.category));
      }
    });
    child.once("close", (code, signal) => {
      clearTimeout(startupTimer);
      clearTimeout(buildTimer);
      if (terminateTimer) clearTimeout(terminateTimer);
      process.removeListener("exit", parentExit);
      options.signal?.removeEventListener("abort", cancelled);
      child.stdio[4]?.destroy();
      if (options.signal?.aborted) failure = fail("cancelled", "cancelled");
      if (failure || code !== 0 || signal || !result) {
        let reason = failure?.diagnostic?.reason ?? "exit";
        const diagnosticOutput = stderr.text();
        // An exiting process also disconnects IPC. Preserve the actual crash or
        // exit status instead of blaming a channel that closed as a consequence.
        if (reason === "ipc-disconnected" && (code !== null || (signal && !sentSignals.has(signal)))) reason = "exit";
        reject(new GraphCandidateProcessError(failure?.category ?? "failed", {
          reason, exitCode: code, signal, heapMb: heap.heapMb, totalMemoryMb: heap.totalMemoryMb, freeMemoryMb: heap.freeMemoryMb,
          ...(reason !== "exit" && signal && sentSignals.has(signal) ? { supervisorSignal: signal } : {}),
          elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
          ...(lastProgress ? { progress: lastProgress } : {}),
          ...(reason === "exit" && stderr.heapLimit()
            ? { resourceFailure: "heap-limit" as const } : {}),
          ...(diagnosticOutput ? { stderr: diagnosticOutput } : {}),
        }));
      } else resolve(result);
    });
    try {
      if (child.pid) options.__internal?.onSpawn?.(child.pid, request.workspace);
      if (options.signal?.aborted) cancelled();
    } catch {
      stop(fail("observer"));
    }
  });
}

function boundedDiagnosticText(text: string): string {
  const plain = text.slice(0, GRAPH_CANDIDATE_DIAGNOSTIC_BYTES * 4)
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
  return Buffer.from(plain).subarray(0, GRAPH_CANDIDATE_DIAGNOSTIC_BYTES).toString("utf8").replace(/\uFFFD$/u, "").trim();
}

/** Drain all stderr while retaining a bounded beginning and end, including fatal runtime output. */
function boundedWorkerDiagnostic(): { append: (chunk: Buffer) => void; text: () => string; heapLimit: () => boolean } {
  const marker = "\n[worker diagnostics truncated]\n";
  const headLimit = 2048;
  const tailLimit = GRAPH_CANDIDATE_DIAGNOSTIC_BYTES - headLimit - Buffer.byteLength(marker);
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let truncated = false;
  let heapLimit = false;
  let markerTail = "";
  return {
    append(chunk) {
      // Keep the fixed fatal hint even if verbose startup/crash output pushes
      // its line out of the retained head/tail. No raw content enters the hint.
      const markerText = markerTail + chunk.toString("utf8");
      heapLimit ||= NODE_HEAP_FAILURE.test(markerText);
      markerTail = markerText.slice(-256);
      const headBytes = Math.min(chunk.length, headLimit - head.length);
      if (headBytes) head = Buffer.concat([head, chunk.subarray(0, headBytes)]);
      const rest = chunk.subarray(headBytes);
      if (tail.length + rest.length > tailLimit) truncated = true;
      // Slice before concatenating: a single oversized write must not expand retained memory.
      tail = Buffer.concat([tail, rest.subarray(Math.max(0, rest.length - tailLimit))]).subarray(-tailLimit);
    },
    text: () => boundedDiagnosticText(head.toString("utf8") + (truncated ? marker : "") + tail.toString("utf8")),
    heapLimit: () => heapLimit,
  };
}

function diagnosticMessage(diagnostic: GraphCandidateProcessDiagnostic): string {
  const descriptions: Record<GraphCandidateProcessDiagnostic["reason"], string> = {
    "entrypoint-missing": "The graph worker executable is missing from this MEX installation",
    spawn: "The graph worker could not start",
    "startup-timeout": "The graph worker did not become ready before its startup deadline",
    "build-timeout": "The graph worker exceeded its graph construction deadline",
    protocol: "The graph worker returned an invalid or out-of-order response",
    "ipc-disconnected": "The graph worker lost its parent communication channel",
    "worker-error": "The graph worker reported an error",
    exit: "The graph worker exited without a valid completed result",
    observer: "Graph worker supervision could not continue",
    cancelled: "Graph candidate construction was cancelled",
  };
  const details: string[] = [];
  if (diagnostic.exitCode !== undefined && diagnostic.exitCode !== null) details.push(`exit code ${diagnostic.exitCode}`);
  if (diagnostic.signal && diagnostic.signal !== diagnostic.supervisorSignal) details.push(`signal ${diagnostic.signal}`);
  if (diagnostic.elapsedMs !== undefined) details.push(`${(diagnostic.elapsedMs / 1000).toFixed(1)}s elapsed`);
  if (diagnostic.progress) {
    const { phase, completed, total } = diagnostic.progress;
    details.push(`last progress: ${phase}${completed === undefined ? "" : ` ${completed}${total === undefined ? "" : `/${total}`} files`}`);
  }
  const description = diagnostic.resourceFailure === "heap-limit"
    ? graphHeapRecovery(diagnostic).replace(/\.$/u, "") : descriptions[diagnostic.reason];
  return `${description}${details.length ? ` (${details.join("; ")})` : ""}.${diagnostic.stderr ? `\nWorker diagnostics:\n${boundedDiagnosticText(diagnostic.stderr)}` : ""}`;
}
