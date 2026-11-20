// Background graph jobs (graph-02).
//
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
