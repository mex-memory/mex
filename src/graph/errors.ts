/**
 * Shared error type for the code-graph contract stubs.
 *
 * Phase 0 ships the frozen interfaces with throwing implementations so the whole
 * module typechecks and downstream code can import + inject the seams before the
 * real engine (Track A) and fingerprint/reconcile/grounding layer (Track B)
 * land. Every stub throws this; nothing here contains real logic.
 */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`NotImplemented: ${what} — code-graph contract stub (Phase 0). Implemented in Phase 1.`);
    this.name = "NotImplementedError";
  }
}

/** A derived graph database exists, but was produced by an incompatible engine. */
export class GraphRebuildRequiredError extends Error {
  readonly code = "GRAPH_REBUILD_REQUIRED";
  readonly recoveryCommand = "mex graph";

  constructor(message = "The code graph was built with an incompatible schema or extractor.") {
    super(`${message} Run \`mex graph\` to rebuild it.`);
    this.name = "GraphRebuildRequiredError";
  }
}
