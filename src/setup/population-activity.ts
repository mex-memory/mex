import type { BackgroundAgentTool } from "../agent-command.js";

export type PopulationActivityKind =
  | "starting" | "started" | "reading" | "searching" | "writing"
  | "running_command" | "delegating" | "working" | "completed" | "failed";
export type PopulationActivityTarget =
  | "architecture" | "stack" | "conventions" | "decisions" | "setup"
  | "router" | "agents" | "patterns";
export interface PopulationActivitySignal {
  readonly kind: PopulationActivityKind;
  readonly state: "running" | "completed" | "failed";
  readonly target?: PopulationActivityTarget;
}

const MAX_LINE_BYTES = 64 * 1024;
const MAX_CONTENT_BLOCKS = 64;
const MAX_TRACKED_TOOLS = 128;
const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 2048;

/** Token counts an agent reported for its session; only the numeric fields, never text. */
export interface PopulationAgentUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly costUsd?: number;
  readonly turns?: number;
}

interface PopulationActivityDecoder {
  write(chunk: Buffer): void;
  end(): void;
  readonly failed: boolean;
  readonly completed: boolean;
  /** The last usage record the agent reported, if any. */
  readonly usage: PopulationAgentUsage | null;
  /** The agent's own final error said its usage limit was reached. */
  readonly usageLimited: boolean;
  readonly resetTime: string | undefined;
}

/** Agents whose JSON event format is not documented: only record counts are used. */
const GENERIC_EVENT_TOOLS: ReadonlySet<BackgroundAgentTool> = new Set(["copilot", "opencode"]);

/** Final provider error text that means the account's usage limit, not a fault of the work. */
export const USAGE_LIMIT_PATTERN = /\busage limit\b|\bhit your (?:usage )?limit\b|\bcredit balance is too low\b|\brate_limit(?:_error)?\b|\brate limit(?:ed| reached| exceeded)\b|\bquota (?:exceeded|reached)\b|\bexceeded your (?:current )?quota\b/iu;

/** Only a time and optional timezone can leave the private provider output. */
export function usageLimitResetTime(text: string): string | undefined {
  const time = /\bresets?\s+(?:(?:at|on)\s+)?((?:\d{1,2}:\d{2}|\d{1,2})(?:\s?[ap]m)?(?:\s*\([A-Za-z_+/-]{1,64}\))?)(?=\s|$|[.,])/iu.exec(text)?.[1];
  if (time) return time;
  const epoch = /\busage limit reached\|(\d{10})\b/iu.exec(text)?.[1];
  return epoch ? new Date(Number(epoch) * 1000).toISOString() : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : undefined;
}

function usageOf(event: Record<string, unknown>): PopulationAgentUsage | null {
  const usage = record(event.usage);
  if (!usage) return null;
  const entries: Array<[keyof PopulationAgentUsage, number | undefined]> = [
    ["inputTokens", count(usage.input_tokens)],
    ["outputTokens", count(usage.output_tokens)],
    ["cachedInputTokens", count(usage.cached_input_tokens) ?? count(usage.cache_read_input_tokens)],
    ["cacheCreationInputTokens", count(usage.cache_creation_input_tokens)],
    ["costUsd", count(event.total_cost_usd)],
    ["turns", count(event.num_turns)],
  ];
  const kept = entries.filter(([, value]) => value !== undefined);
  return kept.length === 0 ? null : Object.fromEntries(kept) as PopulationAgentUsage;
}

/** The provider's own error text of a final failure record, bounded; never forwarded, only matched. */
function errorTextOf(event: Record<string, unknown>): string {
  const content = record(event.message)?.content;
  const blocks = Array.isArray(content) ? content.slice(0, MAX_CONTENT_BLOCKS).map((block) => record(block)?.text) : [];
  const errors = Array.isArray(event.errors) ? event.errors.slice(0, MAX_CONTENT_BLOCKS) : [];
  const parts = [event.result, event.message, record(event.error)?.message, record(event.error)?.type, event.error, ...errors, ...blocks]
    .filter((value): value is string => typeof value === "string");
  return parts.join(" ").slice(0, 4096);
}

/**
 * Decode only allowlisted activity from provider JSONL. No source text, tool
 * arguments, IDs, commands, paths, or reasoning cross this boundary. Oversized
 * records are discarded through their next newline, not truncated into JSON.
 *
 * Protocol references:
 * https://app.unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.301/files/sdk.d.ts
 * https://code.claude.com/docs/en/headless
 * https://code.claude.com/docs/en/agent-sdk/streaming-output
 * https://github.com/openai/codex/blob/main/sdk/typescript/src/items.ts
 * https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts
 * https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs
 * https://cursor.com/docs/cli/reference/output-format
 *
 * GitHub Copilot CLI (`--output-format=json`) and OpenCode (`run --format json`)
 * document only that they print one JSON event per line, not the events
 * themselves. For them every well-formed record counts as activity, and the
 * session completed when the CLI exits with status 0 after printing at least
 * one record; nothing else is read from their records.
 */
export function createPopulationActivityDecoder(
  tool: BackgroundAgentTool,
  onSignal: (signal: PopulationActivitySignal) => void,
): PopulationActivityDecoder {
  const line = Buffer.alloc(MAX_LINE_BYTES);
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const tools = new Map<string, PopulationActivitySignal>();
  let length = 0;
  let oversized = false;
  let ended = false;
  let failed = false;
  let completed = false;
  let usage: PopulationAgentUsage | null = null;
  let usageLimited = false;
  let rateLimitRejected = false;
  let resetTime: string | undefined;
  const checkLimit = (event: Record<string, unknown>) => {
    const text = errorTextOf(event);
    if (event.api_error_status === 429 || USAGE_LIMIT_PATTERN.test(text)) {
      usageLimited = true;
      resetTime = usageLimitResetTime(text) ?? resetTime;
    }
  };

  const fail = () => {
    if (failed) return;
    failed = true;
    onSignal({ kind: "failed", state: "failed" });
  };

  const remember = (id: string, signal: PopulationActivitySignal) => {
    if (!tools.has(id) && tools.size >= MAX_TRACKED_TOOLS) {
      tools.delete(tools.keys().next().value!);
    }
    tools.set(id, signal);
  };

  const toolStarted = (block: Record<string, unknown>) => {
    if (block.type !== "tool_use" || typeof block.name !== "string") return;
    const kind = claudeToolKind(block.name);
    const input = record(block.input);
    const target = kind === "reading" || kind === "writing" ? targetForPath(input?.file_path) : undefined;
    const signal: PopulationActivitySignal = { kind, state: "running", ...(target ? { target } : {}) };
    const id = boundedId(block.id);
    if (id) {
      const previous = tools.get(id);
      // Partial tool input is followed by the full assistant block. Only emit
      // again when it adds a safe target; do not count one call twice.
      if (previous && previous.kind === kind && (!target || previous.target === target)) return;
      remember(id, signal);
    }
    onSignal(signal);
  };

  const claudeRecord = (event: Record<string, unknown>) => {
    if (event.type === "rate_limit_event") {
      const info = record(event.rate_limit_info);
      rateLimitRejected = info?.status === "rejected" && info.overageStatus !== "allowed" && info.overageStatus !== "allowed_warning";
      if (rateLimitRejected) completed = false;
      if (rateLimitRejected && typeof info?.resetsAt === "number" && Number.isFinite(info.resetsAt)
        && info.resetsAt >= 0 && info.resetsAt <= 4_102_444_800) {
        resetTime = new Date(info.resetsAt * 1000).toISOString();
      }
    } else if (event.type === "system" && event.subtype === "init") {
      completed = false;
      onSignal({ kind: "started", state: "running" });
    } else if (event.type === "result") {
      usage = usageOf(event) ?? usage;
      if (event.is_error === true || String(event.subtype).startsWith("error_")) checkLimit(event);
      if (event.is_error === true || (typeof event.subtype === "string" && event.subtype.startsWith("error_"))) fail();
      else if (event.subtype === "success" && !failed) {
        completed = true;
        onSignal({ kind: "completed", state: "completed" });
      }
    } else if (event.type === "stream_event") {
      const partial = record(event.event);
      if (partial?.type === "message_start") onSignal({ kind: "working", state: "running" });
      else if (partial?.type === "content_block_start") {
        const block = record(partial.content_block);
        if (block) toolStarted(block);
      } else if (partial?.type === "content_block_delta") {
        const type = record(partial.delta)?.type;
        if (type === "text_delta" || type === "thinking_delta" || type === "input_json_delta") {
          // The existence of a recognized event proves activity. Its private
          // body is neither inspected nor retained or projected.
          onSignal({ kind: "working", state: "running" });
        }
      }
      // content_block_stop finishes the generated input, not the executed tool.
    } else if (event.type === "assistant" || event.type === "user") {
      if (event.type === "assistant" && event.error !== undefined && event.error !== null) {
        // Other assistant errors are settled by the result record and the exit status.
        checkLimit(event);
        if (usageLimited) fail();
      }
      const content = record(event.message)?.content;
      if (!Array.isArray(content)) return;
      for (const value of content.slice(0, MAX_CONTENT_BLOCKS)) {
        const block = record(value);
        if (!block) continue;
        if (event.type === "assistant") toolStarted(block);
        else if (block.type === "tool_result") {
          const id = boundedId(block.tool_use_id);
          const started = id ? tools.get(id) : undefined;
          if (!id || !started) continue;
          tools.delete(id);
          onSignal({ ...started, state: block.is_error === true ? "failed" : "completed" });
        }
      }
    } else if (event.type === "tool_progress") {
      const id = boundedId(event.tool_use_id);
      const started = id ? tools.get(id) : undefined;
      if (started) onSignal(started);
    }
  };

  const codexRecord = (event: Record<string, unknown>) => {
    if (event.type === "thread.started") {
      completed = false;
      onSignal({ kind: "started", state: "running" });
    } else if (event.type === "turn.started") {
      completed = false;
      onSignal({ kind: "working", state: "running" });
    } else if (event.type === "turn.failed" || event.type === "error") {
      checkLimit(event);
      fail();
    } else if (event.type === "turn.completed") {
      usage = usageOf(event) ?? usage;
      if (!failed) {
        completed = true;
        onSignal({ kind: "completed", state: "completed" });
      }
    } else if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
      const item = record(event.item);
      if (!item) return;
      let kind: PopulationActivityKind;
      switch (item.type) {
        case "command_execution": kind = "running_command"; break;
        case "file_change": kind = "writing"; break;
        case "web_search": kind = "searching"; break;
        case "collab_tool_call": kind = "delegating"; break;
        case "agent_message": case "reasoning":
          onSignal({ kind: "working", state: "running" }); return;
        case "mcp_tool_call":
        case "todo_list": kind = "working"; break;
        // This is a recoverable item error, unlike top-level error/turn.failed.
        case "error": onSignal({ kind: "working", state: "failed" }); return;
        default: return;
      }
      const state = item.status === "failed" || item.status === "declined"
        || (item.type === "command_execution" && typeof item.exit_code === "number" && item.exit_code !== 0)
        ? "failed" : event.type === "item.completed" || item.status === "completed" ? "completed" : "running";
      if (item.type === "file_change" && Array.isArray(item.changes)) {
        const targets = new Set<PopulationActivityTarget | undefined>();
        for (const change of item.changes.slice(0, MAX_CONTENT_BLOCKS)) targets.add(targetForPath(record(change)?.path));
        for (const target of targets) onSignal({ kind, state, ...(target ? { target } : {}) });
        if (targets.size > 0) return;
      }
      onSignal({ kind, state });
    }
  };

  const cursorTool = (event: Record<string, unknown>) => {
    const call = record(event.tool_call);
    if (!call) return;
    const id = boundedId(event.call_id);
    if (event.subtype === "started") {
      const read = record(call.readToolCall);
      const write = record(call.writeToolCall);
      const kind: PopulationActivityKind = read ? "reading" : write ? "writing" : "working";
      const target = targetForPath(record((read ?? write)?.args)?.path);
      const signal: PopulationActivitySignal = { kind, state: "running", ...(target ? { target } : {}) };
      if (id) remember(id, signal);
      onSignal(signal);
    } else if (event.subtype === "completed") {
      const started = id ? tools.get(id) : undefined;
      if (!id || !started) return;
      tools.delete(id);
      const result = record(record(call.readToolCall ?? call.writeToolCall ?? call.function)?.result);
      onSignal({ ...started, state: result && !("success" in result) ? "failed" : "completed" });
    }
  };

  const cursorRecord = (event: Record<string, unknown>) => {
    if (event.type === "system" && event.subtype === "init") {
      completed = false;
      onSignal({ kind: "started", state: "running" });
    } else if (event.type === "assistant") {
      onSignal({ kind: "working", state: "running" });
    } else if (event.type === "tool_call") {
      cursorTool(event);
    } else if (event.type === "result") {
      // The documented terminal record is success only; a failure exits non-zero without one.
      if (event.subtype === "success" && event.is_error !== true && !failed) {
        completed = true;
        onSignal({ kind: "completed", state: "completed" });
      } else fail();
    }
  };

  let records = 0;
  const genericRecord = () => {
    records += 1;
    onSignal(records === 1 ? { kind: "started", state: "running" } : { kind: "working", state: "running" });
  };

  const consumeLine = () => {
    let event: Record<string, unknown> | undefined;
    if (!oversized && length > 0) {
      try { event = record(JSON.parse(utf8.decode(line.subarray(0, length)))); }
      catch { /* Malformed JSON or UTF-8 is not activity. */ }
    }
    line.fill(0, 0, length);
    length = 0;
    oversized = false;
    if (event) {
      if (tool === "claude") claudeRecord(event);
      else if (tool === "codex") codexRecord(event);
      else if (tool === "cursor") cursorRecord(event);
      else genericRecord();
    }
  };

  return {
    get failed() { return failed; },
    // Undocumented event formats: the exit status decides, after at least one record.
    get completed() { return GENERIC_EVENT_TOOLS.has(tool) ? records > 0 && !failed : completed && !failed; },
    get usage() { return usage; },
    get usageLimited() { return usageLimited; },
    get resetTime() { return resetTime; },
    write(chunk) {
      if (ended) return;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(0x0a, start);
        const stop = newline === -1 ? chunk.length : newline;
        const bytes = stop - start;
        if (!oversized) {
          if (length + bytes <= MAX_LINE_BYTES) {
            chunk.copy(line, length, start, stop);
            length += bytes;
          } else oversized = true;
        }
        if (newline === -1) break;
        consumeLine();
        start = newline + 1;
      }
    },
    end() {
      if (ended) return;
      ended = true;
      consumeLine();
      // Status notifications are advisory when the session ultimately succeeds
      // (for example it switched to overage). A rejected session without a
      // successful result is resumable, including when no result was emitted.
      if (rateLimitRejected && (!completed || failed)) {
        usageLimited = true;
        fail();
      }
      tools.clear();
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function boundedId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : undefined;
}

function claudeToolKind(name: string): PopulationActivityKind {
  switch (name) {
    case "Read": return "reading";
    case "Glob": case "Grep": case "WebSearch": return "searching";
    case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": return "writing";
    case "Bash": return "running_command";
    case "Task": case "Agent": return "delegating";
    default: return "working";
  }
}

function targetForPath(value: unknown): PopulationActivityTarget | undefined {
  if (typeof value !== "string" || value.length > MAX_PATH_LENGTH) return undefined;
  const path = value.replaceAll("\\", "/");
  if (path.split("/").includes("..")) return undefined;
  const context = /(?:^|\/)\.mex\/context\/(architecture|stack|conventions|decisions|setup)\.md$/u.exec(path);
  if (context) return context[1] as PopulationActivityTarget;
  if (/(?:^|\/)\.mex\/ROUTER\.md$/u.test(path)) return "router";
  if (/(?:^|\/)\.mex\/AGENTS\.md$/u.test(path)) return "agents";
  if (/(?:^|\/)\.mex\/patterns\/[^\0]+\.md$/u.test(path)) return "patterns";
  return undefined;
}
