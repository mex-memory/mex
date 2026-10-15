/**
 * The hook runner: one Claude Code hook invocation in, at most one JSON
 * document out.
 *
 * It reads the hook payload, decides which event it is, asks the composer for
 * a packet and prints Claude Code's `hookSpecificOutput`. The one rule above
 * the rest: a hook must never fail the agent's turn. Every path out of
 * {@link runHook} is an exit code of 0, and any error becomes silence plus a
 * line in `.mex/local/context-log.jsonl`.
 */

import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfiguredContextConfig } from "../../config.js";
import { loadFlaggedIds } from "../flags.js";
import { loadContextIndex } from "../index-file.js";
import { openGraphReader } from "../graph-reader.js";
import { PACKET_CHAR_LIMIT } from "../packet.js";
import { appendBoundedLine } from "../local-state.js";
import { resolveContextRoot, type ContextRoot } from "../root.js";
import { isValidSessionId, loadInjectedChars, loadShown, loadStats, recordShown, recordStats } from "../session.js";
import { decideBudget } from "./budget.js";
import { diffAgainstHead, diffAgainstHeadAsync, fileSignature, readHead } from "./diff.js";
import {
  composeEdit,
  composeGrep,
  composeRead,
  hitsFromFileList,
  parseGrepLines,
  projectRelative,
  type EventContext,
  type EventOutcome,
  type GrepHit,
} from "./events.js";

export const HOOK_LOG_NAME = "context-log.jsonl";
export const HOOK_LOG_MAX_BYTES = 256 * 1024;
const LOG_TEXT_CHARS = 2000;

/** The events a hook can handle. */
export type HookEvent = "prompt" | "read" | "edit" | "grep" | "bash" | "stop";

export interface HookPayload {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  session_id?: unknown;
  prompt?: unknown;
  cwd?: unknown;
  /** Set by Claude Code when the agent is continuing because a Stop hook blocked. */
  stop_hook_active?: unknown;
}

export interface HookEnvironment {
  /** `CLAUDE_PROJECT_DIR`, when the host set it. */
  projectDir?: string;
  /** Where the process runs. */
  cwd: string;
  /** Disable the semantic recipe (tests; `MEX_HOOK_LEXICAL=1`). */
  lexical?: boolean;
}

export interface HookResult {
  /** Exactly what to print; empty for silence. */
  stdout: string;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Which event a payload is, or null for one MEX has nothing to say about. */
export function classifyHook(payload: HookPayload): HookEvent | null {
  const name = text(payload.hook_event_name);
  if (name === "UserPromptSubmit") return "prompt";
  if (name === "Stop") return "stop";
  if (name !== "PostToolUse") return null;
  switch (text(payload.tool_name)) {
    case "Read":
      return "read";
    case "Edit":
    case "Write":
    case "MultiEdit":
      return "edit";
    case "Grep":
      return "grep";
    case "Bash":
      return "bash";
    default:
      return null;
  }
}

const HOST_EVENT_NAME: Record<Exclude<HookEvent, "stop">, "UserPromptSubmit" | "PostToolUse"> = {
  prompt: "UserPromptSubmit",
  read: "PostToolUse",
  edit: "PostToolUse",
  grep: "PostToolUse",
  bash: "PostToolUse",
};

/** Claude Code's hook output document for injected context. */
export function renderHookOutput(event: Exclude<HookEvent, "stop">, additionalContext: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: HOST_EVENT_NAME[event], additionalContext } });
}

const SEARCH_COMMAND = /(^|[\s|;&(])(rg|grep|egrep|fgrep|ag|ack)(\s|$)|\bgit\s+grep\b/;

/** Output lines that look like `path:line:` from a Bash search command. */
function bashGrepHits(payload: HookPayload, projectRoot: string): GrepHit[] {
  const command = text(object(payload.tool_input)["command"]) ?? "";
  if (!SEARCH_COMMAND.test(command)) return [];
  const response = payload.tool_response;
  const stdout = typeof response === "string" ? response : text(object(response)["stdout"]) ?? "";
  return parseGrepLines(stdout.slice(0, 256 * 1024), projectRoot);
}

/** Hits from the Grep tool, whichever output mode it ran in. */
function grepToolHits(payload: HookPayload, projectRoot: string): GrepHit[] {
  const response = payload.tool_response;
  if (typeof response === "string") return parseGrepLines(response.slice(0, 256 * 1024), projectRoot);
  const body = object(response);
  const content = text(body["content"]);
  if (content !== undefined) return parseGrepLines(content.slice(0, 256 * 1024), projectRoot);
  const names = body["filenames"];
  return Array.isArray(names) ? hitsFromFileList(names.filter((n): n is string => typeof n === "string"), projectRoot) : [];
}

export function appendLog(root: ContextRoot | null, entry: Record<string, unknown>): void {
  if (root === null) return;
  try {
    appendBoundedLine(root.localDir, join(root.localDir, HOOK_LOG_NAME), JSON.stringify({ at: new Date().toISOString(), ...entry }), {
      maxBytes: HOOK_LOG_MAX_BYTES,
    });
  } catch {
    // The log is advisory; nothing about it may reach the agent.
  }
}

export function describeError(error: unknown): string {
  const raw = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return raw.slice(0, 1500);
}

/** Parse the hook payload; anything that is not a JSON object is "no payload". */
export function parsePayload(raw: string): HookPayload | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as HookPayload) : null;
  } catch {
    return null;
  }
}

/** Handle one hook invocation. Never throws; the caller exits 0 whatever this returns. */
export async function runHook(raw: string, env: HookEnvironment): Promise<HookResult> {
  const started = performance.now();
  let root: ContextRoot | null = null;
  let event: HookEvent | null = null;
  try {
    const payload = parsePayload(raw);
    if (payload === null) return { stdout: "" };
    event = classifyHook(payload);
    if (event === null) return { stdout: "" };

    const startDirs = [env.projectDir, text(payload.cwd), env.cwd].filter((d): d is string => d !== undefined && d !== "");
    for (const dir of startDirs) {
      root = resolveContextRoot(dir);
      if (root !== null) break;
    }
    if (root === null) return { stdout: "" };

    const sessionId = isValidSessionId(payload.session_id) ? payload.session_id : null;
    if (event === "stop") {
      const stop = await (await import("./stop.js")).handleStop({ root, sessionId, stopHookActive: payload.stop_hook_active === true });
      appendLog(root, { event: stop.log["blocked"] === true ? "stop-block" : "stop", ms: Math.round(performance.now() - started), ...stop.log });
      return { stdout: stop.stdout };
    }
    // The prompt path needs the Markdown parser and the ranker; tool events never load them.
    let result: Handled = event === "prompt"
      ? await (await import("./prompt.js")).handlePrompt(root, text(payload.prompt) ?? "", sessionId, { lexical: env.lexical === true })
      : await handleTool(root, payload, event, sessionId);
    // The session's injection budget: whole packets while there is room, pointers past it, nothing far past it.
    if (sessionId !== null && result.text.trim() !== "") {
      const budget = loadConfiguredContextConfig(root.scaffoldRoot).sessionBudgetChars;
      const decision = decideBudget({ used: loadInjectedChars(root.localDir, sessionId), budget, text: result.text, pointers: result.pointers ?? [] });
      if (decision.kind === "pointers") result = { ...result, text: decision.text, note: "budget-pointers" };
      else if (decision.kind === "exhausted") result = { ...result, text: "", ids: [], note: "budget-exhausted" };
    }
    const delivered = result.text.trim() !== "";
    if (delivered && sessionId !== null) {
      try {
        recordShown(root.localDir, sessionId, result.remember, new Date(), result.text.length);
      } catch (error) {
        appendLog(root, { event, error: `session state: ${describeError(error)}` });
      }
    } else if (sessionId !== null && result.remember.length > 0) {
      // Nothing was delivered, but a change was checked: remember that so it is not checked again.
      try {
        recordShown(root.localDir, sessionId, result.remember.filter((key) => key.startsWith("diff:")));
      } catch {
        // Forgetting costs one repeated check.
      }
    }
    if (sessionId !== null && result.stats !== undefined) {
      try {
        recordStats(root.localDir, sessionId, result.stats);
      } catch {
        // Forgetting costs one extra git diff.
      }
    }
    appendLog(root, {
      event,
      ms: Math.round(performance.now() - started),
      injected: result.ids.length,
      ids: result.ids,
      chars: result.text.length,
      ...(result.note === undefined ? {} : { note: result.note }),
      ...(delivered ? { text: result.text.slice(0, LOG_TEXT_CHARS) } : {}),
    });
    return { stdout: delivered ? renderHookOutput(event, result.text.slice(0, PACKET_CHAR_LIMIT)) : "" };
  } catch (error) {
    appendLog(root, { event: "error", during: event, ms: Math.round(performance.now() - started), error: describeError(error) });
    return { stdout: "" };
  }
}

export type Handled = EventOutcome & {
  note?: string;
  /** Source-file signatures to remember for the session (see `session.ts`). */
  stats?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

async function handleTool(root: ContextRoot, payload: HookPayload, event: Exclude<HookEvent, "prompt" | "stop">, sessionId: string | null): Promise<Handled> {
  const none = (note: string): Handled => ({ text: "", remember: [], ids: [], note });
  const loaded = loadContextIndex(root.localDir);
  if (loaded.index === null) return none(`no-index:${loaded.state}`);
  if (!loaded.index.entities.some((e) => e.type === "fact")) return none("no-facts");

  // An edit needs the file's diff, which is a process start. Start it now, so it runs
  // while the graph opens and the session loads; and not at all for a file no fact links.
  const input = object(payload.tool_input);
  let edited: { file: string; diff: ReturnType<typeof diffAgainstHeadAsync> } | null = null;
  if (event === "edit") {
    const path = text(input["file_path"]);
    const file = path === undefined ? null : projectRelative(root.projectRoot, path);
    if (file === null) return none("outside-project");
    if (!loaded.index.entities.some((e) => e.type === "fact" && e.code.includes(file))) {
      return { ...none("not-linked"), stats: { [file]: fileSignature(root.projectRoot, file) } };
    }
    edited = { file, diff: diffAgainstHeadAsync(root.projectRoot, [file]) };
  }

  const { reader } = openGraphReader(root.scaffoldRoot);
  try {
    const ctx: EventContext = {
      projectRoot: root.projectRoot,
      localDir: root.localDir,
      index: loaded.index,
      reader,
      shown: sessionId === null ? new Set<string>() : loadShown(root.localDir, sessionId),
      head: readHead(root.projectRoot),
      flagged: loadFlaggedIds(root.localDir),
    };
    switch (event) {
      case "read": {
        const path = text(input["file_path"]);
        const file = path === undefined ? null : projectRelative(root.projectRoot, path);
        if (file === null) return none("outside-project");
        const outcome = composeRead(ctx, { file, offset: number(input["offset"]), limit: number(input["limit"]) });
        return outcome ?? none("no-facts-in-range");
      }
      case "edit": {
        const { file, diff } = edited!;
        const diffs = await diff;
        if (diffs === null) return none("no-diff");
        // The file is now checked as it stands, so a later Bash call need not diff it again.
        const outcome = composeEdit(ctx, { diffs }) ?? none("nothing-touched");
        return { ...outcome, stats: { [file]: fileSignature(root.projectRoot, file) } };
      }
      case "grep": {
        const outcome = composeGrep(ctx, grepToolHits(payload, root.projectRoot));
        return outcome ?? none("no-fact-hits");
      }
      case "bash":
        return handleBash(root, payload, ctx, sessionId);
      default:
        return none("unhandled");
    }
  } finally {
    reader?.close();
  }
}

/**
 * After a Bash call: search hits, and edits made through the shell (sed,
 * formatters, scripts) which never passed an Edit hook.
 *
 * Finding such edits needs `git diff`, a process start. A size-and-mtime
 * signature per linked file, remembered for the session, says whether any file
 * changed since the last check; when none did (most Bash calls) no process is
 * started. The prompt event seeds the signatures, so changes already in the
 * working tree before the session began are not mistaken for the agent's.
 */
function handleBash(root: ContextRoot, payload: HookPayload, ctx: EventContext, sessionId: string | null): Handled {
  const parts: EventOutcome[] = [];
  const grep = ctx.reader === null ? null : composeGrep(ctx, bashGrepHits(payload, root.projectRoot));
  if (grep !== null) parts.push(grep);

  const linkedFiles = [...new Set(ctx.index.entities.filter((e) => e.type === "fact").flatMap((e) => e.code))];
  const current = Object.fromEntries(linkedFiles.map((file) => [file, fileSignature(root.projectRoot, file)]));
  const recorded = sessionId === null ? {} : loadStats(root.localDir, sessionId);
  const moved = linkedFiles.filter((file) => recorded[file] !== current[file]);

  let note = grep === null ? "no-change" : undefined;
  if (moved.length > 0) {
    const diffs = diffAgainstHead(root.projectRoot, moved);
    if (diffs !== null) {
      const edit = composeEdit(ctx, { diffs }, PACKET_CHAR_LIMIT - (grep === null ? 0 : grep.text.length + 2));
      if (edit !== null) parts.push(edit);
      if (edit !== null) note = undefined;
    }
  }
  const outcome: Handled = {
    text: parts.map((p) => p.text).filter((t) => t !== "").join("\n\n"),
    remember: parts.flatMap((p) => p.remember),
    ids: parts.flatMap((p) => p.ids),
    pointers: parts.flatMap((p) => p.pointers ?? []),
    stats: current,
  };
  if (note !== undefined && outcome.text === "") outcome.note = note;
  return outcome;
}
