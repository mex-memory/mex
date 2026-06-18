import { existsSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { globSync } from "glob";
import chalk from "chalk";
import { parseFrontmatter } from "./drift/frontmatter.js";
import { daysSinceFrontmatterDate } from "./drift/checkers/staleness.js";
import { toPosix } from "./paths.js";
import type { MexConfig } from "./types.js";

export interface HeartbeatResult {
  ok: boolean;
  staleFiles: Array<{ file: string; days: number }>;
  memoryCleanupDue: boolean;
  oldDailyMemoryFiles: string[];
}

export interface HeartbeatOpts {
  json?: boolean;
  /** Override the glob patterns used to discover heartbeat files (relative to
   *  `config.scaffoldRoot`). Defaults to {@link DEFAULT_HEARTBEAT_PATTERNS}. */
  scaffoldPatterns?: readonly string[];
}

/**
 * Default glob patterns used by the heartbeat checker, relative to
 * `MexConfig.scaffoldRoot`. NOT a stable contract — mex may add to this list
 * between minor versions. Pass `scaffoldPatterns` explicitly when exact
 * behavior matters.
 */
export const DEFAULT_HEARTBEAT_PATTERNS = [
  "ROUTER.md",
  "AGENTS.md",
  "context/*.md",
  "patterns/*.md",
] as const;

const DEFAULT_STALE_DAYS = 7;
const DEFAULT_MEMORY_CLEANUP_DAYS = 7;
const DEFAULT_DAILY_MEMORY_RETENTION_DAYS = 14;

export async function runHeartbeat(config: MexConfig, opts: HeartbeatOpts = {}): Promise<HeartbeatResult> {
  const result = checkHeartbeat(config, new Date(), { scaffoldPatterns: opts.scaffoldPatterns });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  printHeartbeat(result, config);
  return result;
}

export interface CheckHeartbeatOpts {
  /** Override the glob patterns used to discover heartbeat files (relative to
   *  `config.scaffoldRoot`). Defaults to {@link DEFAULT_HEARTBEAT_PATTERNS}. */
  scaffoldPatterns?: readonly string[];
}

export function checkHeartbeat(
  config: MexConfig,
  now = new Date(),
  opts: CheckHeartbeatOpts = {}
): HeartbeatResult {
  const staleDays = config.heartbeat?.staleDays ?? DEFAULT_STALE_DAYS;
  const memoryCleanupDays = config.heartbeat?.memoryCleanupDays ?? DEFAULT_MEMORY_CLEANUP_DAYS;
  const dailyRetentionDays = config.heartbeat?.dailyMemoryRetentionDays ?? DEFAULT_DAILY_MEMORY_RETENTION_DAYS;

  const staleFiles = scaffoldHeartbeatFiles(config.scaffoldRoot, opts.scaffoldPatterns)
    .map((file) => {
      const fm = parseFrontmatter(file);
      const days = daysSinceFrontmatterDate(
        typeof fm?.last_updated === "string" ? fm.last_updated : undefined,
        now,
      );
      return days !== null && days > staleDays
        ? { file: toPosix(relative(config.scaffoldRoot, file)), days }
        : null;
    })
    .filter((v): v is { file: string; days: number } => Boolean(v));

  const memoryCleanupDue = isMemoryCleanupDue(config.projectRoot, memoryCleanupDays, now);
  const oldDailyMemoryFiles = oldMemoryFiles(config.projectRoot, dailyRetentionDays, now);

  return {
    ok: staleFiles.length === 0 && !memoryCleanupDue && oldDailyMemoryFiles.length === 0,
    staleFiles,
    memoryCleanupDue,
    oldDailyMemoryFiles,
  };
}

function scaffoldHeartbeatFiles(
  scaffoldRoot: string,
  patterns: readonly string[] = DEFAULT_HEARTBEAT_PATTERNS,
): string[] {
  return patterns.flatMap((pattern) =>
    globSync(pattern, {
      cwd: scaffoldRoot,
      absolute: true,
      follow: true,
      nodir: true,
    }),
  );
}

function isMemoryCleanupDue(projectRoot: string, thresholdDays: number, now: Date): boolean {
  const file = resolve(projectRoot, "memory/.last-cleanup.json");
  if (!existsSync(file)) return false;
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof raw.lastCleanup !== "string") return false;
    const days = daysSinceIsoDate(raw.lastCleanup, now);
    return days !== null && days > thresholdDays;
  } catch {
    return false;
  }
}

function oldMemoryFiles(projectRoot: string, retentionDays: number, now: Date): string[] {
  const memoryRoot = resolve(projectRoot, "memory");
  if (!existsSync(memoryRoot)) return [];
  return globSync("*.md", { cwd: memoryRoot, nodir: true })
    .filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file))
    .filter((file) => {
      const days = daysSinceFrontmatterDate(file.replace(/\.md$/, ""), now);
      return days !== null && days > retentionDays;
    })
    .map((file) => `memory/${file}`);
}

function daysSinceIsoDate(value: string, now: Date): number | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dateUtc = Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());
  const days = Math.floor((todayUtc - dateUtc) / 86_400_000);
  return days < 0 ? null : days;
}

function printHeartbeat(result: HeartbeatResult, config: MexConfig): void {
  if (result.ok) {
    console.log("HEARTBEAT_OK");
    return;
  }

  console.log(chalk.bold("Heartbeat needs attention"));
  if (result.staleFiles.length) {
    console.log();
    console.log(chalk.yellow("Stale scaffold files:"));
    for (const f of result.staleFiles) {
      console.log(`  ${f.file} — last_updated ${f.days} days ago`);
    }
    console.log(chalk.dim("  Review these files and run `mex sync` if they no longer match reality."));
  }
  if (result.memoryCleanupDue) {
    console.log();
    console.log(chalk.yellow("Memory cleanup is due."));
    console.log(chalk.dim("  Review memory/YYYY-MM-DD.md files and promote useful details to MEMORY.md."));
  }
  if (result.oldDailyMemoryFiles.length) {
    console.log();
    console.log(chalk.yellow("Old daily memory files:"));
    for (const file of result.oldDailyMemoryFiles) console.log(`  ${file}`);
  }
  console.log();
  console.log(chalk.dim(`Scaffold: ${config.scaffoldRoot}`));
}
