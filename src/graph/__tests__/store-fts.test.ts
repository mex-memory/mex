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

  it("ranks a compound declaration above an incidental signature mention", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-store-ranking-"));
    roots.push(root);
    const db = openGraphDatabase(join(root, "graph.db"));
    const store = new GraphStore(db);
    const base: Omit<GraphNode, "id" | "kind" | "name" | "qualifiedName" | "filePath"> = {
      language: "typescript", startLine: 1, endLine: 2, startColumn: 0, endColumn: 1,
      isExported: true, isAsync: false, isStatic: false, isAbstract: false, updatedAt: 1,
    };
    try {
      store.insertNode({
        ...base, id: "class:ledger", kind: "class", name: "BudgetLedger",
        qualifiedName: "BudgetLedger", filePath: "src/budget.ts",
      });
      store.insertNode({
        ...base, id: "function:report", kind: "function", name: "writeReport",
        qualifiedName: "writeReport", filePath: "src/report.ts", signature: "(ledger: string): void",
      });
      expect(store.search("ledger", { limit: 2 }).map((node) => node.name)).toEqual(["BudgetLedger", "writeReport"]);
    } finally {
      db.close();
    }
  });

  it("prefers production declarations and returns nothing for boilerplate-only queries", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-store-production-"));
    roots.push(root);
    const db = openGraphDatabase(join(root, "graph.db"));
    const store = new GraphStore(db);
    const make = (id: string, filePath: string): GraphNode => ({
      id, kind: "function", name: "resolveAccount", qualifiedName: "resolveAccount", filePath,
      language: "typescript", startLine: 1, endLine: 2, startColumn: 0, endColumn: 1,
      isExported: true, isAsync: false, isStatic: false, isAbstract: false, updatedAt: 1,
    });
    try {
      store.insertNode(make("function:test", "test/resolve.test.ts"));
      store.insertNode(make("function:prod", "src/resolve.ts"));
      expect(store.search("resolveAccount", { limit: 2 }).map((node) => node.id)).toEqual([
        "function:prod", "function:test",
      ]);
      expect(store.search("how does it work")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("maps a source hit to bounded named structural declarations deterministically", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-store-source-bridge-"));
    roots.push(root);
    const db = openGraphDatabase(join(root, "graph.db"));
    const store = new GraphStore(db);
    const filePath = "src/bridge.ts";
    const make = (
      id: string,
      kind: GraphNode["kind"],
      name: string,
      startLine: number,
      endLine: number,
    ): GraphNode => ({
      id, kind, name, qualifiedName: name, filePath, language: "typescript",
      startLine, endLine, startColumn: 0, endColumn: 1, updatedAt: 1,
    });
    try {
      store.insertNode(make("file:bridge", "file", "bridge.ts", 1, 120));
      store.insertNode(make("class:owner", "class", "Owner", 1, 120));
      store.insertNode(make("method:execute", "method", "execute", 10, 90));
      store.insertNode(make("function:target", "function", "target", 20, 30));
      store.insertNode(make("function:callback", "function", "<callback:argument-0>", 40, 45));
      store.insertNode(make("variable:local", "variable", "localValue", 25, 25));
      store.insertNode(make("interface:contract", "interface", "Contract", 60, 70));
      store.insertNode(make("type:result", "type_alias", "Result", 70, 70));
      const lines = Array.from({ length: 100 }, (_, index) => `// bridge line ${index + 1}`);
      lines[69] = "const deterministicStructuralNeedle = true;";
      store.replaceSourceChunks(filePath, lines.join("\n"), "bridge-hash");

      const readIds = (): string[] | undefined => store.searchSourceChunks("deterministicStructuralNeedle")
        .find((hit) => hit.filePath === filePath && hit.startLine === 1)?.nodeIds;
      const firstRead = readIds();
      expect(firstRead).toEqual([
        "class:owner", "method:execute", "function:target", "interface:contract", "type:result",
      ]);
      expect(readIds()).toEqual(firstRead);
      expect(firstRead).not.toContain("file:bridge");
      expect(firstRead).not.toContain("function:callback");
      expect(firstRead).not.toContain("variable:local");
    } finally {
      db.close();
    }
  });

  it("prefers a substantive declaration over tiny wrappers sharing its source chunk", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-store-source-coverage-"));
    roots.push(root);
    const db = openGraphDatabase(join(root, "graph.db"));
    const store = new GraphStore(db);
    const filePath = "src/resolver.ts";
    const make = (id: string, name: string, startLine: number, endLine: number): GraphNode => ({
      id, kind: "function", name, qualifiedName: name, filePath, language: "typescript",
      startLine, endLine, startColumn: 0, endColumn: 1, updatedAt: 1,
    });
    try {
      store.insertNode(make("function:substantive", "resolveModuleName", 20, 97));
      store.insertNode(make("function:wrapper-a", "resolveLibrary", 62, 63));
      store.insertNode(make("function:wrapper-b", "resolvePackage", 66, 67));
      store.insertNode(make("function:wrapper-c", "resolveSource", 70, 71));
      const lines = Array.from({ length: 100 }, (_, index) => `// resolver line ${index + 1}`);
      lines[69] = "const substantiveCoverageNeedle = true;";
      store.replaceSourceChunks(filePath, lines.join("\n"), "resolver-hash");

      const hit = store.searchSourceChunks("substantiveCoverageNeedle")
        .find((entry) => entry.filePath === filePath && entry.startLine === 61);
      expect(hit?.nodeIds).toEqual([
        "function:substantive", "function:wrapper-a", "function:wrapper-b", "function:wrapper-c",
      ]);
      expect(store.searchSourceChunks("substantiveCoverageNeedle")
        .find((entry) => entry.filePath === filePath && entry.startLine === 61)?.nodeIds)
        .toEqual(hit?.nodeIds);
    } finally {
      db.close();
    }
  });
});
