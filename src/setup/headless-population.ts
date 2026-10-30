import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  BACKGROUND_AGENT_CLIS,
  COMMAND_CAPABLE_AGENTS,
  CURSOR_PERMISSIONS_FILE,
  buildAgentCommand,
  cursorSessionPermissionsText,
  isBackgroundAgentTool,
  opencodeSessionConfig,
  type BackgroundAgentTool,
} from "../agent-command.js";
import { AI_TOOLS, type AiTool } from "../types.js";
import {
  createPopulationActivityDecoder,
  USAGE_LIMIT_PATTERN,
  usageLimitResetTime,
  type PopulationActivitySignal,
  type PopulationAgentUsage,
} from "./population-activity.js";
import { createPopulationTranscriptDecoder, type PopulationTranscriptSignal } from "./population-transcript.js";
import { createPopulationSession, SetupPopulationError } from "./population.js";

import { parsePlanState, SETUP_PLAN_STATE_FILE, type SetupPlanState } from "./subsystem-state.js";

/** Probe the single-session pause without repairing an unrelated/corrupt plan. */
export function readSingleUsagePause(projectRoot: string): SetupPlanState | null {
  try {
    const state = parsePlanState(readFileSync(resolve(projectRoot, SETUP_PLAN_STATE_FILE), "utf8")).state;
    return state?.queue?.mode === "single" && state.queue.finalized !== true && state.finalizedAt === undefined
      && state.shared.reason === "usage_limit" ? state : null;
  } catch { return null; }
}

export type { BackgroundAgentTool } from "../agent-command.js";

/** What a background launch reports: the agent that ran (null when none could) and whether it finished. */
export interface HeadlessPopulationLaunchResult {
  readonly tool: BackgroundAgentTool | null;
  readonly completed: boolean;
}

const POPULATION_TIMEOUT_MS = 15 * 60_000;
const TERMINATE_GRACE_MS = 500;
const DIAGNOSTIC_BYTES = 8 * 1024;
const DISCOVERY_TIMEOUT_MS = 5_000;

export interface HeadlessPopulationOptions {
  readonly selectedTools: readonly AiTool[];
  /** Run exactly this agent (still checked for availability); otherwise MEX picks one (see findAvailableSetupAgent). */
  readonly tool?: BackgroundAgentTool;
  /**
   * The prompt tells the agent to run `mex` commands, so only an agent whose
   * session may run the pre-approved ones is eligible (Claude Code, Codex).
   */
  readonly requireCommands?: boolean;
  readonly prompt: string;
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  /** Agent-memory setup supports directories without a Git repository. */
  readonly allowNonGit?: boolean;
  /** The stdout inactivity window; the browser request cannot supply this. */
  readonly timeoutMs?: number;
  /** Fixed activity categories only; never raw agent output or tool arguments. */
  readonly onActivity?: (activity: HeadlessPopulationActivity) => void;
  readonly onTranscript?: (entry: HeadlessPopulationTranscript) => void;
  /** Token counts the agent reported for the session, once, when it closes. */
  readonly onUsage?: (usage: PopulationAgentUsage) => void;
  /** Subprocess test seams, never part of the Hub request contract. */
  readonly __internal?: {
    readonly isAvailable?: (command: string) => Promise<boolean>;
    readonly spawn?: typeof crossSpawn;
    readonly onSpawn?: (pid: number) => void;
  };
}

export type HeadlessPopulationActivity = PopulationActivitySignal & { readonly tool: BackgroundAgentTool };
export type HeadlessPopulationTranscript = PopulationTranscriptSignal & { readonly tool: BackgroundAgentTool };

export type PopulationFailure = "launch" | "arguments" | "authentication" | "usage_limit" | "failed" | "protocol" | "cancelled" | "timeout" | "prompt";

/** Fixed messages only: child output can contain prompts, paths, and secrets. */
export class HeadlessPopulationError extends SetupPopulationError {
  constructor(readonly category: PopulationFailure, readonly tool?: BackgroundAgentTool, readonly resetTime?: string) {
    const name = tool ? AI_TOOLS[tool].name : "The selected AI tool";
    const messages: Record<PopulationFailure, string> = {
      launch: `${name} could not start. Check its installation and try again.`,
      arguments: `${name} rejected the background command. Update the AI CLI and MEX, then try again.`,
      authentication: `${name} could not authenticate. Sign in to its CLI and try again.`,
      usage_limit: `${name} reached its usage limit.${resetTime ? ` Resets ${resetTime}.` : ""} Rerun \`mex setup\` after the limit resets; finished work is kept.`,
      failed: `${name} exited before population completed. Check its CLI configuration and try again.`,
      protocol: `${name} stopped without confirming completion. Review the files and resume setup.`,
      cancelled: "AI population was cancelled. You can resume setup when ready.",
      timeout: "The agent showed no activity for 15 minutes and was stopped. Review the files and resume setup.",
      prompt: "The private setup population prompt could not be prepared or removed safely.",
    };
    super(messages[category]);
    this.name = "HeadlessPopulationError";
  }
}

/** The Hub owns a non-interactive background child and its entire prompt lifetime. */
export async function launchHeadlessSetupPopulation(
  options: HeadlessPopulationOptions,
): Promise<HeadlessPopulationLaunchResult> {
  if (options.signal?.aborted) throw new HeadlessPopulationError("cancelled");
  try {
    const isAvailable = async (command: string) => {
      const available = await (options.__internal?.isAvailable
        ?? ((name) => isAvailableAsync(name, options.signal)))(command);
      if (options.signal?.aborted) throw new HeadlessPopulationError("cancelled");
      return available;
    };
    const choice = options.tool !== undefined
      ? await isAgentUsable(options.tool, options.projectRoot, isAvailable, options.requireCommands === true)
        ? { tool: options.tool, selected: options.selectedTools.includes(options.tool) } : null
      : await findAvailableSetupAgent(options.selectedTools, {
        projectRoot: options.projectRoot, requireCommands: options.requireCommands === true, isAvailable,
      });
    if (choice === null) return { tool: null, completed: false };
    const session = createPopulationSession(options.prompt, options.projectRoot);
    try {
      return { tool: choice.tool, completed: await runHeadlessAgent(choice.tool, session.instruction, session.root, options) };
    } finally {
      session.cleanup();
    }
  } catch (error) {
    if (error instanceof HeadlessPopulationError) throw error;
    // The shared terminal helper retains detailed local errors; browser callers
    // receive only this safe allowlist, without an attached raw error cause.
    throw new HeadlessPopulationError("prompt");
  }
}

/** An agent MEX picked for background setup sessions, and whether the user selected it. */
export interface SetupAgentChoice {
  readonly tool: BackgroundAgentTool;
  readonly selected: boolean;
}

/**
 * Agents tried, in this order, when none of the user's selected agents can run
 * in the background. Cursor is left out: its documented command is the generic
 * name `agent`, which another program on PATH may also use, so MEX runs it only
 * when the user selected Cursor.
 */
const UNSELECTED_FALLBACK_ORDER: readonly BackgroundAgentTool[] = ["claude", "codex", "copilot", "opencode"];

export interface FindSetupAgentOptions {
  readonly projectRoot?: string;
  readonly signal?: AbortSignal;
  /** Only agents whose session may run the pre-approved `mex` commands. */
  readonly requireCommands?: boolean;
  /** Test seam for the PATH lookup. */
  readonly isAvailable?: (command: string) => Promise<boolean>;
}

/**
 * The agent background setup sessions use: the first agent the user selected
 * whose CLI is installed, in the user's order; otherwise any installed
 * supported CLI (`selected: false`, which callers announce in one line);
 * `null` when none is. Selecting no agent at all ("continue without an agent",
 * `--tool none`) is a choice too: then MEX launches nothing.
 */
export async function findAvailableSetupAgent(
  selectedTools: readonly AiTool[],
  options: FindSetupAgentOptions = {},
): Promise<SetupAgentChoice | null> {
  const isAvailable = options.isAvailable ?? ((command: string) => isAvailableAsync(command, options.signal));
  const requireCommands = options.requireCommands === true;
  for (const tool of selectedTools) {
    if (!isBackgroundAgentTool(tool)) continue;
    if (await isAgentUsable(tool, options.projectRoot, isAvailable, requireCommands)) return { tool, selected: true };
  }
  if (selectedTools.length === 0) return null;
  for (const tool of UNSELECTED_FALLBACK_ORDER) {
    if (selectedTools.includes(tool)) continue;
    if (await isAgentUsable(tool, options.projectRoot, isAvailable, requireCommands)) return { tool, selected: false };
  }
  return null;
}

/** One line saying which agent runs the background sessions, when it is not simply the user's first choice. */
export function describeSetupAgentChoice(choice: SetupAgentChoice, selectedTools: readonly AiTool[]): string | null {
  const name = AI_TOOLS[choice.tool].name;
  const first = selectedTools.find((tool) => isBackgroundAgentTool(tool));
  if (choice.selected && (first === undefined || first === choice.tool)) return null;
  const others = selectedTools.filter((tool) => tool !== choice.tool).map((tool) => AI_TOOLS[tool].name);
  const why = others.length === 0
    ? "No agent was selected"
    : `${others.join(", ")} ${others.length === 1 ? "has" : "have"} no CLI MEX can run in the background here`;
  return `${why}, so MEX runs ${name} (\`${BACKGROUND_AGENT_CLIS[choice.tool]}\`) for the setup sessions. To choose another agent, rerun \`mex setup\` and select it.`;
}

async function isAgentUsable(
  tool: BackgroundAgentTool,
  projectRoot: string | undefined,
  isAvailable: (command: string) => Promise<boolean>,
  requireCommands: boolean,
): Promise<boolean> {
  if (requireCommands && !COMMAND_CAPABLE_AGENTS.has(tool)) return false;
  // A user's own Cursor permission file is never edited, so MEX could not restrict the session.
  if (tool === "cursor" && projectRoot !== undefined && !cursorPermissionsUsable(projectRoot)) return false;
  // A user's own inline OpenCode config that is not a JSON object cannot be extended safely.
  if (tool === "opencode" && opencodeSessionConfig() === null) return false;
  return isAvailable(BACKGROUND_AGENT_CLIS[tool]);
}

/**
 * `MEX_SETUP_BACKGROUND_AGENTS=0` makes MEX find no agent CLI on PATH, so it
 * never starts a real agent session (the test suite sets it; injected test
 * seams still work).
 */
export const BACKGROUND_AGENTS_ENV = "MEX_SETUP_BACKGROUND_AGENTS";

function isAvailableAsync(command: string, signal?: AbortSignal): Promise<boolean> {
  if (process.env[BACKGROUND_AGENTS_ENV] === "0") return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = crossSpawn(process.platform === "win32" ? "where" : "which", [command], {
      stdio: "ignore", windowsHide: true, timeout: DISCOVERY_TIMEOUT_MS, signal,
    });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

/** Whether the project's Cursor permission file is absent or exactly the one MEX writes. */
export function cursorPermissionsUsable(projectRoot: string): boolean {
  const path = resolve(projectRoot, CURSOR_PERMISSIONS_FILE);
  if (!existsSync(path)) return true;
  try { return readFileSync(path, "utf8") === cursorSessionPermissionsText(); }
  catch { return false; }
}

/** Sessions holding the MEX-written Cursor permission file, per project. */
const cursorHolds = new Map<string, { count: number; createdDirectory: boolean }>();

/**
 * Put MEX's Cursor permission file in place for one session; the last session
 * of the project removes it (and the `.cursor` folder if MEX created it and it
 * is empty). A file MEX left behind after a crash is recognized by its exact
 * bytes and reused. Returns `null` when the user has their own file.
 */
export function acquireCursorPermissions(projectRoot: string): (() => void) | null {
  const root = resolve(projectRoot);
  const path = resolve(root, CURSOR_PERMISSIONS_FILE);
  let hold = cursorHolds.get(root);
  if (hold === undefined) {
    if (!cursorPermissionsUsable(root)) return null;
    const directory = dirname(path);
    const createdDirectory = !existsSync(directory);
    mkdirSync(directory, { recursive: true });
    if (!existsSync(path)) {
      try { writeFileSync(path, cursorSessionPermissionsText(), { encoding: "utf8", flag: "wx" }); }
      catch { if (!cursorPermissionsUsable(root)) return null; }
    }
    hold = { count: 0, createdDirectory };
    cursorHolds.set(root, hold);
  }
  const held = hold;
  held.count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.count -= 1;
    if (held.count > 0) return;
    cursorHolds.delete(root);
    try {
      if (readFileSync(path, "utf8") === cursorSessionPermissionsText()) rmSync(path, { force: true });
    } catch { /* already gone */ }
    if (held.createdDirectory) {
      try { rmdirSync(dirname(path)); } catch { /* not empty or gone: keep it */ }
    }
  };
}

function runHeadlessAgent(
  tool: BackgroundAgentTool,
  instruction: string,
  cwd: string,
  options: HeadlessPopulationOptions,
): Promise<boolean> {
  if (options.signal?.aborted) return Promise.reject(new HeadlessPopulationError("cancelled"));
  const invocation = buildAgentCommand(tool, instruction, "headless", { allowNonGit: options.allowNonGit });
  if (invocation === null) return Promise.reject(new HeadlessPopulationError("launch", tool));
  let releasePermissions: (() => void) | null = null;
  if (tool === "cursor") {
    releasePermissions = acquireCursorPermissions(cwd);
    if (releasePermissions === null) return Promise.reject(new HeadlessPopulationError("launch", tool));
  }
  const requestedTimeout = options.timeoutMs ?? POPULATION_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(1, Math.min(POPULATION_TIMEOUT_MS, requestedTimeout))
    : POPULATION_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = (options.__internal?.spawn ?? crossSpawn)(invocation.command, invocation.args, {
        cwd,
        ...(invocation.env === undefined ? {} : { env: { ...process.env, ...invocation.env } }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // POSIX process groups include agent-created shell/worker descendants.
        detached: process.platform !== "win32",
      });
    } catch {
      releasePermissions?.();
      reject(new HeadlessPopulationError("launch", tool));
      return;
    }
    const stdout = boundedDiagnostic();
    const stderr = boundedDiagnostic();
    let failure: HeadlessPopulationError | undefined;
    let treeCleanup: Promise<void> | undefined;
    let closing = false;
    const emitActivity = (activity: PopulationActivitySignal) => {
      if (closing || failure || options.signal?.aborted) return;
      // An observer must not leave an otherwise healthy child unowned.
      try { options.onActivity?.({ tool, ...activity }); } catch { /* observation only */ }
    };
    const decoder = createPopulationActivityDecoder(tool, emitActivity);
    const transcript = options.onTranscript ? createPopulationTranscriptDecoder(tool, (entry) => {
      if (closing || failure || options.signal?.aborted) return;
      try { options.onTranscript?.({ tool, ...entry }); } catch { /* observation only */ }
    }) : undefined;
    child.stdout?.on("data", (chunk: Buffer) => {
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
    const stop = (reason: HeadlessPopulationError) => {
      if (closing || failure) return;
      failure = reason;
      transcript?.dispose();
      treeCleanup = terminateProcessTree(child);
    };
    const cancelled = () => stop(new HeadlessPopulationError("cancelled", tool));
    const parentExit = () => killProcessTreeOnExit(child);
    const timer = setTimeout(() => stop(new HeadlessPopulationError("timeout", tool)), timeoutMs);
    timer.unref();
    process.once("exit", parentExit);
    options.signal?.addEventListener("abort", cancelled, { once: true });
    child.once("error", () => stop(new HeadlessPopulationError("launch", tool)));
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
      options.signal?.removeEventListener("abort", cancelled);
      await treeCleanup;
      process.removeListener("exit", parentExit);
      releasePermissions?.();
      if (decoder.usage) {
        try { options.onUsage?.(decoder.usage); } catch { /* observation only */ }
      }
      if (options.signal?.aborted) reject(new HeadlessPopulationError("cancelled", tool));
      else if (failure) reject(failure);
      // A limit notice in a session that still finished cleanly is advisory.
      else if ((decoder.usageLimited || stderrLimit) && (code !== 0 || signal || decoder.failed || !decoder.completed)) {
        reject(new HeadlessPopulationError("usage_limit", tool, decoder.resetTime ?? stderrReset));
      } else if (code !== 0 || signal || decoder.failed) {
        reject(new HeadlessPopulationError(
          decoder.usageLimited || USAGE_LIMIT_PATTERN.test(stderr.text()) ? "usage_limit" : classifyFailure(stderr.text(), stdout.text()),
          tool,
        ));
      } else if (!decoder.completed) reject(new HeadlessPopulationError("protocol", tool));
      else resolve(true);
    });
    try {
      if (child.pid) options.__internal?.onSpawn?.(child.pid);
    } catch {
      stop(new HeadlessPopulationError("failed", tool));
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

function classifyFailure(stderr: string, stdout: string): PopulationFailure {
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
