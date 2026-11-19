import { graphCoverage, installGraphReadCoverage } from "./read-coverage.js";
import { GraphStore } from "./db/store.js";
import type { SqliteDatabase } from "./db/sqlite.js";
import type { GraphEngine } from "./engine.js";
import { getCallees, getCallers, getIncoming, getOutgoing } from "./traversal/traversal.js";

/** Adopt a validated immutable connection without loading extraction or maintenance. */
export function createGraphReadEngine(database: SqliteDatabase, root?: string): GraphEngine {
  installGraphReadCoverage(database);
  const store = new GraphStore(database);
  const hasCoverage = !!database.prepare("SELECT 1 FROM sqlite_master WHERE name='coverage' AND type='table'").get();
  const coverageRow = hasCoverage ? database.prepare("SELECT reason FROM coverage WHERE path=?") : null;
  const reasonFor = (path: string): string | undefined => (coverageRow?.get(path) as { reason: string } | undefined)?.reason;
  const visible = (nodes: import("./types.js").GraphNode[]) => hasCoverage ? nodes.filter(node => reasonFor(node.filePath) === undefined) : nodes;
  const readonly = async (): Promise<never> => { throw new Error("A read-only graph engine cannot build or synchronize an index."); };
  return {
    coverageFor: (path) => {
      const posix = path.replaceAll("\\", "/");
      const reason = reasonFor(posix);
      if (reason !== undefined || !root) return reason !== undefined ? { indexed: false, reason } : store.getFileRecord(posix) ? { indexed: true } : { indexed: false, reason: "not indexed" };
      return graphCoverage(posix, undefined, store.getFileRecord(posix) !== null, root);
    },
    build: readonly,
    sync: readonly,
    searchNodes: (query, options) => visible(store.search(query, options)),
    searchSource: (query, limit = 40) => store.searchSourceChunks(query, limit).map(({ id: _id, ...hit }) => hit),
    getIndexedFiles: () => store.getAllFileRecords().map(file => ({
      path: file.path, contentHash: file.contentHash, parseStatus: file.parseStatus ?? "ok",
      diagnosticCount: file.diagnosticCount ?? 0, errorCoverage: file.errorCoverage ?? 0, nodeCount: file.nodeCount,
    })),
    getNode: id => { const node = store.getNodeById(id); return node && (!hasCoverage || reasonFor(node.filePath) === undefined) ? node : null; },
    getCallers: id => visible(getCallers(store, id)),
    getCallees: id => visible(getCallees(store, id)),
    getIncoming: (id, kinds) => getIncoming(store, id, kinds),
    getOutgoing: (id, kinds) => getOutgoing(store, id, kinds),
    close: () => database.close(),
  };
}
