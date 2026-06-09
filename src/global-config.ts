/**
 * Global (per-machine) config under `~/.mex/`.
 *
 * Owns: `~/.mex/telemetry-id` (machine UUID) and `~/.mex/config.json`
 * (global preferences like telemetry opt-out).
 *
 * Completely separate from the per-scaffold config in `src/config.ts`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

// ── Paths ──

const MEX_HOME_DIR_NAME = ".mex";
const TELEMETRY_ID_FILE = "telemetry-id";
const GLOBAL_CONFIG_FILE = "config.json";

/** Absolute path to `~/.mex`. Respects `$HOME`. */
export function mexHomeDir(): string {
  return join(homedir(), MEX_HOME_DIR_NAME);
}

/** Create `~/.mex/` if it doesn't exist. */
export function ensureMexHomeDir(): void {
  const dir = mexHomeDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
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
    const existing = readFileSync(filePath, "utf-8").trim();
    return existing.length > 0 ? existing : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read or create `~/.mex/telemetry-id`. Mode `0600` so only the owner can read.
 *
 * **Caller must guarantee telemetry is enabled before calling.** When disabled,
 * this file must not exist.
 */
export function getMachineId(): string {
  const existing = readMachineId();
  if (existing) return existing;

  ensureMexHomeDir();
  const id = randomUUID();
  writeFileSync(join(mexHomeDir(), TELEMETRY_ID_FILE), id + "\n", { mode: 0o600 });
  return id;
}

// ── Global config ──

interface GlobalConfig {
  telemetry?: "on" | "off";
  firstRunNoticeShown?: boolean;
  [key: string]: unknown;
}

/**
 * Read `~/.mex/config.json`. Returns `{}` if missing or malformed — tolerant
 * parse matching the style of `loadPersistedConfig` in `src/config.ts`.
 */
export function readGlobalConfig(): GlobalConfig {
  const filePath = join(mexHomeDir(), GLOBAL_CONFIG_FILE);
  if (!existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return raw as GlobalConfig;
  } catch {
    return {};
  }
}

/**
 * Set a single key in `~/.mex/config.json`, preserving all other keys.
 */
export function setGlobalConfigKey(key: string, value: unknown): void {
  ensureMexHomeDir();
  const filePath = join(mexHomeDir(), GLOBAL_CONFIG_FILE);
  const existing = readGlobalConfig();
  existing[key] = value;
  writeFileSync(filePath, JSON.stringify(existing, null, 2) + "\n");
}

// ── Dev-repo guard ──

/**
 * Detect whether we're running from a clone of the mex repo itself.
 * Checks: `MEX_DEV` env var, or `package.json` name matches the mex package.
 *
 * Generalized from `setup/index.ts:127-138` — checks the real package name
 * `mex-agent` plus legacy names `promexeus` and `mex` for safety.
 */
export function isDevRepo(): boolean {
  if (process.env.MEX_DEV) return true;

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
