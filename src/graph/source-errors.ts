import { GRAPH_CORPUS_LIMITS } from "./corpus-policy.js";

export interface GraphSourceStagingFailure {
  filePath: string;
  operation: "stat" | "read" | "discover" | "parse";
  code?: string;
  message: string;
}

/** A structural sync never publishes a corpus whose source discovery was incomplete. */
export class GraphSourceStagingError extends Error {
  readonly code = "GRAPH_SOURCE_STAGING_FAILED";
  readonly failures: GraphSourceStagingFailure[];

  constructor(failures: GraphSourceStagingFailure[]) {
    const boundedFailures = failures.slice(0, GRAPH_CORPUS_LIMITS.maxDiagnostics);
    const omitted = failures.length - boundedFailures.length;
    super(`Could not stage ${failures.length} source file(s): ${boundedFailures.map((failure) => failure.filePath).join(", ")}${omitted > 0 ? ` (${omitted} more omitted)` : ""}`);
    this.name = "GraphSourceStagingError";
    this.failures = boundedFailures;
  }
}

