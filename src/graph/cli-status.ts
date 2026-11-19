import { collectGraphGarbage, graphLocation, whatMexStores } from "./storage.js";
import type { GraphStatus, GraphSourceChanges } from "../team/contracts/graph.js";
import type { Diagnostic } from "../team/contracts/shared.js";
import type { GraphCommandOptions } from "./cli-graph.js";
import { inspectGraphStatus } from "./status.js";
import { openRecordReadOnly } from "../record/index.js";
import { latestBuildUsage } from "../record/build-usage.js";
import { readGraphState } from "./jobs.js";
/** Graph health and freshness. Reads only, apart from collecting unreferenced graph files. */
export async function runGraphStatus(options: GraphCommandOptions = {}): Promise<void> {
  const rootDir = options.root ?? process.cwd();
  const location = graphLocation(rootDir);
  collectGraphGarbage(location);
  const stores = whatMexStores(location.recordDirectory);
  const status = await inspectGraphStatus({ projectRoot: rootDir });
  const usage = lastUsage(location.projectId, location.root);
  const warm = readGraphState(location.directory);
  if (options.json) console.log(JSON.stringify({ ...status, stores, ...(usage ? { usage } : {}), ...(warm ? { warm } : {}) }, null, 2));
  else {
    printStatus(status);
    if (warm?.warm === "off") {
      console.log(`WARNING GRAPH_WARM_PATH_OFF: on ${warm.checkedAt.slice(0, 10)} a full rebuild differed from the graph in ${warm.differing?.length ?? 0} file(s); edits refresh cold until a weekly check matches.`);
    } else if (warm) console.log(`Full-rebuild check: matched on ${warm.checkedAt.slice(0, 10)}`);
    printStores(stores, location.projectId);
  }
}

/** The last build and refresh in the usage log, when the record has them. */
function lastUsage(projectId: string, checkout: string): ReturnType<typeof latestBuildUsage> | undefined {
  try {
    const reader = openRecordReadOnly();
    if (!reader) return undefined;
    try {
      if (reader.version < 6) return undefined;
      return latestBuildUsage(reader, projectId, checkout);
    } finally {
      reader.close();
    }
  } catch {
    return undefined;
  }
}

function megabytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** "What MEX stores": every project's index folder, against the shared cap. */
function printStores(stores: ReturnType<typeof whatMexStores>, current: string): void {
  console.log(`What MEX stores: ${megabytes(stores.bytes)} of ${megabytes(stores.cap)} (least recently used projects are removed first)`);
  for (const project of [...stores.projects].sort((left, right) => right.lastUse - left.lastUse)) {
    const used = project.lastUse ? new Date(project.lastUse).toISOString().slice(0, 10) : "not recorded";
    console.log(`  ${project.projectId === current ? "* " : "  "}${project.folder}: graph ${megabytes(project.graphBytes)}, file index ${megabytes(project.fileIndexBytes)}, `
      + `${project.checkouts.length} checkout${project.checkouts.length === 1 ? "" : "s"}, last used ${used}`);
  }
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

