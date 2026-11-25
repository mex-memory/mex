import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hash } from "../../judge/evidence.js";
import type { Message } from "../input.js";
import { replyContexts, typedQuote } from "../transcript.js";

type Agent = "claude" | "codex";
type Role = "user" | "assistant";
let base: string;

beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "mex-transcript-"))); });
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

function transcript(agent: Agent): string {
  const directory = join(base, agent === "claude" ? "projects" : "sessions");
  mkdirSync(directory);
  vi.stubEnv(agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME", base);
  return join(directory, "session.jsonl");
}

function turn(agent: Agent, role: Role, text: string): unknown {
  if (agent === "claude") return { type: role, message: { role, content: [{ type: "text", text }] } };
  return { type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } };
}

function toolRows(agent: Agent): unknown[] {
  if (agent === "claude") return [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "call", name: "Read", input: { file_path: "tool input" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call", content: "tool result" }, { type: "text", text: "Tool result reminder" }] } },
  ];
  return [
    { type: "response_item", payload: { type: "function_call", call_id: "call", arguments: "tool input" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call", role: "user", content: "tool result" } },
  ];
}

const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n");
const captured = (text: string, row = 1): Message => ({ id: `m${row}`, row, session: "s", at: "2000-01-01T00:00:00Z", text, marks: "", previous_reply: null, delivered: [] });

it.each(["claude", "codex"] as const)("finds an early reply and verifies its typed quote in a 6 MiB %s transcript", agent => {
  const path = transcript(agent);
  const options = "1. Keep the old parser.\n2. Use the new parser.";
  const followup = "Which option should we use?";
  const message = captured("yes, 2");
  const first = jsonl([
    turn(agent, "assistant", "From an earlier turn"),
    turn(agent, "user", "Show me my options"),
    turn(agent, "assistant", options),
    ...toolRows(agent),
    turn(agent, "assistant", followup),
    turn(agent, "user", message.text),
  ]) + "\n";
  const last = "\n" + jsonl([turn(agent, "user", "A later prompt")]);
  const padding = (6 << 20) - Buffer.byteLength(first + last + '{"type":"progress","padding":""}');
  writeFileSync(path, first + JSON.stringify({ type: "progress", padding: "x".repeat(padding) }) + last);

  expect(replyContexts(path, agent, [message], "tail600")).toBeUndefined();
  expect(message.previous_reply).toBeNull();
  expect(replyContexts(path, agent, [message])).toBeUndefined();
  expect(message.previous_reply).toBe(`${options}\n${followup}`);
  expect(typedQuote(path, agent, "yes, 2", hash(message.text))).toBe(true);
  expect(typedQuote(path, agent, options, hash(options))).toBe(false);
});

it.each([{ length: 300, limit: 12_000 }, { length: 301, limit: 600 }])("keeps $limit reply characters for a $length-character prompt", ({ length, limit }) => {
  const path = transcript("codex");
  const message = captured("🙂".repeat(length));
  const first = "Earlier options. ".repeat(1000), last = "→".repeat(800);
  writeFileSync(path, jsonl([turn("codex", "assistant", first), turn("codex", "assistant", last), turn("codex", "user", message.text)]));
  expect(replyContexts(path, "codex", [message])).toBeUndefined();
  expect(message.previous_reply).toBe(Array.from(`${first}\n${last}`).slice(-limit).join(""));
});

it.each(["claude", "codex"] as const)("builds all four context modes on %s", agent => {
  const path = transcript(agent), short = captured("yes, 2"), long = captured("x".repeat(301), 2);
  const note = "Remember the established parser rules.", early = "Earlier option. ".repeat(900), end = "t".repeat(700) + note;
  const reply = `${early}\n${end}`;
  writeFileSync(path, jsonl([
    turn(agent, "assistant", "A different turn"), turn(agent, "user", "Show my options"),
    turn(agent, "assistant", early), ...toolRows(agent), turn(agent, "assistant", end), turn(agent, "user", short.text),
    turn(agent, "assistant", early), turn(agent, "assistant", end), turn(agent, "user", long.text),
  ]));
  const masked = reply.replace(note, "[MEX note]"), tail = "t".repeat(600 - note.length) + "[MEX note]";
  const cases = [
    ["design", tail],
    ["tail600", tail],
    ["full", masked],
    ["none", null],
  ] as const;
  for (const [mode, expectedLong] of cases) {
    expect(replyContexts(path, agent, [short, long], mode, { notes: [note] })).toBeUndefined();
    expect(long.previous_reply).toBe(expectedLong);
    expect(short.previous_reply).toBe(mode === "design" ? reply.slice(-12_000).replace(note, "[MEX note]") : expectedLong);
  }
});

it("does not open a missing transcript in typed-only mode", () => {
  const message = captured("yes"); message.previous_reply = "old context";
  const withheld = new Set<number>();
  expect(replyContexts(join(base, "missing.jsonl"), "codex", [message], "none", { withheld })).toBeUndefined();
  expect(message.previous_reply).toBeNull();
  expect(withheld.size).toBe(0);
});

it("decodes a multi-byte character across a read boundary", () => {
  const path = transcript("claude");
  const message = captured("yes");
  const reply = "🙂 Use the second option";
  const line = JSON.stringify(turn("claude", "assistant", reply));
  const prefixBytes = Buffer.byteLength(line.slice(0, line.indexOf("🙂")));
  const padding = (64 << 10) - 1 - prefixBytes - Buffer.byteLength('{"padding":""}\r\n');
  writeFileSync(path, JSON.stringify({ padding: "x".repeat(padding) }) + "\r\n" + line + "\r\n" + jsonl([turn("claude", "user", message.text)]));
  expect(replyContexts(path, "claude", [message])).toBeUndefined();
  expect(message.previous_reply).toBe(reply);
});

it("drops context and quote proof for a repeated message across the whole session", () => {
  const path = transcript("codex");
  const message = captured("yes");
  writeFileSync(path, jsonl([
    turn("codex", "assistant", "First question"), turn("codex", "user", message.text),
    { type: "progress", padding: "x".repeat(1 << 20) },
    turn("codex", "assistant", "Second question"), turn("codex", "user", message.text),
  ]));
  expect(replyContexts(path, "codex", [message])).toBeUndefined();
  expect(message.previous_reply).toBeNull();
  expect(typedQuote(path, "codex", message.text, hash(message.text))).toBe(false);
});

it("verifies quotes inside the captured text limit", () => {
  const path = transcript("codex");
  const recorded = "🧪".repeat(1200);
  writeFileSync(path, jsonl([turn("codex", "user", `${recorded} Text after the capture limit.`)]));
  expect(typedQuote(path, "codex", "🧪", hash(recorded))).toBe(true);
  expect(typedQuote(path, "codex", "Text after the capture limit.", hash(recorded))).toBe(false);
});

it.each(["{broken", '{"type":"assistant","message":{"content":null}}'])
  ("uses typed-only input for a broken transcript row %s", broken => {
    const path = transcript("claude");
    const message = captured("yes, 2");
    writeFileSync(path, jsonl([turn("claude", "assistant", "Some options"), turn("claude", "user", message.text)]) + "\n" + broken);
    expect(replyContexts(path, "claude", [message])).toBe("invalid-format");
    expect(message.previous_reply).toBeNull();
    expect(typedQuote(path, "claude", message.text, hash(message.text))).toBe(false);
  });

it("reports a transcript layout without chat rows as unsupported", () => {
  const path = transcript("codex");
  writeFileSync(path, '{"new_layout":{"typed":"yes"}}');
  const message = captured("yes");
  expect(replyContexts(path, "codex", [message])).toBe("invalid-format");
  expect(message.previous_reply).toBeNull();
});

it("refuses to take context or proof from a transcript over 32 MiB", () => {
  const path = transcript("codex");
  const message = captured("yes");
  writeFileSync(path, jsonl([turn("codex", "assistant", "Some options"), turn("codex", "user", message.text)]));
  truncateSync(path, (32 << 20) + 1);
  expect(replyContexts(path, "codex", [message])).toBe("too-large");
  expect(message.previous_reply).toBeNull();
  expect(typedQuote(path, "codex", message.text, hash(message.text))).toBe(false);
});

it.each(["appended", "replaced"] as const)("discards context when a transcript is %s during the read", change => {
  const path = transcript("claude");
  const message = captured("yes");
  const last = JSON.stringify(turn("claude", "user", message.text));
  writeFileSync(path, jsonl([turn("claude", "assistant", "Some options")]) + "\n" + last);
  const parse = JSON.parse;
  const watched = vi.spyOn(JSON, "parse").mockImplementation((line, reviver) => {
    if (line === last) {
      if (change === "appended") appendFileSync(path, "\n");
      else {
        renameSync(path, join(base, "old-session.jsonl"));
        writeFileSync(path, last);
      }
    }
    return parse(line, reviver);
  });
  try {
    expect(replyContexts(path, "claude", [message])).toBe("changed");
    expect(message.previous_reply).toBeNull();
  } finally { watched.mockRestore(); }
});

const claudeTool = (name: string, input: object) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const codexTool = (name: string) => ({ type: "response_item", payload: { type: "function_call", name, arguments: "{}" } });
it.each([
  { agent: "claude", tool: "web", call: () => claudeTool("WebFetch", { url: "https://example.test" }) },
  { agent: "claude", tool: "MCP", call: () => claudeTool("mcp__docs__search", {}) },
  { agent: "claude", tool: "outside Read", call: () => claudeTool("Read", { file_path: join(base, "outside.txt") }) },
  { agent: "claude", tool: "outside Grep", call: () => claudeTool("Grep", { path: "..", pattern: "anything" }) },
  { agent: "claude", tool: "outside Glob", call: () => claudeTool("Glob", { path: base, pattern: "*.ts" }) },
  { agent: "claude", tool: "Glob from outside", call: () => ({ ...claudeTool("Glob", { pattern: "*.ts" }), cwd: base }) },
  { agent: "codex", tool: "web", call: () => ({ type: "response_item", payload: { type: "web_search_call", action: { type: "search", query: "example" } } }) },
  { agent: "codex", tool: "web event", call: () => ({ type: "event_msg", payload: { type: "web_search_end", call_id: "search-1", action: { type: "search", query: "example" } } }) },
  { agent: "codex", tool: "MCP", call: () => codexTool("mcp__docs__search") },
  { agent: "codex", tool: "MCP event", call: () => ({ type: "event_msg", payload: { type: "mcp_tool_call_begin", invocation: { server: "docs", tool: "search" } } }) },
] satisfies Array<{ agent: Agent; tool: string; call: () => unknown }>)
("withholds only the affected turn for $agent $tool", ({ agent, call }) => {
  const path = transcript(agent), checkout = join(base, "repo"); mkdirSync(checkout);
  const first = captured("yes, 2"), next = captured("keep 1", 2);
  writeFileSync(path, jsonl([
    turn(agent, "assistant", "Text before the outside call"), call(), ...toolRows(agent),
    turn(agent, "assistant", "Text after the outside call"), turn(agent, "user", first.text),
    turn(agent, "assistant", "Fresh local options"), turn(agent, "user", next.text),
  ]));
  for (const mode of ["design", "tail600", "full"] as const) {
    const withheld = new Set<number>();
    expect(replyContexts(path, agent, [first, next], mode, { checkout, withheld })).toBeUndefined();
    expect(first.previous_reply).toBeNull();
    expect(next.previous_reply).toBe("Fresh local options");
    expect([...withheld]).toEqual([first.row]);
  }
  expect(typedQuote(path, agent, first.text, hash(first.text))).toBe(true);
});

it("withholds a legacy tail turn whose earlier tools cannot be verified", () => {
  const path = transcript("codex"), first = captured("try that"), next = captured("keep this", 2);
  writeFileSync(path, jsonl([
    codexTool("mcp__docs__search"), { type: "progress", padding: "x".repeat(1 << 20) },
    turn("codex", "assistant", "The first option"), turn("codex", "user", first.text),
    turn("codex", "assistant", "The fresh option"), turn("codex", "user", next.text),
  ]));
  const withheld = new Set<number>();
  expect(replyContexts(path, "codex", [first, next], "tail600", { withheld })).toBeUndefined();
  expect(first.previous_reply).toBeNull();
  expect(next.previous_reply).toBe("The fresh option");
  expect([...withheld]).toEqual([first.row]);
});

it("keeps reply context for an in-checkout read and unknown tool shapes", () => {
  const path = transcript("claude"), checkout = join(base, "repo"); mkdirSync(checkout);
  writeFileSync(join(checkout, "README.md"), "fixture");
  const message = captured("use the first option");
  writeFileSync(path, jsonl([
    claudeTool("Read", { file_path: join(checkout, "README.md") }), claudeTool("Read", { future_path: "../outside.txt" }),
    { type: "unknown", name: "WebFetch", input: {} },
    turn("claude", "assistant", "Allowed local options"), turn("claude", "user", message.text),
  ]));
  expect(replyContexts(path, "claude", [message], "design", { checkout })).toBeUndefined();
  expect(message.previous_reply).toBe("Allowed local options");
});

it.skipIf(process.platform === "win32")("withholds a reply if a read follows an in-checkout link outside", () => {
  const path = transcript("claude"), checkout = join(base, "repo"), target = join(base, "outside.txt"); mkdirSync(checkout);
  writeFileSync(target, "fixture");
  symlinkSync(target, join(checkout, "linked.txt"));
  const message = captured("use the first option");
  writeFileSync(path, jsonl([claudeTool("Read", { file_path: "linked.txt" }), turn("claude", "assistant", "The outside text"), turn("claude", "user", message.text)]));
  expect(replyContexts(path, "claude", [message], "design", { checkout })).toBeUndefined();
  expect(message.previous_reply).toBeNull();
});

it("masks a note split across assistant rows and clipped by the excerpt boundary", () => {
  const path = transcript("codex"), message = captured("x".repeat(301));
  const first = "Private body prefix. ".repeat(28), end = "Private body suffix.", tail = "t".repeat(575);
  writeFileSync(path, jsonl([turn("codex", "assistant", first), turn("codex", "assistant", end + "\n" + tail), turn("codex", "user", message.text)]));
  expect(replyContexts(path, "codex", [message], "design", { notes: [first + "\n" + end] })).toBeUndefined();
  expect(message.previous_reply).toBe("[MEX note]\n" + tail);
});
