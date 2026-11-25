import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { object } from "../record/usage.js";
import type { TranscriptAgent } from "./profiles.js";

const webTools = new Set(["WebSearch", "WebFetch", "web_search", "web_fetch", "web.run", "web__run"]);
const remoteItems = new Set(["web_search_call", "web_search", "WebSearch", "mcp_tool_call", "McpToolCall"]);
const remoteEvents = new Set(["web_search_begin", "web_search_end", "mcp_tool_call_begin", "mcp_tool_call_end"]);

function outsideName(name: unknown): boolean {
  return typeof name === "string" && (webTools.has(name) || name === "google_web_search" || /^(?:mcp__.+__.+|MCP:.+|mcp_.+_.+)$/u.test(name));
}

/** Recognize only literal one-file reads. The command is never run. */
export function codexRead(call: Record<string, unknown>): { path: string; cwd?: string } | undefined {
  if (typeof call.arguments !== "string" || call.arguments.length > 8192) return;
  let args;
  try { args = object(JSON.parse(call.arguments)); } catch { return; }
  const cwd = typeof args?.workdir === "string" ? args.workdir : undefined;
  const path = args?.file_path ?? args?.path;
  if (call.name === "read_file" && typeof path === "string") return { path, cwd };
  if (call.name !== "exec_command" || typeof args?.cmd !== "string") return;
  const read = /^(?:cat(?: --)?|sed -n (?:'\d+(?:,\d+)?p'|"\d+(?:,\d+)?p")) ([A-Za-z0-9_./~:\\-]+)$/u.exec(args.cmd.trim());
  if (read) return { path: read[1]!, cwd: cwd ?? "" };
}

function canonical(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

function outsideRead(root: string, cwd: unknown, path: unknown): boolean {
  if (typeof path !== "string" || !path || path.includes("\0")) return false;
  const base = typeof cwd === "string" && isAbsolute(cwd) ? cwd : root;
  const expanded = path === "~" || path.startsWith("~/") || sep === "\\" && path.startsWith("~\\") ? homedir() + path.slice(1) : path;
  // Resolve the real target before collapsing `..`, which may follow a directory link.
  const target = canonical(isAbsolute(expanded) ? expanded : base + sep + expanded);
  const fromRoot = relative(root, target);
  return fromRoot === ".." || fromRoot.startsWith(".." + sep) || isAbsolute(fromRoot);
}

/** A recognized outside call taints the entire reply, including text before the call. */
export function outsideTool(agent: TranscriptAgent, checkout?: string): (row: Record<string, unknown>) => boolean {
  const root = checkout && canonical(checkout);
  if (agent === "codex") return row => {
    const payload = object(row.payload);
    if (row.type === "response_item" && typeof payload?.type === "string") {
      if (remoteItems.has(payload.type)) return true;
      if (payload.type !== "function_call" && payload.type !== "custom_tool_call") return false;
      const read = codexRead(payload);
      return outsideName(payload.name) || !!(root && read && outsideRead(root, read.cwd, read.path));
    }
    if (row.type !== "event_msg" || typeof payload?.type !== "string") return false;
    if (remoteEvents.has(payload.type)) return true;
    const item = object(payload.item);
    return (payload.type === "item_started" || payload.type === "item_completed") && typeof item?.type === "string" && remoteItems.has(item.type);
  };
  if (agent === "copilot") return row => {
    const data = object(row.data);
    if (row.type !== "tool.execution_start" || !data) return false;
    const args = object(data.arguments);
    return !!data.mcpServerName || outsideName(data.toolName)
      || !!(root && data.toolName === "view" && outsideRead(root, undefined, args?.path));
  };
  if (agent === "gemini") return row => Array.isArray(row.toolCalls) && row.toolCalls.some(value => {
    const call = object(value), args = object(call?.args);
    return outsideName(call?.name) || !!(root && call?.name === "read_file" && outsideRead(root, undefined, args?.file_path));
  });
  return row => {
    if ((row.role ?? row.type) !== "assistant") return false;
    const blocks = object(row.message)?.content ?? row.content;
    if (!Array.isArray(blocks)) return false;
    return blocks.some(value => {
      const call = object(value);
      if (call?.type === "mcp_tool_use") return true;
      if (call?.type !== "tool_use" && call?.type !== "server_tool_use") return false;
      if (outsideName(call.name)) return true;
      if (!root) return false;
      const input = object(call.input);
      if (call.name === "Read") return outsideRead(root, row.cwd, input?.file_path);
      if (call.name !== "Grep" && call.name !== "Glob") return false;
      const path = input?.path === undefined && typeof input?.pattern === "string" ? "." : input?.path;
      return outsideRead(root, row.cwd, path);
    });
  };
}

/** Mask all matching spans, including overlapping notes and ones crossing the excerpt boundary. */
export function maskReply(body: string, excerpt: string, notes: readonly string[]): string {
  if (!notes.length || !excerpt) return excerpt;
  const from = body.length - excerpt.length;
  const coverage = new Int32Array(excerpt.length + 1);
  let found = false;
  for (const note of notes) {
    if (!note.length) continue;
    for (let at = body.indexOf(note, Math.max(0, from - note.length + 1)); at !== -1; at = body.indexOf(note, at + 1)) {
      const start = Math.max(0, at - from), end = at + note.length - from;
      coverage[start] = coverage[start]! + 1;
      coverage[end] = coverage[end]! - 1;
      found = true;
    }
  }
  if (!found) return excerpt;
  const parts: string[] = [];
  let covered = 0, start = 0;
  for (let i = 0; i <= excerpt.length; i++) {
    const next = covered + coverage[i]!;
    if (!covered && next) parts.push(excerpt.slice(start, i), "[MEX note]");
    if (covered && !next) start = i;
    covered = next;
  }
  return parts.join("") + excerpt.slice(start);
}
