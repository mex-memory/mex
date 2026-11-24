import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { filesUnder } from "../../../scripts/delivery-replay/cost.mjs";
import { parseEventStream } from "../../adapters/agents/shared.mjs";
import { codexConfig, windowsSandbox } from "./codex.mjs";
import { checkedRun } from "./arms.mjs";
import { records, sessionUsage } from "./usage.mjs";

export const adapters = {
  claude: {
    label: "Claude Code",
    hookAgent: "claude-code",
    executable: "claude",
    configure() {},
    invocation({ pin, session }) {
      return ["-p", "--output-format", "stream-json", "--verbose", "--model", pin.model,
        "--effort", pin.effort, "--permission-mode", "dontAsk",
        "--allowedTools", "Read,Grep,Glob,Edit,Write,Bash",
        ...(session ? ["--resume", session] : ["--session-id", randomUUID()])];
    },
    session(events) {
      return events.find(event => event.type === "system" && event.subtype === "init")?.session_id;
    },
    terminal(events) {
      const end = events.findLast(event => event.type === "result");
      return end && end.is_error !== true && end.subtype === "success";
    },
    transcript(profile, id) {
      return nativeFile(join(profile.env.CLAUDE_CONFIG_DIR, "projects"), name => name === id + ".jsonl");
    },
  },
  codex: {
    label: "Codex",
    hookAgent: "codex",
    executable: "codex",
    configure(profile, pin) {
      const config = codexConfig({ model: pin.model, effort: pin.effort, windowsSandboxMode: windowsSandbox() });
      writeFileSync(join(profile.env.CODEX_HOME, "config.toml"), config, { mode: 0o600 });
    },
    invocation({ profile, session }) {
      // The fresh home only has this harness's installed hook file. A project
      // hook file is refused before opting in to Codex's unattended trust mode.
      if (existsSync(join(profile.workspace, ".codex", "hooks.json"))) {
        throw new Error("A Codex project hook file prevents isolated hook trust");
      }
      if (profile.arm === "mex" && !readFileSync(profile.hooks.settings).equals(profile.hooks.bytes)) {
        throw new Error("Codex hook settings changed after preflight");
      }
      const trust = profile.arm === "mex" ? ["--dangerously-bypass-hook-trust"] : [];
      return ["exec", "--json", "--color", "never",
        ...trust, ...(session ? ["resume", session] : []), "-"];
    },
    session(events) {
      return events.find(event => event.type === "thread.started")?.thread_id;
    },
    terminal(events) {
      return events.some(event => event.type === "turn.completed") && !events.some(event => event.type === "turn.failed");
    },
    transcript(profile, id) {
      return nativeFile(join(profile.env.CODEX_HOME, "sessions"), name => name.endsWith("-" + id + ".jsonl"));
    },
  },
  copilot: { label: "Copilot CLI", headless: ["copilot", "-p"] },
  opencode: { label: "OpenCode", headless: ["opencode", "run"] },
  devin: { label: "Devin" },
  kiro: { label: "Kiro", headless: ["kiro-cli", "chat", "--no-interactive"] },
  cursor: { label: "Cursor", headless: ["agent", "-p"] },
  antigravity: { label: "Antigravity", headless: ["agy", "-p"] },
  gemini: { label: "Gemini CLI", headless: ["gemini", "-p"] },
};

export function requireAdapter(id) {
  const adapter = Object.hasOwn(adapters, id) ? adapters[id] : null;
  if (!adapter?.invocation) throw new Error((adapter?.label ?? id) + ": runner not implemented");
  return adapter;
}

function nativeFile(root, matches) {
  const files = filesUnder(root).filter(file => matches(basename(file)));
  if (files.length !== 1) throw new Error("Expected exactly one native transcript per session");
  return files[0];
}

export async function versionOf(command, profile, pin) {
  const version = await checkedRun(command[0], [...command.slice(1), "--version"], {
    cwd: profile.root, env: profile.env, timeoutMs: 15000,
  }, "Agent version check");
  if (version.stdout.trim() !== pin.version) throw new Error("Agent version does not match the run pin");
  return version.stdout.trim();
}

export async function runTurn({ adapter, command, profile, pin, session, prompt, timeoutMs }) {
  const args = adapter.invocation({ profile, pin, session });
  const result = await checkedRun(command[0], [...command.slice(1), ...args], {
    cwd: profile.workspace, env: profile.env, stdin: prompt + "\n", timeoutMs,
  }, adapter.label + " turn");
  const { events, malformedLines } = parseEventStream(result.stdout, adapter.label);
  if (malformedLines || !adapter.terminal(events)) throw new Error(adapter.label + " did not finish the turn");
  const id = adapter.session(events);
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id) || (session && id !== session)) {
    throw new Error(adapter.label + " did not report the requested session");
  }
  return id;
}

export function readSession(adapter, profile, session, model) {
  const file = adapter.transcript(profile, session);
  return { file, usage: sessionUsage(records(file), adapter.hookAgent, model) };
}
