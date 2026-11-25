/**
 * Global (per-machine) config under `~/.mex/`.
 *
 * Owns: `~/.mex/telemetry-id` (installation UUID), `~/.mex/config.json`
 * (global preferences), and the durable `~/.mex/telemetry-disabled` opt-out.
 *
 * Completely separate from the per-scaffold config in `src/config.ts`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync, openSync, closeSync, fstatSync, readSync, renameSync, unlinkSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

// ── Paths ──

const MEX_HOME_DIR_NAME = ".mex";
const TELEMETRY_ID_FILE = "telemetry-id";
const TELEMETRY_DISABLED_FILE = "telemetry-disabled";
const GLOBAL_CONFIG_FILE = "config.json";

/**
 * Absolute path to `~/.mex`.
 *
 * `MEX_HOME` overrides the base directory when set — used by tests to isolate
 * the global config/telemetry-id from the real home, and lets users relocate
 * the dir. We can't rely on `$HOME` for this: Node's `homedir()` ignores `$HOME`
 * on Windows (it reads `USERPROFILE`), so an explicit override is the only
 * cross-platform seam.
 */
export function mexHomeDir(): string {
  const base = process.env.MEX_HOME?.trim() || homedir();
  return join(base, MEX_HOME_DIR_NAME);
}

/** Create `~/.mex/` if it doesn't exist. */
export function ensureMexHomeDir(): void {
  const dir = mexHomeDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe MEX preference directory");
}

/** Installation IDs are generated UUIDs, never caller-supplied names or paths. */
export function isTelemetryId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// ── Machine ID ──

/**
 * Read `~/.mex/telemetry-id` if it already exists, without creating it.
 * Returns `undefined` when the file is absent or empty. Use this for read-only
 * paths (e.g. `telemetry inspect`) that must not plant a tracking id on disk.
 */
export function readMachineId(): string | undefined {
  const filePath = join(mexHomeDir(), TELEMETRY_ID_FILE);
  if (!existsSync(filePath)) return undefined;
  try {
    const parent = lstatSync(mexHomeDir());
    if (!parent.isDirectory() || parent.isSymbolicLink()) return undefined;
    const before = lstatSync(filePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 64n) return undefined;
    const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (before.dev !== opened.dev || before.ino !== opened.ino || opened.size > 64n) return undefined;
      const bytes = Buffer.alloc(64);
      const existing = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString("utf8").trim();
      return isTelemetryId(existing) ? existing : undefined;
    } finally { closeSync(fd); }
  } catch {
    return undefined;
  }
}

/**
 * Read or create `~/.mex/telemetry-id`. Mode `0600` so only the owner can read.
 *
 * **Caller must guarantee telemetry is enabled before calling.** When disabled,
 * telemetry must not create this file while disabled (an existing ID may remain).
 */
export function getMachineId(): string {
  const existing = readMachineId();
  if (existing) return existing;

  ensureMexHomeDir();
  const id = randomUUID();
  // Exclusive creation means two first invocations cannot replace one
  // another's identity. A partial/invalid file is left alone and capture drops.
  try {
    writeFileSync(join(mexHomeDir(), TELEMETRY_ID_FILE), id + "\n", { mode: 0o600, flag: "wx" });
    return id;
  } catch {
    const concurrent = readMachineId();
    if (concurrent) return concurrent;
    throw new Error("Telemetry identity unavailable");
  }
}

// ── Global config ──

interface GlobalConfig {
  telemetry?: "on" | "off";
  firstRunNoticeShown?: boolean;
  feedbackDismissed?: boolean;
  feedbackInviteCount?: number;
  [key: string]: unknown;
}

const MAX_GLOBAL_CONFIG_BYTES = 64 * 1024;

function globalConfigResult(home = mexHomeDir()): { config: GlobalConfig; available: boolean } {
  const filePath = join(home, GLOBAL_CONFIG_FILE);
  try {
    const parent = lstatSync(home);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Unsafe preference directory");
    const before = lstatSync(filePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > MAX_GLOBAL_CONFIG_BYTES) throw new Error("Unsafe preference file");
    const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (before.dev !== opened.dev || before.ino !== opened.ino || opened.size > MAX_GLOBAL_CONFIG_BYTES) throw new Error("Preference file changed");
      const bytes = Buffer.alloc(Number(opened.size) + 1);
      const length = readSync(fd, bytes, 0, bytes.length, 0);
      const after = fstatSync(fd, { bigint: true });
      if (BigInt(length) !== opened.size || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) throw new Error("Preference file changed");
      const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Invalid preference object");
      return { config: raw as GlobalConfig, available: true };
    } finally { closeSync(fd); }
  } catch (error) {
    return { config: {}, available: (error as NodeJS.ErrnoException).code === "ENOENT" };
  }
}

/** Feedback callers retain their tolerant empty-config fallback. */
export function readGlobalConfig(home?: string): GlobalConfig { return globalConfigResult(home).config; }

/** Missing preferences use the documented default; unreadable existing ones fail closed. */
export function readTelemetryPreference(home = mexHomeDir()): "on" | "off" | "unavailable" {
  // Every existing marker fails closed, including a malformed file or link.
  // Unrelated config writers cannot erase this independent opt-out.
  try { lstatSync(join(home, TELEMETRY_DISABLED_FILE)); return "off"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unavailable"; }
  const result = globalConfigResult(home);
  if (!result.available) return "unavailable";
  if (result.config.telemetry === undefined || result.config.telemetry === "on") return "on";
  return result.config.telemetry === "off" ? "off" : "unavailable";
}

interface DisabledMarker { dev: bigint; ino: bigint; }
function inspectDisabledMarker(): DisabledMarker | undefined {
  try {
    const marker = lstatSync(join(mexHomeDir(), TELEMETRY_DISABLED_FILE), { bigint: true });
    if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1n || marker.size !== 0n) throw new Error("Unsafe MEX telemetry opt-out marker");
    return { dev: marker.dev, ino: marker.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function createDisabledMarker(): void {
  try { closeSync(openSync(join(mexHomeDir(), TELEMETRY_DISABLED_FILE), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  // Repeated disable leaves the same marker intact. No caller follows a link.
  if (!inspectDisabledMarker()) throw new Error("MEX telemetry opt-out marker changed");
}

function removeDisabledMarker(expected: DisabledMarker | undefined): void {
  const current = inspectDisabledMarker();
  if (!current) return;
  if (!expected || expected.dev !== current.dev || expected.ino !== current.ino) throw new Error("MEX telemetry opt-out changed while enabling; it remains disabled");
  unlinkSync(join(mexHomeDir(), TELEMETRY_DISABLED_FILE));
}

/**
 * Set a single key in `~/.mex/config.json`, preserving all other keys.
 */
export function setGlobalConfigKey(key: string, value: unknown): void {
  ensureMexHomeDir();
  // Only explicit telemetry preference changes own this marker. Create it first
  // on disable; remove it only after an explicit enable's JSON write succeeds.
  // This survives an unrelated process publishing an older merged config later.
  if (key === "telemetry" && value === "off") createDisabledMarker();
  const enabling = key === "telemetry" && value === "on";
  const disabledMarker = enabling ? inspectDisabledMarker() : undefined;
  const filePath = join(mexHomeDir(), GLOBAL_CONFIG_FILE);
  const existing = readGlobalConfig();
  existing[key] = value;
  const serialized = JSON.stringify(existing, null, 2) + "\n";
  if (Buffer.byteLength(serialized) > MAX_GLOBAL_CONFIG_BYTES) throw new Error("MEX preference file exceeds its limit");
  const parent = lstatSync(mexHomeDir(), { bigint: true });
  const temp = join(mexHomeDir(), `.config-${randomUUID()}.tmp`);
  let owned: { dev: bigint; ino: bigint } | undefined;
  try {
    // Refuse links rather than following an existing config into another file.
    try {
      const target = lstatSync(filePath, { bigint: true });
      if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1n || target.size > MAX_GLOBAL_CONFIG_BYTES) throw new Error("Unsafe MEX preference file");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    writeFileSync(temp, serialized, { flag: "wx", mode: 0o600 });
    owned = lstatSync(temp, { bigint: true });
    const current = lstatSync(mexHomeDir(), { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== parent.dev || current.ino !== parent.ino) throw new Error("MEX preference directory changed");
    // Atomic replacement avoids a partially written opt-out being read as a
    // default-on configuration. Rename replaces a leaf link without following it.
    renameSync(temp, filePath);
    if (enabling) removeDisabledMarker(disabledMarker);
  } finally {
    if (owned) {
      try {
        const current = lstatSync(temp, { bigint: true });
        if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(temp);
      } catch { /* Already renamed or independently removed. */ }
    }
  }
}

// ── Dev-repo guard ──

/**
 * Detect whether we're running from a clone of the mex repo itself.
 * Checks: `MEX_DEV` env var, or `package.json` name matches the mex package.
 *
 * Generalized from `setup/index.ts:127-138` — checks the real package name
 * `mex-agent` plus the legacy name `promexeus`. The bare `mex` name is
 * intentionally excluded (too generic — see the inline note below).
 */
export function isDevRepo(env = process.env): boolean {
  if (env.MEX_DEV) return true;

  try {
    // Walk up from cwd to find the nearest package.json
    let dir = process.cwd();
    while (true) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const content = readFileSync(pkgPath, "utf-8");
        try {
          const pkg = JSON.parse(content) as { name?: string };
          const name = pkg.name;
          // Match the real package name and the legacy "promexeus". The bare
          // "mex" name is intentionally excluded — too generic, and combined
          // with a src/cli.ts it could disable telemetry in a user's project.
          if (name === "mex-agent" || name === "promexeus") {
            // Double-check: must also have src/telemetry or src/cli.ts to be
            // the actual dev repo, not a random package that happens to share
            // a name.
            if (existsSync(join(dir, "src", "cli.ts"))) {
              return true;
            }
          }
        } catch { /* malformed JSON — not a dev repo */ }
        break; // found a package.json, stop walking
      }
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* best-effort */ }

  return false;
}
