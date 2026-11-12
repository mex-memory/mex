import { existsSync, mkdirSync, readFileSync, writeFileSync, statfsSync, statSync, lstatSync, renameSync } from "node:fs";
import { join, isAbsolute, parse, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { mexHomeDir } from "../global-config.js";
import { absolutePath, realPath, shortHash } from "./project.js";

export interface LocationOptions {
  home?: string;
  cache?: string;
  isNetwork?: (home: string) => boolean;
  /** Readers never create directories or publish location pointers. */
  create?: boolean;
}
export interface RecordLocation { home: string; directory: string; record: string; hooks: string; }
/** Canonicalize existing ancestors; absent suffixes retain their requested spelling. */
function locationPath(path: string): string {
  let existing = absolutePath(path);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absolutePath(path);
    suffix.unshift(basename(existing)); existing = parent;
  }
  return join(realPath(existing), ...suffix);
}
export function cacheRoot(): string {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "mex");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "mex");
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "mex");
}
/** Called only without a cached location. Failure means local; callers can inject detection. */
export function isNetworkHome(home: string): boolean {
  if (process.platform === "win32") {
    return windowsNetworkHome(home);
  }
  let existing = home;
  while (!existsSync(existing)) {
    const parent = join(existing, "..");
    if (parent === existing) return false;
    existing = parent;
  }
  existing = realPath(existing);
  if (process.platform === "darwin") {
    const mounts = execFileSync("/sbin/mount", [], { encoding: "utf8", timeout: 1000 });
    return darwinNetworkMount(existing, mounts);
  }
  return [0x6969, 0x517b, 0xff534d42, 0xfe534d42].includes(Number(statfsSync(existing).type) >>> 0);
}

export const WINDOWS_NETWORK_QUERY_TIMEOUT_MS = 5000;
/** Native realpath commonly expands a mapped drive to UNC, avoiding PowerShell entirely. */
export function windowsNetworkHome(home: string, probe: {
  realPath: (path: string) => string;
  driveType: (drive: string, timeout: number) => string;
} = {
  realPath,
  driveType: (drive, timeout) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='${drive}'\").DriveType`],
    { encoding: "utf8", timeout, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }),
}): boolean {
  if (home.startsWith("\\\\")) return true;
  let existing = home;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  try { if (probe.realPath(existing).startsWith("\\\\")) return true; } catch { /* Try the drive query. */ }
  return probe.driveType(parse(home).root.slice(0, 2), WINDOWS_NETWORK_QUERY_TIMEOUT_MS).trim() === "4";
}

/** macOS mount output includes the filesystem name; BSD stat's %T does not. */
export function darwinNetworkMount(path: string, mounts: string): boolean {
  let selected = "", type = "";
  for (const line of mounts.split("\n")) {
    const match = /^.+ on (.+) \(([^,)]+)(?:,.*)?\)$/.exec(line);
    if (!match) continue;
    const mount = match[1].replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    if ((path === mount || path.startsWith(mount === "/" ? "/" : `${mount}/`)) && mount.length > selected.length) {
      selected = mount; type = match[2];
    }
  }
  return ["nfs", "smbfs", "cifs", "afpfs", "webdav"].includes(type);
}

export function recordLocation(options: LocationOptions = {}): RecordLocation {
  const home = locationPath(options.home ?? mexHomeDir());
  const cache = locationPath(join(options.cache ?? cacheRoot(), shortHash(home)));
  const pointer = join(home, "location");
  let directory: string | undefined;
  try {
    if (statSync(pointer).size <= 4096) {
      const text = readFileSync(pointer, "utf8").trim();
      if (isAbsolute(text) && !text.includes("\0")) {
        // Only our two deterministic destinations are valid; never follow arbitrary redirects.
        const candidate = locationPath(text);
        if (candidate === home || candidate === cache) directory = candidate;
      }
    }
  } catch { /* Missing/invalid pointer: detect again. */ }
  if (!directory && options.create === false) {
    // No pointer means no writer has run yet, so there's nothing elsewhere to find:
    // readers never pay for network detection.
    directory = home;
  }
  if (!directory) {
    let network = false;
    try { network = (options.isNetwork ?? isNetworkHome)(home); } catch { /* Fail open locally. */ }
    directory = network ? cache : home;
    if (options.create !== false) {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      // Exclusive publication makes concurrent Node/Go first opens agree.
      try { writeFileSync(pointer, `${directory}\n`, { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const published = readFileSync(pointer, "utf8").trim();
        if (published === home || published === cache) directory = published;
      }
    }
  }
  if (options.create !== false) mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { home, directory, record: join(directory, "record.db"), hooks: join(directory, "hooks.db") };
}

function projectDataPath(location: RecordLocation, projectId: string): string {
  if (!/^[gf]-[a-f0-9]{24}$/.test(projectId)) throw new Error("Invalid project id");
  return join(location.home, "projects", projectId);
}
export function projectDataDirectory(location: RecordLocation, projectId: string): string {
  const directory = projectDataPath(location, projectId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/** Rename one contained directory entry; never recursively copy/delete or merge user data. */
export function moveProjectData(location: RecordLocation, oldId: string, newId: string): "absent" | "moved" | "conflict" {
  const source = projectDataPath(location, oldId);
  const target = projectDataPath(location, newId);
  let sourceStat;
  try { sourceStat = lstatSync(source); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw error; }
  const parent = dirname(source);
  if (dirname(target) !== parent || lstatSync(parent).isSymbolicLink() || realPath(parent) !== absolutePath(parent)
    || !sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Unsafe project data move");
  try { lstatSync(target); return "conflict"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  renameSync(source, target);
  return "moved";
}
