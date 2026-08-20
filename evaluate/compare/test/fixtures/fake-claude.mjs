import { appendFileSync, readFileSync } from "node:fs";

const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
if (mode === "timeout") setTimeout(() => {}, 60_000);
else if (mode === "failure") { process.stderr.write("fake failure\n"); process.exit(7); }
else {
  const valueAfter = (flag) => process.argv[process.argv.indexOf(flag) + 1];
  const settingsPath = valueAfter("--settings");
  const settings = settingsPath ? JSON.parse(readFileSync(settingsPath, "utf8")) : null;
  const hook = settings?.hooks?.PreToolUse?.[0];
  const hookCommand = hook?.hooks?.[0];
  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const emitGuardLifecycle = (toolId) => {
    if (mode === "missing-hook-events") return;
    const hookId = `hook-${toolId}`;
    const common = {
      type: "system",
      hook_id: hookId,
      hook_name: "PreToolUse:Bash",
      hook_event: "PreToolUse",
    };
    emit({ ...common, subtype: "hook_started" });
    emit({
      ...common,
      subtype: "hook_response",
      output: mode === "guard-hook-error" ? "guard failed" : "{}\n",
      stdout: mode === "guard-hook-error" ? "" : "{}\n",
      stderr: mode === "guard-hook-error" ? "guard failed" : "",
      exit_code: mode === "guard-hook-error" ? 2 : 0,
      outcome: mode === "guard-hook-error" ? "error" : "success",
    });
  };
  if (mode === "permission-config") {
    const allowedIndex = process.argv.indexOf("--allowedTools");
    const allowed = process.argv.slice(allowedIndex + 1).filter((value) => !value.startsWith("--"));
    const valid = valueAfter("--permission-mode") === "dontAsk"
      && valueAfter("--setting-sources") === ""
      && valueAfter("--tools") === "Read,Grep,Glob,Bash"
      && process.argv.includes("--strict-mcp-config")
      && process.argv.includes("--no-chrome")
      && process.argv.includes("--disable-slash-commands")
      && process.argv.includes("--include-hook-events")
      && !process.argv.includes("--safe-mode")
      && allowed.includes("Read") && allowed.includes("Grep") && allowed.includes("Glob")
      && ["graph scope *", "graph query *", "graph get *", "impact *"]
        .every((suffix) => allowed.some((value) => value.startsWith("Bash(") && value.includes(suffix)))
      && !allowed.includes("Bash")
      && hook?.matcher === "Bash"
      && hookCommand?.type === "command"
      && hookCommand.command === "/bin/sh"
      && Array.isArray(hookCommand.args)
      && hookCommand.args[0] === "-c"
      && hookCommand.args.some((value) => value.endsWith("/bash-guard.mjs"))
      && hookCommand.args.some((value) => value.endsWith("/bash-guard.json"))
      && hookCommand.statusMessage === "MEX eval Bash policy guard";
    if (!valid) { process.stderr.write("unsafe Claude permission configuration\n"); process.exit(8); }
  }
  const promptIndex = process.argv.indexOf("-p");
  const prompt = process.argv[promptIndex + 1] ?? "";
  if (process.env.FAKE_CLAUDE_DRIFT_PATH
    && (!process.env.FAKE_CLAUDE_DRIFT_QUESTION
      || prompt.includes(`Question: ${process.env.FAKE_CLAUDE_DRIFT_QUESTION}`))) {
    appendFileSync(process.env.FAKE_CLAUDE_DRIFT_PATH, "\n// concurrent comparison drift\n");
  }
  const rateLimitApplies = ["allowed-warning", "rate-limit"].includes(mode)
    && (!process.env.FAKE_CLAUDE_RATE_LIMIT_QUESTION
      || prompt.includes(`Question: ${process.env.FAKE_CLAUDE_RATE_LIMIT_QUESTION}`));
  if (rateLimitApplies) {
    emit({
      type: "rate_limit_event",
      rate_limit_info: mode === "rate-limit"
        ? { status: "rejected", resetsAt: 1_787_160_600, rateLimitType: "five_hour", overageStatus: "rejected" }
        : { status: "allowed_warning", resetsAt: 1_787_160_600, rateLimitType: "five_hour", utilization: 0.94 },
    });
  }
  if (rateLimitApplies && mode === "rate-limit") {
    emit({
      type: "assistant",
      error: "rate_limit",
      is_api_error_message: true,
      message: {
        id: "assistant-rate-limit",
        usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
        content: [{ type: "text", text: "You've hit your session limit" }],
      },
    });
    emit({
      type: "result",
      subtype: "success",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 429,
      result: "You've hit your session limit",
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
      num_turns: 1,
      permission_denials: [],
    });
  } else {
    const graphPrefix = prompt.match(/Start with `(.+?) graph scope/);
    const toolId = "tool-1";
    const permissionDenials = [];
    if (graphPrefix) {
      const command = `${graphPrefix[1]} graph scope "fake question"`;
      emit({ type: "assistant", message: { id: "assistant-1", usage: { input_tokens: 11, cache_creation_input_tokens: 12, cache_read_input_tokens: 13, output_tokens: 14 }, content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command } }] } });
      emitGuardLifecycle(toolId);
      emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolId, content: '{"type":"meta","command":"graph scope"}\n{"type":"fact","id":"fake","name":"FakeSymbol","filePath":"src/fake.ts","startLine":1,"endLine":1}\n{"type":"source","filePath":"src/fake.ts","ranges":[{"startLine":1,"endLine":1,"content":"function FakeSymbol() {}"}]}\n{"type":"summary","status":"ok"}\n' }] } });
      if (mode === "denied-file-shell") {
        const deniedId = "tool-denied-file-shell";
        const readId = "tool-read";
        emit({ type: "assistant", message: { id: "assistant-2", usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, content: [{ type: "tool_use", id: deniedId, name: "Bash", input: { command: "cd /repo && grep -R FakeSymbol src | head -20" } }] } });
        emitGuardLifecycle(deniedId);
        emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: deniedId, content: "MEX_EVAL_BASH_DENIED: only the exact graph wrapper is allowed", is_error: true }] } });
        emit({ type: "assistant", message: { id: "assistant-3", usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, content: [{ type: "tool_use", id: readId, name: "Read", input: { file_path: "/repo/src/fake.ts" } }] } });
        emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: readId, content: "function FakeSymbol() {}" }] } });
      }
    } else {
      emit({ type: "assistant", message: { id: "assistant-1", usage: { input_tokens: 11, cache_creation_input_tokens: 12, cache_read_input_tokens: 13, output_tokens: 14 }, content: [{ type: "tool_use", id: toolId, name: "Grep", input: { pattern: "FakeSymbol" } }] } });
      emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolId, content: "src/fake.ts:1:function FakeSymbol() {}" }] } });
    }
    const structuredOutput = mode === "schema-invalid"
      ? { answer: "test", symbols: ["FakeSymbol"], evidence: [{ path: "src/fake.ts", line: 1 }], complete: true }
      : { answer: "FakeSymbol is declared in the cited source and implements the requested behavior.", symbols: ["FakeSymbol"], evidence: [{ path: "src/fake.ts", line: 1 }], complete: true };
    emit({ type: "result", structured_output: structuredOutput, usage: { input_tokens: 11, cache_creation_input_tokens: 12, cache_read_input_tokens: 13, output_tokens: 14 }, total_cost_usd: 0.001, num_turns: 1, permission_denials: permissionDenials });
  }
}
