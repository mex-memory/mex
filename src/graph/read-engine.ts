import { GraphStore } from "./db/store.js";
import type { SqliteDatabase } from "./db/sqlite.js";
import type { GraphEngine } from "./engine.js";
import { getCallees, getCallers, getIncoming, getOutgoing } from "./traversal/traversal.js";

/** Adopt a validated immutable connection without loading extraction or maintenance. */
export function createGraphReadEngine(database: SqliteDatabase): GraphEngine {
  const store = new GraphStore(database);
  const readonly = async (): Promise<never> => { throw new Error("A read-only graph engine cannot build or synchronize an index."); };
  return {
    build: readonly,
    sync: readonly,
    searchNodes: (query, options) => store.search(query, options),
    searchSource: (query, limit = 40) => store.searchSourceChunks(query, limit).map(({ id: _id, ...hit }) => hit),
    getIndexedFiles: () => store.getAllFileRecords().map(file => ({
      path: file.path, contentHash: file.contentHash, parseStatus: file.parseStatus ?? "ok",
      diagnosticCount: file.diagnosticCount ?? 0, errorCoverage: file.errorCoverage ?? 0, nodeCount: file.nodeCount,
    })),
    getNode: id => store.getNodeById(id),
    getCallers: id => getCallers(store, id),
    getCallees: id => getCallees(store, id),
    getIncoming: (id, kinds) => getIncoming(store, id, kinds),
    getOutgoing: (id, kinds) => getOutgoing(store, id, kinds),
    close: () => database.close(),
  };
}
