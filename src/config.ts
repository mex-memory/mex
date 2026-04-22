import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { MexConfig, AiTool, StalenessThresholds } from "./types.js";
import { DEFAULT_STALENESS_THRESHOLDS } from "./drift/checkers/staleness.js";

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

  const aiTools = loadAiTools(scaffoldRoot);
  const stalenessThresholds = loadStalenessThresholds(scaffoldRoot);
  return { projectRoot, scaffoldRoot, aiTools, stalenessThresholds };
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
  [key: string]: unknown;
}

const VALID_AI_TOOLS = new Set<string>(["claude", "cursor", "windsurf", "copilot", "opencode", "codex"]);

function loadAiTools(scaffoldRoot: string): AiTool[] {
  const configPath = resolve(scaffoldRoot, CONFIG_FILE);
  if (!existsSync(configPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
    const arr = (raw as MexPersistedConfig).aiTools;
    if (!Array.isArray(arr)) return [];
    return arr.filter((v): v is AiTool => typeof v === "string" && VALID_AI_TOOLS.has(v));
  } catch {
    return [];
  }
}

function loadStalenessThresholds(scaffoldRoot: string): StalenessThresholds | undefined {
  const configPath = resolve(scaffoldRoot, CONFIG_FILE);
  if (!existsSync(configPath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const staleness = (raw as MexPersistedConfig).staleness;
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

export function saveAiTools(scaffoldRoot: string, tools: AiTool[]): void {
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
  existing.aiTools = [...new Set(tools)];
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
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
