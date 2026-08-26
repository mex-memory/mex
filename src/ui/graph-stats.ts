// ============================================================================
// Read-only code-graph statistics
// ============================================================================
//
// Aggregates counts out of an existing `.mex/graph.db` for the dashboard. Opens
// the database through the engine's read-only path, which asserts `query_only`
// and refuses a schema the current build can't read — so viewing stats can
// never mutate or migrate the index.
//
// Kept separate from `readSnapshot` because opening SQLite is the one expensive
// part of rendering the dashboard.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openGraphDatabase } from "../graph/db/database.js";
import { GraphStore, type GraphHealthSummary } from "../graph/db/store.js";
import { GraphRebuildRequiredError } from "../graph/errors.js";
import type { EdgeKind, Language, NodeKind } from "../graph/types.js";

export interface CountByKind<T extends string> {
  kind: T;
  count: number;
}

export interface LanguageStats {
  language: Language;
  files: number;
  nodes: number;
}

export interface IndexedFileSummary {
  path: string;
  language: Language;
  nodeCount: number;
  parseStatus: "ok" | "partial" | "failed";
  /** ISO timestamp of the file's last on-disk modification. */
  modifiedAt: string;
  /** ISO timestamp of when the graph last indexed it. */
  indexedAt: string;
}

export type GraphStatsUnavailableReason = "missing" | "needs-rebuild" | "error";

export interface GraphStats {
  available: boolean;
  /** Set only when `available` is false. */
  unavailable: { reason: GraphStatsUnavailableReason; message: string } | null;
  totals: { nodes: number; edges: number; files: number };
  health: GraphHealthSummary;
  nodesByKind: CountByKind<NodeKind>[];
  edgesByKind: CountByKind<EdgeKind>[];
  languages: LanguageStats[];
  /** Most recently indexed files, newest first. */
  recentFiles: IndexedFileSummary[];
  /** Manifest hash recorded by the last successful build, when present. */
  manifestHash: string | null;
}

export interface ReadGraphStatsOptions {
  root: string;
  /** How many entries to include in `recentFiles`. */
  recentFileLimit?: number;
}

const EMPTY_HEALTH: GraphHealthSummary = {
  indexedFiles: 0,
  okFiles: 0,
  partialFiles: 0,
  failedFiles: 0,
};

/**
 * Read aggregate graph statistics for the project at `root`. Never throws — a
 * missing or incompatible index is reported as `available: false` with a reason
 * the UI can turn into the right call to action (build vs rebuild).
 */
export function readGraphStats(options: ReadGraphStatsOptions): GraphStats {
  const { root, recentFileLimit = 8 } = options;
  const dbPath = resolve(root, ".mex", "graph.db");

  if (!existsSync(dbPath)) {
    return unavailable("missing", "No code graph has been built for this project yet.");
  }

  let db: ReturnType<typeof openGraphDatabase> | null = null;
  try {
    db = openGraphDatabase(dbPath, { readOnly: true });
    const store = new GraphStore(db);

    const nodes = store.getAllNodes();
    const edges = store.getAllEdges();
    const fileRecords = store.getAllFileRecords();

    const nodesByKind = tally(nodes.map((node) => node.kind));
    const edgesByKind = tally(edges.map((edge) => edge.kind));

    const nodesPerLanguage = new Map<Language, number>();
    for (const node of nodes) {
      nodesPerLanguage.set(node.language, (nodesPerLanguage.get(node.language) ?? 0) + 1);
    }
    const filesPerLanguage = new Map<Language, number>();
    for (const record of fileRecords) {
      filesPerLanguage.set(record.language, (filesPerLanguage.get(record.language) ?? 0) + 1);
    }

    const languages: LanguageStats[] = [...new Set([...filesPerLanguage.keys(), ...nodesPerLanguage.keys()])]
      .map((language) => ({
        language,
        files: filesPerLanguage.get(language) ?? 0,
        nodes: nodesPerLanguage.get(language) ?? 0,
      }))
      .sort((a, b) => b.nodes - a.nodes || b.files - a.files);

    const recentFiles: IndexedFileSummary[] = [...fileRecords]
      .sort((a, b) => b.indexedAt - a.indexedAt || b.modifiedAt - a.modifiedAt)
      .slice(0, recentFileLimit)
      .map((record) => ({
        path: record.path,
        language: record.language,
        nodeCount: record.nodeCount,
        parseStatus: record.parseStatus ?? "ok",
        modifiedAt: new Date(record.modifiedAt).toISOString(),
        indexedAt: new Date(record.indexedAt).toISOString(),
      }));

    return {
      available: true,
      unavailable: null,
      totals: { nodes: nodes.length, edges: edges.length, files: fileRecords.length },
      health: store.getHealthSummary(),
      nodesByKind,
      edgesByKind,
      languages,
      recentFiles,
      manifestHash: store.getMetadata("manifest_hash"),
    };
  } catch (error) {
    if (error instanceof GraphRebuildRequiredError) {
      return unavailable("needs-rebuild", error.message);
    }
    return unavailable("error", error instanceof Error ? error.message : String(error));
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a database that failed to open cleanly is not worth reporting.
    }
  }
}

function unavailable(reason: GraphStatsUnavailableReason, message: string): GraphStats {
  return {
    available: false,
    unavailable: { reason, message },
    totals: { nodes: 0, edges: 0, files: 0 },
    health: EMPTY_HEALTH,
    nodesByKind: [],
    edgesByKind: [],
    languages: [],
    recentFiles: [],
    manifestHash: null,
  };
}

function tally<T extends string>(values: readonly T[]): CountByKind<T>[] {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}
