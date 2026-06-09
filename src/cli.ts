import chalk from "chalk";
import { Command, InvalidArgumentError } from "commander";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { findConfig, getScaffoldIdentity } from "./config.js";
import { reportConsole, reportQuiet, reportJSON, reportVerbose } from "./reporter.js";
import { VERSION } from "./version.js";

/**
 * Load config for a CLI command and backfill scaffold identity on the way.
 * Centralises the E1 migration: any command that loads config mints a
 * scaffold_id if one is missing (silent, cheap, best-effort). Keeps findConfig
 * itself a pure read for embedders.
 */
function loadConfig(): ReturnType<typeof findConfig> {
  const config = findConfig();
  getScaffoldIdentity(config);
  return config;
}

export function parseIntArg(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError(`Expected a non-negative integer, got "${raw}".`);
  }
  return n;
}

export function parsePositiveIntArg(raw: string): number {
  const n = parseIntArg(raw);
  if (n <= 0) {
    throw new InvalidArgumentError(`Expected a positive integer, got "${raw}".`);
  }
  return n;
}

export const program = new Command();

async function runTuiCommand(): Promise<void> {
  const { launchTui } = await import("./tui.js");
  launchTui();
}

program
  .name("mex")
  .description("CLI engine for mex scaffold — drift detection, pre-analysis, and targeted sync")
  .version(VERSION)
  .showHelpAfterError()
  .action(async () => {
    await runTuiCommand();
  });

program
  .command("tui")
  .description("Open the interactive mex dashboard")
  .action(async () => {
    await runTuiCommand();
  });

// ── Setup (npx entry point) ──
program
  .command("setup")
  .description("First-time setup — create .mex/ scaffold and populate with AI")
  .option("--mode <mode>", "Template mode: code-repo (default) or agent-memory", "code-repo")
  .option("--dry-run", "Show what would happen without making changes")
  .action(async (opts) => {
    try {
      const { runSetup } = await import("./setup/index.js");
      await runSetup({ dryRun: opts.dryRun, mode: opts.mode });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── Layer 2: Drift Detection ──
program
  .command("check")
  .description("Detect drift between scaffold files and codebase reality")
  .option("--json", "Output full drift report as JSON")
  .option("--quiet", "Single-line summary only")
  .option("--fix", "Run sync to fix any issues found")
  .option("--verbose", "Show detailed diagnostic output")
  .option("--stale-warn-days <n>", "Warn when a file hasn't changed in N days (default 30)", parseIntArg)
  .option("--stale-error-days <n>", "Error when a file hasn't changed in N days (default 90)", parseIntArg)
  .option("--stale-warn-commits <n>", "Warn when a file has N commits since its last change (default 50)", parseIntArg)
  .option("--stale-error-commits <n>", "Error when a file has N commits since its last change (default 200)", parseIntArg)
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const { runDriftCheck } = await import("./drift/index.js");
      const { DEFAULT_STALENESS_THRESHOLDS } = await import("./drift/checkers/staleness.js");

      const stalenessThresholds = {
        warnDays: opts.staleWarnDays ?? config.stalenessThresholds?.warnDays ?? DEFAULT_STALENESS_THRESHOLDS.warnDays,
        errorDays: opts.staleErrorDays ?? config.stalenessThresholds?.errorDays ?? DEFAULT_STALENESS_THRESHOLDS.errorDays,
        warnCommits: opts.staleWarnCommits ?? config.stalenessThresholds?.warnCommits ?? DEFAULT_STALENESS_THRESHOLDS.warnCommits,
        errorCommits: opts.staleErrorCommits ?? config.stalenessThresholds?.errorCommits ?? DEFAULT_STALENESS_THRESHOLDS.errorCommits,
      };

      const report = await runDriftCheck(
        { ...config, stalenessThresholds },
        { verbose: opts.verbose },
      );

      if (opts.json) {
        reportJSON(report, { verbose: opts.verbose });
      } else if (opts.quiet) {
        reportQuiet(report);
      } else {
        if (opts.verbose) reportVerbose(report);
        reportConsole(report);
      }

      // If --fix and there are issues, jump to sync
      const hasErrors = report.issues.some((i) => i.severity === "error");
      if (opts.fix && hasErrors) {
        const { runSync } = await import("./sync/index.js");
        await runSync(config, {});
        return;
      }

      if (hasErrors) process.exit(1);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── Layer 1: Pre-analysis Scanner ──
program
  .command("init")
  .description("Scan codebase and generate pre-analysis brief for AI")
  .option("--json", "Output scanner brief as JSON")
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const { runScan } = await import("./scanner/index.js");
      const result = await runScan(config, { jsonOnly: opts.json });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── Agent Memory Events ──
program
  .command("log <message>")
  .description("Append a decision, note, risk, or todo to the mex event log")
  .option("--type <type>", "Event type: decision, note, risk, todo", "note")
  .option("--file <path>", "Related file path (repeatable)", (value, prev: string[]) => [...prev, value], [])
  .action(async (message, opts) => {
    try {
      const config = loadConfig();
      const { runLog } = await import("./events.js");
      await runLog(config, message, { kind: opts.type, files: opts.file });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("timeline")
  .description("Show recent mex event log entries")
  .option("--json", "Output events as JSON")
  .option("--since <date>", "Filter from YYYY-MM-DD or relative Nd, e.g. 30d")
  .option("--type <type>", "Filter by event type")
  .option("--limit <n>", "Maximum number of entries", parsePositiveIntArg)
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const { runTimeline } = await import("./events.js");
      await runTimeline(config, opts);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("heartbeat")
  .description("Run lightweight agent-memory health checks once")
  .option("--json", "Output heartbeat report as JSON")
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const { runHeartbeat } = await import("./heartbeat.js");
      await runHeartbeat(config, { json: opts.json });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("doctor")
  .description("Run a friendly scaffold health diagnostic")
  .action(async () => {
    try {
      const config = loadConfig();
      const { runDoctor } = await import("./doctor.js");
      await runDoctor(config);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("export")
  .description("Bundle scaffold files into a single Markdown document")
  .option("-o, --output <path>", "Write bundled markdown to a file (default: stdout)")
  .action(async (opts) => {
    try {
      const config = findConfig();
      const { runExport } = await import("./export/index.js");
      await runExport(config, { output: opts.output });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── Layer 3: Targeted Sync ──
program
  .command("sync")
  .description("Run drift check, then build targeted prompts for AI to fix flagged files")
  .option("--dry-run", "Show what would be synced without executing")
  .option("--warnings", "Include warning-only files (by default only errors are synced)")
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const { runSync } = await import("./sync/index.js");
      await runSync(config, { dryRun: opts.dryRun, includeWarnings: opts.warnings });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── Layer 4: Patterns ──
const patternCmd = program
  .command("pattern")
  .description("Manage pattern files");

patternCmd
  .command("add <name>")
  .description("Create a new pattern file and add it to the index")
  .action(async (name) => {
    try {
      const config = loadConfig();
      const { runPatternAdd } = await import("./pattern/index.js");
      await runPatternAdd(config, name);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── Git Hook ──
program
  .command("watch")
  .description("Install/uninstall post-commit hook, or run heartbeat on an interval")
  .option("--uninstall", "Remove the post-commit hook")
  .option("--interval [minutes]", "Run mex heartbeat repeatedly instead of installing a hook", (v) => v === undefined ? true : parsePositiveIntArg(v))
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const { manageHook } = await import("./watch.js");
      const intervalMinutes = opts.interval === true
        ? config.watch?.intervalMinutes ?? 30
        : typeof opts.interval === "number"
          ? opts.interval
          : undefined;
      await manageHook(config, { uninstall: opts.uninstall, intervalMinutes });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("completion <shell>")
  .description("Print shell completion script for bash, zsh, or fish")
  .action((shell) => {
    try {
      console.log(buildCompletion(shell));
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── Quick Reference ──
program
  .command("commands")
  .description("List all available commands and scripts")
  .action(() => {
    console.log(chalk.bold("\nCLI Commands") + chalk.dim("  (run from project root)\n"));
    console.log("  mex setup              First-time setup — create .mex/ scaffold");
    console.log("  mex setup --dry-run    Preview setup without making changes");
    console.log("  mex check              Drift score — are scaffold files still accurate?");
    console.log("  mex check --quiet      One-liner drift score");
    console.log("  mex check --json       Full drift report as JSON");
    console.log("  mex check --fix        Check and fix any errors found");
    console.log("  mex sync               Fix drift — AI updates only what's broken");
    console.log("  mex sync --dry-run     Preview fix prompts without running them");
    console.log("  mex sync --warnings    Include warning-only files in sync");
    console.log("  mex init               Pre-scan codebase, build brief for AI");
    console.log("  mex init --json        Scanner brief as JSON");
    console.log("  mex log <message>      Append a note/decision/risk/todo to the event log");
    console.log("  mex timeline           Show recent event log entries");
    console.log("  mex heartbeat          Run lightweight agent-memory health checks");
    console.log("  mex doctor             Friendly scaffold health summary");
    console.log("  mex export             Bundle scaffold into one Markdown file");
    console.log("  mex export -o <path>   Write bundled markdown to a file");
    console.log("  mex tui                Open the interactive mex dashboard");
    console.log("  mex pattern add <name> Create a new pattern file");
    console.log("  mex watch              Install post-commit hook for auto drift score");
    console.log("  mex watch --interval   Run heartbeat every 30 minutes (or config value)");
    console.log("  mex watch --uninstall  Remove the post-commit hook");
    console.log();
    console.log(chalk.dim("Not installed globally? Replace 'mex' with 'npx mex-agent'."));
    console.log();
  });

// Skip auto-parse when imported (e.g. by tests). The bin entry is built by
// tsup as ./dist/cli.js with a shebang banner; only run program.parse() when
// this module is the script being invoked. Resolve argv[1] so symlinked bins
// (npm global, npx, node_modules/.bin) match import.meta.url.
let isMainModule = false;
if (process.argv[1]) {
  try {
    isMainModule = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    // argv[1] is missing or not on disk (e.g. test fixtures) — not the main entry.
  }
}
if (isMainModule) {
  program.parse();
}

function buildCompletion(shell: string): string {
  const commands = [
    "setup", "check", "init", "sync", "pattern", "log", "timeline",
    "heartbeat", "doctor", "export", "watch", "tui", "commands", "completion",
  ];
  if (shell === "bash") {
    return `_mex_completion() {
  COMPREPLY=($(compgen -W "${commands.join(" ")}" -- "\${COMP_WORDS[COMP_CWORD]}"))
}
complete -F _mex_completion mex`;
  }
  if (shell === "zsh") {
    return `#compdef mex
_arguments '1:command:(${commands.join(" ")})'`;
  }
  if (shell === "fish") {
    return commands.map((cmd) => `complete -c mex -f -a ${cmd}`).join("\n");
  }
  throw new Error(`Unknown shell "${shell}". Use bash, zsh, or fish.`);
}
