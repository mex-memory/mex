import crossSpawn from "cross-spawn";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { AgentCommand, BackgroundAgentTool } from "../agent-command.js";
import { createCallUsage, recordModelCall, warnUsageFailure } from "../record/usage.js";
import { acquireModelAdmission, type AutomaticModelBatch, type ModelAdmission } from "./budget-queue.js";
import type { ConsentedModelBatch } from "./consent.js";
import { createPopulationActivityDecoder, USAGE_LIMIT_PATTERN, usageLimitResetTime, type PopulationActivitySignal, type PopulationAgentUsage } from "./activity.js";
import { createPopulationTranscriptDecoder, type PopulationTranscriptSignal } from "./transcript.js";
import { ModelRunError, type ModelFailure } from "./errors.js";

export const MAX_PROCESS_TIMEOUT_MS = 15 * 60_000;
const TERMINATE_GRACE_MS = 500;
const DIAGNOSTIC_BYTES = 8 * 1024;
const DISCOVERY_TIMEOUT_MS = 5_000;
export interface ModelProcessOptions {
  prompt: string;
  purpose: string;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  maxLineBytes?: number;
  requestedModel?: string;
  automatic?: AutomaticModelBatch;
  consented?: ConsentedModelBatch;
  executionDirectory?: string;
  queueTimeoutMs?: number;
  onStdoutChunk?: (chunk: Buffer) => void;
  onActivity?: (activity: PopulationActivitySignal & { tool: BackgroundAgentTool }) => void;
  onTranscript?: (entry: PopulationTranscriptSignal & { tool: BackgroundAgentTool }) => void;
  onUsage?: (usage: PopulationAgentUsage) => void;
  __internal?: { spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess; onSpawn?: (pid: number) => void };
}
export interface ModelProcessResult { usage: ReturnType<ReturnType<typeof createCallUsage>["finish"]>; }

export async function runModelProcess(
  tool: BackgroundAgentTool,
  invocation: AgentCommand,
  cwd: string,
  options: ModelProcessOptions,
): Promise<ModelProcessResult> {
  const modelIndex = invocation.args.indexOf("--model");
  const model = options.requestedModel ?? (modelIndex >= 0 ? invocation.args[modelIndex + 1] : undefined) ?? "unknown";
  const admission = await acquireModelAdmission({ agent: tool, model, projectPath: cwd, automatic: options.automatic,
    consented: options.consented }, options.signal, options.queueTimeoutMs);
  try { return await runOwnedProcess(tool, invocation, cwd, options, admission); }
  finally { admission?.close(); }
}

function runOwnedProcess(
  tool: BackgroundAgentTool,
  invocation: AgentCommand,
  cwd: string,
  options: ModelProcessOptions,
  admission?: ModelAdmission,
): Promise<ModelProcessResult> {
  if (options.signal?.aborted) return Promise.reject(new ModelRunError("cancelled"));
  const requestedTimeout = options.timeoutMs ?? MAX_PROCESS_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(1, Math.min(MAX_PROCESS_TIMEOUT_MS, requestedTimeout))
    : MAX_PROCESS_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, ...invocation.env, MEX_BACKGROUND: "1" };
      if (options.consented) for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN", "GL_TOKEN"]) delete env[name];
      child = (options.__internal?.spawn ?? crossSpawn)(invocation.command, invocation.args, {
        cwd: options.executionDirectory ?? cwd,
        env,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
        // POSIX process groups include agent-created shell/worker descendants.
        detached: process.platform !== "win32",
      });
    } catch {
      reject(new ModelRunError("launch", tool));
      return;
    }
    const stdout = boundedDiagnostic();
    const stderr = boundedDiagnostic();
    let failure: ModelRunError | undefined;
    let treeCleanup: Promise<void> | undefined;
    let closing = false;
    const emitActivity = (activity: PopulationActivitySignal) => {
      if (closing || failure || options.signal?.aborted) return;
      // An observer must not leave an otherwise healthy child unowned.
      try { options.onActivity?.({ tool, ...activity }); } catch { /* observation only */ }
    };
    const decoder = createPopulationActivityDecoder(tool, emitActivity, options.maxLineBytes);
    const accounting = createCallUsage(tool, options.prompt, options.maxLineBytes, event => admission?.observe(event));
    const transcript = options.onTranscript ? createPopulationTranscriptDecoder(tool, (entry) => {
      if (closing || failure || options.signal?.aborted) return;
      try { options.onTranscript?.({ tool, ...entry }); } catch { /* observation only */ }
    }) : undefined;
    child.stdout?.on("data", (chunk: Buffer) => {
      accounting.write(chunk);
      try { options.onStdoutChunk?.(chunk); } catch { /* observation only */ }
      stdout.append(chunk);
      // Count stdout records even when their type has no visible activity signal.
      if (!closing && !failure && chunk.includes(10)) timer.refresh();
      if (!closing && !failure && !options.signal?.aborted) {
        decoder.write(chunk);
        transcript?.write(chunk);
      }
    });
    let stderrLimit = false;
    let stderrReset: string | undefined;
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
      const text = stderrTail + chunk.toString("utf8");
      stderrLimit ||= USAGE_LIMIT_PATTERN.test(text);
      if (stderrLimit) stderrReset = usageLimitResetTime(text) ?? stderrReset;
      stderrTail = text.slice(-512);
    });
    child.once("spawn", () => emitActivity({ kind: "starting", state: "running" }));
    const stop = (reason: ModelRunError) => {
      if (closing || failure) return;
      failure = reason;
      transcript?.dispose();
      treeCleanup = terminateProcessTree(child);
    };
    const cancelled = () => stop(new ModelRunError("cancelled", tool));
    const parentExit = () => killProcessTreeOnExit(child);
    const timer = setTimeout(() => stop(new ModelRunError("timeout", tool)), timeoutMs);
    timer.unref();
    const wallTimer = options.totalTimeoutMs === undefined ? undefined : setTimeout(() => stop(new ModelRunError("timeout", tool)), Math.max(1, Math.min(MAX_PROCESS_TIMEOUT_MS, options.totalTimeoutMs)));
    wallTimer?.unref();
    process.once("exit", parentExit);
    options.signal?.addEventListener("abort", cancelled, { once: true });
    child.once("error", () => stop(new ModelRunError("launch", tool)));
    child.once("exit", () => {
      // A successful POSIX child must not leave background helpers holding its
      // pipes or editing after the prompt is removed. Windows cancellation uses
      // taskkill while the parent PID is still alive, to retain the tree relation.
      if (!treeCleanup && process.platform !== "win32") treeCleanup = terminateProcessTree(child);
    });
    child.once("close", async (code, signal) => {
      // `close` follows the pipe drains, so a final JSON record without a newline
      // is decoded before observers are detached and the launch promise settles.
      decoder.end();
      transcript?.end();
      closing = true;
      clearTimeout(timer);
      if (wallTimer) clearTimeout(wallTimer);
      options.signal?.removeEventListener("abort", cancelled);
      await treeCleanup;
      process.removeListener("exit", parentExit);
      if (decoder.usage) {
        try { options.onUsage?.(decoder.usage); } catch { /* observation only */ }
      }
      const measured = accounting.finish();
      const incomplete = !!(options.consented || options.automatic) && (!!failure || code !== 0 || !!signal || decoder.failed || !decoder.completed);
      let recorded = true;
      for (const usage of measured.byModel ?? [measured]) {
        const saved = recordModelCall({ ...usage, estimated: usage.estimated || measured.estimated || incomplete, ...(measured.sessionId ? { sessionId: measured.sessionId } : {}), agent: tool, purpose: options.purpose, projectPath: cwd, batchId: admission?.id }, admission ? { home: admission.home } : {});
        recorded = saved && recorded;
      }
      try { admission?.finish({ ...measured, estimated: measured.estimated || incomplete }, recorded); } catch { warnUsageFailure(); }
      if (options.signal?.aborted) reject(new ModelRunError("cancelled", tool));
      else if (failure) reject(failure);
      // A limit notice in a session that still finished cleanly is advisory.
      else if ((decoder.usageLimited || stderrLimit) && (code !== 0 || signal || decoder.failed || !decoder.completed)) {
        reject(new ModelRunError("usage_limit", tool, decoder.resetTime ?? stderrReset));
      } else if (code !== 0 || signal || decoder.failed) {
        reject(new ModelRunError(
          decoder.usageLimited || USAGE_LIMIT_PATTERN.test(stderr.text()) ? "usage_limit" : classifyFailure(stderr.text(), stdout.text()),
          tool,
        ));
      } else if (!decoder.completed) reject(new ModelRunError("protocol", tool));
      else resolve({ usage: measured });
    });
    try {
      if (child.pid) options.__internal?.onSpawn?.(child.pid);
    } catch {
      stop(new ModelRunError("failed", tool));
    }
    if (options.input !== undefined) {
      if (!child.stdin) stop(new ModelRunError("launch", tool));
      else { child.stdin.on("error", () => { /* close classifies an early child exit */ }); child.stdin.end(options.input); }
    }
    if (options.signal?.aborted) cancelled();
  });
}

function boundedDiagnostic(): { append: (chunk: Buffer) => void; text: () => string } {
  const buffer = Buffer.alloc(DIAGNOSTIC_BYTES);
  let length = 0;
  return {
    append: (chunk) => { length += chunk.copy(buffer, length, 0, Math.max(0, buffer.length - length)); },
    text: () => buffer.subarray(0, length).toString("utf8"),
  };
}

function classifyFailure(stderr: string, stdout: string): ModelFailure {
  const text = `${stderr}\n${stdout}`;
  if (/unexpected argument|unknown (?:option|argument)|unrecognized (?:option|argument)/iu.test(text)) return "arguments";
  if (/not (?:logged|signed) in|not authenticated|authentication (?:failed|required)|invalid api key|unauthorized|please (?:log|sign) in/iu.test(text)) return "authentication";
  return "failed";
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}

function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      // cross-spawn may launch an npm .cmd wrapper; killing that wrapper alone
      // leaves Node and its grandchildren running. Never involve a command shell.
      const killer = crossSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore", windowsHide: true, timeout: DISCOVERY_TIMEOUT_MS,
      });
      killer.once("error", () => { child.kill("SIGKILL"); resolve(); });
      killer.once("close", () => { child.kill("SIGKILL"); resolve(); });
    });
  }
  // Do not retain an unnecessary grace timer once the complete group is gone.
  try { process.kill(-child.pid, 0); } catch { return Promise.resolve(); }
  signalProcessGroup(child, "SIGTERM");
  return new Promise((resolve) => {
    setTimeout(() => { signalProcessGroup(child, "SIGKILL"); resolve(); }, TERMINATE_GRACE_MS);
  });
}

function killProcessTreeOnExit(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // Node's exit hook cannot await work. Normal Hub shutdown uses AbortSignal
    // and the asynchronous path; this bounded fallback handles process.exit().
    crossSpawn.sync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore", windowsHide: true, timeout: DISCOVERY_TIMEOUT_MS,
    });
  } else signalProcessGroup(child, "SIGKILL");
}
