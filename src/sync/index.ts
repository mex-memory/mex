import chalk from "chalk";
import { spawnSync, execSync } from "node:child_process";
import { createInterface } from "node:readline";
import type { MexConfig, SyncTarget, DriftIssue, AiTool } from "../types.js";
import { AI_TOOLS } from "../types.js";
import { runDriftCheck } from "../drift/index.js";
import { buildSyncBrief, buildCombinedBrief } from "./brief-builder.js";

function askUser(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function hasCliTool(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runToolInteractive(tool: AiTool, brief: string, cwd: string): boolean {
  const meta = AI_TOOLS[tool];
  if (!meta.cli) return false;

  const args = [...meta.promptFlag, brief];
  const result = spawnSync(meta.cli, args, {
    cwd,
    stdio: "inherit",
    timeout: 300_000,
  });
  return result.status === 0 || result.status === null;
}

/** Pick which AI tool to use for interactive sync */
async function pickSyncTool(configuredTools: AiTool[]): Promise<AiTool | null> {
  // Filter to tools that have a CLI and are installed
  let available = configuredTools.filter((t) => {
    const meta = AI_TOOLS[t];
    return meta.cli && hasCliTool(meta.cli);
  });

  // If no configured tools matched, scan for any installed CLI and ask user
  if (available.length === 0) {
    const detected = (Object.keys(AI_TOOLS) as AiTool[]).filter((t) => {
      const meta = AI_TOOLS[t];
      return meta.cli && hasCliTool(meta.cli);
    });

    if (detected.length === 0) return null;

    console.log(chalk.yellow("\nNo AI tool configured — but found installed CLI(s):"));
    console.log();
    detected.forEach((t, i) => {
      console.log(`  ${i + 1}) ${AI_TOOLS[t].name}`);
    });
    console.log();

    const choice = await askUser(`Which one should we use? [1-${detected.length}] (default: 1): `);
    const idx = parseInt(choice || "1", 10) - 1;
    return detected[idx] ?? detected[0];
  }

  if (available.length === 1) return available[0];

  // Multiple CLI tools available — ask user
  console.log(chalk.bold("\nWhich tool should fix these?"));
  console.log();
  available.forEach((t, i) => {
    console.log(`  ${i + 1}) ${AI_TOOLS[t].name}`);
  });
  console.log();

  const choice = await askUser(`Choice [1-${available.length}] (default: 1): `);
  const idx = parseInt(choice || "1", 10) - 1;
  return available[idx] ?? available[0];
}

type SyncMode = "interactive" | "prompts";

/** Run targeted sync: detect → brief → AI → verify → ask → loop */
export async function runSync(
  config: MexConfig,
  opts: { dryRun?: boolean; includeWarnings?: boolean }
): Promise<void> {
  let cycle = 0;
  let mode: SyncMode | null = null;
  let activeTool: AiTool | null = null;

  while (true) {
    cycle++;

    // Step 1: Run drift check
    if (cycle === 1) {
      console.log(chalk.bold("Running drift check..."));
    } else {
      console.log(chalk.bold("\nRe-checking for remaining drift..."));
    }

    const report = await runDriftCheck(config);

    if (report.issues.length === 0) {
      console.log(chalk.green("✓ No drift detected. Everything is in sync."));
      return;
    }

    console.log(
      chalk.yellow(
        `Found ${report.issues.length} issues (score: ${report.score}/100)`
      )
    );

    // Step 2: Group issues by file
    const relevantIssues = opts.includeWarnings
      ? report.issues
      : report.issues.filter((i) => {
          const fileHasError = report.issues.some(
            (other) => other.file === i.file && other.severity === "error"
          );
          return fileHasError;
        });

    if (relevantIssues.length === 0) {
      console.log(
        chalk.green(
          "No errors found. Only warnings remain (use --warnings to include them)."
        )
      );
      return;
    }

    const targets = groupIntoTargets(relevantIssues);

    console.log(
      chalk.bold(`\n${targets.length} file(s) need attention:\n`)
    );

    for (const target of targets) {
      const errors = target.issues.filter(
        (i) => i.severity === "error"
      ).length;
      const warnings = target.issues.filter(
        (i) => i.severity === "warning"
      ).length;
      console.log(
        `  ${target.file} — ${errors} errors, ${warnings} warnings`
      );
    }

    // Dry run — show combined prompt and exit
    if (opts.dryRun) {
      console.log(
        chalk.dim("\n--dry-run: showing prompt without executing\n")
      );
      const brief = await buildCombinedBrief(targets, config.projectRoot);
      console.log(brief);
      console.log();
      return;
    }

    // Ask user for mode (only on first cycle)
    if (mode === null) {
      // Determine if any configured tool has a usable CLI
      const syncTool = await pickSyncTool(config.aiTools);
      const toolName = syncTool ? AI_TOOLS[syncTool].name : null;

      console.log(chalk.bold("\nHow should we fix these?"));
      console.log();
      if (toolName) {
        console.log(`  1) Interactive — ${toolName} fixes with you watching (default)`);
      } else {
        console.log("  1) Interactive — AI fixes with you watching (default)");
      }
      console.log("  2) Show prompts — I'll paste manually");
      console.log("  3) Exit");
      console.log();

      const choice = await askUser("Choice [1-3] (default: 1): ");
      const picked = choice || "1";

      switch (picked) {
        case "1":
          if (!syncTool) {
            console.log(chalk.yellow("No supported AI CLI detected. Falling back to prompts mode."));
            console.log(chalk.dim("Supported CLIs: claude, opencode, codex"));
            console.log();
            mode = "prompts";
          } else {
            activeTool = syncTool;
            mode = "interactive";
          }
          break;
        case "2":
          mode = "prompts";
          break;
        case "3":
          console.log(chalk.dim("Exiting. Run mex sync again anytime."));
          return;
        default:
          console.log(chalk.dim("Exiting."));
          return;
      }
    }

    // Show prompts mode — print combined prompt and exit
    if (mode === "prompts") {
      const brief = await buildCombinedBrief(targets, config.projectRoot);
      console.log(brief);
      console.log();
      return;
    }

    // Step 3: Fix all files in one interactive session
    console.log();
    const toolLabel = activeTool ? AI_TOOLS[activeTool].name : "AI";
    console.log(chalk.bold(`\nSending all ${targets.length} file(s) to ${toolLabel} in one session...\n`));

    const brief = await buildCombinedBrief(targets, config.projectRoot);
    const ok = runToolInteractive(activeTool!, brief, config.projectRoot);

    if (!ok) {
      console.log(chalk.red(`  ✗ ${toolLabel} session failed`));
    }

    // Step 4: Verify
    const postReport = await runDriftCheck(config);
    const scoreDelta = postReport.score - report.score;
    const deltaStr =
      scoreDelta > 0
        ? chalk.green(`+${scoreDelta}`)
        : scoreDelta === 0
          ? chalk.yellow("+0")
          : chalk.red(`${scoreDelta}`);

    console.log(
      chalk.bold(
        `\nDrift score: ${report.score} → ${postReport.score}/100 (${deltaStr})`
      )
    );

    // Step 5: Check if we should continue
    const remainingErrors = postReport.issues.filter(
      (i) => i.severity === "error"
    ).length;
    const remainingWarnings = postReport.issues.filter(
      (i) => i.severity === "warning"
    ).length;

    if (remainingErrors === 0 && !opts.includeWarnings) {
      if (remainingWarnings > 0) {
        console.log(
          chalk.dim(
            `${remainingWarnings} warning(s) remain (use --warnings to include them).`
          )
        );
      } else {
        console.log(chalk.green("✓ All issues resolved."));
      }
      return;
    }

    if (postReport.score === 100) {
      console.log(chalk.green("✓ Perfect score. All issues resolved."));
      return;
    }

    // Ask user whether to continue
    const remaining = opts.includeWarnings
      ? remainingErrors + remainingWarnings
      : remainingErrors;

    const answer = await askUser(
      `\n${remaining} issue(s) remain. Run another cycle? [Y/n] `
    );

    if (answer.toLowerCase() === "n") {
      console.log(chalk.dim("Stopped. Run mex sync again anytime."));
      return;
    }
  }
}

function groupIntoTargets(issues: DriftIssue[]): SyncTarget[] {
  const byFile = new Map<string, DriftIssue[]>();
  for (const issue of issues) {
    if (!byFile.has(issue.file)) byFile.set(issue.file, []);
    byFile.get(issue.file)!.push(issue);
  }

  return Array.from(byFile.entries()).map(([file, issues]) => ({
    file,
    issues,
    gitDiff: null,
  }));
}
