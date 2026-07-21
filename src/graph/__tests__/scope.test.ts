import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GraphEngine } from "../engine.js";
import { compactFact, groupByFile, readNodeSource, scopeSelect, selectScope } from "../scope.js";
import type { GraphNode } from "../types.js";

function node(id: string, name: string, line: number, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, name, kind: "function", qualifiedName: `module.${name}`, filePath: "src/sample.ts",
    language: "typescript", startLine: line, endLine: line, startColumn: 0, endColumn: 1,
    updatedAt: 1, ...extra,
  };
}

function fixture(): { graph: GraphEngine; seed: GraphNode; caller: GraphNode; callee: GraphNode } {
  const seed = node("function:seed", "seed", 2, { signature: "function seed(): string", docstring: "Seed docs", returnType: "string" });
  const caller = node("function:caller", "caller", 1);
  const callee = node("function:callee", "callee", 3);
  const nodes = [seed, caller, callee];
  const graph: GraphEngine = {
    build: vi.fn(), sync: vi.fn(), close: vi.fn(),
    searchNodes: vi.fn(() => [seed]),
    getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
    getCallers: (id) => id === seed.id ? [caller] : [],
    getCallees: (id) => id === seed.id ? [callee] : [],
  };
  return { graph, seed, caller, callee };
}

describe("query-time graph scope", () => {
  it("selects top-ten FTS seeds plus one-hop callers and callees, deduped", () => {
    const { graph } = fixture();
    expect(scopeSelect(graph, "seed task")).toEqual(["function:seed", "function:caller", "function:callee"]);
    expect(graph.searchNodes).toHaveBeenCalledWith("seed task", { limit: 10 });
  });

  it("builds a compact fact with relationship counts and no source", () => {
    const { graph, seed } = fixture();
    expect(compactFact(graph, seed.id, "minimal")).toEqual({
      id: seed.id, kind: "function", name: "seed", qualifiedName: "module.seed",
      filePath: "src/sample.ts", lineStart: 2, lineEnd: 2, signature: "function seed(): string",
      callerCount: 1, calleeCount: 1, detail: "minimal", sourceIncluded: false,
    });
  });

  it("marks sourceIncluded when detail is source", () => {
    const { graph, seed } = fixture();
    expect(compactFact(graph, seed.id, "source")?.sourceIncluded).toBe(true);
  });

  it("returns null for a missing node", () => {
    const { graph } = fixture();
    expect(compactFact(graph, "function:gone", "minimal")).toBeNull();
  });

  it("reads a node's source body from disk, capping at maxLines", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-scope-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/sample.ts"), "line-a\nline-b\nline-c\nline-d\n");
    try {
      const wide = node("function:wide", "wide", 1, { endLine: 4 });
      expect(readNodeSource(wide, root, 0)).toEqual({
        startLine: 1, endLine: 4, nodeIds: ["function:wide"], content: "line-a\nline-b\nline-c\nline-d", truncated: false,
      });
      expect(readNodeSource(wide, root, 2)).toEqual({
        startLine: 1, endLine: 2, nodeIds: ["function:wide"], content: "line-a\nline-b", truncated: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when the source file cannot be read", () => {
    expect(readNodeSource(node("function:x", "x", 1), "/no/such/root", 0)).toBeNull();
  });

  it("groups nodes by file preserving first-seen order", () => {
    const a1 = node("function:a1", "a1", 1, { filePath: "a.ts" });
    const b1 = node("function:b1", "b1", 1, { filePath: "b.ts" });
    const a2 = node("function:a2", "a2", 2, { filePath: "a.ts" });
    const groups = groupByFile([a1, b1, a2]);
    expect([...groups.keys()]).toEqual(["a.ts", "b.ts"]);
    expect(groups.get("a.ts")).toEqual([a1, a2]);
  });
});

describe("scored scope selection", () => {
  it("ranks an exact identifier match first with reasons and category", () => {
    const { graph } = fixture();
    const { candidates, matchedCount } = selectScope(graph, "seed task", 10);
    expect(matchedCount).toBe(3);
    expect(candidates[0]).toMatchObject({ id: "function:seed", score: 1, category: "direct" });
    expect(candidates[0].reasons).toEqual(["exact-name-match", "semantic-match"]);
    const neighbors = candidates.filter((c) => c.category === "neighbor").map((c) => c.id).sort();
    expect(neighbors).toEqual(["function:callee", "function:caller"]);
  });

  it("caps returned candidates at maxNodes while reporting the full match count", () => {
    const { graph } = fixture();
    const { candidates, matchedCount } = selectScope(graph, "seed", 1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe("function:seed");
    expect(matchedCount).toBeGreaterThan(1);
  });

  it("routes test-file nodes into the test quota bucket", () => {
    const testNode = node("function:seed", "seed", 2, { filePath: "src/__tests__/seed.test.ts", signature: "s" });
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn(() => [testNode]),
      getNode: (id) => id === testNode.id ? testNode : null,
      getCallers: () => [], getCallees: () => [],
    };
    const { candidates } = selectScope(graph, "seed", 10);
    expect(candidates[0].category).toBe("test");
  });
});
