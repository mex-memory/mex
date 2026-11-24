import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { agentSettings } from "../install/settings.js";
import { openHooksReadOnly } from "../record/index.js";
import type { LocationOptions } from "../record/location.js";
import { AGENT_MODELS, type ModelAgent } from "./models.js";

export type AgentId = "claude-code" | "codex" | "gemini" | "cursor" | "antigravity" | "copilot" | "opencode" | "kiro" | "devin";

const modelRunners = {
  "claude-code": "claude", codex: "codex", gemini: "gemini", copilot: "copilot",
} as const satisfies Partial<Record<AgentId, ModelAgent>>;
type RunnableAgentId = keyof typeof modelRunners;

export function modelAgent(id: "claude" | "claude-code" | "codex"): "claude" | "codex";
export function modelAgent(id: RunnableAgentId | "claude"): ModelAgent;
export function modelAgent(id: RunnableAgentId | "claude"): ModelAgent {
  return id === "claude" ? id : modelRunners[id];
}

type Runner = { ok: true; best: string | null; cheap: string | null; usage: "reported" | "estimated"; models: string };

export interface AgentStatus {
  id: AgentId;
  name: string;
  installed: boolean;
  cli: string | null;
  hooks: "supported" | "none";
  runner:
    | Runner
    | { ok: false; reason: string };
  sessions7d: number;
}

const agents: ReadonlyArray<{
  id: AgentId; name: string; commands: readonly string[]; hooks?: true;
  runner: { usage: "reported" | "estimated"; models: string } | { reason: string };
}> = [
  { id: "claude-code", name: "Claude Code", commands: ["claude"], hooks: true,
    runner: { usage: "reported", models: "Opus writes the rules, Haiku checks them" } },
  { id: "codex", name: "Codex", commands: ["codex"], hooks: true,
    runner: { usage: "reported", models: "gpt-6.1-sol writes the rules, gpt-6-luna checks them" } },
  { id: "gemini", name: "Gemini CLI", commands: ["gemini"],
    runner: { usage: "reported", models: "Pro writes the rules, Flash checks them" } },
  { id: "cursor", name: "Cursor", commands: ["agent", "cursor-agent"],
    runner: { reason: "can't be limited to reading yet: its hooks can still run commands" } },
  { id: "antigravity", name: "Antigravity", commands: ["agy"],
    runner: { reason: "its print mode loses output when run in the background (an open Antigravity bug)" } },
  { id: "copilot", name: "Copilot CLI", commands: ["copilot"], hooks: true,
    runner: { usage: "estimated", models: "uses the account's default model" } },
  { id: "opencode", name: "OpenCode", commands: ["opencode"], hooks: true,
    runner: { reason: "can't be limited to reading yet: its plugins can still run" } },
  { id: "kiro", name: "Kiro", commands: ["kiro-cli"],
    runner: { reason: "can't be limited to reading yet: its hooks can still run commands" } },
  { id: "devin", name: "Devin", commands: [], runner: { reason: "MEX can't run Devin from the terminal yet" } },
];

interface DetectionOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  location?: LocationOptions;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name);
  return env[name] ?? (key === undefined ? undefined : env[key]);
}

export function copilotCli(env = process.env): string | null {
  return cliPaths(env, process.platform)(["copilot"]);
}

function isCopilotLauncher(path: string): boolean {
  // VS Code ships a forwarder on PATH even when GitHub Copilot CLI is absent.
  if (/[\\/]bin[\\/]copilot-shim[\\/]/iu.test(path) || /[\\/]bin[\\/]copilot-shim[\\/]/iu.test(realpathSync(path))) return true;
  const handle = openSync(path, "r");
  try {
    const header = Buffer.alloc(512);
    const length = readSync(handle, header, 0, header.length, 0);
    return header.toString("utf8", 0, length).includes("vscode-copilot-launcher");
  } finally { closeSync(handle); }
}

function cliPaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const windows = platform === "win32";
  const directories = (envValue(env, "PATH") ?? "").split(windows ? ";" : ":")
    .map(path => path.trim().replace(/^"(.*)"$/u, "$1")).filter(Boolean);
  const extensions = windows ? ["", ...(envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  return (commands: readonly string[]): string | null => {
    for (const directory of directories) for (const command of commands) for (const extension of extensions) {
      const path = resolve(directory, command + extension);
      try {
        const stat = statSync(path);
        if (stat.isFile() && (windows || (stat.mode & 0o111) !== 0)
          && (command !== "copilot" || !isCopilotLauncher(path))) return path;
      } catch { /* Check the next PATH entry. */ }
    }
    return null;
  };
}

function sessionCounts(location?: LocationOptions): Map<string, number> {
  const hooks = openHooksReadOnly(location);
  try {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    return new Map(hooks?.all<{ agent: string; count: number }>(
      "SELECT agent,count(*) AS count FROM sessions WHERE last_seen_at>=? GROUP BY agent", since,
    ).map(row => [row.agent, row.count]));
  } catch { return new Map(); }
  finally { hooks?.close(); }
}

export const AGENT_NAMES = Object.fromEntries(agents.map(({ id, name }) => [id, name])) as Record<AgentId, string>;

export function agentName(id: AgentId | "claude"): string {
  return AGENT_NAMES[id === "claude" ? "claude-code" : id];
}

export const LEARNING_AGENTS = ["claude-code", "claude", "codex", "gemini", "copilot"] as const;

export function detectAgents(options: DetectionOptions & { userHome?: string; includeSessions?: boolean } = {}): AgentStatus[] {
  const env = options.env ?? process.env;
  const find = cliPaths(env, options.platform ?? process.platform);
  const counts = options.includeSessions === false ? new Map<string, number>() : sessionCounts(options.location);
  const user = options.userHome ?? homedir();
  return agents.map(({ id, name, commands, hooks, runner }) => {
    const cli = find(commands);
    let installed = cli !== null;
    if (!installed && (id === "claude-code" || id === "codex")) {
      // Other agents' invalid settings overrides should not hide PATH results.
      const settingsEnv = id === "claude-code" ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : { CODEX_HOME: env.CODEX_HOME };
      try { installed = statSync(dirname(agentSettings(user, settingsEnv)[id])).isDirectory(); }
      catch { /* The desktop application's settings directory is absent. */ }
    }
    return {
      id, name, cli, installed, hooks: hooks ? "supported" : "none", sessions7d: counts.get(id) ?? 0,
      runner: "reason" in runner ? { ok: false, reason: runner.reason }
        : !cli ? { ok: false, reason: `install the ${name} command-line tool to run deep analysis` }
          : { ok: true, best: AGENT_MODELS[id]?.best ?? null, cheap: AGENT_MODELS[id]?.cheap ?? null, ...runner },
    };
  });
}

export type RunnableAgent = AgentStatus & { id: RunnableAgentId; runner: Runner };

export function runnableAgents(statuses: AgentStatus[]): RunnableAgent[] {
  return statuses.filter((status): status is RunnableAgent =>
    status.installed && status.runner.ok && Object.hasOwn(modelRunners, status.id)).sort((a, b) => b.sessions7d - a.sessions7d);
}
