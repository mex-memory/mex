import type { MachineAgentSchema, MachineAgentsSnapshotSchema } from "@mex/hub-contracts/machine";
import { lstatSync, opendirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { z } from "zod";
import { agentConfigPath, agentDetected, AGENT_NAMES, executablesOnPath, existingRepairCommand, installHookCommands } from "../../install/index.js";
import { installPath, MAX_SETTINGS_BYTES, readSnapshot, samePath, snapshotBytes } from "../../install/files.js";
import { OPENCODE_PLUGIN_MARKER, opencodePlugin } from "../../install/opencode-plugin.js";
import { EVENTS, object, ownedHookGroups, parseSettings, registeredHookEvents } from "../../install/settings.js";
import { readBoundedTextFile } from "../../knowledge/files.js";
import { openHooksReadOnly, openRecordReadOnly, type RecordReader } from "../../record/index.js";
import { recordLocation, type LocationOptions } from "../../record/location.js";
import { compactSettingFiles } from "../../compaction/control.js";
import { journaledExcludeFiles } from "../../repo-start/exclude.js";
import { filesWithVisibility, nativeFiles, type ManagedFile } from "./machine-files.js";
import { machinePath, machineProjects, machineTime } from "./machine-projects.js";
import { readStore } from "./read.js";

export type MachineAgent = z.infer<typeof MachineAgentSchema>;
export type AgentId = MachineAgent["id"];
type AgentSnapshot = z.infer<typeof MachineAgentsSnapshotSchema>;
export const AGENT_IDS = Object.keys(AGENT_NAMES) as AgentId[];

const OPENCODE_EVENTS = ["session.created", "session.compacted", "session.idle", "tool.execute.before", "tool.execute.after", "experimental.session.compacting"];
const FILES_PARTIAL = "Some files couldn’t be listed within the reading limit.";
const HOOKS_UNREADABLE = "Last fired couldn’t be read from the local hooks store.";

export interface MachineAgentOptions extends LocationOptions {
  env?: NodeJS.ProcessEnv;
  userHome?: string;
  entry?: string;
}

type HookRegistration = MachineAgent["hooks"] & {
  owned: boolean;
  policy?: string;
  nativeReady: boolean;
  terminal?: boolean;
};

function jsonSwitch(file: string, key: string): boolean {
  const text = readBoundedTextFile(file, MAX_SETTINGS_BYTES);
  return text !== undefined && JSON.parse(text)[key] === true;
}

function claudePolicy(settings: ReturnType<typeof parseSettings>): string | undefined {
  if (settings.disableAllHooks === true) return "Claude Code has hooks turned off.";
  const root = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode"
    : process.platform === "win32" ? "C:\\Program Files\\ClaudeCode" : "/etc/claude-code";
  const files = [join(root, "managed-settings.json")];
  const directory = join(root, "managed-settings.d");
  if (lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    const dir = opendirSync(directory);
    try {
      let count = 0;
      for (let file; (file = dir.readSync());) {
        if (++count > 32) throw new Error("Too many managed settings files.");
        if (file.name.endsWith(".json")) files.push(join(directory, file.name));
      }
    } finally { dir.closeSync(); }
  }
  if (files.some(file => jsonSwitch(file, "disableAllHooks") || jsonSwitch(file, "allowManagedHooksOnly"))) {
    return "Claude Code’s managed settings restrict hooks.";
  }
}

function hostPolicy(agent: Exclude<AgentId, "opencode">, path: string, user: string, settings: ReturnType<typeof parseSettings>) {
  if (agent === "claude-code") return claudePolicy(settings);
  if (agent === "codex") {
    const read = (name: string) => parseToml(readBoundedTextFile(join(dirname(path), name), MAX_SETTINGS_BYTES) ?? "");
    const config = read("config.toml");
    if (object(config.features) && (config.features.hooks === false || config.features.codex_hooks === false)) return "Codex has hooks turned off.";
    if (config.allow_managed_hooks_only === true || read("requirements.toml").allow_managed_hooks_only === true) {
      return "Codex allows only managed hooks.";
    }
  } else if (jsonSwitch(join(user, ".copilot", "config.json"), "disableAllHooks")) return "Copilot CLI has hooks turned off.";
}

function inspectConfig(agent: AgentId, home: string, user: string, path: string | undefined): HookRegistration {
  const names = agent === "opencode" ? OPENCODE_EVENTS : EVENTS[agent];
  const commands = installHookCommands(home, process.platform);
  const nativeReady = existingRepairCommand(home, process.platform) !== undefined;
  const unknown: HookRegistration = {
    owned: false, nativeReady, canVerify: false, terminal: true,
    events: names.map(name => ({ name, status: "unverified" })),
  };
  if (!path) return unknown;
  try {
    const bytes = snapshotBytes(readSnapshot(path, MAX_SETTINGS_BYTES));
    if (agent === "opencode") {
      const owned = bytes?.toString("utf8").startsWith(OPENCODE_PLUGIN_MARKER) ?? false;
      const [native, fallback] = commands.map(command => bytes?.equals(Buffer.from(opencodePlugin(command))) ?? false);
      if (bytes && !native && !fallback) return { ...unknown, owned };
      return { owned, nativeReady: nativeReady && !fallback, canVerify: true, events: names.map(name => ({ name, status: bytes ? "installed" : "missing" })) };
    }
    const settings = parseSettings(bytes);
    const [native, fallback] = commands.map(command => registeredHookEvents(settings, agent, command, process.platform));
    let policy: string | undefined;
    try { policy = hostPolicy(agent, path, user, settings); }
    catch { policy = "The agent’s hook policy couldn’t be read. Check your agent’s settings."; }
    return {
      owned: Object.keys(ownedHookGroups(settings, commands)).length > 0, canVerify: true, nativeReady, policy,
      terminal: agent === "copilot" && bytes !== null && settings.version !== 1,
      events: names.map(name => ({ name, status: native.has(name) || fallback.has(name) ? "installed" : "missing" })),
      ...(fallback.size > 0 && native.size < names.length ? { nativeReady: false } : {}),
    };
  } catch { return unknown; }
}

interface AgentInstall { id: number; agent: string; path: string; ts: string }
interface AgentEvidence {
  installs: AgentInstall[];
  lastFiredAt: string | null;
  hooksUnavailable: boolean;
  files: MachineAgent["files"];
  tracked?: boolean | null;
}

function configuredPath(agent: AgentId, user: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const path = installPath(agentConfigPath(agent, user, env));
    if (machinePath(path)) return path;
  } catch { /* An invalid override affects only this agent. */ }
}

export function readAgent(agent: AgentId, options: MachineAgentOptions, evidence: AgentEvidence): MachineAgent {
  const env = options.env ?? process.env, user = options.userHome ?? homedir();
  const { home } = recordLocation({ ...options, create: false });
  const { installs, files, lastFiredAt, hooksUnavailable } = evidence;
  const path = configuredPath(agent, user, env);
  const detected = agentDetected(agent, process.platform, env, path);
  const recorded = path && installs.find(row => row.agent === agent && samePath(row.path, path));
  const hooks = inspectConfig(agent, home, user, path);
  const known = Boolean(recorded || hooks.owned);
  const complete = hooks.canVerify && hooks.events.every(({ status }) => status === "installed");
  const otherCodexHome = agent === "codex" && installs.some(row => row.agent === agent && (!path || !samePath(row.path, path)));
  // The hook store has no config-home key or current host trust record. Treat
  // observed firing after the recorded install as historical evidence only.
  const firedSinceInstall = !!lastFiredAt && !otherCodexHome && !!recorded && Date.parse(lastFiredAt) >= Date.parse(recorded.ts);
  let state: MachineAgent["state"] = detected || known ? "notSetUp" : "notFound";
  let trust: MachineAgent["trust"] = "unknown";
  let repair: MachineAgent["repair"] = "unavailable";
  let statusNote: string | undefined;
  if (known || detected && !hooks.canVerify && path) {
    if (hooks.policy) statusNote = hooks.policy;
    else if (!complete || !hooks.nativeReady) {
      if (evidence.tracked) statusNote = "Git tracks this configuration. Review the hook changes in your dotfiles or repo.";
      else {
        state = "needsRepair";
        const shimReady = Boolean(options.entry && existingRepairCommand(home, process.platform, options.entry));
        // Every event is registered but runs the fallback runner. Switching
        // runners changes more than the recorded hook entries, so it belongs
        // to the installer in the terminal.
        repair = hooks.terminal || complete || !shimReady ? "terminal" : "browser";
        if (complete) {
          statusNote = shimReady ? "These hooks use MEX’s fallback runner, which delivers no knowledge. Run mex install to switch them to the native hook."
            : "The installed MEX hook or launcher couldn’t be verified.";
        }
      }
    } else if (agent === "codex" && !firedSinceInstall && !otherCodexHome && !hooksUnavailable) {
      state = "needsApproval";
      trust = "needsApproval";
      statusNote = "MEX hasn’t observed these hooks fire since installation.";
    } else {
      state = "working";
      if (agent === "codex") {
        trust = firedSinceInstall ? "approved" : "unknown";
        statusNote = firedSinceInstall ? "MEX observed a hook fire after installation." : "Codex trust couldn’t be verified.";
      }
    }
  }
  if (!hooks.canVerify && !path) statusNote ??= "Check the agent’s configuration directory in your terminal.";
  else if (state === "notSetUp" && !known) statusNote ??= "Run mex install from your terminal to set up hooks.";
  return { id: agent, name: AGENT_NAMES[agent], detected, state, trust, lastFiredAt, errors: [], files, repair,
    statusNote: statusNote ?? (hooksUnavailable ? HOOKS_UNREADABLE : undefined), hooks: { canVerify: hooks.canVerify, events: hooks.events } };
}

function installEvidence(reader: RecordReader | undefined) {
  return reader?.all<AgentInstall>(`SELECT id,agent,path,ts FROM installs
    WHERE key IN ('file-v1:settings','file-v1:runtime') AND agent IN ('claude-code','codex','copilot','opencode','legacy')
    AND length(path)<=4096 ORDER BY id DESC LIMIT 513`) ?? [];
}

function lastFired(hooks: RecordReader | undefined, agent: AgentId) {
  return machineTime(hooks?.get<{ at: string }>("SELECT max(last_seen_at) at FROM sessions WHERE agent=?", agent)?.at);
}

export function refreshedAgent(agent: AgentId, options: MachineAgentOptions, files: MachineAgent["files"]): MachineAgent {
  const installs = readStore(openRecordReadOnly, options, installEvidence);
  let at: string | null = null, hooksUnavailable = false;
  try { at = readStore(openHooksReadOnly, options, hooks => lastFired(hooks, agent)); }
  catch { hooksUnavailable = true; }
  return readAgent(agent, options, { installs, lastFiredAt: at, hooksUnavailable, files });
}

function pathWarning(entry: string | undefined, env: NodeJS.ProcessEnv): AgentSnapshot["pathWarning"] {
  if (!entry || !machinePath(entry)) return;
  try {
    if (!lstatSync(entry, { throwIfNoEntry: false })?.isFile()) return;
    const candidates = executablesOnPath("mex", process.platform, env, 16).map(path => resolve(path)).filter(machinePath);
    const paths = [...new Set(candidates.filter(path => process.platform !== "win32" || /\.[a-z0-9]+$/iu.test(basename(path))))].slice(0, 8);
    const first = paths[0];
    if (!first) return;
    const target = realpathSync(first);
    if (samePath(target, entry)) return;
    if (process.platform === "win32" && /\.(?:bat|cmd)$/iu.test(first)) {
      const npmEntry = join(dirname(first), "node_modules", "mex-agent", "dist", "cli.js");
      const script = readBoundedTextFile(target, 16 << 10);
      if (samePath(npmEntry, entry) && script?.includes("mex-agent\\dist\\cli.js") && statSync(npmEntry).isFile()) return;
    }
    return { paths, hubEntry: entry };
  } catch { return undefined; }
}

export async function takeAgentsSnapshot(options: MachineAgentOptions, signal: AbortSignal): Promise<Pick<AgentSnapshot, "agents" | "issue" | "pathWarning">> {
  const { home } = recordLocation({ ...options, create: false });
  const { installs, repos, journal } = readStore(openRecordReadOnly, options, reader => ({
    installs: installEvidence(reader), repos: machineProjects(reader),
    journal: reader ? { compact: compactSettingFiles(reader), excludes: journaledExcludeFiles(reader) } : { compact: [], excludes: [] },
  }));
  const native = await nativeFiles(home, repos.projects, signal, new Set(journal.excludes));
  const files: ManagedFile[] = [...installs.slice(0, 512).flatMap(({ agent, path }): ManagedFile[] => {
    if (!machinePath(path)) return [];
    if (agent === "legacy") return [{ agents: [basename(path) === "hooks.json" ? "codex" : "claude-code"], path, kind: "hookConfig" }];
    return [{ agents: [agent as AgentId], path, kind: "hookConfig" }];
  }), ...native.files];
  for (const path of journal.compact.filter(machinePath)) {
    files.push({ agents: [path.endsWith(".toml") ? "codex" : "claude-code"], path, kind: "agentSettings" });
  }
  const env = options.env ?? process.env, user = options.userHome ?? homedir();
  const configs = new Map(AGENT_IDS.map(agent => [agent, configuredPath(agent, user, env)]));
  const visibility = await filesWithVisibility(files, signal, [...configs.values()].filter(path => path !== undefined));
  let activity: Map<AgentId, string | null> | undefined;
  let issue: string | undefined;
  try { activity = readStore(openHooksReadOnly, options, hooks => new Map(AGENT_IDS.map(agent => [agent, lastFired(hooks, agent)]))); }
  catch (error) { issue = error instanceof Error && error.message.startsWith("hooks.db schema version ") ? error.message : HOOKS_UNREADABLE; }
  const agents = AGENT_IDS.map(agent => readAgent(agent, options, {
    installs, files: visibility.byAgent.get(agent) ?? [], lastFiredAt: activity?.get(agent) ?? null, hooksUnavailable: !activity,
    tracked: visibility.visibility.get(configs.get(agent) ?? "")?.tracked,
  }));
  issue ??= native.partial || repos.partial || visibility.partial || installs.length > 512 ? FILES_PARTIAL : undefined;
  return { agents, issue, pathWarning: pathWarning(options.entry, options.env ?? process.env) };
}
