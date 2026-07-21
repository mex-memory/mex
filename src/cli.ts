import chalk from "chalk";
import { Command, InvalidArgumentError } from "commander";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { findConfig, getScaffoldIdentity, readScaffoldId } from "./config.js";
import { reportConsole, reportQuiet, reportJSON, reportVerbose } from "./reporter.js";
import { VERSION } from "./version.js";
import { captureCommand, flush, isEnabled, getPayloadPreview, showFirstRunNotice } from "./telemetry/index.js";
import { readMachineId, setGlobalConfigKey } from "./global-config.js";
import { runFeedback, maybeShowInvite, dismissInvite, enableInvite } from "./feedback/index.js";

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

// ── Telemetry hooks ──

// preAction: fire the event at the START of the command. Two reasons:
//  - the async request gets the whole command runtime to land in the background
//  - commands that call process.exit() (e.g. `check` on drift) are still
//    counted; a postAction hook would never run after process.exit and would
//    systematically miss every error/drift outcome.
// scaffold_id is resolved read-only (never mints). Telemetry never throws here.
program.hook("preAction", (_thisCommand, actionCommand) => {
  try {
    // Never count the telemetry/config meta-commands. In particular,
    // `telemetry inspect` must have zero side effects — no event sent, no
    // machine-id file created — so it stays a pure audit surface.
    const parentName = actionCommand.parent?.name();
    if (parentName === "telemetry" || parentName === "config") return;

    let scaffoldId: string | undefined;
    try {
      scaffoldId = readScaffoldId(findConfig().scaffoldRoot);
    } catch {
      // No scaffold (or not in one) — omit scaffold_id.
    }
    captureCommand(actionCommand.name(), scaffoldId);
  } catch {
    // Telemetry must never affect command behaviour.
  }
});

// postAction: best-effort bounded flush for commands that exit naturally.
// Commands that process.exit() skip this, but their event was already sent
// from preAction (flushAt:1 fires the request immediately).
program.hook("postAction", async () => {
  try {
    await flush();
  } catch {
    // Telemetry must never affect command behaviour.
  }
});

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

      // Warm moment — a clean check just gave the user value. Quietly invite
      // feedback (only on success, never right before an error exit).
      maybeShowInvite();
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

// ── Code Graph ──
const graphCommand = program
  .command("graph")
  .description("Build/rebuild the code knowledge graph into .mex/graph.db")
  .option("--json", "Output the build summary as JSON")
  .option("--root <dir>", "Project root to index (defaults to current directory)")
  .action(async (opts) => {
    try {
      const { runGraph } = await import("./graph/cli-graph.js");
      await runGraph({ root: opts.root, json: opts.json });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

graphCommand
  .command("query <relation> <target>")
  .description("Query graph structure: who-calls, what-calls, or where-defined")
  .option("--detail <level>", "minimal | standard | source", "minimal")
  .option("--max-nodes <n>", "maximum results to return")
  .option("--max-output-tokens <n>", "hard output token ceiling")
  .option("--max-source-lines <n>", "per-node source line cap (with --detail source)")
  .action((relation, target, options) => {
    return import("./graph/cli-agent.js").then(({ runGraphQuery }) => runGraphQuery(relation, target, process.cwd(), {}, options));
  });

graphCommand
  .command("scope <task...>")
  .description("Retrieve a compact code neighborhood for a task as JSONL")
  .option("--detail <level>", "minimal | standard | source", "minimal")
  .option("--max-nodes <n>", "maximum nodes to return")
  .option("--max-output-tokens <n>", "hard output token ceiling")
  .option("--max-source-lines <n>", "per-node source line cap (with --detail source)")
  .option("--fingerprint", "attach serialized node fingerprints (grounding workflow)")
  .action((task: string[], options) => {
    return import("./graph/cli-agent.js").then(({ runGraphScope }) => runGraphScope(task.join(" "), process.cwd(), {}, options));
  });

graphCommand
  .command("get <id...>")
  .description("Expand source for specific node ids as JSONL")
  .option("--max-source-lines <n>", "per-node source line cap")
  .option("--max-output-tokens <n>", "hard output token ceiling")
  .action((ids: string[], options) => {
    return import("./graph/cli-agent.js").then(({ runGraphGet }) => runGraphGet(ids, process.cwd(), {}, options));
  });

graphCommand
  .command("ground")
  .description("Retro-ground an existing pre-0.7 scaffold using the code graph")
  .option("--dry-run", "Print the migration prompt without launching an agent")
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const { runGraphGround } = await import("./graph/cli-ground.js");
      await runGraphGround(config, opts);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("impact <target>")
  .description("Show transitive code and scaffold blast radius for a symbol or file")
  .option("--detail <level>", "minimal | standard | source", "minimal")
  .option("--depth <n>", "transitive caller depth", "2")
  .option("--max-nodes <n>", "maximum impacted nodes to return")
  .option("--max-output-tokens <n>", "hard output token ceiling")
  .option("--max-source-lines <n>", "per-node source line cap (with --detail source)")
  .action((target, options) => {
    return import("./graph/cli-agent.js").then(({ runImpact }) => runImpact(target, process.cwd(), {}, options));
  });

// ── Agent Memory Events ──
program
  .command("log <message>")
  .description("Append a decision, note, risk, or todo to the mex event log")
  .option("--type <type>", "Event type: decision, note, risk, todo", "note")
  .option("--file <path>", "Related file path (repeatable)", (value, prev: string[]) => [...prev, value], [])
  .option("--source <source>", "Where the event came from (e.g. meeting, manual, agent)")
  .option("--status <status>", "Lifecycle status (e.g. decided, implemented)")
  .action(async (message, opts) => {
    try {
      const config = loadConfig();
      const { runLog } = await import("./events.js");
      await runLog(config, message, { kind: opts.type, files: opts.file, source: opts.source, status: opts.status });
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
      maybeShowInvite();
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

// ── Telemetry ──
const telemetryCmd = program
  .command("telemetry")
  .description("Telemetry transparency commands");

telemetryCmd
  .command("inspect")
  .description("Print the exact JSON payload that would be sent (without sending it)")
  .action(() => {
    try {
      // Read-only: use readScaffoldId (never mints), not getScaffoldIdentity
      let scaffoldId: string | undefined;
      try {
        const config = findConfig();
        scaffoldId = readScaffoldId(config.scaffoldRoot);
      } catch { /* no scaffold — omit scaffold_id */ }

      // Read-only: show the machine_id only if it already exists. Auditing the
      // payload must never plant the tracking file on disk.
      const machineId = readMachineId();

      const payload = getPayloadPreview("inspect", scaffoldId, machineId);
      console.log(JSON.stringify(payload, null, 2));
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

telemetryCmd
  .command("status")
  .description("Show whether telemetry is enabled and the active opt-out reason")
  .action(() => {
    const result = isEnabled();
    if (result.enabled) {
      console.log("Telemetry: enabled");
    } else {
      console.log(`Telemetry: disabled (reason: ${result.reason})`);
    }
  });

// ── Config ──
const configCmd = program
  .command("config")
  .description("Manage global mex configuration");

configCmd
  .command("set <key> <value>")
  .description("Set a global config value (e.g. telemetry on|off)")
  .action((key: string, value: string) => {
    try {
      if (key === "telemetry") {
        if (value !== "on" && value !== "off") {
          console.error(`Invalid value "${value}" for telemetry. Use "on" or "off".`);
          process.exit(1);
        }
        setGlobalConfigKey("telemetry", value);
        console.log(`Telemetry set to "${value}" in ~/.mex/config.json`);
      } else if (key === "feedback") {
        if (value !== "on" && value !== "off") {
          console.error(`Invalid value "${value}" for feedback. Use "on" or "off".`);
          process.exit(1);
        }
        // "off" hides the invite; "on" re-enables it.
        if (value === "off") dismissInvite();
        else enableInvite();
        console.log(`Feedback invite ${value === "off" ? "hidden" : "re-enabled"}.`);
      } else {
        console.error(`Unknown config key "${key}". Supported keys: telemetry, feedback`);
        process.exit(1);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── Feedback ──
program
  .command("feedback")
  .description("Open the mex feedback form (the maintainer is doing user research calls)")
  .action(() => {
    runFeedback();
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
    console.log("  mex graph              Build the code knowledge graph into .mex/graph.db");
    console.log("  mex graph --json       Graph build summary as JSON");
    console.log("  mex graph scope <task>               Compact task neighborhood as JSONL");
    console.log("  mex graph get <id...>                Expand source for node ids as JSONL");
    console.log("  mex graph ground                     Ground an existing pre-0.7 scaffold");
    console.log("  mex graph query <relation> <target>  Structural lookup as JSONL");
    console.log("  mex impact <symbol|file>              Blast radius as JSONL");
    console.log("  mex log <message>      Append a note/decision/risk/todo to the event log");
    console.log("  mex timeline           Show recent event log entries");
    console.log("  mex heartbeat          Run lightweight agent-memory health checks");
    console.log("  mex doctor             Friendly scaffold health summary");
    console.log("  mex tui                Open the interactive mex dashboard");
    console.log("  mex pattern add <name> Create a new pattern file");
    console.log("  mex watch              Install post-commit hook for auto drift score");
    console.log("  mex watch --interval   Run heartbeat every 30 minutes (or config value)");
    console.log("  mex watch --uninstall  Remove the post-commit hook");
    console.log("  mex telemetry inspect  Show the exact telemetry payload (without sending)");
    console.log("  mex telemetry status   Show telemetry enabled/disabled and reason");
    console.log("  mex config set <k> <v> Set a global config value (e.g. telemetry off)");
    console.log("  mex feedback           Open the feedback form (the maintainer does user calls)");
    console.log();
    console.log(chalk.dim("Not installed globally? Replace 'mex' with 'npx mex-agent'."));
    console.log();
  });

// Skip auto-parse when imported (e.g. by tests). The bin entry is built by
// tsup as ./dist/cli.js with a shebang banner; only run program.parseAsync()
// when this module is the script being invoked. Resolve argv[1] so symlinked
// bins (npm global, npx, node_modules/.bin) match import.meta.url.
//
// Critical: use parseAsync(), not parse(). Commander's sync parse() does not
// await the promise chain built by hooks and async actions — preAction/
// postAction hooks would silently never execute and telemetry events would
// never flush.
let isMainModule = false;
if (process.argv[1]) {
  try {
    isMainModule = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    // argv[1] is missing or not on disk (e.g. test fixtures) — not the main entry.
  }
}
if (isMainModule) {
  showFirstRunNotice();
  program.parseAsync().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}

function buildCompletion(shell: string): string {
  const commands = [
    "setup", "check", "init", "graph", "impact", "sync", "pattern", "log", "timeline",
    "heartbeat", "doctor", "watch", "tui", "commands", "completion",
    "telemetry", "config", "feedback",
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
