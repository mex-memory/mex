import { readFileSync } from "node:fs";
import { resolve, relative, basename } from "node:path";
import { globSync } from "glob";
import type { MexConfig, DriftReport, DriftIssue, Claim } from "../types.js";
import { extractClaims } from "./claims.js";
import { parseFrontmatter } from "./frontmatter.js";
import { computeScore } from "./scoring.js";
import { checkPaths } from "./checkers/path.js";
import { checkEdges } from "./checkers/edges.js";
import { checkIndexSync } from "./checkers/index-sync.js";
import { checkStaleness } from "./checkers/staleness.js";
import { checkCommands } from "./checkers/command.js";
import { checkDependencies } from "./checkers/dependency.js";
import { checkCrossFile } from "./checkers/cross-file.js";
import { checkScriptCoverage } from "./checkers/script-coverage.js";
import { checkToolConfigSync } from "./checkers/tool-config-sync.js";
import { checkTodoFixme } from "./checkers/todo-fixme.js";
import { checkBrokenLinks } from "./checkers/broken-link.js";
import { toPosix } from "../paths.js";
import { loadGroundingRuntime, type GroundingRuntime } from "../graph/runtime.js";

let graphUpgradeNudgeShown = false;

/**
 * Default glob patterns used to locate scaffold markdown files, relative to
 * `MexConfig.scaffoldRoot`. Exported so consumers can extend rather than
 * replace the list, e.g.
 *
 * ```ts
 * runDriftCheck(config, {
 *   scaffoldPatterns: [...DEFAULT_SCAFFOLD_PATTERNS, "traces/**\/*.md"],
 * });
 * ```
 *
 * NOT a stable contract — mex may add to this list between minor versions.
 * If exact behavior matters, pass `scaffoldPatterns` explicitly.
 */
export const DEFAULT_SCAFFOLD_PATTERNS = [
  "context/*.md",
  "patterns/*.md",
  "ROUTER.md",
  "AGENTS.md",
  "SETUP.md",
  "SYNC.md",
] as const;

export interface RunDriftCheckOpts {
  verbose?: boolean;
  /** Override the glob patterns used to discover scaffold files (relative to
   *  `config.scaffoldRoot`). Defaults to {@link DEFAULT_SCAFFOLD_PATTERNS}. */
  scaffoldPatterns?: readonly string[];
  /** Internal seam used to verify graph-load graceful degradation. */
  groundingRuntimeLoader?: (config: MexConfig) => Promise<GroundingRuntime | null>;
  graphWarning?: (message: string) => void;
}

/** Run full drift detection across all scaffold files */
export async function runDriftCheck(
  config: MexConfig,
  opts: RunDriftCheckOpts = {}
): Promise<DriftReport> {
  const { projectRoot, scaffoldRoot } = config;

  // Find all markdown files in scaffold
  const scaffoldFiles = findScaffoldFiles(projectRoot, scaffoldRoot, opts.scaffoldPatterns);
  const allClaims: Claim[] = [];
  const allIssues: DriftIssue[] = [];
  const checkerIssueCounts: Array<[string, number]> = [];
  const hasGroundings = scaffoldFiles.some((filePath) => Boolean(parseFrontmatter(filePath)?.grounds_to));
  let groundingRuntime: GroundingRuntime | null = null;
  if (hasGroundings) {
    try {
      groundingRuntime = await (opts.groundingRuntimeLoader ?? loadGroundingRuntime)(config);
      if (!groundingRuntime && !graphUpgradeNudgeShown) {
        graphUpgradeNudgeShown = true;
        (opts.graphWarning ?? console.warn)(
          "A code graph unlocks sharper drift detection. Run `mex graph`.",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      (opts.graphWarning ?? console.warn)(`Code graph unavailable; grounding checks skipped: ${message}`);
    }
  }

  // Extract claims from all files
  for (const filePath of scaffoldFiles) {
    const source = toPosix(relative(projectRoot, filePath));
    const claims = extractClaims(filePath, source);
    allClaims.push(...claims);
  }

  // Run checkers that work on individual files
  for (const filePath of scaffoldFiles) {
    const source = toPosix(relative(projectRoot, filePath));

    // Frontmatter edge check
    const frontmatter = parseFrontmatter(filePath);
    const edgeIssues = checkEdges(frontmatter, filePath, source, projectRoot, scaffoldRoot);
    allIssues.push(...edgeIssues);

    // Staleness check
    const stalenessIssues = await checkStaleness(
      source,
      source,
      projectRoot,
      config.stalenessThresholds,
      { lastUpdated: typeof frontmatter?.last_updated === "string" ? frontmatter.last_updated : undefined },
    );
    allIssues.push(...stalenessIssues);

    checkerIssueCounts.push([`edges:${source}`, edgeIssues.length]);
    checkerIssueCounts.push([`staleness:${source}`, stalenessIssues.length]);

    if (groundingRuntime) {
      const groundingIssues = groundingRuntime.checker(
        frontmatter, filePath, source, projectRoot, scaffoldRoot,
      );
      allIssues.push(...groundingIssues);
      checkerIssueCounts.push([`grounding:${source}`, groundingIssues.length]);
    }
  }

  // Run checkers that work on claims
  // Only check paths in ROUTER.md — other scaffold files use backticks for
  // non-path content (config values, IPs, annotation keys) that produces
  // false MISSING_PATH errors. See https://github.com/theDakshJaitly/mex/issues/79
  const routerClaims = allClaims.filter((c) => basename(c.source) === "ROUTER.md");
  const pathIssues = checkPaths(routerClaims, projectRoot, scaffoldRoot);
  allIssues.push(...pathIssues);
  checkerIssueCounts.push(["paths", pathIssues.length]);

  const commandIssues = checkCommands(allClaims, projectRoot);
  allIssues.push(...commandIssues);
  checkerIssueCounts.push(["commands", commandIssues.length]);

  const dependencyIssues = checkDependencies(allClaims, projectRoot);
  allIssues.push(...dependencyIssues);
  checkerIssueCounts.push(["dependencies", dependencyIssues.length]);

  const crossFileIssues = checkCrossFile(allClaims);
  allIssues.push(...crossFileIssues);
  checkerIssueCounts.push(["cross-file", crossFileIssues.length]);

  // Run structural checkers
  const indexSyncIssues = checkIndexSync(projectRoot, scaffoldRoot);
  allIssues.push(...indexSyncIssues);
  checkerIssueCounts.push(["index-sync", indexSyncIssues.length]);

  // Run coverage checkers (reality → scaffold direction)
  const scriptCoverageIssues = checkScriptCoverage(scaffoldFiles, projectRoot);
  allIssues.push(...scriptCoverageIssues);
  checkerIssueCounts.push(["script-coverage", scriptCoverageIssues.length]);

  const toolConfigSyncIssues = checkToolConfigSync(projectRoot);
  allIssues.push(...toolConfigSyncIssues);
  checkerIssueCounts.push(["tool-config-sync", toolConfigSyncIssues.length]);

  const todoFixmeIssues = checkTodoFixme(scaffoldFiles, projectRoot);
  allIssues.push(...todoFixmeIssues);
  checkerIssueCounts.push(["todo-fixme", todoFixmeIssues.length]);

  const brokenLinkIssues = checkBrokenLinks(scaffoldFiles, projectRoot, scaffoldRoot);
  allIssues.push(...brokenLinkIssues);
  checkerIssueCounts.push(["broken-link", brokenLinkIssues.length]);

  const score = computeScore(allIssues);
  const verboseLog = opts.verbose
    ? buildVerboseLog(scaffoldFiles.length, allClaims, checkerIssueCounts)
    : undefined;

  const report = {
    score,
    issues: allIssues,
    filesChecked: scaffoldFiles.length,
    timestamp: new Date().toISOString(),
    verboseLog,
  };
  groundingRuntime?.close();
  return report;
}

/** Find all markdown files that are part of the scaffold */
export function findScaffoldFiles(
  projectRoot: string,
  scaffoldRoot: string,
  patterns: readonly string[] = DEFAULT_SCAFFOLD_PATTERNS
): string[] {
  const files: string[] = [];

  // Search inside scaffold root (handles both .mex/ and root layouts)
  for (const pattern of patterns) {
    const matches = globSync(pattern, {
      cwd: scaffoldRoot,
      absolute: true,
      follow: true,
      ignore: ["node_modules/**"],
    });
    files.push(...matches);
  }

  // Also check project root for tool config files (CLAUDE.md, etc.)
  if (scaffoldRoot !== projectRoot) {
    for (const name of ["CLAUDE.md", ".cursorrules", ".windsurfrules"]) {
      const matches = globSync(name, {
        cwd: projectRoot,
        absolute: true,
        ignore: ["node_modules/**"],
      });
      files.push(...matches);
    }
  }

  // Deduplicate
  return [...new Set(files)];
}

export function buildVerboseLog(
  filesScanned: number,
  claims: Claim[],
  checkerIssueCounts: Array<[string, number]>
): string[] {
  const pathClaims = claims.filter((claim) => claim.kind === "path").length;
  const commandClaims = claims.filter((claim) => claim.kind === "command").length;
  const dependencyClaims = claims.filter((claim) => claim.kind === "dependency").length;

  return [
    `Scaffold files scanned: ${filesScanned}`,
    `Claims extracted: ${claims.length} (path: ${pathClaims}, command: ${commandClaims}, dependency: ${dependencyClaims})`,
    ...checkerIssueCounts.map(
      ([checker, count]) => `Checker ${checker}: ${count} issue${count === 1 ? "" : "s"}`
    ),
  ];
}
