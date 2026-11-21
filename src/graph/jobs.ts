// Background graph jobs (graph-02, graph-03).
//
//   graph-build    The code map setup queues after the file index (setup job
//                  rows, contracts/setup-jobs.md): a build, or a refresh when a
//                  graph exists. It reports "N of M files" while reading code,
//                  like the file index, and ends with the free pass that moves
//                  notes from file hashes to fingerprints. Files the map
//                  couldn't read end it "done with gaps", with the reason.
//   graph-refresh  A checkout's cold refresh: after a warm checkout cools, or
//                  when edits the warm path could not take have gone quiet.
//   graph-verify   Weekly: a fresh build of the checkout must give the same
//                  rows as its base plus overlay, or the warm path turns off
//                  for the repository (graph-state.json) until a check passes.
//
// The graph code loads only when a batch runs, so listing jobs stays cheap.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { registerJobKind } from "../record/jobs.js";

export interface GraphJobParams { checkout: string }

/** Where a project's warm-path state lives: beside its graph files. */
export function graphStateFile(indexDirectory: string): string {
  return join(indexDirectory, "graph-state.json");
}

export interface GraphState {
  version: 1;
  /** "off" after a full rebuild differed from the incremental graph. */
  warm: "on" | "off";
  checkedAt: string;
  /** The checkout the last check built, and the files that differed. */
  checkout?: string;
  differing?: string[];
}

export function readGraphState(indexDirectory: string): GraphState | undefined {
  try {
    const state = JSON.parse(readFileSync(graphStateFile(indexDirectory), "utf8")) as GraphState;
    return state.version === 1 && (state.warm === "on" || state.warm === "off") ? state : undefined;
  } catch {
    return undefined;
  }
}

export function writeGraphState(indexDirectory: string, state: GraphState): void {
  const file = graphStateFile(indexDirectory);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

/** A check is due once a week. */
export const GRAPH_VERIFY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** What the build is doing, in the words the jobs list and the setup screen show. */
export function graphBuildProgress(update: { phase: string; completed?: number; total?: number }): string {
  if (update.phase === "parse" && update.total !== undefined && update.completed !== undefined) {
    return `${update.completed.toLocaleString("en-US")} of ${update.total.toLocaleString("en-US")} files`;
  }
  switch (update.phase) {
    case "discover": return "finding the code to map";
    case "stage": return "preparing the build";
    case "parse": return "reading code";
    case "resolve": return "connecting calls and imports";
    case "validate": return "checking the map";
    default: return "saving the map";
  }
}

function plural(n: number, word: string): string { return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`; }

registerJobKind<GraphJobParams, { runs: number }>({
  name: "graph-build",
  label: "Code map",
  scope: "project",
  // A build publishes a new file and moves a pointer; running it twice is harmless.
  sideEffects: "idempotent",
  async runBatch({ params, checkpoint, progress }) {
    const { ensureGraphCurrent } = await import("./maintenance.js");
    let last = 0;
    const result = await ensureGraphCurrent(params.checkout, {
      candidateExecution: "process",
      onProgress: progress ? (update) => {
        // The jobs table keeps one line; parse counts at most once a second.
        const now = Date.now();
        if (update.phase !== "parse" || update.completed === update.total || now - last >= 1000) {
          last = now;
          progress(graphBuildProgress(update));
        }
      } : undefined,
    });
    const { upgradeEntryChecks } = await import("../knowledge/check-upgrade.js");
    const upgrade = upgradeEntryChecks({ projectPath: params.checkout });
    const skipped = result.skipped ?? [];
    const parts = [result.operation === "unchanged"
      ? "The code map was already current"
      : `Code map ${result.operation === "rebuild" ? "built" : "refreshed"}: ${plural(result.filesIndexed, "file")}, ${plural(result.nodesCreated, "definition")}`];
    if (upgrade.upgraded > 0) parts.push(`${plural(upgrade.upgraded, "note")} now checked by code fingerprint`);
    if (skipped.length > 0) {
      const reasons = [...new Set(skipped.map((s) => s.reason === "corpus-limit" ? "too big" : s.reason))].join(", ");
      parts.push(`${plural(skipped.length, "file")} not mapped (${reasons})`);
    }
    return {
      checkpoint: { runs: (checkpoint?.runs ?? 0) + 1 },
      done: true,
      gaps: skipped.length > 0,
      results: result.filesIndexed,
      summary: parts.join("; "),
    };
  },
});

registerJobKind<GraphJobParams, { runs: number }>({
  name: "graph-refresh",
  label: "Graph refresh",
  scope: "project",
  // A refresh publishes a new file and moves a pointer; running it twice is harmless.
  sideEffects: "idempotent",
  async runBatch({ params, checkpoint }) {
    const { ensureGraphCurrent } = await import("./maintenance.js");
    const result = await ensureGraphCurrent(params.checkout, { candidateExecution: "process" });
    // The graph is ready: entries that link code by file hash get fingerprints.
    const { upgradeEntryChecks } = await import("../knowledge/check-upgrade.js");
    upgradeEntryChecks({ projectPath: params.checkout });
    return {
      checkpoint: { runs: (checkpoint?.runs ?? 0) + 1 },
      done: true,
      results: result.filesIndexed,
      summary: result.operation === "unchanged" ? "The graph was already current" : `Graph ${result.operation}: ${result.filesIndexed} files`,
    };
  },
});

registerJobKind<GraphJobParams, { runs: number }>({
  name: "graph-verify",
  label: "Graph check",
  scope: "project",
  sideEffects: "idempotent",
  async runBatch({ params, checkpoint }) {
    const { verifyGraph } = await import("./verify.js");
    const outcome = await verifyGraph(params.checkout);
    return {
      checkpoint: { runs: (checkpoint?.runs ?? 0) + 1 },
      done: true,
      results: outcome.files,
      summary: outcome.status === "skipped" ? `Not checked: ${outcome.reason}`
        : outcome.status === "match" ? `A full rebuild matched the graph (${outcome.files} files)`
        : `A full rebuild differed in ${outcome.differing.length} files; the warm path is off for this repository`,
    };
  },
});
