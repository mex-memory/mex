import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { resolve, dirname, isAbsolute, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { MexConfig, AiTool, StalenessThresholds, WatchConfig, HeartbeatConfig, ScaffoldIdentity, WikiConfig, WikiSynthesisConfig } from "./types.js";
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
  /** Wiki indexing scope. Optional and additive; defaults to D10's lists. */
  wiki?: WikiConfig;
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
    wiki: normalizeWikiConfig(input.wiki),
  };
}

/**
 * Walk up from startDir looking for .git to find project root,
 * then require the current `.mex/` scaffold layout.
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
  const wiki = loadWikiConfig(persistedConfig);
  return { projectRoot, scaffoldRoot, aiTools, stalenessThresholds, watch, heartbeat, identity, wiki };
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
  setupMode?: unknown;
  wiki?: unknown;
  staleness?: unknown;
  watch?: unknown;
  heartbeat?: unknown;
  scaffold_id?: unknown;
  scaffold_name?: unknown;
  origin?: unknown;
  upstream?: unknown;
  [key: string]: unknown;
}

const VALID_AI_TOOLS = new Set<string>(["claude", "cursor", "windsurf", "copilot", "opencode", "codex"]);

function loadAiTools(raw: MexPersistedConfig | null): AiTool[] {
  const arr = raw?.aiTools;
  if (!Array.isArray(arr)) return [];
  return arr.filter((v): v is AiTool => typeof v === "string" && VALID_AI_TOOLS.has(v));
}

/** Read an existing setup tool selection without requiring a complete scaffold. */
export function loadConfiguredAiTools(scaffoldRoot: string): AiTool[] {
  return loadAiTools(loadPersistedConfig(scaffoldRoot));
}

/** Distinguish an explicit empty selection from a setup that never chose tools. */
export function hasConfiguredAiTools(scaffoldRoot: string): boolean {
  return Array.isArray(loadPersistedConfig(scaffoldRoot)?.aiTools);
}

/** Read setup intent without initializing config; older projects use code-repo. */
export function loadConfiguredSetupMode(scaffoldRoot: string): "code-repo" | "agent-memory" {
  return loadPersistedConfig(scaffoldRoot)?.setupMode === "agent-memory" ? "agent-memory" : "code-repo";
}

/** Persist setup intent using the same atomic, key-preserving config writer. */
export function saveConfiguredSetupMode(scaffoldRoot: string, mode: "code-repo" | "agent-memory"): void {
  mergeIntoConfig(scaffoldRoot, { setupMode: mode });
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

// ── Wiki indexing scope (implementation plan, D10) ──

/**
 * Paths the wiki engine never indexes.
 *
 * Ordered, and matched against scaffold-relative POSIX paths.
 */
export const DEFAULT_WIKI_EXCLUDE: readonly string[] = ["**/node_modules/**"];

/**
 * Reserved read-only prefixes.
 *
 * None of these directories exist yet, and that is the point: D10 fixes the set
 * before anything consumes it, so a read-only path is a first-class concept
 * from the first commit instead of a retrofit. A matching file is parsed,
 * indexed, queried and grounded exactly like any other — the restriction is on
 * writes, and P5's `operations/plan.ts` is where it is enforced.
 */
export const DEFAULT_WIKI_READ_ONLY: readonly string[] = [
  "team/**",
  "workstreams/**",
  "inbox/**",
  "relays/**",
  "playbooks/**",
  "events/activity/**",
];

/** Keep only the strings; a non-string entry is dropped rather than stored. */
function globList(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const globs = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return globs.length > 0 ? globs : [...fallback];
}

/**
 * §12 scope defaults.
 *
 * Measured rather than invented: every number is the reference pipeline's own,
 * except `maxTokens`, which is D10's default neighbourhood budget — a cluster
 * context is handed to an agent the same way a neighbourhood is, and having one
 * number for both is what D10 asks for.
 */
export const DEFAULT_WIKI_SYNTHESIS: WikiSynthesisConfig = {
  minFiles: 1,
  maxTokens: 4000,
  primaryContextLines: 3,
  maxFileLines: 400,
  supportingMaxLines: 120,
  maxCandidates: 60,
  maxPerUnit: 6,
  maxGroups: 40,
  maxNodes: 60,
};

/** A positive finite number, or the default. A garbage value costs one setting. */
function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeSynthesisConfig(value: unknown): WikiSynthesisConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ...DEFAULT_WIKI_SYNTHESIS };
  const raw = value as Record<string, unknown>;
  const out = { ...DEFAULT_WIKI_SYNTHESIS };
  const keys = Object.keys(DEFAULT_WIKI_SYNTHESIS) as Array<keyof WikiSynthesisConfig>;
  for (const key of keys) {
    out[key] = positiveNumber(raw[key], DEFAULT_WIKI_SYNTHESIS[key]);
  }
  return out;
}

/** Fill in D10's defaults around whatever the caller supplied. */
export function normalizeWikiConfig(value: Partial<WikiConfig> | undefined): WikiConfig {
  return {
    exclude: globList(value?.exclude, DEFAULT_WIKI_EXCLUDE),
    readOnly: globList(value?.readOnly, DEFAULT_WIKI_READ_ONLY),
    synthesis: normalizeSynthesisConfig(value?.synthesis),
  };
}

/**
 * Read `wiki` out of `.mex/config.json`.
 *
 * **Degrades to defaults; never throws.** Config parsing runs on the path of
 * every mex command, including the many that have nothing to do with the wiki,
 * so a hand-edited `"wiki": "yes"` must cost the user a wiki setting rather
 * than the whole CLI. `MexPersistedConfig`'s index signature already carries the
 * key through the JSON load untouched, so this is purely additive.
 */
function loadWikiConfig(raw: MexPersistedConfig | null): WikiConfig {
  const wiki = raw?.wiki;
  if (typeof wiki !== "object" || wiki === null || Array.isArray(wiki)) return normalizeWikiConfig(undefined);
  return normalizeWikiConfig(wiki as Partial<WikiConfig>);
}

function loadHeartbeatConfig(raw: MexPersistedConfig | null): HeartbeatConfig | undefined {
  if (!raw || typeof raw.heartbeat !== "object" || raw.heartbeat === null || Array.isArray(raw.heartbeat)) {
    return undefined;
  }
  const h = raw.heartbeat as Record<string, unknown>;
  const out: HeartbeatConfig = {};
  // Day-based heartbeat thresholds accept 0 ("stale as soon as older than
  // today", #42) while still rejecting negatives and garbage.
  const staleDays = readDayThreshold(h.staleDays);
  const memoryCleanupDays = readDayThreshold(h.memoryCleanupDays);
  const dailyMemoryRetentionDays = readDayThreshold(h.dailyMemoryRetentionDays);
  if (staleDays !== undefined) out.staleDays = staleDays;
  if (memoryCleanupDays !== undefined) out.memoryCleanupDays = memoryCleanupDays;
  if (dailyMemoryRetentionDays !== undefined) out.dailyMemoryRetentionDays = dailyMemoryRetentionDays;
  return Object.keys(out).length ? out : undefined;
}

function readDayThreshold(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  return undefined;
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
  const configDirectory = dirname(configPath);
  mkdirSync(configDirectory, { recursive: true });
  const stagedPath = resolve(configDirectory, `.config.json.mex-stage-${randomUUID()}`);
  try {
    writeFileSync(stagedPath, JSON.stringify(existing, null, 2) + "\n", { flag: "wx" });
    renameSync(stagedPath, configPath);
  } finally {
    rmSync(stagedPath, { force: true });
  }
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
  const mexDir = resolve(projectRoot, ".mex");
  return existsSync(mexDir) ? mexDir : null;
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
