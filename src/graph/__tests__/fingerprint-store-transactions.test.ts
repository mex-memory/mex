import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSqlite, type SqliteDatabase } from "../db/sqlite.js";
import { GraphStore } from "../db/store.js";
import { FingerprintStore, upsertFingerprintsInOwnedTransaction } from "../fingerprint-store.js";
import { MIN_TOKENS } from "../config.js";
import { encodeMinhash } from "../fingerprint.js";
import type { Fingerprint } from "../reconcile.js";

const databases: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

function value(offset: number): Fingerprint {
  return {
    minhash: Array.from({ length: 64 }, (_, index) => offset + index),
    neighbors: [`neighbor:${offset}`],
    // Large enough to own LSH buckets (see `indexedInLsh`).
    tokenCount: MIN_TOKENS + offset,
  };
}

function fixture(ids = ["a", "b", "c"]): { db: SqliteDatabase; graph: GraphStore; store: FingerprintStore } {
  const db = openSqlite(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const graph = new GraphStore(db);
  for (const id of ids) {
    graph.insertNode({
      id, kind: "function", name: id, qualifiedName: id, filePath: "src/example.ts",
      language: "typescript", startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 1,
    });
  }
  const store = new FingerprintStore(db);
  store.upsertMany(ids.map((nodeId, index) => ({ nodeId, fingerprint: value(index + 1) })));
  return { db, graph, store };
}

function rows(db: SqliteDatabase) {
  return {
    fingerprints: db.prepare(
      "SELECT CAST(ref AS TEXT) AS ref, node_id, hex(minhash) AS minhash, neighbors, token_count FROM node_fingerprints ORDER BY node_id",
    ).all(),
    buckets: db.prepare(
      "SELECT band, CAST(band_hash AS TEXT) AS band_hash, CAST(ref AS TEXT) AS ref FROM lsh_buckets ORDER BY band, band_hash, ref",
    ).all(),
  };
}

function failDuringBuckets(db: SqliteDatabase): void {
  // FAIL preserves earlier rows from this multi-row statement, so successful
  // rollback must restore more than just the preceding fingerprint UPDATE.
  db.exec(`CREATE TRIGGER fail_fingerprint_bucket BEFORE INSERT ON lsh_buckets
    WHEN NEW.band = 12 AND NEW.ref = (SELECT ref FROM node_fingerprints WHERE node_id = 'b')
    BEGIN SELECT RAISE(FAIL, 'injected partial bucket failure'); END`);
}

describe("fingerprint transaction ownership", () => {
  it("loads shared candidates in bounded chunks without point reads and preserves code-unit order", () => {
    const ids = Array.from({ length: 503 }, (_, index) => `node:${index}`);
    ids.push("node:Z", "node:a", "node:ä");
    const { db, store } = fixture(ids);
    store.upsertMany(ids.map(nodeId => ({ nodeId, fingerprint: value(1) })));
    const get = vi.spyOn(store, "get");
    const prepare = vi.spyOn(db, "prepare");
    expect(store.lookup(value(1))).toEqual(ids.sort().map(nodeId => ({ nodeId, fingerprint: value(1) })));
    expect(get).not.toHaveBeenCalled();
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("WHERE node_id IN"))).toHaveLength(2);
    expect(store.lookup(value(50_000))).toEqual([]);
  });

  it.each([
    ["minhash", JSON.stringify([1])],
    ["minhash", JSON.stringify(Array(64).fill(-1))],
    ["neighbors", '[42]'],
    ["token_count", -1],
  ])("refuses structurally invalid stored %s on both read paths", (column, invalid) => {
    const { db, store } = fixture();
    db.prepare(`UPDATE node_fingerprints SET ${column} = ? WHERE node_id = 'a'`).run(invalid);
    expect(() => store.get("a")).toThrow("Invalid fingerprint");
    expect(() => store.lookup(value(1))).toThrow("Invalid fingerprint");
  });

  it("keeps a small fingerprint readable without LSH buckets", () => {
    const { db, store } = fixture();
    const small = { ...value(7), tokenCount: MIN_TOKENS - 1 };
    store.upsertMany([{ nodeId: "a", fingerprint: small }]);
    const ref = (db.prepare("SELECT CAST(ref AS TEXT) AS ref FROM node_fingerprints WHERE node_id = 'a'").get() as { ref: string }).ref;
    expect(db.prepare("SELECT COUNT(*) AS count FROM lsh_buckets WHERE ref = ?").get(BigInt(ref))).toEqual({ count: 0 });
    expect(store.get("a")).toEqual(small);
    expect(store.lookup(small)).toEqual([]);
    store.upsertMany([{ nodeId: "a", fingerprint: value(7) }]);
    expect(store.lookup(value(7)).map((entry) => entry.nodeId)).toEqual(["a"]);
  });

  it("avoids the growing nested savepoint only when the publisher explicitly owns rollback", () => {
    const { db, graph, store } = fixture();
    const exec = vi.spyOn(db, "exec");
    graph.transaction(() => upsertFingerprintsInOwnedTransaction(db, [{ nodeId: "a", fingerprint: value(100) }]));
    expect(exec.mock.calls.some(([sql]) => /SAVEPOINT|RELEASE|ROLLBACK TO/.test(sql))).toBe(false);

    exec.mockClear();
    graph.transaction(() => store.upsertMany([{ nodeId: "a", fingerprint: value(200) }]));
    expect(exec.mock.calls.some(([sql]) => /^SAVEPOINT /.test(sql))).toBe(true);
    expect(exec.mock.calls.some(([sql]) => /^RELEASE /.test(sql))).toBe(true);
  });

  it("keeps owned and standalone replacement identical across chunks, duplicates, aliases and wide refs", () => {
    const ids = Array.from({ length: 503 }, (_, index) => `node:${String(index).padStart(3, "0")}`);
    const standalone = fixture(ids);
    const owned = fixture(ids);
    const wideRef = 9_007_199_254_740_999n;
    for (const { db, graph, store } of [standalone, owned]) {
      db.exec("DELETE FROM lsh_buckets; DELETE FROM node_fingerprints");
      db.prepare("INSERT INTO node_fingerprints(ref, node_id, minhash, neighbors, token_count) VALUES (?, ?, ?, '[]', 1)")
        .run(wideRef, ids[0], encodeMinhash(value(1).minhash));
      store.upsertMany(ids.map((nodeId) => ({ nodeId, fingerprint: value(1) })));
      graph.insertAlias("old:first", ids[0]!, "identity", 1);
    }
    const previous = rows(standalone.db);
    const entries = ids.slice(0, -1).reverse().map((nodeId, index) => ({ nodeId, fingerprint: value(10_000 + index) }));
    entries.push({ nodeId: ids[0]!, fingerprint: value(50_000) });
    standalone.store.upsertMany(entries);
    owned.graph.transaction(() => upsertFingerprintsInOwnedTransaction(owned.db, entries));

    expect(rows(owned.db)).toEqual(rows(standalone.db));
    expect(rows(owned.db).fingerprints.map((row) => (row as { ref: string }).ref))
      .toEqual(previous.fingerprints.map((row) => (row as { ref: string }).ref));
    expect(owned.store.get(ids.at(-1)!)).toEqual(value(1));
    expect(owned.store.get("old:first")).toEqual(value(50_000));
    expect(owned.store.lookup(value(50_000)).map((entry) => entry.nodeId)).toEqual([ids[0]]);
    expect(owned.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each([false, true])("restores a failed batch before a caller continues (enclosing transaction: %s)", (enclosing) => {
    for (const failure of ["foreign-key", "partial-buckets"] as const) {
      const { db, store } = fixture();
      const before = rows(db);
      if (failure === "partial-buckets") failDuringBuckets(db);
      if (enclosing) db.exec("BEGIN");
      const entries = [
        { nodeId: "a", fingerprint: value(100) },
        { nodeId: "b", fingerprint: value(200) },
        ...(failure === "foreign-key" ? [{ nodeId: "z-missing", fingerprint: value(300) }] : []),
      ];
      expect(() => store.upsertMany(entries)).toThrow(failure === "foreign-key" ? /FOREIGN KEY/ : /partial bucket/);
      expect(rows(db)).toEqual(before);
      // This write and COMMIT prove the batch did not abort or poison the
      // enclosing transaction when its caller deliberately catches the error.
      store.upsert("c", value(400));
      if (enclosing) db.exec("COMMIT");
      expect(store.get("a")).toEqual(value(1));
      expect(store.get("b")).toEqual(value(2));
      expect(store.get("c")).toEqual(value(400));
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }
  });

  it("keeps a single upsert atomic after a partial bucket statement", () => {
    const { db, store } = fixture();
    const before = rows(db);
    failDuringBuckets(db);
    expect(() => store.upsert("b", value(100))).toThrow(/partial bucket/);
    expect(rows(db)).toEqual(before);
  });

  it.each(["foreign-key", "partial-buckets"] as const)("rolls back the whole owning publication on %s failure", (failure) => {
    const { db, graph, store } = fixture();
    graph.setMetadata("snapshot", "old snapshot");
    const before = rows(db);
    const oldNodes = graph.getAllNodes();
    if (failure === "partial-buckets") failDuringBuckets(db);
    expect(() => graph.transaction(() => {
      graph.clearDerivedGraph();
      for (const node of oldNodes.slice(0, 2)) graph.insertNode({ ...node, name: "changed" });
      graph.setMetadata("snapshot", "unpublished snapshot");
      upsertFingerprintsInOwnedTransaction(db, [
        { nodeId: "a", fingerprint: value(100) },
        { nodeId: "b", fingerprint: value(200) },
        ...(failure === "foreign-key" ? [{ nodeId: "z-missing", fingerprint: value(300) }] : []),
      ]);
    })).toThrow(failure === "foreign-key" ? /FOREIGN KEY/ : /partial bucket/);
    expect(rows(db)).toEqual(before);
    expect(graph.getAllNodes()).toEqual(oldNodes);
    expect(graph.getMetadata("snapshot")).toBe("old snapshot");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rolls back malformed later entries and leaves empty batches unchanged", () => {
    const { db, store } = fixture();
    const before = rows(db);
    expect(() => store.upsertMany([
      { nodeId: "a", fingerprint: value(100) },
      { nodeId: "b", fingerprint: { ...value(200), minhash: [1] } },
    ])).toThrow();
    expect(rows(db)).toEqual(before);
    store.upsertMany([]);
    upsertFingerprintsInOwnedTransaction(db, []);
    expect(rows(db)).toEqual(before);
  });
});
