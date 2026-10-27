import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { GraphStatus, GraphSourceChanges } from "../team/contracts/graph.js";
import type { Diagnostic } from "../team/contracts/shared.js";
import type { GraphCommandOptions } from "./cli-graph.js";
import { inspectGraphStatus } from "./status.js";
/** Strictly read-only graph health/freshness command. */
export async function runGraphStatus(options: GraphCommandOptions = {}): Promise<void> {
  const rootDir = options.root ?? process.cwd();
  const inspected = await inspectGraphStatus({ projectRoot: rootDir });
  const leftovers = await orphanGraphFileDiagnostics(rootDir, inspected);
  const status = leftovers.length > 0
    ? { ...inspected, diagnostics: [...inspected.diagnostics, ...leftovers] }
    : inspected;
  if (options.json) console.log(JSON.stringify(status, null, 2));
  else printStatus(status);
}

/**
 * Name owned graph files left under `.mex/` (issue #205). Read-only: an
 * interrupted maintenance run leaves a full-size candidate that otherwise
 * stays invisible unless someone lists the directory. The store's own status
 * is unchanged; these are reported alongside it.
 */
async function orphanGraphFileDiagnostics(rootDir: string, status: GraphStatus): Promise<Diagnostic[]> {
  let names: string[];
  try { names = readdirSync(join(rootDir, ".mex")); } catch { return []; }
  if (!names.some(name => ["graph.db.candidate-", "graph.db.rollback-", "graph.db.recovery-"].some(prefix => name.startsWith(prefix)))) return [];
  const { inspectOrphanGraphFiles } = await import("./maintenance.js");
  const files = inspectOrphanGraphFiles(rootDir);
  // A live maintenance run legitimately owns its in-progress candidate.
  if (files.maintenanceActive) return [];
  const diagnostics: Diagnostic[] = [];
  if (files.candidates.length > 0) {
    // Refresh and repair sweep as soon as they hold the lease, even when they
    // then decline the store; only a missing index is refused before that.
    const command = status.status === "missing" ? "mex graph rebuild" : "mex graph refresh";
    diagnostics.push({
      code: "GRAPH_INDEX_ORPHAN_CANDIDATE",
      severity: "warning",
      message: `${files.candidates.length} leftover graph build candidate file(s) from an interrupted `
        + "maintenance run are using disk space; the next `mex graph refresh`, `repair`, or `rebuild` "
        + "removes them when no open handle prevents deletion; locked files are retried later.",
      detail: { paths: files.candidates },
      remediation: [{ label: "Remove leftover candidates", command }],
    });
  }
  if (files.retained.length > 0) {
    diagnostics.push({
      code: "GRAPH_INDEX_RECOVERY_DATA_PRESENT",
      severity: "info",
      message: `${files.retained.length} retained graph recovery file(s) are present under .mex/; `
        + "delete them by hand once you no longer need the prior graph bytes.",
      detail: { paths: files.retained },
    });
  }
  return diagnostics;
}

function printStatus(status: GraphStatus): void {
  const branch = status.currentRepo.branch ?? "detached/no branch";
  const head = status.currentRepo.head?.slice(0, 12) ?? "no HEAD";
  const changes = status.changes;
  console.log(`Graph status: ${status.status}`);
  console.log(`Repository: ${branch} @ ${head}${status.currentRepo.dirty ? " (dirty)" : ""}`);
  if (status.inspected === false) {
    console.log("Last successful index: not inspected");
    console.log("Sources: not inspected");
    console.log("Parse health: not inspected");
  } else {
    console.log(`Last successful index: ${status.lastSuccessfulIndexAt ?? "never"}`);
    console.log(formatGraphSourceChanges(changes));
    console.log(
      `Parse health: ${status.parseHealth.ok} ok, ${status.parseHealth.partial} partial, `
        + `${status.parseHealth.failed} failed`,
    );
  }
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

