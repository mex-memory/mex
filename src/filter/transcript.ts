import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";
import type { Message } from "./input.js";
import { hash } from "../judge/evidence.js";
import { object } from "../record/usage.js";

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
export type ReplyContextMode = "design" | "tail600";
export type TranscriptIssue = "unavailable" | "too-large" | "changed" | "invalid-format";
type TranscriptRead<T> = { value: T } | { issue: TranscriptIssue };
type TranscriptMessage = { role: "user" | "assistant"; text: string };

// Limit the string before splitting it into code points. Each takes at most two UTF-16 code units.
const typedPrefix = (value: string) => Array.from(value.slice(0, TYPED_LIMIT * 2)).slice(0, TYPED_LIMIT).join("");
const tail = (value: string, limit: number) => Array.from(value.slice(-limit * 2)).slice(-limit).join("");

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  return value.filter(v => v && ["text", "input_text", "output_text"].includes(v.type) && typeof v.text === "string").map(v => v.text).join("\n");
}

function messageRow(line: string, agent: TranscriptAgent, wholeSession: boolean): TranscriptMessage | "invalid-format" | undefined {
  if (!line.trim()) return;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return "invalid-format"; }
  const row = object(value);
  if (!row || (wholeSession && (row.isCompactSummary === true || row.isMeta === true))) return;
  const payload = object(row.type === "response_item" ? row.payload : row.message);
  if (wholeSession && agent === "codex" && row.type === "response_item"
    && payload?.type !== undefined && payload.type !== "message") return;
  const role = agent === "claude" ? row.type : payload?.role;
  if (role !== "user" && role !== "assistant") {
    if (agent === "codex" && row.type === "response_item" && payload?.type === "message" && typeof role !== "string") return "invalid-format";
    return;
  }
  const blocks = payload?.content;
  if (wholeSession && agent === "claude" && role === "user" && Array.isArray(blocks)
    && blocks.some(block => object(block)?.type === "tool_result")) return;
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

function readTail(path: string, agent: TranscriptAgent, maxBytes = TAIL_BYTES, requireFull = false, appending = false): TranscriptRead<string> {
  return readTranscript<string>(path, agent, (fd, size) => {
    if (requireFull && size > BigInt(maxBytes)) return { issue: "too-large" };
    const offset = Math.max(0, Number(size) - maxBytes), bytes = Buffer.alloc(Math.min(Number(size), maxBytes));
    let n = 0;
    while (n < bytes.length) {
      const got = readSync(fd, bytes, n, bytes.length - n, offset + n);
      if (!got) return { issue: "changed" };
      n += got;
    }
    const body = bytes.toString("utf8");
    return { value: offset ? body.slice(body.indexOf("\n") + 1) : body };
  }, appending);
}

/** Appending callers take a prefix of the initial size and handle a torn final line themselves. */
export function transcriptTail(path: string, agent: TranscriptAgent, maxBytes = TAIL_BYTES, requireFull = false, appending = false): string | undefined {
  const result = readTail(path, agent, maxBytes, requireFull, appending);
  return "value" in result ? result.value : undefined;
}

function scanLines(fd: number, size: number, visit: (line: string) => TranscriptIssue | undefined): TranscriptIssue | undefined {
  const buffer = Buffer.allocUnsafe(Math.min(size, READ_CHUNK_BYTES));
  const fragments: Buffer[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  function visitLine(bytes: Buffer): TranscriptIssue | undefined {
    let line: string;
    try { line = decoder.decode(bytes); } catch { return "invalid-format"; }
    return visit(line);
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
      fragments.length = 0;
      start = end + 1;
    }
  }
  if (fragments.length) return visitLine(Buffer.concat(fragments));
}

function scanSession(path: string, agent: TranscriptAgent, visit: (message: TranscriptMessage) => void): TranscriptIssue | undefined {
  const result = readTranscript(path, agent, (fd, size) => {
    if (size > BigInt(SESSION_BYTES)) return { issue: "too-large" };
    let sawMessage = false;
    const issue = scanLines(fd, Number(size), line => {
      const message = messageRow(line, agent, true);
      if (message === "invalid-format") return message;
      if (message?.text) {
        sawMessage = true;
        visit(message);
      }
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
  const issue = scanSession(path, agent, message => {
    if (message.role !== "user") return;
    const typed = typedPrefix(message.text);
    if (typed.includes(quote) && hash(typed) === messageHash) matches++;
  });
  return !issue && matches === 1;
}

function scanTail(path: string, agent: TranscriptAgent, visit: (message: TranscriptMessage) => void): TranscriptIssue | undefined {
  const result = readTail(path, agent);
  if ("issue" in result) return result.issue;
  let sawMessage = false;
  for (const line of result.value.split("\n")) {
    const message = messageRow(line, agent, false);
    if (message && message !== "invalid-format" && message.text) {
      sawMessage = true;
      visit(message);
    }
  }
  if (!sawMessage) return "invalid-format";
}

/** Only an exact, unambiguous user-message match associates reply context with journal text. */
export function replyContexts(path: string, agent: TranscriptAgent, messages: Message[], mode: ReplyContextMode = "design"): TranscriptIssue | undefined {
  if (!messages.length) return;
  const targets = new Set(messages.map(message => message.text));
  const contexts = new Map<string, string | null>();
  let previous = "";
  const wholeSession = mode === "design";
  const contextUnits = SHORT_MESSAGE_CONTEXT * 2;
  const visit = (message: TranscriptMessage) => {
    if (message.role === "assistant") {
      if (wholeSession) {
        const next = message.text.slice(-contextUnits);
        previous = (previous ? `${previous}\n${next}` : next).slice(-contextUnits);
      } else previous = tail(message.text, REPLY_TAIL);
      return;
    }
    const key = typedPrefix(message.text);
    if (targets.has(key)) {
      const limit = wholeSession && Array.from(key).length <= SHORT_MESSAGE ? SHORT_MESSAGE_CONTEXT : REPLY_TAIL;
      contexts.set(key, contexts.has(key) || !previous ? null : tail(previous, limit));
    }
    previous = "";
  };
  const issue = wholeSession ? scanSession(path, agent, visit) : scanTail(path, agent, visit);
  for (const message of messages) message.previous_reply = issue ? null : contexts.get(message.text) ?? null;
  return issue;
}
