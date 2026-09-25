import chalk from "chalk";
import type { DriftReport, DriftIssue, Severity } from "./types.js";
import type { GraphAwareDriftReport } from "./drift/index.js";
import type { GraphStatus } from "./team/contracts/graph.js";

type ReportableDriftReport = DriftReport & Partial<Pick<GraphAwareDriftReport, "graphStatus">>;

const severityColor: Record<Severity, (s: string) => string> = {
  error: chalk.red,
  warning: chalk.yellow,
  info: chalk.blue,
};

const severityIcon: Record<Severity, string> = {
  error: "✗",
  warning: "⚠",
  info: "ℹ",
};

export function reportConsole(report: ReportableDriftReport): void {
  // Show score at top so it's visible before scrolling through issues
  if (report.issues.length > 0) {
    printSummary(report);
    console.log();
  }

  const grouped = groupBySeverityThenFile(report.issues);

  for (const severity of ["error", "warning", "info"] as Severity[]) {
    const files = grouped[severity];
    if (!files || Object.keys(files).length === 0) continue;
    console.log(chalk.bold(severity.toUpperCase()));
    console.log();
    for (const [file, issues] of Object.entries(files)) {
      console.log(chalk.bold.underline(file));
      for (const issue of issues) {
        const color = severityColor[issue.severity];
        const icon = severityIcon[issue.severity];
        const loc = issue.line ? `:${issue.line}` : "";
        console.log(
          `  ${color(`${icon} ${issue.code}`)}${loc} ${issue.message}`
        );
        const remediation = remediationFor(issue.code);
        if (remediation) console.log(chalk.dim(`    → ${remediation}`));
      }
      console.log();
    }
  }

  printSummary(report);
  printGraphStatus(report.graphStatus);
}

export function reportQuiet(report: ReportableDriftReport): void {
  const errors = report.issues.filter((i) => i.severity === "error").length;
  const warnings = report.issues.filter(
    (i) => i.severity === "warning"
  ).length;
  const parts = [];
  if (errors) parts.push(`${errors} error${errors > 1 ? "s" : ""}`);
  if (warnings) parts.push(`${warnings} warning${warnings > 1 ? "s" : ""}`);
  const detail = parts.length ? ` (${parts.join(", ")})` : "";
  const color =
    report.score >= 80
      ? chalk.green
      : report.score >= 50
        ? chalk.yellow
        : chalk.red;
  const graph = report.graphStatus ? ` · ${graphStatusSummary(report.graphStatus)}` : "";
  console.log(`mex: drift score ${color(`${report.score}/100`)}${detail}${graph}`);
}

export function reportJSON(report: ReportableDriftReport, opts?: { verbose?: boolean }): void {
  const output = opts?.verbose ? report : { ...report, verboseLog: undefined };
  console.log(JSON.stringify(output, null, 2));
}

export function reportVerbose(report: ReportableDriftReport): void {
  if (!report.verboseLog?.length) return;
  console.log(chalk.dim("── Verbose ──"));
  for (const line of report.verboseLog) {
    console.log(chalk.dim(`  ${line}`));
  }
  console.log();
}

function printSummary(report: DriftReport): void {
  const errors = report.issues.filter((i) => i.severity === "error").length;
  const warnings = report.issues.filter(
    (i) => i.severity === "warning"
  ).length;
  const infos = report.issues.filter((i) => i.severity === "info").length;
  const color =
    report.score >= 80
      ? chalk.green
      : report.score >= 50
        ? chalk.yellow
        : chalk.red;

  console.log(
    chalk.bold(
      `Drift score: ${color(`${report.score}/100`)} — ${errors} errors, ${warnings} warnings, ${infos} info`
    )
  );
  console.log(chalk.dim(`${report.filesChecked} files checked`));
}

function printGraphStatus(graph: GraphStatus | undefined): void {
  if (!graph) return;
  console.log(chalk.dim(graphStatusSummary(graph)));
  const visible = graph.diagnostics.slice(0, 3);
  for (const diagnostic of visible) {
    console.log(chalk.dim(`  ${diagnostic.code}: ${diagnostic.message}`));
  }
  if (graph.diagnostics.length > visible.length) {
    console.log(chalk.dim(`  ${graph.diagnostics.length - visible.length} additional graph diagnostic(s) omitted`));
  }
}

function graphStatusSummary(graph: GraphStatus): string {
  return `graph ${graph.status} · ${graphChangeDetail(graph)}`;
}

/** Compact, truthful graph-drift detail shared by first-party text surfaces. */
export function graphChangeDetail(graph: GraphStatus): string {
  const changes = graph.changes;
  const count = `${changes.total} source change${changes.total === 1 ? "" : "s"}`;
  const breakdown = changes.truncated
    ? "path details truncated"
    : `${changes.added.length} added, ${changes.modified.length} modified, ${changes.deleted.length} deleted`;
  const causes: string[] = [];
  if (changes.branchChanged) causes.push("branch changed");
  if (changes.configChanged) causes.push("config changed");
  if (changes.grammarChanged) causes.push("grammar changed");
  if (changes.manifestChanged && !changes.configChanged && !changes.grammarChanged) {
    causes.push("build manifest changed");
  }
  const command = graphRemediationCommand(graph);
  return `${count} (${breakdown})${causes.length > 0 ? ` · ${causes.join(" · ")}` : ""}${command ? ` · run \`${command}\`` : ""}`;
}

/** Return only a remediation command explicitly supplied by graph diagnostics. */
export function graphRemediationCommand(graph: GraphStatus): string | undefined {
  return graph.diagnostics
    .flatMap((diagnostic) => diagnostic.remediation ?? [])
    .find((action) => action.command)?.command;
}

export function graphPrimaryDiagnostic(graph: GraphStatus): string | undefined {
  const diagnostic = graph.diagnostics[0];
  return diagnostic ? `${diagnostic.code}: ${diagnostic.message}` : undefined;
}

function groupBySeverityThenFile(
  issues: DriftIssue[]
): Record<Severity, Record<string, DriftIssue[]>> {
  const grouped: Record<Severity, Record<string, DriftIssue[]>> = {
    error: {},
    warning: {},
    info: {},
  };
  for (const issue of issues) {
    if (!grouped[issue.severity][issue.file]) grouped[issue.severity][issue.file] = [];
    grouped[issue.severity][issue.file].push(issue);
  }
  return grouped;
}

function remediationFor(code: DriftIssue["code"]): string | null {
  switch (code) {
    case "STALE_FILE":
      return "Review the file against reality, update it if needed, then bump last_updated.";
    case "MISSING_PATH":
      return "Fix the referenced path or remove stale documentation.";
    case "DEAD_COMMAND":
      return "Update the command in the scaffold or restore the missing script.";
    case "DEPENDENCY_MISSING":
      return "Remove the dependency claim or add the dependency to the manifest.";
    case "DEAD_EDGE":
      return "Update or remove the frontmatter edge target.";
    case "INDEX_MISSING_ENTRY":
    case "INDEX_ORPHAN_ENTRY":
      return "Update patterns/INDEX.md to match the pattern files on disk.";
    case "UNDOCUMENTED_SCRIPT":
      return "Document the script in AGENTS.md, SETUP.md, or context/setup.md.";
    case "TOOL_CONFIG_DRIFT":
      return "Re-copy the correct version over the tool configs that disagree with it.";
    case "TODO_FIXME":
      return "Resolve the TODO/FIXME or remove the marker from the scaffold.";
    case "BROKEN_LINK":
      return "Fix the link target path or remove the broken Markdown link.";
    case "GROUNDING_MOVED_BY_NEIGHBORS":
      return "Not scored. Confirm the new node is the same function; `mex sync` rewrites the reference.";
    default:
      return null;
  }
}
