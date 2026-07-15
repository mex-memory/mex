import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, isAbsolute, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { MexConfig, AiTool, StalenessThresholds, WatchConfig, HeartbeatConfig, ScaffoldIdentity } from "./types.js";
import { DEFAULT_STALENESS_THRESHOLDS } from "./drift/checkers/staleness.js";

/**
 * Inputs accepted by {@link createConfig}. Only the two roots are required —
 * everything else mirrors the optional fields on {@link MexConfig} so callers
 * can opt in field by field.
 */
export interface CreateConfigInput {
  /** Absolute path to the project root (e.g. where .git lives). */
  projectRoot: string;
  /** Absolute path to the scaffold root (the directory holding ROUTER.md, etc.). */
  scaffoldRoot: string;
  aiTools?: AiTool[];
  stalenessThresholds?: StalenessThresholds;
  watch?: WatchConfig;
  heartbeat?: HeartbeatConfig;
}

/**
 * Build a {@link MexConfig} from explicit inputs, bypassing the on-disk
 * discovery that {@link findConfig} performs. Intended for embedders that
 * already know where the project and scaffold live — for example, tools that
 * use a non-default scaffold directory name and therefore can't rely on
 * findConfig's `.mex/` lookup.
 *
 * Defaults `aiTools` to an empty array. Other optional fields are passed
 * through untouched.
 */
export function createConfig(input: CreateConfigInput): MexConfig {
  if (!isAbsolute(input.projectRoot)) {
    throw new Error(`createConfig: projectRoot must be an absolute path, got "${input.projectRoot}"`);
  }
  if (!isAbsolute(input.scaffoldRoot)) {
    throw new Error(`createConfig: scaffoldRoot must be an absolute path, got "${input.scaffoldRoot}"`);
  }
  return {
    projectRoot: input.projectRoot,
    scaffoldRoot: input.scaffoldRoot,
    aiTools: input.aiTools ?? [],
    stalenessThresholds: input.stalenessThresholds,
    watch: input.watch,
    heartbeat: input.heartbeat,
  };
}

/**
 * Walk up from startDir looking for .git to find project root,
 * then look for scaffold root (.mex/ or context/ directory).
 */
export function findConfig(startDir?: string): MexConfig {
  const dir = startDir ?? process.cwd();

  if (dir.split(/[\\/]/).includes(".mex")) {
    throw new Error(
      "You're inside the .mex/ directory. Run mex commands from your project root instead."
    );
  }

  // Try git root first, fall back to cwd if no git repo
  const gitRoot = findProjectRoot(dir);
  const projectRoot = gitRoot ?? dir;

  const mexDir = resolve(projectRoot, ".mex");
  if (existsSync(mexDir) && !existsSync(resolve(mexDir, "ROUTER.md"))) {
    throw new Error("Scaffold directory exists but looks incomplete. Run: mex setup");
  }

  const scaffoldRoot = findScaffoldRoot(projectRoot);
  if (!scaffoldRoot) {
    if (!gitRoot) {
      throw new Error("No git repository found. Initialize one first: git init");
    }

    throw new Error(
      "No .mex/ scaffold found. Run: mex setup"
    );
  }

  const persistedConfig = loadPersistedConfig(scaffoldRoot);
  const aiTools = loadAiTools(persistedConfig);
  const stalenessThresholds = loadStalenessThresholds(scaffoldRoot, persistedConfig);
  const watch = loadWatchConfig(persistedConfig);
  const heartbeat = loadHeartbeatConfig(persistedConfig);
  const identity = loadScaffoldIdentity(persistedConfig);
  return { projectRoot, scaffoldRoot, aiTools, stalenessThresholds, watch, heartbeat, identity };
}

function findProjectRoot(dir: string): string | null {
  let current = resolve(dir);
  while (true) {
    if (existsSync(resolve(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ── AI Tool persistence ──

const CONFIG_FILE = "config.json";

interface MexPersistedConfig {
  aiTools?: unknown;
  staleness?: unknown;
  watch?: unknown;
  heartbeat?: unknown;
  scaffold_id?: unknown;
  scaffold_name?: unknown;
  origin?: unknown;
  upstream?: unknown;
  [key: string]: unknown;
}

const VALID_AI_TOOLS = new Set<string>(["claude", "cursor", "windsurf", "copilot", "opencode", "codex", "pi"]);

function loadAiTools(raw: MexPersistedConfig | null): AiTool[] {
  const arr = raw?.aiTools;
  if (!Array.isArray(arr)) return [];
  return arr.filter((v): v is AiTool => typeof v === "string" && VALID_AI_TOOLS.has(v));
}

function loadStalenessThresholds(scaffoldRoot: string, raw: MexPersistedConfig | null): StalenessThresholds | undefined {
  const configPath = resolve(scaffoldRoot, CONFIG_FILE);
  if (!raw) return undefined;
  try {
    const staleness = raw.staleness;
    if (typeof staleness !== "object" || staleness === null || Array.isArray(staleness)) return undefined;
    const s = staleness as Record<string, unknown>;

    const readInt = (key: string): number | undefined => {
      const v = s[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
      return undefined;
    };

    const warnDays = readInt("warnDays");
    const errorDays = readInt("errorDays");
    const warnCommits = readInt("warnCommits");
    const errorCommits = readInt("errorCommits");

    // Any field missing falls back to defaults, so partial overrides still work.
    if (warnDays === undefined && errorDays === undefined && warnCommits === undefined && errorCommits === undefined) {
      return undefined;
    }
    const resolved: StalenessThresholds = {
      warnDays: warnDays ?? DEFAULT_STALENESS_THRESHOLDS.warnDays,
      errorDays: errorDays ?? DEFAULT_STALENESS_THRESHOLDS.errorDays,
      warnCommits: warnCommits ?? DEFAULT_STALENESS_THRESHOLDS.warnCommits,
      errorCommits: errorCommits ?? DEFAULT_STALENESS_THRESHOLDS.errorCommits,
    };

    // Reject inverted warn/error pairs. A misconfigured
    // warnDays: 90, errorDays: 30 silently makes the warn path unreachable,
    // so surface it and fall back to defaults rather than honoring a
    // config that disables half of the checker.
    if (resolved.errorDays < resolved.warnDays || resolved.errorCommits < resolved.warnCommits) {
      console.warn(
        `[mex] staleness thresholds in ${configPath} invert warn/error ` +
          `(warnDays=${resolved.warnDays}, errorDays=${resolved.errorDays}, ` +
          `warnCommits=${resolved.warnCommits}, errorCommits=${resolved.errorCommits}); ` +
          `falling back to defaults.`
      );
      return { ...DEFAULT_STALENESS_THRESHOLDS };
    }

    return resolved;
  } catch {
    return undefined;
  }
}

function loadWatchConfig(raw: MexPersistedConfig | null): WatchConfig | undefined {
  if (!raw || typeof raw.watch !== "object" || raw.watch === null || Array.isArray(raw.watch)) {
    return undefined;
  }
  const w = raw.watch as Record<string, unknown>;
  const intervalMinutes = readPositiveNumber(w.intervalMinutes);
  return intervalMinutes === undefined ? undefined : { intervalMinutes };
}

function loadHeartbeatConfig(raw: MexPersistedConfig | null): HeartbeatConfig | undefined {
  if (!raw || typeof raw.heartbeat !== "object" || raw.heartbeat === null || Array.isArray(raw.heartbeat)) {
    return undefined;
  }
  const h = raw.heartbeat as Record<string, unknown>;
  const out: HeartbeatConfig = {};
  const staleDays = readPositiveNumber(h.staleDays);
  const memoryCleanupDays = readPositiveNumber(h.memoryCleanupDays);
  const dailyMemoryRetentionDays = readPositiveNumber(h.dailyMemoryRetentionDays);
  if (staleDays !== undefined) out.staleDays = staleDays;
  if (memoryCleanupDays !== undefined) out.memoryCleanupDays = memoryCleanupDays;
  if (dailyMemoryRetentionDays !== undefined) out.dailyMemoryRetentionDays = dailyMemoryRetentionDays;
  return Object.keys(out).length ? out : undefined;
}

function readPositiveNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return undefined;
}

function loadScaffoldIdentity(raw: MexPersistedConfig | null): ScaffoldIdentity | undefined {
  if (!raw) return undefined;
  const id = raw.scaffold_id;
  // Identity exists only once a scaffold_id is present. Everything else is
  // optional and falls back to a safe default.
  if (typeof id !== "string" || id.length === 0) return undefined;
  return {
    scaffold_id: id,
    scaffold_name: typeof raw.scaffold_name === "string" ? raw.scaffold_name : "",
    origin: typeof raw.origin === "string" ? raw.origin : null,
    upstream: typeof raw.upstream === "string" ? raw.upstream : null,
  };
}

function loadPersistedConfig(scaffoldRoot: string): MexPersistedConfig | null {
  const configPath = resolve(scaffoldRoot, CONFIG_FILE);
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    return raw as MexPersistedConfig;
  } catch {
    return null;
  }
}

/**
 * Read config.json, shallow-merge `patch` into it, and write it back. Preserves
 * any keys not named in the patch, so independent writers (aiTools, identity,
 * …) never clobber each other.
 */
function mergeIntoConfig(scaffoldRoot: string, patch: Record<string, unknown>): void {
  const configPath = resolve(scaffoldRoot, CONFIG_FILE);
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        existing = raw as Record<string, unknown>;
      }
    } catch { /* start fresh */ }
  }
  Object.assign(existing, patch);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
}

export function saveAiTools(scaffoldRoot: string, tools: AiTool[]): void {
  mergeIntoConfig(scaffoldRoot, { aiTools: [...new Set(tools)] });
}

export function saveScaffoldIdentity(scaffoldRoot: string, identity: ScaffoldIdentity): void {
  mergeIntoConfig(scaffoldRoot, {
    scaffold_id: identity.scaffold_id,
    scaffold_name: identity.scaffold_name,
    origin: identity.origin,
    upstream: identity.upstream,
  });
}

/**
 * Return the scaffold's identity, minting and persisting one if it does not yet
 * exist. Reads config.json fresh so it is idempotent regardless of what the
 * in-memory config knows — re-running setup never regenerates an existing id.
 *
 * The persist is best-effort: a write failure (read-only FS, perms) is
 * swallowed and the in-memory identity is returned, so this can never break or
 * change the exit code of a command.
 */
export function ensureScaffoldIdentity(scaffoldRoot: string, projectRoot: string): ScaffoldIdentity {
  const existing = loadScaffoldIdentity(loadPersistedConfig(scaffoldRoot));
  // A complete identity needs both an id and a name. If a prior write or a
  // hand-edited config left scaffold_name empty, keep the existing id and
  // backfill only the missing name — never regenerate the id.
  if (existing && existing.scaffold_name) return existing;

  const identity: ScaffoldIdentity = {
    scaffold_id: existing?.scaffold_id ?? randomUUID(),
    scaffold_name: basename(projectRoot),
    origin: existing?.origin ?? null,
    upstream: existing?.upstream ?? null,
  };
  try {
    saveScaffoldIdentity(scaffoldRoot, identity);
  } catch { /* best-effort: never break a command on a telemetry-id write */ }
  return identity;
}

/**
 * Public accessor for a scaffold's identity. Returns the already-loaded
 * identity when present, otherwise mints and persists one. See E1 in
 * COMPATIBILITY.md — part of the public API surface.
 */
export function getScaffoldIdentity(config: MexConfig): ScaffoldIdentity {
  if (config.identity && config.identity.scaffold_name) return config.identity;
  const identity = ensureScaffoldIdentity(config.scaffoldRoot, config.projectRoot);
  config.identity = identity;
  return identity;
}

function findScaffoldRoot(projectRoot: string): string | null {
  // Prefer .mex/ directory
  const mexDir = resolve(projectRoot, ".mex");
  if (existsSync(mexDir)) {
    return mexDir;
  }

  // Fall back to context/ directory (current mex layout)
  const contextDir = resolve(projectRoot, "context");
  if (existsSync(contextDir)) return projectRoot;

  return null;
}

/**
 * Read-only scaffold_id lookup. Returns the scaffold_id string if it exists
 * in config.json, or `undefined` if not. **Never mints or writes anything.**
 *
 * Used by telemetry inspect to show the payload without side-effects.
 */
export function readScaffoldId(scaffoldRoot: string): string | undefined {
  const raw = loadPersistedConfig(scaffoldRoot);
  const identity = loadScaffoldIdentity(raw);
  return identity?.scaffold_id;
}
