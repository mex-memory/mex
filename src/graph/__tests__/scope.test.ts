import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GraphEngine } from "../engine.js";
import { clusterFacts, scopeSelect } from "../scope.js";
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

  it("hydrates the complete fact shape and current source body", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-scope-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/sample.ts"), "caller();\nfunction seed() {}\ncallee();\n");
    try {
      const { graph, seed } = fixture();
      expect(clusterFacts(graph, [seed.id, "missing"], root)).toEqual([{
        id: seed.id, kind: "function", name: "seed", qualifiedName: "module.seed",
        filePath: "src/sample.ts", signature: "function seed(): string", docstring: "Seed docs",
        returnType: "string", callers: ["function:caller"], callees: ["function:callee"],
        source: "function seed() {}",
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
