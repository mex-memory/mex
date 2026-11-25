import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
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
const captured = (text: string): Message => ({ id: "m1", row: 1, session: "s", at: "2000-01-01T00:00:00Z", text, marks: "", previous_reply: null, delivered: [] });

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
