import { isAbsolute, join } from "node:path";
import { statSync } from "node:fs";
import { withContainedArtifactLock } from "../team/artifacts/filesystem.js";
import { equalSnapshot, MAX_SETTINGS_BYTES, readSnapshot, replaceFile, samePath, snapshotBytes, type Snapshot } from "./files.js";
import { object, undoSettings } from "./settings.js";

export interface RecoveryRow { path: string; old_value: string; new_value: string; }

export function decodeSnapshot(value: string): Snapshot {
  const result: unknown = JSON.parse(value);
  if (!object(result) || (result.data !== null && typeof result.data !== "string") || !Number.isInteger(result.mode)
    || Number(result.mode) < 0 || Number(result.mode) > 0o777) throw new Error("Invalid installation snapshot.");
  return result as unknown as Snapshot;
}

/** No database, Git, repository commands or package imports on this path. */
export function restoreSettings(row: RecoveryRow): void {
  if (!isAbsolute(row.path)) throw new Error("Invalid installation path.");
  const before = decodeSnapshot(row.old_value);
  const after = decodeSnapshot(row.new_value);
  if ((before.data?.length ?? 0) > MAX_SETTINGS_BYTES * 1.4 || (after.data?.length ?? 0) > MAX_SETTINGS_BYTES * 1.4) throw new Error("Settings snapshot exceeds its bound.");
  const current = readSnapshot(row.path, MAX_SETTINGS_BYTES);
  if (equalSnapshot(current, before)) return;
  let desired = before;
  if (!equalSnapshot(current, after)) {
    if (current.data === null || after.data === null) throw new Error("Changed settings were kept.");
    desired = { data: undoSettings(snapshotBytes(current)!, snapshotBytes(before), snapshotBytes(after)!).toString("base64"), mode: current.mode };
  }
  replaceFile(row.path, current, desired);
}

/** Only a valid launcher naming a definitely absent CLI authorizes cleanup. */
export function cliMissing(home: string): boolean {
  try {
    const bytes = snapshotBytes(readSnapshot(join(home, "bin", "launcher.json"), 4096));
    if (bytes === null) return false;
    const launcher = JSON.parse(bytes.toString("utf8"));
    if (!object(launcher) || launcher.version !== 1 || typeof launcher.entry !== "string" || !isAbsolute(launcher.entry)) return false;
    try { statSync(launcher.entry); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  } catch { return false; }
}

/** Cooperate with install/uninstall and recheck authority after obtaining their lock. */
export async function applyOrphanRecovery(home: string): Promise<boolean> {
  try {
    return await withContainedArtifactLock(home, "install", ".install.lock", () => {
    if (!cliMissing(home)) return false;
    const path = join(home, "install-recovery.json");
    const bytes = snapshotBytes(readSnapshot(path, 8 << 20));
    if (bytes === null) return false;
    const recovery = JSON.parse(bytes.toString("utf8"));
    if (!object(recovery) || recovery.version !== 1 || typeof recovery.home !== "string" || !samePath(recovery.home, home) || !Array.isArray(recovery.rows) || recovery.rows.length > 512) return false;
    for (const row of recovery.rows) {
      if (!object(row) || !["claude-code", "codex", "copilot"].includes(String(row.agent)) || typeof row.path !== "string"
        || typeof row.old_value !== "string" || typeof row.new_value !== "string") return false;
    }
    const blocked = new Set<string>();
    for (const row of recovery.rows) {
      if (blocked.has(row.path)) continue;
      try { restoreSettings(row as unknown as RecoveryRow); } catch { blocked.add(row.path); }
    }
    return blocked.size === 0;
    });
  } catch { return false; }
}
