import { readFileSync, realpathSync } from "node:fs";
import { resolve, relative } from "node:path";
import { globSync } from "glob";
import type { MexConfig, DriftReport, DriftIssue, Claim } from "../types.js";
import { extractClaims } from "./claims.js";
import { parseFrontmatter } from "./frontmatter.js";
import { computeScore } from "./scoring.js";
import { checkPaths } from "./checkers/path.js";
import { checkEdges } from "./checkers/edges.js";
import { checkIndexSync } from "./checkers/index-sync.js";
import { checkStalePatterns } from "./checkers/stale-pattern.js";
import { checkFrontmatterCompleteness } from "./checkers/frontmatter-completeness.js";
import { checkStaleness } from "./checkers/staleness.js";
import { checkCommands } from "./checkers/command.js";
import { checkDependencies } from "./checkers/dependency.js";
import { checkCrossFile } from "./checkers/cross-file.js";
import { checkScriptCoverage } from "./checkers/script-coverage.js";
import { checkToolConfigSync } from "./checkers/tool-config-sync.js";
import { checkAnchorLink } from "./checkers/anchor-link.js";
import { checkTodoFixme } from "./checkers/todo-fixme.js";
import { checkBrokenLinks } from "./checkers/broken-link.js";
import { toPosix } from "../paths.js";
import {
  loadReadOnlyGroundingRuntime,
  type GroundingRuntime,
  type ReadOnlyGroundingRuntimeResult,
} from "../graph/runtime.js";
import { extractGroundings, findMexAnchors } from "../markdown.js";
import type { GraphStatus } from "../team/contracts/graph.js";

let graphUpgradeNudgeShown = false;
let graphMigrationNudgeShown = false;

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
  /** Backward-compatible injection seam retained for existing embedders. */
  groundingRuntimeLoader?: (config: MexConfig) => Promise<GroundingRuntime | null>;
  /** Receive optional grounding/freshness warnings without writing to stderr. */
  graphWarning?: (message: string) => void;
}

/** Internal report used by graph-aware CLI surfaces; not re-exported at package root. */
export type GraphAwareDriftReport = DriftReport & { graphStatus: GraphStatus };

/** Internal test/adapter seams; deliberately excluded from the stable package API. */
export interface GraphAwareRunDriftCheckOpts extends RunDriftCheckOpts {
  readOnlyGroundingRuntimeLoader?: (
    config: MexConfig,
    options?: { loadRuntime?: boolean },
  ) => Promise<ReadOnlyGroundingRuntimeResult>;
}

/** Run full drift detection through the stable package API. */
export async function runDriftCheck(
  config: MexConfig,
  opts: RunDriftCheckOpts = {}
): Promise<DriftReport> {
  const { graphStatus: _graphStatus, ...report } = await runDriftCheckWithGraphStatus(config, {
    ...opts,
    // Preserve the historical package API warning behavior. First-party
    // graph-aware surfaces render status themselves and default to silence.
    graphWarning: opts.graphWarning ?? console.warn,
  });
  return report;
}

/**
 * Internal graph-aware check used by first-party CLI surfaces. Keeping this
 * richer result out of `src/index.ts` prevents provisional graph contracts
 * from changing the package-root `DriftReport` declaration.
 */
export async function runDriftCheckWithGraphStatus(
  config: MexConfig,
  opts: GraphAwareRunDriftCheckOpts = {},
): Promise<GraphAwareDriftReport> {
  const { projectRoot, scaffoldRoot } = config;
  const warnGraph = opts.graphWarning ?? (() => {});

  // Find all markdown files in scaffold
  const scaffoldFiles = findScaffoldFiles(projectRoot, scaffoldRoot, opts.scaffoldPatterns);
  const allClaims: Claim[] = [];
  const allIssues: DriftIssue[] = [];
  const checkerIssueCounts: Array<[string, number]> = [];
  const pendingGroundingIssues: DriftIssue[] = [];
  const pendingGroundingIssueCounts: Array<[string, number]> = [];
  const usesInjectedGroundingRuntime = opts.groundingRuntimeLoader !== undefined;
  // Read the key the same way the checker and the writer do. Asking only for a
  // root `grounds_to` missed every migrated scaffold, where §13.4 has moved the
  // key under the `mex` map — so `groundingRelevant` came out false, the
  // grounding runtime was never opened, and the checker that would have found
  // the groundings was never constructed. `extractGroundings` resolves the path.
  const hasGroundings = scaffoldFiles.some((filePath) => {
    let content: string;
    try { content = readFileSync(filePath, "utf-8"); } catch { return false; }
    return extractGroundings(content).length > 0 || findMexAnchors(content).length > 0;
  });
  const needsGroundingMigration = !hasGroundings && scaffoldFiles.some(isPopulatedGroundingCandidate);
  const groundingRelevant = hasGroundings || needsGroundingMigration;
  let groundingRuntime: GroundingRuntime | null = null;
  let graphStatus: GraphStatus | undefined;
  try {
    try {
      const loaded = await (
        opts.readOnlyGroundingRuntimeLoader ?? loadReadOnlyGroundingRuntime
      )(config, { loadRuntime: opts.groundingRuntimeLoader ? false : groundingRelevant });
      graphStatus = loaded.graphStatus;
      groundingRuntime = loaded.runtime;

      if (usesInjectedGroundingRuntime) {
        // Preserve the historical injection seam while still inspecting graph
        // status unconditionally. An explicit injected runtime remains
        // authoritative for checker execution; production callers do not use
        // this seam and remain gated on a fresh read-only graph snapshot.
        const inspectedRuntime = groundingRuntime;
        groundingRuntime = null;
        inspectedRuntime?.close();
        groundingRuntime = groundingRelevant
          ? await opts.groundingRuntimeLoader!(config)
          : null;
      }

      if (!usesInjectedGroundingRuntime && graphStatus.status !== "fresh" && groundingRuntime) {
        const staleRuntime = groundingRuntime;
        groundingRuntime = null;
        staleRuntime.close();
      }

      if (!usesInjectedGroundingRuntime && groundingRelevant && graphStatus.status !== "fresh") {
        warnGraph(
          graphFreshnessWarning(graphStatus, groundingRelevant, needsGroundingMigration),
        );
      } else if (groundingRelevant && !groundingRuntime && !graphUpgradeNudgeShown) {
        graphUpgradeNudgeShown = true;
        warnGraph(graphStatus.status === "fresh"
          ? "A code graph unlocks sharper drift detection. Run `mex graph`, then `mex graph ground`."
          : graphFreshnessWarning(graphStatus, groundingRelevant, needsGroundingMigration));
      } else if (groundingRuntime && needsGroundingMigration && !graphMigrationNudgeShown) {
        graphMigrationNudgeShown = true;
        warnGraph(
          "Existing scaffold has no code grounding. Run `mex graph ground` to connect it.",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const groundingNote = groundingRelevant ? "; grounding checks skipped" : "";
      if (graphStatus) {
        warnGraph(`Code graph grounding unavailable${groundingNote}: ${message}`);
      } else {
        graphStatus = unavailableGraphStatus(message);
        warnGraph(`Code graph status unavailable${groundingNote}: ${message}`);
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

      // Frontmatter completeness check
      const frontmatterCompletenessIssues = checkFrontmatterCompleteness(frontmatter, source);
      allIssues.push(...frontmatterCompletenessIssues);

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
      checkerIssueCounts.push([`frontmatter-completeness:${source}`, frontmatterCompletenessIssues.length]);
      checkerIssueCounts.push([`staleness:${source}`, stalenessIssues.length]);

      if (groundingRuntime) {
        const groundingIssues = groundingRuntime.checker(
          frontmatter, filePath, source, projectRoot, scaffoldRoot,
        );
        // A production immutable reader is guarded for the whole check, but a
        // later file can still observe graph replacement after an earlier file
        // produced findings. Hold every graph-derived finding until all files
        // have been checked, then publish the batch only if the same snapshot
        // remained valid throughout. The explicit legacy injection seam is
        // caller-owned and preserves its historical behavior.
        pendingGroundingIssues.push(...groundingIssues);
        pendingGroundingIssueCounts.push([`grounding:${source}`, groundingIssues.length]);
      }
    }

    if (usesInjectedGroundingRuntime || graphStatus?.status === "fresh") {
      allIssues.push(...pendingGroundingIssues);
      checkerIssueCounts.push(...pendingGroundingIssueCounts);
    }

    if (groundingRelevant
      && graphStatus.status !== "fresh"
      && graphStatus.diagnostics.some((entry) => entry.code === "GRAPH_INDEX_READER_DATABASE_CHANGED")) {
      warnGraph(graphFreshnessWarning(graphStatus, groundingRelevant, needsGroundingMigration));
    }

    // Run checkers that work on claims
    // Paths are checked in every scaffold file. #80 narrowed this to ROUTER.md
    // because non-path inline code produced false MISSING_PATH errors, but that
    // left the other ten files unchecked -- a path could rot in context/ or
    // patterns/ and nothing said so. The extraction side now rejects the values
    // that caused those false positives, so the scope can widen again.
    // See https://github.com/mex-memory/mex/issues/107
    //
    // A token the scaffold documents as a package is not a missing file: mex
    // must not call `youtubei.js` a dependency in context/stack.md and a broken
    // path in ROUTER.md.
    const declaredPackages = new Set(
      allClaims.filter((c) => c.kind === "dependency").map((c) => c.value)
    );
    const pathClaims = allClaims.filter(
      (c) => c.kind !== "path" || !declaredPackages.has(c.value)
    );
    const pathIssues = checkPaths(pathClaims, projectRoot, scaffoldRoot);
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

    const stalePatternIssues = checkStalePatterns(projectRoot, scaffoldRoot);
    allIssues.push(...stalePatternIssues);
    checkerIssueCounts.push(["stale-pattern", stalePatternIssues.length]);

    // Run coverage checkers (reality → scaffold direction)
    const scriptCoverageIssues = checkScriptCoverage(scaffoldFiles, projectRoot);
    allIssues.push(...scriptCoverageIssues);
    checkerIssueCounts.push(["script-coverage", scriptCoverageIssues.length]);

    const anchorLinkIssues = checkAnchorLink(projectRoot, scaffoldRoot);
    allIssues.push(...anchorLinkIssues);
    checkerIssueCounts.push(["anchor-link", anchorLinkIssues.length]);

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

    return {
      score,
      issues: allIssues,
      filesChecked: scaffoldFiles.length,
      timestamp: new Date().toISOString(),
      verboseLog,
      graphStatus: graphStatus ?? unavailableGraphStatus("Graph status inspection returned no result."),
    };
  } finally {
    groundingRuntime?.close();
  }
}

function graphFreshnessWarning(
  status: GraphStatus,
  groundingRelevant: boolean,
  needsGroundingMigration: boolean,
): string {
  const groundingNote = groundingRelevant ? "; grounding checks skipped" : "";
  const command = graphRemediationCommand(status);
  const primary = status.diagnostics.find((entry) =>
    entry.code === "GRAPH_INDEX_READER_DATABASE_CHANGED"
  )
    ?? status.diagnostics.find((entry) => entry.severity === "error")
    ?? status.diagnostics.find((entry) => entry.severity === "warning")
    ?? status.diagnostics[0];
  const diagnostic = primary
    ? ` ${primary.code}: ${primary.message.slice(0, 300)}`
    : " Review graph diagnostics.";
  const remediation = command ? ` Run \`${command}\`.` : diagnostic;
  switch (status.status) {
    case "missing":
      return needsGroundingMigration && command
        ? `Code graph is missing${groundingNote}. Run \`${command}\`, then \`mex graph ground\`.`
        : `Code graph is missing${groundingNote}.${remediation}`;
    case "stale":
      return `Code graph is stale${groundingNote}.${remediation}`;
    case "degraded":
      return `Code graph is degraded${groundingNote}.${remediation}`;
    case "rebuild_required":
      return `Code graph requires a rebuild${groundingNote}.${remediation}`;
    case "corrupt":
      return `Code graph is corrupt${groundingNote}.${remediation}`;
    case "fresh":
      return "";
  }
}

function graphRemediationCommand(status: GraphStatus): string | undefined {
  return status.diagnostics
    .flatMap((diagnostic) => diagnostic.remediation ?? [])
    .find((action) => action.command)?.command;
}

function unavailableGraphStatus(message: string): GraphStatus {
  const observedAt = new Date().toISOString();
  return {
    status: "degraded",
    observedAt,
    currentRepo: { branch: null, head: null, dirty: false, observedAt },
    lastSuccessfulIndexAt: null,
    indexedAt: null,
    indexedBranch: null,
    indexedHead: null,
    schemaVersion: null,
    extractorVersion: null,
    grammarVersion: null,
    parseHealth: {
      total: 0,
      ok: 0,
      partial: 0,
      failed: 0,
      failedPaths: [],
      failedPathsTruncated: false,
    },
    changes: {
      total: 0,
      added: [],
      modified: [],
      deleted: [],
      truncated: false,
      branchChanged: false,
      manifestChanged: false,
      configChanged: false,
      grammarChanged: false,
    },
    diagnostics: [{
      code: "GRAPH_STATUS_UNAVAILABLE",
      severity: "warning",
      message,
    }],
  };
}

function isPopulatedGroundingCandidate(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  if (!normalized.includes("/context/") && !normalized.includes("/patterns/")) return false;
  if (normalized.endsWith("/patterns/README.md") || normalized.endsWith("/patterns/INDEX.md")) return false;
  try {
    const content = readFileSync(filePath, "utf-8");
    return !content.includes("[YYYY-MM-DD]") && content.trim().length > 0;
  } catch {
    return false;
  }
}

/** Find all markdown files that are part of the scaffold */
export function findScaffoldFiles(
  projectRoot: string,
  scaffoldRoot: string,
  patterns: readonly string[] = DEFAULT_SCAFFOLD_PATTERNS
): string[] {
  const files: string[] = [];

  // Search inside scaffold root (handles both .mex/ and root layouts).
  // follow: true supports symlinked scaffold content; deduplicating by real
  // path keeps one file reached through two links a single scan entry, and
  // glob bounds symlink loops so runaway scans stay off the table (#40).
  const seenReal = new Set<string>();
  for (const pattern of patterns) {
    for (const match of globSync(pattern, {
      cwd: scaffoldRoot,
      absolute: true,
      follow: true,
      ignore: ["node_modules/**"],
    })) {
      let real: string;
      try {
        real = realpathSync(match);
      } catch {
        real = match;
      }
      if (seenReal.has(real)) continue;
      seenReal.add(real);
      files.push(match);
    }
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
