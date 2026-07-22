import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openGraphDatabase } from "../db/database.js";
import { GraphStore } from "../db/store.js";
import type { GraphEdge, GraphNode } from "../types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fn(id: string, name: string): GraphNode {
  return {
    id, kind: "function", name, qualifiedName: `module.${name}`, filePath: "src/sample.ts",
    language: "typescript", startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 1,
  };
}

function calls(source: string, target: string): GraphEdge {
  return { source, target, kind: "calls" };
}

/** Build a store where `seed` is called by three functions, inserting edges in `order`. */
function storeWithCallers(order: GraphEdge[]): { store: GraphStore; close: () => void } {
  const root = mkdtempSync(join(tmpdir(), "mex-store-det-"));
  roots.push(root);
  const db = openGraphDatabase(join(root, "graph.db"));
  const store = new GraphStore(db);
  for (const node of [fn("function:seed", "seed"), fn("function:a", "a"), fn("function:b", "b"), fn("function:c", "c")]) {
    store.insertNode(node);
  }
  for (const edge of order) store.insertEdge(edge);
  return { store, close: () => db.close() };
}

describe("GraphStore read ordering is insertion-order independent", () => {
  it("incoming edges (callers) keep the same order regardless of edge insertion order", () => {
    const forward = storeWithCallers([calls("function:a", "function:seed"), calls("function:b", "function:seed"), calls("function:c", "function:seed")]);
    const scrambled = storeWithCallers([calls("function:c", "function:seed"), calls("function:a", "function:seed"), calls("function:b", "function:seed")]);
    try {
      const a = forward.store.getIncomingEdges("function:seed", ["calls"]).map((e) => e.source);
      const b = scrambled.store.getIncomingEdges("function:seed", ["calls"]).map((e) => e.source);
      expect(a).toEqual(["function:a", "function:b", "function:c"]);
      expect(b).toEqual(a);
    } finally {
      forward.close();
      scrambled.close();
    }
  });

  it("getOutgoingEdges is ordered deterministically by (source, target, kind)", () => {
    const forward = storeWithCallers([calls("function:seed", "function:c"), calls("function:seed", "function:a"), calls("function:seed", "function:b")]);
    try {
      const targets = forward.store.getOutgoingEdges("function:seed", ["calls"]).map((e) => e.target);
      expect(targets).toEqual(["function:a", "function:b", "function:c"]);
    } finally {
      forward.close();
    }
  });
});
