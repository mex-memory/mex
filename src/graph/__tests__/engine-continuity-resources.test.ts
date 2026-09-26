import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGraphEngine, type GraphRefreshStrategy } from "../engine-impl.js";
import { GraphStore } from "../db/store.js";
import { openSqlite } from "../db/sqlite.js";
import { FingerprintStore } from "../fingerprint-store.js";
import type { GraphEngine } from "../engine.js";

const roots: string[] = [];
const engines: GraphEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(strategy?: GraphRefreshStrategy) {
  const root = mkdtempSync(join(tmpdir(), "mex-continuity-resources-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  const dbPath = join(root, "graph.db");
  const engine = createGraphEngine({
    rootDir: root,
    dbPath,
    ...(strategy ? { __internalRefreshStrategy: strategy } : {}),
  } as Parameters<typeof createGraphEngine>[0]);
  engines.push(engine);
  return { root, dbPath, engine };
}

function graphFacts(dbPath: string) {
  const db = openSqlite(dbPath, { readOnly: true });
  try {
    return {
      nodes: db.prepare("SELECT * FROM nodes ORDER BY id").all()
        .map((row) => {
          const { updated_at: _updatedAt, ...node } = row as Record<string, unknown>;
          return node;
        }),
      edges: db.prepare("SELECT * FROM edges ORDER BY source, target, kind, IFNULL(line, -1), IFNULL(col, -1)").all()
        .map((row) => {
          const { id: _id, ...edge } = row as Record<string, unknown>;
          return edge;
        }),
      fingerprints: db.prepare(
        "SELECT node_id, hex(minhash) AS minhash, neighbors, token_count FROM node_fingerprints ORDER BY node_id",
      ).all(),
    };
  } finally {
    db.close();
  }
}

describe("bounded publication continuity reads", () => {
  it("publishes a real body edit without materializing old nodes or reading their fingerprints", async () => {
    const { root, engine } = fixture();
    const source = join(root, "src", "stable.ts");
    writeFileSync(source, "export function stable(value: number): number { return value + 1; }\n");
    await engine.build();
    const before = engine.searchNodes("stable").find((node) => node.name === "stable")!;
    expect(before).toBeDefined();

    const oldNodes = vi.spyOn(GraphStore.prototype, "getAllNodes").mockImplementation(() => {
      throw new Error("Unnecessary old node materialization");
    });
    const oldFingerprints = vi.spyOn(FingerprintStore.prototype, "get").mockImplementation(() => {
      throw new Error("Unnecessary old fingerprint read");
    });
    writeFileSync(source, "export function stable(value: number): number { return value + 2; }\n");
    const result = await engine.sync(["src/stable.ts"]);
    const after = engine.getNode(before.id);
    expect(result.filesIndexed).toBe(1);
    expect(after).toMatchObject({ id: before.id, name: "stable" });
    expect(after?.bodyHash).not.toBe(before.bodyHash);
    expect(oldNodes).not.toHaveBeenCalled();
    expect(oldFingerprints).not.toHaveBeenCalled();
  });

  // A full publication needs one old snapshot to disambiguate removed IDs. An
  // incremental publication (issue #209) derives the old node set from the
  // fresh nodes of unchanged files plus the stored nodes of rewritten files,
  // so it never materializes the whole old graph; its aliases must be the same.
  for (const [strategy, snapshotReads] of [["full", 1], ["incremental", 0]] as const) {
  it(`preserves fingerprint-rename and signature-move alias chains without reloading fresh nodes (${strategy})`, async () => {
    const { root, dbPath, engine } = fixture(strategy);
    const source = join(root, "src", "handler.ts");
    const initial = `export function legacyHandler(value: number): number {
  const first = value + 1;
  const second = first * 2;
  const third = second - 3;
  const fourth = Math.max(third, 4);
  const fifth = Math.min(fourth, 5);
  return first + second + third + fourth + fifth;
}\n`;
    const renamed = `export function modernHandler(input: number): number {
  const alpha = input + 10;
  const beta = alpha * 20;
  const gamma = beta - 30;
  const delta = Math.max(gamma, 40);
  const epsilon = Math.min(delta, 50);
  return alpha + beta + gamma + delta + epsilon;
}\n`;
    writeFileSync(source, initial);
    await engine.build();
    const original = engine.searchNodes("legacyHandler").find((node) => node.name === "legacyHandler")!;
    const nodeReads = vi.spyOn(GraphStore.prototype, "getAllNodes");
    writeFileSync(source, renamed);
    await engine.sync(["src/handler.ts"]);
    const middle = engine.getNode(original.id)!;
    expect(middle).toMatchObject({ name: "modernHandler", filePath: "src/handler.ts" });
    expect(middle.id).not.toBe(original.id);
    // One old snapshot is needed to disambiguate removed IDs. The staged fresh
    // nodes already exist and must not be loaded from SQLite a second time.
    expect(nodeReads).toHaveBeenCalledTimes(snapshotReads);

    nodeReads.mockClear();
    unlinkSync(source);
    writeFileSync(join(root, "src", "moved.ts"), renamed.replace("input + 10", "input + 11"));
    await engine.sync(["src/handler.ts", "src/moved.ts"]);
    const final = engine.getNode(original.id)!;
    expect(final).toMatchObject({ name: "modernHandler", filePath: "src/moved.ts" });
    expect(final.id).not.toBe(middle.id);
    expect(engine.getNode(middle.id)).toEqual(final);
    expect(nodeReads).toHaveBeenCalledTimes(snapshotReads);

    nodeReads.mockClear();
    const fingerprintReads = vi.spyOn(FingerprintStore.prototype, "get").mockImplementation(() => {
      throw new Error("Surviving alias targets do not need old fingerprints");
    });
    writeFileSync(join(root, "src", "moved.ts"), renamed.replace("input + 10", "input + 12"));
    await engine.sync(["src/moved.ts"]);
    expect(engine.getNode(original.id)?.id).toBe(final.id);
    expect(engine.getNode(middle.id)?.id).toBe(final.id);
    expect(nodeReads).not.toHaveBeenCalled();
    expect(fingerprintReads).not.toHaveBeenCalled();
    fingerprintReads.mockRestore();

    const db = openSqlite(dbPath, { readOnly: true });
    try {
      const aliases = db.prepare("SELECT alias_id, canonical_node_id, match_method, confidence FROM node_aliases").all();
      expect(aliases).toContainEqual({
        alias_id: original.id, canonical_node_id: final.id, match_method: "fingerprint", confidence: 1,
      });
      expect(aliases).toContainEqual({
        alias_id: middle.id, canonical_node_id: final.id, match_method: "signature", confidence: 0.98,
      });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }

    // A clean build of the final corpus must have the same graph facts; only
    // continuity aliases should depend on the sequence of previous snapshots.
    nodeReads.mockRestore();
    const cleanPath = join(root, "clean.db");
    const clean = createGraphEngine({ rootDir: root, dbPath: cleanPath });
    engines.push(clean);
    await clean.build();
    expect(graphFacts(dbPath)).toEqual(graphFacts(cleanPath));
  }, 20_000);
  }
});
