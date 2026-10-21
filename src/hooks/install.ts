/**
 * `mex hooks install | status | remove` for Claude Code.
 *
 * Two files change, both only inside what MEX owns: the marked hook entries in
 * `.claude/settings.json`, and the short managed block in `CLAUDE.md`. Each
 * operation is planned first (pure text in, text out), can be shown as a diff
 * without writing, and is applied atomically per file. Nothing here touches
 * `.mex/`.
 */

import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveContextRoot } from "../context/root.js";
import {
  inspectSettings,
  planInstall,
  planRemove,
  renderDiff,
  type SettingsPlan,
  type SettingsStatus,
} from "./claude-settings.js";
import { describeInstalledCommand, resolveHookCommand, type HookCommand, type ResolveOptions } from "./command.js";
import { planHookInstructionEdit, planHookInstructionRemoval } from "./instructions.js";

export const SETTINGS_RELATIVE = ".claude/settings.json";
export const INSTRUCTIONS_RELATIVE = "CLAUDE.md";
const MAX_FILE_BYTES = 1024 * 1024;

export type HooksProblemCode =
  | "HOOKS_NO_SCAFFOLD"
  | "HOOKS_UNSUPPORTED_TOOL"
  | "HOOKS_NO_COMMAND"
  | "HOOKS_SETTINGS_UNSAFE"
  | "HOOKS_INSTRUCTIONS_UNSAFE";

export class HooksError extends Error {
  constructor(
    readonly code: HooksProblemCode,
    message: string,
  ) {
    super(message);
    this.name = "HooksError";
  }
}

export const SUPPORTED_TOOLS = ["claude"] as const;

export function assertSupportedTool(tool: string | undefined): void {
  if (tool !== undefined && !(SUPPORTED_TOOLS as readonly string[]).includes(tool)) {
    throw new HooksError("HOOKS_UNSUPPORTED_TOOL", `Hooks are only available for: ${SUPPORTED_TOOLS.join(", ")}. "${tool}" is not supported yet.`);
  }
}

interface ReadFile {
  path: string;
  bytes: Uint8Array | null;
}

/** Read a regular file of bounded size; a symlink, a directory or an oversized file is refused, not followed. */
function readRegular(path: string, problem: HooksProblemCode): ReadFile {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, bytes: null };
    throw new HooksError(problem, `${path} cannot be read: ${(error as Error).message}`);
  }
  if (!stat.isFile()) throw new HooksError(problem, `${path} is not a regular file (a symbolic link or directory); MEX will not write through it.`);
  if (stat.size > MAX_FILE_BYTES) throw new HooksError(problem, `${path} is larger than ${MAX_FILE_BYTES} bytes; MEX will not rewrite it.`);
  const fd = openSync(path, "r");
  try {
    if (fstatSync(fd).size > MAX_FILE_BYTES) throw new HooksError(problem, `${path} is larger than ${MAX_FILE_BYTES} bytes; MEX will not rewrite it.`);
    return { path, bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}

const decode = (bytes: Uint8Array | null): string | null => (bytes === null ? null : Buffer.from(bytes).toString("utf8"));

function writeAtomic(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, bytes, { flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export interface HooksPaths {
  projectRoot: string;
  settings: string;
  instructions: string;
}

export function resolveHooksPaths(cwd: string): HooksPaths {
  const root = resolveContextRoot(cwd);
  if (root === null) {
    throw new HooksError("HOOKS_NO_SCAFFOLD", `No MEX scaffold (.mex/) found at or above ${cwd}. Run \`mex setup\` in the project first.`);
  }
  return {
    projectRoot: root.projectRoot,
    settings: join(root.projectRoot, ".claude", "settings.json"),
    instructions: join(root.projectRoot, INSTRUCTIONS_RELATIVE),
  };
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export interface FileChange {
  /** Project-relative display path. */
  relative: string;
  path: string;
  action: "create" | "update" | "remove" | "noop";
  before: string | null;
  after: string | null;
  /** Bytes to write; null when nothing is written. */
  bytes: Uint8Array | null;
  /** True when a removal leaves nothing, so the file itself is deleted. */
  deleteFile?: boolean;
}

export interface HooksPlan {
  operation: "install" | "remove";
  command: HookCommand | null;
  settings: FileChange;
  instructions: FileChange;
  /** Entries in settings.json after the change (install) or deleted by it (remove). */
  entries: number;
}

function settingsChange(paths: HooksPaths, file: ReadFile, plan: SettingsPlan): FileChange {
  if (plan.action === "conflict") throw new HooksError("HOOKS_SETTINGS_UNSAFE", `${SETTINGS_RELATIVE}: ${plan.message}`);
  const before = decode(file.bytes);
  const noop = plan.text === null;
  return {
    relative: SETTINGS_RELATIVE,
    path: paths.settings,
    action: noop ? "noop" : plan.action === "remove" ? "update" : plan.action === "create" ? "create" : "update",
    before,
    after: noop ? before : plan.text,
    bytes: noop ? null : Buffer.from(plan.text!, "utf8"),
  };
}

export function planHooksInstall(cwd: string, options: ResolveOptions = {}): HooksPlan {
  const paths = resolveHooksPaths(cwd);
  const command = resolveHookCommand(options);
  if (command === null) {
    throw new HooksError(
      "HOOKS_NO_COMMAND",
      "Neither `mex-hook` on PATH nor the built hook bundle (dist/hook.js) was found. Install mex globally or build it (`npm run build`), then try again.",
    );
  }
  const settingsFile = readRegular(paths.settings, "HOOKS_SETTINGS_UNSAFE");
  const settings = settingsChange(paths, settingsFile, planInstall(decode(settingsFile.bytes), command.command));

  const instructionsFile = readRegular(paths.instructions, "HOOKS_INSTRUCTIONS_UNSAFE");
  const edit = planHookInstructionEdit(instructionsFile.bytes);
  if (edit.action === "conflict") {
    throw new HooksError("HOOKS_INSTRUCTIONS_UNSAFE", `${INSTRUCTIONS_RELATIVE}: the MEX hooks block markers are malformed (${edit.reason}); fix or delete them and try again.`);
  }
  const instructions: FileChange = {
    relative: INSTRUCTIONS_RELATIVE,
    path: paths.instructions,
    action: edit.action === "noop" ? "noop" : edit.action === "create" ? "create" : "update",
    before: decode(instructionsFile.bytes),
    after: edit.desiredBytes === undefined ? decode(instructionsFile.bytes) : decode(edit.desiredBytes),
    bytes: edit.action === "noop" || edit.desiredBytes === undefined ? null : edit.desiredBytes,
  };
  return { operation: "install", command, settings, instructions, entries: settings.action === "noop" ? 0 : 5 };
}

export function planHooksRemove(cwd: string): HooksPlan {
  const paths = resolveHooksPaths(cwd);
  const settingsFile = readRegular(paths.settings, "HOOKS_SETTINGS_UNSAFE");
  const plan = planRemove(decode(settingsFile.bytes));
  const settings = settingsChange(paths, settingsFile, plan);

  const instructionsFile = readRegular(paths.instructions, "HOOKS_INSTRUCTIONS_UNSAFE");
  const removal = planHookInstructionRemoval(instructionsFile.bytes);
  if (removal.action === "conflict") {
    throw new HooksError("HOOKS_INSTRUCTIONS_UNSAFE", `${INSTRUCTIONS_RELATIVE}: the MEX hooks block markers are malformed (${removal.reason}); fix or delete them and try again.`);
  }
  const instructions: FileChange =
    removal.action === "remove"
      ? {
          relative: INSTRUCTIONS_RELATIVE,
          path: paths.instructions,
          action: removal.empty ? "remove" : "update",
          before: decode(instructionsFile.bytes),
          after: removal.empty ? null : decode(removal.desiredBytes!),
          bytes: removal.empty ? null : removal.desiredBytes!,
          deleteFile: removal.empty === true,
        }
      : { relative: INSTRUCTIONS_RELATIVE, path: paths.instructions, action: "noop", before: decode(instructionsFile.bytes), after: decode(instructionsFile.bytes), bytes: null };
  return { operation: "remove", command: null, settings, instructions, entries: plan.entries };
}

/** The unified diff of everything a plan would write. */
export function renderPlanDiff(plan: HooksPlan): string {
  return [plan.settings, plan.instructions]
    .filter((change) => change.action !== "noop")
    .map((change) => renderDiff(change.relative, change.before, change.after))
    .join("\n\n");
}

/** Write a plan. Each file is replaced atomically; a file that held only MEX's block is deleted. */
export function applyHooksPlan(plan: HooksPlan): void {
  for (const change of [plan.settings, plan.instructions]) {
    if (change.action === "noop") continue;
    if (change.deleteFile) {
      rmSync(change.path, { force: true });
      continue;
    }
    if (change.bytes !== null) writeAtomic(change.path, change.bytes);
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface HooksStatus {
  tool: "claude";
  settingsPath: string;
  settingsExists: boolean;
  settings: SettingsStatus;
  /** What the installed entries run, when they agree. */
  installed: { kind: "bin" | "node" | "unknown"; command: string; target: string | null; exists: boolean | null } | null;
  /** What an install would run now. */
  available: HookCommand | null;
  instructionsPresent: boolean;
  /** installed: every entry present and current; partial: some; outdated: present with another command; none. */
  state: "installed" | "partial" | "outdated" | "broken" | "none" | "unreadable";
}

export function hooksStatus(cwd: string, options: ResolveOptions = {}): HooksStatus {
  const paths = resolveHooksPaths(cwd);
  const available = resolveHookCommand(options);
  const settingsFile = readRegular(paths.settings, "HOOKS_SETTINGS_UNSAFE");
  const settings = inspectSettings(decode(settingsFile.bytes), available?.command ?? null);
  const instructionsFile = readRegular(paths.instructions, "HOOKS_INSTRUCTIONS_UNSAFE");
  const present = planHookInstructionRemoval(instructionsFile.bytes).action === "remove";

  const installedCommand = settings.command ?? settings.entries.find((entry) => entry.command !== null)?.command ?? null;
  const installed = installedCommand === null ? null : { ...describeInstalledCommand(installedCommand), command: installedCommand };
  const counts = { installed: 0, missing: 0, outdated: 0 };
  for (const entry of settings.entries) counts[entry.state] += 1;
  let state: HooksStatus["state"];
  if (settings.parseError !== null) state = "unreadable";
  else if (counts.installed + counts.outdated === 0) state = "none";
  else if (installed?.exists === false) state = "broken";
  else if (counts.missing > 0) state = "partial";
  else if (counts.outdated > 0 || settings.strays > 0) state = "outdated";
  else state = "installed";
  return { tool: "claude", settingsPath: paths.settings, settingsExists: settingsFile.bytes !== null, settings, installed, available, instructionsPresent: present, state };
}
