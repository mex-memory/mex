// ============================================================================
// mex code-graph — `mex graph` command  (A6)
// ============================================================================
//
// Build/rebuild the code graph into `.mex/graph.db`. Deterministic (tree-sitter
// → SQLite, zero LLM). Runs in `mex setup` for fresh installs and on demand.
// Kept self-contained so `src/cli.ts` wires it with a single lazy import (like
// every other command), never disturbing the existing surface.

import { createGraphEngine } from "./index.js";

export interface GraphCommandOptions {
  /** Project root to index (defaults to cwd). */
  root?: string;
  /** Emit the build summary as JSON. */
  json?: boolean;
}

/**
 * Run `mex graph`: build the whole graph and print a one-line (or JSON) summary.
 * Degrades loudly on failure (a clear message + non-zero exit) rather than
 * leaving a half-written DB — the caller (`cli.ts`) maps a throw to `exit(1)`.
 */
export async function runGraph(options: GraphCommandOptions = {}): Promise<void> {
  const rootDir = options.root ?? process.cwd();
  const engine = createGraphEngine({ rootDir });
  try {
    const result = await engine.build(rootDir);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `Code graph built: ${result.nodesCreated} nodes, ${result.edgesCreated} edges ` +
          `across ${result.filesIndexed} files in ${result.durationMs}ms → .mex/graph.db`,
      );
    }
  } finally {
    engine.close();
  }
}
