#!/usr/bin/env node
// Stand-in for `claude -p` that emits a minimal stream-json transcript, so the
// run pipeline can be exercised end to end without a model session.
const prompt = process.argv[process.argv.indexOf("-p") + 1] ?? "";
const change = (process.argv[process.argv.indexOf("--append-system-prompt") + 1] ?? prompt).includes("Do not commit");
const usage = { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 7 };
const structured = change
  ? { summary: "No change made; fake agent run.", filesChanged: [], testsRun: "none" }
  : { answer: "The fake agent answers without reading the repository at all.", symbols: ["fetch"], evidence: [{ path: "src/hono-base.ts", line: 1 }], complete: false };
const events = [
  { type: "system", subtype: "init" },
  { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/hono-base.ts" } }], usage } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "source" }] } },
  { type: "result", structured_output: structured, num_turns: 1, usage, total_cost_usd: 0 },
];
process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
