import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * How the hook shim starts MEX's Node side: `<MEX home>/bin/launcher.json`
 * names the Node binary and the CLI entry of the last `mex` that ran. The
 * shim uses it at session start to start the background process when work
 * is waiting (`mex __ensure-background`). The installer (foundation-04) will
 * own this file; until then every CLI run keeps it current.
 */
export const LAUNCHER_VERSION = 1;

export function launcherFile(home: string): string { return join(home, "bin", "launcher.json"); }

/**
 * The built CLI file behind `process.argv[1]`. A global npm install on Linux
 * and macOS runs MEX through a `bin/mex` symlink, so the path as typed has no
 * `.js`; the real file does. Unresolvable paths are returned as given.
 */
export function cliEntryPath(entry: string | undefined = process.argv[1]): string | undefined {
  if (!entry) return entry;
  try { return realpathSync(resolve(entry)); } catch { return resolve(entry); }
}

/** Writes the launcher when it changed. Never creates MEX's home and never throws. */
export function writeLauncher(home: string, entry: string | undefined = cliEntryPath(), node: string = process.execPath): boolean {
  try {
    // Only a built CLI can be started by the shim; a source run (tsx, tests) leaves the file alone.
    if (!entry || !entry.endsWith(".js") || !existsSync(home)) return false;
    // Once installed, the install service journals launcher upgrades. Ordinary
    // commands must not invalidate the original bytes recorded for uninstall.
    if (existsSync(join(home, "install-recovery.json"))) return false;
    const file = launcherFile(home);
    const text = `${JSON.stringify({ version: LAUNCHER_VERSION, node, entry: resolve(entry) })}\n`;
    try { if (readFileSync(file, "utf8") === text) return false; } catch { /* not written yet */ }
    mkdirSync(join(home, "bin"), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, file);
    return true;
  } catch { return false; }
}
