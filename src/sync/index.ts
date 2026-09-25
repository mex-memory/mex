import chalk from "chalk";
import crossSpawn from "cross-spawn";
import { createInterface } from "node:readline";
import type { MexConfig, SyncTarget, DriftIssue, AiTool } from "../types.js";
import { AI_TOOLS } from "../types.js";
import { runDriftCheck } from "../drift/index.js";
import { isCliAvailable } from "../cli-tools.js";
import { buildSyncBrief, buildCombinedBrief } from "./brief-builder.js";
import { findScaffoldFiles } from "../drift/index.js";
import { captureGroundingBaselines, groundingReviewNodeIds, loadGroundingRuntime, persistMovedGroundings, previewGroundingBaseline, type MovedByNeighborsNotice } from "../graph/runtime.js";
import { movedByNeighborsMessage } from "../drift/checkers/grounding.js";
import { writeGroundings } from "../markdown.js";
import { buildAgentCommand } from "../agent-command.js";

const INTERACTIVE_AI_TIMEOUT_MS = 15 * 60_000;

export interface RunToolInteractiveOptions {
  /** Sync keeps its bounded default; setup passes null for a user-driven session. */
  timeoutMs?: number | null;
}

function askUser(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function runToolInteractive(
  tool: AiTool,
  brief: string,
  cwd: string,
  options: RunToolInteractiveOptions = {},
): boolean {
  const invocation = buildAgentCommand(tool, brief, "interactive");
  if (invocation === null) return false;
  // cross-spawn resolves Windows `.cmd`/`.bat` wrappers (npm installs `claude`
  // as `claude.cmd`) and escapes args correctly — plain spawnSync throws ENOENT
  // on Windows, and `shell: true` mangles the multi-line prompt (issue #85).
  const result = crossSpawn.sync(invocation.command, invocation.args, {
    cwd,
    stdio: "inherit",
    ...(options.timeoutMs === null
      ? {}
      : { timeout: options.timeoutMs ?? INTERACTIVE_AI_TIMEOUT_MS }),
  });
  // A spawn failure (ENOENT, etc.) sets `error` and leaves `status` null — don't
  // mistake that for success, or launch problems get silently swallowed.
  if (result.error) return false;
  return result.status === 0;
}

/** Pick which AI tool to use for interactive sync */
async function pickSyncTool(configuredTools: AiTool[]): Promise<AiTool | null> {
  // Filter to tools that have a CLI and are installed
  let available = configuredTools.filter((t) => {
    const meta = AI_TOOLS[t];
    return meta.cli && isCliAvailable(meta.cli);
  });

  // If no configured tools matched, scan for any installed CLI and ask user
  if (available.length === 0) {
    const detected = (Object.keys(AI_TOOLS) as AiTool[]).filter((t) => {
      const meta = AI_TOOLS[t];
      return meta.cli && isCliAvailable(meta.cli);
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

/** Internal seams for exercising a complete sync without launching an agent or terminal. */
interface SyncDependencies {
  ask?: (question: string) => Promise<string>;
  runAgent?: typeof runToolInteractive;
  reviewGrounding?: boolean;
}

/** Run targeted sync: detect → brief → AI → verify → ask → loop */
export async function runSync(
  config: MexConfig,
  opts: { dryRun?: boolean; includeWarnings?: boolean },
  dependencies: SyncDependencies = {},
): Promise<void> {
  const ask = dependencies.ask ?? askUser;
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

    const scaffoldFiles = findScaffoldFiles(config.projectRoot, config.scaffoldRoot);
    if (!opts.dryRun) {
      const repairRuntime = await loadGroundingRuntime(config).catch(() => null);
      if (repairRuntime) {
        const notices: MovedByNeighborsNotice[] = [];
        try {
          persistMovedGroundings(config, scaffoldFiles, repairRuntime, notices);
        } catch {
          // Drift check owns the user-facing degradation warning; sync continues.
        } finally {
          // Always release the SQLite handle, even if persistence threw.
          repairRuntime.close();
        }
        // Rewritten already, so the drift check below cannot see these (#229).
        for (const notice of notices) {
          console.log(chalk.blue(`ℹ GROUNDING_MOVED_BY_NEIGHBORS ${notice.file}: ${
            movedByNeighborsMessage(notice.oldId, notice.newId, notice.anchor)}`));
        }
      }
    }
    const report = await runDriftCheck(config);
    // A notice reports a completed rebind (#229); there is nothing to repair.
    const issues = report.issues.filter((i) => i.code !== "GROUNDING_MOVED_BY_NEIGHBORS");

    if (issues.length === 0) {
      console.log(chalk.green("✓ No drift detected. Everything is in sync."));
      return;
    }

    console.log(
      chalk.yellow(
        `Found ${issues.length} issues (score: ${report.score}/100)`
      )
    );

    // Step 2: Group issues by file
    const relevantIssues = opts.includeWarnings
      ? issues
      : issues.filter((i) => {
          // Every grounding outcome is a repair path, including warning-only
          // inline GONE anchors; do not require --warnings to maintain pointers.
          if (i.code.startsWith("GROUNDING_")) return true;
          const fileHasError = issues.some(
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
      const brief = await buildGroundingAwareBrief(targets, config);
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

      const choice = await ask("Choice [1-3] (default: 1): ");
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
      const brief = await buildGroundingAwareBrief(targets, config);
      console.log(brief);
      console.log();
      return;
    }

    // Step 3: Fix all files in one interactive session
    console.log();
    const toolLabel = activeTool ? AI_TOOLS[activeTool].name : "AI";
    console.log(chalk.bold(`\nSending all ${targets.length} file(s) to ${toolLabel} in one session...\n`));

    const brief = await buildGroundingAwareBrief(targets, config);
    const ok = (dependencies.runAgent ?? runToolInteractive)(activeTool!, brief, config.projectRoot);

    if (!ok) {
      console.log(chalk.red(`  ✗ ${toolLabel} session failed`));
    } else {
      try {
        // Completion authorizes verification and initial capture, never renewal
        // of accepted knowledge. Literal-only edits can keep the same fingerprint.
        await captureGroundingBaselines(config);
        if (dependencies.reviewGrounding ?? (process.stdin.isTTY && process.stdout.isTTY)) {
          await reviewGroundingBaselines(config, targets, ask);
        }
      } catch {
        console.log(chalk.yellow("Grounding review could not finish. Existing baselines are preserved for entries that were not accepted."));
      }
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

    const answer = await ask(
      `\n${remaining} issue(s) remain. Run another cycle? [Y/n] `
    );

    if (answer.toLowerCase() === "n") {
      console.log(chalk.dim("Stopped. Run mex sync again anytime."));
      return;
    }
  }
}

/** Review one exact entry at a time; no graph lease is held while waiting for input. */
export async function reviewGroundingBaselines(
  config: MexConfig,
  targets: readonly SyncTarget[],
  ask: (question: string) => Promise<string> = askUser,
  write: (message: string) => void = console.log,
): Promise<void> {
  let inspected = 0;
  for (const target of targets) {
    if (!target.issues.some((issue) => issue.code.startsWith("GROUNDING_"))) continue;
    const nodeIds = groundingReviewNodeIds(config, target.file);
    if (nodeIds === null) {
      write(`Grounding review for ${target.file} exceeds the inline review limit; its baseline is preserved.`);
      continue;
    }
    for (const nodeId of nodeIds) {
      if (++inspected > 64) {
        write("The grounding review limit was reached; remaining baselines are preserved.");
        return;
      }
      const runtime = await loadGroundingRuntime(config);
      if (!runtime) return;
      let review;
      try {
        review = previewGroundingBaseline(config, target.file, nodeId, runtime);
      } finally {
        runtime.close();
      }
      if (!review) continue;
      write(`\nGrounding review: ${target.file}\nNode: ${nodeId}`);
      // Keep authored metadata/prose visible, but hide serialized grounding
      // fingerprints. The acceptance still binds the original complete bytes.
      write(`\nCurrent document (grounding metadata hidden):\n${writeGroundings(review.content, [])}`);
      write(`\nPreviously accepted code:\n${review.oldBody ?? "Unavailable in this checkout; inspect the prior revision before accepting."}`);
      write(`\nCurrent code:\n${review.newBody}`);
      write("Accepting records that this claim was reviewed against the current code. Commit and push to share it.");
      const answer = (await ask("Accept this grounding after reviewing the claim and current code? [y/N] ")).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") continue;
      const result = await captureGroundingBaselines(config, {
        acceptedGroundings: [review.acceptance],
        warn: write,
      });
      write(result.captured === 1
        ? "Accepted this grounding in the working tree."
        : "Grounding was not accepted; its document or code changed. Review it again.");
    }
  }
}

async function buildGroundingAwareBrief(targets: SyncTarget[], config: MexConfig): Promise<string> {
  try {
    const runtime = await loadGroundingRuntime(config);
    if (!runtime) return buildCombinedBrief(targets, config.projectRoot);
    try {
      return await buildCombinedBrief(targets, config.projectRoot, { config, runtime });
    } finally {
      runtime.close();
    }
  } catch {
    return buildCombinedBrief(targets, config.projectRoot);
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
