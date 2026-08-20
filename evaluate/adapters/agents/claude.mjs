import { parseStructuredAnswer } from "../../compare/lib/answer.mjs";
import { BASH_GUARD_DENIAL } from "../../compare/lib/bash-guard.mjs";
import { contentText, parseEventStream, toolMetrics, usageRecord } from "./shared.mjs";

const CLAUDE_BASH_HOOK_NAME = "PreToolUse:Bash";

function bashGuardLifecycle(events, toolCalls) {
  const lifecycle = events.filter((event) => event?.type === "system"
    && ["hook_started", "hook_response"].includes(event.subtype)
    && event.hook_event === "PreToolUse"
    && event.hook_name === CLAUDE_BASH_HOOK_NAME);
  const unique = new Map();
  let malformed = 0;
  for (const event of lifecycle) {
    if (typeof event.hook_id !== "string" || !event.hook_id) { malformed += 1; continue; }
    unique.set(`${event.subtype}:${event.hook_id}`, event);
  }
  const starts = [...unique.values()].filter((event) => event.subtype === "hook_started");
  const responses = [...unique.values()].filter((event) => event.subtype === "hook_response");
  const startIds = new Set(starts.map((event) => event.hook_id));
  const responseIds = new Set(responses.map((event) => event.hook_id));
  const completeIds = [...startIds].filter((id) => responseIds.has(id));
  const bashCalls = toolCalls.filter((call) => call.name === "Bash").length;
  const violations = [];
  if (malformed) violations.push(`${malformed} malformed guard lifecycle event(s)`);
  if (starts.length !== responses.length || completeIds.length !== starts.length) {
    violations.push(`${starts.length} guard start(s), ${responses.length} response(s), ${completeIds.length} complete pair(s)`);
  }
  if (completeIds.length !== bashCalls) {
    violations.push(`${bashCalls} Bash tool use(s) but ${completeIds.length} complete guard lifecycle pair(s)`);
  }
  const failed = responses.filter((event) => event.outcome !== "success" || event.exit_code !== 0);
  if (failed.length) {
    violations.push(`${failed.length} guard response(s) did not complete successfully with exit 0`);
  }
  return {
    valid: violations.length === 0,
    bashCalls,
    starts: starts.length,
    responses: responses.length,
    complete: completeIds.length,
    duplicateEvents: Math.max(0, lifecycle.length - unique.size - malformed),
    responseOutcomes: responses.map((event) => ({
      hookId: event.hook_id,
      outcome: event.outcome ?? null,
      exitCode: Number.isFinite(Number(event.exit_code)) ? Number(event.exit_code) : null,
    })),
    violations,
  };
}

export const claudeAdapter = {
  id: "claude",

  buildInvocation({
    executable = "claude", prefix = [], prompt, model, schema, subjectRoot,
    tools = "Read,Grep,Glob,Bash", allowedTools = [], settingsPath = null,
  }) {
    const isolationArgs = settingsPath
      ? ["--settings", settingsPath, "--strict-mcp-config", "--no-chrome", "--disable-slash-commands", "--include-hook-events"]
      : ["--safe-mode"];
    return {
      command: executable,
      args: [
        ...prefix,
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        ...isolationArgs,
        "--setting-sources", "",
        "--no-session-persistence",
        "--exclude-dynamic-system-prompt-sections",
        "--permission-mode", "dontAsk",
        "--model", model,
        "--json-schema", JSON.stringify(schema),
        "--add-dir", subjectRoot,
        "--tools", tools,
        ...(allowedTools.length ? ["--allowedTools", ...allowedTools] : []),
      ],
    };
  },

  parseTranscript(raw, task) {
    const { events, malformedLines } = parseEventStream(raw, "Claude stream");
    const rawUsage = [];
    const usageByMessage = new Map();
    const messageUsageEvents = [];
    const toolCalls = [];
    const byId = new Map();
    let resultValue = "";
    let reportedCostUsd = null;
    let turns = null;
    let resultPermissionDenials = [];
    let terminalUsage = null;
    let terminalApiErrorStatus = null;
    let terminalReason = null;
    const rateLimitEvents = [];
    let anonymousMessage = 0;
    for (const event of events) {
      if (event.type === "rate_limit_event") {
        rateLimitEvents.push(event.rate_limit_info ?? {});
      } else if (event.type === "assistant") {
        const value = event.message?.usage;
        if (value) {
          rawUsage.push(value);
          const messageId = typeof event.message?.id === "string" && event.message.id
            ? event.message.id
            : `anonymous-${++anonymousMessage}`;
          const normalized = {
            messageId,
            inputTokens: Number(value.input_tokens ?? 0),
            cacheWrite: Number(value.cache_creation_input_tokens ?? value.cache_creation ?? 0),
            cacheRead: Number(value.cache_read_input_tokens ?? value.cache_read ?? 0),
            output: Number(value.output_tokens ?? value.output ?? 0),
          };
          messageUsageEvents.push(normalized);
          usageByMessage.set(messageId, normalized);
        }
        for (const block of event.message?.content ?? []) {
          if (block.type !== "tool_use") continue;
          if (block.id && byId.has(block.id)) continue;
          const call = { id: block.id ?? null, name: block.name, input: block.input ?? {}, status: "attempted", output: null };
          toolCalls.push(call);
          if (call.id) byId.set(call.id, call);
        }
      } else if (event.type === "user") {
        for (const block of event.message?.content ?? []) {
          if (block.type !== "tool_result") continue;
          const call = byId.get(block.tool_use_id);
          if (!call) continue;
          call.output = contentText(block.content);
          if (block.is_error && call.output.includes(BASH_GUARD_DENIAL)) {
            call.status = "denied";
            call.denialSource = "eval-bash-guard";
          } else {
            call.status = block.is_error ? "error" : "executed";
          }
        }
      } else if (event.type === "result") {
        resultValue = event.structured_output ?? event.result ?? resultValue;
        if (Number.isFinite(Number(event.total_cost_usd))) reportedCostUsd = Number(event.total_cost_usd);
        if (Number.isFinite(Number(event.num_turns))) turns = Number(event.num_turns);
        resultPermissionDenials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
        if (event.usage && typeof event.usage === "object") terminalUsage = event.usage;
        if (event.api_error_status !== null && event.api_error_status !== undefined
          && Number.isFinite(Number(event.api_error_status))) terminalApiErrorStatus = Number(event.api_error_status);
        if (typeof event.terminal_reason === "string") terminalReason = event.terminal_reason;
      }
    }
    const rejectedRateLimit = rateLimitEvents.find((event) => event?.status === "rejected") ?? null;
    const providerFailure = rejectedRateLimit || terminalApiErrorStatus === 429 ? {
      provider: "claude",
      type: "rate_limit",
      retryable: true,
      rateLimitStatus: rejectedRateLimit?.status ?? null,
      rateLimitType: rejectedRateLimit?.rateLimitType ?? null,
      resetsAt: rejectedRateLimit?.resetsAt !== null && rejectedRateLimit?.resetsAt !== undefined
        && Number.isFinite(Number(rejectedRateLimit.resetsAt)) ? Number(rejectedRateLimit.resetsAt) : null,
      apiErrorStatus: terminalApiErrorStatus,
      terminalReason,
    } : null;
    const uniqueMessages = [...usageByMessage.values()];
    const messageTotals = uniqueMessages.reduce((totals, value) => ({
      inputTokens: totals.inputTokens + value.inputTokens,
      cacheWrite: totals.cacheWrite + value.cacheWrite,
      cacheRead: totals.cacheRead + value.cacheRead,
      output: totals.output + value.output,
    }), { inputTokens: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
    const terminal = terminalUsage ? {
      inputTokens: Number(terminalUsage.input_tokens ?? 0),
      cacheWrite: Number(terminalUsage.cache_creation_input_tokens ?? terminalUsage.cache_creation ?? 0),
      cacheRead: Number(terminalUsage.cache_read_input_tokens ?? terminalUsage.cache_read ?? 0),
      output: Number(terminalUsage.output_tokens ?? terminalUsage.output ?? 0),
    } : null;
    const accountingValid = terminal !== null
      && terminal.inputTokens === messageTotals.inputTokens
      && terminal.cacheWrite === messageTotals.cacheWrite
      && terminal.cacheRead === messageTotals.cacheRead;
    const accountingReason = terminal === null
      ? "missing_terminal_usage"
      : accountingValid
        ? null
        : "terminal_unique_message_input_cache_mismatch";
    const selected = accountingValid ? terminal : null;
    const usage = usageRecord({
      uncachedInput: selected?.inputTokens,
      cacheWrite: selected?.cacheWrite,
      cacheRead: selected?.cacheRead,
      output: selected?.output,
      reportedInput: selected ? selected.inputTokens + selected.cacheWrite + selected.cacheRead : null,
      reportedTotal: selected ? selected.inputTokens + selected.cacheWrite + selected.cacheRead + selected.output : null,
      reportedCostUsd,
      accountingValid,
      accountingReason,
    }, rawUsage, {
      terminal: terminal ? {
        ...terminal,
        processed: terminal.inputTokens + terminal.cacheWrite + terminal.cacheRead + terminal.output,
        raw: terminalUsage,
      } : null,
      perMessage: {
        uniqueMessageCount: uniqueMessages.length,
        duplicateEventCount: Math.max(0, messageUsageEvents.length - uniqueMessages.length),
        inputTokens: messageTotals.inputTokens,
        cacheWrite: messageTotals.cacheWrite,
        cacheRead: messageTotals.cacheRead,
        output: messageTotals.output,
        processed: messageTotals.inputTokens + messageTotals.cacheWrite + messageTotals.cacheRead + messageTotals.output,
        messages: uniqueMessages,
      },
    });
    const seenPermissionDenialToolIds = new Set();
    const uniqueResultPermissionDenials = resultPermissionDenials.filter((denial) => {
      const toolUseId = typeof denial?.tool_use_id === "string" && denial.tool_use_id ? denial.tool_use_id : null;
      if (!toolUseId) return true;
      if (seenPermissionDenialToolIds.has(toolUseId)) return false;
      seenPermissionDenialToolIds.add(toolUseId);
      return true;
    });
    const unmatchedPermissionDenials = [];
    for (const denial of uniqueResultPermissionDenials) {
      const call = typeof denial?.tool_use_id === "string" ? byId.get(denial.tool_use_id) : null;
      if (!call) { unmatchedPermissionDenials.push(denial); continue; }
      call.status = "denied";
      call.permissionDenial = denial;
    }
    const synthesizedPermissionDenials = toolCalls
      .filter((call) => call.status === "denied" && !call.permissionDenial)
      .map((call) => ({ tool_name: call.name, tool_use_id: call.id, source: call.denialSource ?? "tool_result" }));
    const permissionDenialDetails = [...uniqueResultPermissionDenials, ...synthesizedPermissionDenials];
    const tools = toolMetrics(toolCalls, task);
    const guardLifecycle = bashGuardLifecycle(events, toolCalls);
    return {
      provider: "claude",
      usage,
      turns,
      toolCalls,
      ...tools,
      permissionDenials: toolCalls.filter((call) => call.status === "denied").length + unmatchedPermissionDenials.length,
      permissionDenialDetails,
      duplicatePermissionDenials: resultPermissionDenials.length - uniqueResultPermissionDenials.length,
      unmatchedPermissionDenials: unmatchedPermissionDenials.length,
      bashGuardLifecycle: guardLifecycle,
      providerFailure,
      malformedLines,
      structured: parseStructuredAnswer(resultValue),
      rawResult: resultValue,
    };
  },
};
