/**
 * Which command a hook entry runs.
 *
 * Preferably the `mex-hook` bin, when it resolves on PATH: it is short, and it
 * follows the installed package. Otherwise `node "<absolute dist/hook.js>"`,
 * which works from a checkout or a package that is not on PATH. Both end in
 * the marker argument that makes an entry MEX's, and neither needs a shell
 * feature, so the same string works in a POSIX shell and on Windows.
 */

import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MEX_HOOK_MARKER } from "./claude-settings.js";

export interface HookCommand {
  kind: "bin" | "node";
  /** The exact string written to settings.json. */
  command: string;
  /** The file it resolves to: the bin found on PATH, or the hook bundle. */
  target: string;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Where `dist/hook.js` may be; defaults to the places relative to this module. */
  entryCandidates?: readonly string[];
}

const BIN = "mex-hook";

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The `mex-hook` shim on PATH, or null. */
export function findBinOnPath(options: ResolveOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const names = platform === "win32" ? [`${BIN}.cmd`, `${BIN}.exe`, `${BIN}.ps1`, BIN] : [BIN];
  const pathValue = env["PATH"] ?? env["Path"] ?? "";
  for (const dir of pathValue.split(platform === "win32" ? ";" : delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** The built hook bundle, found relative to whichever module is running. */
export function findHookEntry(options: ResolveOptions = {}): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = options.entryCandidates ?? [join(here, "hook.js"), resolve(here, "..", "hook.js"), resolve(here, "..", "..", "dist", "hook.js")];
  return candidates.find(isFile) ?? null;
}

const forwardSlashes = (path: string): string => path.replace(/\\/g, "/");

export function resolveHookCommand(options: ResolveOptions = {}): HookCommand | null {
  const bin = findBinOnPath(options);
  if (bin !== null) return { kind: "bin", command: `${BIN} ${MEX_HOOK_MARKER}`, target: bin };
  const entry = findHookEntry(options);
  if (entry === null) return null;
  const absolute = resolve(entry);
  // Forward slashes survive both a POSIX shell and Windows' own argument parsing.
  return { kind: "node", command: `node "${forwardSlashes(absolute)}" ${MEX_HOOK_MARKER}`, target: absolute };
}

/** What an installed command string runs, for `status`. */
export function describeInstalledCommand(command: string): { kind: "bin" | "node" | "unknown"; target: string | null; exists: boolean | null } {
  if (new RegExp(`^${BIN}(\\s|$)`).test(command)) {
    const bin = findBinOnPath();
    return { kind: "bin", target: bin, exists: bin !== null };
  }
  const node = /^node\s+"([^"]+)"/.exec(command);
  if (node) return { kind: "node", target: node[1]!, exists: existsSync(node[1]!) };
  return { kind: "unknown", target: null, exists: null };
}
