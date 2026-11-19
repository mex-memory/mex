import { existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import type { MexConfig } from "./types.js";
import { runStatus } from "./status.js";

/** The 0.9 doctor reads the same snapshot as status and adds fixes. */
export function runStatusDoctor(options: { json?: boolean } = {}): void {
  runStatus({ ...options, doctor: true });
}
import {
  runDriftCheckWithGraphStatus,
  type GraphAwareDriftReport,
} from "./drift/index.js";
import { checkHeartbeat } from "./heartbeat.js";
import { readEvents } from "./events.js";
import { readStoredGraphCoverage, type GraphCoverageObservation } from "./graph/coverage.js";
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
  const coverage = await readStoredGraphCoverage(config.projectRoot, graph.status === "fresh");

  printLine("Drift", report.score >= 80 && errors === 0, `${report.score}/100 (${errors} errors, ${warnings} warnings)`);
  printLine("Graph", graph.status === "fresh", graphStatusDetail(graph));
  printLine("Coverage", coverage?.histogram.total === 0 && !coverage.histogram.truncated, coverageDetail(coverage));
  printLine("Heartbeat", heartbeat.ok, heartbeat.ok
    ? (heartbeat.filesWithoutLastUpdated
      ? "HEARTBEAT_OK (staleness checks inactive: no parseable last_updated dates)"
      : "HEARTBEAT_OK")
    : `${heartbeat.staleFiles.length} stale files, ${heartbeat.oldDailyMemoryFiles.length} old memory files`);
  printLine("Events", true, `${events.length} logged event${events.length === 1 ? "" : "s"}`);
  const hasConfig = existsSync(resolve(config.scaffoldRoot, "config.json"));
  printLine("Config", true, hasConfig ? ".mex/config.json loaded with defaults for missing values" : "using defaults; no .mex/config.json found");

  const { agentStatuses } = await import("./install/agents.js");
  const agents = agentStatuses();
  for (const agent of agents) printLine(agent.name, agent.ok, agent.detail);

  const graphNeedsAttention = graph.status !== "fresh";
  const graphRecoveryCommand = graphRemediationCommand(graph);
  const unsupportedSources = (coverage?.histogram.total ?? 0) > 0;
  const agentAttention = agents.filter(agent => !agent.ok);
  if (errors || warnings || !heartbeat.ok || graphNeedsAttention || unsupportedSources || agentAttention.length) {
    console.log();
    console.log(chalk.bold("Next steps"));
    if (errors || warnings) console.log("  Run `mex check` for drift details, then `mex sync --deep` for targeted repair prompts.");
    if (unsupportedSources) {
      console.log("  The listed extensions have no extractor; use source search for these languages or `mex graph --json` for the build coverage breakdown.");
    }
    if (graphNeedsAttention && graphRecoveryCommand) {
      console.log(`  Run \`${graphRecoveryCommand}\` to repair the graph explicitly.`);
    } else if (graphNeedsAttention) {
      console.log("  Review the graph diagnostics before using graph-grounded results.");
    }
    if (!heartbeat.ok) console.log("  Run `mex heartbeat` to see stale context or memory cleanup details.");
    if (agentAttention.length) console.log(`  Run \`mex install\` for ${agentAttention.map(agent => agent.name).join(", ")}.`);
  }

  if (errors) process.exitCode = 1;
}

function coverageDetail(observation: GraphCoverageObservation | null): string {
  if (!observation) return "unknown (no readable coverage observation); run mex graph rebuild";
  const coverage = observation.histogram;
  const age = observation.verified ? "" : " (as of the last graph build)";
  if (coverage.total === 0 && !coverage.truncated) return `all recognized source files are indexable${age}`;
  const suffix = coverage.truncated ? ", walk stopped early" : "";
  return `${coverage.total} source file(s) not indexable by any extractor: ${coverage.entries.slice(0, 10).map((entry) => `${entry.extension} (${entry.files})`).join(", ")}${suffix}${age}`;
}

function graphStatusDetail(graph: GraphAwareDriftReport["graphStatus"]): string {
  const diagnostic = graphPrimaryDiagnostic(graph);
  return `${graph.status}; ${graphChangeDetail(graph)}${diagnostic ? `; ${diagnostic}` : ""}`;
}

function printLine(label: string, ok: boolean, detail: string): void {
  const icon = ok ? chalk.green("✓") : chalk.yellow("!");
  console.log(`${icon} ${chalk.bold(label)} ${chalk.dim(detail)}`);
}
