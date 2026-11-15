/**
 * Which agents are on this machine and whether MEX reaches them, for
 * `mex doctor`. Read-only: it never installs, repairs or removes anything.
 * Agents installed after `mex install` show as "found · add MEX".
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mexHomeDir } from "../global-config.js";
import { binaryFileName, selfTestBinary, type SelfTestResult } from "../hooks/shim/binary.js";
import { AGENT_NAMES, opencodePluginPath, testCommand } from "./index.js";
import { OPENCODE_PLUGIN_MARKER } from "./opencode-plugin.js";
import { agentSettings, AGENT_COMMANDS, FAILURE_BLOCKS, type Agent } from "./settings.js";

export type KnownAgent = Agent | "opencode" | "devin" | "kiro";
export interface AgentStatus {
  agent: KnownAgent;
  name: string;
  found: boolean;
  /** MEX's hook or plugin is registered for it. */
  reached: boolean;
  /** One line for the person. */
  detail: string;
  ok: boolean;
}
export interface AgentStatusOptions {
  userHome?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  onPath?: (program: string) => boolean;
  /** Re-runs the registered command for agents where a failing hook blocks them. */
  commandTest?: (agent: Agent) => SelfTestResult;
}

const PROGRAMS: Record<KnownAgent, string> = { ...AGENT_COMMANDS, opencode: "opencode", devin: "devin", kiro: "kiro-cli" };
const NAMES: Record<KnownAgent, string> = { ...AGENT_NAMES, devin: "Devin", kiro: "Kiro CLI" };

function read(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function onPathDefault(platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  return (program: string) => spawnSync(platform === "win32" ? "where.exe" : "which", [program], { env, timeout: 1500, windowsHide: true, stdio: "ignore" }).status === 0;
}

/** Re-tests the command in Copilot's hook file: the native binary's self-test, or node starting the fallback. */
function registeredCommandTest(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, settingsText: string): SelfTestResult {
  const native = join(home, "bin", binaryFileName(platform));
  if (settingsText.includes(binaryFileName(platform)) && existsSync(native)) return selfTestBinary(native);
  const fallback = join(home, "bin", "mex-hook.cjs");
  if (!existsSync(fallback)) return { ok: false, error: `missing ${fallback}` };
  return testCommand({ path: "node", args: [fallback] }, env);
}

export function agentStatuses(options: AgentStatusOptions = {}): AgentStatus[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const user = options.userHome ?? homedir();
  const home = options.home ?? mexHomeDir();
  const onPath = options.onPath ?? onPathDefault(platform, env);
  let settings: Record<Agent, string>;
  try { settings = agentSettings(user, env); } catch { settings = agentSettings(user, {}); }
  const out: AgentStatus[] = [];
  for (const agent of Object.keys(PROGRAMS) as KnownAgent[]) {
    const found = onPath(PROGRAMS[agent]);
    const name = NAMES[agent];
    let reached = false;
    let detail: string;
    let ok = true;
    if (agent === "devin") {
      // Devin runs the hooks in ~/.claude, in Claude Code's format.
      reached = read(settings["claude-code"]).includes("mex-hook");
      detail = reached ? "through Claude Code's hooks in ~/.claude, which Devin also runs" : "found · add MEX: `mex install` (Devin uses Claude Code's hooks)";
    } else if (agent === "kiro") {
      detail = "rule files only: Kiro CLI hooks belong to a custom agent, and MEX doesn't create one";
    } else if (agent === "opencode") {
      let path: string;
      try { path = opencodePluginPath(user, env); } catch { path = opencodePluginPath(user, {}); }
      reached = read(path).startsWith(OPENCODE_PLUGIN_MARKER);
      detail = reached ? `plugin ${path}` : "found · add MEX: `mex install`";
    } else {
      const text = read(settings[agent]);
      reached = text.includes("mex-hook");
      detail = reached ? `hooks in ${settings[agent]}` : "found · add MEX: `mex install`";
      if (reached && FAILURE_BLOCKS.has(agent)) {
        const test = options.commandTest?.(agent) ?? registeredCommandTest(home, env, platform, text);
        if (test.ok) detail += "; hook self-test passed";
        else {
          ok = false;
          detail = `hook self-test FAILED (${test.error ?? "unknown"}): ${name} denies tool calls while it fails. Run \`mex install\` to switch its hooks off, or fix the runtime and retest.`;
        }
      }
    }
    if (!found && !reached) continue;
    if (found && !reached && agent !== "kiro") ok = false;
    out.push({ agent, name, found, reached, detail, ok });
  }
  return out;
}
