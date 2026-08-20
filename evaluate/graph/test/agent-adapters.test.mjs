import assert from "node:assert/strict";
import test from "node:test";
import { claudeAdapter } from "../../adapters/agents/claude.mjs";
import { codexAdapter } from "../../adapters/agents/codex.mjs";
import { ANSWER_SCHEMA } from "../../compare/lib/answer.mjs";

const task = {
  id: "target",
  gold: [{ symbol: "TargetSymbol", kind: "function", path: "src/subject.ts" }],
  expectedSymbols: ["TargetSymbol"],
};
const answer = { answer: "TargetSymbol is declared in the cited source and implements the requested behavior.", symbols: ["TargetSymbol"], evidence: [{ path: "src/subject.ts", line: 1 }], complete: true };
const fact = '{"type":"fact","name":"TargetSymbol","kind":"function","filePath":"src/subject.ts"}\n';

test("Claude adapter keeps cache composition and computes new-token work", () => {
  const raw = [
    { type: "assistant", message: { id: "m1", usage: { input_tokens: 11, cache_creation_input_tokens: 12, cache_read_input_tokens: 13, output_tokens: 14 }, content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: 'node mex.js graph scope "question"' } }] } },
    { type: "system", subtype: "hook_started", hook_id: "h1", hook_name: "PreToolUse:Bash", hook_event: "PreToolUse" },
    { type: "system", subtype: "hook_response", hook_id: "h1", hook_name: "PreToolUse:Bash", hook_event: "PreToolUse", output: "{}\n", stdout: "{}\n", stderr: "", exit_code: 0, outcome: "success" },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: fact }] } },
    { type: "result", structured_output: answer, usage: { input_tokens: 11, cache_creation_input_tokens: 12, cache_read_input_tokens: 13, output_tokens: 14 }, total_cost_usd: 0.25, num_turns: 1, permission_denials: [] },
  ].map(JSON.stringify).join("\n");
  const parsed = claudeAdapter.parseTranscript(raw, task);
  assert.deepEqual({
    uncachedInput: parsed.usage.uncachedInput,
    cacheWrite: parsed.usage.cacheWrite,
    cacheRead: parsed.usage.cacheRead,
    output: parsed.usage.output,
    reportedTotal: parsed.usage.reportedTotal,
    newTokens: parsed.usage.newTokens,
  }, { uncachedInput: 11, cacheWrite: 12, cacheRead: 13, output: 14, reportedTotal: 50, newTokens: 37 });
  assert.equal(parsed.graph.initialScopeRank, 1);
  assert.equal(parsed.usage.accountingValid, true);
  assert.equal(parsed.bashGuardLifecycle.valid, true);
  assert.equal(parsed.bashGuardLifecycle.complete, 1);
  assert.equal(parsed.structured.ok, true);
});

test("Claude adapter deduplicates terminal permission denials by tool_use_id", () => {
  const denial = { tool_name: "Bash", tool_use_id: "denied-1", reason: "blocked by eval guard" };
  const raw = [
    { type: "assistant", message: { id: "m-denied", usage: { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 5, output_tokens: 7 }, content: [{ type: "tool_use", id: "denied-1", name: "Bash", input: { command: "git status" } }] } },
    { type: "system", subtype: "hook_started", hook_id: "h-denied", hook_name: "PreToolUse:Bash", hook_event: "PreToolUse" },
    { type: "system", subtype: "hook_response", hook_id: "h-denied", hook_name: "PreToolUse:Bash", hook_event: "PreToolUse", output: "denied", stdout: "denied", stderr: "", exit_code: 0, outcome: "success" },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "denied-1", content: "MEX_EVAL_BASH_DENIED: unrelated Bash command", is_error: true }] } },
    { type: "result", structured_output: answer, usage: { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 5, output_tokens: 7 }, permission_denials: [denial, { ...denial }] },
  ].map(JSON.stringify).join("\n");
  const parsed = claudeAdapter.parseTranscript(raw, task);
  assert.equal(parsed.permissionDenials, 1);
  assert.equal(parsed.permissionDenialDetails.length, 1);
  assert.equal(parsed.duplicatePermissionDenials, 1);
  assert.equal(parsed.unmatchedPermissionDenials, 0);
  assert.equal(parsed.toolCalls[0].status, "denied");
  assert.equal(parsed.bashGuardLifecycle.valid, true);
});

test("Claude adapter deduplicates repeated assistant message IDs and rejects terminal mismatches", () => {
  const assistant = { type: "assistant", message: { id: "same", usage: { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 5, output_tokens: 7 }, content: [] } };
  const valid = claudeAdapter.parseTranscript([
    assistant,
    assistant,
    { type: "result", structured_output: answer, usage: { input_tokens: 2, cache_creation: 3, cache_read: 5, output_tokens: 7 } },
  ].map(JSON.stringify).join("\n"), task);
  assert.equal(valid.usage.accountingValid, true);
  assert.equal(valid.usage.perMessage.uniqueMessageCount, 1);
  assert.equal(valid.usage.perMessage.duplicateEventCount, 1);
  assert.equal(valid.usage.reportedTotal, 17);

  const invalid = claudeAdapter.parseTranscript([
    assistant,
    { type: "result", structured_output: answer, usage: { input_tokens: 99, cache_creation: 3, cache_read: 5, output_tokens: 7 } },
  ].map(JSON.stringify).join("\n"), task);
  assert.equal(invalid.usage.accountingValid, false);
  assert.equal(invalid.usage.newTokens, null);
  assert.equal(invalid.usage.terminal.inputTokens, 99);
  assert.equal(invalid.usage.perMessage.inputTokens, 2);
});

test("Codex adapter subtracts cached input while preserving the raw usage event", () => {
  const raw = [
    { type: "thread.started", thread_id: "fake" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "c1", type: "command_execution", command: 'node mex.js graph scope "question"', status: "in_progress" } },
    { type: "item.completed", item: { id: "c1", type: "command_execution", command: 'node mex.js graph scope "question"', aggregated_output: fact, exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "a1", type: "agent_message", text: JSON.stringify(answer) } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10, reasoning_output_tokens: 4 } },
  ].map(JSON.stringify).join("\n");
  const parsed = codexAdapter.parseTranscript(raw, task);
  assert.deepEqual({
    uncachedInput: parsed.usage.uncachedInput,
    cacheWrite: parsed.usage.cacheWrite,
    cacheRead: parsed.usage.cacheRead,
    output: parsed.usage.output,
    reportedInput: parsed.usage.reportedInput,
    reportedTotal: parsed.usage.reportedTotal,
    newTokens: parsed.usage.newTokens,
  }, { uncachedInput: 40, cacheWrite: null, cacheRead: 60, output: 10, reportedInput: 100, reportedTotal: 110, newTokens: 50 });
  assert.equal(parsed.usage.raw[0].reasoning_output_tokens, 4);
  assert.equal(parsed.graph.initialScopeRank, 1);
});

test("headless invocations are ephemeral and use local CLI authentication paths", () => {
  const claude = claudeAdapter.buildInvocation({
    prompt: "p", model: "m", schema: ANSWER_SCHEMA, subjectRoot: "/repo",
    tools: "Read,Grep,Glob,Bash",
    allowedTools: ["Read", "Grep", "Glob", "Bash(node /tmp/graph-command.mjs graph *)"],
    settingsPath: "/tmp/claude-settings.json",
  });
  assert.equal(claude.command, "claude");
  assert.equal(claude.args.includes("--no-session-persistence"), true);
  assert.equal(claude.args.includes("--safe-mode"), false);
  assert.equal(claude.args[claude.args.indexOf("--settings") + 1], "/tmp/claude-settings.json");
  assert.equal(claude.args[claude.args.indexOf("--setting-sources") + 1], "");
  assert.equal(claude.args[claude.args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(claude.args[claude.args.indexOf("--tools") + 1], "Read,Grep,Glob,Bash");
  assert.deepEqual(claude.args.slice(claude.args.indexOf("--allowedTools") + 1), [
    "Read", "Grep", "Glob", "Bash(node /tmp/graph-command.mjs graph *)",
  ]);
  assert.equal(claude.args.includes("--strict-mcp-config"), true);
  assert.equal(claude.args.includes("--no-chrome"), true);
  assert.equal(claude.args.includes("--disable-slash-commands"), true);
  assert.equal(claude.args.includes("--include-hook-events"), true);
  const codex = codexAdapter.buildInvocation({ prompt: "p", model: "m", schemaPath: "/tmp/schema.json", subjectRoot: "/repo" });
  assert.equal(codex.command, "codex");
  assert.equal(codex.args.slice(0, 2).join(" "), "exec --ephemeral");
  assert.equal(codex.args.includes("--json"), true);
  assert.equal(codex.args.includes("--output-schema"), true);
});
