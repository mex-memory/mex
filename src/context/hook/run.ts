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

import { statSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { bashReads, bashSearchCwd, bashSearchPattern, bashSearchSegment, shellSegments, shellOutput } from "../../hooks/shell.js";
export { bashSearchPattern } from "../../hooks/shell.js";
import { attributePatch, parseApplyPatch, patchedFiles, type PatchFile } from "../../hooks/patch.js";
import { effectiveSwitches } from "../../hooks/switches.js";
import { loadConfiguredContextConfig } from "../../config.js";
import { loadFlaggedIds } from "../flags.js";
import { loadContextIndex, readBounded } from "../index-file.js";
import type { ContextIndex } from "../types.js";
import { openGraphReader } from "../graph-reader.js";
import { PACKET_CHAR_LIMIT } from "../packet.js";
import { appendBoundedLine } from "../local-state.js";
import { resolveContextRoot, type ContextRoot } from "../root.js";
import { isValidSessionId, loadInjectedChars, loadShown, loadStats, recordShown, recordStats } from "../session.js";
import { afterKnowledge, composeGraphEdit, composeGraphSearch, graphEnabled, GRAPH_MAX_FILES, joinGraph } from "./graph.js";
import { decideBudget } from "./budget.js";
import { diffAgainstHead, diffAgainstHeadAsync, fileSignature, hunksKey, hunksValue, newHunks, readHead, type FileDiff } from "./diff.js";
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
  turn_id?: unknown;
  model?: unknown;
  /** Set by Claude Code when the agent is continuing because a Stop hook blocked. */
  stop_hook_active?: unknown;
}

export interface HookEnvironment {
  /** `CLAUDE_PROJECT_DIR`, when the host set it. */
  projectDir?: string;
  /** Where the process runs. */
  cwd: string;
  host?: "claude" | "codex";
  /** Disable the semantic recipe (tests; `MEX_HOOK_LEXICAL=1`). */
  lexical?: boolean;
  /** The host entry supplies the installed event policy; offline callers may exercise every composer. */
  tools?: { read: boolean; edit: boolean; search: boolean };
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
    case "apply_patch":
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

/** A Bash diff of more files than this is a checkout-wide change (a formatter, a branch switch): no impact note. */
export const BASH_DIFF_MAX_FILES = 200;

/** Commands that only read: their first word, when no segment redirects output into a file. */
const READ_ONLY = new Set([
  "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag", "ack", "ls", "dir", "tree", "wc", "echo", "printf",
  "pwd", "cd", "pushd", "popd", "which", "where", "type", "file", "stat", "du", "df", "sort", "uniq", "cut", "tr", "nl", "diff", "cmp",
  "get-content", "gc", "select-string", "sls", "get-childitem", "gci", "select-object", "set-location",
  "true", "false", "date", "env", "test", "[", "basename", "dirname", "realpath", "readlink", "column", "jq", "od", "xxd", "hexdump",
]);
const GIT_READ_ONLY = new Set(["log", "show", "status", "diff", "grep", "ls-files", "rev-parse", "blame", "branch", "describe", "shortlog", "cat-file", "ls-tree"]);

/**
 * Whether a shell command may have written files. Errs towards yes: only commands made of
 * read-only programs (with no `>` into a file, no `sed -i`, no `find -exec/-delete`) say no.
 * A yes costs one `git diff`; a wrong no misses an impact note.
 */
export function mayWriteFiles(command: string): boolean {
  if (command.trim() === "") return false;
  for (const raw of command.split(/&&|\|\||[;|\n]/)) {
    const segment = raw.replace(/\d?>&\d|\d?>\s*\/dev\/null|\d?>\s*nul\b/gi, "").trim();
    if (segment === "") continue;
    if (/>/.test(segment)) return true;
    const words = segment.split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    const program = (words[0] ?? "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
    if (program === "git") {
      if (!GIT_READ_ONLY.has(words.find((word, i) => i > 0 && !word.startsWith("-")) ?? "")) return true;
      continue;
    }
    if (program === "sed") {
      if (words.some((word) => /^-[A-Za-z]*i/.test(word) || word.startsWith("--in-place"))) return true;
      continue;
    }
    if (program === "find") {
      if (words.some((word) => /^-(exec|execdir|delete|ok|fprint)/.test(word))) return true;
      continue;
    }
    if (program === "awk") continue;
    if (!READ_ONLY.has(program.toLowerCase())) return true;
  }
  return false;
}

/** At most this many files named by one command are diffed. */
export const BASH_NAMED_MAX_FILES = 20;

/**
 * Project files a command names: path-like words (in arguments, or in an inline script such as
 * `p = 'django/db/backends/base/operations.py'`), read relative to the project root and to any
 * directory the command `cd`s into. Only existing files inside the project and outside `.mex/`.
 */
export function commandFiles(projectRoot: string, command: string): string[] {
  const dirs = [projectRoot];
  for (const match of command.matchAll(/(?:^|[\s;&|(])cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) {
    const dir = match[1]!.replace(/^["']|["']$/g, "");
    dirs.push(isAbsolute(dir) || /^\/[a-z]\//i.test(dir) ? dir.replace(/^\/([a-z])\//i, "$1:/") : join(projectRoot, dir));
  }
  const out = new Set<string>();
  for (const match of command.slice(0, 64 * 1024).matchAll(/[\w.@~:\\/-]*[\w-]\.[A-Za-z][A-Za-z0-9]{0,5}\b/g)) {
    const word = match[0].replace(/^\/([a-z])\//i, "$1:/");
    for (const dir of dirs) {
      const file = projectRelative(projectRoot, isAbsolute(word) ? word : join(dir, word));
      if (file === null || out.has(file)) continue;
      try {
        if (statSync(join(projectRoot, file)).isFile()) { out.add(file); break; }
      } catch {
        // Not a file here; try the next directory.
      }
    }
    if (out.size >= BASH_NAMED_MAX_FILES) break;
  }
  return [...out];
}

/** The entries of `diffs` for `files`. */
function only(diffs: ReadonlyMap<string, FileDiff>, files: readonly string[]): Map<string, FileDiff> {
  const fold = (file: string): string => (process.platform === "win32" ? file.toLowerCase() : file);
  const wanted = new Set(files.map(fold));
  return new Map([...diffs].filter(([file]) => wanted.has(fold(file))));
}

/** Output lines that look like `path:line:` from a Bash search command. */
export function bashGrepHits(payload: HookPayload, projectRoot: string, shellCwd = projectRoot): GrepHit[] {
  const command = text(object(payload.tool_input)["command"]) ?? "";
  const segment = bashSearchSegment(command);
  if (segment === null) return [];
  const response = payload.tool_response;
  const stdout = shellOutput(response);
  const cwd = bashSearchCwd(command, shellCwd);
  let bounded = stdout.slice(0, 256 * 1024);
  const mixedSearches = shellSegments(command).filter(part => bashSearchSegment(part) !== null).length > 1;
  const pattern = bashSearchPattern(command);
  if (mixedSearches && /^[\w$]+$/.test(pattern)) {
    const insensitive = /(?:^|\s)-[A-Za-z]*i|--ignore-case/.test(segment);
    const literal = insensitive ? pattern.toLowerCase() : pattern;
    bounded = bounded.split(/\r?\n/).filter(line => (insensitive ? line.toLowerCase() : line).includes(literal)).join("\n");
  }
  const hits = parseGrepLines(bounded, cwd).flatMap(hit => {
    const file = projectRelative(projectRoot, join(cwd, hit.file));
    return file === null ? [] : [{ ...hit, file }];
  });
  const files = commandFiles(cwd, segment);
  if (hits.length > 0) {
    if (!mixedSearches || files.length === 0) return hits;
    const names = new Set(files.map(file => projectRelative(projectRoot, join(cwd, file))));
    return hits.filter(hit => names.has(hit.file));
  }
  if (files.length !== 1) return [];
  const file = projectRelative(projectRoot, join(cwd, files[0]!));
  return file === null ? [] : bounded.split(/\r?\n/).flatMap(line => {
    const match = /^(\d+):/.exec(line);
    return match ? [{ file, line: Number(match[1]) }] : [];
  });
}

/** Hits from the Grep tool, whichever output mode it ran in. */
export function grepToolHits(payload: HookPayload, projectRoot: string): GrepHit[] {
  const response = payload.tool_response;
  const input = object(payload.tool_input);
  const parse = (content: string): GrepHit[] => {
    const bounded = content.slice(0, 256 * 1024);
    const hits = parseGrepLines(bounded, projectRoot);
    if (hits.length) return hits;
    const path = text(input["path"]);
    const file = path ? projectRelative(projectRoot, path) : null;
    return file ? bounded.split(/\r?\n/).flatMap((line) => {
      const match = /^(\d+):/.exec(line);
      return match ? [{ file, line: Number(match[1]) }] : [];
    }) : [];
  };
  if (typeof response === "string") return parse(response);
  const body = object(response);
  const content = text(body["content"]);
  if (content !== undefined) return parse(content);
  const names = body["filenames"];
  return Array.isArray(names) ? hitsFromFileList(names.filter((n): n is string => typeof n === "string"), projectRoot) : [];
}

export function appendLog(root: ContextRoot | null, entry: Record<string, unknown>): void {
  if (root === null) return;
  try {
    appendBoundedLine(root.localDir, join(root.localDir, HOOK_LOG_NAME), JSON.stringify({ at: new Date().toISOString(), host: process.env.MEX_HOOK_HOST === "codex" ? "codex" : "claude", recipe: process.env.MEX_HOOK_LEXICAL === "1" ? "lexical" : "semantic", switches: effectiveSwitches(), ...entry }), {
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
  let host = env.host ?? "claude";
  const log = (entry: Record<string, unknown>) => appendLog(root, { host, recipe: env.lexical ? "lexical" : "semantic", requestedRecipe: env.lexical ? "lexical" : "semantic", switches: { ...effectiveSwitches(), ...(env.tools ?? { read: true, edit: true, search: true }) }, ...entry });
  try {
    const payload = parsePayload(raw);
    if (payload === null) return { stdout: "" };
    host = env.host ?? (typeof payload.turn_id === "string" || payload.tool_name === "apply_patch" ? "codex" : "claude");
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
      const stop = await (await import("./stop.js")).handleStop({ root, sessionId, stopHookActive: payload.stop_hook_active === true, start: { env: { MEX_HOOK_HOST: host, MEX_HOOK_LEXICAL: env.lexical ? "1" : "0" } } });
      log({ event: stop.log["blocked"] === true ? "stop-block" : "stop", ms: Math.round(performance.now() - started), ...stop.log });
      return { stdout: stop.stdout };
    }
    // The prompt path needs the Markdown parser and the ranker; tool events never load them.
    let result: Handled = event === "prompt"
      ? await (await import("./prompt.js")).handlePrompt(root, text(payload.prompt) ?? "", sessionId, { lexical: env.lexical === true })
      : await handleTool(root, payload, event, sessionId, env.tools, host);
    // The session's injection budget: whole packets while there is room, pointers past it, nothing far past it.
    if (sessionId !== null && result.text.trim() !== "") {
      const budget = loadConfiguredContextConfig(root.scaffoldRoot).sessionBudgetChars;
      const used = loadInjectedChars(root.localDir, sessionId);
      // Graph uses only the budget left after knowledge; never turn graph into knowledge pointers.
      if (result.graphChars && used + result.text.length > budget) {
        result = { ...result, text: result.text.slice(0, result.text.length - result.graphChars).trimEnd(),
          remember: result.remember.filter((k) => !k.startsWith("graph:") && !k.startsWith("impact:")), graphNodes: [], graphChars: 0 };
      }
      const decision = decideBudget({ used, budget, text: result.text, pointers: result.pointers ?? [] });
      if (decision.kind === "pointers") result = { ...result, text: decision.text, note: "budget-pointers" };
      else if (decision.kind === "exhausted") result = { ...result, text: "", ids: [], note: "budget-exhausted" };
    }
    const delivered = result.text.trim() !== "";
    if (delivered && sessionId !== null) {
      try {
        recordShown(root.localDir, sessionId, result.remember, new Date(), result.text.length);
      } catch (error) {
        log({ event, error: `session state: ${describeError(error)}` });
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
    log({
      ...(result.recipe ? { recipe: result.recipe } : {}),
      event: event === "bash" && bashSearchSegment(text(object(payload.tool_input)["command"]) ?? "") !== null && shellSegments(text(object(payload.tool_input)["command"]) ?? "").length > 1 ? "search-compound" : event,
      ms: Math.round(performance.now() - started),
      injected: result.ids.length,
      ids: result.ids,
      chars: result.text.length,
      graphNodes: delivered ? result.graphNodes ?? [] : [],
      graphChars: delivered ? result.graphChars ?? 0 : 0,
      ...(delivered && result.graphChars ? { kind: "graph" } : {}),
      ...(result.note === undefined ? {} : { note: result.note }),
      ...(delivered ? { text: result.text.slice(0, LOG_TEXT_CHARS) } : {}),
    });
    return { stdout: delivered ? renderHookOutput(event, result.text.slice(0, PACKET_CHAR_LIMIT)) : "" };
  } catch (error) {
    log({ event: "error", during: event, ms: Math.round(performance.now() - started), error: describeError(error) });
    return { stdout: "" };
  }
}

export type Handled = EventOutcome & {
  note?: string;
  /** Actual prompt recipe, including a semantic-to-lexical fallback. */
  recipe?: "lexical" | "semantic";
  /** Source-file signatures to remember for the session (see `session.ts`). */
  stats?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

async function handleTool(root: ContextRoot, payload: HookPayload, event: Exclude<HookEvent, "prompt" | "stop">, sessionId: string | null, tools = { read: true, edit: true, search: true }, host: "claude" | "codex" = "claude"): Promise<Handled> {
  const none = (note: string): Handled => ({ text: "", remember: [], ids: [], note });
  const loaded = loadContextIndex(root.localDir);
  if (loaded.index === null) return none(`no-index:${loaded.state}`);

  // An edit needs the file's diff, which is a process start. Start it now, so it runs
  // while the graph opens and the session loads. With graph disabled, unlinked files skip it.
  const input = object(payload.tool_input);
  const shellCwd = typeof payload.cwd === "string" && projectRelative(root.projectRoot, join(payload.cwd, "__cwd_check__")) !== null ? payload.cwd : root.projectRoot;
  const shown = sessionId === null ? new Set<string>() : loadShown(root.localDir, sessionId);
  if (event === "read") {
    const path = text(input["file_path"]);
    const file = path === undefined ? null : projectRelative(root.projectRoot, path);
    if (file === null) return none("outside-project");
    if (!loaded.index.entities.some(e => e.type === "fact" && e.code.includes(file) && !shown.has(e.id))) return none("no-unseen-facts");
  }
  if (event === "bash" && !tools.edit && bashSearchSegment(text(input["command"]) ?? "") === null && (!tools.read || bashReads(text(input["command"]) ?? "", root.projectRoot).length === 0)) return none("unsupported-command");
  const patch = event === "edit" && payload.tool_name === "apply_patch" ? parseApplyPatch(text(input["command"]) ?? "", root.projectRoot, shellCwd) : null;
  let patched: { files: string[]; patch: PatchFile[]; diff: ReturnType<typeof diffAgainstHeadAsync> } | null = null;
  if (patch !== null) {
    if (!tools.edit) return none("disabled-edit");
    if (/^Exit code: (?!0(?:\r?\n|$))-?\d+/.test(typeof payload.tool_response === "string" ? payload.tool_response : "")) return none("failed-patch");
    const files = patchedFiles(patch);
    if (!files.length) return none("outside-project");
    if (!graphEnabled() && !loaded.index.entities.some(e => e.type === "fact" && e.code.some(f => files.includes(f)))) return none("not-linked");
    patched = { files, patch, diff: diffAgainstHeadAsync(root.projectRoot, files, true) };
  }
  let edited: { file: string; diff: ReturnType<typeof diffAgainstHeadAsync> } | null = null;
  if (event === "edit" && patch === null) {
    const path = text(input["file_path"]);
    const file = path === undefined ? null : projectRelative(root.projectRoot, path);
    if (file === null) return none("outside-project");
    if (!graphEnabled() && !loaded.index.entities.some((e) => e.type === "fact" && e.code.includes(file))) {
      return { ...none("not-linked"), stats: { [file]: fileSignature(root.projectRoot, file) } };
    }
    edited = { file, diff: diffAgainstHeadAsync(root.projectRoot, [file]) };
  }
  // A Bash call's diff, when it needs one, also starts now.
  const bash = event === "bash" ? planBash(root, payload, loaded.index, sessionId, tools.edit, shellCwd) : null;

  const { reader } = openGraphReader(root.scaffoldRoot);
  try {
    const ctx: EventContext = {
      projectRoot: root.projectRoot,
      localDir: root.localDir,
      index: loaded.index,
      reader,
      shown,
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
        if (patched !== null) {
          const all = await patched.diff;
          if (all === null) return none("no-diff");
          const recorded = sessionId === null ? {} : loadStats(root.localDir, sessionId);
          const fresh = new Map<string, FileDiff>();
          for (const [file, diff] of all) {
            const unseen = newHunks(diff, recorded[hunksKey(file)]);
            const evidence = patched.patch.find(p => p.file === file || p.moveTo === file);
            if (!unseen || !evidence) continue;
            if (evidence.kind !== "delete" && !evidence.moveTo) {
              try { if (projectRelative(root.projectRoot, realpathSync(join(root.projectRoot, file))) === null) continue; } catch { continue; }
            }
            const content = evidence.kind === "delete" || evidence.moveTo ? { text: "" } : readBounded(join(root.projectRoot, file), 4 * 1024 * 1024);
            if (!("text" in content)) continue;
            const attributed = attributePatch(evidence, content.text, diff);
            if (attributed !== null) {
              // Only newly seen HEAD hunks are eligible; attribution narrows their ranges.
              const ranges = attributed.ranges.filter(([a, b]) => unseen.ranges.some(([x, y]) => a <= y && b >= x));
              if (ranges.length) fresh.set(file, { ...attributed, ranges });
            }
          }
          const outcome = afterKnowledge(composeEdit(ctx, { diffs: fresh }), composeGraphEdit(ctx, fresh)) ?? none("nothing-touched");
          return { ...outcome, ...(outcome.text ? {} : { note: all.size === 0 ? "no-change" : "nothing-touched" }),
            stats: { ...Object.fromEntries(patched.files.map(f => [f, fileSignature(root.projectRoot, f)])),
              ...Object.fromEntries([...all].map(([f, d]) => [hunksKey(f), hunksValue(d)])) } };
        }
        const { file, diff } = edited!;
        const diffs = await diff;
        if (diffs === null) return none("no-diff");
        // The file is now checked as it stands, so a later Bash call need not diff it again.
        const outcome = afterKnowledge(composeEdit(ctx, { diffs }), composeGraphEdit(ctx, diffs)) ?? none("nothing-touched");
        // An empty outcome still carries the change's dedup key; it was silent, so say why in the log.
        const note = outcome.text === "" ? { note: diffs.size === 0 ? "no-change" : "nothing-touched" } : {};
        // The hunks this event reported, so a later Bash call does not report them as its own.
        const hunks = Object.fromEntries([...diffs].map(([name, diff]) => [hunksKey(name), hunksValue(diff)]));
        return { ...outcome, ...note, stats: { [file]: fileSignature(root.projectRoot, file), ...hunks } };
      }
      case "grep": {
        const hits = grepToolHits(payload, root.projectRoot);
        const outcome = afterKnowledge(composeGrep(ctx, hits), composeGraphSearch(ctx, hits, text(input["pattern"]) ?? ""));
        return outcome ?? none("no-fact-hits");
      }
      case "bash":
        return await handleBash(root, payload, ctx, bash!, tools, host === "codex");
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
interface BashPlan {
  command: string;
  cwd: string;
  current: Record<string, string>;
  recorded: Record<string, string>;
  moved: string[];
  /** The diff of the named and moved files, started before the graph opens; null when the command names none. */
  diff: Promise<Map<string, FileDiff> | null> | null;
}

/**
 * What a Bash call must check. A command that may write files (a script, an in-place sed) gets
 * one diff of the files it names plus the linked files that moved; the new hunks are what the
 * shell edited, and they get the edit event's impact note. Naming is the cheap evidence: a diff of
 * the whole tree costs about 200 ms on a 7,000-file checkout, a scoped one about 50 ms, so a command
 * that names no file gets no note.
 */
function planBash(root: ContextRoot, payload: HookPayload, index: ContextIndex, sessionId: string | null, edits = true, cwd = root.projectRoot): BashPlan {
  const command = text(object(payload.tool_input)["command"]) ?? "";
  if (!edits) return { command, cwd, current: {}, recorded: {}, moved: [], diff: null };
  const linkedFiles = [...new Set(index.entities.filter((e) => e.type === "fact").flatMap((e) => e.code))];
  const current: Record<string, string> = Object.fromEntries(linkedFiles.map((file) => [file, fileSignature(root.projectRoot, file)]));
  const recorded = sessionId === null ? {} : loadStats(root.localDir, sessionId);
  const moved = linkedFiles.filter((file) => recorded[file] !== current[file]);
  const named = sessionId !== null && graphEnabled() && mayWriteFiles(command) ? commandFiles(root.projectRoot, command) : [];
  return { command, cwd, current, recorded, moved, diff: named.length > 0 ? diffAgainstHeadAsync(root.projectRoot, [...new Set([...named, ...moved])]) : null };
}

async function handleBash(root: ContextRoot, payload: HookPayload, ctx: EventContext, plan: BashPlan, tools: { read: boolean; edit: boolean; search: boolean }, precisePipes = false): Promise<Handled> {
  const { command, current, recorded, moved } = plan;
  const parts: EventOutcome[] = [];
  const hits = tools.search ? bashGrepHits(payload, root.projectRoot, plan.cwd) : [];
  const grep = composeGrep(ctx, hits);
  if (grep !== null) parts.push(grep);
  if (tools.read && grep === null && hits.length === 0) for (const raw of bashReads(command, plan.cwd, precisePipes)) {
    const file = projectRelative(root.projectRoot, resolve(plan.cwd, raw.file));
    if (file === null) continue;
    const read = { ...raw, file };
    if (read.tail !== undefined) {
      const source = readBounded(join(root.projectRoot, read.file), 4 * 1024 * 1024);
      if (!("text" in source)) continue;
      const lines = source.text.split("\n").length - (source.text.endsWith("\n") ? 1 : 0);
      read.offset = Math.max(1, lines - read.tail + 1); read.limit = read.tail;
    }
    const outcome = composeRead(ctx, read);
    if (outcome !== null) { parts.push(outcome); break; }
  }

  const all = plan.diff === null ? null : await plan.diff;
  let impact: EventOutcome | null = null;
  if (all !== null && ctx.reader !== null && all.size <= BASH_DIFF_MAX_FILES) {
    const fresh = new Map<string, FileDiff>();
    for (const [file, diff] of all) {
      const added = file.startsWith(".mex/") ? null : newHunks(diff, recorded[hunksKey(file)]);
      if (added !== null) fresh.set(file, added);
      current[hunksKey(file)] = hunksValue(diff);
    }
    if (fresh.size > 0 && fresh.size <= GRAPH_MAX_FILES) impact = composeGraphEdit(ctx, fresh);
  }
  const shown = impact === null ? ctx.shown : new Set([...ctx.shown, ...impact.remember]);
  const search = composeGraphSearch({ ...ctx, shown }, hits, bashSearchPattern(command));

  const searching = tools.search && bashSearchSegment(command) !== null;
  let note = grep === null ? searching ? hits.length === 0 ? "no-search-hits" : "no-new-search-context" : "no-change" : undefined;
  if (moved.length > 0) {
    const diffs = all === null ? diffAgainstHead(root.projectRoot, moved) : only(all, moved);
    if (diffs !== null) {
      const available = Math.max(0, PACKET_CHAR_LIMIT - parts.reduce((sum, part) => sum + part.text.length + 2, 0));
      const edit = composeEdit(ctx, { diffs }, available);
      if (edit !== null) parts.push(edit);
      if (edit !== null && edit.text !== "") note = undefined;
      else if (grep === null && !searching) note = diffs.size === 0 ? "no-change" : "nothing-touched";
    }
  }
  const outcome: Handled = {
    text: parts.map((p) => p.text).filter((t) => t !== "").join("\n\n"),
    remember: parts.flatMap((p) => p.remember),
    ids: parts.flatMap((p) => p.ids),
    pointers: parts.flatMap((p) => p.pointers ?? []),
    graphNodes: parts.flatMap((p) => p.graphNodes ?? []),
    graphChars: parts.reduce((sum, p) => sum + (p.graphChars ?? 0), 0),
    stats: current,
  };
  if (note !== undefined && outcome.text === "") outcome.note = note;
  const combined = afterKnowledge(outcome, joinGraph(impact, search)) ?? outcome;
  return { ...combined, ...(combined.text ? { note: undefined } : {}), stats: current };
}
