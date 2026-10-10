import crossSpawn from "cross-spawn";
import { execFile, type ChildProcess } from "node:child_process";
import { buildAgentCommand } from "../agent-command.js";
import { AI_TOOLS, type AiTool } from "../types.js";
import { createPopulationSession, type SetupAgentTool } from "./population.js";

const DISCOVERY_TIMEOUT_MS = 5_000;
const PROCESS_SNAPSHOT_TIMEOUT_MS = 2_000;
const PROCESS_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_OWNED_PROCESSES = 4_096;
const PROCESS_POLL_MS = 100;
const TERMINATE_GRACE_MS = 500;

export interface InteractivePopulationResult {
  readonly tool: SetupAgentTool | null;
  /** A clean agent exit is not confirmation that setup is complete. */
  readonly status: "exited" | "failed" | "cancelled" | "unavailable";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly message?: string;
}

interface ProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly started: string;
}

export interface InteractivePopulationOptions {
  readonly selectedTools: readonly AiTool[];
  readonly prompt: string;
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  /** Local subprocess test seams, never accepted from a setup request. */
  readonly __internal?: {
    readonly isAvailable?: (command: string) => Promise<boolean>;
    readonly spawn?: typeof crossSpawn;
    readonly snapshot?: () => Promise<readonly ProcessIdentity[] | null>;
    readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  };
}

/** Hand the existing terminal to the agent; the caller suspends and resumes its UI. */
export async function launchInteractiveSetupPopulation(
  options: InteractivePopulationOptions,
): Promise<InteractivePopulationResult> {
  let tool: SetupAgentTool | null = null;
  const outcome = (status: InteractivePopulationResult["status"], message: string): InteractivePopulationResult => ({
    tool, status, exitCode: null, signal: null, message,
  });
  if (options.signal?.aborted) return outcome("cancelled", "AI population was cancelled. You can resume setup when ready.");

  for (const candidate of options.selectedTools) {
    if (candidate !== "claude" && candidate !== "codex") continue;
    let available: boolean;
    try {
      available = await (options.__internal?.isAvailable ?? ((command) => isAvailable(command, options.signal)))(AI_TOOLS[candidate].cli!);
    } catch {
      return outcome(options.signal?.aborted ? "cancelled" : "failed", options.signal?.aborted
        ? "AI population was cancelled. You can resume setup when ready."
        : "MEX could not check the selected AI CLI. Check its installation and PATH, then resume setup.");
    }
    if (options.signal?.aborted) return outcome("cancelled", "AI population was cancelled. You can resume setup when ready.");
    if (available) { tool = candidate; break; }
  }
  if (!tool) return outcome("unavailable", "No selected interactive AI CLI is available. Install and sign in to a selected CLI, then resume setup.");

  let session: ReturnType<typeof createPopulationSession>;
  try {
    session = createPopulationSession(options.prompt, options.projectRoot);
  } catch {
    return outcome("failed", "The private setup population prompt could not be prepared. Check .mex/local permissions and available disk space, then resume setup.");
  }

  let result: InteractivePopulationResult;
  try {
    result = await runInteractiveAgent(tool, session.instruction, session.root, options);
  } finally {
    // Cleanup happens only after process cleanup, including cancellation escalation.
    try { session.cleanup(); }
    catch {
      result = outcome(options.signal?.aborted ? "cancelled" : "failed", "The private setup prompt could not be removed. Check .mex/local permissions and remove its setup-population folder before resuming setup.");
    }
  }
  return result!;
}

function isAvailable(command: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const child = crossSpawn(process.platform === "win32" ? "where" : "which", [command], {
      stdio: "ignore", windowsHide: true, timeout: DISCOVERY_TIMEOUT_MS, signal,
    });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

function runInteractiveAgent(
  tool: SetupAgentTool,
  instruction: string,
  cwd: string,
  options: InteractivePopulationOptions,
): Promise<InteractivePopulationResult> {
  const name = AI_TOOLS[tool].name;
  const cancelled = (): InteractivePopulationResult => ({ tool, status: "cancelled", exitCode: null, signal: null,
    message: "AI population was cancelled. You can resume setup when ready." });
  if (options.signal?.aborted) return Promise.resolve(cancelled());
  const invocation = buildAgentCommand(tool, instruction, "interactive")!;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = (options.__internal?.spawn ?? crossSpawn)(invocation.command, invocation.args, {
        cwd,
        stdio: "inherit",
        // A detached POSIX child cannot read the foreground terminal normally.
        // Never signal its process group: it shares that group with MEX.
        detached: false,
      });
    } catch {
      resolve({ tool, status: "failed", exitCode: null, signal: null,
        message: `${name} could not start. Check its installation and resume setup.` });
      return;
    }

    let launchFailed = false;
    let cleanupVerified = true;
    let wasCancelled = false;
    let closed = false;
    let cleanup: Promise<void> | undefined;
    const owner = ownProcessTree(child, options);
    const startCleanup = () => owner.stop().then((verified) => { cleanupVerified = verified; }).catch(() => {
      // A cleanup error must not strand the UI waiting for this launch result.
      cleanupVerified = false;
      try { child.kill("SIGKILL"); } catch { /* Already gone. */ }
    });
    const stop = () => {
      if (closed) return;
      wasCancelled = true;
      cleanup ??= startCleanup();
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    child.once("error", () => { launchFailed = true; cleanup ??= startCleanup(); });
    child.once("exit", () => { cleanup ??= startCleanup(); });
    child.once("close", async (exitCode, signal) => {
      closed = true;
      options.signal?.removeEventListener("abort", stop);
      cleanup ??= startCleanup();
      await cleanup;
      const cleanupWarning = "MEX could not verify that the agent's helper processes stopped. Close any remaining agent sessions before resuming setup.";
      if (wasCancelled || options.signal?.aborted || signal === "SIGINT") resolve({ ...cancelled(), exitCode, signal,
        ...(!cleanupVerified ? { message: `AI population was cancelled. ${cleanupWarning}` } : {}) });
      else if (launchFailed) resolve({ tool, status: "failed", exitCode, signal,
        message: `${name} could not start. Check its installation and resume setup.` });
      else if (!cleanupVerified) resolve({ tool, status: "failed", exitCode, signal, message: cleanupWarning });
      else if (exitCode !== 0 || signal) resolve({ tool, status: "failed", exitCode, signal,
        message: `${name} stopped before a clean exit. Review its terminal output and resume setup.` });
      else resolve({ tool, status: "exited", exitCode, signal });
    });
    if (options.signal?.aborted) stop();
  });
}

/**
 * Inherited terminal access precludes the detached group used by headless setup.
 * Track only this child's observed descendants and revalidate identities before
 * signalling individual PIDs. Never adopt siblings or signal the foreground group.
 * A descendant that daemonizes between snapshots cannot safely be rediscovered.
 */
function ownProcessTree(child: ChildProcess, options: InteractivePopulationOptions): { stop: () => Promise<boolean> } {
  const pid = child.pid;
  const snapshot = options.__internal?.snapshot ?? snapshotProcesses;
  const kill = options.__internal?.kill ?? ((target, signal) => { process.kill(target, signal); });
  const owned = new Map<number, ProcessIdentity>();
  let exited = false;
  let stopping = false;
  let refresh: Promise<boolean> | undefined;
  child.once("exit", () => { exited = true; });

  const capture = (): Promise<boolean> => {
    if (refresh) return refresh;
    refresh = (async () => {
      let processes: readonly ProcessIdentity[] | null;
      try { processes = await snapshot(); } catch { return false; }
      if (!processes) return false;
      const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
      for (const [target, identity] of owned) {
        if (byPid.get(target)?.started !== identity.started) owned.delete(target);
      }
      const root = pid ? byPid.get(pid) : undefined;
      if (!exited && root && !owned.has(root.pid)) owned.set(root.pid, root);
      // Reparented descendants remain owned only while their start identity matches.
      const children = new Map<number, ProcessIdentity[]>();
      for (const entry of processes) {
        const siblings = children.get(entry.parentPid) ?? [];
        siblings.push(entry);
        children.set(entry.parentPid, siblings);
      }
      const parents = [...owned.keys()];
      for (let index = 0; index < parents.length && owned.size < MAX_OWNED_PROCESSES; index++) {
        for (const entry of children.get(parents[index]!) ?? []) {
          if (owned.size >= MAX_OWNED_PROCESSES) break;
          if (owned.has(entry.pid) || entry.pid === process.pid) continue;
          owned.set(entry.pid, entry);
          parents.push(entry.pid);
        }
      }
      return owned.size < MAX_OWNED_PROCESSES;
    })().finally(() => { refresh = undefined; });
    return refresh;
  };
  const timer = process.platform !== "win32" && pid ? setInterval(() => { if (!stopping) void capture(); }, PROCESS_POLL_MS) : undefined;
  timer?.unref();
  if (process.platform !== "win32" && pid) void capture();

  const signalOwned = async (signal: NodeJS.Signals) => {
    const refreshed = await capture();
    let verified = refreshed;
    // Descendants first; parents can reap them before they themselves stop.
    for (const target of refreshed ? [...owned.keys()].reverse() : []) {
      if (target === pid || target === process.pid) continue;
      try { kill(target, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") verified = false; }
    }
    if (!exited) {
      try { if (!child.kill(signal)) verified = false; }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") verified = false; }
    }
    return verified;
  };
  return {
    stop: async () => {
      stopping = true;
      if (timer) clearInterval(timer);
      if (!pid) return true;
      if (process.platform === "win32") {
        return exited || await stopWindowsTree(child);
      }
      const terminated = await signalOwned("SIGTERM");
      if (terminated && exited && owned.size === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, TERMINATE_GRACE_MS));
      return await signalOwned("SIGKILL") && terminated;
    },
  };
}

function snapshotProcesses(): Promise<readonly ProcessIdentity[] | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,lstart="], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
      timeout: PROCESS_SNAPSHOT_TIMEOUT_MS, maxBuffer: PROCESS_SNAPSHOT_BYTES, killSignal: "SIGKILL",
    }, (error, stdout) => {
      if (error) { resolve(null); return; }
      const processes: ProcessIdentity[] = [];
      for (const line of stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
        if (match) processes.push({ pid: Number(match[1]), parentPid: Number(match[2]), started: match[3]! });
      }
      resolve(processes);
    });
  });
}

function stopWindowsTree(child: ChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    // Reuse the headless ownership strategy for npm .cmd wrappers on Windows.
    const killer = crossSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore", windowsHide: true, timeout: DISCOVERY_TIMEOUT_MS,
    });
    const done = (verified: boolean) => { try { child.kill("SIGKILL"); } catch { /* Already gone. */ } resolve(verified); };
    killer.once("error", () => done(false));
    killer.once("close", (code) => done(code === 0));
  });
}
