import chalk from "chalk";
import { Command, InvalidArgumentError, Option } from "commander";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findConfig, getScaffoldIdentity } from "./config.js";
import { reportConsole, reportQuiet, reportJSON, reportVerbose } from "./reporter.js";
import { registerRemovedCommands, removedCommandMessage } from "./removed-commands.js";
import { VERSION } from "./version.js";
import { PUBLIC_COMMAND_ORDER } from "./cli-tools.js";
import { buildKnowledgeCommands } from "./knowledge/cli.js";
import { buildUpgradeCommand } from "./upgrade/cli.js";
import { unsupportedNodeMessage } from "./node-version.js";
import { captureEvent, flush, isEnabled, getProjectTelemetryContext, getTelemetryInspection, disableTelemetry, enableTelemetry, showFirstRunNotice } from "./telemetry/index.js";
import { mexHomeDir, setGlobalConfigKey } from "./global-config.js";
import { createCliTelemetry, telemetryProjectLocation } from "./cli-telemetry.js";
export { isTelemetryExemptCommand } from "./cli-telemetry.js";
import { runFeedback, maybeShowInvite, dismissInvite, enableInvite } from "./feedback/index.js";
import type { MexConfig } from "./types.js";
import type { RunHubCommandOptions } from "./hub/command.js";
import { capabilitiesInvalidRequestEnvelope, readWikiExclude } from "./capabilities.js";
import { WIKI_APPLY_HELP } from "./wiki/cli/apply-help.js";
import {
  buildTeamIdentityActivityCommands,
  exitCodeForTeamEnvelope,
  locateTeamRepositoryRoot,
  processTeamCommandIo,
  renderTeamEnvelope,
  teamProblemEnvelope,
  TeamCliUsageError,
  type TeamCliCommandName,
  type TeamCliMode,
  type TeamIdentityActivityCliServiceFactory,
} from "./team/cli/index.js";
import {
  buildRelayCommand,
  type TeamRelayCliServiceFactory,
} from "./team/relay/cli/index.js";

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

export function parsePortArg(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new InvalidArgumentError(`Expected a positive integer, got "${raw}".`);
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new InvalidArgumentError(`Expected a positive integer, got "${raw}".`);
  }
  if (port > 65_535) {
    throw new InvalidArgumentError(`Expected a TCP port from 1 to 65535, got "${raw}".`);
  }
  return port;
}

/** Pure Hub bootstrap projection so CLI and production wiring share Wiki scope. */
export function createHubRunOptions(
  config: Pick<MexConfig, "projectRoot" | "wiki">,
  scaffoldId: string,
  options: { port?: number; open: boolean },
): RunHubCommandOptions {
  return {
    projectRoot: config.projectRoot,
    scaffoldId,
    port: options.port,
    openBrowser: options.open,
    ...(config.wiki?.exclude === undefined ? {} : { wikiExclude: config.wiki.exclude }),
    ...(config.wiki?.readOnly === undefined ? {} : { wikiReadOnly: config.wiki.readOnly }),
  };
}

export const program = new Command();
let cliStarted = false;
registerRemovedCommands(program);

/** Commands whose machine/read-only contract must precede any global notice. */
export function isFirstRunNoticeExemptCommand(commandName?: string): boolean {
  return commandName === undefined || commandName === "setup" || commandName === "hub"
    || commandName === "telemetry"
    || commandName === "config"
    || commandName === "logging"
    || commandName === "timeline"
    || commandName === "capabilities"
    || commandName === "member"
    || commandName === "activity"
    || commandName === "workstream"
    || commandName === "inbox"
    || commandName === "relay"
    || commandName === "spec"
    || commandName === "note" || commandName === "log" || commandName === "recall" || commandName === "expand"
    || commandName === "edit" || commandName === "wrong" || commandName === "forget"
    || commandName === "what" || commandName === "report"
    || commandName === "hints" || commandName === "rules" || commandName === "share" || commandName === "brief" || commandName === "upgrade"
    || commandName === "skills" || commandName === "install" || commandName === "uninstall"
    || commandName === "off" || commandName === "on" || commandName === "capture" || commandName === "handoff" || commandName === "compact"
    || commandName === "status" || commandName === "doctor";
}

async function runBrowserCommand(options: { port?: number; open: boolean; mode?: string; setup?: boolean }): Promise<void> {
  const { launchHub } = await import("./hub/command.js");
  await launchHub({ port: options.port, openBrowser: options.open, mode: options.mode, setup: options.setup });
}

async function reportSetupCommandError(error: unknown): Promise<void> {
  const { SetupError } = await import("./setup/errors.js");
  console.error(error instanceof SetupError ? error.userMessage : error instanceof Error ? error.message : String(error));
  if (error instanceof SetupError && error.message !== error.userMessage) console.error(`Diagnostics: ${error.message}`);
  process.exitCode = 1;
}

async function runSetupCommand(options: {
  browser?: boolean; dryRun?: boolean; mode?: string; port?: number; open: boolean; tool?: string[]; yes?: boolean;
  force?: boolean;
}): Promise<void> {
  try {
    if (!options.dryRun) showFirstRunNotice();
    if (options.browser) {
      await runBrowserCommand({ ...options, setup: true });
      return;
    }
    const setup = await import("./setup/index.js");
    const result = await setup.runSetup({
      dryRun: options.dryRun,
      mode: options.mode,
      port: options.port,
      openBrowser: options.open,
      ...(options.tool === undefined ? {} : { tools: setup.parseSetupTools(options.tool) }),
      ...(options.yes ? { yes: true } : {}),
      ...(options.force ? { force: true } : {}),
    });
    process.exitCode = result.exitCode;
  } catch (error) {
    await reportSetupCommandError(error);
  }
}

// ── Telemetry hooks ──

const cliTelemetry = createCliTelemetry(captureEvent, flush, undefined, (command) => {
  const { root, discovery } = telemetryProjectLocation(command);
  return getProjectTelemetryContext(root, discovery);
});
program.hook("preAction", (_thisCommand, actionCommand) => {
  let family = actionCommand;
  while (family.parent && family.parent !== program) family = family.parent;
  if (family.name() === "sync" && family.opts().dryRun) return;
  if (cliStarted && !isFirstRunNoticeExemptCommand(family === program ? undefined : family.name())) showFirstRunNotice();
  cliTelemetry.start(actionCommand);
});
program.hook("postAction", async (_thisCommand, actionCommand) => {
  await cliTelemetry.finish(process.exitCode);
  let family = actionCommand;
  while (family.parent && family.parent !== program) family = family.parent;
  // Uninstall must not recreate the launcher or restart pending jobs.
  if (family.name() === "uninstall" || family.name() === "off" || family.name() === "capture" || family.name() === "compact"
    || family.name() === "status" || family.name() === "doctor"
    || (family.name() === "upgrade" && (Number(process.exitCode ?? 0) !== 0 || (!family.opts().apply && !family.opts().finish)))
    || (["install", "sync"].includes(family.name()) && family.opts().dryRun)) return;
  // Keep the hook shim's launcher pointing at this CLI.
  try {
    const { writeLauncher } = await import("./hooks/shim/launcher.js");
    writeLauncher(mexHomeDir());
  } catch { /* never affects the command */ }
  // Restart the background process when jobs are waiting. The marker check opens no database.
  try {
    // Default sync decides whether its own accepted work may continue. A held
    // or paused invocation must not wake an unrelated host's queued judge.
    if (!(family.name() === "sync" && !family.opts().deep) && existsSync(join(mexHomeDir(), "jobs-pending"))) {
      const { restartIfPending } = await import("./record/background.js");
      restartIfPending();
    }
  } catch { /* never affects the command */ }
  if (process.stderr.isTTY && Number(process.exitCode ?? 0) === 0 && !actionCommand.optsWithGlobals().json
    && !["review", "completion", "__background", "__hook-note"].includes(family.name()) && !process.argv.includes("--json")) {
    try {
      const { dailyReviewLine } = await import("./review/daily.js");
      const line = dailyReviewLine({ projectPath: process.cwd() });
      if (line) console.error(line);
    } catch { /* a reminder never affects the command */ }
  }
});

async function runRepoStartCommand(options: { folder?: boolean; wait?: boolean } = {}): Promise<void> {
  try {
    const { runRepoStart } = await import("./repo-start/command.js");
    const result = await runRepoStart({ ...(options.folder ? { folder: true } : {}), ...(options.wait === false ? { wait: false } : {}) });
    process.exitCode = result.exitCode;
    // Stopped waiting with work still running here: the background process has taken it over.
    if (result.exitNow) process.exit(result.exitCode);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

program
  .name("mex")
  .description("Project memory for your agents — run it in a repo to turn MEX on there")
  .version(VERSION)
  .showHelpAfterError()
  // Kept for `mex hub`, which reads them as global options.
  .addOption(new Option("--port <n>", "Bind a specific loopback port (with `mex hub`)").argParser(parsePortArg).hideHelp())
  .addOption(new Option("--no-open", "Print the Hub link without opening a browser (with `mex hub`)").hideHelp())
  .option("--folder", "Turn MEX on in a folder that isn't a git repo, without the question")
  .option("--no-wait", "Show the first screen and leave the file index and git history to the background")
  .action(async (options: { folder?: boolean; wait?: boolean }) => {
    showFirstRunNotice();
    const { showUpdateNotice } = await import("./telemetry/updates.js");
    await showUpdateNotice();
    await runRepoStartCommand(options);
  });

program.command("install")
  .description("Install or update machine-wide agent hooks; no tracked files are edited")
  .option("--dry-run", "List installation changes without writing")
  .option("--json", "Print a machine-readable summary without settings contents")
  .action(async (options: { dryRun?: boolean; json?: boolean }) => {
    try { const { runInstall } = await import("./install/cli.js"); await runInstall(options); }
    catch (error) { console.error((error as Error).message); process.exitCode = 1; }
  });

program.command("uninstall")
  .description("Restore changes made by MEX, keeping data unless --purge is given")
  .option("--dry-run", "List the recorded changes without writing")
  .option("--purge", "Also delete MEX data after hooks are safely removed")
  .option("--json", "Print a machine-readable restoration summary")
  .action(async (options: { dryRun?: boolean; purge?: boolean; json?: boolean }) => {
    try { const { runUninstall } = await import("./install/cli.js"); await runUninstall(options); }
    catch (error) { console.error((error as Error).message); process.exitCode = 1; }
  });

program.command("off")
  .description("Turn MEX off for this registered repo")
  .option("--all", "Turn MEX off everywhere")
  .option("--for <duration>", "Turn back on automatically after a duration such as 2h")
  .option("--json", "Print the saved switch state")
  .action(async (options: { for?: string; all?: boolean; json?: boolean }) => {
    try { const { runCheckoutSwitch } = await import("./controls/cli.js"); runCheckoutSwitch(false, options); }
    catch (error) { console.error((error as Error).message); process.exitCode = 1; }
  });

program.command("on")
  .description("Turn MEX back on for this registered repo")
  .option("--all", "Clear global off; repo and session switches still apply")
  .option("--lever <name>", "Turn a ledger-paused lever back on for a fresh trial")
  .option("--json", "Print the saved switch state")
  .action(async (options: { all?: boolean; lever?: string; json?: boolean }) => {
    try { const { runCheckoutSwitch } = await import("./controls/cli.js"); runCheckoutSwitch(true, options); }
    catch (error) { console.error((error as Error).message); process.exitCode = 1; }
  });

program.command("compact [action]")
  .description("Review, accept, or restore measured host compaction settings")
  .option("--agent <agent>", "Select claude-code or codex")
  .option("--model <model>", "Select a model from measured sessions")
  .option("--scope <scope>", "Write user settings or a Git-ignored repo settings file")
  .option("--choice <choice>", "Choose window, idle, or post-turn")
  .option("--offer <id>", "Accept the exact offer shown by mex compact")
  .option("--json", "Print the offer or outcome as JSON")
  .action(async (action: string | undefined, options) => {
    try { const { runCompact } = await import("./compaction/command.js"); await runCompact(action, options); }
    catch (error) { console.error((error as Error).message); process.exitCode = 1; }
  });

program.command("capture <state>")
  .description("Turn capture off or on without changing delivery")
  .option("--all", "Change capture everywhere")
  .option("--json", "Print the saved capture state")
  .action(async (state: string, options: { all?: boolean; json?: boolean }) => {
    try { const { runCaptureSwitch } = await import("./controls/cli.js"); runCaptureSwitch(state, options); }
    catch (error) { console.error((error as Error).message); process.exitCode = 1; }
  });

program
  .command("hub")
  .description("Show the 0.9 Hub notice; open the Hub in a 0.8 repo")
  .option("--port <n>", "Bind a specific loopback port", parsePortArg)
  .option("--no-open", "Do not open the browser automatically")
  .action(async (_opts: { port?: number; open: boolean }, command: Command) => {
    const opts = command.optsWithGlobals();
    try {
      showFirstRunNotice();
      const { launchHub } = await import("./hub/command.js");
      await launchHub({ port: opts.port, openBrowser: opts.open });
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("capabilities", { hidden: true })
  .description("Inspect installed and currently available machine capabilities")
  .option("--json", "Emit the versioned machine-readable capability manifest")
  .action(async (options: { json?: boolean }) => {
    if (options.json !== true) {
      console.error("mex capabilities requires --json.");
      process.exitCode = 2;
      return;
    }
    const { runCapabilities } = await import("./capabilities.js");
    await runCapabilities();
  });

const teamWorkflowCliService = async () => {
  // Team reads and previews must not backfill scaffold identity. The concrete
  // repository port independently attests that config.json is tracked at the
  // current HEAD before it exposes any Team surface.
  const projectRoot = locateTeamRepositoryRoot();
  const { createRepositoryTeamWorkflowPort } = await import(
    "./team/workflow/repository-team-workflow-port.js"
  );
  return createRepositoryTeamWorkflowPort(projectRoot);
};
const teamIdentityActivityService: TeamIdentityActivityCliServiceFactory = teamWorkflowCliService;
const teamRelayService: TeamRelayCliServiceFactory = teamWorkflowCliService;

for (const command of buildTeamIdentityActivityCommands({
  service: teamIdentityActivityService,
  io: processTeamCommandIo(),
})) {
  program.addCommand(command, { hidden: true });
}
program.addCommand(buildRelayCommand({
  service: teamRelayService,
  io: processTeamCommandIo(),
}), { hidden: true });

// ── Setup: an alias of bare `mex`; the 0.8 flows stay reachable until they are removed ──
const LEGACY_SETUP_FLAGS = ["legacy", "cli", "mode", "dryRun", "tool", "yes", "force"] as const;
const setupCommand = program
  .command("setup")
  .description("Turn MEX on for this repo (the same as `mex`)")
  .addOption(new Option("--legacy", "Run the 0.8 terminal setup").hideHelp())
  .addOption(new Option("--cli", "0.8 terminal setup").hideHelp())
  .addOption(new Option("--browser", "Run the 0.8 setup in the local browser Hub").conflicts(["cli", "dryRun", "tool", "yes", "force", "legacy"]).hideHelp())
  .addOption(new Option("--mode <mode>", "0.8 setup: template mode, code-repo or agent-memory").hideHelp())
  .addOption(new Option("--dry-run", "0.8 setup: show what would happen without making changes").hideHelp())
  .addOption(new Option("--port <n>", "With --browser: bind a specific loopback port").argParser(parsePortArg).hideHelp())
  .addOption(new Option("--no-open", "With --browser: show the Hub link without opening a browser").hideHelp())
  .addOption(new Option("--tool <tool>", "0.8 setup: preselect an AI tool").argParser((value: string, previous: string[] = []) => [...previous, value]).hideHelp())
  .addOption(new Option("--yes", "0.8 setup: never wait on a question").hideHelp())
  .addOption(new Option("--force", "0.8 setup: run the full flow").hideHelp())
  .option("--folder", "Turn MEX on in a folder that isn't a git repo, without the question")
  .option("--no-wait", "Show the first screen and leave the file index and git history to the background")
  .addHelpText(
    "after",
    "\n`mex setup` does what `mex` does: it turns MEX on for this repo and shows what it\n"
      + "found. Next: mex note \"<fact>\" adds a note. Undo: mex off.\n",
  )
  .action(async (_opts, command: Command) => {
    const options = command.optsWithGlobals<Parameters<typeof runSetupCommand>[0] & { legacy?: boolean; cli?: boolean }>();
    if (options.browser || LEGACY_SETUP_FLAGS.some(flag => (options as Record<string, unknown>)[flag] !== undefined)) {
      await runSetupCommand(options);
      return;
    }
    showFirstRunNotice();
    await runRepoStartCommand({ folder: (options as { folder?: boolean }).folder, wait: (options as { wait?: boolean }).wait });
  });

setupCommand
  .command("next")
  .addOption(new Option("--start", "0.8 setup: start a new chat, settling earlier tasks").hideHelp())
  .addOption(new Option("--retry <task>", "0.8 setup: hand an abandoned running task out again (use its printed task id)").hideHelp())
  .description("For your agent: turn MEX on here, print what was found, and the question to put to you")
  .addHelpText(
    "after",
    "\nRun by an agent: it does what `mex` does without asking anything, then prints the\n"
      + "question to put to the person and the exact command to run on yes. Nothing paid starts.\n"
      + "With nothing to ask it says so. The 0.8 one-step setup continues with --start or --retry,\n"
      + "or when a 0.8 setup-next session is already in progress here.\n",
  )
  .action(async (options: { retry?: string; start?: boolean }) => {
    try {
      const { findSetupProjectRoot } = await import("./setup/entry.js");
      const projectRoot = findSetupProjectRoot();
      const { legacySetupNextInProgress, runSetupHandoff } = await import("./repo-start/handoff.js");
      if (options.start || options.retry !== undefined || legacySetupNextInProgress(projectRoot)) {
        const { runSetupNext } = await import("./setup/next.js");
        const result = await runSetupNext({
          ...(options.retry === undefined ? {} : { retry: options.retry }),
          ...(options.start === undefined ? {} : { start: options.start }),
          projectRoot,
          onProgress: (line) => console.error(line),
        });
        console.log(result.output);
        process.exitCode = result.exitCode;
        return;
      }
      process.exitCode = await runSetupHandoff();
    } catch (error) {
      await reportSetupCommandError(error);
    }
  });

// ── Handoff ──
program
  .command("handoff [line...]")
  .description("Hand this branch to a teammate: write .mex/handoffs/<branch>.md with no AI; `mex handoff done` closes it")
  .option("--to <name>", "Who it is for")
  .option("--yes", "Write without asking after the preview")
  .option("--dry-run", "Show the preview only")
  .option("--branch <name>", "With done: the handoff's branch")
  .option("--json", "Print the result as JSON")
  .addHelpText("after", "\nThe handoff holds the branch, uncommitted file names, your last ask, the last failing\ncommand and one optional line of yours. It passes a secret scan and a check for names,\nhosts and emails the repo doesn't already contain. You commit it; MEX never pushes.\nThe next agent session on the branch gets it once. It closes when the branch merges,\nat the receiver's first commit, or with `mex handoff done`.\n")
  .action(async (words: string[], opts: { to?: string; yes?: boolean; dryRun?: boolean; branch?: string; json?: boolean }) => {
    try {
      const { runHandoff } = await import("./knowledge/handoff-cli.js");
      process.exitCode = await runHandoff(words, opts);
    } catch (error) {
      const err = error as { code?: string; message: string };
      if (opts.json) console.log(JSON.stringify({ ok: false, error: { code: err.code ?? "HANDOFF_FAILED", message: err.message } }));
      else console.error(err.message);
      process.exitCode = 1;
    }
  });

// ── Knowledge checks ──
program
  .command("check")
  .description("Check every knowledge entry against the code, plus store gates and conformance; read-only, no AI")
  .option("--json", "Output the report as JSON")
  .option("--diff <base>", "Check this branch against <base> for pre-push and CI; needs no graph and stores nothing")
  .option("--legacy", "Run the 0.8 prose checkers on an old scaffold, without the file-age checks")
  .option("--quiet", "With --legacy: single-line summary only")
  .option("--fix", "With --legacy: run sync to fix any issues found")
  .option("--verbose", "With --legacy: show detailed diagnostic output")
  .action(async (opts) => {
    try {
      if (opts.legacy) {
        await runLegacyCheck(opts);
        return;
      }
      const { runCheck, formatCheck, hasLegacyScaffold } = await import("./knowledge/check.js");
      const report = runCheck({ projectPath: process.cwd(), diff: opts.diff });
      if (opts.json) console.log(JSON.stringify(report));
      else {
        const { realPath } = await import("./record/project.js");
        console.log(formatCheck(report, realPath(process.cwd())));
        if (!report.entries.length && hasLegacyScaffold(process.cwd())) console.log("This repo has a 0.8 scaffold: mex check --legacy checks it.");
      }
      if (!report.ok) process.exitCode = 1;
    } catch (err) {
      if (opts.json) console.log(JSON.stringify({ ok: false, error: { code: (err as { code?: string }).code ?? "CHECK_FAILED", message: (err as Error).message } }));
      else console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

async function runLegacyCheck(opts: { json?: boolean; quiet?: boolean; fix?: boolean; verbose?: boolean }): Promise<void> {
  const config = loadConfig();
  const { runDriftCheckWithGraphStatus } = await import("./drift/index.js");
  const report = await runDriftCheckWithGraphStatus(config, { verbose: opts.verbose, ageChecks: false });

  // An unfinished setup is said first, with the one line that continues it.
  const { describeUnfinishedSetup } = await import("./setup/unfinished.js");
  const unfinished = describeUnfinishedSetup(config.projectRoot);
  if (opts.json) {
    const setup = unfinished === null ? {} : { setup: { done: unfinished.done, total: unfinished.total, finished: false, message: unfinished.line } };
    reportJSON({ ...report, ...setup } as typeof report, { verbose: opts.verbose });
  } else if (opts.quiet) {
    if (unfinished) console.log(unfinished.line);
    reportQuiet(report);
  } else {
    if (unfinished) console.log(`${unfinished.line}
`);
    if (opts.verbose) reportVerbose(report);
    reportConsole(report);
  }

  const hasErrors = report.issues.some((i) => i.severity === "error");
  if (opts.fix && hasErrors) {
    const { runSync } = await import("./sync/index.js");
    await runSync(config, {});
    return;
  }
  if (hasErrors) {
    process.exitCode = 1;
    return;
  }
  maybeShowInvite();
}

// ── Code Graph ──
const graphCommand = program
  .command("graph", { hidden: true })
  .description("Ensure a current code graph: reuse fresh, refresh changed, rebuild missing or unusable")
  .option("--force", "Force a full build (also available as mex graph rebuild)")
  .option("--json", "Output the build summary as JSON")
  .option("--root <dir>", "Project root to index (defaults to current directory)")
  .action(async (opts) => {
    try {
      const { runGraph } = await import("./graph/cli-graph.js");
      await runGraph({ root: opts.root, json: opts.json, force: opts.force });
    } catch (err) {
      const { describeGraphMaintenanceFailure } = await import("./graph/cli-graph.js");
      console.error(describeGraphMaintenanceFailure(err));
      process.exitCode = 1;
      return;
    }
  });

graphCommand
  .command("status")
  .description("Inspect graph freshness without writing or rebuilding")
  .option("--json", "Output the complete graph status as JSON")
  .option("--root <dir>", "Project root to inspect (defaults to current directory)")
  .action(async (opts) => {
    try {
      const { runGraphStatus } = await import("./graph/cli-status.js");
      await runGraphStatus({
        root: opts.root ?? graphCommand.opts().root,
        json: opts.json ?? graphCommand.opts().json,
      });
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
      return;
    }
  });

graphCommand
  .command("refresh")
  .description("Explicitly refresh a compatible graph from the current repository")
  .option("--json", "Output the complete refresh result as JSON")
  .option("--root <dir>", "Project root to refresh (defaults to current directory)")
  .action(async (opts) => {
    try {
      const { runGraphRefresh } = await import("./graph/cli-graph.js");
      await runGraphRefresh({
        root: opts.root ?? graphCommand.opts().root,
        json: opts.json ?? graphCommand.opts().json,
      });
    } catch (err) {
      const { describeGraphMaintenanceFailure } = await import("./graph/cli-graph.js");
      console.error(describeGraphMaintenanceFailure(err));
      process.exitCode = 1;
      return;
    }
  });

graphCommand
  .command("rebuild")
  .description("Rebuild in isolation, validate, and atomically publish the graph")
  .option("--json", "Output the complete rebuild result as JSON")
  .option("--root <dir>", "Project root to rebuild (defaults to current directory)")
  .action(async (opts) => {
    try {
      const { runGraphRebuild } = await import("./graph/cli-graph.js");
      await runGraphRebuild({
        root: opts.root ?? graphCommand.opts().root,
        json: opts.json ?? graphCommand.opts().json,
      });
    } catch (err) {
      const { describeGraphMaintenanceFailure } = await import("./graph/cli-graph.js");
      console.error(describeGraphMaintenanceFailure(err));
      process.exitCode = 1;
      return;
    }
  });

graphCommand
  .command("query <relation> <target>")
  .description("Query who-calls, what-calls, or where-defined by symbol, node id, or indexed file:line")
  .option("--detail <level>", "minimal | standard | source", "minimal")
  .option("--max-nodes <n>", "maximum results to return")
  .option("--max-output-tokens <n>", "hard output token ceiling")
  .option("--max-source-lines <n>", "per-node source line cap (with --detail source)")
  .option("--include-tests", "also return callers/callees in test files when other results exist")
  .action(async (relation, target, options) => {
    const { createGraphCliWriter } = await import("./graph-cli-output.js");
    return import("./graph/cli-agent.js").then(({ runGraphQuery }) => runGraphQuery(relation, target, process.cwd(), { write: createGraphCliWriter() }, options));
  });

graphCommand
  .command("scope <task...>")
  .description("Retrieve source-backed code context and execution flow for a task as JSONL")
  .option("--detail <level>", "minimal | standard | source", "source")
  .option("--max-nodes <n>", "maximum nodes to return")
  .option("--max-files <n>", "maximum source files to return")
  .option("--max-output-tokens <n>", "hard output token ceiling")
  .option("--max-source-lines <n>", "per-node source line cap (with --detail source)")
  .option("--fingerprint", "attach serialized node fingerprints (grounding workflow)")
  .option("--wiki", "also return knowledge entities grounded to the nodes in scope")
  .action(async (task: string[], options) => {
    const { runGraphScope } = await import("./graph/cli-agent.js");
    // Composed here, not imported by the graph. With the flag off there is no
    // provider at all, so the graph's output path is the same code it was
    // before this option existed — which is what makes "byte-identical when
    // off" a structural property rather than a promise.
    const deps = options.wiki === true
      ? await import("./wiki/cli/for-code.js").then(({ knowledgeRecordsFor }) => ({
          knowledgeFor: (nodeIds: readonly string[]): Array<Record<string, unknown>> =>
            knowledgeRecordsFor(nodeIds).map((record) => ({ ...record })),
        }))
      : {};
    const { createGraphCliWriter } = await import("./graph-cli-output.js");
    return runGraphScope(task.join(" "), process.cwd(), { ...deps, write: createGraphCliWriter() }, options);
  });

// ── Wiki ──
//
// P9 owns the full wiki command surface and the JSON envelope. This one command
// exists now because the reverse join is the phase's product claim and a
// library function does not demonstrate it. It is a thin shell over
// `wiki/query/for-code.ts`.
const wikiCommand = program
  .command("wiki", { hidden: true })
  .description("Knowledge-graph commands over the .mex wiki");

/**
 * The scaffold-shaped options every wiki command needs.
 *
 * One resolution, so ten commands cannot disagree about where the scaffold is
 * or which paths are reserved. `wiki.exclude` and `wiki.readOnly` come from
 * config (D10) rather than from flags: a reserved path is a property of the
 * project, not of the invocation.
 */
function wikiIo(): import("./wiki/cli/commands.js").CommandIo {
  // Advertised Wiki reads and previews are non-persisting. In particular,
  // resolving their configuration must never backfill a missing scaffold_id.
  const config = findConfig();
  return {
    write: (line: string) => console.log(line),
    setExitCode: (code: number) => {
      process.exitCode = code;
    },
    scaffoldRoot: config.scaffoldRoot,
    projectRoot: config.projectRoot,
    ...(config.wiki?.exclude === undefined ? {} : { exclude: config.wiki.exclude }),
    ...(config.wiki?.readOnly === undefined ? {} : { readOnly: config.wiki.readOnly }),
    enforceInboxSpecBoundary: true,
  };
}

/**
 * `wikiIo()` plus the code graph, for the commands that resolve groundings
 * (#232): rebuild-index, migrate, apply, reground and regenerate-views.
 *
 * The graph is the repository graph port, the same one the Project Hub hands
 * the Wiki: it opens nothing until a command asks for a snapshot, refuses one
 * that is missing, stale or incompatible, and never maintains the index. The
 * read-only commands keep `wikiIo()` and pay for none of it.
 */
async function groundedWikiIo(): Promise<import("./wiki/cli/commands.js").CommandIo> {
  const base = wikiIo();
  const { createRepositoryGraphPort } = await import("./graph/application-adapter.js");
  return { ...base, groundingBridge: createRepositoryGraphPort(base.projectRoot ?? resolve(base.scaffoldRoot, ".."), { candidateExecution: "process" }) };
}

/** The §15.1 filters, added to whichever commands they apply to. */
function withReadFilters(command: Command): Command {
  return command
    .option("--type <type>", "only entities of this type")
    .option("--topic <id-or-alias>", "only entities in this topic")
    .option("--status <status>", "only entities in this lifecycle state")
    .option("--health <health>", "only entities whose worst grounding health is this")
    .option("--limit <n>", "maximum records to return; clamped, never unbounded")
    .option("--include-archived", "include archived entities, which are excluded by default")
    .option("--json", "emit one enveloped JSON object instead of JSONL records");
}

withReadFilters(wikiCommand.command("list").description("Entities in this scaffold, bounded")).action(
  async (options) => {
    const { runList } = await import("./wiki/cli/commands.js");
    runList(wikiIo(), options);
  },
);

wikiCommand
  .command("show <id>")
  .description("One entity, with its body")
  .option("--no-body", "omit the entity body")
  .option("--json", "emit one enveloped JSON object")
  .action(async (id: string, options) => {
    const { runShow } = await import("./wiki/cli/commands.js");
    runShow(wikiIo(), id, options);
  });

withReadFilters(wikiCommand.command("query <text...>").description("Search the Wiki by words: entities with every term first, title before body, then entities matching some terms, labelled")).action(
  async (text: string[], options) => {
    const { runQuery } = await import("./wiki/cli/commands.js");
    runQuery(wikiIo(), text.join(" "), options);
  },
);

withReadFilters(wikiCommand.command("related <id>").description("The bounded neighbourhood around an entity"))
  .option("--depth <n>", "traversal depth; clamped")
  .option("--max-tokens <n>", "token budget for the neighbourhood")
  .action(async (id: string, options) => {
    const { runRelated } = await import("./wiki/cli/commands.js");
    runRelated(wikiIo(), id, options);
  });

withReadFilters(wikiCommand.command("backlinks <id>").description("Entities that point at this one")).action(
  async (id: string, options) => {
    const { runBacklinks } = await import("./wiki/cli/commands.js");
    runBacklinks(wikiIo(), id, options);
  },
);

wikiCommand
  .command("validate")
  .description("Check Wiki structure (ids, relations, evidence, anchors); code links are checked by `mex check`")
  .option("--limit <n>", "maximum diagnostics to report")
  .option("--json", "emit one enveloped JSON object")
  .action(async (options) => {
    const { runValidate } = await import("./wiki/cli/commands.js");
    await runValidate(wikiIo(), options);
  });

withReadFilters(wikiCommand.command("graph").description("A bounded slice of the relation graph")).action(
  async (options) => {
    const { runGraph } = await import("./wiki/cli/commands.js");
    runGraph(wikiIo(), options);
  },
);

wikiCommand
  .command("rebuild-index")
  .description("Rebuild the disposable index; the only command that creates it")
  .option("--json", "emit one enveloped JSON object")
  .action(async (options) => {
    const { runRebuildIndex } = await import("./wiki/cli/commands.js");
    await runRebuildIndex(await groundedWikiIo(), options);
  });

wikiCommand
  .command("regenerate-views")
  .description("Rewrite generated sections that have drifted; --dry-run reports only")
  .option("--dry-run", "report what has drifted and write nothing")
  .option("--json", "emit one enveloped JSON object")
  .action(async (options) => {
    const { runRegenerateViews } = await import("./wiki/cli/commands.js");
    await runRegenerateViews(await groundedWikiIo(), options);
  });

wikiCommand
  .command("migrate")
  .description("Convert a pre-wiki scaffold; --dry-run writes nothing and mints no id")
  .option("--dry-run", "report what would happen and write nothing")
  .option("--json", "emit one enveloped JSON object")
  .action(async (options) => {
    const { runMigrate } = await import("./wiki/cli/commands.js");
    await runMigrate(await groundedWikiIo(), options);
  });

wikiCommand
  .command("apply <operation-file>")
  .description("Plan one operation or an all-or-nothing batch from a JSON file; writes only with --apply")
  .option("--apply", "write the change, rather than only planning it")
  .option("--dry-run", "plan only, even if --apply was given")
  .option("--json", "emit one enveloped JSON object")
  .addHelpText("after", WIKI_APPLY_HELP)
  .action(async (file: string, options) => {
    const { runApply } = await import("./wiki/cli/commands.js");
    await runApply(await groundedWikiIo(), file, options);
  });

wikiCommand
  .command("reground <entity-id>")
  .description("Re-record an entity's code links after review confirms its text still holds; writes only with --apply")
  .option("--apply", "write the re-recorded links, rather than only planning them")
  .option("--reason <text>", "why the links are re-recorded, kept in the operation log")
  .option("--json", "emit one enveloped JSON object")
  .action(async (id: string, options) => {
    const { runReground } = await import("./wiki/cli/commands.js");
    await runReground(await groundedWikiIo(), id, options);
  });

wikiCommand
  .command("link-sections")
  .description("Connect existing knowledge sections to their enclosing knowledge; writes only with --apply")
  .option("--apply", "write the planned structural relationships")
  .option("--dry-run", "plan only, even if --apply was given")
  .option("--json", "emit one enveloped JSON object")
  .action(async (options) => {
    const { runLinkSections } = await import("./wiki/cli/commands.js");
    await runLinkSections(await groundedWikiIo(), options);
  });

wikiCommand
  .command("upgrade")
  .description("Preview an existing scaffold's review for one code-linked fact per entity; --apply starts an interactive agent")
  .option("--apply", "start the explicit agent review, rather than preview only")
  .option("--dry-run", "preview only, even if --apply was given")
  .option("--after <entity-id>", "resume bounded review after an existing entity id")
  .option("--tool <name>", "optional interactive CLI override; otherwise uses the same agent chooser as mex sync --deep")
  .action(async (options) => {
    const { runKnowledgeUpgrade } = await import("./sync/knowledge-upgrade.js");
    await runKnowledgeUpgrade(loadConfig(), options);
  });

/**
 * The synthesis wiring: the code graph, and an agent launcher.
 *
 * Composed here rather than imported anywhere under `src/wiki/`, for the same
 * reason `knowledgeFor` is (handoff §39.7): a `src/graph/` to `src/wiki/`
 * import would be a genuine cycle, and injection makes "synthesis does nothing
 * without a graph" a structural property rather than a promise. Everything
 * below is lazily imported so a `mex check` pays none of it.
 */
async function synthesisIo(): Promise<import("./wiki/cli/commands.js").CommandIo> {
  const base = wikiIo();
  const config = findConfig();

  const [
    { createRepositoryGraphPort },
    { AI_TOOLS },
    { isCliAvailable },
    { runToolInteractive },
  ] = await Promise.all([
    import("./graph/application-adapter.js"),
    import("./types.js"),
    import("./cli-tools.js"),
    import("./sync/index.js"),
  ]);

  return {
    ...base,
    repoRoot: config.projectRoot,
    synthesisBridge: createRepositoryGraphPort(config.projectRoot, { candidateExecution: "process" }),
    ...(config.wiki?.synthesis === undefined ? {} : { synthesisScope: config.wiki.synthesis }),
    launchAgent: (playbook: string) => {
      // mex's own launcher, not a second one: six tools, cross-platform
      // detection, and the Windows shim handling that issue #85 paid for.
      // The configured tools first, then whatever else is installed. No
      // interactive question: an agent-facing command that stopped to ask which
      // CLI to use would hang the run it was supposed to start.
      const candidates = [...config.aiTools, ...(Object.keys(AI_TOOLS) as import("./types.js").AiTool[])];
      for (const tool of candidates) {
        const meta = AI_TOOLS[tool];
        if (meta.cli === null || !isCliAvailable(meta.cli)) continue;
        return runToolInteractive(tool, playbook, config.projectRoot);
      }
      return false;
    },
  };
}

wikiCommand
  .command("build")
  .description("Discover clusters and hand an agent the synthesis playbook")
  .option("--cluster <name>", "restrict the run to one cluster")
  .option("--print", "print the playbook rather than launching an agent")
  .option("--json", "emit one enveloped JSON object; never launches an agent")
  .action(async (options) => {
    const { runBuild } = await import("./wiki/cli/commands.js");
    await runBuild(await synthesisIo(), { ...options, print: options.print === true || options.json === true });
  });

wikiCommand
  .command("prepare")
  .description("The deterministic scope and prompt for one synthesis stage")
  .option("--stage <stage>", "architecture_component | pattern | convention | global | relationships")
  .option("--cluster <name>", "which cluster, for the per-cluster stages")
  .option("--json", "emit one enveloped JSON object")
  .action(async (options) => {
    const { runPrepare } = await import("./wiki/cli/commands.js");
    await runPrepare(await synthesisIo(), options);
  });

wikiCommand
  .command("propose <response-file>")
  .description("Validate an agent's synthesis response into operation plans; writes only with --apply")
  .option("--apply", "write the changes, rather than only planning them")
  .option("--dry-run", "plan only, even if --apply was given")
  .option("--stage <stage>", "the stage this response answers, when the file does not say")
  .option("--cluster <name>", "the cluster this response is for, when the file does not say")
  .option("--json", "emit one enveloped JSON object")
  .action(async (file: string, options) => {
    const { runPropose } = await import("./wiki/cli/commands.js");
    await runPropose(await synthesisIo(), file, options);
  });

wikiCommand
  .command("for-code <nodeId...>")
  .description("Knowledge entities grounded to the given code-graph node ids, with the link health `mex check` reports")
  .option("--json", "Emit one enveloped JSON object instead of JSONL records")
  .option("--limit <n>", "maximum entities to return")
  .option("--include-archived", "include archived entities, which are excluded by default")
  .action(async (nodeIds: string[], options) => {
    const { runWikiForCode } = await import("./wiki/cli/for-code.js");
    runWikiForCode(nodeIds, process.cwd(), {
      json: options.json === true,
      limit: options.limit === undefined ? undefined : Number(options.limit),
      includeArchived: options.includeArchived === true,
    });
  });

graphCommand
  .command("get <id...>")
  .description("Expand source for specific node ids as JSONL")
  .option("--detail <level>", "source (get always returns source)", "source")
  .option("--max-source-lines <n>", "per-node source line cap")
  .option("--max-output-tokens <n>", "hard output token ceiling")
  .action(async (ids: string[], options) => {
    const { createGraphCliWriter } = await import("./graph-cli-output.js");
    return import("./graph/cli-agent.js").then(({ runGraphGet }) => runGraphGet(ids, process.cwd(), { write: createGraphCliWriter() }, options));
  });

graphCommand
  .command("repair")
  .description("Repair a recognized graph through a locked, validated candidate")
  .option("--json", "Output the complete repair result as JSON")
  .option("--root <dir>", "Project root (defaults to current directory)")
  .action(async (opts) => {
    try {
      const { runGraphRepair } = await import("./graph/cli-graph.js");
      process.exitCode = await runGraphRepair({
        root: opts.root ?? graphCommand.opts().root,
        json: opts.json ?? graphCommand.opts().json,
      });
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
      return;
    }
  });

graphCommand
  .command("ground")
  .description("Retro-ground an existing pre-0.7 scaffold using the code graph")
  .option("--dry-run", "Print the migration prompt without launching an agent")
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const { runGraphGround } = await import("./graph/cli-ground.js");
      const { wikiGroundingDocumentReader } = await import("./wiki/grounding/document-reader.js");
      await runGraphGround(config, opts, { documentReader: wikiGroundingDocumentReader });
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
      return;
    }
  });

graphCommand
  .command("compact-fingerprints")
  .description("Re-encode committed grounding fingerprints in the compact mh2: format; needs no graph")
  .option("--dry-run", "Report what would change without writing")
  .option("--json", "Output the result as JSON")
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const { runCompactFingerprints } = await import("./fingerprint-compaction.js");
      runCompactFingerprints(config, {
        dryRun: opts.dryRun === true,
        json: opts.json ?? graphCommand.opts().json,
      });
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
      return;
    }
  });

program
  .command("impact <target>", { hidden: true })
  .description("Show transitive code and scaffold blast radius for a symbol, node id, file, or indexed file:line")
  .addOption(new Option("--direction <direction>", "proven call edges: callers (default), callees, or both").choices(["callers", "callees", "both"]))
  .option("--detail <level>", "minimal | standard | source", "minimal")
  .option("--depth <n>", "transitive call-edge depth", "2")
  .option("--max-nodes <n>", "maximum impacted nodes to return")
  .option("--max-output-tokens <n>", "hard output token ceiling")
  .option("--max-source-lines <n>", "per-node source line cap (with --detail source)")
  .option("--include-tests", "also return impacted nodes in test files when other results exist")
  .action(async (target, options) => {
    const { createGraphCliWriter } = await import("./graph-cli-output.js");
    return import("./graph/cli-agent.js").then(({ runImpact }) => runImpact(target, process.cwd(), { write: createGraphCliWriter() }, options));
  });

// ── Knowledge entries ──
for (const command of buildKnowledgeCommands()) program.addCommand(command);
program.addCommand(buildUpgradeCommand({ afterUpgrade: showFirstRunNotice }));

// ── File index ──
const indexCommand = program
  .command("index", { hidden: true })
  .description("Build or refresh this checkout's file index now (outlines, names and pattern counts per file)")
  .option("--full", "Read every file again instead of only the changed ones")
  .option("--workers <n>", "Worker threads (0 runs in this process)", (value) => Number(value))
  .option("--json", "Print the build summary as JSON")
  .action(async (options: { full?: boolean; workers?: number; json?: boolean }) => {
    try {
      const { runIndexBuild } = await import("./file-index/command.js");
      await runIndexBuild(options);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });
indexCommand
  .command("status")
  .description("When this checkout's index was built and how many files it covers")
  .option("--json", "Print as JSON")
  .action(async (options: { json?: boolean }) => {
    try {
      const { runIndexStatus } = await import("./file-index/command.js");
      await runIndexStatus(options);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });
indexCommand
  .command("outline <file>")
  .description("Show a file's symbols with their current line numbers")
  .option("--json", "Print as JSON")
  .action(async (file: string, options: { json?: boolean }) => {
    try {
      const { runIndexOutline } = await import("./file-index/command.js");
      await runIndexOutline(file, options);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

// ── Saved output ──
program
  .command("out [number]")
  .description("Show the full output MEX saved when it shortened a command's output; with no number, list them")
  .option("--grep <pattern>", "Only the lines matching this pattern (a regular expression), with line numbers")
  .option("-i, --ignore-case", "Match --grep without regard to case")
  .option("-C, --context <n>", "Lines of context around each --grep match", parseIntArg)
  .option("--json", "Print as JSON")
  .action(async (number: string | undefined, options: { grep?: string; ignoreCase?: boolean; context?: number; json?: boolean }) => {
    try {
      const { runOut } = await import("./output/command.js");
      process.exitCode = runOut(number, options);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("run")
  .description("Run a command the way the Codex wrapper does: print it, run it, keep its exit code, shorten long successful output")
  .requiredOption("--shell <shell>", "bash, zsh, sh, powershell or pwsh")
  .argument("<command>", "The exact command, as one argument after --")
  .action(async (command: string, options: { shell: string }) => {
    const { runWrapped } = await import("./output/run.js");
    process.exitCode = runWrapped(options.shell, command);
  });

// ── Background jobs ──
const jobsCommand = program
  .command("jobs")
  .description("List MEX's background jobs on this machine; pause, resume or cancel one")
  .option("--json", "Print the jobs as JSON")
  .option("--all", "Include older jobs")
  .action(async (options: { json?: boolean; all?: boolean }) => {
    try {
      const { runJobsList } = await import("./record/jobs-command.js");
      runJobsList(options);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });
for (const action of ["pause", "resume", "cancel"] as const) {
  jobsCommand
    .command(`${action} <number>`)
    .description(`${action[0]!.toUpperCase()}${action.slice(1)} a job, by its number in \`mex jobs\``)
    .action(async (position: string) => {
      try {
        const { runJobsAction } = await import("./record/jobs-command.js");
        runJobsAction(action, position);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });
}
jobsCommand
  .command("run")
  .description("Run waiting jobs in this terminal (when the background process is off)")
  .option("--minutes <n>", "Stop after this many minutes", (value) => Number(value))
  .action(async (options: { minutes?: number }) => {
    try {
      const { runJobsHere } = await import("./record/jobs-command.js");
      await runJobsHere(options);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });
if (process.env.MEX_JOBS_DEMO === "1") {
  jobsCommand
    .command("demo", { hidden: true })
    .description("Queue a demo job for this folder (demos and tests only)")
    .option("--batches <n>", "Number of batches", (value) => Number(value))
    .option("--delay <ms>", "Delay per batch", (value) => Number(value))
    .option("--fail-at <n>", "Fail at this batch (0-based)", (value) => Number(value))
    .option("--wait-file <path>", "Wait while this file exists")
    .option("--trace-file <path>", "Append each batch start here")
    .action(async (options: { batches?: number; delay?: number; failAt?: number; waitFile?: string; traceFile?: string }) => {
      const { runJobsDemo } = await import("./record/jobs-command.js");
      runJobsDemo(options);
    });
}

program.command("status", { hidden: true })
  .description("Show agents, notes, background work and model use")
  .option("--json", "Print the same status as an object")
  .action(async (options: { json?: boolean }) => {
    const { runStatus } = await import("./status.js");
    runStatus(options);
  });

program
  .command("doctor")
  .description("Show MEX status and fixes for recorded problems")
  .option("--json", "Print status and problems as an object")
  .option("--legacy", "Run the 0.8 scaffold diagnostic")
  .action(async (options: { json?: boolean; legacy?: boolean }) => {
    try {
      const { runDoctor, runStatusDoctor } = await import("./doctor.js");
      if (options.legacy) await runDoctor(loadConfig());
      else runStatusDoctor(options);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
      return;
    }
  });

// ── Knowledge freshness ──
program
  .command("sync")
  .description("Run the knowledge judge now; use --deep for the interactive AI sync session")
  .option("--deep", "Run the legacy drift check and interactive AI session")
  .option("--dry-run", "Show what would be synced without executing")
  .option("--warnings", "With --deep: include warning-only files")
  .action(async (opts) => {
    try {
      if (opts.deep) {
        const { runSync } = await import("./sync/index.js");
        await runSync(opts.dryRun ? findConfig() : loadConfig(), { dryRun: opts.dryRun, includeWarnings: opts.warnings });
      } else {
        if (opts.warnings) throw new Error("Use `mex sync --deep --warnings` to include legacy warning-only files.");
        const { runJudgeSync } = await import("./judge/sync.js");
        const job = await runJudgeSync({ projectPath: process.cwd(), dryRun: opts.dryRun });
        if (job?.state === "failed") process.exitCode = 1;
      }
      if (!opts.dryRun) maybeShowInvite();
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
      return;
    }
  });

program
  .command("completion <shell>", { hidden: true })
  .description("Print shell completion script for bash, zsh, or fish")
  .action((shell) => {
    try {
      console.log(buildCompletion(shell));
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
      return;
    }
  });

// ── Telemetry ──
const telemetryCmd = program
  .command("telemetry")
  .description("Telemetry transparency commands, including the opt-out")
  .addHelpText(
    "after",
    "\nOpting out:\n"
      + "  mex telemetry disable   Turn telemetry off for every project (~/.mex/config.json)\n"
      + "  mex telemetry off       The same opt-out, with a shorter name\n"
      + "  DO_NOT_TRACK=1          Standard cross-tool opt-out, honoured per invocation\n"
      + "  MEX_TELEMETRY=0         mex-specific env opt-out, honoured per invocation\n"
      + "  MEX_OFFLINE=1           Stop telemetry and update fetching\n"
      + "\nEnvironment variables win over the stored setting. `mex telemetry status`\n"
      + "reports which one is in effect.\n",
  );

/** Explain an opt-out reason in terms of the thing the user would have to change. */
function describeTelemetryReason(reason: string | undefined): string {
  switch (reason) {
    case "DO_NOT_TRACK":
      return "The DO_NOT_TRACK environment variable is set to 1.";
    case "MEX_TELEMETRY":
      return "The MEX_TELEMETRY environment variable is set to 0.";
    case "MEX_OFFLINE":
      return "MEX_OFFLINE=1 stops telemetry and update fetching.";
    case "dev":
      return "This is a mex development checkout; telemetry never runs from one.";
    case "config":
      return "A stored global preference or opt-out marker disables telemetry. Re-enable with `mex telemetry enable`.";
    case "config_unavailable":
      return "The existing global preference file is unreadable, malformed, or unsafe. Telemetry stays off until that file is repaired.";
    default:
      return "";
  }
}

/**
 * `telemetry disable` / `enable` write the same `~/.mex/config.json` key as
 * `mex config set telemetry off|on`.
 *
 * The duplication is the point. Issue #110 reported reaching for
 * `mex telemetry disable`, getting `unknown command`, and then guessing at env
 * var names — because the only switch lived under `config`, which is not where
 * anyone looks for it. An alias costs nothing; a user who cannot find the
 * opt-out costs trust.
 */
function disableTelemetryWithNotice(): void {
  const result = disableTelemetry();
  if (!result.purged) console.log("Telemetry is off; the local queue could not be cleared because it is busy or unavailable.");
}

function setTelemetryEnabled(enabled: boolean): void {
  try {
    if (enabled) enableTelemetry();
    else disableTelemetryWithNotice();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  console.log(`Telemetry ${enabled ? "enabled" : "disabled"} in ~/.mex/config.json`);

  // Never claim an outcome the next invocation will contradict: an env opt-out
  // outranks the stored value, and a dev checkout outranks both.
  const active = isEnabled();
  if (active.enabled !== enabled) {
    const detail = describeTelemetryReason(active.reason);
    console.log(
      active.enabled
        ? "Telemetry is still on for this project."
        : `Telemetry stays off regardless of this setting. ${detail}`.trim(),
    );
  }
}

telemetryCmd
  .command("disable")
  .alias("off")
  .description("Turn telemetry off for every project (writes ~/.mex/config.json)")
  .action(() => setTelemetryEnabled(false));

telemetryCmd
  .command("enable")
  .alias("on")
  .description("Turn telemetry back on for every project")
  .action(() => setTelemetryEnabled(true));

telemetryCmd
  .command("inspect")
  .description("Inspect pending and sent usage reports, privacy fields, and limits without sending")
  .action(() => {
    try {
      console.log(JSON.stringify(getTelemetryInspection(), null, 2));
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
      return;
    }
  });

telemetryCmd
  .command("status")
  .description("Show whether telemetry is enabled and the active opt-out reason")
  .action(() => {
    const result = isEnabled();
    if (result.enabled) {
      console.log("Telemetry: enabled");
      console.log("Turn it off with `mex telemetry off`, DO_NOT_TRACK=1, MEX_TELEMETRY=0, or MEX_OFFLINE=1.");
      return;
    }
    console.log(`Telemetry: disabled (reason: ${result.reason})`);
    const detail = describeTelemetryReason(result.reason);
    if (detail) console.log(detail);
  });

// ── Config ──
const configCmd = program
  .command("config")
  .description("Manage mex configuration");

configCmd
  .command("set <key> <value>")
  .description("Set a config value (e.g. learning.statements on|off, telemetry on|off)")
  .option("--project", "Set delivery.scorer, delivery.surface.<id> or learning.sharing for the registered project")
  .action(async (key: string, value: string, options: { project?: boolean }) => {
    try {
      if (options.project && !["delivery.scorer", "learning.sharing"].includes(key) && !key.startsWith("delivery.surface.")) throw new Error("--project is supported for delivery.scorer, delivery.surface.<id> and learning.sharing.");
      if (key.startsWith("delivery.surface.")) {
        const { openRecord } = await import("./record/index.js");
        const { setDeliverySurface } = await import("./controls/index.js");
        const writer = openRecord();
        try { setDeliverySurface(writer, key.slice(17), value, options.project ? process.cwd() : undefined); } finally { writer.close(); }
        console.log("Delivery surface set to " + value + ".");
      } else if (key === "learning.sharing") {
        if (!options.project) throw new Error("Use --project to set learning.sharing for this repository.");
        if (!["automatic", "manual"].includes(value)) throw new Error("Use automatic or manual for learning.sharing.");
        const { openRecord } = await import("./record/index.js");
        const { setLearningSharing } = await import("./controls/index.js");
        const writer = openRecord();
        try { setLearningSharing(writer, value, process.cwd()); } finally { writer.close(); }
        console.log(value === "manual" ? "Learned notes stay personal until mex share." : "Eligible learned notes can reach this shared repository after their diff is shown.");
      } else if (key === "learning.statements") {
        if (value !== "on" && value !== "off") throw new Error("Use on or off for learning.statements.");
        const { openRecord } = await import("./record/index.js");
        const writer = openRecord({ create: true });
        try {
          writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES('global','learning.statements',?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(value);
        } finally { writer.close(); }
        console.log(value === "on"
          ? "MEX now learns lasting statements from what you type, in the background with your agent's smallest model, at most 3% of your usage. Turn off: mex config set learning.statements off"
          : "MEX no longer learns from what you type. Notes you save with mex note still get their checks.");
      } else if (key === "delivery.aliases") {
        const { openRecord } = await import("./record/index.js");
        const { setDeliveryAliases } = await import("./controls/index.js");
        if (value !== "on" && value !== "off") throw new Error("Use on or off for delivery.aliases.");
        const writer = openRecord();
        try { setDeliveryAliases(writer, value); } finally { writer.close(); }
        console.log("Typed-prompt ranking " + (value === "on" ? "now uses" : "no longer uses") + " entries' aliases and asks.");
      } else if (key === "delivery.scorer") {
        const { openRecord } = await import("./record/index.js");
        const { setDeliveryScorer } = await import("./controls/index.js");
        if (!["tiers", "bm25", "fcfs", "risk"].includes(value)) throw new Error("Use tiers, bm25, fcfs or risk for delivery.scorer.");
        const writer = openRecord();
        try { setDeliveryScorer(writer, value, options.project ? process.cwd() : undefined); } finally { writer.close(); }
        console.log("Delivery scorer set to " + value + (options.project ? " for this project." : " for this machine."));
      } else if (key === "telemetry") {
        if (value !== "on" && value !== "off") {
          console.error(`Invalid value "${value}" for telemetry. Use "on" or "off".`);
          process.exitCode = 1;
          return;
        }
        if (value === "off") disableTelemetryWithNotice();
        else enableTelemetry();
        console.log(`Telemetry set to "${value}" in ~/.mex/config.json`);
      } else if (key === "feedback") {
        if (value !== "on" && value !== "off") {
          console.error(`Invalid value "${value}" for feedback. Use "on" or "off".`);
          process.exitCode = 1;
          return;
        }
        // "off" hides the invite; "on" re-enables it.
        if (value === "off") dismissInvite();
        else enableInvite();
        console.log(`Feedback invite ${value === "off" ? "hidden" : "re-enabled"}.`);
      } else {
        console.error(`Unknown config key "${key}". Supported keys: telemetry, feedback, learning.statements, delivery.scorer, delivery.surface.<id>, learning.sharing, delivery.aliases`);
        process.exitCode = 1;
        return;
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
      return;
    }
  });

// ── Feedback ──
program
  .command("feedback")
  .description("Open the mex feedback form (the maintainer is doing user research calls)")
  .action(() => {
    runFeedback();
  });

// Commander 13 has no help groups. Order its visible command projection as a short manual.
const publicRank = (name: string) => {
  const rank = (PUBLIC_COMMAND_ORDER as readonly string[]).indexOf(name);
  return rank < 0 ? PUBLIC_COMMAND_ORDER.length : rank;
};
const visibleCommands = program.createHelp().visibleCommands;
program.configureHelp({
  visibleCommands(command) {
    const commands = visibleCommands.call(this, command);
    return command === program ? commands.sort((a, b) => publicRank(a.name()) - publicRank(b.name())) : commands;
  },
});
const publicDescriptions: Record<string, string> = {
  install: "Install hooks for Claude Code and Codex on this machine",
  uninstall: "Restore agent settings; keep notes unless --purge is given",
  note: "Save a personal note and why it matters",
  recall: "Find a note by words, without a model call",
  expand: "Read a note, its source and its checks",
  edit: "Correct a note; preview changes to team entries",
  wrong: "Retire an incorrect note and keep the reason",
  forget: "Remove a note from future sessions",
  check: "Check which notes still hold against the code",
  review: "Review learned notes before sharing them",
  share: "Share notes and rule files through a reviewed git branch",
  rules: "Read agent rule files and show lines that need review",
  handoff: "Leave a branch handoff for a teammate",
  upgrade: "Preview the upgrade from 0.8; apply after review",
  what: "Show what MEX gave or held back this session",
  brief: "Preview what a new session will receive",
  config: "Change MEX settings",
  telemetry: "Inspect anonymous usage counts or turn them off",
  feedback: "Open the feedback form",
};
for (const command of program.commands) if (publicDescriptions[command.name()]) command.description(publicDescriptions[command.name()]);

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
// Refuse unsupported Node before any command runs, so it cannot fail halfway.
export function runCli(): void {
  cliStarted = true;
  const unsupportedNode = unsupportedNodeMessage(process.versions.node);
  if (unsupportedNode !== null) {
    console.error(unsupportedNode);
    process.exitCode = 1;
  } else {
    const removed = removedCommandMessage(process.argv.slice(2));
    if (removed !== null) {
      console.error(removed);
      process.exitCode = 1;
      return;
    }
    const commandArgv = process.argv.slice(2);
    const teamJsonContext = inspectTeamJsonInvocation(commandArgv);
    if (teamJsonContext !== null && hasMissingTeamApplyValue(commandArgv)) {
      emitTeamJsonParseProblem(teamJsonContext);
    } else if (isInvalidCapabilitiesJsonInvocation(commandArgv)) {
      console.log(JSON.stringify(capabilitiesInvalidRequestEnvelope()));
      process.exitCode = 2;
    } else {
      if (teamJsonContext !== null) {
        configureTeamJsonParseErrors(program);
      }
      program.parseAsync().catch((err: Error) => {
        if (teamJsonContext !== null) {
          emitTeamJsonParseProblem(teamJsonContext);
          return;
        }
        console.error(err.message);
        process.exitCode = 1;
      }).finally(() => cliTelemetry.finish(process.exitCode));
    }
  }
}

if (isMainModule) runCli();

interface TeamJsonInvocationContext {
  command: TeamCliCommandName;
  mode: TeamCliMode;
}

function inspectTeamJsonInvocation(argv: readonly string[]): TeamJsonInvocationContext | null {
  if (!argv.includes("--json") || argv.includes("--help") || argv.includes("-h")) return null;
  const family = argv[0];
  if (family !== "member" && family !== "activity" && family !== "workstream" && family !== "inbox" && family !== "relay" && family !== "spec") return null;
  const leaf = argv[1];
  const applyRequested = argv.some((value) => value === "--apply" || value.startsWith("--apply="));
  if (family === "member") {
    if (leaf === "list" || leaf === "show" || leaf === "current") {
      return { command: `member.${leaf}`, mode: "read" };
    }
    if (leaf === "add" || leaf === "update" || leaf === "deactivate" || leaf === "select") {
      return {
        command: `member.${leaf}`,
        mode: applyRequested ? "apply" : "preview",
      };
    }
    return { command: "member", mode: "read" };
  }
  if (family === "activity" && (leaf === "list" || leaf === "show")) {
    return { command: `activity.${leaf}`, mode: "read" };
  }
  if (family === "activity" && leaf === "record") {
    return { command: "activity.record", mode: applyRequested ? "apply" : "preview" };
  }
  if (family === "activity") return { command: "activity", mode: "read" };
  if (family === "workstream") {
    if (leaf === "list" || leaf === "show") {
      return { command: `workstream.${leaf}`, mode: "read" };
    }
    if (leaf === "create" || leaf === "update" || leaf === "archive") {
      return {
        command: `workstream.${leaf}`,
        mode: applyRequested ? "apply" : "preview",
      };
    }
    return { command: "workstream", mode: "read" };
  }
  if (family === "inbox") {
    const group = argv[1];
    const nestedLeaf = argv[2];
    if (group === "contract") return { command: "inbox.contract", mode: "read" };
    if (group === "draft") {
      if (nestedLeaf === "list" || nestedLeaf === "show") {
        return { command: `inbox.draft.${nestedLeaf}`, mode: "read" };
      }
      if (nestedLeaf === "save" || nestedLeaf === "delete") {
        return {
          command: `inbox.draft.${nestedLeaf}`,
          mode: applyRequested ? "apply" : "preview",
        };
      }
      return { command: "inbox.draft", mode: "read" };
    }
    if (group === "proposal") {
      if (nestedLeaf === "list" || nestedLeaf === "show") {
        return { command: `inbox.proposal.${nestedLeaf}`, mode: "read" };
      }
      if (["approve", "reject", "withdraw", "mark-stale", "repair"].includes(nestedLeaf ?? "")) {
        return {
          command: `inbox.proposal.${nestedLeaf}` as TeamCliCommandName,
          mode: applyRequested ? "apply" : "preview",
        };
      }
      return { command: "inbox.proposal", mode: "read" };
    }
    if (group === "publish") {
      return { command: "inbox.publish", mode: applyRequested ? "apply" : "preview" };
    }
    return { command: "inbox", mode: "read" };
  }
  if (family === "relay") {
    const group = argv[1];
    const nestedLeaf = argv[2];
    if (group === "contract") return { command: "relay.contract", mode: "read" };
    if (group === "draft") {
      if (nestedLeaf === "list" || nestedLeaf === "show") {
        return { command: `relay.draft.${nestedLeaf}`, mode: "read" };
      }
      if (nestedLeaf === "save" || nestedLeaf === "delete") {
        return {
          command: `relay.draft.${nestedLeaf}`,
          mode: applyRequested ? "apply" : "preview",
        };
      }
      return { command: "relay.draft", mode: "read" };
    }
    if (group === "list" || group === "show") {
      return { command: `relay.${group}`, mode: "read" };
    }
    if (group === "publish" || group === "acknowledge" || group === "close") {
      return {
        command: `relay.${group}`,
        mode: applyRequested ? "apply" : "preview",
      };
    }
    return { command: "relay", mode: "read" };
  }
  if (leaf === "list" || leaf === "show") {
    return { command: `spec.${leaf}`, mode: "read" };
  }
  return { command: "spec", mode: "read" };
}

function configureTeamJsonParseErrors(root: Command): void {
  const visit = (command: Command): void => {
    command.exitOverride();
    command.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    for (const child of command.commands) visit(child);
  };
  visit(root);
}

function hasMissingTeamApplyValue(argv: readonly string[]): boolean {
  return argv.some((value, index) => (
    value === "--apply"
    && (argv[index + 1] === undefined || argv[index + 1]!.startsWith("-"))
  ));
}

function emitTeamJsonParseProblem(context: TeamJsonInvocationContext): void {
  const envelope = teamProblemEnvelope(
    context.command,
    context.mode,
    new TeamCliUsageError("The Team command arguments are invalid. Review the command help and retry."),
  );
  console.log(renderTeamEnvelope(envelope));
  process.exitCode = exitCodeForTeamEnvelope(envelope);
}

function isInvalidCapabilitiesJsonInvocation(argv: readonly string[]): boolean {
  return argv[0] === "capabilities"
    && argv.includes("--json")
    && !argv.includes("--help")
    && !argv.includes("-h")
    && (argv.length !== 2 || argv[1] !== "--json");
}

function buildCompletion(shell: string): string {
  const commands = [...PUBLIC_COMMAND_ORDER];
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
