// ============================================================================
// Grounding coverage — read-only
// ============================================================================
//
// Answers one question the dashboard needs and nothing else can answer: has the
// grounding your agent authored in `.mex/` actually been fingerprinted against
// the graph?
//
// It matters because grounding is a two-party contract. The agent writes
// `grounds_to` entries and `mex://` anchors into the Markdown; mex then records
// the current body of each referenced symbol as a baseline. Drift detection
// compares against those baselines, so authored-but-uncaptured grounding looks
// like documentation that mex silently cannot verify.
//
// `mex setup` captures baselines right after the agent finishes. The web wizard
// hands you the prompt and loses control at that moment, so the dashboard has to
// be able to notice the gap and offer to close it.

import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { globSync } from "glob";
import { openGraphDatabase } from "../graph/db/database.js";
import { GraphRebuildRequiredError } from "../graph/errors.js";
import { extractGroundings, findMexAnchors } from "../markdown.js";

export interface GroundingFileCoverage {
  /** Project-relative scaffold file, e.g. `.mex/context/stack.md`. */
  file: string;
  /** Distinct node ids referenced by `grounds_to` entries and `mex://` anchors. */
  authored: number;
  /** How many of those have a stored baseline. */
  captured: number;
}

export interface GroundingCoverage {
  /** False when there is no graph to fingerprint against. */
  graphAvailable: boolean;
  /** Total distinct (file, node) references authored across the scaffold. */
  authored: number;
  /** How many of those have a baseline recorded in the graph. */
  captured: number;
  /**
   * True when the agent authored grounding that has never been captured — the
   * one state with an action attached.
   */
  needsCapture: boolean;
  /** Only files that reference at least one node, worst coverage first. */
  files: GroundingFileCoverage[];
  /** Set when coverage could not be read; the rest of the payload is zeroed. */
  error: string | null;
}

export interface ReadGroundingCoverageOptions {
  root: string;
}

/**
 * Read grounding coverage for the project at `root`. Never throws: a missing
 * scaffold, a missing graph, and an unreadable graph are all reported in the
 * payload, because none of them is a reason to fail a dashboard panel.
 */
export function readGroundingCoverage(options: ReadGroundingCoverageOptions): GroundingCoverage {
  const projectRoot = resolve(options.root);
  const scaffoldRoot = resolve(projectRoot, ".mex");

  if (!existsSync(scaffoldRoot)) return empty(false);

  let authoredByFile: Map<string, Set<string>>;
  try {
    authoredByFile = readAuthoredReferences(projectRoot, scaffoldRoot);
  } catch (error) {
    return { ...empty(false), error: messageOf(error) };
  }

  const dbPath = resolve(scaffoldRoot, "graph.db");
  if (!existsSync(dbPath)) return summarize(authoredByFile, new Set(), false);

  let db: ReturnType<typeof openGraphDatabase> | null = null;
  try {
    db = openGraphDatabase(dbPath, { readOnly: true });
    const rows = db
      .prepare("SELECT scaffold_file, node_id FROM _mex_grounded_source")
      .all() as Array<{ scaffold_file: string; node_id: string }>;
    const captured = new Set(rows.map((row) => key(row.scaffold_file, row.node_id)));
    return summarize(authoredByFile, captured, true);
  } catch (error) {
    // A graph built by another mex version can't be read, but the authored
    // count is still true and worth reporting.
    const message =
      error instanceof GraphRebuildRequiredError ? error.message : messageOf(error);
    return { ...summarize(authoredByFile, new Set(), false), error: message };
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a database that never opened cleanly is not worth reporting.
    }
  }
}

/**
 * Distinct node ids referenced per scaffold file. Uses the same extractors the
 * engine uses when it captures baselines, so the two can never disagree about
 * what counts as a reference.
 */
function readAuthoredReferences(
  projectRoot: string,
  scaffoldRoot: string,
): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();

  for (const absolute of globSync("**/*.md", { cwd: scaffoldRoot, absolute: true, nodir: true })) {
    let content: string;
    try {
      content = readFileSync(absolute, "utf-8");
    } catch {
      continue;
    }
    const nodeIds = new Set([
      ...extractGroundings(content).map((grounding) => grounding.node),
      ...findMexAnchors(content).map((anchor) => anchor.nodeId),
    ]);
    if (nodeIds.size === 0) continue;
    // The engine keys baselines by project-relative posix path.
    byFile.set(relative(projectRoot, absolute).replaceAll("\\", "/"), nodeIds);
  }

  return byFile;
}

function summarize(
  authoredByFile: Map<string, Set<string>>,
  captured: ReadonlySet<string>,
  graphAvailable: boolean,
): GroundingCoverage {
  const files: GroundingFileCoverage[] = [...authoredByFile]
    .map(([file, nodeIds]) => ({
      file,
      authored: nodeIds.size,
      captured: [...nodeIds].filter((nodeId) => captured.has(key(file, nodeId))).length,
    }))
    .sort(
      (a, b) =>
        a.captured / a.authored - b.captured / b.authored || b.authored - a.authored,
    );

  const authored = files.reduce((total, file) => total + file.authored, 0);
  const capturedTotal = files.reduce((total, file) => total + file.captured, 0);

  return {
    graphAvailable,
    authored,
    captured: capturedTotal,
    needsCapture: graphAvailable && authored > 0 && capturedTotal < authored,
    files,
    error: null,
  };
}

function empty(graphAvailable: boolean): GroundingCoverage {
  return {
    graphAvailable,
    authored: 0,
    captured: 0,
    needsCapture: false,
    files: [],
    error: null,
  };
}

function key(scaffoldFile: string, nodeId: string): string {
  return `${scaffoldFile}\u0000${nodeId}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
