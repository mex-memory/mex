import type {
  GraphRefreshResult, GraphSourceChanges, GraphStatus,
} from "../team/contracts/graph.js";
import {
  GraphMaintenanceError,
  repairGraph,
  rebuildGraph,
  refreshGraph,
  type GraphMaintenanceResult,
} from "./maintenance.js";
import { inspectGraphStatus } from "./status.js";
import {
  unindexedExtensionHistogram,
  type GraphCoverageHistogram,
} from "./corpus-policy.js";

export interface GraphCommandOptions {
  /** Project root to inspect or maintain (defaults to cwd). */
  root?: string;
  /** Emit the complete machine-readable result. */
  json?: boolean;
}

/** Strictly read-only graph health/freshness command. */
export async function runGraphStatus(options: GraphCommandOptions = {}): Promise<void> {
  const rootDir = options.root ?? process.cwd();
  const status = await inspectGraphStatus({ projectRoot: rootDir });
  if (options.json) console.log(JSON.stringify(status, null, 2));
  else printStatus(status);
}

/** Explicit correctness-first refresh through the existing full semantic sync path. */
export async function runGraphRefresh(options: GraphCommandOptions = {}): Promise<void> {
  const rootDir = options.root ?? process.cwd();
  const result = await refreshGraph(rootDir);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printMaintenance("refreshed", result);
}

/** Explicit isolated candidate rebuild with atomic publication and recovery. */
export async function runGraphRebuild(options: GraphCommandOptions = {}): Promise<void> {
  const rootDir = options.root ?? process.cwd();
  const result = await rebuildGraph(rootDir);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printMaintenance("rebuilt", result);
}

/** Backward-compatible `mex graph`, now implemented as a safe rebuild. */
export async function runGraph(options: GraphCommandOptions = {}): Promise<void> {
  const rootDir = options.root ?? process.cwd();
  const result = await rebuildGraph(rootDir);
  const coverage = unindexedExtensionHistogram(rootDir);
  if (options.json) {
    console.log(JSON.stringify({
      filesIndexed: result.filesIndexed,
      nodesCreated: result.nodesCreated,
      edgesCreated: result.edgesCreated,
      durationMs: result.durationMs,
      health: {
        ok: result.status.parseHealth.ok,
        partial: result.status.parseHealth.partial,
        failed: result.status.parseHealth.failed,
      },
      ...(coverage.total > 0
        ? {
            unindexedSources: {
              total: coverage.total,
              byExtension: Object.fromEntries(coverage.entries.map((e) => [e.extension, e.files])),
              truncated: coverage.truncated,
            },
          }
        : {}),
      ...(result.skipped && result.skipped.length > 0 ? { skipped: result.skipped } : {}),
      ...(result.declinedInputs && result.declinedInputs.length > 0
        ? { declinedInputs: result.declinedInputs }
        : {}),
    }, null, 2));
    return;
  }
  console.log(
    `Code graph built: ${result.nodesCreated} nodes, ${result.edgesCreated} edges `
      + `across ${result.filesIndexed} files in ${result.durationMs}ms → .mex/graph.db`,
  );
  printUnindexedSources(coverage);
  printSkippedSources(result.skipped);
  printDeclinedInputs(result.declinedInputs);
}

/**
 * Name the source files no extractor handles, grouped by extension.
 *
 * `filesIndexed` alone cannot distinguish "nothing to index" from "everything
 * except the languages we don't support" — the second looks identical to the
 * first from `Code graph built: 0 nodes`, and an agent asking about a symbol
 * that exists in a `.svelte` or `.go` file gets the same `TARGET_NOT_FOUND`
 * a typo gets. Absent when the histogram found nothing, so existing outputs
 * (and every script consuming them) are unchanged for fully supported repos.
 */
function printUnindexedSources(coverage: GraphCoverageHistogram): void {
  if (coverage.total === 0) return;
  const shown = coverage.entries.slice(0, MAX_SKIPPED_PATHS_SHOWN);
  const breakdown = shown.map((entry) => `${entry.extension} (${entry.files})`).join(", ");
  console.log(
    `Not indexed: ${coverage.total} source file(s) have extensions no extractor handles: ${breakdown}`,
  );
  if (coverage.entries.length > shown.length) {
    console.log("  …and more extensions (use --json for the full breakdown)");
  }
  if (coverage.truncated) {
    console.log("  (count may be higher: the repository walk stopped early)");
  }
}

/**
 * Name the files that are deliberately missing from the graph.
 *
 * Silence here is what made an oversized file look like a graph bug: a symbol
 * was simply absent with nothing to explain it.
 */
function printSkippedSources(skipped: GraphRefreshResult["skipped"]): void {
  if (!skipped || skipped.length === 0) return;
  const shown = skipped.slice(0, MAX_SKIPPED_PATHS_SHOWN);
  console.log(`Skipped ${skipped.length} file(s) the bounded corpus policy will not index:`);
  for (const file of shown) console.log(`  ${file.filePath} — ${file.message}`);
  const omitted = skipped.length - shown.length;
  if (omitted > 0) console.log(`  …and ${omitted} more (use --json for the full list)`);
  console.log("Add a glob to \"graph.ignore\" in .mex/config.json to exclude a path deliberately.");
}

/**
 * Name the config inputs the graph refused to read.
 *
 * Every source file is still in the graph; what is reduced is type resolution
 * for the affected project, which is otherwise invisible.
 */
function printDeclinedInputs(declined: GraphRefreshResult["declinedInputs"]): void {
  if (!declined || declined.length === 0) return;
  const shown = declined.slice(0, MAX_SKIPPED_PATHS_SHOWN);
  console.log(
    `Declined ${declined.length} TypeScript config input(s) outside the project; `
      + "type resolution for the affected projects is less complete:",
  );
  for (const input of shown) console.log(`  ${input.filePath}`);
  const omitted = declined.length - shown.length;
  if (omitted > 0) console.log(`  …and ${omitted} more (use --json for the full list)`);
}

/** Human output stays bounded; `--json` carries the complete list. */
const MAX_SKIPPED_PATHS_SHOWN = 10;

/**
 * Explain a maintenance failure with the observation that caused it.
 *
 * A failed publication used to print one sentence naming the status it
 * refused, and discard the diagnostics the error carries. That left a user
 * with a long build, no graph, and no way to learn which file was responsible
 * or what was skipped along the way.
 */
export function describeGraphMaintenanceFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof GraphMaintenanceError) || error.diagnostics.length === 0) return message;
  const lines = [message];
  const shown = error.diagnostics.slice(0, MAX_DIAGNOSTICS_SHOWN);
  lines.push(`Observed ${error.diagnostics.length} diagnostic(s):`);
  for (const diagnostic of shown) {
    const path = (diagnostic as { path?: unknown }).path;
    const where = typeof path === "string" ? ` [${path}]` : "";
    lines.push(`  ${diagnostic.severity.toUpperCase()} ${diagnostic.code}${where}: ${diagnostic.message}`);
  }
  const omitted = error.diagnostics.length - shown.length;
  if (omitted > 0) lines.push(`  …and ${omitted} more`);
  const command = error.diagnostics
    .flatMap((diagnostic) => diagnostic.remediation ?? [])
    .find((action) => action.command)?.command;
  if (command) lines.push(`Next: ${command}`);
  if (error.recoveryPath) lines.push(`Previous index retained at: ${error.recoveryPath}`);
  return lines.join("\n");
}

const MAX_DIAGNOSTICS_SHOWN = 20;

function printStatus(status: GraphStatus): void {
  const branch = status.currentRepo.branch ?? "detached/no branch";
  const head = status.currentRepo.head?.slice(0, 12) ?? "no HEAD";
  const changes = status.changes;
  console.log(`Graph status: ${status.status}`);
  console.log(`Repository: ${branch} @ ${head}${status.currentRepo.dirty ? " (dirty)" : ""}`);
  console.log(`Last successful index: ${status.lastSuccessfulIndexAt ?? "never"}`);
  console.log(formatGraphSourceChanges(changes));
  console.log(
    `Parse health: ${status.parseHealth.ok} ok, ${status.parseHealth.partial} partial, `
      + `${status.parseHealth.failed} failed`,
  );
  for (const diagnostic of status.diagnostics) {
    console.log(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
  }
  const command = status.diagnostics
    .flatMap((diagnostic) => diagnostic.remediation ?? [])
    .find((action) => action.command)?.command;
  if (command) console.log(`Next: ${command}`);
}

/** Internal human-output formatter; JSON output retains the complete contract. */
export function formatGraphSourceChanges(changes: GraphSourceChanges): string {
  if (changes.truncated) {
    const shown = changes.added.length + changes.modified.length + changes.deleted.length;
    const omitted = Math.max(0, changes.total - shown);
    const omission = omitted > 0 ? `${omitted} paths omitted` : "path details truncated";
    return `Sources: ${changes.total} changed (`
      + `${changes.added.length} added shown, ${changes.modified.length} modified shown, `
      + `${changes.deleted.length} deleted shown; ${omission})`;
  }
  return `Sources: ${changes.total} changed `
    + `(${changes.added.length} added, ${changes.modified.length} modified, ${changes.deleted.length} deleted)`;
}

function printMaintenance(verb: "refreshed" | "rebuilt", result: GraphMaintenanceResult): void {
  console.log(
    `Code graph ${verb}: ${result.nodesCreated} nodes, ${result.edgesCreated} edges `
      + `across ${result.filesIndexed} files in ${result.durationMs}ms; status ${result.status.status}.`,
  );
  printSkippedSources(result.skipped);
  printDeclinedInputs(result.declinedInputs);
  if (result.recoveryPath) {
    console.log(`Previous index retained for local recovery: ${result.recoveryPath}`);
  }
}

/** Explicit locked candidate repair; the live graph is never opened writable. */
export async function runGraphRepair(
  input: GraphCommandOptions | string = {},
): Promise<number> {
  const options = typeof input === "string" ? { root: input } : input;
  try {
    const result = await repairGraph(options.root ?? process.cwd());
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const recovered = result.recoveredWalBytes > 0
        ? `recovered ${(result.recoveredWalBytes / 1048576).toFixed(1)} MB of WAL`
        : "no WAL data was pending";
      const schema = result.upgraded
        ? `upgraded ${result.lineage} schema ${result.fromSchemaVersion} → ${result.toSchemaVersion}`
        : `validated ${result.lineage} schema ${result.toSchemaVersion}`;
      console.log(`Graph store repaired: ${recovered}; ${schema}; status ${result.status.status}.`);
      for (const diagnostic of result.diagnostics) {
        if (diagnostic.code !== "GRAPH_INDEX_RECOVERY_CLEANUP_INCOMPLETE") continue;
        console.warn(`WARNING ${diagnostic.code}: ${diagnostic.message}`);
      }
    }
    return 0;
  } catch (error) {
    const guidance = error instanceof GraphMaintenanceError
      && (error.code === "GRAPH_INDEX_MISSING" || error.code === "GRAPH_INDEX_NOT_REPAIRABLE")
      ? " Run `mex graph rebuild`."
      : "";
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message}${message.includes("mex graph rebuild") ? "" : guidance}`);
    return 1;
  }
}
