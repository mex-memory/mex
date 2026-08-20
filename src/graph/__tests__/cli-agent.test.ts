// Integration test for the agent-facing JSONL commands. Builds a real graph over
// a tiny project and drives runGraphScope / runGraphQuery / runGraphGet / runImpact
// through injected session + capturing writer, asserting the protocol contract:
// meta first, source-bearing Scope by default, summary last, budget truncation,
// directed flow records, and narrow source-on-demand via `graph get`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGraphEngine } from "../index.js";
import type { GraphEngine } from "../engine.js";
import type { GraphEdge, GraphNode } from "../types.js";
import type { RankedScopeFile, ScopedCandidate, SourceRange } from "../scope.js";
import { openSqlite } from "../db/sqlite.js";
import {
  bestSemanticQuerySourceCandidate,
  runGraphGet, runGraphQuery, runGraphScope, runImpact, type AgentCommandDeps,
} from "../cli-agent.js";

let root: string;
let engine: GraphEngine;
let deps: AgentCommandDeps;
let lines: string[];

function capture(fn: () => void): Record<string, unknown>[] {
  lines = [];
  fn();
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function idOf(name: string): string {
  const hit = engine.searchNodes(name).find((n) => n.name === name);
  if (!hit) throw new Error(`no node ${name}`);
  return hit.id;
}

function syntheticScopeGraph(options: {
  nodes: GraphNode[];
  edges?: GraphEdge[];
  sources: Array<{ path: string; content: string }>;
  searchNodes: (request: string) => GraphNode[];
  sourceHits?: Array<{
    filePath: string; startLine: number; endLine: number; contentHash: string;
    rank: number; matchedTerms: string[]; nodeIds?: string[];
  }>;
}): GraphEngine {
  const edges = options.edges ?? [];
  const nodeById = new Map(options.nodes.map((node) => [node.id, node]));
  return {
    build: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 }),
    sync: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 }),
    close: () => {},
    searchNodes: options.searchNodes,
    searchSource: () => options.sourceHits ?? [],
    getNode: (id) => nodeById.get(id) ?? null,
    getCallers: (id) => edges.filter((edge) => edge.target === id)
      .flatMap((edge) => nodeById.get(edge.source) ?? []),
    getCallees: (id) => edges.filter((edge) => edge.source === id)
      .flatMap((edge) => nodeById.get(edge.target) ?? []),
    getIncoming: (id) => edges.filter((edge) => edge.target === id)
      .flatMap((edge) => {
        const node = nodeById.get(edge.source);
        return node ? [{ edge, node }] : [];
      }),
    getOutgoing: (id) => edges.filter((edge) => edge.source === id)
      .flatMap((edge) => {
        const node = nodeById.get(edge.target);
        return node ? [{ edge, node }] : [];
      }),
    getIndexedFiles: () => options.sources.map(({ path, content }) => ({
      path, contentHash: createHash("sha256").update(content).digest("hex"),
      language: "typescript", size: content.length, modifiedAt: 1,
      nodeCount: options.nodes.filter((node) => node.filePath === path).length,
      parseStatus: "ok" as const, diagnosticCount: 0, missingCount: 0, errorCoverage: 0,
    })),
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mex-cli-agent-"));
  writeFileSync(join(root, "util.ts"), `export function helper(x: number): number {\n  return x + 1;\n}\n`);
  writeFileSync(
    join(root, "main.ts"),
    `import { helper } from "./util";\n` +
      `export function run(): number {\n  return helper(41);\n}\n` +
      `export class App {\n  start(): number { return run(); }\n}\n`,
  );
  engine = createGraphEngine({ rootDir: root });
  await engine.build(root);
  const db = openSqlite(join(root, ".mex", "graph.db"));
  deps = { open: () => ({ graph: engine, db, close: () => {} }), write: (line) => lines.push(line) };
});

afterAll(() => {
  engine.close();
  rmSync(root, { recursive: true, force: true });
});

describe("semantic query source reservation", () => {
  const node = (id: string, name: string, filePath: string, signature?: string): GraphNode => ({
    id, kind: "function", name, qualifiedName: name, signature,
    filePath, language: "typescript", startLine: 1, endLine: 20,
    startColumn: 0, endColumn: 1, updatedAt: 1,
  });
  const file = (entry: GraphNode): RankedScopeFile => ({
    filePath: entry.filePath, score: 1, reasons: [], nodeIds: [entry.id],
    textHits: [], textOnly: false, parseStatus: "ok",
  });
  const candidate = (id: string, score: number, reasons: string[]): ScopedCandidate => ({
    id, score, reasons, category: "direct",
  });

  it("groups identifier terms by raw query concept and rejects stronger term-only evidence", () => {
    const commandLine = node("command-line", "commandLineWorker", "command.ts");
    const answer = node(
      "config-answer", "findConfigFile", "config.ts",
      "(searchPath: string, configName?: string): string | undefined",
    );
    const termOnly = node(
      "term-only", "searchConfigFile", "lexical.ts",
      "(searchPath: string, configName?: string): string | undefined",
    );
    const contextual = node(
      "contextual", "performIncrementalCompilation", "command.ts",
      "(config: ParsedCommandLine): void",
    );
    const nodes = new Map([commandLine, answer, termOnly, contextual].map((entry) => [entry.id, entry]));
    const candidates = [
      candidate(commandLine.id, 100, [
        "bm25-node", "graph:calls", "source-region:callsite", "term:command", "term:line",
      ]),
      candidate(termOnly.id, 200, ["bm25-node", "term:search", "term:confi"]),
      // Contextual signature coverage (`compilation` + `config`) is useful,
      // but two independently corroborated answer concepts are stronger.
      candidate(contextual.id, 300, [
        "bm25-node", "graph:calls", "source-region:callsite", "term:compilation",
      ]),
      candidate(answer.id, 1, ["graph:calls", "source-region:callsite", "term:search", "term:confi"]),
    ];
    expect(bestSemanticQuerySourceCandidate(
      "Where does command-line compilation search upward for a project configuration?",
      candidates, [file(commandLine), file(termOnly), file(contextual), file(answer)], nodes,
    )).toBe(answer.id);
  });

  it("counts direct declaration concepts beyond the first recorded term channel", () => {
    const target = node(
      "source-planner", "planFileSource", "scope.ts",
      "(nodes: GraphNode[], textHits: SourceChunkHit[]): SourceRange[]",
    );
    const decoy = node(
      "query-planner", "planGraphQuery", "query.ts",
      "(query: string): GraphQueryPlan",
    );
    const nodes = new Map([target, decoy].map((entry) => [entry.id, entry]));
    expect(bestSemanticQuerySourceCandidate(
      "How does Scope plan bounded source windows for selected symbols and query hits?",
      [
        candidate(decoy.id, 200, [
          "bm25-node", "graph:calls", "source-region:callsite", "term:bounded", "term:plan",
        ]),
        // Scope records only the first matching term for a search channel.
        // `source` and `hits` are still explicit declaration components and
        // must contribute once `term:plan` independently corroborates it.
        candidate(target.id, 1, [
          "bm25-node", "graph:calls", "source-region:callsite",
          "term:plan", "term:symbols", "term:windows",
        ]),
      ],
      [file(decoy), file(target)], nodes,
    )).toBe(target.id);
  });

  it("does not reserve lexical-only or anonymous callback candidates", () => {
    const termOnly = node(
      "term-only", "searchConfigFile", "lexical.ts",
      "(searchPath: string, configName?: string): string | undefined",
    );
    const anonymous = node(
      "anonymous", "<callback:searchConfigFile>", "callback.ts",
      "(searchPath: string, configName?: string): string | undefined",
    );
    const nodes = new Map([termOnly, anonymous].map((entry) => [entry.id, entry]));
    expect(bestSemanticQuerySourceCandidate(
      "search project configuration",
      [
        candidate(termOnly.id, 100, ["bm25-node", "term:search", "term:project", "term:confi"]),
        candidate(anonymous.id, 200, [
          "graph:calls", "source-region:callsite", "term:search", "term:project", "term:confi",
        ]),
      ],
      [file(termOnly), file(anonymous)], nodes,
    )).toBeUndefined();
  });
});

describe("runGraphScope", () => {
  it("uses protocol v3 and returns source in the first response by default", () => {
    const records = capture(() => runGraphScope("run", root, deps, {}));
    expect(records[0]).toMatchObject({
      type: "meta", protocolVersion: 3, schemaVersion: 3, command: "graph scope", detail: "source",
      maxFiles: 4, maxFlowSteps: 8, maxOutputTokens: 3500,
    });
    expect(records[1]).toMatchObject({ type: "health", indexedFiles: 2, okFiles: 2, failedFiles: 0 });
    const sources = records.filter((r) => r.type === "source");
    expect(sources.length).toBeGreaterThan(0);
    expect(JSON.stringify(sources)).toContain("helper(41)");
    expect(JSON.stringify(sources)).toMatch(/\d+: .*helper/);
    const facts = records.filter((r) => r.type === "fact");
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) {
      expect(fact).not.toHaveProperty("source");
      expect(fact).not.toHaveProperty("callers");
      expect(fact).not.toHaveProperty("detail");
      expect(fact).not.toHaveProperty("sourceIncluded");
      expect(fact).not.toHaveProperty("bodyHash");
      expect(typeof fact.callerCount).toBe("number");
      expect(typeof fact.score).toBe("number");
      expect(fact).not.toHaveProperty("selectionReasons");
    }
    const summary = records.at(-1)!;
    expect(summary).toMatchObject({
      type: "summary", status: "ok", evidenceStrength: "strong",
      returnedFiles: expect.arrayContaining(["main.ts"]), textFallbackFiles: [], suggestedNextCommands: [],
    });
    expect(summary.sourceBackedNodes).toEqual(expect.arrayContaining(facts.map((fact) => fact.id)));
    expect(typeof summary.estimatedOutputTokens).toBe("number");
    expect(typeof summary.truncated).toBe("boolean");
    expect(records.findIndex((r) => r.type === "source")).toBeLessThan(records.findIndex((r) => r.type === "fact"));
  });

  it("emits grouped source records when detail is source", () => {
    const records = capture(() => runGraphScope("run", root, deps, { detail: "source" }));
    const source = records.filter((r) => r.type === "source");
    expect(source.length).toBeGreaterThan(0);
    const joined = JSON.stringify(source);
    expect(joined).toContain("helper");
  });

  it("rejects an output-token budget too small for honest protocol framing", () => {
    const records = capture(() => runGraphScope("run", root, deps, { maxOutputTokens: 60 }));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "error", code: "INVALID_OUTPUT_BUDGET" });
    expect(records[0]!.message).toContain("use at least");
  });

  it("caps the number of returned facts at maxNodes", () => {
    const records = capture(() => runGraphScope("run", root, deps, { maxNodes: 1 }));
    expect(records.filter((r) => r.type === "fact")).toHaveLength(1);
  });

  it("keeps the full-query declaration source ahead of a whole-file lexical distractor", () => {
    const isolated = mkdtempSync(join(tmpdir(), "mex-source-full-query-"));
    const scopeLines = Array.from({ length: 260 }, (_, index) => `// scope filler ${index + 1}`);
    scopeLines[0] = "export function selectScope(): void {";
    scopeLines[79] = "}";
    scopeLines[119] = "export function planSourceWindows(symbols: unknown[]): unknown[] {";
    for (let line = 120; line < 149; line++) scopeLines[line] = `  // bounded source window ${line + 1}`;
    scopeLines[149] = "  return symbols;";
    scopeLines[150] = "}";
    const queryLines = Array.from({ length: 183 }, (_, index) => (
      `// query planning distraction ${index + 1} ${"x".repeat(32)}`
    ));
    queryLines[116] = "export function planGraphQuery(query: string): string {";
    queryLines[168] = "  return query;";
    queryLines[169] = "}";
    const scopeSource = scopeLines.join("\n");
    const querySource = queryLines.join("\n");
    writeFileSync(join(isolated, "scope.ts"), scopeSource);
    writeFileSync(join(isolated, "query.ts"), querySource);

    const sourceDecoy: GraphNode = {
      id: "function:source-decoy", kind: "function", name: "selectScope", qualifiedName: "selectScope",
      filePath: "scope.ts", language: "typescript", startLine: 1, endLine: 80,
      startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const target: GraphNode = {
      id: "function:source-planner", kind: "function", name: "planSourceWindows",
      qualifiedName: "planSourceWindows", signature: "(symbols: unknown[]): unknown[]",
      filePath: "scope.ts", language: "typescript", startLine: 120, endLine: 151,
      startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const queryPlanner: GraphNode = {
      id: "function:query-planner", kind: "function", name: "planGraphQuery",
      qualifiedName: "planGraphQuery", signature: "(query: string): string",
      filePath: "query.ts", language: "typescript", startLine: 117, endLine: 170,
      startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const graphNodes = [target, sourceDecoy, queryPlanner];
    const query = "plan bounded source windows";
    const graph: GraphEngine = {
      build: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 }),
      sync: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 }),
      close: () => {},
      searchNodes: (request) => request === query || ["plan", "source", "windows"].includes(request)
        ? [target, queryPlanner] : request === "bounded" ? [queryPlanner] : [],
      getNode: (id) => graphNodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing: () => [],
      searchSource: () => [{
        filePath: sourceDecoy.filePath, startLine: 1, endLine: 80,
        contentHash: createHash("sha256").update(scopeSource).digest("hex"), rank: -0.4,
        matchedTerms: ["plan", "bounded", "source", "windows"], nodeIds: [sourceDecoy.id],
      }, {
        filePath: target.filePath, startLine: 101, endLine: 160,
        contentHash: createHash("sha256").update(scopeSource).digest("hex"), rank: -0.3,
        matchedTerms: ["plan", "source", "windows"], nodeIds: [target.id],
      }, {
        filePath: queryPlanner.filePath, startLine: 101, endLine: 180,
        contentHash: createHash("sha256").update(querySource).digest("hex"), rank: -0.2,
        matchedTerms: ["plan", "bounded"], nodeIds: [queryPlanner.id],
      }],
      getIndexedFiles: () => [{
        path: target.filePath, contentHash: createHash("sha256").update(scopeSource).digest("hex"),
        parseStatus: "ok", diagnosticCount: 0, errorCoverage: 0, nodeCount: 2,
      }, {
        path: queryPlanner.filePath, contentHash: createHash("sha256").update(querySource).digest("hex"),
        parseStatus: "ok", diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
      }],
    };
    const db = deps.open!(root).db;
    const directDeps: AgentCommandDeps = {
      open: () => ({ graph, db, close: () => {} }),
      write: (line) => lines.push(line),
    };
    try {
      const records = capture(() => runGraphScope(query, isolated, directDeps, {
        maxNodes: 1, maxFiles: 2, maxSourceLines: 200, maxOutputTokens: 1800,
      }));
      const sources = records.filter((record) => record.type === "source");
      const targetIndex = sources.findIndex((record) => (record.ranges as Array<{ nodeIds: string[] }>)
        .some((range) => range.nodeIds.includes(target.id)));
      const queryWholeFileIndex = sources.findIndex((record) => record.filePath === queryPlanner.filePath
        && (record.ranges as Array<{ startLine: number; endLine: number }>).some((range) => (
          range.startLine === 1 && range.endLine === 183
        )));
      expect(targetIndex, JSON.stringify(records)).toBeGreaterThanOrEqual(0);
      expect(sources[targetIndex]).toMatchObject({
        filePath: target.filePath,
        ranges: [expect.objectContaining({
          startLine: target.startLine, endLine: target.endLine, nodeIds: [target.id], truncated: false,
        })],
      });
      expect(queryWholeFileIndex === -1 || queryWholeFileIndex > targetIndex).toBe(true);
      expect(records.at(-1)!.estimatedOutputTokens as number).toBeLessThanOrEqual(1800);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("includes selection diagnostics only at standard detail", () => {
    const records = capture(() => runGraphScope("run", root, deps, { detail: "standard" }));
    const facts = records.filter((r) => r.type === "fact");
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) expect(Array.isArray(fact.selectionReasons)).toBe(true);
  });

  it("emits an exact named symbol before a larger flow-spine file under a tight budget", () => {
    const isolated = mkdtempSync(join(tmpdir(), "mex-source-priority-"));
    const targetLines = Array.from({ length: 220 }, (_, index) => `// target filler ${index + 1}`);
    targetLines.splice(199, 6,
      "export function TargetSymbol(): number {", "  return 1;", "}", "", "", "");
    const flowLines = Array.from({ length: 220 }, (_, index) => `// flow filler ${index + 1}`);
    flowLines[0] = "export function firstStage(): number {";
    flowLines[69] = "}";
    flowLines[89] = "export function secondStage(): number {";
    flowLines[90] = "  return TargetSymbol();";
    flowLines[159] = "}";
    const targetSource = targetLines.join("\n");
    const flowSource = flowLines.join("\n");
    writeFileSync(join(isolated, "target.ts"), targetSource);
    writeFileSync(join(isolated, "flow.ts"), flowSource);

    const target: GraphNode = {
      id: "function:target", kind: "function", name: "TargetSymbol", qualifiedName: "TargetSymbol",
      filePath: "target.ts", language: "typescript", startLine: 200, endLine: 202,
      startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const first: GraphNode = {
      id: "function:first", kind: "function", name: "firstStage", qualifiedName: "firstStage",
      filePath: "flow.ts", language: "typescript", startLine: 1, endLine: 70,
      startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const second: GraphNode = {
      id: "function:second", kind: "function", name: "secondStage", qualifiedName: "secondStage",
      filePath: "flow.ts", language: "typescript", startLine: 90, endLine: 160,
      startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const graphNodes = [target, first, second];
    const graphEdges: GraphEdge[] = [
      { source: first.id, target: second.id, kind: "calls", line: 40, column: 2, confidence: 1 },
      { source: second.id, target: target.id, kind: "calls", line: 91, column: 2, confidence: 1 },
    ];
    const graph: GraphEngine = {
      build: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, parseErrors: [], durationMs: 0 }),
      sync: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, parseErrors: [], durationMs: 0 }),
      close: () => {},
      searchNodes: () => [target],
      getNode: (id) => graphNodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [],
      getIncoming: (id) => graphEdges.filter((edge) => edge.target === id).map((edge) => ({
        edge, node: graphNodes.find((entry) => entry.id === edge.source)!,
      })),
      getOutgoing: (id) => graphEdges.filter((edge) => edge.source === id).map((edge) => ({
        edge, node: graphNodes.find((entry) => entry.id === edge.target)!,
      })),
      getIndexedFiles: () => [
        {
          path: "target.ts", contentHash: createHash("sha256").update(targetSource).digest("hex"),
          language: "typescript", size: targetSource.length, modifiedAt: 1, nodeCount: 1,
          parseStatus: "ok", diagnosticCount: 0, missingCount: 0, errorCoverage: 0,
        },
        {
          path: "flow.ts", contentHash: createHash("sha256").update(flowSource).digest("hex"),
          language: "typescript", size: flowSource.length, modifiedAt: 1, nodeCount: 2,
          parseStatus: "ok", diagnosticCount: 0, missingCount: 0, errorCoverage: 0,
        },
      ],
    };
    const db = deps.open!(root).db;
    const priorityDeps: AgentCommandDeps = {
      open: () => ({ graph, db, close: () => {} }),
      write: (line) => lines.push(line),
    };
    try {
      const records = capture(() => runGraphScope("TargetSymbol", isolated, priorityDeps, {
        maxOutputTokens: 1200, maxSourceLines: 200,
      }));
      const sources = records.filter((record) => record.type === "source");
      expect(sources.length, JSON.stringify(records)).toBeGreaterThan(0);
      expect(sources[0]).toMatchObject({ type: "source", filePath: "target.ts", evidence: "graph" });
      expect(JSON.stringify(sources[0])).toContain("TargetSymbol");
      // Under this deliberately tight budget the two complete flow bodies do
      // not fit atomically. Preserve the directed flow record instead of
      // emitting a misleading signature/tail fragment.
      expect(records.some((record) => record.type === "flow")).toBe(true);
      const summary = records.at(-1)!;
      expect(summary).toMatchObject({ status: "ok", truncated: true });
      expect(summary.estimatedOutputTokens as number).toBeLessThanOrEqual(summary.maxOutputTokens as number);

      const roomy = capture(() => runGraphScope("TargetSymbol", isolated, priorityDeps, {
        maxOutputTokens: 2400, maxSourceLines: 200,
      }));
      const flowRanges = roomy.filter((record) => record.type === "source" && record.filePath === "flow.ts")
        .flatMap((record) => record.ranges as Array<{
          startLine: number; endLine: number; truncated: boolean; nodeIds: string[];
        }>);
      expect(flowRanges).toEqual(expect.arrayContaining([
        expect.objectContaining({ startLine: 1, endLine: 70, truncated: false }),
        expect.objectContaining({ startLine: 90, endLine: 160, truncated: false }),
      ]));
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("keeps an explicit exact lookup ahead of an unrelated displayed-flow target", () => {
    const isolated = mkdtempSync(join(tmpdir(), "mex-source-exact-before-flow-"));
    const exactSource = "export function TargetSymbol(): number {\n  return unrelatedFlowTarget();\n}\n";
    const flowSource = "export function unrelatedFlowTarget(): number {\n  return 1;\n}\n";
    writeFileSync(join(isolated, "target.ts"), exactSource);
    writeFileSync(join(isolated, "flow.ts"), flowSource);
    const exact: GraphNode = {
      id: "function:exact-before-flow", kind: "function", name: "TargetSymbol", qualifiedName: "TargetSymbol",
      filePath: "target.ts", language: "typescript", startLine: 1, endLine: 3,
      startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const flowTarget: GraphNode = {
      id: "function:unrelated-flow-target", kind: "function", name: "unrelatedFlowTarget",
      qualifiedName: "unrelatedFlowTarget", filePath: "flow.ts", language: "typescript",
      startLine: 1, endLine: 3, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const edge: GraphEdge = {
      source: exact.id, target: flowTarget.id, kind: "calls", line: 2, column: 2, confidence: 1,
    };
    const graph: GraphEngine = {
      build: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 }),
      sync: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 }),
      close: () => {}, searchNodes: () => [exact], searchSource: () => [],
      getNode: (id) => [exact, flowTarget].find((node) => node.id === id) ?? null,
      getCallers: () => [], getCallees: () => [],
      getIncoming: (id) => id === flowTarget.id ? [{ edge, node: exact }] : [],
      getOutgoing: (id) => id === exact.id ? [{ edge, node: flowTarget }] : [],
      getIndexedFiles: () => [
        {
          path: exact.filePath, contentHash: createHash("sha256").update(exactSource).digest("hex"),
          language: "typescript", size: exactSource.length, modifiedAt: 1, nodeCount: 1,
          parseStatus: "ok", diagnosticCount: 0, missingCount: 0, errorCoverage: 0,
        },
        {
          path: flowTarget.filePath, contentHash: createHash("sha256").update(flowSource).digest("hex"),
          language: "typescript", size: flowSource.length, modifiedAt: 1, nodeCount: 1,
          parseStatus: "ok", diagnosticCount: 0, missingCount: 0, errorCoverage: 0,
        },
      ],
    };
    const db = deps.open!(root).db;
    const exactDeps: AgentCommandDeps = {
      open: () => ({ graph, db, close: () => {} }),
      write: (line) => lines.push(line),
    };
    try {
      const records = capture(() => runGraphScope(
        "TargetSymbol", isolated, exactDeps,
        { maxOutputTokens: 1500, maxSourceLines: 200, maxFiles: 2 },
      ));
      const sources = records.filter((record) => record.type === "source");
      expect(sources[0], JSON.stringify(records)).toMatchObject({
        filePath: exact.filePath,
        ranges: [expect.objectContaining({ nodeIds: [exact.id], truncated: false })],
      });
      expect(records.some((record) => record.type === "flow")).toBe(true);
      expect(records.at(-1)!.estimatedOutputTokens as number).toBeLessThanOrEqual(1500);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("does not treat unrelated primary source and flow coverage as completion of a nested query body", () => {
    const isolated = mkdtempSync(join(tmpdir(), "scope-source-completeness-"));
    const primaryLines = Array.from({ length: 70 }, (_, index) => `// primary selection ${index + 1}`);
    primaryLines[0] = "export class PrimarySelector {";
    primaryLines[68] = "  choose(): void {}";
    primaryLines[69] = "}";
    const secondaryLines = Array.from({ length: 150 }, (_, index) => `// secondary flow ${index + 1}`);
    secondaryLines[0] = "export function collectBackgroundPaths(): void {";
    secondaryLines[79] = "  function matchBackgroundPaths(): void {";
    secondaryLines[148] = "  }";
    secondaryLines[149] = "}";
    const primarySource = primaryLines.join("\n");
    const secondarySource = secondaryLines.join("\n");
    writeFileSync(join(isolated, "primary.ts"), primarySource);
    writeFileSync(join(isolated, "secondary.ts"), secondarySource);

    const primary: GraphNode = {
      id: "class:primary-selector", kind: "class", name: "PrimarySelector", qualifiedName: "PrimarySelector",
      filePath: "primary.ts", language: "typescript", startLine: 1, endLine: 70,
      startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const primaryHelper: GraphNode = {
      id: "method:primary-choose", kind: "method", name: "choose",
      qualifiedName: "PrimarySelector::choose", filePath: "primary.ts", language: "typescript",
      startLine: 69, endLine: 69, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const backgroundStart: GraphNode = {
      id: "function:background-start", kind: "function", name: "collectBackgroundPaths",
      qualifiedName: "collectBackgroundPaths", filePath: "secondary.ts", language: "typescript",
      startLine: 1, endLine: 150, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const backgroundEnd: GraphNode = {
      id: "function:background-end", kind: "function", name: "matchBackgroundPaths",
      qualifiedName: "collectBackgroundPaths::matchBackgroundPaths",
      filePath: "secondary.ts", language: "typescript",
      startLine: 80, endLine: 149, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const backgroundEdge: GraphEdge = {
      source: primary.id, target: primaryHelper.id, kind: "calls",
      line: 69, column: 2, confidence: 1,
    };
    const query = "How does nested matchBackgroundPaths advance selected paths?";
    const graph = syntheticScopeGraph({
      nodes: [primary, primaryHelper, backgroundStart, backgroundEnd], edges: [backgroundEdge],
      sources: [
        { path: primary.filePath, content: primarySource },
        { path: backgroundStart.filePath, content: secondarySource },
      ],
      searchNodes: (request) => request === query || request.includes("PrimarySelector")
        ? [primary, primaryHelper] : [backgroundStart, backgroundEnd],
      sourceHits: [{
        filePath: primary.filePath, startLine: 1, endLine: 70,
        contentHash: createHash("sha256").update(primarySource).digest("hex"), rank: -1,
        matchedTerms: ["paths"], nodeIds: [primary.id, primaryHelper.id],
      }, {
        filePath: backgroundStart.filePath, startLine: 1, endLine: 150,
        contentHash: createHash("sha256").update(secondarySource).digest("hex"), rank: -0.05,
        matchedTerms: ["nested", "match", "background", "paths"],
        nodeIds: [backgroundEnd.id, backgroundStart.id],
      }],
    });
    const db = deps.open!(root).db;
    const directDeps: AgentCommandDeps = {
      open: () => ({ graph, db, close: () => {} }), write: (line) => lines.push(line),
    };
    try {
      const records = capture(() => runGraphScope(query, isolated, directDeps, {
        maxFiles: 2, maxSourceLines: 200, maxOutputTokens: 3000,
      }));
      const primaryRanges = records.filter((record) => record.type === "source"
        && record.filePath === primary.filePath)
        .flatMap((record) => record.ranges as SourceRange[]);
      const secondaryRanges = records.filter((record) => record.type === "source"
        && record.filePath === backgroundStart.filePath)
        .flatMap((record) => record.ranges as SourceRange[]);
      expect(primaryRanges).toEqual([
        expect.objectContaining({ startLine: 1, endLine: 70, reason: "whole-file", truncated: false }),
      ]);
      const nestedLines = new Set(secondaryRanges.flatMap((range) => (
        Array.from({ length: range.endLine - range.startLine + 1 }, (_, index) => range.startLine + index)
      )));
      expect(nestedLines.has(backgroundEnd.startLine), JSON.stringify(records)).toBe(true);
      expect(nestedLines.has(backgroundEnd.endLine), JSON.stringify(records)).toBe(true);
      expect(records.some((record) => record.type === "flow"
        && (record.steps as GraphEdge[]).some((edge) => edge.source === primary.id
          && edge.target === primaryHelper.id))).toBe(true);
      expect(records.at(-1)).toMatchObject({ type: "summary", status: "ok" });
      expect(records.at(-1)!.estimatedOutputTokens as number).toBeLessThanOrEqual(3000);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("keeps a 185-line primary whole-file answer intact", () => {
    const isolated = mkdtempSync(join(tmpdir(), "scope-source-long-primary-"));
    const sourceLines = Array.from({ length: 185 }, (_, index) => `// primary body ${index + 1}`);
    sourceLines[0] = "export function PrimaryProcedure(): void {";
    sourceLines[184] = "}";
    const source = sourceLines.join("\n");
    writeFileSync(join(isolated, "primary.ts"), source);
    const primary: GraphNode = {
      id: "function:primary-procedure", kind: "function", name: "PrimaryProcedure",
      qualifiedName: "PrimaryProcedure", filePath: "primary.ts", language: "typescript",
      startLine: 1, endLine: 185, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const graph = syntheticScopeGraph({
      nodes: [primary], sources: [{ path: primary.filePath, content: source }],
      searchNodes: () => [primary],
      sourceHits: [{
        filePath: primary.filePath, startLine: 1, endLine: 185,
        contentHash: createHash("sha256").update(source).digest("hex"), rank: -1,
        matchedTerms: ["primary", "procedure"], nodeIds: [primary.id],
      }],
    });
    const db = deps.open!(root).db;
    const directDeps: AgentCommandDeps = {
      open: () => ({ graph, db, close: () => {} }), write: (line) => lines.push(line),
    };
    try {
      const records = capture(() => runGraphScope("PrimaryProcedure", isolated, directDeps, {
        maxFiles: 1, maxSourceLines: 200, maxOutputTokens: 3000,
      }));
      const ranges = records.filter((record) => record.type === "source")
        .flatMap((record) => record.ranges as SourceRange[]);
      expect(ranges).toEqual([
        expect.objectContaining({
          startLine: 1, endLine: 185, nodeIds: expect.arrayContaining([primary.id]),
          reason: "whole-file", truncated: false,
        }),
      ]);
      expect(records.at(-1)).toMatchObject({ type: "summary", status: "ok" });
      expect(records.at(-1)!.estimatedOutputTokens as number).toBeLessThanOrEqual(3000);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("coalesces overlapping complete declarations before source serialization", () => {
    const isolated = mkdtempSync(join(tmpdir(), "scope-source-overlap-"));
    const sourceLines = Array.from({ length: 220 }, (_, index) => `// assembly body ${index + 1}`);
    sourceLines[19] = "export function EnvelopeAssembler(): void {";
    sourceLines[29] = "  const representation = 'stable';";
    sourceLines[79] = "  function boundedDigest(): string {";
    sourceLines[109] = "  }";
    sourceLines[159] = "}";
    const source = sourceLines.join("\n");
    writeFileSync(join(isolated, "assembly.ts"), source);
    const parent: GraphNode = {
      id: "function:envelope-assembler", kind: "function", name: "EnvelopeAssembler",
      qualifiedName: "EnvelopeAssembler", filePath: "assembly.ts", language: "typescript",
      startLine: 20, endLine: 160, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const property: GraphNode = {
      id: "property:representation", kind: "property", name: "representation",
      qualifiedName: "EnvelopeAssembler::representation", filePath: "assembly.ts", language: "typescript",
      startLine: 30, endLine: 30, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const helper: GraphNode = {
      id: "function:bounded-digest", kind: "function", name: "boundedDigest",
      qualifiedName: "EnvelopeAssembler::boundedDigest", filePath: "assembly.ts", language: "typescript",
      startLine: 80, endLine: 110, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const edge: GraphEdge = {
      source: parent.id, target: helper.id, kind: "calls", line: 120, column: 2, confidence: 1,
    };
    const graph = syntheticScopeGraph({
      nodes: [parent, property, helper], edges: [edge],
      sources: [{ path: parent.filePath, content: source }],
      searchNodes: () => [parent, property, helper],
      sourceHits: [{
        filePath: parent.filePath, startLine: 20, endLine: 160,
        contentHash: createHash("sha256").update(source).digest("hex"), rank: -1,
        matchedTerms: ["envelope", "assembler"], nodeIds: [parent.id, property.id, helper.id],
      }],
    });
    const db = deps.open!(root).db;
    const directDeps: AgentCommandDeps = {
      open: () => ({ graph, db, close: () => {} }), write: (line) => lines.push(line),
    };
    try {
      const records = capture(() => runGraphScope("EnvelopeAssembler", isolated, directDeps, {
        maxFiles: 1, maxSourceLines: 200, maxOutputTokens: 3000,
      }));
      const ranges = records.filter((record) => record.type === "source")
        .flatMap((record) => record.ranges as SourceRange[])
        .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
      for (let index = 1; index < ranges.length; index++) {
        expect(ranges[index]!.startLine).toBeGreaterThan(ranges[index - 1]!.endLine);
      }
      expect(ranges).toEqual([
        expect.objectContaining({
          startLine: 20, endLine: 160, truncated: false,
          nodeIds: expect.arrayContaining([parent.id, helper.id]),
        }),
      ]);
      expect(records.some((record) => record.type === "flow"
        && (record.steps as GraphEdge[]).some((step) => step.source === parent.id
          && step.target === helper.id))).toBe(true);
      expect(records.at(-1)).toMatchObject({ type: "summary", status: "ok" });
      expect(records.at(-1)!.sourceBackedNodes).toEqual(expect.arrayContaining([
        parent.id, helper.id,
      ]));
      expect(records.at(-1)!.estimatedOutputTokens as number).toBeLessThanOrEqual(3000);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("emits the most cohesive file before an incidental exact project symbol and ignores optional trimming for status", () => {
    const isolated = mkdtempSync(join(tmpdir(), "mex-source-cohesion-"));
    mkdirSync(join(isolated, "runtime"));
    const frameworkSource = "export class Framework {}\n";
    const targetSource = Array.from({ length: 70 }, (_, index) => (
      index === 0 ? "export function assemblePipeline(stages: unknown[], handlers: unknown[]) {"
        : index === 68 ? "  return handlers.map((handler) => handler(stages))"
          : index === 69 ? "}" : `  // cohesive pipeline stage ${index}`
    )).join("\n");
    const optionalSource = Array.from({ length: 200 }, (_, index) => `// optional handler note ${index + 1}`).join("\n");
    writeFileSync(join(isolated, "framework.ts"), frameworkSource);
    writeFileSync(join(isolated, "runtime", "assemble-pipeline.ts"), targetSource);
    writeFileSync(join(isolated, "optional.ts"), optionalSource);

    const framework: GraphNode = {
      id: "class:framework", kind: "class", name: "Framework", qualifiedName: "Framework",
      filePath: "framework.ts", language: "typescript", startLine: 1, endLine: 1,
      startColumn: 0, endColumn: 25, updatedAt: 1,
    };
    const target: GraphNode = {
      id: "function:assemble", kind: "function", name: "assemblePipeline", qualifiedName: "assemblePipeline",
      signature: "function assemblePipeline(stages: unknown[], handlers: unknown[]): unknown[]",
      filePath: "runtime/assemble-pipeline.ts", language: "typescript", startLine: 1, endLine: 70,
      startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const optional: GraphNode = {
      id: "function:optional", kind: "function", name: "optionalHandler", qualifiedName: "optionalHandler",
      signature: "function optionalHandler(handler: unknown): void",
      filePath: "optional.ts", language: "typescript", startLine: 1, endLine: 200,
      startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const graphNodes = [framework, target, optional];
    const graph: GraphEngine = {
      build: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 }),
      sync: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 }),
      close: () => {}, searchNodes: () => graphNodes,
      getNode: (id) => graphNodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing: () => [],
      searchSource: () => [
        {
          filePath: target.filePath, startLine: 1, endLine: 70,
          contentHash: createHash("sha256").update(targetSource).digest("hex"), rank: -0.08,
          matchedTerms: ["assemble", "pipeline", "stages", "handlers"],
        },
        {
          filePath: optional.filePath, startLine: 1, endLine: 80,
          contentHash: createHash("sha256").update(optionalSource).digest("hex"), rank: -0.02,
          matchedTerms: ["handler"],
        },
      ],
      getIndexedFiles: () => [
        {
          path: framework.filePath, contentHash: createHash("sha256").update(frameworkSource).digest("hex"),
          parseStatus: "ok", diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
        },
        {
          path: target.filePath, contentHash: createHash("sha256").update(targetSource).digest("hex"),
          parseStatus: "ok", diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
        },
        {
          path: optional.filePath, contentHash: createHash("sha256").update(optionalSource).digest("hex"),
          parseStatus: "ok", diagnosticCount: 0, errorCoverage: 0, nodeCount: 1,
        },
      ],
    };
    const db = deps.open!(root).db;
    const cohesiveDeps: AgentCommandDeps = {
      open: () => ({ graph, db, close: () => {} }),
      write: (line) => lines.push(line),
    };
    try {
      const records = capture(() => runGraphScope(
        "How does Framework assemble pipeline stages with handlers?",
        isolated,
        cohesiveDeps,
        { maxOutputTokens: 1800, maxSourceLines: 200, maxFiles: 3 },
      ));
      const sources = records.filter((record) => record.type === "source");
      expect(sources[0]).toMatchObject({ filePath: target.filePath });
      const targetRanges = sources.filter((record) => record.filePath === target.filePath)
        .flatMap((record) => record.ranges as Array<{ startLine: number; endLine: number }>);
      expect(sources.filter((record) => record.filePath === target.filePath)).toHaveLength(1);
      expect(targetRanges).toEqual([
        expect.objectContaining({ startLine: 1, endLine: 70, reason: "whole-file", truncated: false }),
      ]);
      expect(records.at(-1)).toMatchObject({ type: "summary", status: "ok", truncated: true });

      const constrained = capture(() => runGraphScope(
        "How does Framework assemble pipeline stages with handlers?",
        isolated,
        cohesiveDeps,
        { maxOutputTokens: 1200, maxSourceLines: 200, maxFiles: 3 },
      ));
      expect(constrained.at(-1)).toMatchObject({
        type: "summary", status: "partial", truncated: true,
        warnings: expect.arrayContaining([expect.stringContaining("High-priority evidence omitted")]),
      });
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("admits a rank-three file's compact primary before an earlier file's optional bodies", () => {
    const isolated = mkdtempSync(join(tmpdir(), "mex-source-fairness-"));
    const dense = "x".repeat(120);
    const firstLines = Array.from({ length: 240 }, (_, index) => `// first filler ${index + 1}`);
    firstLines.splice(0, 6,
      "export function pipelineStart(): void {", "  // primary pipeline anchor", "}", "", "", "");
    for (let line = 19; line < 99; line++) firstLines[line] = `// optional alpha ${dense}`;
    for (let line = 109; line < 189; line++) firstLines[line] = `// optional beta ${dense}`;
    const secondLines = Array.from({ length: 220 }, (_, index) => `// second filler ${index + 1}`);
    secondLines.splice(0, 4, "export function pipelineSecondary(): void {", "  return;", "}", "");
    const thirdLines = Array.from({ length: 240 }, (_, index) => `// third filler ${index + 1}`);
    thirdLines[0] = "export function pipelineDeclarationOne(): number {";
    for (let line = 1; line < 79; line++) thirdLines[line] = `// third decoy one ${dense}`;
    thirdLines[79] = "}";
    thirdLines[89] = "export function pipelineDeclarationTwo(): number {";
    for (let line = 90; line < 159; line++) thirdLines[line] = `// third decoy two ${dense}`;
    thirdLines[159] = "}";
    thirdLines.splice(169, 6,
      "export function pipelineDeclarationAnswer(): number {", "  // compact requested declaration", "  return 3;", "}", "", "");
    const firstSource = firstLines.join("\n");
    const secondSource = secondLines.join("\n");
    const thirdSource = thirdLines.join("\n");
    writeFileSync(join(isolated, "first.ts"), firstSource);
    writeFileSync(join(isolated, "second.ts"), secondSource);
    writeFileSync(join(isolated, "third.ts"), thirdSource);

    const primary: GraphNode = {
      id: "function:pipeline-start", kind: "function", name: "pipelineStart", qualifiedName: "pipelineStart",
      filePath: "first.ts", language: "typescript", startLine: 1, endLine: 6,
      startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const optionalAlpha: GraphNode = {
      id: "function:optional-alpha", kind: "function", name: "pipelineOptionalAlpha",
      qualifiedName: "pipelineOptionalAlpha", filePath: "first.ts", language: "typescript",
      startLine: 20, endLine: 99, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const optionalBeta: GraphNode = {
      id: "function:optional-beta", kind: "function", name: "pipelineOptionalBeta",
      qualifiedName: "pipelineOptionalBeta", filePath: "first.ts", language: "typescript",
      startLine: 110, endLine: 189, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const secondary: GraphNode = {
      id: "function:pipeline-secondary", kind: "function", name: "pipelineSecondary",
      qualifiedName: "pipelineSecondary", filePath: "second.ts", language: "typescript",
      startLine: 1, endLine: 4, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const thirdDecoyOne: GraphNode = {
      id: "function:third-decoy-one", kind: "function", name: "pipelineDeclarationOne",
      qualifiedName: "pipelineDeclarationOne", filePath: "third.ts", language: "typescript",
      startLine: 1, endLine: 80, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const thirdDecoyTwo: GraphNode = {
      id: "function:third-decoy-two", kind: "function", name: "pipelineDeclarationTwo",
      qualifiedName: "pipelineDeclarationTwo", filePath: "third.ts", language: "typescript",
      startLine: 90, endLine: 160, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const target: GraphNode = {
      id: "function:third-answer", kind: "function", name: "pipelineDeclarationAnswer",
      qualifiedName: "pipelineDeclarationAnswer", filePath: "third.ts", language: "typescript",
      startLine: 170, endLine: 175, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const graphNodes = [primary, optionalAlpha, optionalBeta, secondary, thirdDecoyOne, thirdDecoyTwo, target];
    const sources = new Map([
      ["first.ts", firstSource], ["second.ts", secondSource], ["third.ts", thirdSource],
    ]);
    const graph: GraphEngine = {
      build: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 }),
      sync: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 }),
      close: () => {}, searchNodes: () => graphNodes,
      getNode: (id) => graphNodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing: () => [],
      searchSource: () => [
        {
          filePath: "first.ts", startLine: 1, endLine: 80,
          contentHash: createHash("sha256").update(firstSource).digest("hex"), rank: -3,
          matchedTerms: ["pipeline"], nodeIds: [primary.id, optionalAlpha.id],
        },
        {
          filePath: "second.ts", startLine: 1, endLine: 80,
          contentHash: createHash("sha256").update(secondSource).digest("hex"), rank: -2,
          matchedTerms: ["pipeline"], nodeIds: [secondary.id],
        },
        {
          filePath: "third.ts", startLine: 1, endLine: 80,
          contentHash: createHash("sha256").update(thirdSource).digest("hex"), rank: -0.3,
          matchedTerms: ["pipeline", "declaration"], nodeIds: [thirdDecoyOne.id],
        },
        {
          filePath: "third.ts", startLine: 90, endLine: 160,
          contentHash: createHash("sha256").update(thirdSource).digest("hex"), rank: -0.2,
          matchedTerms: ["pipeline", "declaration"], nodeIds: [thirdDecoyTwo.id],
        },
        {
          filePath: "third.ts", startLine: 170, endLine: 220,
          contentHash: createHash("sha256").update(thirdSource).digest("hex"), rank: -0.1,
          matchedTerms: ["pipeline", "declaration"], nodeIds: [target.id],
        },
      ],
      getIndexedFiles: () => [...sources].map(([path, source]) => ({
        path, contentHash: createHash("sha256").update(source).digest("hex"),
        language: "typescript" as const, size: source.length, modifiedAt: 1,
        nodeCount: graphNodes.filter((node) => node.filePath === path).length,
        parseStatus: "ok" as const, diagnosticCount: 0, missingCount: 0, errorCoverage: 0,
      })),
    };
    const db = deps.open!(root).db;
    const fairnessDeps: AgentCommandDeps = {
      open: () => ({ graph, db, close: () => {} }),
      write: (line) => lines.push(line),
    };
    try {
      const records = capture(() => runGraphScope(
        "locate the pipeline declaration answer",
        isolated,
        fairnessDeps,
        { maxOutputTokens: 3500, maxSourceLines: 200, maxFiles: 3 },
      ));
      const sourceRecords = records.filter((record) => record.type === "source");
      const targetIndex = sourceRecords.findIndex((record) => (record.ranges as Array<{ nodeIds: string[] }>)
        .some((range) => range.nodeIds.includes(target.id)));
      const optionalIndex = sourceRecords.findIndex((record) => record.filePath === "first.ts"
        && (record.ranges as Array<{ startLine: number }>).some((range) => range.startLine > 25));
      expect(targetIndex, JSON.stringify(records)).toBeGreaterThanOrEqual(0);
      expect(optionalIndex === -1 || optionalIndex > targetIndex).toBe(true);
      expect(sourceRecords[targetIndex]).toMatchObject({
        filePath: "third.ts",
        ranges: [expect.objectContaining({ startLine: 170, endLine: 175, truncated: false })],
      });
      expect(records.at(-1)).toMatchObject({
        type: "summary",
        returnedFiles: expect.arrayContaining(["first.ts", "second.ts", "third.ts"]),
        maxOutputTokens: 3500,
      });
      expect(records.at(-1)!.estimatedOutputTokens as number).toBeLessThanOrEqual(3500);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("completes a later file's first bounded direct answer after an oversized decoy", () => {
    const isolated = mkdtempSync(join(tmpdir(), "mex-source-direct-answer-"));
    const leadLines = Array.from({ length: 90 }, (_, index) => (
      index === 0 ? "export function primaryPipelineAnswer(): number {"
        : index === 89 ? "}" : `// primary answer context ${index + 1} ${"lead".repeat(12)}`
    ));
    const answerLines = Array.from({ length: 240 }, (_, index) => `// secondary filler ${index + 1}`);
    answerLines[0] = "export function pipelineCoordinator(): number {";
    for (let line = 1; line < 179; line++) {
      answerLines[line] = `// pipeline answer decoy ${line + 1} ${"dense".repeat(10)}`;
    }
    answerLines[179] = "}";
    answerLines[189] = "export function sourceAnswer(): number {";
    for (let line = 190; line < 218; line++) answerLines[line] = `// requested source answer ${line + 1}`;
    answerLines[218] = "}";
    const leadSource = leadLines.join("\n");
    const answerSource = answerLines.join("\n");
    writeFileSync(join(isolated, "lead.ts"), leadSource);
    writeFileSync(join(isolated, "answer.ts"), answerSource);

    const lead: GraphNode = {
      id: "function:lead-answer", kind: "function", name: "primaryPipelineAnswer",
      qualifiedName: "primaryPipelineAnswer", filePath: "lead.ts", language: "typescript",
      startLine: 1, endLine: 90, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const decoy: GraphNode = {
      id: "function:answer-decoy", kind: "function", name: "pipelineCoordinator",
      qualifiedName: "pipelineCoordinator", filePath: "answer.ts", language: "typescript",
      startLine: 1, endLine: 180, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const target: GraphNode = {
      id: "function:source-answer", kind: "function", name: "sourceAnswer",
      qualifiedName: "sourceAnswer", filePath: "answer.ts", language: "typescript",
      startLine: 190, endLine: 219, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const graphNodes = [lead, decoy, target];
    const graph: GraphEngine = {
      build: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 }),
      sync: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 }),
      close: () => {}, searchNodes: () => graphNodes,
      getNode: (id) => graphNodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing: () => [],
      searchSource: () => [
        {
          filePath: "lead.ts", startLine: 1, endLine: 80,
          contentHash: createHash("sha256").update(leadSource).digest("hex"), rank: -8,
          matchedTerms: ["pipeline", "answer", "source"], nodeIds: [lead.id],
        },
        {
          filePath: "answer.ts", startLine: 1, endLine: 80,
          contentHash: createHash("sha256").update(answerSource).digest("hex"), rank: -5,
          matchedTerms: ["pipeline", "answer"], nodeIds: [decoy.id],
        },
        {
          filePath: "answer.ts", startLine: 181, endLine: 240,
          contentHash: createHash("sha256").update(answerSource).digest("hex"), rank: -4,
          matchedTerms: ["source", "answer"], nodeIds: [target.id],
        },
      ],
      getIndexedFiles: () => [
        {
          path: "lead.ts", contentHash: createHash("sha256").update(leadSource).digest("hex"),
          language: "typescript", size: leadSource.length, modifiedAt: 1, nodeCount: 1,
          parseStatus: "ok", diagnosticCount: 0, missingCount: 0, errorCoverage: 0,
        },
        {
          path: "answer.ts", contentHash: createHash("sha256").update(answerSource).digest("hex"),
          language: "typescript", size: answerSource.length, modifiedAt: 1, nodeCount: 2,
          parseStatus: "ok", diagnosticCount: 0, missingCount: 0, errorCoverage: 0,
        },
      ],
    };
    const db = deps.open!(root).db;
    const directDeps: AgentCommandDeps = {
      open: () => ({ graph, db, close: () => {} }),
      write: (line) => lines.push(line),
    };
    try {
      const records = capture(() => runGraphScope(
        "find the pipeline source answer", isolated, directDeps,
        { maxOutputTokens: 3500, maxSourceLines: 200, maxFiles: 2 },
      ));
      const targetRanges = records.filter((record) => record.type === "source" && record.filePath === "answer.ts")
        .flatMap((record) => record.ranges as Array<{ startLine: number; endLine: number; nodeIds: string[] }>)
        .filter((range) => range.nodeIds.includes(target.id));
      const coveredLines = targetRanges.flatMap((range) => (
        Array.from({ length: range.endLine - range.startLine + 1 }, (_, index) => range.startLine + index)
      ));
      expect(Math.min(...coveredLines), JSON.stringify(records)).toBe(target.startLine);
      expect(Math.max(...coveredLines), JSON.stringify(records)).toBe(target.endLine);
      expect(new Set(coveredLines).size).toBe(target.endLine - target.startLine + 1);
      expect(records.at(-1)!.estimatedOutputTokens as number).toBeLessThanOrEqual(3500);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("admits bounded callsite answers before fairness when a direct hit also appears in a flow", () => {
    const isolated = mkdtempSync(join(tmpdir(), "mex-source-callsite-anchor-"));
    const dense = "z".repeat(24);
    const competitorDense = "z".repeat(24);
    const sourceLines = Array.from({ length: 340 }, (_, index) => `// filler ${index + 1}`);
    const declarations = [
      { id: "function:direct-one", name: "pipelineDeclarationOne", start: 1, end: 80 },
      { id: "function:direct-two", name: "pipelineDeclarationTwo", start: 90, end: 160 },
      { id: "function:direct-three", name: "pipelineDeclarationThree", start: 170, end: 230 },
    ];
    for (const declaration of declarations) {
      sourceLines[declaration.start - 1] = `export function ${declaration.name}(): number {`;
      for (let line = declaration.start; line < declaration.end - 1; line++) {
        sourceLines[line] = `// dense direct body ${dense}`;
      }
      sourceLines[declaration.end - 1] = "}";
    }
    sourceLines.splice(239, 6,
      "export function semanticContinuation(): number {", "  // semantic callsite target", "  return 4;", "}", "", "");
    sourceLines[249] = "export function pipelineDeclarationFallback(): number {";
    for (let line = 250; line < 326; line++) {
      sourceLines[line] = `// semantic target body ${line + 1} ${"answer".repeat(4)}`;
    }
    sourceLines[326] = "}";
    sourceLines.splice(329, 6,
      "export function finalSemanticTarget(): number {", "  // final semantic target", "  return 5;", "}", "", "");
    const source = sourceLines.join("\n");
    writeFileSync(join(isolated, "pipeline.ts"), source);

    const competitorSources = new Map([
      ["competitor-one.ts", "pipelineDeclarationCompetitorOne"],
      ["competitor-two.ts", "pipelineDeclarationCompetitorTwo"],
      ["competitor-three.ts", "pipelineDeclarationCompetitorThree"],
    ].map(([filePath, name]) => {
      const fileLines = Array.from({ length: 40 }, (_, index) => (
        index === 0 ? `export function ${name}(): number {`
          : index === 39 ? "}"
            : `// competing declaration body ${index + 1} ${competitorDense}`
      ));
      const fileSource = fileLines.join("\n");
      writeFileSync(join(isolated, filePath), fileSource);
      return [filePath, fileSource] as const;
    }));

    const directNodes: GraphNode[] = declarations.map((declaration) => ({
      id: declaration.id, kind: "function", name: declaration.name, qualifiedName: declaration.name,
      filePath: "pipeline.ts", language: "typescript", startLine: declaration.start, endLine: declaration.end,
      startColumn: 0, endColumn: 1, updatedAt: 1,
    }));
    const semanticTarget: GraphNode = {
      id: "function:semantic-target", kind: "function", name: "semanticContinuation",
      qualifiedName: "semanticContinuation", filePath: "pipeline.ts", language: "typescript",
      startLine: 240, endLine: 245, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const secondSemanticTarget: GraphNode = {
      id: "function:second-semantic-target", kind: "function", name: "pipelineDeclarationFallback",
      qualifiedName: "pipelineDeclarationFallback", filePath: "pipeline.ts", language: "typescript",
      startLine: 250, endLine: 327, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const finalSemanticTarget: GraphNode = {
      id: "function:final-semantic-target", kind: "function", name: "finalSemanticTarget",
      qualifiedName: "finalSemanticTarget", filePath: "pipeline.ts", language: "typescript",
      startLine: 330, endLine: 335, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const competitorNodes: GraphNode[] = [...competitorSources.keys()].map((filePath, index) => ({
      id: `function:competitor-${index + 1}`, kind: "function",
      name: `pipelineDeclarationCompetitor${index + 1}`,
      qualifiedName: `pipelineDeclarationCompetitor${index + 1}`,
      filePath, language: "typescript", startLine: 1, endLine: 40,
      startColumn: 0, endColumn: 1, updatedAt: 1,
    }));
    const graphNodes = [
      ...directNodes, semanticTarget, secondSemanticTarget, finalSemanticTarget, ...competitorNodes,
    ];
    const graphEdges: GraphEdge[] = [
      { source: directNodes[0]!.id, target: semanticTarget.id, kind: "calls", line: 10, column: 2, confidence: 1 },
      { source: directNodes[1]!.id, target: secondSemanticTarget.id, kind: "calls", line: 100, column: 2, confidence: 1 },
      // This non-reserved authoritative source hit is also a later-flow
      // endpoint. It must count against the direct quota, leaving both bounded
      // flow slots available for the two semantic targets.
      { source: directNodes[2]!.id, target: finalSemanticTarget.id, kind: "calls", line: 180, column: 2, confidence: 1 },
    ];
    const graph: GraphEngine = {
      build: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 }),
      sync: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 }),
      close: () => {}, searchNodes: () => graphNodes,
      getNode: (id) => graphNodes.find((entry) => entry.id === id) ?? null,
      getCallers: () => [], getCallees: () => [],
      getIncoming: (id) => graphEdges.filter((edge) => edge.target === id).map((edge) => ({
        edge, node: graphNodes.find((entry) => entry.id === edge.source)!,
      })),
      getOutgoing: (id) => graphEdges.filter((edge) => edge.source === id).map((edge) => ({
        edge, node: graphNodes.find((entry) => entry.id === edge.target)!,
      })),
      searchSource: () => [
        ...directNodes.map((node, index) => ({
          filePath: node.filePath, startLine: node.startLine, endLine: node.endLine,
          contentHash: createHash("sha256").update(source).digest("hex"), rank: -6 + index,
          matchedTerms: ["pipeline", "declaration"], nodeIds: [node.id],
        })),
        ...competitorNodes.map((node, index) => ({
          filePath: node.filePath, startLine: node.startLine, endLine: node.endLine,
          contentHash: createHash("sha256").update(competitorSources.get(node.filePath)!).digest("hex"),
          rank: -2.9 + index * 0.1, matchedTerms: ["pipeline", "declaration"], nodeIds: [node.id],
        })),
      ],
      getIndexedFiles: () => [
        {
          path: "pipeline.ts", contentHash: createHash("sha256").update(source).digest("hex"),
          language: "typescript", size: source.length, modifiedAt: 1,
          nodeCount: directNodes.length + 2, parseStatus: "ok",
          diagnosticCount: 0, missingCount: 0, errorCoverage: 0,
        },
        ...competitorNodes.map((node) => {
          const fileSource = competitorSources.get(node.filePath)!;
          return {
            path: node.filePath, contentHash: createHash("sha256").update(fileSource).digest("hex"),
            language: "typescript" as const, size: fileSource.length, modifiedAt: 1, nodeCount: 1,
            parseStatus: "ok" as const, diagnosticCount: 0, missingCount: 0, errorCoverage: 0,
          };
        }),
      ],
    };
    const db = deps.open!(root).db;
    const callsiteDeps: AgentCommandDeps = {
      open: () => ({ graph, db, close: () => {} }),
      write: (line) => lines.push(line),
    };
    try {
      const records = capture(() => runGraphScope(
        "locate the pipeline declaration", isolated, callsiteDeps,
        { maxOutputTokens: 6000, maxSourceLines: 200, maxFiles: 4 },
      ));
      const sourceRecords = records.filter((record) => record.type === "source");
      const semanticIndex = sourceRecords.findIndex((record) => (
        record.ranges as Array<{ nodeIds: string[] }>
      ).some((range) => range.nodeIds.includes(semanticTarget.id)));
      const secondSemanticIndex = sourceRecords.findIndex((record) => (
        record.ranges as Array<{ nodeIds: string[] }>
      ).some((range) => range.nodeIds.includes(secondSemanticTarget.id)));
      const finalSemanticIndex = sourceRecords.findIndex((record) => (
        record.ranges as Array<{ nodeIds: string[] }>
      ).some((range) => range.nodeIds.includes(finalSemanticTarget.id)));
      const firstBodyIndex = sourceRecords.findIndex((record) => (
        record.ranges as Array<{ startLine: number; nodeIds: string[] }>
      ).some((range) => range.nodeIds.includes(directNodes[0]!.id) && range.startLine > 6));
      const firstCompetitorIndex = sourceRecords.findIndex((record) => (
        typeof record.filePath === "string" && record.filePath.startsWith("competitor-")
      ));
      // The terminal target of the first displayed path is the first atomic
      // source answer, even though three earlier source-region declarations
      // in the same file would otherwise consume the answer waves first.
      expect(semanticIndex, JSON.stringify(records)).toBe(0);
      // The globally best NL-correlated candidate is next: it has two direct
      // identifier concepts plus callsite/graph proof. The competitor nodes
      // have the same lexical concepts but no semantic callsite and therefore
      // must not receive this global reservation.
      expect(secondSemanticIndex, JSON.stringify(records)).toBe(1);
      expect(finalSemanticIndex, JSON.stringify(records)).toBeGreaterThanOrEqual(0);
      expect(firstCompetitorIndex, JSON.stringify(records)).toBeGreaterThan(Math.max(
        semanticIndex, secondSemanticIndex, finalSemanticIndex,
      ));
      expect(firstBodyIndex === -1 || firstBodyIndex > Math.max(
        semanticIndex, secondSemanticIndex, finalSemanticIndex,
      )).toBe(true);
      expect(sourceRecords[semanticIndex]).toMatchObject({
        filePath: "pipeline.ts",
        ranges: [expect.objectContaining({ startLine: 240, endLine: 245, truncated: false })],
      });
      expect(sourceRecords[secondSemanticIndex]).toMatchObject({
        filePath: "pipeline.ts",
        ranges: [expect.objectContaining({ startLine: 250, endLine: 327, truncated: false })],
      });
      expect(sourceRecords[finalSemanticIndex]).toMatchObject({
        filePath: "pipeline.ts",
        ranges: [expect.objectContaining({ startLine: 330, endLine: 335, truncated: false })],
      });
      const competitorRecords = sourceRecords.filter((record) => (
        typeof record.filePath === "string" && record.filePath.startsWith("competitor-")
      ));
      expect(competitorRecords.length).toBeGreaterThan(0);
      for (const record of competitorRecords) {
        expect(record.ranges).toEqual([
          expect.objectContaining({ startLine: 1, endLine: 40, reason: "whole-file", truncated: false }),
        ]);
      }
      expect(records.at(-1)).toMatchObject({
        type: "summary", returnedFiles: expect.arrayContaining(["pipeline.ts"]),
      });
      expect(records.at(-1)!.estimatedOutputTokens as number).toBeLessThanOrEqual(6000);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("caps deterministic summary lists and reports how many entries were omitted", () => {
    const isolated = mkdtempSync(join(tmpdir(), "mex-summary-cap-"));
    const source = "export function alphaBeta(): void {}\n";
    writeFileSync(join(isolated, "terms.ts"), source);
    const terms = [
      "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "theta", "lambda", "kappa", "sigma",
      "omega", "quartz", "falcon", "harbor", "island", "jungle", "kernel", "matrix", "nebula", "orbit",
    ];
    const termNode: GraphNode = {
      id: "function:terms", kind: "function", name: "alphaBeta", qualifiedName: "alphaBeta",
      signature: `function alphaBeta(${terms.join(" ")}): void`, filePath: "terms.ts", language: "typescript",
      startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 1,
    };
    const graph: GraphEngine = {
      build: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, parseErrors: [], durationMs: 0 }),
      sync: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, parseErrors: [], durationMs: 0 }),
      close: () => {}, searchNodes: () => [termNode],
      getNode: (id) => id === termNode.id ? termNode : null,
      getCallers: () => [], getCallees: () => [], getIncoming: () => [], getOutgoing: () => [],
      getIndexedFiles: () => [{
        path: "terms.ts", contentHash: createHash("sha256").update(source).digest("hex"),
        language: "typescript", size: source.length, modifiedAt: 1, nodeCount: 1,
        parseStatus: "ok", diagnosticCount: 0, missingCount: 0, errorCoverage: 0,
      }],
    };
    const db = deps.open!(root).db;
    const summaryDeps: AgentCommandDeps = {
      open: () => ({ graph, db, close: () => {} }),
      write: (line) => lines.push(line),
    };
    try {
      const records = capture(() => runGraphScope(terms.join(" "), isolated, summaryDeps, { detail: "minimal" }));
      const summary = records.at(-1)!;
      expect(summary.coveredTerms).toHaveLength(12);
      expect(summary.omittedCounts).toMatchObject({ coveredTerms: 8 });
      expect(summary).toMatchObject({ type: "summary", truncated: true, status: "ok" });
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe("runGraphGet", () => {
  it("returns capped source for a known id and NODE_NOT_FOUND for an unknown one", () => {
    const records = capture(() => runGraphGet([idOf("run"), "function:missing"], root, deps, {}));
    expect(records.some((r) => r.type === "source" && JSON.stringify(r).includes("helper(41)"))).toBe(true);
    expect(records.some((r) => r.type === "error" && r.code === "NODE_NOT_FOUND")).toBe(true);
  });

  it("does not rewrite an undersized budget to make compliance appear successful", () => {
    const records = capture(() => runGraphGet(["missing:a", "missing:b", "missing:c"], root, deps, { maxOutputTokens: 20 }));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "error", code: "INVALID_OUTPUT_BUDGET" });
  });
});

describe("runGraphQuery", () => {
  it("returns compact source-off results by default", () => {
    const records = capture(() => runGraphQuery("where-defined", "run", root, deps, {}));
    const results = records.filter((r) => r.type === "result");
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) expect(result).not.toHaveProperty("source");
  });

  it("preserves the queried target on each result", () => {
    const records = capture(() => runGraphQuery("who-calls", "helper", root, deps, {}));
    const results = records.filter((r) => r.type === "result");
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) expect(result.target).toBe(idOf("helper"));
  });
});

describe("runImpact", () => {
  it("respects the depth cap and frames with meta/summary", () => {
    const shallow = capture(() => runImpact("helper", root, deps, { depth: 1 }));
    expect(shallow[0]).toMatchObject({ type: "meta", command: "impact" });
    expect(shallow.at(-1)).toMatchObject({ type: "summary" });
    const callers = shallow.filter((r) => r.type === "caller");
    for (const caller of callers) expect(caller.depth).toBeLessThanOrEqual(1);
  });

  it("caps total returned nodes (defines + callers) at maxNodes", () => {
    const records = capture(() => runImpact("helper", root, deps, { maxNodes: 1 }));
    const nodeRecords = records.filter((r) => r.type === "defines" || r.type === "caller");
    expect(nodeRecords.length).toBeLessThanOrEqual(1);
    expect((records.at(-1)!.returnedNodes as number)).toBeLessThanOrEqual(1);
  });
});

describe("budget accounting honesty", () => {
  it("emits confidence-gated directed flow records and accounts every returned step", () => {
    const full = capture(() => runGraphScope("run", root, deps, { detail: "standard" }));
    const flows = full.filter((r) => r.type === "flow");
    expect(flows.length).toBeGreaterThan(0);
    expect(full.some((r) => r.type === "edge")).toBe(false);
    const steps = flows.flatMap((flow) => flow.steps as Array<Record<string, unknown>>);
    expect(steps.length).toBeGreaterThan(0);
    for (const flow of flows) {
      const endpointIds = new Set((flow.nodes as Array<{ id: string }>).map((node) => node.id));
      expect(endpointIds.size).toBeGreaterThan(0);
      for (const step of flow.steps as Array<{ source: string; target: string }>) {
        expect(endpointIds.has(step.source)).toBe(true);
        expect(endpointIds.has(step.target)).toBe(true);
      }
    }
    for (const step of steps) {
      expect(step.kind).toBe("calls");
      expect(step.confidence as number).toBeGreaterThanOrEqual(0.8);
    }
    expect(full.at(-1)).toMatchObject({ type: "summary", returnedEdges: steps.length });
  });

  it("links emitted source to facts by node id without a redundant per-fact flag", () => {
    const records = capture(() => runGraphScope("run", root, deps, { detail: "source" }));
    const facts = records.filter((r) => r.type === "fact");
    const sourcedNodeIds = new Set(
      records.filter((r) => r.type === "source").flatMap((r) => (r.ranges as Array<{ nodeIds: string[] }>).flatMap((x) => x.nodeIds)),
    );
    for (const fact of facts) {
      expect(fact).not.toHaveProperty("sourceIncluded");
      expect(sourcedNodeIds.has(fact.id as string)).toBe(true);
    }
  });

  it("never stamps sourceIncluded on non-fact records (e.g. impact target)", () => {
    const records = capture(() => runImpact("helper", root, deps, { detail: "source" }));
    const targetRecord = records.find((r) => r.type === "target");
    expect(targetRecord).toBeDefined();
    expect(targetRecord).not.toHaveProperty("sourceIncluded");
  });

  it("does not under-report tokens: estimate covers the actually emitted bytes and stays under the ceiling", () => {
    for (const maxOutputTokens of [1500, 3500]) {
      const records = capture(() => runGraphScope("run", root, deps, { detail: "source", maxOutputTokens }));
      const summary = records.at(-1)!;
      const actual = records.reduce((sum, r) => sum + Math.ceil(JSON.stringify(r).length / 4), 0);
      expect(summary.estimatedOutputTokens as number).toBeGreaterThanOrEqual(actual);
      expect(summary.estimatedOutputTokens as number).toBeLessThanOrEqual(summary.maxOutputTokens as number);
    }
  });

  it("returns a newly added matching file as text-only evidence without graph claims", () => {
    writeFileSync(join(root, "new-live.ts"), "export const freshNeedle = 'only in live source';\n");
    const records = capture(() => runGraphScope("freshNeedle", root, deps, {}));
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "source", filePath: "new-live.ts", evidence: "text-only", unindexed: true,
      }),
    ]));
    expect(records.some((record) => record.type === "fact" && record.filePath === "new-live.ts")).toBe(false);
    expect(records.at(-1)).toMatchObject({
      type: "summary", status: "degraded", truncated: true,
      textFallbackFiles: expect.arrayContaining(["new-live.ts"]),
    });
  });

  it("keeps a complete graph answer ok when optional live text also matches", () => {
    const optionalPath = join(root, "optional-live-note.ts");
    writeFileSync(optionalPath, "// incidental run note for operators\n");
    try {
      const records = capture(() => runGraphScope("run incidental", root, deps, {}));
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "source", filePath: "main.ts", evidence: "graph" }),
        expect.objectContaining({
          type: "source", filePath: "optional-live-note.ts", evidence: "text-only", unindexed: true,
        }),
      ]));
      expect(records.some((record) => record.type === "flow")).toBe(true);
      expect(records.at(-1)).toMatchObject({
        type: "summary", status: "ok", truncated: true,
        textFallbackFiles: expect.arrayContaining(["optional-live-note.ts"]),
        suggestedNextCommands: [],
      });
    } finally {
      rmSync(optionalPath, { force: true });
    }
  });

  it("never emits stale graph flows or stale facts after a live file changes", () => {
    writeFileSync(
      join(root, "main.ts"),
      `import { helper } from "./util";\nexport function run(): number {\n  return helper(42);\n}\n`,
    );
    const records = capture(() => runGraphScope("run helper", root, deps, {}));
    expect(records.some((record) => record.type === "flow")).toBe(false);
    expect(records.some((record) => record.type === "fact" && record.filePath === "main.ts")).toBe(false);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "source", filePath: "main.ts", evidence: "text-only", stale: true }),
    ]));
    expect(JSON.stringify(records.filter((record) => record.type === "source"))).toContain("helper(42)");
  });

  it("drops stale indexed hits when the live file no longer matches the query", () => {
    writeFileSync(join(root, "main.ts"), "export const unrelatedLiveValue = 42;\n");
    const records = capture(() => runGraphScope("run", root, deps, {}));
    expect(records.some((record) => record.type === "source" && record.filePath === "main.ts")).toBe(false);
    expect(records.some((record) => record.type === "fact" && record.filePath === "main.ts")).toBe(false);
    expect(records.some((record) => record.type === "flow")).toBe(false);
    expect(records.at(-1)?.returnedFiles).not.toContain("main.ts");
    expect(records.at(-1)?.textFallbackFiles).not.toContain("main.ts");
  });
});
