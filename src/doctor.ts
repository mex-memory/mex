import { existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import type { MexConfig } from "./types.js";
import { runDriftCheck } from "./drift/index.js";
import { checkHeartbeat } from "./heartbeat.js";
import { readEvents } from "./events.js";

export async function runDoctor(config: MexConfig): Promise<void> {
  console.log(chalk.bold("mex doctor"));
  console.log(chalk.dim(`Scaffold: ${config.scaffoldRoot}`));
  console.log();

  const report = await runDriftCheck(config);
  const errors = report.issues.filter((i) => i.severity === "error").length;
  const warnings = report.issues.filter((i) => i.severity === "warning").length;
  const heartbeat = checkHeartbeat(config);
  const events = readEvents(config);

  printLine("Drift", report.score >= 80 && errors === 0, `${report.score}/100 (${errors} errors, ${warnings} warnings)`);
  printLine("Heartbeat", heartbeat.ok, heartbeat.ok ? "HEARTBEAT_OK" : `${heartbeat.staleFiles.length} stale files, ${heartbeat.oldDailyMemoryFiles.length} old memory files`);
  printLine("Events", true, `${events.length} logged event${events.length === 1 ? "" : "s"}`);
  const hasConfig = existsSync(resolve(config.scaffoldRoot, "config.json"));
  printLine("Config", true, hasConfig ? ".mex/config.json loaded with defaults for missing values" : "using defaults; no .mex/config.json found");

  if (errors || warnings || !heartbeat.ok) {
    console.log();
    console.log(chalk.bold("Next steps"));
    if (errors || warnings) console.log("  Run `mex check` for drift details, then `mex sync` for targeted repair prompts.");
    if (!heartbeat.ok) console.log("  Run `mex heartbeat` to see stale context or memory cleanup details.");
  }

  if (errors) process.exitCode = 1;
}

function printLine(label: string, ok: boolean, detail: string): void {
  const icon = ok ? chalk.green("✓") : chalk.yellow("!");
  console.log(`${icon} ${chalk.bold(label)} ${chalk.dim(detail)}`);
}
