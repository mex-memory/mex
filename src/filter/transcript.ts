import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";
import type { Message } from "./input.js";
import { hash } from "../judge/evidence.js";
import { object } from "../record/usage.js";
import { maskReply, outsideTool } from "./reply-privacy.js";

/** Identify simple file reads without running or interpreting shell programs. */
export function codexRead(call: Record<string, unknown>): { path: string; cwd?: string } | undefined {
  if (typeof call.arguments !== "string" || call.arguments.length > 8192) return undefined;
  let args;
  try { args = object(JSON.parse(call.arguments)); } catch { return undefined; }
  const cwd = typeof args?.workdir === "string" ? args.workdir : undefined;
  const path = args?.file_path ?? args?.path;
  if (call.name === "read_file" && typeof path === "string") return { path };
  if (call.name === "exec_command" && typeof args?.cmd === "string") {
    const read = /^(?:cat(?: --)?|sed -n ['"]\d+(?:,\d+)?p['"]) ([A-Za-z0-9_./-]+)$/u.exec(args.cmd.trim());
    if (read) return { path: read[1]!, cwd: cwd ?? "" };
  }
  return undefined;
}

const TAIL_BYTES = 1024 * 1024;
const SESSION_BYTES = 32 << 20;
const READ_CHUNK_BYTES = 64 << 10;
const TYPED_LIMIT = 1200;
const SHORT_MESSAGE = 300;
const REPLY_TAIL = 600;
const SHORT_MESSAGE_CONTEXT = 12_000;

type TranscriptAgent = "claude" | "codex";
export type ReplyContextMode = "design" | "tail600" | "full" | "none";
export type TranscriptIssue = "unavailable" | "too-large" | "changed" | "invalid-format" | "delivered-notes";
export interface ReplyOption { row: number; option: number; text: string; }
type TranscriptRead<T> = { value: T } | { issue: TranscriptIssue };
type TranscriptMessage = { role: "user" | "assistant"; text: string };
type TranscriptRow = Record<string, unknown>;
type VisitRow = (row: TranscriptRow, message: TranscriptMessage | undefined, offset: number) => void;

// Limit the string before splitting it into code points. Each takes at most two UTF-16 code units.
const typedPrefix = (value: string) => Array.from(value.slice(0, TYPED_LIMIT * 2)).slice(0, TYPED_LIMIT).join("");
const tail = (value: string, limit: number) => Array.from(value.slice(-limit * 2)).slice(-limit).join("");

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  return value.filter(v => v && ["text", "input_text", "output_text"].includes(v.type) && typeof v.text === "string").map(v => v.text).join("\n");
}

function parseRow(line: string): TranscriptRow | "invalid-format" | undefined {
  if (!line.trim()) return;
  try { return object(JSON.parse(line)); } catch { return "invalid-format"; }
}

function messageRow(row: TranscriptRow, agent: TranscriptAgent): TranscriptMessage | "invalid-format" | undefined {
  if (row.isCompactSummary === true || row.isMeta === true) return;
  const payload = object(row.type === "response_item" ? row.payload : row.message);
  if (agent === "codex" && row.type === "response_item"
    && payload?.type !== undefined && payload.type !== "message") return;
  const role = agent === "claude" ? row.type : payload?.role;
  if (role !== "user" && role !== "assistant") {
    if (agent === "codex" && row.type === "response_item" && payload?.type === "message" && typeof role !== "string") return "invalid-format";
    return;
  }
  const blocks = payload?.content;
  if (agent === "claude" && role === "user" && Array.isArray(blocks)
    && blocks.some(block => ["tool_result", "mcp_tool_result", "web_search_tool_result", "web_fetch_tool_result"].some(type => object(block)?.type === type))) return;
  const content = text(blocks);
  return content === undefined ? "invalid-format" : { role, text: content };
}

/** Read only a regular, contained host file, and validate its snapshot before returning data. */
function readTranscript<T>(path: string, agent: TranscriptAgent, read: (fd: number, size: bigint) => TranscriptRead<T>, appending = false): TranscriptRead<T> {
  let fd: number | undefined;
  try {
    const root = realpathSync(agent === "claude" ? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects")
      : join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"));
    const actual = realpathSync(path), within = relative(root, actual), expected = lstatSync(path, { bigint: true });
    if (!path.endsWith(".jsonl") || !within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)
      || !expected.isFile() || expected.isSymbolicLink()) return { issue: "unavailable" };
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino) return { issue: "unavailable" };
    const result = read(fd, before.size);
    const after = fstatSync(fd, { bigint: true });
    if ((!appending && (before.size !== after.size || before.mtimeNs !== after.mtimeNs)) || after.size < before.size) return { issue: "changed" };
    if (!appending) {
      const current = lstatSync(path, { bigint: true });
      if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || realpathSync(path) !== actual) return { issue: "changed" };
    }
    return result;
  } catch { return { issue: "unavailable" }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Path-only memory references use the captured rollout's bounded identity record. */
export function codexRolloutSession(path: string): string | undefined {
  const result = readTranscript<string>(path, "codex", (fd, size) => {
    const head = Buffer.alloc(Math.min(Number(size), READ_CHUNK_BYTES));
    const length = readSync(fd, head, 0, head.length, 0), end = head.subarray(0, length).indexOf(10);
    if (end < 0) return { issue: "invalid-format" };
    const row = parseRow(head.subarray(0, end).toString("utf8"));
    const id = row && row !== "invalid-format" && row.type === "session_meta" ? object(row.payload)?.id : undefined;
    return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(id) ? { value: id } : { issue: "invalid-format" };
  });
  return "value" in result ? result.value : undefined;
}

interface TranscriptTail { body: string; truncated: boolean; start: number; }
function readTail(path: string, agent: TranscriptAgent, maxBytes = TAIL_BYTES, requireFull = false, appending = false): TranscriptRead<TranscriptTail> {
  return readTranscript<TranscriptTail>(path, agent, (fd, size) => {
    if (requireFull && size > BigInt(maxBytes)) return { issue: "too-large" };
    const offset = Math.max(0, Number(size) - maxBytes), bytes = Buffer.alloc(Math.min(Number(size), maxBytes));
    let n = 0;
    while (n < bytes.length) {
      const got = readSync(fd, bytes, n, bytes.length - n, offset + n);
      if (!got) return { issue: "changed" };
      n += got;
    }
    const newline = bytes.indexOf(0x0a);
    const start = offset ? newline < 0 ? bytes.length : newline + 1 : 0;
    return { value: { body: bytes.subarray(start).toString("utf8"), truncated: offset > 0, start: offset + start } };
  }, appending);
}

/** Appending callers take a prefix of the initial size and handle a torn final line themselves. */
export function transcriptTail(path: string, agent: TranscriptAgent, maxBytes = TAIL_BYTES, requireFull = false, appending = false): string | undefined {
  const result = readTail(path, agent, maxBytes, requireFull, appending);
  return "value" in result ? result.value.body : undefined;
}

function scanLines(fd: number, size: number, visit: (line: string, start: number) => TranscriptIssue | undefined): TranscriptIssue | undefined {
  const buffer = Buffer.allocUnsafe(Math.min(size, READ_CHUNK_BYTES));
  const fragments: Buffer[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let lineStart = 0;
  function visitLine(bytes: Buffer): TranscriptIssue | undefined {
    let line: string;
    try { line = decoder.decode(bytes); } catch { return "invalid-format"; }
    return visit(line, lineStart);
  }
  for (let offset = 0; offset < size;) {
    const n = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!n) return "changed";
    offset += n;
    const chunk = buffer.subarray(0, n);
    for (let start = 0; start < n;) {
      const end = chunk.indexOf(0x0a, start);
      if (end === -1) {
        fragments.push(Buffer.from(chunk.subarray(start)));
        break;
      }
      const part = chunk.subarray(start, end);
      const issue = visitLine(fragments.length ? Buffer.concat([...fragments, part]) : part);
      if (issue) return issue;
      lineStart = offset - n + end + 1;
      fragments.length = 0;
      start = end + 1;
    }
  }
  if (fragments.length) return visitLine(Buffer.concat(fragments));
}

function scanSession(path: string, agent: TranscriptAgent, visit: VisitRow): TranscriptIssue | undefined {
  const result = readTranscript(path, agent, (fd, size) => {
    if (size > BigInt(SESSION_BYTES)) return { issue: "too-large" };
    let sawMessage = false;
    const issue = scanLines(fd, Number(size), (line, offset) => {
      const row = parseRow(line);
      if (!row || row === "invalid-format") return row;
      const message = messageRow(row, agent);
      if (message === "invalid-format") return message;
      sawMessage ||= !!message?.text;
      visit(row, message, offset);
    });
    if (issue) return { issue };
    return sawMessage ? { value: undefined } : { issue: "invalid-format" };
  });
  return "issue" in result ? result.issue : undefined;
}

/** A promotion proof comes only from a uniquely matching user message. */
export function typedQuote(path: string, agent: TranscriptAgent, quote: string, messageHash: string): boolean {
  if (!quote) return false;
  let matches = 0;
  const issue = scanSession(path, agent, (_row, message) => {
    if (message?.role !== "user") return;
    const typed = typedPrefix(message.text);
    if (typed.includes(quote) && hash(typed) === messageHash) matches++;
  });
  return !issue && matches === 1;
}

function scanTail(path: string, agent: TranscriptAgent, visit: VisitRow, truncated: () => void): TranscriptIssue | undefined {
  const result = readTail(path, agent);
  if ("issue" in result) return result.issue;
  if (result.value.truncated) truncated();
  let sawMessage = false;
  let offset = result.value.start;
  for (const line of result.value.body.split("\n")) {
    const start = offset;
    offset += Buffer.byteLength(line) + 1;
    const row = parseRow(line);
    if (row === "invalid-format") return row;
    if (!row) continue;
    const message = messageRow(row, agent);
    if (message === "invalid-format") return message;
    sawMessage ||= !!message?.text;
    visit(row, message, start);
  }
  if (!sawMessage) return "invalid-format";
}

const WITHHELD = Symbol("withheld reply");
const OPTION_LIMIT = 32;
interface LocatedOption extends ReplyOption { offset: number; }
interface Reply { text: string; options: ReplyOption[]; }

function replyOptions(text: string, row: number, offset: number, limit: number): LocatedOption[] {
  const from = Math.max(0, text.length - limit);
  // An excerpt starting inside an option cannot prove that option.
  const newline = text.indexOf("\n", from);
  const start = from === 0 ? 0 : newline === -1 ? text.length : newline + 1;
  const options: LocatedOption[] = [];
  for (const match of text.slice(start).matchAll(/^[ \t]{0,8}(?:[-*][ \t]+)?(?:\*\*)?(?:option[ \t]+)?([1-9]\d?)(?:[.):]|[ \t]*[-–—])(?:\*\*)?[ \t]+[^ \t\r\n][^\r\n]{0,500}$/gimu)) {
    options.push({ row, option: Number(match[1]), text: match[0], offset: offset + start + match.index });
    if (options.length > OPTION_LIMIT) options.shift();
  }
  return options;
}

/** Only an exact, unambiguous user-message match associates reply context with journal text. */
export function replyContexts(path: string, agent: TranscriptAgent, messages: Message[], mode: ReplyContextMode = "design",
  context: { checkout?: string; notes?: readonly string[]; withheld?: Set<number>; maxFullReplyBytes?: number; includeOptions?: boolean } = {}): TranscriptIssue | undefined {
  if (!messages.length) return;
  if (mode === "none") {
    for (const message of messages) {
      message.previous_reply = null;
      if (context.includeOptions) message.previous_options = [];
    }
    return;
  }
  const targets = new Set(messages.map(message => message.text));
  const contexts = new Map<string, Reply | typeof WITHHELD | null>();
  let previous = "";
  let withheld = false;
  const fullReply: string[] = [];
  let fullBytes = 0;
  let replyLength = 0;
  let options: LocatedOption[] = [];
  const fullLimit = context.maxFullReplyBytes ?? SESSION_BYTES;
  const notes = context.notes ?? [];
  // Keep enough leading text to recognize a note that overlaps the retained tail.
  const contextUnits = (mode === "design" ? SHORT_MESSAGE_CONTEXT : REPLY_TAIL) * 2 + notes.reduce((longest, note) => Math.max(longest, note.length), 0);
  const outside = outsideTool(agent, context.checkout);
  function visibleReply(body: string, excerpt: string, limit?: number): Reply | null {
    const masked = maskReply(body, excerpt, notes);
    const text = limit === undefined ? masked : tail(masked, limit);
    if (!text) return null;
    const lines = new Set(context.includeOptions ? text.split("\n") : []);
    const visible = options.filter(option => option.offset >= replyLength - excerpt.length && lines.has(option.text));
    return { text, options: visible.map(({ offset: _offset, ...option }) => option) };
  }
  const visit: VisitRow = (row, message, offset) => {
    if (outside(row)) { withheld = true; previous = ""; fullReply.length = 0; }
    if (!message?.text) return;
    if (message.role === "assistant") {
      if (withheld) return;
      const text = message.text.replaceAll("\r\n", "\n");
      if (mode === "full") {
        fullBytes += Buffer.byteLength(text) + (fullReply.length ? 1 : 0);
        if (fullBytes > fullLimit) { withheld = true; fullReply.length = 0; }
        else fullReply.push(text);
      } else {
        const next = text.slice(-contextUnits);
        previous = (mode === "design" && previous ? `${previous}\n${next}` : next).slice(-contextUnits);
      }
      if (context.includeOptions && !withheld) {
        if (mode === "tail600") { options = []; replyLength = 0; }
        const start = replyLength ? replyLength + 1 : 0;
        options = [...options, ...replyOptions(text, offset, start, mode === "full" ? text.length : contextUnits)].slice(-OPTION_LIMIT);
        replyLength = start + text.length;
      }
      return;
    }
    const key = typedPrefix(message.text);
    if (targets.has(key)) {
      if (contexts.has(key)) contexts.set(key, null);
      else if (withheld) contexts.set(key, WITHHELD);
      else if (mode === "full") {
        const body = fullReply.join("\n");
        contexts.set(key, visibleReply(body, body));
      } else {
        const limit = mode === "design" && Array.from(key).length <= SHORT_MESSAGE ? SHORT_MESSAGE_CONTEXT : REPLY_TAIL;
        contexts.set(key, visibleReply(previous, tail(previous, limit), limit));
      }
    }
    previous = "";
    fullReply.length = 0;
    fullBytes = 0;
    replyLength = 0;
    options = [];
    withheld = false;
  };
  // A tail starting midway through a turn cannot establish what tools ran before that turn's reply.
  const issue = mode === "tail600" ? scanTail(path, agent, visit, () => { withheld = true; }) : scanSession(path, agent, visit);
  for (const message of messages) {
    const reply = contexts.get(message.text);
    if (!issue && reply === WITHHELD) context.withheld?.add(message.row);
    const matched = !issue && reply && reply !== WITHHELD ? reply : undefined;
    message.previous_reply = matched?.text ?? null;
    if (context.includeOptions) message.previous_options = matched?.options ?? [];
  }
  return issue;
}

/** The persisted proof binds the context of a short typed reply, without retaining agent text. */
export function replyContextDigest(message: Pick<Message, "text" | "previous_reply">): string | undefined {
  return message.previous_reply && Array.from(message.text).length <= SHORT_MESSAGE ? hash(message.previous_reply) : undefined;
}
