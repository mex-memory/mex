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

/** A promotion proof comes only from a matching user message, never an assistant/tool row. */
export function typedQuote(path: string, agent: "claude" | "codex", quote: string, messageHash: string): boolean {
  const body = transcriptTail(path, agent);
  if (!body || !quote) return false;
  let matches = 0;
  for (const line of body.split("\n")) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== "object") continue;
    const payload = row.type === "response_item" ? row.payload : row.message;
    const role = agent === "claude" ? row.type : payload?.role;
    if (role !== "user") continue;
    const content = text(payload?.content);
    if (content && content.includes(quote) && hash(Array.from(content).slice(0, 1200).join("")) === messageHash) matches++;
  }
  return matches === 1;
}

const TAIL_BYTES = 1024 * 1024;
const tail = (text: string) => Array.from(text).slice(-600).join("");
function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  return value.filter(v => v && ["text", "input_text", "output_text"].includes(v.type) && typeof v.text === "string").map(v => v.text).join("\n");
}
/** Read only a regular host transcript under its own configured session directory. */
export function transcriptTail(path: string, agent: "claude" | "codex", maxBytes = TAIL_BYTES, requireFull = false): string | undefined {
  let fd: number | undefined;
  try {
    const root = realpathSync(agent === "claude" ? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects")
      : join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"));
    const actual = realpathSync(path), within = relative(root, actual), expected = lstatSync(path, { bigint: true });
    if (!path.endsWith(".jsonl") || !within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)
      || !expected.isFile() || expected.isSymbolicLink()) return undefined;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino) return undefined;
    if (requireFull && before.size > BigInt(maxBytes)) return undefined;
    const offset = Math.max(0, Number(before.size) - maxBytes), bytes = Buffer.alloc(Math.min(Number(before.size), maxBytes));
    let n = 0;
    while (n < bytes.length) { const got = readSync(fd, bytes, n, bytes.length - n, offset + n); if (!got) break; n += got; }
    const after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || n !== bytes.length) return undefined;
    const body = bytes.toString("utf8");
    return offset ? body.slice(body.indexOf("\n") + 1) : body;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** Only an exact user-message match associates an assistant tail with journal text. */
export function replyContexts(path: string, agent: "claude" | "codex", messages: Message[]): void {
  const body = transcriptTail(path, agent);
  if (!body) return;
  let previous: string | null = null;
  const contexts = new Map<string, Array<string | null>>();
  for (const line of body.split("\n")) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== "object") continue;
    const payload = row.type === "response_item" ? row.payload : row.message;
    const role = agent === "claude" ? row.type : payload?.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = text(payload?.content);
    if (!content) continue;
    if (role === "assistant") { previous = tail(content); continue; }
    // Do not associate ambiguous repeated asks or a partial prefix with a reply.
    const key = Array.from(content).slice(0, 1200).join("");
    const prior = contexts.get(key) ?? []; prior.push(previous); contexts.set(key, prior);
    previous = null;
  }
  for (const message of messages) {
    const matches = contexts.get(message.text);
    if (matches?.length === 1) message.previous_reply = matches[0] ?? null;
  }
}
