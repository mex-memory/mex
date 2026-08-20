import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GraphEngine } from "../engine.js";
import { compactFact, groupByFile, planFileSource, readNodeSource, scopeSelect, selectScope } from "../scope.js";
import type { GraphEdge, GraphNode } from "../types.js";

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
  const ambiguous = node("function:ambiguous", "ambiguous", 4);
  const incoming: GraphEdge = {
    source: caller.id, target: seed.id, kind: "calls", line: 8, column: 2,
    confidence: 1, resolutionMethod: "typescript-compiler", provenance: "typescript-compiler",
  };
  const outgoing: GraphEdge = {
    source: seed.id, target: callee.id, kind: "calls", line: 3, column: 2,
    confidence: 1, resolutionMethod: "typescript-compiler", provenance: "typescript-compiler",
  };
  const lowConfidence: GraphEdge = {
    source: seed.id, target: ambiguous.id, kind: "calls", line: 4, column: 2,
    confidence: 0.75, resolutionMethod: "partial-candidate", provenance: "heuristic",
  };
  const nodes = [seed, caller, callee, ambiguous];
  const graph: GraphEngine = {
    build: vi.fn(), sync: vi.fn(), close: vi.fn(),
    searchNodes: vi.fn(() => [seed]),
    getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
    getCallers: (id) => id === seed.id ? [caller] : [],
    getCallees: (id) => id === seed.id ? [callee] : [],
    getIncoming: (id) => id === seed.id ? [{ node: caller, edge: incoming }] : [],
    getOutgoing: (id) => id === seed.id
      ? [{ node: callee, edge: outgoing }, { node: ambiguous, edge: lowConfidence }]
      : [],
  };
  return { graph, seed, caller, callee };
}

function callPairCallbackCompletionFixture(options: {
  terminalName?: string;
  containmentConfidence?: number;
  callbackContainerId?: string;
  proveCallPair?: boolean;
} = {}): {
  graph: GraphEngine;
  task: string;
  spine: GraphEdge[];
  entry: GraphNode;
  planner: GraphNode;
} {
  const task = "How does an agent expand a selected graph node into bounded source code?";
  const entry = node("function:callback-entry", "runGraphGet", 1, {
    filePath: "src/agent.ts", startLine: 1, endLine: 20, isExported: true,
    signature: options.proveCallPair === false
      ? "(ids: string[]): void"
      : "(ids: string[], deps?: AgentCommandDeps, rawOptions?: RawOptions): void",
    docstring: options.proveCallPair === false ? undefined
      : "Targeted source expansion by graph node id. Output is source records.",
  });
  const planner = node("function:callback-planner", "planSource", 30, {
    filePath: entry.filePath, startLine: 30, endLine: 70,
    signature: "(ledger: BudgetLedger, nodes: GraphNode[], opts: AgentOptions): SourceRange[]",
  });
  const callback = node("function:callback-planner-map", "<callback:fileNodes.map[0]>", 40, {
    filePath: planner.filePath, qualifiedName: "planSource::<callback:fileNodes.map[0]>",
    startLine: 40, endLine: 50, containerId: options.callbackContainerId ?? planner.id,
  });
  const terminal = node("function:callback-terminal", options.terminalName ?? "readNodeSource", 1, {
    filePath: "src/source.ts", startLine: 1, endLine: 15, isExported: true,
  });
  const distractors = Array.from({ length: 8 }, (_, index) => node(
    `function:callback-noise-${index}`,
    `opaqueBranch${index}`,
    1,
    { filePath: entry.filePath, isExported: true },
  ));
  const corpusFillers = Array.from({ length: 8 }, (_, index) => node(
    `function:callback-corpus-${index}`,
    `unrelatedCorpusSymbol${index}`,
    1,
    { filePath: `src/corpus-${index}.ts` },
  ));
  const entryPlanner: GraphEdge = {
    source: entry.id, target: planner.id, kind: "calls", line: 10, column: 2,
    confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
  };
  const plannerCallback: GraphEdge = {
    source: planner.id, target: callback.id, kind: "contains", line: 40, column: 2,
    confidence: options.containmentConfidence ?? 1,
    resolutionMethod: "lexical-containment", provenance: "typescript-compiler",
  };
  const callbackTerminal: GraphEdge = {
    source: callback.id, target: terminal.id, kind: "calls", line: 45, column: 4,
    confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
  };
  const noiseEdges = distractors.map((target, index): GraphEdge => ({
    source: entry.id, target: target.id, kind: "calls", line: 2 + index, column: 2,
    confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
  }));
  const nodes = [entry, planner, callback, terminal, ...distractors, ...corpusFillers];
  const byId = new Map(nodes.map((entry) => [entry.id, entry]));
  const edges = [entryPlanner, plannerCallback, callbackTerminal, ...noiseEdges];
  const outgoing = new Map<string, Array<{ node: GraphNode; edge: GraphEdge }>>();
  const incoming = new Map<string, Array<{ node: GraphNode; edge: GraphEdge }>>();
  for (const edge of edges) {
    const source = byId.get(edge.source)!;
    const target = byId.get(edge.target)!;
    outgoing.set(source.id, [...(outgoing.get(source.id) ?? []), { node: target, edge }]);
    incoming.set(target.id, [...(incoming.get(target.id) ?? []), { node: source, edge }]);
  }
  const searchResults = [...corpusFillers, ...distractors, entry, planner];
  const graph: GraphEngine = {
    build: vi.fn(), sync: vi.fn(), close: vi.fn(), searchNodes: vi.fn(() => searchResults),
    getNode: (id) => byId.get(id) ?? null,
    getCallers: () => [], getCallees: () => [],
    getIncoming: (id, kinds) => (incoming.get(id) ?? [])
      .filter(({ edge }) => !kinds || kinds.includes(edge.kind)),
    getOutgoing: (id, kinds) => (outgoing.get(id) ?? [])
      .filter(({ edge }) => !kinds || kinds.includes(edge.kind)),
    getIndexedFiles: () => [...new Set(nodes.map((entry) => entry.filePath))].map((path) => ({
      path, contentHash: path, parseStatus: "ok" as const, diagnosticCount: 0,
      errorCoverage: 0, nodeCount: nodes.filter((entry) => entry.filePath === path).length,
    })),
    searchSource: () => [{
      filePath: entry.filePath, startLine: 1, endLine: 20, contentHash: "agent-entry",
      rank: -0.3, matchedTerms: ["expand", "selected", "graph", "node"], nodeIds: [entry.id],
    }, {
      filePath: planner.filePath, startLine: 30, endLine: 35, contentHash: "agent-planner",
      rank: -0.29, matchedTerms: ["bounded", "source", "node"], nodeIds: [planner.id],
    }],
  };
  return { graph, task, spine: [entryPlanner, plannerCallback, callbackTerminal], entry, planner };
}

describe("query-time graph scope", () => {
  it("pins an explicit seed and expands two hops only through reliable typed edges", () => {
    const { graph } = fixture();
    const selected = scopeSelect(graph, "Seed task");
    expect(selected[0]).toBe("function:seed");
    expect(new Set(selected.slice(1))).toEqual(new Set(["function:caller", "function:callee"]));
    expect(selected).not.toContain("function:ambiguous");
    expect(graph.searchNodes).toHaveBeenCalledWith("Seed task", { limit: 80 });
  });

  it("builds a compact fact with relationship counts and no source", () => {
    const { graph, seed } = fixture();
    expect(compactFact(graph, seed.id, "minimal")).toEqual({
      id: seed.id, kind: "function", name: "seed", qualifiedName: "module.seed",
      filePath: "src/sample.ts", lineStart: 2, lineEnd: 2, signature: "function seed(): string",
      callerCount: 1, calleeCount: 1, detail: "minimal", sourceIncluded: false,
    });
  });

  it("defaults sourceIncluded to false — the emitter flips it only when source fits", () => {
    const { graph, seed } = fixture();
    expect(compactFact(graph, seed.id, "source")?.sourceIncluded).toBe(false);
    expect(compactFact(graph, seed.id, "source")?.detail).toBe("source");
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
        startLine: 1, endLine: 4, nodeIds: ["function:wide"],
        content: "1: line-a\n2: line-b\n3: line-c\n4: line-d", truncated: false, reason: "complete-symbol",
      });
      expect(readNodeSource(wide, root, 2)).toEqual({
        startLine: 1, endLine: 2, nodeIds: ["function:wide"],
        content: "1: line-a\n2: line-b", truncated: true, reason: "signature",
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

describe("source range planning", () => {
  it("preserves caller-provided node priority instead of reverting to source-line order", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-source-order-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/sample.ts"), Array.from({ length: 260 }, (_, index) => `line ${index + 1}`).join("\n"));
    try {
      const named = node("function:named", "NamedTarget", 200, { startLine: 200, endLine: 205 });
      const neighbor = node("function:neighbor", "neighbor", 10, { startLine: 10, endLine: 15 });
      const ranges = planFileSource("src/sample.ts", [named, neighbor], [], root, "NamedTarget", 200);
      expect(ranges.map((range) => range.nodeIds)).toEqual([[named.id], [neighbor.id]]);
      expect(ranges.map((range) => range.startLine)).toEqual([200, 10]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deduplicates a complete parent/child pair while retaining both source-backed ids", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-source-parent-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/sample.ts"), Array.from({ length: 260 }, (_, index) => `line ${index + 1}`).join("\n"));
    try {
      const child = node("method:child", "child", 40, { startLine: 40, endLine: 60 });
      const parent = node("class:parent", "Parent", 10, { kind: "class", startLine: 10, endLine: 100 });
      const ranges = planFileSource("src/sample.ts", [child, parent], [], root, "Parent.child", 200);
      expect(ranges).toHaveLength(1);
      expect(ranges[0]).toMatchObject({
        startLine: 10, endLine: 100, reason: "complete-symbol", truncated: false,
      });
      expect(new Set(ranges[0]!.nodeIds)).toEqual(new Set([child.id, parent.id]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a signature plus at most two 25-line callsite/query windows for a long symbol", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-source-long-"));
    mkdirSync(join(root, "src"));
    const lines = Array.from({ length: 260 }, (_, index) => `line ${index + 1}`);
    lines[89] = "const queryAlpha = first();";
    lines[119] = "return queryAlpha;";
    lines[179] = "invokeFlowSpine();";
    writeFileSync(join(root, "src/sample.ts"), lines.join("\n"));
    try {
      const long = node("method:long", "longMethod", 1, { kind: "method", startLine: 1, endLine: 240 });
      const ranges = planFileSource("src/sample.ts", [long], [], root, "queryAlpha", 200, [180]);
      expect(ranges).toHaveLength(3);
      expect(ranges[0]).toMatchObject({
        startLine: 1, endLine: 6, reason: "signature", truncated: true, nodeIds: [long.id],
      });
      expect(ranges[1]).toMatchObject({ startLine: 168, endLine: 192, reason: "callsite", nodeIds: [long.id] });
      expect(ranges[2]).toMatchObject({ startLine: 78, endLine: 102, reason: "query-hit", nodeIds: [long.id] });
      for (const range of ranges.slice(1)) expect(range.endLine - range.startLine + 1).toBeLessThanOrEqual(25);
      expect(ranges.some((range) => range.content.includes("return queryAlpha"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("merges two source windows separated by ten lines or fewer without merging the signature", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-source-merge-"));
    mkdirSync(join(root, "src"));
    const lines = Array.from({ length: 260 }, (_, index) => `line ${index + 1}`);
    lines[49] = "queryNeedle();";
    lines[79] = "queryNeedle();";
    writeFileSync(join(root, "src/sample.ts"), lines.join("\n"));
    try {
      const long = node("method:long", "longMethod", 1, { kind: "method", startLine: 1, endLine: 240 });
      const ranges = planFileSource("src/sample.ts", [long], [], root, "queryNeedle", 200);
      expect(ranges).toHaveLength(2);
      expect(ranges[0]).toMatchObject({ startLine: 1, endLine: 6, reason: "signature" });
      expect(ranges[1]).toMatchObject({ startLine: 38, endLine: 92, reason: "query-hit" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("scored scope selection", () => {
  it("prefers query concepts co-located in one source region over terms scattered across a central file", () => {
    const focused = node("function:focused", "focused", 1, {
      filePath: "src/focused.ts", signature: "function focused(alpha: Alpha, beta: Beta, gamma: Gamma): void",
    });
    const central = node("function:central", "central", 1, {
      filePath: "src/central.ts", signature: "function central(alpha: Alpha, beta: Beta, gamma: Gamma): void",
    });
    const nodes = [central, focused];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn(() => nodes),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing: () => [],
      getIndexedFiles: () => [
        { path: "src/central.ts", contentHash: "central", parseStatus: "ok", diagnosticCount: 0, errorCoverage: 0, nodeCount: 1 },
        { path: "src/focused.ts", contentHash: "focused", parseStatus: "ok", diagnosticCount: 0, errorCoverage: 0, nodeCount: 1 },
      ],
      searchSource: () => [
        { filePath: "src/central.ts", startLine: 1, endLine: 20, contentHash: "central", rank: -0.05, matchedTerms: ["alpha"] },
        { filePath: "src/central.ts", startLine: 61, endLine: 80, contentHash: "central", rank: -0.05, matchedTerms: ["beta"] },
        { filePath: "src/central.ts", startLine: 121, endLine: 140, contentHash: "central", rank: -0.05, matchedTerms: ["gamma"] },
        {
          filePath: "src/focused.ts", startLine: 1, endLine: 20, contentHash: "focused", rank: -0.05,
          matchedTerms: ["alpha", "beta", "gamma"],
        },
      ],
    };

    const selection = selectScope(graph, "alpha beta gamma", 10, 2);
    expect(selection.files[0]).toMatchObject({ filePath: "src/focused.ts" });
    expect(selection.files[0]!.score).toBeGreaterThan(selection.files[1]!.score);
  });

  it("reserves the best source-chunk declaration before aggregate representatives", () => {
    const aligned = node("function:aligned", "recoverCandidate", 10, {
      filePath: "src/extensions.ts", startLine: 10, endLine: 30,
    });
    const aggregate = node("function:aggregate", "supportedExtensionLookup", 12, {
      filePath: "src/extensions.ts", startLine: 12, endLine: 20,
    });
    const nodes = [aligned, aggregate];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn(() => [aggregate]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing: () => [],
      getIndexedFiles: () => [{
        path: aligned.filePath, contentHash: "extensions", parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: nodes.length,
      }],
      searchSource: () => [{
        filePath: aligned.filePath, startLine: 10, endLine: 30, contentHash: "extensions",
        rank: -0.2, matchedTerms: ["supported", "extension", "lookup"],
        nodeIds: [aligned.id],
      }, {
        filePath: aggregate.filePath, startLine: 12, endLine: 20, contentHash: "extensions",
        rank: -0.19, matchedTerms: ["supported", "extension", "lookup"],
        nodeIds: [aggregate.id],
      }],
    };

    const selection = selectScope(graph, "supported extension lookup", 2, 1);
    expect(selection.candidates.map((candidate) => candidate.id)).toEqual([aggregate.id, aligned.id]);
    expect(selection.files[0]?.nodeIds).toEqual([aggregate.id, aligned.id]);
  });

  it("preserves a plan+source full-query declaration when a same-file source region ranks first", () => {
    const target = node("function:target", "planFileSource", 120, {
      filePath: "src/planner.ts", startLine: 120, endLine: 150,
      signature: "function planFileSource(symbols: Symbol[]): SourceWindow[]",
    });
    const sourceDecoy = node("function:source-decoy", "selectScope", 1, {
      filePath: target.filePath, startLine: 1, endLine: 80,
    });
    const nodes = [target, sourceDecoy];
    const query = "plan source";
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn((request) => request === query || ["plan", "source"].includes(request)
        ? [target] : []),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing: () => [],
      getIndexedFiles: () => [{
        path: target.filePath, contentHash: "planner", parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: nodes.length,
      }],
      searchSource: () => [{
        filePath: target.filePath, startLine: 1, endLine: 80, contentHash: "planner",
        rank: -0.3, matchedTerms: ["plan", "source"],
        nodeIds: [sourceDecoy.id],
      }, {
        filePath: target.filePath, startLine: 101, endLine: 160, contentHash: "planner",
        rank: -0.2, matchedTerms: ["plan", "source"], nodeIds: [target.id],
      }],
    };

    const selection = selectScope(graph, query, 1, 1);
    expect(selection.candidates.map((candidate) => candidate.id)).toEqual([target.id]);
    expect(selection.files[0]?.nodeIds).toEqual([target.id]);
    expect(selection.candidates[0]?.reasons).toContain("bm25-node");
    expect(selection.candidates[0]?.reasons).not.toContain("query-phrase-flow");
  });

  it("does not count stems of one raw concept as independent full-query proof", () => {
    const wrapper = node("function:wrapper", "getSupportedExtensionsWithJsonIfResolveJsonModule", 40, {
      filePath: "src/extensions.ts", startLine: 40, endLine: 50,
      signature: "function getSupportedExtensionsWithJsonIfResolveJsonModule(options: CompilerOptions): string[]",
    });
    const aligned = node("function:aligned", "getSupportedExtensions", 10, {
      filePath: wrapper.filePath, startLine: 10, endLine: 30,
      signature: "function getSupportedExtensions(options: CompilerOptions): string[]",
    });
    const nodes = [wrapper, aligned];
    const query = "which routine decides supported compiler options";
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn(() => [wrapper, aligned]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing: () => [],
      getIndexedFiles: () => [{
        path: wrapper.filePath, contentHash: "extensions", parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: nodes.length,
      }],
      searchSource: () => [{
        filePath: aligned.filePath, startLine: 10, endLine: 30, contentHash: "extensions",
        rank: -0.3, matchedTerms: ["supported", "compiler", "options"], nodeIds: [aligned.id],
      }],
    };

    const selection = selectScope(graph, query, 1, 1);
    expect(selection.candidates.map((candidate) => candidate.id)).toEqual([aligned.id]);
    expect(selection.candidates.map((candidate) => candidate.id)).not.toContain(wrapper.id);
  });

  it("does not reserve a full-query BM25 hit corroborated only by prose", () => {
    const proseOnly = node("function:prose-only", "utility", 1, {
      filePath: "src/utility.ts", docstring: "Plan bounded source windows for a request.",
    });
    const aligned = node("function:aligned-answer", "sourceWindows", 20, {
      filePath: "src/planner.ts", startLine: 20, endLine: 40,
      signature: "function sourceWindows(plan: Plan): SourceWindow[]",
    });
    const nodes = [proseOnly, aligned];
    const query = "plan bounded source windows";
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn((request) => request === query ? [proseOnly] : [proseOnly, aligned]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing: () => [],
      getIndexedFiles: () => nodes.map((entry) => ({
        path: entry.filePath, contentHash: entry.id, parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
      })),
      searchSource: () => [{
        filePath: aligned.filePath, startLine: 20, endLine: 40, contentHash: "planner",
        rank: -0.3, matchedTerms: ["plan", "bounded", "source", "windows"], nodeIds: [aligned.id],
      }],
    };

    const selection = selectScope(graph, query, 1, 2);
    expect(selection.candidates.map((candidate) => candidate.id)).toEqual([aligned.id]);
    expect(selection.candidates.map((candidate) => candidate.id)).not.toContain(proseOnly.id);
  });

  it("reserves one production full-query declaration deterministically without widening maxNodes", () => {
    const testHit = node("function:test-hit", "alphaBetaTest", 1, {
      filePath: "src/__tests__/pipeline.test.ts", signature: "function alphaBetaTest(pipeline: Pipeline): void",
    });
    const firstProduction = node("function:production-first", "alphaBetaPrimary", 100, {
      filePath: "src/pipeline.ts", signature: "function alphaBetaPrimary(pipeline: Pipeline): void",
    });
    const secondProduction = node("function:production-second", "alphaBetaSecondary", 140, {
      filePath: firstProduction.filePath, signature: "function alphaBetaSecondary(pipeline: Pipeline): void",
    });
    const sourceDecoy = node("function:source-decoy", "regionOwner", 1, {
      filePath: firstProduction.filePath, startLine: 1, endLine: 80,
    });
    const nodes = [testHit, firstProduction, secondProduction, sourceDecoy];
    const query = "alpha beta pipeline";
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn(() => [testHit, firstProduction, secondProduction]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing: () => [],
      getIndexedFiles: () => [testHit.filePath, firstProduction.filePath].map((path) => ({
        path, contentHash: path, parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: nodes.filter((entry) => entry.filePath === path).length,
      })),
      searchSource: () => [{
        filePath: sourceDecoy.filePath, startLine: 1, endLine: 80, contentHash: "pipeline",
        rank: -0.3, matchedTerms: ["alpha", "beta", "pipeline"], nodeIds: [sourceDecoy.id],
      }],
    };

    const first = selectScope(graph, query, 2, 2);
    const second = selectScope(graph, query, 2, 2);
    expect(first.candidates).toHaveLength(2);
    expect(first.candidates.map((candidate) => candidate.id)).toEqual([
      firstProduction.id, sourceDecoy.id,
    ]);
    expect(first.candidates.map((candidate) => candidate.id)).not.toContain(testHit.id);
    expect(first.candidates.map((candidate) => candidate.id)).not.toContain(secondProduction.id);
    expect(second.candidates.map((candidate) => candidate.id))
      .toEqual(first.candidates.map((candidate) => candidate.id));
  });

  it("does not turn sibling declarations in a broad source chunk into graph candidates", () => {
    const file = node("file:context", "retrievedContext.ts", 1, {
      kind: "file", filePath: "src/retrieved-context.ts", startLine: 1, endLine: 80,
    });
    const anchor = node("function:anchor", "quotaGate", 10, {
      filePath: file.filePath, startLine: 10, endLine: 30,
    });
    const sibling = node("function:sibling", "legacyNeighborhood", 50, {
      filePath: anchor.filePath, startLine: 50, endLine: 55,
    });
    const callback = node("function:file-callback", "<callback:file[0]>", 60, {
      filePath: anchor.filePath, startLine: 60, endLine: 60,
    });
    const callbackTarget = node("function:callback-target", "unrelatedCallbackTarget", 70, {
      filePath: anchor.filePath, startLine: 70, endLine: 75,
    });
    const nodes = [file, anchor, sibling, callback, callbackTarget];
    const contains = (target: GraphNode): GraphEdge => ({
      source: file.id, target: target.id, kind: "contains", line: target.startLine,
      confidence: 1, resolutionMethod: "lexical-containment", provenance: "typescript-compiler",
    });
    const anchorContainment = contains(anchor);
    const siblingContainment = contains(sibling);
    const callbackContainment = contains(callback);
    const callbackCall: GraphEdge = {
      source: callback.id, target: callbackTarget.id, kind: "calls", line: 60,
      confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
    };
    const indexedFile = {
      path: anchor.filePath, contentHash: "context", parseStatus: "ok" as const,
      diagnosticCount: 0, errorCoverage: 0, nodeCount: nodes.length,
    };
    const base: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(), searchNodes: vi.fn(() => [file]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [],
      getIncoming: (id) => id === anchor.id ? [{ node: file, edge: anchorContainment }]
        : id === sibling.id ? [{ node: file, edge: siblingContainment }] : [],
      getOutgoing: (id) => id === file.id ? [
        { node: anchor, edge: anchorContainment }, { node: sibling, edge: siblingContainment },
        { node: callback, edge: callbackContainment },
      ] : id === callback.id ? [{ node: callbackTarget, edge: callbackCall }] : [],
      getIndexedFiles: () => [indexedFile],
      searchSource: () => [{
        filePath: anchor.filePath, startLine: 1, endLine: 80, contentHash: "context",
        rank: -0.2, matchedTerms: ["retrieved", "context", "token"],
        nodeIds: [anchor.id, sibling.id],
      }],
    };

    const selection = selectScope(
      base,
      "prevent retrieved context from exceeding its token allowance",
      10,
      1,
    );
    expect(selection.candidates.map((candidate) => candidate.id)).toContain(anchor.id);
    expect(selection.candidates.map((candidate) => candidate.id)).not.toContain(sibling.id);
    expect(selection.candidates.map((candidate) => candidate.id)).not.toContain(callback.id);
    expect(selection.candidates.map((candidate) => candidate.id)).not.toContain(callbackTarget.id);
    expect(selection.files[0]).toMatchObject({ filePath: anchor.filePath, textOnly: false });
    expect(selection.files[0]?.nodeIds).not.toContain(sibling.id);

    const weak = selectScope({
      ...base,
      searchNodes: vi.fn(() => []),
      getNode: (id) => id === sibling.id ? sibling : null,
      getIncoming: () => [], getOutgoing: () => [],
      searchSource: () => [{
        filePath: sibling.filePath, startLine: 1, endLine: 80, contentHash: "context",
        rank: -0.2, matchedTerms: ["retrieved", "context"], nodeIds: [sibling.id],
      }],
    }, "retrieved context allowance", 10, 1);
    expect(weak.candidates).toEqual([]);
    expect(weak.files[0]).toMatchObject({
      filePath: sibling.filePath, nodeIds: [], textOnly: true,
    });
    expect(weak.files[0]?.textHits).toHaveLength(1);
  });

  it("reserves a compiler-proven cross-file destination when both endpoints match an adjacent phrase", () => {
    const schedule = node("function:schedule", "scheduleCacheInvalidation", 10, {
      filePath: "src/coordinator.ts",
    });
    const invalidate = node("function:invalidate", "cacheInvalidationHandler", 20, {
      filePath: "src/cache.ts",
    });
    const distractors = Array.from({ length: 3 }, (_, index) => node(
      `function:distractor-${index}`,
      `cacheInvalidationGuide${index}`,
      1,
      { filePath: `src/guide-${index}.ts` },
    ));
    const edge: GraphEdge = {
      source: schedule.id, target: invalidate.id, kind: "calls", line: 12, column: 2,
      confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
    };
    const laterCallsite: GraphEdge = { ...edge, line: 29, column: 4 };
    const nodes = [schedule, invalidate, ...distractors];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn((query) => query.toLowerCase() === "cache invalidation" ? [schedule] : distractors),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [],
      // Deliberately reverse callsite order: storage order must not choose the
      // representative edge for a repeated source/target relationship.
      getOutgoing: (id) => id === schedule.id
        ? [{ node: invalidate, edge: laterCallsite }, { node: invalidate, edge }]
        : [],
      getIndexedFiles: () => nodes.map((entry) => ({
        path: entry.filePath, contentHash: entry.id, parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
      })),
      searchSource: () => distractors.map((entry, index) => ({
        filePath: entry.filePath, startLine: 1, endLine: 20, contentHash: entry.id,
        rank: -0.2 + index * 0.001, matchedTerms: ["cache", "invalidation"], nodeIds: [entry.id],
      })),
    };

    const selection = selectScope(graph, "How does cache invalidation cross the service boundary?", 12, 2);
    expect(selection.files.map((file) => file.filePath)).toContain(invalidate.filePath);
    expect(selection.candidates.find((candidate) => candidate.id === invalidate.id)?.reasons)
      .toContain("query-phrase-flow");
    expect(selection.flows[0]?.steps).toEqual([edge]);
  });

  it("keeps filtered phrase concepts attached to their compiler-proven bridge", () => {
    const source = node("function:file-resolution-dispatcher", "fileResolutionDispatcher", 10, {
      filePath: "src/dispatcher.ts",
    });
    const target = node("function:file-resolution-handler", "fileResolutionHandler", 20, {
      filePath: "src/handler.ts",
    });
    const edge: GraphEdge = {
      source: source.id, target: target.id, kind: "calls", line: 12, column: 2,
      confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
    };
    const nodes = [source, target];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn((query) => query.toLowerCase() === "file resolution" ? [source] : []),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [],
      getOutgoing: (id) => id === source.id ? [{ node: target, edge }] : [],
      getIndexedFiles: () => nodes.map((entry) => ({
        path: entry.filePath, contentHash: entry.id, parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
      })),
      searchSource: () => [],
    };

    // The first three pairs are filtered as low-signal. The surviving pair's
    // original index is 3, even though it occupies index 0 in the filtered list.
    const selection = selectScope(graph, "graph node source file resolution", 12, 2);
    expect(selection.candidates.find((candidate) => candidate.id === target.id)?.reasons)
      .toContain("query-phrase-flow");
    expect(selection.coveredTerms).toEqual(["file", "resolution"]);
    expect(selection.flows[0]?.steps).toEqual([edge]);
  });

  it.each([
    {
      phrase: "graph retrieval",
      sourceName: "runGraphScope",
      targetName: "selectScope",
      signature: "(graph: GraphEngine): GraphScopeSelection",
      docstring: "Broad graph retrieval for a natural-language request.",
    },
    {
      phrase: "build graph",
      sourceName: "graphCommandCallback",
      targetName: "runGraph",
      signature: "(graph: GraphEngine): void",
      docstring: "Build the graph for the current repository.",
    },
  ])("retains the required $phrase semantic bridge when its other concept is low-signal", ({
    phrase, sourceName, targetName, signature, docstring,
  }) => {
    const source = node(`function:${sourceName}`, sourceName, 10, {
      filePath: "src/command.ts", signature, docstring,
    });
    const target = node(`function:${targetName}`, targetName, 20, {
      filePath: "src/implementation.ts", signature, docstring,
    });
    const edge: GraphEdge = {
      source: source.id, target: target.id, kind: "calls", line: 12, column: 2,
      confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
    };
    const nodes = [source, target];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn(() => [source]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [],
      getOutgoing: (id) => id === source.id ? [{ node: target, edge }] : [],
      getIndexedFiles: () => nodes.map((entry) => ({
        path: entry.filePath, contentHash: entry.id, parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
      })),
      searchSource: () => [],
    };

    const selection = selectScope(graph, phrase, 12, 2);
    expect(selection.files.map((file) => file.filePath)).toContain(target.filePath);
    expect(selection.candidates.find((candidate) => candidate.id === target.id)?.reasons)
      .toContain("query-phrase-flow");
    expect(selection.flows[0]?.steps).toEqual([edge]);
  });

  it("does not promote a compiler-proven source-file bridge over focused retrieval evidence", () => {
    const source = node("function:source-map", "getSourceMapDirectory", 10, {
      filePath: "src/emitter.ts",
    });
    const target = node("function:new-dir", "getSourceFilePathInNewDir", 20, {
      filePath: "src/utilities.ts",
    });
    const focused = node("function:resolver", "resolveModuleName", 30, {
      filePath: "src/module-name-resolver.ts",
    });
    const edge: GraphEdge = {
      source: source.id, target: target.id, kind: "calls", line: 12, column: 2,
      confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
    };
    const nodes = [source, target, focused];
    const query = "locate an imported package or source file";
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn((request) => request.toLowerCase() === "source file" ? [source] : [focused]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [],
      getOutgoing: (id) => id === source.id ? [{ node: target, edge }] : [],
      getIndexedFiles: () => nodes.map((entry) => ({
        path: entry.filePath, contentHash: entry.id, parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
      })),
      searchSource: () => [{
        filePath: focused.filePath, startLine: 30, endLine: 40, contentHash: "resolver",
        rank: -0.3, matchedTerms: ["locate", "imported", "package"], nodeIds: [focused.id],
      }],
    };

    const selection = selectScope(graph, query, 12, 1);
    expect(selection.files.map((file) => file.filePath)).toEqual([focused.filePath]);
    expect(selection.files.flatMap((file) => file.reasons)).not.toContain("query-phrase-flow");
    expect(selection.candidates.flatMap((candidate) => candidate.reasons)).not.toContain("query-phrase-flow");
    expect(selection.flows.flatMap((flow) => flow.steps)).not.toContainEqual(edge);
  });

  it("bounds phrase-flow endpoint inspection after stable callsite ordering", () => {
    const source = node("function:source", "scheduleCacheInvalidation", 10, { filePath: "src/source.ts" });
    const rejected = Array.from({ length: 16 }, (_, index) => node(
      `function:rejected-${index}`,
      `ordinaryHandler${index}`,
      index + 1,
      { filePath: `src/rejected-${index}.ts` },
    ));
    const beyondLimit = node("function:beyond-limit", "cacheInvalidationHandler", 30, {
      filePath: "src/beyond-limit.ts",
    });
    const edges = [...rejected.map((target, index) => ({
      node: target,
      edge: {
        source: source.id, target: target.id, kind: "calls" as const, line: index + 1, column: 1,
        confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler" as const,
      },
    })), {
      node: beyondLimit,
      edge: {
        source: source.id, target: beyondLimit.id, kind: "calls" as const, line: 17, column: 1,
        confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler" as const,
      },
    }].reverse();
    const nodes = [source, ...rejected, beyondLimit];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn((query) => query.toLowerCase() === "cache invalidation" ? [source] : []),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [],
      getOutgoing: (id) => id === source.id ? edges : [],
      getIndexedFiles: () => nodes.map((entry) => ({
        path: entry.filePath, contentHash: entry.id, parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
      })),
      searchSource: () => [],
    };

    const selection = selectScope(graph, "cache invalidation across a boundary", 12, 2);
    expect(selection.candidates.map((candidate) => candidate.id)).not.toContain(beyondLimit.id);
    expect(selection.files.map((file) => file.filePath)).not.toContain(beyondLimit.filePath);
    expect(selection.flows).toEqual([]);
  });

  it("does not activate phrase-flow admission for same-file or low-confidence edges", () => {
    const run = (sameFile: boolean, confidence: number) => {
      const source = node("function:source", "scheduleCacheInvalidation", 10, {
        filePath: "src/source.ts",
      });
      const target = node("function:target", "cacheInvalidationHandler", 20, {
        filePath: sameFile ? source.filePath : "src/hidden.ts",
      });
      const distractor = node("function:distractor", "cacheInvalidationGuide", 1, {
        filePath: "src/guide.ts",
      });
      const edge: GraphEdge = {
        source: source.id, target: target.id, kind: "calls", line: 12, column: 2,
        confidence, resolutionMethod: confidence >= 0.8 ? "typescript-signature" : "partial-candidate",
        provenance: confidence >= 0.8 ? "typescript-compiler" : "heuristic",
      };
      const nodes = [source, target, distractor];
      const graph: GraphEngine = {
        build: vi.fn(), sync: vi.fn(), close: vi.fn(),
        searchNodes: vi.fn((query) => query.toLowerCase() === "cache invalidation" ? [source] : [distractor]),
        getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
        getCallers: () => [], getCallees: () => [], getIncoming: () => [],
        getOutgoing: (id) => id === source.id ? [{ node: target, edge }] : [],
        getIndexedFiles: () => nodes.map((entry) => ({
          path: entry.filePath, contentHash: entry.id, parseStatus: "ok" as const,
          diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
        })),
        searchSource: () => [{
          filePath: distractor.filePath, startLine: 1, endLine: 20, contentHash: distractor.id,
          rank: -0.2, matchedTerms: ["cache", "invalidation"], nodeIds: [distractor.id],
        }],
      };
      return selectScope(graph, "cache invalidation across a boundary", 12, 2);
    };

    for (const selection of [run(true, 1), run(false, 0.75)]) {
      expect(selection.files.flatMap((file) => file.reasons)).not.toContain("query-phrase-flow");
      expect(selection.candidates.flatMap((candidate) => candidate.reasons)).not.toContain("query-phrase-flow");
    }
  });

  it("requires phrase evidence in each endpoint identity instead of comments alone", () => {
    const source = node("function:source", "scheduleCacheInvalidation", 10, { filePath: "src/source.ts" });
    const target = node("function:target", "clearEntries", 20, {
      filePath: "src/hidden.ts", docstring: "Performs cache invalidation after a write.",
    });
    const distractor = node("function:distractor", "cacheInvalidationGuide", 1, { filePath: "src/guide.ts" });
    const edge: GraphEdge = {
      source: source.id, target: target.id, kind: "calls", confidence: 1,
      resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
    };
    const nodes = [source, target, distractor];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn((query) => query.toLowerCase() === "cache invalidation" ? [source] : [distractor]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [],
      getOutgoing: (id) => id === source.id ? [{ node: target, edge }] : [],
      getIndexedFiles: () => nodes.map((entry) => ({
        path: entry.filePath, contentHash: entry.id, parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
      })),
      searchSource: () => [{
        filePath: distractor.filePath, startLine: 1, endLine: 20, contentHash: distractor.id,
        rank: -0.2, matchedTerms: ["cache", "invalidation"], nodeIds: [distractor.id],
      }],
    };

    const selection = selectScope(graph, "cache invalidation across a boundary", 12, 2);
    expect(selection.files.flatMap((file) => file.reasons)).not.toContain("query-phrase-flow");
    expect(selection.candidates.flatMap((candidate) => candidate.reasons)).not.toContain("query-phrase-flow");
  });

  it("does not let a two-word low-signal phrase displace stronger source evidence", () => {
    const source = node("function:source", "graphDeclarationScanner", 10, { filePath: "src/scanner.ts" });
    const target = node("function:target", "graphDeclarationRegistry", 20, { filePath: "src/registry.ts" });
    const focused = node("function:focused", "explainArchitecture", 4, {
      filePath: "src/architecture.ts", docstring: "Explains graph declarations and their ownership.",
    });
    const edge: GraphEdge = {
      source: source.id, target: target.id, kind: "calls", line: 12, column: 2,
      confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
    };
    const nodes = [source, target, focused];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn((query) => query.toLowerCase() === "graph declarations" ? [source] : [focused]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [],
      getOutgoing: (id) => id === source.id ? [{ node: target, edge }] : [],
      getIndexedFiles: () => nodes.map((entry) => ({
        path: entry.filePath, contentHash: entry.id, parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
      })),
      searchSource: () => [{
        filePath: focused.filePath, startLine: 1, endLine: 20, contentHash: focused.id,
        rank: -0.3, matchedTerms: ["graph", "declarations"], nodeIds: [focused.id],
      }],
    };

    const selection = selectScope(graph, "How do graph declarations work?", 12, 1);
    expect(selection.files.map((file) => file.filePath)).toEqual([focused.filePath]);
    expect(selection.files.flatMap((file) => file.reasons)).not.toContain("query-phrase-flow");
    expect(selection.candidates.flatMap((candidate) => candidate.reasons)).not.toContain("query-phrase-flow");
  });

  it("prefers a query-correlated declaration over an earlier broad overlap in the same chunk", () => {
    const broad = node("function:broad-overlap", "formatCodeSpan", 10, {
      filePath: "src/diagnostics.ts", startLine: 10, endLine: 50,
    });
    const correlated = node("function:correlated", "formatDiagnosticsWithRelatedInformation", 20, {
      filePath: "src/diagnostics.ts", startLine: 20, endLine: 30,
    });
    const nodes = [broad, correlated];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn(() => [broad]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing: () => [],
      getIndexedFiles: () => [{
        path: broad.filePath, contentHash: "diagnostics", parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: nodes.length,
      }],
      searchSource: () => [{
        filePath: broad.filePath, startLine: 10, endLine: 50, contentHash: "diagnostics",
        rank: -0.2, matchedTerms: ["format", "diagnostics", "information"],
        nodeIds: [broad.id, correlated.id],
      }],
    };

    const selection = selectScope(graph, "format diagnostics information", 1, 1);
    expect(selection.candidates.map((candidate) => candidate.id)).toEqual([correlated.id]);
    expect(selection.files[0]?.nodeIds).toEqual([correlated.id]);
  });

  it("keeps the fourth global hit in the direct source floor ahead of propagated callsite files", () => {
    const origin = node("function:origin", "originHandler", 1, {
      filePath: "src/origin.ts", startLine: 1, endLine: 20,
    });
    const direct = node("function:direct", "directWinner", 1, {
      filePath: "src/direct.ts",
    });
    const propagatedA = node("function:propagated-a", "propagatedOne", 1, {
      filePath: "src/propagated-a.ts",
    });
    const propagatedB = node("function:propagated-b", "propagatedTwo", 1, {
      filePath: "src/propagated-b.ts",
    });
    const propagatedC = node("function:propagated-c", "propagatedThree", 1, {
      filePath: "src/propagated-c.ts",
    });
    const nodes = [origin, direct, propagatedA, propagatedB, propagatedC];
    const edge = (target: GraphNode, line: number): GraphEdge => ({
      source: origin.id, target: target.id, kind: "calls", line, column: 2,
      confidence: 1, resolutionMethod: "typescript-compiler", provenance: "typescript-compiler",
    });
    const originToA = edge(propagatedA, 5);
    const originToB = edge(propagatedB, 6);
    const originToC = edge(propagatedC, 7);
    const hit = (entry: GraphNode, rank: number) => ({
      filePath: entry.filePath, startLine: 1, endLine: 20, contentHash: entry.id,
      rank: -0.2 + rank * 0.001,
      matchedTerms: ["opaque", "memory", "pipeline"], nodeIds: [entry.id],
    });
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(), searchNodes: vi.fn(() => []),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [],
      getOutgoing: (id) => id === origin.id
        ? [
          { node: propagatedA, edge: originToA },
          { node: propagatedB, edge: originToB },
          { node: propagatedC, edge: originToC },
        ]
        : [],
      getIndexedFiles: () => nodes.map((entry) => ({
        path: entry.filePath, contentHash: entry.id, parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
      })),
      searchSource: () => [
        hit(origin, 0),
        { ...hit(origin, 1), startLine: 2, endLine: 19 },
        { ...hit(origin, 2), startLine: 3, endLine: 18 },
        hit(direct, 3),
        hit(propagatedA, 4),
        hit(propagatedB, 5),
        hit(propagatedC, 6),
      ],
    };

    const selection = selectScope(graph, "opaque memory pipeline", 12, 4);
    const selectedPaths = selection.files.map((file) => file.filePath);
    expect(selectedPaths).toEqual(expect.arrayContaining([
      origin.filePath, direct.filePath,
    ]));
    expect(selectedPaths.filter((path) => path.startsWith("src/propagated-"))).toHaveLength(2);
  });

  it("preserves three independent source-channel files before the hybrid fill", () => {
    const sourceA = node("function:source-a", "firstAnchor", 1, { filePath: "src/a.ts" });
    const sourceB = node("function:source-b", "secondAnchor", 1, { filePath: "src/b.ts" });
    const sourceC = node("function:source-c", "thirdAnchor", 1, { filePath: "src/c.ts" });
    const broad = node("function:broad", "alphaBetaGammaPipeline", 1, {
      filePath: "src/broad.ts", signature: "function alphaBetaGammaPipeline(alpha: Alpha, beta: Beta, gamma: Gamma): void",
    });
    const nodes = [sourceA, sourceB, sourceC, broad];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn(() => [broad]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing: () => [],
      getIndexedFiles: () => nodes.map((entry) => ({
        path: entry.filePath, contentHash: entry.id, parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
      })),
      searchSource: () => [sourceA, sourceB, sourceC].map((entry, index) => ({
        filePath: entry.filePath, startLine: 1, endLine: 20, contentHash: entry.id,
        rank: -0.05 + index * 0.001, matchedTerms: ["alpha", "beta"], nodeIds: [entry.id],
      })),
    };

    const selection = selectScope(graph, "alpha beta gamma", 16, 4);
    expect(selection.files.map((file) => file.filePath)).toEqual(expect.arrayContaining([
      sourceA.filePath, sourceB.filePath, sourceC.filePath, broad.filePath,
    ]));
  });

  it("reserves a rare compound declaration ahead of files with broader common-term scores", () => {
    const framework = node("class:framework", "Framework", 1, {
      kind: "class", filePath: "src/framework.ts",
    });
    const rare = node("class:smart-router", "SmartRouter", 1, {
      kind: "class", filePath: "src/smart-router.ts",
    });
    const broad = Array.from({ length: 5 }, (_, index) => node(
      `class:broad-${index}`,
      "RegisteredPathsMatcher",
      1,
      { kind: "class", filePath: `src/broad-${index}.ts` },
    ));
    const nodes = [framework, rare, ...broad];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn((query) => {
        const normalized = query.toLowerCase();
        if (normalized.includes("framework's")) return [...broad, framework, rare];
        if (normalized === "framework") return [framework];
        if (normalized === "smart" || normalized === "router") return [rare];
        if (normalized.includes("register") || normalized.includes("path")
          || normalized.includes("match")) return broad;
        return [...broad, framework, rare];
      }),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing: () => [],
      getIndexedFiles: () => nodes.map((entry) => ({
        path: entry.filePath, contentHash: entry.id, parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
      })),
      searchSource: () => broad.slice(0, 2).map((entry, index) => ({
        filePath: entry.filePath, startLine: 1, endLine: 20, contentHash: entry.id,
        rank: -0.2 + index * 0.001,
        matchedTerms: ["registered", "path", "paths", "match", "matches"],
        nodeIds: [entry.id],
      })),
    };

    const selection = selectScope(
      graph,
      "How does Framework's smart router support registered paths and later matches?",
      16,
      4,
    );
    const selectedPaths = selection.files.map((file) => file.filePath);
    expect(selectedPaths).toEqual(expect.arrayContaining([
      framework.filePath, rare.filePath, broad[0]!.filePath, broad[1]!.filePath,
    ]));
    expect(selectedPaths.filter((filePath) => broad.slice(2)
      .some((entry) => entry.filePath === filePath))).toEqual([]);
    expect(selection.candidates.map((candidate) => candidate.id)).toContain(rare.id);
  });

  it("does not let weak single-concept source hits evict strong graph files", () => {
    const graphA = node("function:graph-a", "alphaBetaHandler", 1, { filePath: "src/graph-a.ts" });
    const graphB = node("function:graph-b", "gammaDeltaHandler", 1, { filePath: "src/graph-b.ts" });
    const weakFiles = ["src/weak-a.ts", "src/weak-b.ts", "src/weak-c.ts"];
    const nodes = [graphA, graphB];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn(() => nodes),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing: () => [],
      getIndexedFiles: () => [...nodes.map((entry) => ({
        path: entry.filePath, contentHash: entry.id, parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
      })), ...weakFiles.map((path) => ({
        path, contentHash: path, parseStatus: "failed" as const,
        diagnosticCount: 1, errorCoverage: 1, nodeCount: 0,
      }))],
      searchSource: () => weakFiles.map((filePath, index) => ({
        filePath, startLine: 1, endLine: 20, contentHash: filePath,
        rank: -0.001 + index * 0.0001, matchedTerms: ["alpha"],
      })),
    };

    const selection = selectScope(graph, "alpha beta gamma delta", 16, 4);
    expect(selection.files.map((file) => file.filePath)).toEqual(expect.arrayContaining([
      graphA.filePath, graphB.filePath,
    ]));
    expect(selection.files.filter((file) => weakFiles.includes(file.filePath))).toHaveLength(2);
  });

  it("uses conservative inflection stems for path candidates", () => {
    const target = node("function:assemble", "assemble", 1, { filePath: "src/runtime/assemble.ts" });
    const distractor = node("function:stages", "stages", 1, { filePath: "src/runtime/core.ts" });
    const nodes = [distractor, target];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn(() => nodes),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing: () => [],
      getIndexedFiles: () => [
        { path: "src/runtime/core.ts", contentHash: "core", parseStatus: "ok", diagnosticCount: 0, errorCoverage: 0, nodeCount: 1 },
        { path: "src/runtime/assemble.ts", contentHash: "assemble", parseStatus: "ok", diagnosticCount: 0, errorCoverage: 0, nodeCount: 1 },
      ],
    };

    const selection = selectScope(graph, "where are request stages assembled", 10, 2);
    expect(selection.files[0]).toMatchObject({
      filePath: "src/runtime/assemble.ts", reasons: expect.arrayContaining(["path-match"]),
    });
  });

  it("ranks an exact identifier match first with reasons and category", () => {
    const { graph } = fixture();
    const { candidates, flows, matchedCount } = selectScope(graph, "Seed task", 10);
    expect(matchedCount).toBe(3);
    expect(candidates[0]).toMatchObject({ id: "function:seed", category: "direct" });
    expect(candidates[0]!.score).toBeGreaterThan(candidates[1]!.score);
    expect(candidates[0]!.reasons).toEqual(expect.arrayContaining(["bm25-node", "exact:Seed", "term:seed"]));
    const neighbors = candidates.filter((c) => c.category === "neighbor").map((c) => c.id).sort();
    expect(neighbors).toEqual(["function:callee", "function:caller"]);
    expect(flows).toEqual([{
      steps: [expect.objectContaining({
        source: "function:seed", target: "function:callee", kind: "calls", confidence: 1,
      })],
    }]);
  });

  it("propagates a reliable exact seed through two typed relevance hops", () => {
    const leaf = node("function:leaf", "Leaf", 3);
    const parent = node("function:parent", "parent", 2);
    const top = node("function:top", "top", 1);
    const nodes = [leaf, parent, top];
    const parentToLeaf: GraphEdge = {
      source: parent.id, target: leaf.id, kind: "calls", line: 2, column: 2,
      confidence: 1, resolutionMethod: "typescript-compiler", provenance: "typescript-compiler",
    };
    const topToParent: GraphEdge = {
      source: top.id, target: parent.id, kind: "calls", line: 1, column: 2,
      confidence: 1, resolutionMethod: "typescript-compiler", provenance: "typescript-compiler",
    };
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn(() => [leaf]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [],
      getIncoming: (id) => id === leaf.id
        ? [{ node: parent, edge: parentToLeaf }]
        : id === parent.id ? [{ node: top, edge: topToParent }] : [],
      getOutgoing: (id) => id === parent.id
        ? [{ node: leaf, edge: parentToLeaf }]
        : id === top.id ? [{ node: parent, edge: topToParent }] : [],
    };

    const selection = selectScope(graph, "Leaf", 10);
    expect(selection.candidates.map((candidate) => candidate.id)).toEqual([
      leaf.id, parent.id, top.id,
    ]);
    expect(selection.candidates[0]!.reasons).toContain("exact:Leaf");
    expect(selection.candidates.slice(1).map((candidate) => candidate.category)).toEqual([
      "neighbor", "neighbor",
    ]);
  });

  it("caps returned candidates at maxNodes while reporting the full match count", () => {
    const { graph } = fixture();
    const { candidates, matchedCount } = selectScope(graph, "Seed", 1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe("function:seed");
    expect(matchedCount).toBeGreaterThan(1);
  });

  it("does not expand or display flows from an incidental BM25-only hit", () => {
    const { graph } = fixture();
    graph.getIndexedFiles = () => [{
      path: "src/sample.ts", contentHash: "hash", language: "typescript", size: 1,
      modifiedAt: 1, nodeCount: 5, parseStatus: "ok", diagnosticCount: 0, missingCount: 0, errorCoverage: 0,
    }];
    const selection = selectScope(graph, "documentation architecture topic", 10);
    expect(selection.flows).toEqual([]);
    expect(selection.files[0]).toMatchObject({ filePath: "src/sample.ts", textOnly: true });
  });

  it("emits only contiguous directed paths with seven hops and eight total steps at most", () => {
    const seed = node("function:seed", "Seed", 1);
    const a = node("function:a", "alpha", 2);
    const b = node("function:b", "beta", 3);
    const c = node("function:c", "gamma", 4);
    const d = node("function:d", "delta", 5);
    const nodes = [seed, a, b, c, d];
    const calls = (source: GraphNode, target: GraphNode): { node: GraphNode; edge: GraphEdge } => ({
      node: target,
      edge: { source: source.id, target: target.id, kind: "calls", confidence: 1 },
    });
    const outgoing = new Map([
      [seed.id, [calls(seed, a), calls(seed, b)]],
      [a.id, [calls(a, c)]],
      [b.id, [calls(b, d)]],
    ]);
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn(() => [seed]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [],
      getOutgoing: (id) => outgoing.get(id) ?? [],
      getIndexedFiles: () => [{
        path: "src/sample.ts", contentHash: "hash", language: "typescript", size: 1,
        modifiedAt: 1, nodeCount: 5, parseStatus: "ok", diagnosticCount: 0, missingCount: 0, errorCoverage: 0,
      }],
    };
    const { flows } = selectScope(graph, "Seed", 10);
    expect(flows.map((flow) => flow.steps.map((step) => `${step.source}->${step.target}`))).toEqual([
      ["function:seed->function:a", "function:a->function:c"],
      ["function:seed->function:b", "function:b->function:d"],
    ]);
    expect(flows.flatMap((flow) => flow.steps)).toHaveLength(4);
    const semanticEdges = flows.flatMap((flow) => flow.steps)
      .map((step) => `${step.source}\0${step.target}\0${step.kind}`);
    expect(new Set(semanticEdges).size).toBe(semanticEdges.length);
    expect(flows.flatMap((flow) => flow.steps).length).toBeLessThanOrEqual(8);
    for (const flow of flows) {
      expect(flow.steps.length).toBeLessThanOrEqual(7);
      for (let index = 1; index < flow.steps.length; index += 1) {
        expect(flow.steps[index - 1]!.target).toBe(flow.steps[index]!.source);
      }
    }
  });

  it("traverses A to C through a lexically invisible B file and promotes B for source", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-cross-file-flow-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/bridge.ts"), "export function relay() {\n  return Gamma();\n}\n");
    try {
      const alpha = node("function:alpha", "Alpha", 1, { filePath: "src/alpha.ts" });
      const bridge = node("function:bridge", "relay", 1, {
        filePath: "src/bridge.ts", startLine: 1, endLine: 3,
      });
      const gamma = node("function:gamma", "Gamma", 1, { filePath: "src/gamma.ts" });
      const distractor = node("function:pipeline", "pipelineGuide", 1, { filePath: "src/guide.ts" });
      const nodes = [alpha, bridge, gamma, distractor];
      const alphaBridge: GraphEdge = {
        source: alpha.id, target: bridge.id, kind: "calls", confidence: 1,
      };
      const bridgeGamma: GraphEdge = {
        source: bridge.id, target: gamma.id, kind: "calls", confidence: 1,
      };
      const graph: GraphEngine = {
        build: vi.fn(), sync: vi.fn(), close: vi.fn(),
        searchNodes: vi.fn((query) => {
          const lower = query.toLowerCase();
          if (lower === "alpha") return [alpha];
          if (lower === "gamma") return [gamma];
          if (lower.includes("pipeline")) return [distractor];
          return [alpha, gamma, distractor];
        }),
        getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
        getCallers: () => [], getCallees: () => [],
        getIncoming: (id) => id === bridge.id ? [{ node: alpha, edge: alphaBridge }]
          : id === gamma.id ? [{ node: bridge, edge: bridgeGamma }] : [],
        getOutgoing: (id) => id === alpha.id ? [{ node: bridge, edge: alphaBridge }]
          : id === bridge.id ? [{ node: gamma, edge: bridgeGamma }] : [],
        getIndexedFiles: () => nodes.map((entry) => ({
          path: entry.filePath, contentHash: entry.id, parseStatus: "ok" as const,
          diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
        })),
        // Force a lexical-only file into the initial three-file budget. The
        // flow promotion must evict it in favor of the bridge.
        searchSource: () => [{
          filePath: distractor.filePath, startLine: 1, endLine: 1,
          contentHash: "guide", rank: -5, matchedTerms: ["pipeline"],
        }],
      };

      const selection = selectScope(graph, "Alpha Gamma pipeline", 10, 3);
      expect(selection.files).toHaveLength(3);
      expect(selection.files.map((file) => file.filePath)).toEqual(expect.arrayContaining([
        alpha.filePath, bridge.filePath, gamma.filePath,
      ]));
      expect(selection.files.map((file) => file.filePath)).not.toContain(distractor.filePath);
      expect(selection.files.find((file) => file.filePath === bridge.filePath)).toMatchObject({
        nodeIds: expect.arrayContaining([bridge.id]), textOnly: false,
        reasons: expect.arrayContaining(["flow-spine"]),
      });
      expect(selection.candidates.map((candidate) => candidate.id)).toContain(bridge.id);
      expect(selection.flows[0]?.steps).toEqual([alphaBridge, bridgeGamma]);

      const bridgeRanges = planFileSource(bridge.filePath, [bridge], [], root, "Alpha Gamma", 160);
      expect(bridgeRanges[0]).toMatchObject({ nodeIds: [bridge.id], reason: "whole-file" });
      expect(bridgeRanges[0]!.content).toContain("return Gamma()");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers a query-region callsite into an outside file over an in-budget incidental flow", () => {
    const source = node("function:source", "pipelineEntry", 1, {
      filePath: "src/source.ts", startLine: 1, endLine: 40,
    });
    const target = node("function:target", "semanticTarget", 1, { filePath: "src/target.ts" });
    const incidental = node("function:incidental", "pipelineDispatchCoordinator", 1, {
      filePath: "src/incidental.ts", startLine: 1, endLine: 100,
    });
    const helper = node("function:helper", "internalHelper", 80, { filePath: "src/incidental.ts" });
    const nodes = [source, target, incidental, helper];
    const sourceTarget: GraphEdge = {
      source: source.id, target: target.id, kind: "calls", line: 10, column: 2, confidence: 1,
    };
    const incidentalHelper: GraphEdge = {
      source: incidental.id, target: helper.id, kind: "calls", line: 80, column: 2, confidence: 1,
    };
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn(() => [incidental]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [],
      getOutgoing: (id) => id === source.id ? [{ node: target, edge: sourceTarget }]
        : id === incidental.id ? [{ node: helper, edge: incidentalHelper }] : [],
      getIndexedFiles: () => nodes.map((entry) => ({
        path: entry.filePath, contentHash: entry.id, parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
      })),
      searchSource: () => [{
        filePath: source.filePath, startLine: 1, endLine: 20, contentHash: "source",
        rank: -0.2, matchedTerms: ["pipeline", "dispatch"], nodeIds: [source.id],
      }, {
        filePath: incidental.filePath, startLine: 1, endLine: 20, contentHash: "incidental",
        rank: -0.19, matchedTerms: ["pipeline", "dispatch"], nodeIds: [incidental.id],
      }],
    };

    const selection = selectScope(graph, "pipeline dispatch", 12, 2);
    expect(selection.flows[0]?.steps).toEqual([sourceTarget]);
    expect(selection.files.map((file) => file.filePath)).toEqual(expect.arrayContaining([
      source.filePath, target.filePath,
    ]));
    expect(selection.files.map((file) => file.filePath)).not.toContain(incidental.filePath);
    expect(selection.candidates.find((candidate) => candidate.id === target.id)).toMatchObject({
      reasons: expect.arrayContaining(["graph:calls", "source-region:callsite"]),
    });
    expect(selection.candidates.map((candidate) => candidate.id)).not.toContain(incidental.id);
  });

  it("promotes the cohesive destination of a broad query-region callsite set", () => {
    const origin = node("function:origin", "entry", 1, {
      filePath: "src/origin.ts", startLine: 1, endLine: 100,
    });
    const incidental = node("function:incidental", "opaquePackagePipeline", 1, {
      filePath: "src/incidental.ts", isExported: true,
    });
    const noise = node("function:noise", "packagePipelineHelper", 1, {
      filePath: "src/noise.ts", isExported: true,
    });
    const prepare = node("function:prepare", "prepareState", 1, {
      filePath: "src/resolver.ts", isExported: true,
    });
    const load = node("function:load", "loadScope", 2, {
      filePath: "src/resolver.ts", isExported: true,
    });
    const resolve = node("function:resolve", "resolveDependency", 3, {
      filePath: "src/resolver.ts", isExported: true,
    });
    const helpers = Array.from({ length: 6 }, (_, index) => node(
      `function:helper-${index}`, `helper${index}`, 1,
      { filePath: `src/helper-${index}.ts`, isExported: true },
    ));
    const nodes = [origin, incidental, noise, prepare, load, resolve, ...helpers];
    const call = (target: GraphNode, line: number): GraphEdge => ({
      source: origin.id, target: target.id, kind: "calls", line, column: 2, confidence: 1,
      resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
    });
    // Repeated calls to one declaration must count as one cohesive target,
    // while the resolver destination contributes three distinct declarations.
    // Put that destination ninth so the eight-way branch cap also has to rank
    // destination groups by cohesion instead of preserving insertion order.
    const incidentalCalls = Array.from({ length: 5 }, (_, index) => call(incidental, 5 + index));
    const noiseCall = call(noise, 10);
    const helperCalls = helpers.map((helper, index) => call(helper, 20 + index));
    const resolverCalls = [call(prepare, 40), call(load, 45), call(resolve, 50)];
    const outgoing = [...incidentalCalls, noiseCall, ...helperCalls, ...resolverCalls];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn(() => [incidental, noise, origin]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [],
      getOutgoing: (id) => id === origin.id
        ? outgoing.map((edge) => ({ edge, node: nodes.find((entry) => entry.id === edge.target)! }))
        : [],
      getIndexedFiles: () => nodes.map((entry) => ({
        path: entry.filePath, contentHash: entry.id, parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
      })),
      searchSource: () => [{
        filePath: origin.filePath, startLine: 1, endLine: 100, contentHash: "origin",
        rank: -0.2, matchedTerms: ["opaque", "package", "pipeline"], nodeIds: [origin.id],
      }],
    };

    const selection = selectScope(graph, "opaque package pipeline", 16, 3);
    expect(selection.flows[0]?.steps).toEqual([resolverCalls[2]]);
    expect(selection.files.map((file) => file.filePath)).toEqual(expect.arrayContaining([
      origin.filePath, incidental.filePath, resolve.filePath,
    ]));
    expect(selection.files.map((file) => file.filePath)).not.toContain(noise.filePath);
    expect(selection.candidates.map((candidate) => candidate.id)).toContain(resolve.id);
  });

  it("prefers the query-relevant response-construction edge over a later wrapper call", () => {
    const privateResponse = node("method:new-response", "#newResponse", 608, {
      kind: "method", filePath: "src/context.ts", startLine: 608, endLine: 656,
    });
    const wrapper = node("method:response-wrapper", "newResponse", 658, {
      kind: "method", filePath: "src/context.ts", startLine: 658, endLine: 658,
    });
    const createResponse = node("function:create-response", "createResponseInstance", 288, {
      filePath: "src/context.ts", startLine: 288, endLine: 291,
    });
    const wrapperCall: GraphEdge = {
      source: wrapper.id, target: privateResponse.id, kind: "calls", line: 658, column: 47,
      confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
    };
    const constructionCall: GraphEdge = {
      source: privateResponse.id, target: createResponse.id, kind: "calls", line: 652, column: 11,
      confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
    };
    const nodes = [privateResponse, wrapper, createResponse];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(), searchNodes: vi.fn(() => nodes),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [],
      getIncoming: (id) => id === privateResponse.id ? [{ node: wrapper, edge: wrapperCall }]
        : id === createResponse.id ? [{ node: privateResponse, edge: constructionCall }] : [],
      getOutgoing: (id) => id === wrapper.id ? [{ node: privateResponse, edge: wrapperCall }]
        : id === privateResponse.id ? [{ node: createResponse, edge: constructionCall }] : [],
      getIndexedFiles: () => [{
        path: "src/context.ts", contentHash: "context", parseStatus: "ok", diagnosticCount: 0,
        errorCoverage: 0, nodeCount: nodes.length,
      }],
      searchSource: () => [{
        filePath: "src/context.ts", startLine: 601, endLine: 680, contentHash: "context",
        rank: -0.2, matchedTerms: ["context", "response", "headers", "status"],
        nodeIds: [privateResponse.id, wrapper.id],
      }],
    };

    const selection = selectScope(graph, "context constructs response with prepared headers and status", 2, 1);
    expect(selection.flows[0]?.steps).toEqual([constructionCall]);
    expect(selection.flows.flatMap((flow) => flow.steps)).toContainEqual(wrapperCall);
    expect(selection.flows.flatMap((flow) => flow.steps).length).toBeLessThanOrEqual(8);
  });

  it("reserves two relevant same-region targets ahead of the latest incidental helper", () => {
    const cache = node("function:cache", "cache", 183, {
      filePath: "src/middleware/cache/index.ts", startLine: 183, endLine: 324,
    });
    const digest = node("function:digest", "createQueryDigest", 95, {
      filePath: cache.filePath, startLine: 95, endLine: 153,
    });
    const key = node("function:key", "createCacheKey", 51, {
      filePath: cache.filePath, startLine: 51, endLine: 70,
    });
    const skip = node("function:skip", "shouldSkipCache", 72, {
      filePath: cache.filePath, startLine: 72, endLine: 80,
    });
    const helpers = Array.from({ length: 7 }, (_, index) => node(
      `function:cache-helper-${index}`, `opaqueHelper${index}`, index + 1,
      { filePath: cache.filePath },
    ));
    const call = (target: GraphNode, line: number): GraphEdge => ({
      source: cache.id, target: target.id, kind: "calls", line, column: 2, confidence: 1,
      resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
    });
    const digestCall = call(digest, 277);
    const keyCall = call(key, 296);
    const skipCall = call(skip, 313);
    const helperCalls = helpers.map((helper, index) => call(helper, 300 + index));
    const edges = [...helperCalls, digestCall, keyCall, skipCall];
    const nodes = [cache, digest, key, skip, ...helpers];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(), searchNodes: vi.fn(() => nodes),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [],
      getIncoming: (id) => edges.filter((edge) => edge.target === id).map((edge) => ({
        node: cache, edge,
      })),
      getOutgoing: (id) => id === cache.id ? edges.map((edge) => ({
        node: nodes.find((entry) => entry.id === edge.target)!, edge,
      })) : [],
      getIndexedFiles: () => [{
        path: cache.filePath, contentHash: "cache", parseStatus: "ok", diagnosticCount: 0,
        errorCoverage: 0, nodeCount: nodes.length,
      }],
      searchSource: () => [{
        filePath: cache.filePath, startLine: 241, endLine: 320, contentHash: "cache",
        rank: -0.2, matchedTerms: ["cache", "query", "digest", "key"], nodeIds: [cache.id],
      }],
    };

    const selection = selectScope(graph, "cache query digest key", 3, 1);
    const firstEdges = selection.flows.slice(0, 2).map((flow) => flow.steps[0]);
    expect(firstEdges).toEqual([digestCall, keyCall]);
    expect(firstEdges).not.toContainEqual(skipCall);
    expect(selection.flows.flatMap((flow) => flow.steps).length).toBeLessThanOrEqual(8);
  });

  it("keeps a query-region callsite flow when its declaration falls below the candidate quota", () => {
    const alpha = node("function:alpha", "AlphaBeta", 1, { filePath: "src/source.ts" });
    const gamma = node("function:gamma", "GammaDelta", 2, { filePath: "src/source.ts" });
    const theta = node("function:theta", "ThetaSigma", 3, { filePath: "src/source.ts" });
    const callsite = node("function:callsite", "hiddenDispatcher", 40, {
      filePath: "src/source.ts", startLine: 40, endLine: 60,
    });
    const target = node("function:target", "semanticTarget", 1, {
      filePath: "src/target.ts", isExported: true,
    });
    const distractor = node("function:distractor", "unrelatedHelper", 1, { filePath: "src/noise.ts" });
    const callsiteTarget: GraphEdge = {
      source: callsite.id, target: target.id, kind: "calls", line: 55, column: 2, confidence: 1,
    };
    const competingFlow: GraphEdge = {
      source: alpha.id, target: distractor.id, kind: "calls", line: 1, column: 2, confidence: 1,
    };
    const nodes = [alpha, gamma, theta, callsite, target, distractor];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn((query) => {
        const exact = nodes.find((entry) => entry.name.toLowerCase() === query.toLowerCase());
        return exact ? [exact] : [alpha, gamma, theta];
      }),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [],
      getOutgoing: (id) => id === callsite.id ? [{ node: target, edge: callsiteTarget }]
        : id === alpha.id ? [{ node: distractor, edge: competingFlow }] : [],
      getIndexedFiles: () => nodes.map((entry) => ({
        path: entry.filePath, contentHash: entry.id, parseStatus: "ok" as const,
        diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
      })),
      searchSource: () => [{
        filePath: callsite.filePath, startLine: 40, endLine: 60, contentHash: "source",
        rank: -0.2, matchedTerms: ["pipeline", "target", "operation"], nodeIds: [callsite.id],
      }],
    };

    const selection = selectScope(
      graph,
      "AlphaBeta GammaDelta ThetaSigma pipeline target operation",
      3,
      3,
    );
    expect(selection.candidates.map((candidate) => candidate.id)).not.toContain(callsite.id);
    expect(selection.flows[0]?.steps).toEqual([callsiteTarget]);
    expect(selection.flows.flatMap((flow) => flow.steps)).toContainEqual(competingFlow);
  });

  it("reserves one bounded whole-query call-pair callback completion across file limits", () => {
    const { graph, task, spine, entry, planner } = callPairCallbackCompletionFixture();

    const selections = [4, 5, 6].map((maxFiles) => selectScope(graph, task, 16, maxFiles));

    for (const selection of selections) {
      const pairCandidates = selection.candidates
        .filter((candidate) => candidate.id === entry.id || candidate.id === planner.id);
      expect(pairCandidates.map((candidate) => candidate.id))
        .toEqual(expect.arrayContaining([entry.id, planner.id]));
      expect(pairCandidates.every((candidate) => candidate.reasons.includes("bm25-call-pair"))).toBe(true);
      expect(selection.flows[0]?.steps).toEqual(spine);
      expect(selection.flows.flatMap((flow) => flow.steps).length).toBeLessThanOrEqual(8);
    }
    expect(selections[1]!.flows).toEqual(selections[0]!.flows);
    expect(selections[2]!.flows).toEqual(selections[0]!.flows);
  });

  it("does not reserve a selected same-file callback prefix without whole-query call-pair proof", () => {
    const { graph, task, spine, entry, planner } = callPairCallbackCompletionFixture({ proveCallPair: false });

    const selection = selectScope(graph, task, 16, 4);

    expect(selection.candidates.map((candidate) => candidate.id))
      .toEqual(expect.arrayContaining([entry.id, planner.id]));
    expect(selection.candidates.filter((candidate) => candidate.id === entry.id || candidate.id === planner.id)
      .every((candidate) => !candidate.reasons.includes("bm25-call-pair"))).toBe(true);
    expect(selection.flows).not.toContainEqual({ steps: spine });
    expect(selection.flows.flatMap((flow) => flow.steps).length).toBeLessThanOrEqual(8);
  });

  it.each([
    { label: "query-irrelevant terminal", options: { terminalName: "flushCache" } },
    { label: "weak containment", options: { containmentConfidence: 0.79 } },
    { label: "mismatched callback container", options: { callbackContainerId: "function:other-owner" } },
  ])("does not reserve a selected planner callback completion with $label", ({ options }) => {
    const { graph, task, spine } = callPairCallbackCompletionFixture(options);

    const { flows } = selectScope(graph, task, 16, 12);

    // Ordinary traversal may still discover the shape later; the failed trust
    // gate must prevent it from consuming the priority-reserve position.
    expect(flows[0]?.steps).not.toEqual(spine);
    expect(flows.flatMap((flow) => flow.steps).length).toBeLessThanOrEqual(8);
  });

  it("does not let a pair-only BFS seed displace a query-region callback owner", () => {
    const task = "request validation input header makes validated data available to handlers";
    const requestPath = "src/request.ts";
    const validationPath = "src/validation.ts";
    const pairTarget = node("method:pair-target", "requestHeader", 1, {
      kind: "method", filePath: requestPath,
      signature: "(request: Request, header: string): string",
    });
    const owner = node("function:validation-owner", "validateInput", 1, {
      filePath: validationPath, startLine: 1, endLine: 100,
    });
    const callback = node("function:validation-callback", "<callback:validateInput[0]>", 10, {
      filePath: validationPath, startLine: 10, endLine: 30,
      qualifiedName: "validateInput::<callback:validateInput[0]>", containerId: owner.id,
    });
    const terminal = node("method:validated-data", "addValidatedData", 40, {
      kind: "method", filePath: requestPath, isExported: true,
    });
    const selectedFillers = Array.from({ length: 15 }, (_, index) => node(
      `function:selected-${String(index).padStart(2, "0")}`,
      `inputHandler${index}`,
      index + 50,
      { filePath: index % 2 === 0 ? validationPath : requestPath },
    ));
    const pairSource = node("function:pair-source", "validationRequestMiddleware", 1, {
      filePath: "src/guard.ts", startLine: 1, endLine: 20, isExported: true,
      signature: "(): MiddlewareHandler",
      docstring: "Validation checks the request header and makes validated input available to handlers.",
    });
    const provenanceSeeds = Array.from({ length: 13 }, (_, index) => node(
      `function:provenance-${String(index).padStart(2, "0")}`,
      `opaqueRegion${index}`,
      1,
      { filePath: `src/region-${String(index).padStart(2, "0")}.ts`, startLine: 1, endLine: 10 },
    ));
    const sink = node("function:provenance-sink", "opaqueSink", 1, { filePath: "src/sink.ts" });
    const contains: GraphEdge = {
      source: owner.id, target: callback.id, kind: "contains", line: 10, column: 2,
      confidence: 1, resolutionMethod: "lexical-containment", provenance: "typescript-compiler",
    };
    const validatedCall: GraphEdge = {
      source: callback.id, target: terminal.id, kind: "calls", line: 20, column: 4,
      confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
    };
    const pairCall: GraphEdge = {
      source: pairSource.id, target: pairTarget.id, kind: "calls", line: 5, column: 2,
      confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
    };
    const provenanceCalls = provenanceSeeds.map((source): GraphEdge => ({
      source: source.id, target: sink.id, kind: "calls", line: 5, column: 2,
      confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
    }));
    const fillerCalls = selectedFillers.map((target, index): GraphEdge => ({
      source: owner.id, target: target.id, kind: "calls", line: 50 + index, column: 2,
      confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
    }));
    const nodes = [
      pairTarget, owner, terminal, ...selectedFillers, pairSource, ...provenanceSeeds, callback, sink,
    ];
    const byId = new Map(nodes.map((entry) => [entry.id, entry]));
    const edges = [contains, validatedCall, pairCall, ...provenanceCalls, ...fillerCalls];
    const neighbors = (id: string, direction: "incoming" | "outgoing", kinds?: GraphEdge["kind"][]) => (
      edges.filter((edge) => (direction === "incoming" ? edge.target : edge.source) === id
        && (!kinds || kinds.includes(edge.kind)))
        .map((edge) => ({
          edge,
          node: byId.get(direction === "incoming" ? edge.source : edge.target)!,
        }))
    );
    const wholeQuery = [pairTarget, owner, terminal, ...selectedFillers, pairSource, ...provenanceSeeds];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(), searchNodes: vi.fn(() => wholeQuery),
      getNode: (id) => byId.get(id) ?? null,
      getCallers: () => [], getCallees: () => [],
      getIncoming: (id, kinds) => neighbors(id, "incoming", kinds),
      getOutgoing: (id, kinds) => neighbors(id, "outgoing", kinds),
      getIndexedFiles: () => [...new Set(nodes.map((entry) => entry.filePath))].map((path) => ({
        path, contentHash: path, parseStatus: "ok" as const, diagnosticCount: 0,
        errorCoverage: 0, nodeCount: nodes.filter((entry) => entry.filePath === path).length,
      })),
      searchSource: () => [{
        filePath: validationPath, startLine: 1, endLine: 30, contentHash: "validation",
        rank: -0.3, matchedTerms: ["request", "validation", "input", "validated", "data"],
        nodeIds: [owner.id],
      }, ...provenanceSeeds.map((entry, index) => ({
        filePath: entry.filePath, startLine: 1, endLine: 10, contentHash: entry.id,
        rank: -0.2 + index / 1_000, matchedTerms: ["request", "validation", "input"],
        nodeIds: [entry.id],
      }))],
    };

    const selection = selectScope(graph, task, 18, 2);

    expect(selection.flows[0]?.steps).toEqual([contains, validatedCall]);
    expect(selection.candidates.find((candidate) => candidate.id === pairTarget.id)?.reasons)
      .toContain("bm25-call-pair");
    expect(selection.candidates.map((candidate) => candidate.id)).not.toContain(pairSource.id);
    expect(selection.flows.flatMap((flow) => flow.steps).length).toBeLessThanOrEqual(8);
  });

  it("uses one real containment edge to enter an anonymous callback flow", () => {
    const outer = node("function:outer", "compose", 1);
    const callback = node("function:callback", "<callback:ReturnStatement>", 2, {
      qualifiedName: "compose::<callback:ReturnStatement>",
    });
    const inner = node("function:inner", "dispatch", 3, {
      qualifiedName: "compose::<callback:ReturnStatement>::dispatch",
    });
    const nodes = [outer, callback, inner];
    const contains: GraphEdge = { source: outer.id, target: callback.id, kind: "contains", confidence: 1 };
    const calls: GraphEdge = { source: callback.id, target: inner.id, kind: "calls", confidence: 1 };
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn((query) => query.toLowerCase() === "compose" ? [outer]
        : query.toLowerCase() === "dispatch" ? [inner] : [outer, inner]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [],
      getIncoming: (id) => id === inner.id ? [{ node: callback, edge: calls }]
        : id === callback.id ? [{ node: outer, edge: contains }] : [],
      getOutgoing: (id) => id === outer.id ? [{ node: callback, edge: contains }]
        : id === callback.id ? [{ node: inner, edge: calls }] : [],
      getIndexedFiles: () => [{
        path: "src/sample.ts", contentHash: "hash", language: "typescript", size: 1,
        modifiedAt: 1, nodeCount: 3, parseStatus: "ok", diagnosticCount: 0, missingCount: 0, errorCoverage: 0,
      }],
    };

    const { flows } = selectScope(graph, "compose dispatch", 10);
    expect(flows[0]?.steps).toEqual([contains, calls]);
    expect(flows[0]?.steps.every((edge, index, steps) => index === 0 || steps[index - 1]!.target === edge.source))
      .toBe(true);
  });

  it("replaces an anonymous callback provenance suffix with its named-owner flow", () => {
    const validator = node("function:validator", "validator", 10, {
      startLine: 10, endLine: 35,
    });
    const callback = node("function:validator-callback", "<callback:validator[0]>", 20, {
      qualifiedName: "validator::<callback:validator[0]>", startLine: 20, endLine: 30,
    });
    const addValidatedData = node("method:add-validated-data", "addValidatedData", 40);
    const contains: GraphEdge = {
      source: validator.id, target: callback.id, kind: "contains", line: 20, column: 2,
      confidence: 1, resolutionMethod: "lexical-containment", provenance: "typescript-compiler",
    };
    const calls: GraphEdge = {
      source: callback.id, target: addValidatedData.id, kind: "calls", line: 25, column: 4,
      confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
    };
    const nodes = [validator, callback, addValidatedData];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(), searchNodes: vi.fn(() => [callback]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [],
      getIncoming: (id) => id === callback.id ? [{ node: validator, edge: contains }]
        : id === addValidatedData.id ? [{ node: callback, edge: calls }] : [],
      getOutgoing: (id) => id === validator.id ? [{ node: callback, edge: contains }]
        : id === callback.id ? [{ node: addValidatedData, edge: calls }] : [],
      getIndexedFiles: () => [{
        path: "src/sample.ts", contentHash: "hash", language: "typescript", size: 1,
        modifiedAt: 1, nodeCount: nodes.length, parseStatus: "ok", diagnosticCount: 0,
        missingCount: 0, errorCoverage: 0,
      }],
      searchSource: () => [{
        filePath: "src/sample.ts", startLine: 10, endLine: 30, contentHash: "hash",
        rank: -0.2, matchedTerms: ["validator", "validated", "data"], nodeIds: [validator.id],
      }],
    };

    const { flows } = selectScope(graph, "validator adds validated data", 10, 1);
    expect(flows[0]?.steps).toEqual([contains, calls]);
    expect(flows).not.toContainEqual({ steps: [calls] });
    expect(flows.flatMap((flow) => flow.steps).length).toBeLessThanOrEqual(8);
  });

  it("prefers a non-recursive named owner over a later callback suffix to the same target", () => {
    const compose = node("function:compose", "compose", 15, { startLine: 15, endLine: 73 });
    const composeCallback = node("function:compose-callback", "<callback:ReturnStatement>", 20, {
      qualifiedName: "compose::<callback:ReturnStatement>", containerId: compose.id,
      startLine: 20, endLine: 30,
    });
    const dispatch = node("function:dispatch", "dispatch", 32, { startLine: 32, endLine: 71 });
    const recursiveCallback = node("function:dispatch-callback", "<callback:handler[1]>", 45, {
      qualifiedName: "dispatch::<callback:handler[1]>", containerId: dispatch.id,
      startLine: 45, endLine: 55,
    });
    const containsCompose: GraphEdge = {
      source: compose.id, target: composeCallback.id, kind: "contains", line: 20, column: 2,
      confidence: 1, resolutionMethod: "lexical-containment", provenance: "typescript-compiler",
    };
    const composeDispatch: GraphEdge = {
      source: composeCallback.id, target: dispatch.id, kind: "calls", line: 23, column: 4,
      confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
    };
    const containsRecursive: GraphEdge = {
      source: dispatch.id, target: recursiveCallback.id, kind: "contains", line: 45, column: 2,
      confidence: 1, resolutionMethod: "lexical-containment", provenance: "typescript-compiler",
    };
    const recursiveDispatch: GraphEdge = {
      source: recursiveCallback.id, target: dispatch.id, kind: "calls", line: 51, column: 4,
      confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
    };
    const nodes = [compose, composeCallback, dispatch, recursiveCallback];
    const incoming = new Map<string, Array<{ node: GraphNode; edge: GraphEdge }>>([
      [composeCallback.id, [{ node: compose, edge: containsCompose }]],
      [recursiveCallback.id, [{ node: dispatch, edge: containsRecursive }]],
      [dispatch.id, [
        { node: composeCallback, edge: composeDispatch },
        { node: recursiveCallback, edge: recursiveDispatch },
      ]],
    ]);
    const outgoing = new Map<string, Array<{ node: GraphNode; edge: GraphEdge }>>([
      [compose.id, [{ node: composeCallback, edge: containsCompose }]],
      [composeCallback.id, [{ node: dispatch, edge: composeDispatch }]],
      [dispatch.id, [{ node: recursiveCallback, edge: containsRecursive }]],
      [recursiveCallback.id, [{ node: dispatch, edge: recursiveDispatch }]],
    ]);
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn(() => [compose, dispatch]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [],
      getIncoming: (id) => incoming.get(id) ?? [],
      getOutgoing: (id) => outgoing.get(id) ?? [],
      getIndexedFiles: () => [{
        path: "src/sample.ts", contentHash: "hash", language: "typescript", size: 1,
        modifiedAt: 1, nodeCount: nodes.length, parseStatus: "ok", diagnosticCount: 0,
        missingCount: 0, errorCoverage: 0,
      }],
      searchSource: () => [{
        filePath: "src/sample.ts", startLine: 15, endLine: 60, contentHash: "hash",
        rank: -0.2, matchedTerms: ["compose", "dispatch", "middleware"],
        nodeIds: [compose.id, dispatch.id],
      }],
    };

    const { flows } = selectScope(graph, "compose middleware dispatch", 10, 1);
    expect(flows[0]?.steps).toEqual([containsCompose, composeDispatch]);
    expect(flows.flatMap((flow) => flow.steps)).not.toContainEqual(recursiveDispatch);
    expect(flows[0]?.steps.every((edge, index, steps) => index === 0 || steps[index - 1]!.target === edge.source))
      .toBe(true);
    expect(flows.flatMap((flow) => flow.steps).length).toBeLessThanOrEqual(8);
  });

  it("ranks a cohesive caller-to-relevant-target fork ahead of a lexical leaf's downstream branch", () => {
    const cache = node("function:cache", "cache", 1);
    const digest = node("function:digest", "createQueryDigest", 2);
    const key = node("function:key", "createCacheKey", 3);
    const downstream = node("function:downstream", "cloneRawRequest", 4);
    const nodes = [cache, digest, key, downstream];
    const edge = (source: GraphNode, target: GraphNode): GraphEdge => ({
      source: source.id, target: target.id, kind: "calls", confidence: 1,
    });
    const cacheDigest = edge(cache, digest);
    const cacheKey = edge(cache, key);
    const digestDownstream = edge(digest, downstream);
    const outgoing = new Map<string, Array<{ node: GraphNode; edge: GraphEdge }>>([
      [cache.id, [{ node: digest, edge: cacheDigest }, { node: key, edge: cacheKey }]],
      [digest.id, [{ node: downstream, edge: digestDownstream }]],
    ]);
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn((query) => {
        const lower = query.toLowerCase();
        if (lower === "cache") return [cache, key];
        if (lower === "digest") return [digest];
        if (lower === "key") return [key];
        return [digest, key, cache];
      }),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [],
      getOutgoing: (id) => outgoing.get(id) ?? [],
      getIndexedFiles: () => [{
        path: "src/sample.ts", contentHash: "hash", language: "typescript", size: 1,
        modifiedAt: 1, nodeCount: 4, parseStatus: "ok", diagnosticCount: 0, missingCount: 0, errorCoverage: 0,
      }],
    };

    const { flows } = selectScope(graph, "cache digest key", 10);
    const firstEdges = flows.map((flow) => flow.steps[0]);
    expect(firstEdges).toEqual(expect.arrayContaining([cacheDigest, cacheKey]));
  });

  it("routes test-file nodes into the test quota bucket", () => {
    const testNode = node("function:seed", "seed", 2, { filePath: "src/__tests__/seed.test.ts", signature: "s" });
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn(() => [testNode]),
      getNode: (id) => id === testNode.id ? testNode : null,
      getCallers: () => [], getCallees: () => [],
      getIncoming: () => [], getOutgoing: () => [],
    };
    const { candidates } = selectScope(graph, "seed", 10);
    expect(candidates[0].category).toBe("test");
  });

  it("promotes an owning type and reconstructs a matched function's call flow", () => {
    const plan = node("function:plan", "planSource", 10, {
      filePath: "src/source.ts", docstring: "Plan bounded source expansion for selected graph node identifiers.",
    });
    const owner = node("class:ledger", "BudgetLedger", 1, { kind: "class", filePath: "src/budget.ts" });
    const method = node("method:tokens", "estimatedTokens", 2, {
      kind: "method", qualifiedName: "BudgetLedger.estimatedTokens", filePath: "src/budget.ts",
    });
    const caller = node("function:get", "runGraphGet", 4, { filePath: "src/get.ts" });
    const callee = node("function:read", "readNodeSource", 20, { filePath: "src/read.ts" });
    const nodes = [plan, owner, method, caller, callee];
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn((query) => query.toLowerCase().includes("token") ? [method] : [plan]),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [],
      getIncoming: (id) => id === method.id
        ? [{ node: owner, edge: { source: owner.id, target: method.id, kind: "contains" } }]
        : id === plan.id
          ? [{ node: caller, edge: { source: caller.id, target: plan.id, kind: "calls" } }]
          : [],
      getOutgoing: (id) => id === plan.id
        ? [{ node: callee, edge: { source: plan.id, target: callee.id, kind: "calls" } }]
        : [],
    };

    const budget = selectScope(graph, "maximum output tokens", 5).candidates.map((entry) => entry.id);
    expect(budget).toContain(owner.id);
    const flow = selectScope(graph, "planSource expands selected identifiers into bounded source", 5)
      .candidates.map((entry) => entry.id);
    expect(flow).toEqual(expect.arrayContaining([plan.id, caller.id, callee.id]));
  });

  it("reserves an externally invoked declaration for a distinct strong intent facet", () => {
    const run = (externalBoundary: boolean) => {
      const aligned = node("function:aligned", "scopeRecord", 10, {
        filePath: "src/service.ts", startLine: 10, endLine: 30,
      });
      const boundary = node("function:boundary", "serveGraphScope", 40, {
        filePath: "src/service.ts", isExported: true,
      });
      const external = node("function:external", "commandRoute", 1, { filePath: "src/command.ts" });
      const alignedBoundary: GraphEdge = {
        source: aligned.id, target: boundary.id, kind: "calls", line: 20, column: 2, confidence: 1,
      };
      const externalBoundaryEdge: GraphEdge = {
        source: external.id, target: boundary.id, kind: "calls", line: 2, column: 2, confidence: 1,
      };
      const nodes = [aligned, boundary, external];
      const graph: GraphEngine = {
        build: vi.fn(), sync: vi.fn(), close: vi.fn(), searchNodes: vi.fn(() => [aligned]),
        getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
        getCallers: () => [], getCallees: () => [],
        getIncoming: (id) => id === boundary.id ? [
          { node: aligned, edge: alignedBoundary },
          ...(externalBoundary ? [{ node: external, edge: externalBoundaryEdge }] : []),
        ] : [],
        getOutgoing: (id) => id === aligned.id ? [{ node: boundary, edge: alignedBoundary }]
          : id === external.id && externalBoundary ? [{ node: boundary, edge: externalBoundaryEdge }] : [],
        getIndexedFiles: () => nodes.map((entry) => ({
          path: entry.filePath, contentHash: entry.id, parseStatus: "ok" as const,
          diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
        })),
        searchSource: () => [{
          filePath: aligned.filePath, startLine: 10, endLine: 30, contentHash: "service",
          rank: -0.2, matchedTerms: ["build", "graph", "answer", "scope", "request"],
          nodeIds: [aligned.id],
        }],
      };
      return { selection: selectScope(graph, "build graph answer scope request", 4, 2), aligned, boundary };
    };

    const positive = run(true);
    expect(positive.selection.candidates[0]?.id).toBe(positive.boundary.id);
    expect(positive.selection.files.find((file) => file.filePath === positive.boundary.filePath)?.nodeIds[0])
      .toBe(positive.boundary.id);

    const inverse = run(false);
    expect(inverse.selection.candidates[0]?.id).toBe(inverse.aligned.id);
  });

  it("admits only a whole-query call pair whose callee adds independent low-signal concepts", () => {
    const run = (addsConcepts: boolean) => {
      const entry = node("function:entry", "openGraphItem", 1, {
        filePath: "src/adapter.ts", isExported: true,
        signature: "(client: AgentClient): void", docstring: "Node source operation.",
      });
      const target = node("function:target", addsConcepts ? "stageNodeSource" : "stageGraphAgent", 20, {
        filePath: "src/adapter.ts",
        signature: addsConcepts ? "(node: GraphNode): SourceRange" : "(client: AgentClient): void",
      });
      const distractors = Array.from({ length: 35 }, (_, index) => node(
        `function:noise-${index}`, `opaque${index}`, index + 40, { filePath: `src/noise-${index}.ts` },
      ));
      const nodes = [entry, target, ...distractors];
      const call: GraphEdge = {
        source: entry.id, target: target.id, kind: "calls", line: 8, column: 2,
        confidence: 1, resolutionMethod: "typescript-signature", provenance: "typescript-compiler",
      };
      const task = "agent graph node source";
      const graph: GraphEngine = {
        build: vi.fn(), sync: vi.fn(), close: vi.fn(),
        searchNodes: vi.fn((query) => query === task ? [...distractors, entry, target] : []),
        getNode: (id) => nodes.find((candidate) => candidate.id === id) ?? null,
        getCallers: () => [], getCallees: () => [],
        getIncoming: (id) => id === target.id ? [{ node: entry, edge: call }] : [],
        getOutgoing: (id) => id === entry.id ? [{ node: target, edge: call }] : [],
        getIndexedFiles: () => [{
          path: entry.filePath, contentHash: "adapter", parseStatus: "ok",
          diagnosticCount: 0, errorCoverage: 0, nodeCount: 2,
        }],
        searchSource: () => [],
      };
      return { selection: selectScope(graph, task, 4, 1), entry, target };
    };

    const positive = run(true);
    expect(positive.selection.candidates.slice(0, 2).map((candidate) => candidate.id))
      .toEqual([positive.entry.id, positive.target.id]);
    expect(positive.selection.candidates.slice(0, 2).every((candidate) => (
      candidate.reasons.includes("bm25-call-pair")
    ))).toBe(true);

    const inverse = run(false);
    expect(inverse.selection.candidates.map((candidate) => candidate.id))
      .not.toEqual(expect.arrayContaining([inverse.entry.id, inverse.target.id]));
  });

  it("bounds whole-query call-pair adjacency before loading outgoing edges", () => {
    const task = "agent graph node source";
    const nodes = Array.from({ length: 80 }, (_, index) => node(
      `function:pair-bound-${String(index).padStart(2, "0")}`,
      `agentGraphNodeSource${index}`,
      index + 1,
      { filePath: `src/pair-${index}.ts`, isExported: true },
    ));
    const getOutgoing = vi.fn((_id: string, _kinds?: GraphEdge["kind"][]) => []);
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(),
      searchNodes: vi.fn((query) => query === task ? nodes : []),
      getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing,
    };

    selectScope(graph, task, 4, 1);

    const pairLookups = getOutgoing.mock.calls.filter(([, kinds]) => (
      kinds?.length === 2 && kinds[0] === "calls" && kinds[1] === "instantiates"
    ));
    expect(pairLookups).toHaveLength(64);
    expect(pairLookups.map(([id]) => id)).toEqual(nodes.slice(0, 64).map((entry) => entry.id));
  });

  it("deduplicates node searches by normalized query text", () => {
    const seed = node("function:seed", "Seed", 1);
    const searchNodes = vi.fn((_query: string) => [seed]);
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(), searchNodes,
      getNode: (id) => id === seed.id ? seed : null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing: () => [],
    };

    selectScope(graph, "Seed", 10);
    const normalized = searchNodes.mock.calls.map(([query]) => query.trim().replace(/\s+/g, " ").toLowerCase());
    expect(new Set(normalized).size).toBe(normalized.length);
    expect(normalized.filter((query) => query === "seed")).toHaveLength(1);
  });

  it("loads repeated source-region node ids once per selection", () => {
    const source = node("function:source", "processPipeline", 1, {
      filePath: "src/pipeline.ts", startLine: 1, endLine: 20,
    });
    const getNode = vi.fn((id: string) => id === source.id ? source : null);
    const graph: GraphEngine = {
      build: vi.fn(), sync: vi.fn(), close: vi.fn(), searchNodes: vi.fn(() => []), getNode,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing: () => [],
      getIndexedFiles: () => [{
        path: source.filePath, contentHash: "source", parseStatus: "ok", diagnosticCount: 0,
        errorCoverage: 0, nodeCount: 1,
      }],
      searchSource: () => [1, 2, 3].map((startLine) => ({
        filePath: source.filePath, startLine, endLine: startLine + 5, contentHash: "source",
        rank: -0.2, matchedTerms: ["process", "pipeline"], nodeIds: [source.id, source.id],
      })),
    };

    selectScope(graph, "process pipeline", 10);
    expect(getNode).toHaveBeenCalledTimes(1);
    expect(getNode).toHaveBeenCalledWith(source.id);
  });

  it("keeps adjacency work fixed when an exact seed has hundreds of callers", () => {
    const run = (fanIn: number): number => {
      const seed = node("function:seed", "Seed", 1);
      const callers = Array.from({ length: fanIn }, (_, index) => node(
        `function:caller-${String(index).padStart(4, "0")}`,
        `caller${String(index).padStart(4, "0")}`,
        index + 2,
      ));
      const children = new Map(callers.map((caller) => [caller.id, Array.from({ length: 8 }, (_, index) => node(
        `${caller.id}:child-${index}`,
        `child${index}`,
        index + 1,
      ))]));
      const incoming = vi.fn((id: string) => id === seed.id ? callers.map((caller) => ({
        node: caller,
        edge: { source: caller.id, target: seed.id, kind: "calls" as const, confidence: 1 },
      })) : []);
      const outgoing = vi.fn((id: string) => (children.get(id) ?? []).map((child) => ({
        node: child,
        edge: { source: id, target: child.id, kind: "calls" as const, confidence: 1 },
      })));
      const graph: GraphEngine = {
        build: vi.fn(), sync: vi.fn(), close: vi.fn(), searchNodes: vi.fn(() => [seed]),
        getNode: (id) => id === seed.id ? seed : callers.find((caller) => caller.id === id) ?? null,
        getCallers: () => [], getCallees: () => [], getIncoming: incoming, getOutgoing: outgoing,
      };

      selectScope(graph, "Seed", 1);
      return incoming.mock.calls.length + outgoing.mock.calls.length;
    };

    const boundedFanIn = run(40);
    const extremeFanIn = run(500);
    expect(extremeFanIn).toBe(boundedFanIn);
    expect(extremeFanIn).toBeLessThanOrEqual(220);
  });
});
