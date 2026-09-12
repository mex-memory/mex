import { existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import type { MexConfig } from "./types.js";
import {
  runDriftCheckWithGraphStatus,
  type GraphAwareDriftReport,
} from "./drift/index.js";
import { checkHeartbeat } from "./heartbeat.js";
import { readEvents } from "./events.js";
import { unindexedExtensionHistogram } from "./graph/corpus-policy.js";
import {
  graphChangeDetail,
  graphPrimaryDiagnostic,
  graphRemediationCommand,
} from "./reporter.js";

export async function runDoctor(config: MexConfig): Promise<void> {
  console.log(chalk.bold("mex doctor"));
  console.log(chalk.dim(`Scaffold: ${config.scaffoldRoot}`));
  console.log();

  const report = await runDriftCheckWithGraphStatus(config, { graphWarning: () => {} });
  const errors = report.issues.filter((i) => i.severity === "error").length;
  const warnings = report.issues.filter((i) => i.severity === "warning").length;
  const heartbeat = checkHeartbeat(config);
  const events = readEvents(config);
  const graph = report.graphStatus;
  const coverage = unindexedExtensionHistogram(config.projectRoot);

  printLine("Drift", report.score >= 80 && errors === 0, `${report.score}/100 (${errors} errors, ${warnings} warnings)`);
  printLine("Graph", graph.status === "fresh", graphStatusDetail(graph));
  printLine("Coverage", coverage.total === 0, coverageDetail(coverage));
  printLine("Heartbeat", heartbeat.ok, heartbeat.ok ? "HEARTBEAT_OK" : `${heartbeat.staleFiles.length} stale files, ${heartbeat.oldDailyMemoryFiles.length} old memory files`);
  printLine("Events", true, `${events.length} logged event${events.length === 1 ? "" : "s"}`);
  const hasConfig = existsSync(resolve(config.scaffoldRoot, "config.json"));
  printLine("Config", true, hasConfig ? ".mex/config.json loaded with defaults for missing values" : "using defaults; no .mex/config.json found");

  const graphNeedsAttention = graph.status !== "fresh";
  const graphRecoveryCommand = graphRemediationCommand(graph);
  if (errors || warnings || !heartbeat.ok || graphNeedsAttention || coverage.total > 0) {
    console.log();
    console.log(chalk.bold("Next steps"));
    if (errors || warnings) console.log("  Run `mex check` for drift details, then `mex sync` for targeted repair prompts.");
    if (coverage.total > 0) {
      console.log("  Source files above exist in the repository but are absent from the graph; no extractor ships for their language yet.");
    }
    if (graphNeedsAttention && graphRecoveryCommand) {
      console.log(`  Run \`${graphRecoveryCommand}\` to repair the graph explicitly.`);
    } else if (graphNeedsAttention) {
      console.log("  Review the graph diagnostics before using graph-grounded results.");
    }
    if (!heartbeat.ok) console.log("  Run `mex heartbeat` to see stale context or memory cleanup details.");
  }

  if (errors) process.exitCode = 1;
}

function coverageDetail(coverage: ReturnType<typeof unindexedExtensionHistogram>): string {
  if (coverage.total === 0) return "all recognized source files are indexable";
  const suffix = coverage.truncated ? ", walk stopped early" : "";
  return `${coverage.total} source file(s) not indexable by any extractor${suffix}`;
}

function graphStatusDetail(graph: GraphAwareDriftReport["graphStatus"]): string {
  const diagnostic = graphPrimaryDiagnostic(graph);
  return `${graph.status}; ${graphChangeDetail(graph)}${diagnostic ? `; ${diagnostic}` : ""}`;
}

function printLine(label: string, ok: boolean, detail: string): void {
  const icon = ok ? chalk.green("✓") : chalk.yellow("!");
  console.log(`${icon} ${chalk.bold(label)} ${chalk.dim(detail)}`);
}
