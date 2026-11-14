import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mexHomeDir } from "../global-config.js";
import { openRecord, openRecordReadOnly, type RecordWriter } from "../record/index.js";
import { recordLocation, type LocationOptions } from "../record/location.js";
import { withContainedArtifactLock } from "../team/artifacts/filesystem.js";
import { binaryFileName, findNativeBinary, selfTestBinary, type SelfTestResult } from "../hooks/shim/binary.js";
import { launcherFile } from "../hooks/shim/launcher.js";
import { assertUntracked, equalSnapshot, installPath, MAX_RUNTIME_BYTES, MAX_SETTINGS_BYTES, readSnapshot, replaceFile, samePath, snapshotBytes, type Snapshot } from "./files.js";
import { agentSettings, CODEX_TRUST_NOTICE, installSettings, isLegacyHandler, parseSettings, removeHandlers, type Agent, type HookCommand } from "./settings.js";
import { decodeSnapshot, restoreSettings } from "./recovery.js";
import { journaledExcludeFiles, restoreExcludeBlocks } from "../repo-start/exclude.js";

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
  selfTest?: (path: string) => SelfTestResult;
  available?: (agent: Agent) => boolean;
  /** Failure injection for crash/recovery tests, after the durable intent. */
  beforeWrite?: (change: InstallChange) => void;
}
export interface InstallResult { agents: Agent[]; changes: InstallChange[]; notices: string[]; legacyTracked: string[]; }

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

function available(agent: Agent, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync(platform === "win32" ? "where.exe" : "which", [agent === "claude-code" ? "claude" : "codex"], {
    env, timeout: 1500, windowsHide: true, stdio: "ignore",
  });
  return result.status === 0;
}

/** Global installation only. Project registration and the first screen belong to setup. */
export async function installAgents(options: InstallOptions = {}): Promise<InstallResult> {
  const env = options.env ?? process.env;
  const user = options.userHome ?? homedir();
  const location = recordLocation({ home: options.home ?? mexHomeDir(), create: false });
  const platform = options.platform ?? process.platform;
  const paths = agentSettings(user, env);
  const agents = (Object.keys(paths) as Agent[]).filter(agent => options.available?.(agent) ?? available(agent, platform, env));
  const result: InstallResult = { agents, changes: [], notices: [], legacyTracked: [] };
  if (!agents.length) return result;
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
      const entry = resolve(options.entry ?? process.argv[1] ?? "");
      if (!entry.endsWith(".js") || !existsSync(entry)) throw new Error("Build MEX before installing hooks; a valid CLI entry is required.");
      const node = options.node ?? process.execPath;
      const binary = options.nativeBinary === undefined ? findNativeBinary() : options.nativeBinary;
      const target = join(bin, binaryFileName(platform));
      const test = options.selfTest ?? selfTestBinary;
      const native = binary && test(binary).ok ? binary : existsSync(target) && test(target).ok ? target : null;
      // Keep a previously selected Node command stable on upgrade. Native npm
      // packages are optional: a missing or blocked binary must not prevent install.
      const rows = writer ? activeRows(writer) : installationChanges(location);
      const previousMode = writer?.setting("global", "install.runner") ?? installationRunner(location);
      const previousNode = rows.length > 0 && previousMode === "node";
      const nativeCommand: HookCommand = { path: target, args: [] };
      const nodeCommand: HookCommand = { path: "node", args: [fallback] };
      const command: HookCommand = native && !previousNode ? nativeCommand : nodeCommand;
      if (writer) writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES('global','install.runner',?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
        .run(command === nodeCommand ? "node" : "native");
      if (!native) result.notices.push("Native hook binary unavailable; using the fail-open Node fallback.");
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
      for (const agent of agents) {
        const before = readSnapshot(paths[agent], MAX_SETTINGS_BYTES);
        put(paths[agent], installSettings(snapshotBytes(before), agent, command, platform, [nativeCommand, nodeCommand]), agent, "settings", undefined, before);
      }
      if (agents.includes("codex")) {
        result.notices.push(CODEX_TRUST_NOTICE);
        if (platform === "win32") result.notices.push("Codex starts every Windows hook through PowerShell (about 0.45 s per call on the measured Windows 11 machine). All supported events are registered.");
      }
      cleanLegacyProjectSettings(options.cwd ?? process.cwd(), result, writer, options);
      return result;
  };
  if (options.dryRun) return planAndApply();
  const writer = openRecord(location);
  try {
    return await withContainedArtifactLock(writer.location.home, "install", ".install.lock", () => planAndApply(writer));
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

/** Exclude files in repositories where `mex` hid `.mex/`; uninstall removes MEX's blocks from them. */
export function excludeChanges(options: LocationOptions = {}): string[] {
  const reader = openRecordReadOnly(options);
  if (!reader) return [];
  try {
    if (reader.diagnostic) throw new Error(reader.diagnostic);
    return journaledExcludeFiles(reader);
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
      // Repository exclude-file blocks don't depend on the hooks; undo them first.
      const excluded = restoreExcludeBlocks(writer);
      result.restored.push(...excluded.restored);
      result.conflicts.push(...excluded.conflicts);
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
