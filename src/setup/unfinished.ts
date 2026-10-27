/**
 * Making an unfinished setup hard to miss.
 *
 * While setup is unfinished, `mex check`, `mex setup` and the Hub say how far
 * it got and give the one line that continues it. MEX also keeps a short
 * managed block in the agent instruction files it already manages (the root
 * `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.windsurfrules` and
 * `.github/copilot-instructions.md`, when they exist and carry MEX's pointer),
 * so the next agent session sees that setup is unfinished and how to continue.
 * The block is removed when setup completes. MEX never creates one of these
 * files for this, and never touches bytes outside its own markers.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { planManagedBlockEdit } from "../managed-block.js";
import {
  ANCHOR_FILES,
  MEX_ANCHOR_START,
  MEX_SETUP_NOTICE_END,
  MEX_SETUP_NOTICE_START,
  isToolConfigCopy,
  referencesScaffold,
} from "../tool-config.js";
import { MEX_INSTRUCTIONS_START } from "../agent-skills/instructions.js";
import { SETUP_PLAN_STATE_FILE, parsePlanState, type SetupPlanState } from "./subsystem-state.js";

export { MEX_SETUP_NOTICE_END, MEX_SETUP_NOTICE_START };

/** The command an agent runs to continue a setup that `mex setup next` drives. */
export const SETUP_NEXT_COMMAND = "mex setup next";

/**
 * The one prompt a user pastes into an agent that MEX cannot launch itself.
 * Each `mex setup next` call prints pending tasks and the next command.
 */
export const SETUP_HANDOFF_PROMPT = [
  "Set up MEX for this project. In the project folder, run `mex setup next --start` first, then do exactly what it prints.",
  "Repeat until it prints that setup is complete. Run each command on its own.",
].join("\n");

export interface UnfinishedSetup {
  /** Units settled (done or skipped) and units in all. */
  readonly done: number;
  readonly total: number;
  /** `queue`: `mex setup next` drives it; `background`: `mex setup` with an agent CLI. */
  readonly driver: "queue" | "background";
  /** One line: how far it got and the exact command to continue. */
  readonly line: string;
}

/** Settled and total units of a stored plan, as `mex setup next` counts them. */
export function countSetupUnits(state: SetupPlanState): { done: number; total: number } {
  const settled = (unit: { state: string }) => unit.state === "done" || unit.state === "skipped";
  if (state.queue?.mode === "single") return { done: settled(state.shared) ? 1 : 0, total: 1 };
  // Agent units only: MEX writes the navigation itself once they settle.
  const units = [state.shared, ...state.subsystems];
  return { done: units.filter(settled).length, total: units.length };
}

export function unfinishedSetupLine(done: number, total: number, driver: "queue" | "background"): string {
  return driver === "queue"
    ? `MEX setup ${done}/${total}, not finished. To continue, run \`${SETUP_NEXT_COMMAND} --start\` in your agent's chat and do what it prints.`
    : `MEX setup ${done}/${total}, not finished. To continue, run \`mex setup\` (or \`${SETUP_NEXT_COMMAND} --start\` in your agent's chat).`;
}

/**
 * The unfinished setup of this project, or `null` when setup finished or never
 * started a stored plan. Read-only.
 */
export function describeUnfinishedSetup(projectRoot: string): UnfinishedSetup | null {
  const root = resolve(projectRoot);
  if (!existsSync(resolve(root, SETUP_PLAN_STATE_FILE))) return null;
  let state: SetupPlanState | null;
  try { state = readPlanStateReadOnly(root); } catch { return null; }
  if (state === null) return null;
  const { done, total } = countSetupUnits(state);
  if (state.finalizedAt !== undefined || state.queue?.finalized === true) return null;
  if (state.queue !== undefined) return { done, total, driver: "queue", line: unfinishedSetupLine(done, total, "queue") };
  // Background sessions: unfinished until finalize ran (a complete plan from before this record counts as finished).
  if (done === total) return null;
  return { done, total, driver: "background", line: unfinishedSetupLine(done, total, "background") };
}

/** Parse without moving an unreadable file aside (status reads must not write). */
function readPlanStateReadOnly(root: string): SetupPlanState | null {
  return parsePlanState(readFileSync(resolve(root, SETUP_PLAN_STATE_FILE), "utf8")).state;
}

const MAX_NOTICE_PREVIEW_BYTES = 4 * 1024;

/** The managed block, in the file's own line endings. */
export function renderSetupNotice(done: number, total: number, eol: "\n" | "\r\n" = "\n"): string {
  return [
    MEX_SETUP_NOTICE_START,
    `MEX setup is not finished (${done}/${total}). Run \`${SETUP_NEXT_COMMAND} --start\` first and do what it prints; repeat until it says setup is complete.`,
    MEX_SETUP_NOTICE_END,
  ].join(eol);
}

/** Root instruction files that exist and already carry a MEX pointer or block. */
export function managedInstructionFiles(projectRoot: string): string[] {
  const root = resolve(projectRoot);
  return ANCHOR_FILES.filter((anchor) => anchor.format === "markdown").map((anchor) => anchor.path).filter((path) => {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) return false;
    let content: string;
    try { content = readFileSync(absolute, "utf8"); } catch { return false; }
    return content.includes(MEX_SETUP_NOTICE_START) || content.includes(MEX_INSTRUCTIONS_START) || content.includes(MEX_ANCHOR_START)
      || isToolConfigCopy(content) || referencesScaffold(content);
  });
}

/**
 * Write (with `progress`) or remove (with `null`) the managed setup block in
 * every managed instruction file. Returns the files changed. A file whose
 * markers are malformed is left alone.
 */
export function syncSetupNotice(projectRoot: string, progress: { done: number; total: number } | null): string[] {
  const root = resolve(projectRoot);
  const changed: string[] = [];
  for (const path of managedInstructionFiles(root)) {
    const absolute = resolve(root, path);
    let bytes: Buffer;
    try { bytes = readFileSync(absolute); } catch { continue; }
    const desired = progress === null
      ? removeSetupNotice(bytes)
      : planManagedBlockEdit({
        start: MEX_SETUP_NOTICE_START,
        end: MEX_SETUP_NOTICE_END,
        render: (eol) => renderSetupNotice(progress.done, progress.total, eol),
        maxPreviewBytes: MAX_NOTICE_PREVIEW_BYTES,
      }, bytes).desiredBytes ?? null;
    if (desired === null || Buffer.compare(Buffer.from(desired), bytes) === 0) continue;
    try {
      writeFileSync(absolute, desired);
      changed.push(path);
    } catch { /* a read-only file keeps its block; status lines still say how to continue */ }
  }
  return changed;
}

/**
 * The file without MEX's setup block, and without the blank line MEX added
 * before it; `null` when there is no single well-formed block.
 */
export function removeSetupNotice(bytes: Uint8Array): Uint8Array | null {
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return null; }
  const start = content.indexOf(MEX_SETUP_NOTICE_START);
  const end = content.indexOf(MEX_SETUP_NOTICE_END);
  if (start === -1 || end === -1 || end < start
    || content.indexOf(MEX_SETUP_NOTICE_START, start + 1) !== -1 || content.indexOf(MEX_SETUP_NOTICE_END, end + 1) !== -1) return null;
  let before = content.slice(0, start);
  let after = content.slice(end + MEX_SETUP_NOTICE_END.length);
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  if (after.startsWith(eol)) after = after.slice(eol.length);
  // An appended block followed a blank line MEX added; a block MEX wrote into a
  // file's middle was surrounded by the user's own line breaks.
  if (after.length === 0 && before.endsWith(`${eol}${eol}`)) before = before.slice(0, -eol.length);
  return Buffer.from(before + after, "utf8");
}
