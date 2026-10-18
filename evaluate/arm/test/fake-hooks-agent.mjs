#!/usr/bin/env node
// Stand-in for `claude -p` that also does what Claude Code does around hooks: it reads the
// checkout's `.claude/settings.json`, and for each step of a scripted session it runs the hook
// commands registered for that event with the same kind of JSON payload on stdin, from the
// project directory, with `CLAUDE_PROJECT_DIR` set and the session's own environment (PATH
// included). It exercises the harness and the wiring from settings to hook command to log.
// It does not prove Claude Code's own behaviour (payload details, timeouts, parallel hooks).
//
// Session script: prompt -> Read a file the knowledge links to -> Grep it -> (change tasks) apply
// the upstream fix and report each edited file -> Stop. A Stop that blocks is followed by a second
// Stop with `stop_hook_active`, as Claude Code does after the agent answers a block.
//
// FAKE_AGENT_FIXES: path of a JSON file { "<first 60 chars of the task prompt>": { base, fix, exclude: [paths] } }.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-claude 0.0.0 (agent-arm test stand-in)\n");
  process.exit(0);
}
const prompt = process.argv[process.argv.indexOf("-p") + 1] ?? "";
const change = prompt.includes("Do not commit");
const cwd = process.cwd();
const sessionId = randomUUID();
const usage = { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: process.env.FAKE_COLD_START === "1" ? 0 : 6000, output_tokens: 7 };

const bash = process.platform === "win32" ? ["C:\\Program Files\\Git\\bin\\bash.exe", ["-c"]] : ["sh", ["-c"]];
const env = { ...process.env, CLAUDE_PROJECT_DIR: cwd };

function hooksFor(eventName, toolName) {
  const path = join(cwd, ".claude", "settings.json");
  if (!existsSync(path)) return [];
  let settings;
  try { settings = JSON.parse(readFileSync(path, "utf8")); } catch { return []; }
  const commands = [];
  for (const group of settings.hooks?.[eventName] ?? []) {
    if (group.matcher && !new RegExp(`^(?:${group.matcher})$`).test(toolName ?? "")) continue;
    for (const hook of group.hooks ?? []) if (hook.type === "command" && hook.command) commands.push(hook.command);
  }
  return commands;
}

function runHooks(payload) {
  const outputs = [];
  for (const command of hooksFor(payload.hook_event_name, payload.tool_name)) {
    const result = spawnSync(bash[0], [...bash[1], command], { input: JSON.stringify({ session_id: sessionId, cwd, transcript_path: "", ...payload }), cwd, env, encoding: "utf8", timeout: 120_000 });
    outputs.push({ command, status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
  }
  return outputs;
}

const events = [{ type: "system", subtype: "init" }];
let messages = 0;
function toolStep(name, input, payloadExtra = {}) {
  messages += 1;
  const id = `t${messages}`;
  events.push({ type: "assistant", timestamp: new Date().toISOString(), message: { id: `m${messages}`, content: [{ type: "tool_use", id, name, input }], usage } });
  events.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  return runHooks({ hook_event_name: "PostToolUse", tool_name: name, tool_input: input, tool_response: {}, ...payloadExtra });
}

function git(args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

// 1. The prompt.
runHooks({ hook_event_name: "UserPromptSubmit", prompt });
if (process.argv.includes("--max-turns") && prompt === "Reply with OK.") {
  runHooks({ hook_event_name: "Stop", stop_hook_active: false });
  events.push({ type: "assistant", message: { id: "warmup", model: "fake", content: [{type:"text",text:"OK"}], usage } });
  events.push({ type: "result", result: "OK", num_turns: 1, usage, total_cost_usd: 0 });
  process.stdout.write(`${events.map(JSON.stringify).join("\n")}\n`);
  process.exit(0);
}

// 2. Read and search a file the knowledge links to (else the README).
let target = "README.md";
try {
  const index = JSON.parse(readFileSync(join(cwd, ".mex", "local", "context-index.json"), "utf8"));
  const linked = index.entities.find((entity) => entity.type === "fact" && entity.code?.length);
  if (linked && existsSync(join(cwd, linked.code[0]))) target = linked.code[0];
} catch { /* no index: the files arm, or a checkout without one */ }
toolStep("Read", { file_path: resolve(cwd, target) });
toolStep("Grep", { pattern: "x", path: cwd }, { tool_response: { filenames: [resolve(cwd, target)] } });

// 3. Change tasks: apply the upstream fix, reporting each file as an Edit.
let changed = [];
if (change) {
  const fixes = process.env.FAKE_AGENT_FIXES ? JSON.parse(readFileSync(process.env.FAKE_AGENT_FIXES, "utf8")) : {};
  const fix = fixes[prompt.slice(0, 60)];
  if (fix) {
    const diff = git(["diff", fix.base, fix.fix, "--", ".", ...(fix.exclude ?? []).map((path) => `:(exclude)${path}`)]);
    if (diff.stdout.trim()) {
      const apply = spawnSync("git", ["apply", "--whitespace=nowarn", "-"], { cwd, input: diff.stdout, encoding: "utf8" });
      if (apply.status === 0) changed = git(["diff", "--name-only"]).stdout.split("\n").filter(Boolean);
      else process.stderr.write(`fake agent: patch did not apply: ${apply.stderr}\n`);
    }
    for (const file of changed) toolStep("Edit", { file_path: resolve(cwd, file), old_string: "a", new_string: "b" });
  }
}

// 3b. FAKE_AGENT_TOUCH_FACT=1: change code a recorded fact is linked to, so the Stop hook has something to review.
// With FAKE_AGENT_CONFIRM=1 the agent then vouches for the listed entities, as a real agent answering the block would.
// FAKE_AGENT_CRLF=1 writes the edited file back with CRLF line ends, as a Python script in text mode does on
// Windows. FAKE_AGENT_IGNORE_BLOCK=1 ends the session at a Stop block, as a headless host does when the agent's
// last act was its structured answer.
let touched = null;
if (process.env.FAKE_AGENT_TOUCH_FACT === "1") {
  try {
    const index = JSON.parse(readFileSync(join(cwd, ".mex", "local", "context-index.json"), "utf8"));
    const entity = index.entities.find((candidate) => candidate.type === "fact" && candidate.symbols?.some((symbol) => symbol.end - symbol.start >= 4));
    const symbol = entity?.symbols.find((candidate) => candidate.end - candidate.start >= 4);
    if (entity && symbol) {
      const file = join(cwd, symbol.file);
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      const comment = /\.py$/.test(file) ? "#" : "//";
      lines.splice(symbol.start, 0, `${lines[symbol.start].match(/^\s*/)[0]}${comment} fake agent edit inside a linked symbol`);
      writeFileSync(file, lines.join(process.env.FAKE_AGENT_CRLF === "1" ? "\r\n" : "\n"));
      touched = { id: entity.id, file: symbol.file };
      toolStep("Edit", { file_path: file, old_string: "a", new_string: "b" });
    }
  } catch (error) { process.stderr.write(`fake agent: could not touch a fact: ${error.message}\n`); }
}

// 4. Stop.
const stop = runHooks({ hook_event_name: "Stop", stop_hook_active: false });
const blocked = stop.find((entry) => /"decision"\s*:\s*"block"/.test(entry.stdout));
if (blocked && process.env.FAKE_AGENT_IGNORE_BLOCK !== "1") {
  if (process.env.FAKE_AGENT_CONFIRM === "1") {
    let reason = "";
    try { reason = JSON.parse(blocked.stdout).reason ?? ""; } catch { /* unreadable block */ }
    const confirm = reason.match(/`(mex context confirm [^`]+)`/)?.[1];
    if (confirm) {
      messages += 1;
      const command = confirm;
      events.push({ type: "assistant", message: { id: `m${messages}`, content: [{ type: "tool_use", id: `t${messages}`, name: "Bash", input: { command } }], usage } });
      events.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${messages}`, content: spawnSync(bash[0], [...bash[1], command], { cwd, env, encoding: "utf8" }).stdout || "ok" }] } });
    }
  }
  runHooks({ hook_event_name: "Stop", stop_hook_active: true });
}

const total = (key) => usage[key] * Math.max(messages, 1);
const structured = change
  ? { summary: `Fake agent run; applied the recorded fix to ${changed.length} file(s).`, filesChanged: changed, testsRun: "none" }
  : { answer: "The fake agent answers after reading one linked file.", symbols: ["fetch"], evidence: [{ path: target, line: 1 }], complete: false };
events.push({ type: "result", structured_output: structured, num_turns: Math.max(messages, 1), usage: { input_tokens: total("input_tokens"), cache_creation_input_tokens: 0, cache_read_input_tokens: total("cache_read_input_tokens"), output_tokens: total("output_tokens") }, total_cost_usd: 0 });
process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
