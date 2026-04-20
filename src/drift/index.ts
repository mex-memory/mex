import { readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
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

/** Run full drift detection across all scaffold files */
export async function runDriftCheck(
  config: MexConfig,
  opts: { verbose?: boolean } = {}
): Promise<DriftReport> {
  const { projectRoot, scaffoldRoot } = config;

  // Find all markdown files in scaffold
  const scaffoldFiles = findScaffoldFiles(projectRoot, scaffoldRoot);
  const allClaims: Claim[] = [];
  const allIssues: DriftIssue[] = [];
  const checkerIssueCounts: Array<[string, number]> = [];

  // Extract claims from all files
  for (const filePath of scaffoldFiles) {
    const source = relative(projectRoot, filePath);
    const claims = extractClaims(filePath, source);
    allClaims.push(...claims);
  }

  // Run checkers that work on individual files
  for (const filePath of scaffoldFiles) {
    const source = relative(projectRoot, filePath);

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
    );
    allIssues.push(...stalenessIssues);

    checkerIssueCounts.push([`edges:${source}`, edgeIssues.length]);
    checkerIssueCounts.push([`staleness:${source}`, stalenessIssues.length]);
  }

  // Run checkers that work on claims
  const pathIssues = checkPaths(allClaims, projectRoot, scaffoldRoot);
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

  const score = computeScore(allIssues);
  const verboseLog = opts.verbose
    ? buildVerboseLog(scaffoldFiles.length, allClaims, checkerIssueCounts)
    : undefined;

  return {
    score,
    issues: allIssues,
    filesChecked: scaffoldFiles.length,
    timestamp: new Date().toISOString(),
    verboseLog,
  };
}

/** Find all markdown files that are part of the scaffold */
function findScaffoldFiles(
  projectRoot: string,
  scaffoldRoot: string
): string[] {
  const scaffoldPatterns = [
    "context/*.md",
    "patterns/*.md",
    "ROUTER.md",
    "AGENTS.md",
    "SETUP.md",
    "SYNC.md",
  ];

  const files: string[] = [];

  // Search inside scaffold root (handles both .mex/ and root layouts)
  for (const pattern of scaffoldPatterns) {
    const matches = globSync(pattern, {
      cwd: scaffoldRoot,
      absolute: true,
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
