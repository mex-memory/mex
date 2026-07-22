// ============================================================================
// mex code-graph — GraphEngine interface  (FROZEN — Phase 0, spec §4/§6/§9)
// ============================================================================
//
// The reader/builder surface over the SQLite graph. Track A implements this by
// porting the demo's extraction + DB + traversal (spec §10 Track A); Track B and
// the grounding checker develop against it as a stub. Adapted from
// `.demo/engine/contract.ts` — narrowed to the graph-facing verbs mex 0.7.0
// needs (build/sync/search/traversal), dropping the demo's unit-authoring verbs
// (scopeSelect/clusterFacts/storeUnit/getStaleUnits) which OSS handles through
// scaffold frontmatter, not a `units` table.
//
// SYNC vs ASYNC (deliberate — see spec §6 discussion in the handoff):
//   * build / sync are ASYNC — they lazy-load tree-sitter WASM grammars.
//   * reader methods (searchNodes / getNode / getCallers / getCallees) are
//     SYNCHRONOUS — they are plain `node:sqlite` reads with no grammar work.
// Synchronous reads are what let the grounding checker match the existing
// (synchronous) drift-checker signature exactly (`src/graph/grounding.ts`).

import type { GraphNode, NodeKind, Language } from "./types.js";
import { NotImplementedError } from "./errors.js";

// ----------------------------------------------------------------------------
// Value types
// ----------------------------------------------------------------------------

/** Summary of a build/sync pass — for the `mex graph` CLI. */
export interface BuildResult {
  filesIndexed: number;
  nodesCreated: number;
  edgesCreated: number;
  durationMs: number;
}

/** Options for {@link GraphEngine.searchNodes}. */
export interface NodeSearchOptions {
  /** Restrict to these node kinds. */
  kinds?: NodeKind[];
  /** Restrict to these languages. */
  languages?: Language[];
  /** Cap the number of results. */
  limit?: number;
}

// ----------------------------------------------------------------------------
// The interface
// ----------------------------------------------------------------------------

/**
 * Deterministic reader/builder over the code graph. No LLM anywhere: build is
 * tree-sitter → SQLite; reads are SQL. Grounding, fingerprinting and drift are
 * layered on top (Track B) and are NOT part of this surface.
 */
export interface GraphEngine {
  /**
   * Build/rebuild the whole graph for the repo into `.mex/`. Deterministic.
   * Runs in `mex setup` for fresh installs and on `mex graph`. Async: lazy-loads
   * grammars for the languages it finds.
   *
   * @param rootDir Project root to index; defaults to the engine's configured root.
   */
  build(rootDir?: string): Promise<BuildResult>;

  /**
   * Incrementally re-extract just the given (changed) files and reconcile the
   * graph. The freshness precondition of `mex check` calls this before the
   * grounding checker runs (spec §6). Async for the same grammar-loading reason
   * as {@link build}.
   */
  sync(changedFiles: string[]): Promise<BuildResult>;

  /**
   * Full-text search over node name/qualified-name/docstring/signature (FTS5).
   * Backs `mex graph query`. Synchronous SQLite read.
   */
  searchNodes(query: string, options?: NodeSearchOptions): GraphNode[];

  /**
   * Look up one node by its Tier-1 id, or null if it no longer exists (a Tier-1
   * MISS — the trigger for reconciliation). The grounding checker uses this to
   * resolve each `grounds_to` target and read its `bodyHash`. Synchronous.
   */
  getNode(id: string): GraphNode | null;

  /** Nodes with an incoming `calls` edge to `id` (its callers). Synchronous. */
  getCallers(id: string): GraphNode[];

  /** Nodes with an outgoing `calls` edge from `id` (its callees). Synchronous. */
  getCallees(id: string): GraphNode[];

  /** Release the underlying database handle. */
  close(): void;
}

/**
 * Phase-0 throwing stub of {@link GraphEngine}. Track A replaces it with the
 * real engine. Present so Track B, the grounding checker, and Phase-2
 * integration tests can be written against the interface first.
 */
export const notImplementedGraphEngine: GraphEngine = {
  build(): Promise<BuildResult> {
    throw new NotImplementedError("GraphEngine.build");
  },
  sync(): Promise<BuildResult> {
    throw new NotImplementedError("GraphEngine.sync");
  },
  searchNodes(): GraphNode[] {
    throw new NotImplementedError("GraphEngine.searchNodes");
  },
  getNode(): GraphNode | null {
    throw new NotImplementedError("GraphEngine.getNode");
  },
  getCallers(): GraphNode[] {
    throw new NotImplementedError("GraphEngine.getCallers");
  },
  getCallees(): GraphNode[] {
    throw new NotImplementedError("GraphEngine.getCallees");
  },
  close(): void {
    throw new NotImplementedError("GraphEngine.close");
  },
};
