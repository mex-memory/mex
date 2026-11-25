import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { mexHomeDir } from "../global-config.js";
import { openRecord, openRecordReadOnly, type RecordWriter } from "../record/index.js";
import { recordLocation, type LocationOptions } from "../record/location.js";
import { withContainedArtifactLock } from "../team/artifacts/filesystem.js";
import { binaryFileName, findNativeBinary, selfTestBinary, type SelfTestResult } from "../hooks/shim/binary.js";
import { cliEntryPath, launcherFile } from "../hooks/shim/launcher.js";
import { assertUntracked, equalSnapshot, installationTracking, installPath, MAX_RUNTIME_BYTES, MAX_SETTINGS_BYTES, readSnapshot, replaceFile, samePath, snapshotBytes, type Snapshot } from "./files.js";
import { agentSettings, agentSettingsPath, AGENT_COMMANDS, CODEX_TRUST_NOTICE, FAILURE_BLOCKS, installSettings, withoutSettings, isLegacyHandler, ownedHookGroups, parseSettings, removeHandlers, undoSettings, type Agent, type HookCommand } from "./settings.js";
import { decodeSnapshot, restoreSettings } from "./recovery.js";
import { opencodePlugin } from "./opencode-plugin.js";
import { journaledExcludeFiles, restoreExcludeBlocks } from "../repo-start/exclude.js";
import { journaledMarkers, restoreFolderMarkers } from "../repo-start/folder.js";
import { compactSettingFiles, undoManagedCompaction } from "../compaction/control.js";

const PREFIX = "file-v1:";
const MAX_CHANGES = 512;
export interface InstallRow { id: number; agent: string; path: string; key: string; old_value: string; new_value: string; ts: string; }
export interface InstallChange { path: string; agent: string; kind: "settings" | "runtime"; before: Snapshot; after: Snapshot; }
export interface InstallOptions {
  home?: string;
  userHome?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
  entry?: string;
  node?: string;
  nativeBinary?: string | null;
  fallbackFile?: string;
  dryRun?: boolean;
  /** Repair one existing agent integration, keeping the installed runtime and other configs untouched. */
  repair?: { agent: Agent | PluginAgent; expected?: RepairRevision; cache?: string; isNetwork?: LocationOptions["isNetwork"] };
  selfTest?: (path: string) => SelfTestResult;
  available?: (agent: Agent | PluginAgent) => boolean;
  /** Runs the exact registered command once, for agents where a failing hook blocks the agent. */
  commandTest?: (command: HookCommand) => SelfTestResult;
  /** Failure injection for crash/recovery tests, after the durable intent. */
  beforeWrite?: (change: InstallChange) => void;
}
/** Agents MEX reaches through a plugin file instead of hook settings. */
export type PluginAgent = "opencode";
export interface InstallResult {
  agents: (Agent | PluginAgent)[]; changes: InstallChange[]; notices: string[]; legacyTracked: string[];
  /** The hook command now in agent settings: the native hook, or the Node fallback that only fails open and delivers nothing. */
  runner?: "native" | "node";
  repair?: RepairRevision;
}

export function activeRows(writer: RecordWriter): InstallRow[] {
  const rows = writer.db.prepare("SELECT * FROM installs WHERE key LIKE 'file-v1:%' ORDER BY id DESC LIMIT ?").all(MAX_CHANGES + 1) as unknown as InstallRow[];
  if (rows.length > MAX_CHANGES) throw new Error("Too many installation changes; review the install record before continuing.");
  return rows;
}

export function recoveryFile(home: string): string { return join(home, "install-recovery.json"); }

function writeRecovery(writer: RecordWriter): void {
  // The shim's surviving Node fallback can undo settings if npm has removed
  // the CLI. It never opens or writes either database.
  const rows = activeRows(writer).filter(row => row.key === `${PREFIX}settings` && row.agent !== "legacy");
  const data = Buffer.from(`${JSON.stringify({ version: 1, home: writer.location.home, rows })}\n`);
  if (data.length > 8 << 20) throw new Error("Installation recovery data exceeds its bound.");
  const path = recoveryFile(writer.location.home);
  assertUntracked(path);
  const before = readSnapshot(path);
  replaceFile(path, before, { data: data.toString("base64"), mode: 0o600 });
}

function recordChange(writer: RecordWriter, change: InstallChange, options: InstallOptions): void {
  if (equalSnapshot(change.before, change.after)) return;
  if (activeRows(writer).length >= MAX_CHANGES) throw new Error("Installation history is full; uninstall before reinstalling.");
  const intent = writer.db.prepare("INSERT INTO installs(agent,path,key,old_value,new_value,ts) VALUES(?,?,?,?,?,?)")
    .run(change.agent, change.path, `${PREFIX}${change.kind}`, JSON.stringify(change.before), JSON.stringify(change.after), new Date().toISOString());
  // Commit the record and its recovery mirror before touching settings.
  writeRecovery(writer);
  options.beforeWrite?.(change);
  try {
    replaceFile(change.path, change.before, change.after);
  } catch (error) {
    // A checked replacement that failed did not apply this delta. Retain its
    // audit bytes, but don't let a later undo treat a concurrent user edit as
    // an installation we actually published.
    writer.db.prepare("UPDATE installs SET key=? WHERE id=?").run(`cancelled:${PREFIX}${change.kind}`, intent.lastInsertRowid);
    try { writeRecovery(writer); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

/** OpenCode loads every file in its global plugin folder. */
export function opencodePluginPath(user: string, env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg && !isAbsolute(xdg)) throw new Error("XDG_CONFIG_HOME must name an absolute directory.");
  return join(xdg || join(user, ".config"), "opencode", "plugin", "mex.js");
}

/**
 * Whether the agent's command is on PATH. Read from the PATH directories
 * directly: a `where.exe` child under a 1.5 s timeout missed Claude Code on
 * a busy Windows machine, so its hooks were silently not installed.
 */
export function executablesOnPath(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, limit: number): string[] {
  const found: string[] = [];
  const key = Object.keys(env).find(k => k.toUpperCase() === "PATH");
  const dirs = (key ? env[key] ?? "" : "").split(platform === "win32" ? ";" : ":").map(d => d.trim().replace(/^"(.*)"$/u, "$1")).filter(Boolean);
  const extKey = Object.keys(env).find(k => k.toUpperCase() === "PATHEXT");
  const exts = platform === "win32" ? ["", ...((extKey ? env[extKey] : undefined) ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        const path = join(dir, name + ext);
        const stat = statSync(path);
        if (stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0)) {
          found.push(path);
          if (found.length >= limit) return found;
        }
      } catch { /* not in this folder */ }
    }
  }
  return found;
}

/** Agents with desktop apps and editor extensions that run the same hooks without a command on PATH. */
const APP_AGENTS: ReadonlySet<Agent> = new Set(["claude-code", "codex"]);

/** Whether the agent's user settings folder (~/.claude, ~/.codex or its override) exists. */
function configured(settingsFile: string): boolean {
  try { return statSync(dirname(settingsFile)).isDirectory(); } catch { return false; }
}

export function agentConfigPath(agent: Agent | PluginAgent, user: string, env: NodeJS.ProcessEnv): string {
  return agent === "opencode" ? opencodePluginPath(user, env) : agentSettingsPath(agent, user, env);
}

export function agentDetected(agent: Agent | PluginAgent, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, settingsFile?: string): boolean {
  const name = agent === "opencode" ? "opencode" : AGENT_COMMANDS[agent];
  return executablesOnPath(name, platform, env, 1).length > 0
    || (agent !== "opencode" && APP_AGENTS.has(agent) && settingsFile !== undefined && configured(settingsFile));
}

/** npx runs a package from npm's temporary cache; hooks pointing there break when npm clears it. */
export function fromNpxCache(entry: string | undefined): boolean {
  return !!entry && /[\\/]_npx[\\/]/u.test(entry);
}

export const AGENT_NAMES: Record<Agent | PluginAgent, string> = { "claude-code": "Claude Code", codex: "Codex", copilot: "Copilot CLI", opencode: "OpenCode" };

/**
 * Runs the registered command the way the agent will, from PATH, with an empty
 * payload, and requires the empty reply. A Node fallback that isn't written yet
 * is tested from a temporary copy of its bytes.
 */
export function testCommand(command: HookCommand, env: NodeJS.ProcessEnv, fallbackBytes?: Buffer): SelfTestResult {
  let args = command.args;
  let temporary: string | undefined;
  try {
    if (fallbackBytes && args[0] && !existsSync(args[0])) {
      temporary = mkdtempSync(join(tmpdir(), "mex-hook-test-"));
      const copy = join(temporary, "mex-hook.cjs");
      writeFileSync(copy, fallbackBytes);
      args = [copy, ...args.slice(1)];
    }
    const run = spawnSync(command.path, [...args, "copilot", "preToolUse"], {
      input: "{}", encoding: "utf8", timeout: 5000, windowsHide: true, shell: false,
      env: { ...env, MEX_OFF: "1" },
    });
    if (run.error) return { ok: false, error: run.error.message };
    if (run.status !== 0) return { ok: false, error: `exit code ${run.status ?? run.signal}` };
    try { return JSON.stringify(JSON.parse(run.stdout)) === "{}" ? { ok: true } : { ok: false, error: "reply was not {}" }; }
    catch { return { ok: false, error: "reply is not JSON" }; }
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

/** Global installation only. Project registration and the first screen belong to setup. */
export async function installAgents(options: InstallOptions = {}): Promise<InstallResult> {
  if (options.repair) return repairAgent(options, options.repair);
  if (!options.entry && fromNpxCache(cliEntryPath())) {
    throw new Error("MEX is running through npx, from npm's temporary cache; hooks installed from there stop working when npm clears it. Install MEX once with `npm i -g mex-agent@next`, then run `mex install`.");
  }
  const env = options.env ?? process.env;
  const user = options.userHome ?? homedir();
  const location = recordLocation({ home: options.home ?? mexHomeDir(), create: false });
  const platform = options.platform ?? process.platform;
  const paths = agentSettings(user, env);
  // The desktop apps and editor extensions run the same hooks from the same
  // user settings without putting a command on PATH; their settings folder
  // is the sign they are in use.
  const agents = (Object.keys(paths) as Agent[]).filter(agent => options.available?.(agent) ?? agentDetected(agent, platform, env, paths[agent]));
  const opencode = options.available?.("opencode") ?? agentDetected("opencode", platform, env);
  const pluginPath = opencode ? installPath(opencodePluginPath(user, env)) : null;
  const result: InstallResult = { agents: [...agents, ...(opencode ? ["opencode" as const] : [])], changes: [], notices: [], legacyTracked: [] };
  if (!result.agents.length) return result;
  // Validate every destination before changing any of them.
  for (const agent of agents) {
    const path = installPath(paths[agent]);
    assertUntracked(path);
    parseSettings(snapshotBytes(readSnapshot(path, MAX_SETTINGS_BYTES)));
    paths[agent] = path;
  }
  const planAndApply = (writer?: RecordWriter): InstallResult => {
      const mexHome = dirname(installPath(join(writer?.location.home ?? location.home, "placeholder")));
      const bin = join(mexHome, "bin");
      const fallback = join(bin, "mex-hook.cjs");
      const source = options.fallbackFile ?? fileURLToPath(new URL("./hook-fallback.cjs", import.meta.url));
      const fallbackBytes = readFileSync(source);
      // A global npm install runs MEX through a `bin/mex` symlink: use the real file.
      const entry = resolve(options.entry ?? cliEntryPath() ?? "");
      if (!entry.endsWith(".js") || !existsSync(entry)) throw new Error("Build MEX before installing hooks; a valid CLI entry is required.");
      const node = options.node ?? process.execPath;
      const binary = options.nativeBinary === undefined ? findNativeBinary() : options.nativeBinary;
      const target = join(bin, binaryFileName(platform));
      const test = options.selfTest ?? selfTestBinary;
      const native = binary && test(binary).ok ? binary : existsSync(target) && test(target).ok ? target : null;
      // Native npm packages are optional: a missing or blocked binary must not prevent install.
      // The Node fallback only fails open; it delivers nothing. So the native command
      // replaces it as soon as a binary passes its self-test, instead of staying stuck on it.
      const previousMode = writer?.setting("global", "install.runner") ?? installationRunner(location);
      const nativeCommand: HookCommand = { path: target, args: [] };
      const nodeCommand: HookCommand = { path: "node", args: [fallback] };
      const command: HookCommand = native ? nativeCommand : nodeCommand;
      result.runner = native ? "native" : "node";
      if (native && previousMode === "node") result.notices.push("MEX's native hook is now available; the hooks switched to it from the fail-open Node fallback.");
      if (writer) writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES('global','install.runner',?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
        .run(command === nodeCommand ? "node" : "native");
      if (!native) result.notices.push("MEX's native hook isn't installed, so your agents get no MEX knowledge yet (the hooks only fail open). Reinstall MEX to fix it.");
      const put = (path: string, bytes: Buffer, agent = "mex", kind: InstallChange["kind"] = "runtime", mode?: number, expected?: Snapshot) => {
        path = resolve(path);
        if (bytes.length > (kind === "settings" ? MAX_SETTINGS_BYTES : MAX_RUNTIME_BYTES)) throw new Error(`Installed file would exceed its bound: ${path}`);
        assertUntracked(path);
        const before = expected ?? readSnapshot(path);
        const change: InstallChange = { path, agent, kind, before, after: { data: bytes.toString("base64"), mode: mode ?? (before.data === null ? 0o600 : before.mode) } };
        if (!equalSnapshot(before, change.after)) { if (writer) recordChange(writer, change, options); result.changes.push(change); }
      };
      // Runtime first, hooks last; uninstall reverses the order by kind.
      if (native && command.path === target) put(target, readFileSync(native), "mex", "runtime", 0o700);
      put(fallback, fallbackBytes);
      put(launcherFile(mexHome), Buffer.from(`${JSON.stringify({ version: 1, node, entry })}\n`));
      let commandWorks: SelfTestResult | undefined;
      for (const agent of [...agents]) {
        const before = readSnapshot(paths[agent], MAX_SETTINGS_BYTES);
        if (FAILURE_BLOCKS.has(agent)) {
          // In Copilot a hook that can't start denies every tool call. Register
          // only a command proven to run here; otherwise remove ours.
          // The native binary passed its self-test above; the Node command must
          // also prove that "node" on PATH starts the fallback.
          commandWorks ??= options.commandTest?.(command)
            ?? (command === nativeCommand ? { ok: true } : testCommand(command, env, fallbackBytes));
          if (!commandWorks.ok) {
            const without = withoutSettings(snapshotBytes(before), [nativeCommand, nodeCommand]);
            if (without) put(paths[agent], without, agent, "settings", undefined, before);
            result.agents.splice(result.agents.indexOf(agent), 1);
            result.notices.push(`${AGENT_NAMES[agent]} found, but MEX's hook failed its self-test here (${commandWorks.error ?? "unknown"}); MEX left ${AGENT_NAMES[agent]} hooks off so the agent keeps working. \`mex doctor\` retests.`);
            continue;
          }
        }
        put(paths[agent], installSettings(snapshotBytes(before), agent, command, platform, [nativeCommand, nodeCommand]), agent, "settings", undefined, before);
      }
      // The plugin is a runtime file: uninstall deletes it only while it is unchanged.
      if (pluginPath) put(pluginPath, Buffer.from(opencodePlugin(command)), "opencode", "runtime", 0o644);
      if (agents.includes("codex")) result.notices.push(CODEX_TRUST_NOTICE);
      cleanLegacyProjectSettings(options.cwd ?? process.cwd(), result, writer, options);
      return result;
  };
  if (options.dryRun) return planAndApply();
  const writer = openRecord(location);
  try {
    return await withContainedArtifactLock(writer.location.home, "install", ".install.lock", () => planAndApply(writer));
  } finally { writer.close(); }
}

export interface RepairRevision { path: string; revision: string; planRevision: string }
export class InstallRevisionConflict extends Error {}

export function installHookCommands(home: string, platform: NodeJS.Platform): [HookCommand, HookCommand] {
  return [
    { path: join(home, "bin", binaryFileName(platform)), args: [] },
    { path: "node", args: [join(home, "bin", "mex-hook.cjs")] },
  ];
}

function executableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch { return false; }
}

/** A browser repair may use only an existing native shim with its intact launcher. */
export function existingRepairCommand(home: string, platform: NodeJS.Platform, entry: string | undefined): HookCommand | undefined {
  if (!entry?.endsWith(".js") || fromNpxCache(entry)) return undefined;
  try {
    const launcher = snapshotBytes(readSnapshot(launcherFile(home), 4096));
    const value = JSON.parse(launcher?.toString("utf8") ?? "null") as { version?: unknown; entry?: unknown; node?: unknown } | null;
    const [command] = installHookCommands(home, platform);
    const shim = lstatSync(command.path);
    if (!shim.isFile() || shim.isSymbolicLink() || shim.nlink !== 1 || !samePath(installPath(command.path), command.path)
      || !executableFile(command.path, platform) || !value || value.version !== 1
      || typeof value.entry !== "string" || !isAbsolute(value.entry) || !samePath(value.entry, entry) || !statSync(entry).isFile()
      || typeof value.node !== "string" || !isAbsolute(value.node) || !executableFile(value.node, platform)) return undefined;
    return command;
  } catch { return undefined; }
}

const runFile = promisify(execFile);
async function repairSelfTest(path: string): Promise<boolean> {
  const { stdout } = await runFile(path, ["--self-test"], {
    timeout: 3_000, maxBuffer: 16 << 10, windowsHide: true, env: { ...process.env, MEX_BACKGROUND: "1" },
  });
  return JSON.parse(stdout)?.ok === true;
}

/** A repair of a recorded install must leave that original undo valid. */
function repairCoveredByJournal(writer: RecordWriter | undefined, location: LocationOptions, change: InstallChange, owned: readonly HookCommand[]): boolean {
  const sql = `SELECT CASE WHEN length(old_value)+length(new_value)<=? THEN old_value END old_value,
    CASE WHEN length(old_value)+length(new_value)<=? THEN new_value END new_value
    FROM installs WHERE path=? AND key=? ORDER BY id DESC LIMIT 1`;
  const params = [3 << 20, 3 << 20, change.path, PREFIX + change.kind] as const;
  const reader = writer ? undefined : openRecordReadOnly(location);
  try {
    if (reader?.diagnostic) throw new Error(reader.diagnostic);
    const row = writer ? writer.db.prepare(sql).get(...params) : reader?.get<{ old_value: string; new_value: string }>(sql, ...params);
    if (!row) return false;
    const before = snapshotBytes(decodeSnapshot(String(row.old_value)));
    const after = snapshotBytes(decodeSnapshot(String(row.new_value)));
    const repaired = snapshotBytes(change.after)!;
    if (change.kind === "runtime" && equalSnapshot(decodeSnapshot(String(row.new_value)), change.after)) return true;
    if (change.kind === "settings" && after) {
      const saved = parseSettings(after), planned = parseSettings(repaired);
      const normalize = (settings: ReturnType<typeof parseSettings>) => JSON.parse(JSON.stringify(ownedHookGroups(settings, owned)));
      if (isDeepStrictEqual(normalize(saved), normalize(planned))) {
        // Ensure the original install can still be reversed around user's other settings.
        undoSettings(repaired, before, after);
        return true;
      }
    }
    throw new Error("The original install record needs to be reviewed before changing this file.");
  } finally { reader?.close(); }
}

async function repairAgent(options: InstallOptions, repair: NonNullable<InstallOptions["repair"]>): Promise<InstallResult> {
  const { agent, expected } = repair;
  const platform = options.platform ?? process.platform;
  const location = { home: options.home, cache: repair.cache, isNetwork: repair.isNetwork };
  const { home } = recordLocation({ ...location, create: false });
  const path = installPath(agentConfigPath(agent, options.userHome ?? homedir(), options.env ?? process.env));
  if (!options.dryRun && !expected) throw new Error("Repair requires a reviewed configuration.");
  if (expected && !samePath(path, expected.path)) throw new InstallRevisionConflict("The configuration path changed.");
  const plan = async (writer?: RecordWriter): Promise<InstallResult> => {
    if (await installationTracking(path) === "tracked") throw new Error("This configuration is tracked by Git.");
    const command = existingRepairCommand(home, platform, options.entry);
    if (!command || !(options.selfTest ? options.selfTest(command.path).ok : await repairSelfTest(command.path))) {
      throw new Error("The installed MEX hook or launcher could not be verified.");
    }
    const before = readSnapshot(path, MAX_SETTINGS_BYTES);
    const bytes = snapshotBytes(before);
    const revision = createHash("sha256").update(bytes ?? Buffer.alloc(0)).digest("hex");
    if (expected && revision !== expected.revision) throw new InstallRevisionConflict("The configuration changed.");
    const owned = installHookCommands(home, platform);
    let next: Buffer;
    if (agent === "opencode") {
      if (bytes && !owned.some(candidate => bytes.equals(Buffer.from(opencodePlugin(candidate))))) {
        throw new Error("The existing plugin needs to be reviewed in the terminal.");
      }
      next = Buffer.from(opencodePlugin(command));
    } else {
      if (agent === "copilot" && bytes && parseSettings(bytes).version !== 1) {
        throw new Error("The Copilot hook file needs its format checked.");
      }
      next = installSettings(bytes, agent, command, platform, owned);
    }
    if (next.length > MAX_SETTINGS_BYTES) throw new Error("The repaired configuration would exceed its bound.");
    const after = { data: next.toString("base64"), mode: agent === "opencode" && !bytes ? 0o644 : before.mode };
    const planRevision = createHash("sha256").update(JSON.stringify([path, before, after])).digest("hex");
    if (expected && planRevision !== expected.planRevision) throw new InstallRevisionConflict("The repair plan changed.");
    const changes: InstallChange[] = equalSnapshot(before, after) ? [] : [{
      path, agent, kind: agent === "opencode" ? "runtime" : "settings", before, after,
    }];
    if (changes.length) {
      const covered = repairCoveredByJournal(writer, location, changes[0], owned);
      try {
        if (writer && covered) replaceFile(path, before, after);
        else if (writer) recordChange(writer, changes[0], options);
      }
      catch (error) {
        if (error instanceof Error && /^File changed (?:before|during) installation/u.test(error.message)) {
          throw new InstallRevisionConflict("The configuration changed.");
        }
        throw error;
      }
    }
    return { agents: [agent], changes, notices: [], legacyTracked: [], runner: "native", repair: { path, revision, planRevision } };
  };
  if (options.dryRun) return plan();
  const writer = openRecord({ ...location, busyTimeoutMs: 0 });
  try {
    return await withContainedArtifactLock(home, "install", ".install.lock", () => plan(writer));
  } finally { writer.close(); }
}

function cleanLegacyProjectSettings(cwd: string, result: InstallResult, writer: RecordWriter | undefined, options: InstallOptions): void {
  let root = resolve(cwd);
  while (dirname(root) !== root && !existsSync(join(root, ".git"))) root = dirname(root);
  if (!existsSync(join(root, ".git"))) return;
  for (const relative of [".claude/settings.json", ".claude/settings.local.json", ".codex/hooks.json"]) {
    const path = installPath(join(root, relative));
    const before = readSnapshot(path, MAX_SETTINGS_BYTES);
    if (before.data === null) continue;
    const settings = parseSettings(snapshotBytes(before));
    if (!removeHandlers(settings, isLegacyHandler)) continue;
    try { assertUntracked(path); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("MEX will not edit a tracked file:")) {
        result.legacyTracked.push(path);
        result.notices.push(`Old project hooks remain in tracked ${relative}; review their removal in Git. The shim ignores project registrations.`);
        continue;
      }
      throw error;
    }
    const change: InstallChange = { path, agent: "legacy", kind: "settings", before, after: { data: Buffer.from(`${JSON.stringify(settings, null, 2)}\n`).toString("base64"), mode: before.mode } };
    if (writer) recordChange(writer, change, options); result.changes.push(change);
  }
}

export function installationChanges(options: LocationOptions = {}): InstallRow[] {
  const reader = openRecordReadOnly(options);
  if (!reader) return [];
  try {
    if (reader.diagnostic) throw new Error(reader.diagnostic);
    const rows = reader.all<InstallRow>("SELECT * FROM installs WHERE key LIKE 'file-v1:%' ORDER BY id DESC LIMIT ?", MAX_CHANGES + 1);
    if (rows.length > MAX_CHANGES) throw new Error("Installation history exceeds its bound.");
    return rows;
  } finally { reader.close(); }
}

/** Additional local changes that uninstall restores along with the installed hooks. */
export function additionalUninstallPaths(options: LocationOptions = {}): string[] {
  const reader = openRecordReadOnly(options);
  if (!reader) return [];
  try {
    if (reader.diagnostic) throw new Error(reader.diagnostic);
    return [...compactSettingFiles(reader), ...journaledExcludeFiles(reader), ...journaledMarkers(reader)];
  } finally { reader.close(); }
}

function installationRunner(options: LocationOptions): string | undefined {
  const reader = openRecordReadOnly(options);
  try { return reader?.setting("global", "install.runner"); }
  finally { reader?.close(); }
}

export interface UninstallResult { restored: string[]; conflicts: string[]; purged: boolean; }

export function restoreChange(row: InstallRow): void {
  assertUntracked(row.path);
  if (row.key === `${PREFIX}settings`) { restoreSettings(row); return; }
  const before = decodeSnapshot(row.old_value);
  const after = decodeSnapshot(row.new_value);
  const current = readSnapshot(row.path);
  if (equalSnapshot(current, before)) return; // Interrupted install or already-restored uninstall.
  if (!equalSnapshot(current, after)) {
    throw new Error(`Changed file kept: ${row.path}`);
  }
  replaceFile(row.path, current, before);
}

export async function uninstallAgents(options: LocationOptions & { purge?: boolean } = {}): Promise<UninstallResult> {
  const location = recordLocation({ ...options, create: false });
  const result: UninstallResult = { restored: [], conflicts: [], purged: false };
  if (!existsSync(location.record)) return result;
  const writer = openRecord({ ...options, home: location.home });
  try {
    await withContainedArtifactLock(location.home, "install", ".install.lock", () => {
      writer.db.prepare("UPDATE background SET request='exit' WHERE id=1 AND owner IS NOT NULL").run();
      const compaction = undoManagedCompaction(writer);
      result.restored.push(...compaction.restored);
      result.conflicts.push(...compaction.conflicts);
      // Repository exclude-file blocks don't depend on the hooks; undo them first.
      for (const undone of [restoreExcludeBlocks(writer), restoreFolderMarkers(writer)]) {
        result.restored.push(...undone.restored);
        result.conflicts.push(...undone.conflicts);
      }
      const rows = activeRows(writer);
      const settings = rows.filter(row => row.key === `${PREFIX}settings`);
      const runtime = rows.filter(row => row.key !== `${PREFIX}settings`);
      const blockedPaths = new Set<string>();
      for (const row of settings) {
        if (blockedPaths.has(row.path)) continue;
        try {
          restoreChange(row);
          writer.db.prepare("UPDATE installs SET key=? WHERE id=?").run(`restored:${row.key}`, row.id);
          result.restored.push(row.path);
        } catch { blockedPaths.add(row.path); result.conflicts.push(row.path); }
      }
      if (blockedPaths.size) return; // Keep every runner until hooks are safely removed.
      for (const row of runtime) {
        if (blockedPaths.has(row.path)) continue;
        try {
          restoreChange(row);
          writer.db.prepare("UPDATE installs SET key=? WHERE id=?").run(`restored:${row.key}`, row.id);
          result.restored.push(row.path);
        } catch { blockedPaths.add(row.path); result.conflicts.push(row.path); }
      }
      writeRecovery(writer);
      if (options.purge && !result.conflicts.length) {
        const running = writer.db.prepare("SELECT pid FROM background WHERE owner IS NOT NULL").get();
        if (running?.pid) {
          try { process.kill(Number(running.pid), 0); result.conflicts.push("Background process is stopping; retry --purge after it exits."); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") result.conflicts.push("Cannot confirm the background process has stopped."); }
        }
        const models = writer.db.prepare("SELECT DISTINCT pid FROM model_batches WHERE state IN ('queued','running')").all();
        for (const model of models) {
          try { process.kill(Number(model.pid), 0); result.conflicts.push("Model work is active; retry --purge after it finishes."); break; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") { result.conflicts.push("Cannot confirm model work has stopped."); break; } }
        }
      }
    });
  } finally { writer.close(); }
  if (options.purge && !result.conflicts.length) {
    for (const path of new Set([location.directory, location.home])) assertPurgeSafe(path);
    for (const path of new Set([location.directory, location.home])) rmSync(path, { recursive: true, force: true });
    result.purged = true;
  }
  return result;
}

function assertPurgeSafe(path: string): void {
  if (!samePath(installPath(join(path, "placeholder")), join(path, "placeholder")) || samePath(path, homedir()) || dirname(path) === path) throw new Error("Refusing to purge a redirected or root directory.");
  let count = 0;
  const visit = (entry: string) => {
    if (++count > 100_000) throw new Error("Purge inspection exceeds its bound; data was kept.");
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) throw new Error("Purge found a link or junction; data was kept.");
    if (stat.isDirectory()) for (const name of readdirSync(entry)) visit(join(entry, name));
  };
  if (existsSync(path)) visit(path);
}
