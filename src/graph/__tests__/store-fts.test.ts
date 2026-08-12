import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openGraphDatabase } from "../db/database.js";
import { GraphStore } from "../db/store.js";
import type { GraphNode } from "../types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GraphStore FTS maintenance", () => {
  it("preserves the content rowid when inserting an existing text node id", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-store-fts-"));
    roots.push(root);
    const db = openGraphDatabase(join(root, "graph.db"));
    const store = new GraphStore(db);
    const node: GraphNode = {
      id: "method:duplicate",
      kind: "method",
      name: "execute",
      qualifiedName: "First.execute",
      filePath: "duplicate-methods.ts",
      language: "typescript",
      startLine: 2,
      endLine: 2,
      startColumn: 2,
      endColumn: 35,
      isExported: false,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      updatedAt: 1,
    };

    try {
      store.insertNode(node);
      const before = db.prepare("SELECT rowid FROM nodes WHERE id = ?").get(node.id) as { rowid: number };
      store.insertNode({ ...node, qualifiedName: "Second.execute", updatedAt: 2 });
      const after = db.prepare("SELECT rowid, qualified_name FROM nodes WHERE id = ?").get(node.id) as {
        rowid: number;
        qualified_name: string;
      };
      const indexed = db.prepare("SELECT COUNT(*) AS count FROM nodes_fts_docsize").get() as { count: number };

      expect(after.rowid).toBe(before.rowid);
      expect(after.qualified_name).toBe("Second.execute");
      expect(indexed.count).toBe(1);
      expect(store.search("execute")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("ranks an internal identifier component above an incidental signature mention", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-store-components-"));
    roots.push(root);
    const db = openGraphDatabase(join(root, "graph.db"));
    const store = new GraphStore(db);
    const base: Omit<GraphNode, "id" | "name" | "qualifiedName" | "kind" | "signature"> = {
      filePath: "retrieval.ts",
      language: "typescript",
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 1,
      isExported: true,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      updatedAt: 1,
    };

    try {
      store.insertNode({
        ...base,
        id: "class:budget-ledger",
        kind: "class",
        name: "BudgetLedger",
        qualifiedName: "BudgetLedger",
        signature: "class BudgetLedger",
      });
      store.insertNode({
        ...base,
        id: "function:plan-source",
        kind: "function",
        name: "planSource",
        qualifiedName: "planSource",
        signature: "planSource(ledger: BudgetLedger): void",
      });

      const matches = store.search("ledger", { limit: 10 });
      expect(matches.map((match) => match.name)).toContain("BudgetLedger");
      expect(matches[0]?.name).toBe("BudgetLedger");
    } finally {
      db.close();
    }
  });
});
