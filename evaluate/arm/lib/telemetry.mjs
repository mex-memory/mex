import { claudeAdapter } from "../../adapters/agents/claude.mjs";
import { streamEvents } from "./measures.mjs";
import { classifyCall } from "./classify.mjs";

export function parseSession(raw, task) {
  const parsed = claudeAdapter.parseTranscript(raw, { ...task, gold: [] });
  const events = streamEvents(raw);
  const turns = events.filter((e) => e.type === "result").at(-1)?.num_turns ?? null;
  const messages = parsed.usage.perMessage?.uniqueMessageCount
    ?? new Set(events.filter((e) => e.type === "assistant" && e.message?.usage).map((e, i) => e.message.id ?? i)).size;
  parsed.accounting = { valid: parsed.usage.accountingValid, reason: parsed.usage.accountingReason,
    terminalTurns: turns, capturedMessages: messages, countMismatch: turns !== null && turns !== messages,
    status: !parsed.usage.accountingValid ? "incomplete-usage-invalid" : turns !== null && turns !== messages ? "turn-message-mismatch" : "verified" };
  return parsed;
}

// Union of test tool intervals, so parallel commands are never subtracted twice.
export function testCommandTime(raw, calls) {
  const ids = new Set(calls.filter((c) => classifyCall(c).category === "test").map((c) => c.id));
  const starts = new Map(), ends = new Map();
  for (const e of streamEvents(raw)) for (const b of e.message?.content ?? []) {
    const at = Date.parse(e.timestamp);
    if (!Number.isFinite(at)) continue;
    if (b.type === "tool_use" && ids.has(b.id) && !starts.has(b.id)) starts.set(b.id, at);
    if (b.type === "tool_result" && ids.has(b.tool_use_id)) ends.set(b.tool_use_id, at);
  }
  const intervals = [...ids].filter((id) => starts.has(id) && ends.get(id) >= starts.get(id))
    .map((id) => [starts.get(id), ends.get(id)]).sort((a, b) => a[0] - b[0]);
  let total = 0, end = -Infinity;
  for (const [a, b] of intervals) { total += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
  return { ms: intervals.length === ids.size ? total : null, commands: ids.size, timedCommands: intervals.length,
    status: intervals.length === ids.size ? "complete" : "missing-timestamps" };
}
