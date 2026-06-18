import chalk from "chalk";
import type { DriftReport, DriftIssue, Severity } from "./types.js";

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

export function reportConsole(report: DriftReport): void {
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
}

export function reportQuiet(report: DriftReport): void {
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
  console.log(`mex: drift score ${color(`${report.score}/100`)}${detail}`);
}

export function reportJSON(report: DriftReport, opts?: { verbose?: boolean }): void {
  const output = opts?.verbose ? report : { ...report, verboseLog: undefined };
  console.log(JSON.stringify(output, null, 2));
}

export function reportVerbose(report: DriftReport): void {
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
      return "Copy the intended tool config text across installed agent config files.";
    case "TODO_FIXME":
      return "Resolve the TODO/FIXME or remove the marker from the scaffold.";
    case "BROKEN_LINK":
      return "Fix the link target path or remove the broken Markdown link.";
    case "FRONTMATTER_MISSING_FIELD":
      return "Add name, description, and last_updated to the scaffold file frontmatter.";
    default:
      return null;
  }
}
