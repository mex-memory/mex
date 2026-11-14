import { createHash, type Hash } from "node:crypto";
import { AI_TOOLS } from "../types.js";
import type { BackgroundAgentTool } from "../agent-command.js";

export type PopulationTranscriptKind = "assistant" | "command" | "file" | "tool" | "notice";
export interface PopulationTranscriptSignal {
  readonly kind: PopulationTranscriptKind;
  readonly text: string;
}

const MAX_LINE_BYTES = 256 * 1024;
const MAX_SIGNAL_CHARACTERS = 4 * 1024;
const MAX_RECORD_CHARACTERS = 64 * 1024;
const MAX_ITEMS = 64;
const MAX_BLOCKS = 64;
const FLUSH_MS = 200;

interface TextFingerprint { length: number; hash: string }
interface PartialText { key: string; length: number; hash: Hash }

/** Assistant prose and fixed tool labels. Completion belongs to the separate decoder. */
export function createPopulationTranscriptDecoder(
  tool: BackgroundAgentTool,
  onSignal: (signal: PopulationTranscriptSignal) => void,
): { write(chunk: Buffer): void; end(): void; dispose(): void } {
  const line = Buffer.alloc(MAX_LINE_BYTES);
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const previous = new Map<string, TextFingerprint>();
  const recentAssistant = new Map<string, true>();
  const seenTools = new Map<string, true>();
  let partial: PartialText | undefined;
  let messageId: string | undefined;
  let length = 0;
  let oversized = false;
  let ended = false;
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let recordCharacters = 0;
  let recordTruncated = false;
  let assistantGroup: string | undefined;
  let lastKind: PopulationTranscriptKind | undefined;
  let assistantTail = "";

  const emit = (kind: PopulationTranscriptKind, text: string) => {
    const safe = sanitizeTranscriptText(text);
    for (let offset = 0; offset < safe.length;) {
      const end = unicodeEnd(safe, offset, Math.min(safe.length, offset + MAX_SIGNAL_CHARACTERS));
      try { onSignal({ kind, text: safe.slice(offset, end) }); }
      catch { /* The transcript is an observer of the owned agent process. */ }
      offset = end;
    }
  };
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const text = pending;
    pending = "";
    if (text) emit("assistant", text);
  };
  const append = (kind: PopulationTranscriptKind, text: unknown) => {
    if (typeof text !== "string" || !text) return;
    let boundedText = text;
    if (recordCharacters >= MAX_RECORD_CHARACTERS) { recordTruncated = true; return; }
    if (boundedText.length > MAX_RECORD_CHARACTERS - recordCharacters) {
      boundedText = boundedText.slice(0, unicodeEnd(boundedText, 0, MAX_RECORD_CHARACTERS - recordCharacters));
      recordTruncated = true;
    }
    recordCharacters += boundedText.length;
    // Preserve split ANSI/key sequences across adjacent text deltas until the
    // batch is emitted. Tool labels contain only fixed application text.
    const safeText = kind === "assistant" ? boundedText : sanitizeTranscriptText(boundedText);
    if (kind !== "assistant") {
      flush();
      emit(kind, safeText);
      lastKind = kind;
      assistantTail = "";
      return;
    }
    lastKind = kind;
    assistantTail = (assistantTail + safeText).slice(-2);
    // Retain no more than one bounded assistant chunk between UI flushes.
    for (let offset = 0; offset < safeText.length;) {
      const end = unicodeEnd(safeText, offset, Math.min(safeText.length, offset + MAX_SIGNAL_CHARACTERS - pending.length));
      const take = end - offset;
      if (take === 0) { flush(); continue; }
      pending += safeText.slice(offset, offset + take);
      offset += take;
      if (pending.length >= MAX_SIGNAL_CHARACTERS) flush();
    }
    if (pending && !timer) {
      timer = setTimeout(flush, FLUSH_MS);
      timer.unref();
    }
  };
  const remember = <T>(map: Map<string, T>, key: string, value: T) => {
    if (!map.has(key) && map.size >= MAX_ITEMS) map.delete(map.keys().next().value!);
    map.set(key, value);
  };
  const beginAssistant = (group: string) => {
    if (lastKind === "assistant" && assistantGroup && assistantGroup !== group && !assistantTail.endsWith("\n\n")) {
      append("assistant", assistantTail.endsWith("\n") ? "\n" : "\n\n");
    }
    assistantGroup = group;
  };
  const cumulative = (kind: PopulationTranscriptKind, key: string | undefined, value: unknown, group?: string) => {
    if (typeof value !== "string" || !value) return;
    if (!key) {
      if (kind === "assistant") beginAssistant(group ?? "current");
      append(kind, value); return;
    }
    const old = previous.get(key);
    const next = fingerprint(value);
    if (old?.length === next.length && old.hash === next.hash) return;
    const prefixMatches = old && value.length >= old.length && digest(value.slice(0, old.length)) === old.hash;
    remember(previous, key, next);
    if (kind === "assistant") beginAssistant(group ?? key);
    append(kind, prefixMatches ? value.slice(old.length) : value);
  };
  const rememberAssistant = (text: string) => remember(recentAssistant, digest(text), true);
  const finishPartial = () => {
    if (!partial) return;
    const hash = partial.hash.copy().digest("hex");
    const fingerprint = { length: partial.length, hash };
    remember(previous, partial.key, fingerprint);
    // A complete assistant envelope can arrive after the following tool block
    // has cleared `partial`. Keep the streamed block's message-bound identity
    // so its prose is not emitted a second time in that envelope.
    remember(previous, `claude-complete:${messageId ?? "current"}:${hash}`, fingerprint);
    remember(recentAssistant, hash, true);
  };
  const toolMarker = (key: string | undefined, kind: "command" | "file" | "tool", label: string) => {
    if (key) {
      if (seenTools.has(key)) return;
      remember(seenTools, key, true);
    }
    append(kind, label);
  };
  const claudeTool = (block: Record<string, unknown>) => {
    if (block.type !== "tool_use") return;
    const key = id(block.id);
    switch (block.name) {
      case "Bash": toolMarker(key, "command", "Ran a command"); break;
      case "Write": case "Edit": case "MultiEdit": case "NotebookEdit":
        toolMarker(key, "file", "Updated a file"); break;
      case "Read": toolMarker(key, "tool", "Read a file"); break;
      case "Grep": case "Glob": toolMarker(key, "tool", "Searched the project"); break;
      case "WebSearch": toolMarker(key, "tool", "Searched the web"); break;
      default: toolMarker(key, "tool", "Used a tool");
    }
  };

  const claude = (event: Record<string, unknown>) => {
    if (event.type === "stream_event") {
      const stream = record(event.event);
      if (stream?.type === "message_start") {
        finishPartial();
        partial = undefined;
        messageId = id(record(stream.message)?.id);
      } else if (stream?.type === "content_block_start") {
        finishPartial();
        partial = undefined;
        const block = record(stream.content_block);
        if (block?.type === "text") {
          const key = `claude:${messageId ?? "current"}:${index(stream.index)}`;
          partial = { key, length: 0, hash: createHash("sha256") };
          if (typeof block.text === "string" && block.text) {
            partial.hash.update(block.text); partial.length += block.text.length;
            beginAssistant(`claude:${messageId ?? "current"}`);
            append("assistant", block.text);
          }
        } else if (block?.type === "tool_use") claudeTool(block);
      } else if (stream?.type === "content_block_delta") {
        const delta = record(stream.delta);
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          if (partial) { partial.hash.update(delta.text); partial.length += delta.text.length; }
          beginAssistant(`claude:${messageId ?? "current"}`);
          append("assistant", delta.text);
        }
      } else if (stream?.type === "content_block_stop") finishPartial();
      return;
    }
    if (event.type === "assistant") {
      const message = record(event.message);
      const blocks = Array.isArray(message?.content) ? message.content.slice(0, MAX_BLOCKS) : [];
      const visible: string[] = [];
      for (const value of blocks) {
        const block = record(value);
        if (block?.type === "text" && typeof block.text === "string") {
          const text = block.text;
          visible.push(text);
          finishPartial();
          const completeKey = `claude-complete:${id(message?.id) ?? "current"}:${digest(text)}`;
          if (!previous.has(completeKey)) {
            const key = partial && id(message?.id) === messageId ? partial.key : undefined;
            cumulative("assistant", key ?? completeKey, text, `claude:${id(message?.id) ?? messageId ?? "current"}`);
            remember(previous, completeKey, fingerprint(text));
          }
          rememberAssistant(text);
        } else if (block?.type === "tool_use") {
          claudeTool(block);
        }
      }
      if (visible.length) rememberAssistant(visible.join(""));
    } else if (event.type === "result" && event.subtype === "success" && event.is_error !== true) {
      const result = text(event.result);
      finishPartial();
      if (result && !recentAssistant.has(digest(result))) {
        beginAssistant("claude:result");
        append("assistant", result);
        rememberAssistant(result);
      }
    }
  };

  const codex = (event: Record<string, unknown>) => {
    if (!["item.started", "item.updated", "item.completed"].includes(String(event.type))) return;
    const item = record(event.item);
    const itemId = id(item?.id);
    if (!item) return;
    const key = (field: string) => itemId ? `${field}:${itemId}` : undefined;
    switch (item.type) {
      case "agent_message": cumulative("assistant", key("assistant"), item.text); break;
      case "command_execution": toolMarker(itemId, "command", "Ran a command"); break;
      case "file_change": toolMarker(itemId, "file", "Updated a file"); break;
      case "mcp_tool_call": case "collab_tool_call": case "tool_call":
        toolMarker(itemId, "tool", "Used a tool"); break;
      case "web_search": toolMarker(itemId, "tool", "Searched the web"); break;
      // Deliberately exclude reasoning, collaboration prompts, user messages,
      // and raw error/session envelopes. Errors already have safe UI messages.
    }
  };

  // Cursor CLI stream-json (https://cursor.com/docs/cli/reference/output-format):
  // assistant messages carry text blocks; tool calls start and complete by call_id.
  const cursor = (event: Record<string, unknown>) => {
    if (event.type === "assistant") {
      const message = record(event.message);
      const blocks = Array.isArray(message?.content) ? message.content.slice(0, MAX_BLOCKS) : [];
      for (const value of blocks) {
        const block = record(value);
        if (block?.type !== "text" || typeof block.text !== "string" || !block.text) continue;
        const hash = digest(block.text);
        if (recentAssistant.has(hash)) continue;
        rememberAssistant(block.text);
        beginAssistant(`cursor:${hash}`);
        append("assistant", block.text);
      }
    } else if (event.type === "tool_call" && event.subtype === "started") {
      const call = record(event.tool_call);
      const key = id(event.call_id);
      if (call?.readToolCall) toolMarker(key, "tool", "Read a file");
      else if (call?.writeToolCall) toolMarker(key, "file", "Updated a file");
      else if (call) toolMarker(key, "tool", "Used a tool");
    } else if (event.type === "result" && event.subtype === "success" && event.is_error !== true) {
      const result = text(event.result);
      if (result && !recentAssistant.has(digest(result))) {
        beginAssistant("cursor:result");
        append("assistant", result);
        rememberAssistant(result);
      }
    }
  };

  // Copilot CLI and OpenCode document no event format: show one fixed notice, never their records.
  let noticed = false;
  const generic = () => {
    if (noticed) return;
    noticed = true;
    append("notice", `${AI_TOOLS[tool].name} is working. Its output format is not documented, so MEX shows its activity but not its messages.`);
  };

  const consumeLine = () => {
    recordCharacters = 0;
    recordTruncated = false;
    let event: Record<string, unknown> | undefined;
    if (!oversized && length) {
      try { event = record(JSON.parse(utf8.decode(line.subarray(0, length)))); } catch { /* Not transcript text. */ }
    }
    // Oversized records are discarded without generating noise for tool output.
    line.fill(0, 0, length);
    length = 0; oversized = false;
    if (event) {
      if (tool === "claude") claude(event);
      else if (tool === "codex") codex(event);
      else if (tool === "cursor") cursor(event);
      else generic();
    }
    if (recordTruncated) {
      flush();
      emit("notice", "A large output record was truncated in the session view.");
    }
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined; pending = ""; partial = undefined;
    previous.clear(); recentAssistant.clear(); seenTools.clear(); line.fill(0); length = 0;
  };
  return {
    write(chunk) {
      if (ended) return;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(0x0a, start);
        const stop = newline === -1 ? chunk.length : newline;
        if (!oversized) {
          if (length + stop - start <= MAX_LINE_BYTES) { chunk.copy(line, length, start, stop); length += stop - start; }
          else oversized = true;
        }
        if (newline === -1) break;
        consumeLine(); start = newline + 1;
      }
    },
    end() {
      if (ended) return;
      ended = true;
      consumeLine(); flush(); clear();
    },
    dispose() { ended = true; clear(); },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function id(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}
function index(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) ? value : 0; }
function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function fingerprint(value: string): TextFingerprint { return { length: value.length, hash: digest(value) }; }
function unicodeEnd(value: string, start: number, end: number): number {
  if (end > start && end < value.length
    && /[\uD800-\uDBFF]/u.test(value[end - 1]!) && /[\uDC00-\uDFFF]/u.test(value[end]!)) return end - 1;
  return end;
}

/** Best-effort recognizable credential masking; normal code and literal HTML stay text. */
function sanitizeTranscriptText(value: string): string {
  return value
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])/gu, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu, "[redacted private key]")
    .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu, "[redacted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/giu, "$1[redacted]")
    .replace(/\b((?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|GH_TOKEN|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gu, "$1[redacted]");
}
