import { describe, expect, it } from "vitest";
import {
  createPopulationActivityDecoder,
  type PopulationActivitySignal,
} from "../population-activity.js";

function fixture(tool: "claude" | "codex") {
  const signals: PopulationActivitySignal[] = [];
  const decoder = createPopulationActivityDecoder(tool, (signal) => signals.push(signal));
  const send = (...events: unknown[]) => decoder.write(Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n"));
  return { signals, decoder, send };
}

const toolUse = (id: string, name = "Read", filePath = "/private/repo/.mex/context/architecture.md") => ({
  type: "tool_use", id, name, input: { file_path: filePath, content: "PRIVATE FILE CONTENT" },
});
const assistant = (...blocks: unknown[]) => ({
  type: "assistant", parent_tool_use_id: null,
  message: { id: "msg_private", role: "assistant", content: blocks },
});
const toolResult = (id: string, isError = false) => ({
  type: "user", parent_tool_use_id: null,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "SECRET COMMAND OUTPUT" }] },
});

describe("Claude Code population activity", () => {
  it("decodes initialization, partial tool start, target enrichment, actual result, and final success", () => {
    const { send, signals, decoder } = fixture("claude");
    send(
      { type: "system", subtype: "init", cwd: "/private/repo", session_id: "private-session", apiKeySource: "SECRET" },
      { type: "stream_event", event: { type: "message_start", message: { content: [], role: "assistant" } } },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "read1", name: "Read", input: {} } } },
      assistant(toolUse("read1")),
      assistant(toolUse("read1")),
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    );
    expect(signals).toEqual([
      { kind: "started", state: "running" },
      { kind: "working", state: "running" },
      { kind: "reading", state: "running" },
      { kind: "reading", state: "running", target: "architecture" },
    ]);
    send(toolResult("read1"), { type: "result", subtype: "success", is_error: false, result: "PRIVATE RESPONSE" });
    expect(signals.slice(-2)).toEqual([
      { kind: "reading", state: "completed", target: "architecture" },
      { kind: "completed", state: "completed" },
    ]);
    expect(JSON.stringify(signals)).not.toMatch(/private|SECRET|CONTENT|RESPONSE/u);
    expect(decoder.failed).toBe(false);
    expect(decoder.completed).toBe(true);
  });

  it.each([
    ["Read", "reading"], ["Glob", "searching"], ["Grep", "searching"], ["WebSearch", "searching"],
    ["Write", "writing"], ["Edit", "writing"], ["MultiEdit", "writing"], ["NotebookEdit", "writing"],
    ["Bash", "running_command"], ["Task", "delegating"], ["Agent", "delegating"], ["mcp__private__tool", "working"],
  ])("projects %s to a fixed %s label", (name, kind) => {
    const { send, signals } = fixture("claude");
    send(assistant(toolUse("t1", name, "private.txt")), toolResult("t1"));
    expect(signals).toEqual([{ kind, state: "running" }, { kind, state: "completed" }]);
  });

  it("uses recognized stream delta occurrence as activity without inspecting or exposing its body", () => {
    const { send, signals } = fixture("claude");
    send(
      assistant({ type: "text", text: "SECRET" }, { type: "thinking", thinking: "SECRET" }),
      { type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking", thinking: "SECRET" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "SECRET" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "SECRET" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "SECRET" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "unknown", text: "SECRET" } } },
      { type: "system", subtype: "hook_progress", stdout: "SECRET" },
      { type: "unknown", result: "SECRET" },
    );
    expect(signals).toEqual(Array.from({ length: 3 }, () => ({ kind: "working", state: "running" })));
  });

  it("tracks correlated progress and tool failures without declaring the whole agent failed", () => {
    const { send, signals, decoder } = fixture("claude");
    send(assistant(toolUse("read1")), { type: "tool_progress", tool_use_id: "read1", tool_name: "Read", elapsed_time_seconds: 3 }, toolResult("read1", true));
    expect(signals.at(-2)).toEqual({ kind: "reading", state: "running", target: "architecture" });
    expect(signals.at(-1)).toEqual({ kind: "reading", state: "failed", target: "architecture" });
    expect(decoder.failed).toBe(false);
    send(toolResult("read1"), { type: "tool_progress", tool_use_id: "read1" });
    expect(signals).toHaveLength(3);
  });

  it.each([
    { type: "result", subtype: "success", is_error: true, result: "SECRET" },
    { type: "result", subtype: "error_during_execution", errors: ["SECRET"] },
    { type: "result", subtype: "error_max_turns", is_error: true },
    { type: "result", subtype: "error_max_budget_usd", is_error: true },
  ])("retains a terminal result error even if the process exits zero: %j", (event) => {
    const { send, signals, decoder } = fixture("claude");
    send(event, { type: "result", subtype: "success", is_error: false });
    decoder.end();
    expect(decoder.failed).toBe(true);
    expect(decoder.completed).toBe(false);
    expect(signals).toEqual([{ kind: "failed", state: "failed" }]);
  });

  it("bounds tool correlation while retaining the newest tools", () => {
    const { send, signals } = fixture("claude");
    for (let i = 0; i < 130; i++) send(assistant(toolUse(`t${i}`)));
    signals.length = 0;
    send(toolResult("t0"), toolResult("t1"), toolResult("t129"));
    expect(signals).toEqual([{ kind: "reading", state: "completed", target: "architecture" }]);
    send(assistant(toolUse("x".repeat(257))), toolResult("x".repeat(257)));
    expect(signals).toHaveLength(2); // Unbounded IDs are never retained for a result.
  });

  it("bounds the work in a single content array", () => {
    const { send, signals } = fixture("claude");
    send(assistant(...Array.from({ length: 100 }, (_, i) => toolUse(`t${i}`))));
    expect(signals).toHaveLength(64);
  });
});

describe("Codex population activity", () => {
  it("projects real command and file-change events, preserving only safe targets", () => {
    const { send, signals, decoder } = fixture("codex");
    send(
      { type: "thread.started", thread_id: "private-thread" },
      { type: "turn.started" },
      { type: "item.started", item: { id: "item_1", type: "command_execution", command: "cat /private/repo/SECRET", status: "in_progress" } },
      { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "cat /private/repo/SECRET", aggregated_output: "SECRET", exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "item_2", type: "file_change", status: "completed", changes: [
        { path: "/private/repo/.mex/context/architecture.md", kind: "update" },
        { path: "/private/repo/.mex/context/stack.md", kind: "add" },
      ] } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    );
    expect(signals).toEqual([
      { kind: "started", state: "running" }, { kind: "working", state: "running" },
      { kind: "running_command", state: "running" }, { kind: "running_command", state: "completed" },
      { kind: "writing", state: "completed", target: "architecture" },
      { kind: "writing", state: "completed", target: "stack" },
      { kind: "completed", state: "completed" },
    ]);
    expect(decoder.failed).toBe(false);
    expect(JSON.stringify(signals)).not.toMatch(/private|SECRET|item_|update|input_tokens/u);
  });

  it("uses agent and reasoning item occurrence as activity without exposing text, and ignores unknown item types", () => {
    const { send, signals } = fixture("codex");
    for (const type of ["agent_message", "reasoning", "future_type"]) {
      send({ type: "item.completed", item: { type, text: "SECRET" } });
    }
    expect(signals).toEqual([{ kind: "working", state: "running" }, { kind: "working", state: "running" }]);
  });

  it("supports real searches, MCP calls and plan updates without leaking their payloads", () => {
    const { send, signals } = fixture("codex");
    send(
      { type: "item.started", item: { type: "web_search", query: "SECRET" } },
      { type: "item.completed", item: { type: "web_search", query: "SECRET" } },
      { type: "item.updated", item: { type: "mcp_tool_call", status: "in_progress", arguments: "SECRET", server: "SECRET", tool: "SECRET" } },
      { type: "item.updated", item: { type: "todo_list", items: [{ text: "SECRET", completed: true }] } },
    );
    expect(signals).toEqual([
      { kind: "searching", state: "running" }, { kind: "searching", state: "completed" },
      { kind: "working", state: "running" }, { kind: "working", state: "running" },
    ]);
  });

  it.each(["command_execution", "file_change", "mcp_tool_call", "error"])("allows recovery after an individual %s failure", (type) => {
    const { send, signals, decoder } = fixture("codex");
    send({ type: "item.completed", item: { type, status: "failed", message: "SECRET" } });
    expect(signals.at(-1)?.state).toBe("failed");
    expect(decoder.failed).toBe(false);
  });

  it("treats a nonzero command exit as failed activity, even with completed status", () => {
    const { send, signals, decoder } = fixture("codex");
    send({ type: "item.completed", item: { type: "command_execution", status: "completed", exit_code: 1 } });
    expect(signals).toEqual([{ kind: "running_command", state: "failed" }]);
    expect(decoder.failed).toBe(false);
  });

  it("shows a declined command as failed activity without declaring the whole run failed", () => {
    const { send, signals, decoder } = fixture("codex");
    send({ type: "item.completed", item: { type: "command_execution", status: "declined", command: "SECRET" } });
    expect(signals).toEqual([{ kind: "running_command", state: "failed" }]);
    expect(decoder.failed).toBe(false);
  });

  it("projects collab tool activity without private prompts, agent messages, or thread IDs", () => {
    const { send, signals } = fixture("codex");
    send(
      { type: "item.started", item: { type: "collab_tool_call", tool: "spawn_agent", status: "in_progress", prompt: "SECRET", sender_thread_id: "SECRET", receiver_thread_ids: ["SECRET"] } },
      { type: "item.completed", item: { type: "collab_tool_call", tool: "wait", status: "completed", agents_states: { SECRET: { status: "completed", message: "SECRET" } } } },
    );
    expect(signals).toEqual([{ kind: "delegating", state: "running" }, { kind: "delegating", state: "completed" }]);
  });

  it.each(["turn.failed", "error"])("retains a %s terminal failure without exposing its text", (type) => {
    const { send, signals, decoder } = fixture("codex");
    send({ type, message: "SECRET", error: { message: "SECRET" } }, { type: "turn.completed" });
    expect(decoder.failed).toBe(true);
    expect(signals).toEqual([{ kind: "failed", state: "failed" }]);
  });
});

describe("bounded incremental JSONL decoding", () => {
  it("handles arbitrary byte boundaries including split UTF-8 and CRLF", () => {
    const { decoder, signals } = fixture("claude");
    const bytes = Buffer.from(JSON.stringify(assistant(toolUse("t1", "Read", "/private/🍃/.mex/ROUTER.md"))) + "\r\n" + JSON.stringify(toolResult("t1")));
    for (const byte of bytes) decoder.write(Buffer.from([byte]));
    decoder.end();
    expect(signals).toEqual([
      { kind: "reading", state: "running", target: "router" },
      { kind: "reading", state: "completed", target: "router" },
    ]);
  });

  it("drops an oversized record through its newline, then resumes at the next valid record", () => {
    const { decoder, signals } = fixture("codex");
    decoder.write(Buffer.from('{"type":"turn.started","padding":"'));
    for (let i = 0; i < 100; i++) decoder.write(Buffer.alloc(4096, "x"));
    decoder.write(Buffer.from('"}\n{"type":"turn.started"}\n'));
    decoder.end();
    expect(signals).toEqual([{ kind: "working", state: "running" }]);
  });

  it("drops huge single chunks without retaining them and ignores oversized EOF", () => {
    const { decoder, signals } = fixture("codex");
    decoder.write(Buffer.concat([Buffer.alloc(200_000, "x"), Buffer.from('\n{"type":"turn.started"}\n'), Buffer.alloc(200_000, "x")]));
    decoder.end();
    expect(signals).toEqual([{ kind: "working", state: "running" }]);
  });

  it("ignores malformed JSON, invalid UTF-8, primitives, arrays, and unknown envelopes", () => {
    const { decoder, signals } = fixture("codex");
    decoder.write(Buffer.from('not json\nnull\n42\n[]\n{"item":{"type":"file_change"}}\n'));
    decoder.write(Buffer.concat([Buffer.from('{"type":"turn.started","x":"'), Buffer.from([0xff]), Buffer.from('"}\n')]));
    decoder.write(Buffer.from('{"type":"turn.started"}\n'));
    expect(signals).toEqual([{ kind: "working", state: "running" }]);
  });

  it("processes EOF once and ignores later writes", () => {
    const { decoder, signals } = fixture("codex");
    decoder.write(Buffer.from('{"type":"turn.completed"}'));
    decoder.end();
    decoder.end();
    decoder.write(Buffer.from('{"type":"turn.started"}\n'));
    expect(signals).toEqual([{ kind: "completed", state: "completed" }]);
    expect(decoder.completed).toBe(true);
  });

  it.each(["claude", "codex"] as const)("requires a recognized terminal success from %s", (tool) => {
    const { decoder, send } = fixture(tool);
    expect(decoder.completed).toBe(false);
    send(tool === "claude" ? { type: "result", subtype: "success", is_error: false } : { type: "turn.completed" });
    expect(decoder.completed).toBe(true);
    send(tool === "claude" ? { type: "system", subtype: "init" } : { type: "turn.started" });
    expect(decoder.completed).toBe(false);
  });

  it.each(["claude", "codex"] as const)("does not accept malformed, truncated, or oversized %s final records as completion", (tool) => {
    const terminal = tool === "claude" ? { type: "result", subtype: "success", is_error: false } : { type: "turn.completed" };
    for (const final of [
      "not json\n",
      JSON.stringify(terminal).slice(0, -1),
      JSON.stringify({ ...terminal, result: "x".repeat(70_000) }) + "\n",
      JSON.stringify({ ...terminal, is_error: true, result: "x".repeat(70_000) }) + "\n",
    ]) {
      const { decoder } = fixture(tool);
      decoder.write(Buffer.from(final));
      decoder.end();
      expect(decoder.completed).toBe(false);
    }
  });

  it.each([
    [".mex/context/architecture.md", "architecture"], [".mex/context/stack.md", "stack"],
    [".mex/context/conventions.md", "conventions"], [".mex/context/decisions.md", "decisions"],
    [".mex/context/setup.md", "setup"], ["./.mex/ROUTER.md", "router"],
    ["C:\\private\\.mex\\AGENTS.md", "agents"], [".mex/patterns/secure-local-project-hub.md", "patterns"],
    [".mex/patterns/../private.md", undefined], [".mex/context/private.md", undefined],
    [".mex-secret/context/architecture.md", undefined], ["architecture.md", undefined],
    ["x".repeat(2049) + "/.mex/ROUTER.md", undefined],
  ])("projects only a closed target for %s", (path, target) => {
    const { send, signals } = fixture("codex");
    send({ type: "item.completed", item: { type: "file_change", changes: [{ path, kind: "update" }] } });
    expect(signals).toEqual([{ kind: "writing", state: "completed", ...(target ? { target } : {}) }]);
  });
});


describe("provider usage-limit fixtures", () => {
  const text = "You've hit your limit ? resets 5:30pm (Asia/Kolkata)";
  it.each([
    { type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text }] } },
    { type: "assistant", error: "rate_limit", message: { content: [] } },
    { type: "result", is_error: true, result: text },
    { type: "result", is_error: true, api_error_status: 429 },
    { type: "result", subtype: "error_during_execution", is_error: true, errors: [text] },
    { type: "result", is_error: true, error: { type: "rate_limit_error", message: text } },
  ])("recognizes %j even after partial work", (event) => {
    const decoder = createPopulationActivityDecoder("claude", () => {});
    decoder.write(Buffer.from(JSON.stringify({ type: "result", subtype: "success" }) + "\n"));
    const bytes = Buffer.from(JSON.stringify(event));
    for (let i = 0; i < bytes.length; i += 7) decoder.write(bytes.subarray(i, i + 7));
    decoder.end();
    expect(decoder.usageLimited).toBe(true);
    expect(decoder.completed).toBe(false);
    if (JSON.stringify(event).includes("5:30pm")) expect(decoder.resetTime).toBe("5:30pm (Asia/Kolkata)");
  });
  it.each(["file size limit exceeded", "context limit reached", "turn limit exceeded", "limit is undefined", "maximum output tokens exceeded"])("does not mistake %s for account quota", (text) => {
    const decoder = createPopulationActivityDecoder("claude", () => {});
    decoder.write(Buffer.from(JSON.stringify({ type: "result", is_error: true, result: text })));
    decoder.end();
    expect(decoder.failed).toBe(true);
    expect(decoder.usageLimited).toBe(false);
  });
  it("does not classify ordinary assistant prose as a provider failure", () => {
    const decoder = createPopulationActivityDecoder("claude", () => {});
    decoder.write(Buffer.from(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })));
    decoder.end();
    expect(decoder.usageLimited).toBe(false);
  });
});

it.each(["allowed", "allowed_warning", "rejected"])("handles documented rate_limit_event status %s", (status) => {
  const decoder = createPopulationActivityDecoder("claude", () => {});
  decoder.write(Buffer.from(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status, resetsAt: 1792859400 } })));
  decoder.end();
  expect(decoder.usageLimited).toBe(status === "rejected");
  if (status === "rejected") expect(decoder.resetTime).toBe(new Date(1792859400000).toISOString());
});
it("keeps rate-limit warnings advisory when overage or a completed result permits work", () => {
  for (const overageStatus of ["allowed", undefined]) {
    const decoder = createPopulationActivityDecoder("claude", () => {});
    decoder.write(Buffer.from(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", overageStatus } }) + "\n"));
    decoder.write(Buffer.from(JSON.stringify({ type: "result", subtype: "success", is_error: false })));
    decoder.end();
    expect(decoder.completed).toBe(true);
    expect(decoder.usageLimited).toBe(false);
  }
});

it("retains the reset epoch from older provider limit results", () => {
  const decoder = createPopulationActivityDecoder("claude", () => {});
  decoder.write(Buffer.from(JSON.stringify({ type: "result", is_error: true, result: "Claude AI usage limit reached|1760000000" })));
  decoder.end();
  expect(decoder.resetTime).toBe("2025-10-09T08:53:20.000Z");
});

it("leaves a non-limit assistant error to the result record", () => {
  const decoder = createPopulationActivityDecoder("claude", () => {});
  decoder.write(Buffer.from(JSON.stringify({ type: "assistant", error: "server_error", message: { content: [] } }) + "\n"));
  decoder.write(Buffer.from(JSON.stringify({ type: "result", subtype: "success", is_error: false })));
  decoder.end();
  expect(decoder.usageLimited).toBe(false);
  expect(decoder.completed).toBe(true);
});

it("does not treat an absent assistant error encoded as null as failure", () => {
  const decoder = createPopulationActivityDecoder("claude", () => {});
  decoder.write(Buffer.from(JSON.stringify({ type: "assistant", error: null, message: { content: [] } }) + "\n"));
  decoder.write(Buffer.from(JSON.stringify({ type: "result", subtype: "success", is_error: false })));
  decoder.end();
  expect(decoder.completed).toBe(true);
});
