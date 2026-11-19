import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  runGraphGet,
  runGraphQuery,
  runGraphScope,
  type AgentCommandDeps,
} from "../cli-agent.js";
import type { GraphEngine } from "../engine.js";
import type { GraphEdge, GraphNode } from "../types.js";

const sources = {
  "src/a.ts": "export function leaf() {\n  return 1;\n}\n",
  "src/parent.ts": "export function parent() {\n  return leaf();\n}\n",
  "src/top.ts": "export function top() {\n  return parent();\n}\n",
} as const;

const nodes: GraphNode[] = [
  {
    id: "function:leaf",
    kind: "function",
    name: "leaf",
    qualifiedName: "leaf",
    filePath: "src/a.ts",
    language: "typescript",
    startLine: 1,
    endLine: 3,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1,
  },
  {
    id: "function:parent",
    kind: "function",
    name: "parent",
    qualifiedName: "parent",
    filePath: "src/parent.ts",
    language: "typescript",
    startLine: 1,
    endLine: 3,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1,
  },
  {
    id: "function:top",
    kind: "function",
    name: "top",
    qualifiedName: "top",
    filePath: "src/top.ts",
    language: "typescript",
    startLine: 1,
    endLine: 3,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1,
  },
];

const edges: GraphEdge[] = [
  {
    source: "function:parent",
    target: "function:leaf",
    kind: "calls",
    line: 2,
    column: 2,
    confidence: 1,
    resolutionMethod: "typescript-compiler",
    provenance: "typescript-compiler",
  },
  {
    source: "function:top",
    target: "function:parent",
    kind: "calls",
    line: 2,
    column: 2,
    confidence: 1,
    resolutionMethod: "typescript-compiler",
    provenance: "typescript-compiler",
  },
];

let root: string;
let output: string[];
let deps: AgentCommandDeps;

function capture(command: () => void): string[] {
  output = [];
  command();
  return output;
}

function golden(name: "graph-scope" | "graph-get" | "graph-query"): string[] {
  return readFileSync(new URL(`./fixtures/protocol-v3/${name}.jsonl`, import.meta.url), "utf8")
    .trimEnd()
    .split(/\r?\n/);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mex-protocol-v3-golden-"));
  mkdirSync(join(root, "src"));
  for (const [filePath, source] of Object.entries(sources)) {
    writeFileSync(join(root, filePath), source);
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const graph: GraphEngine = {
      coverageFor: () => ({ indexed: false, reason: "excluded" }),
    build: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 }),
    sync: async () => ({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0 }),
    close: vi.fn(),
    searchNodes: (query) => nodes.filter((node) =>
      node.name.toLowerCase().includes(query.toLowerCase())),
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
    getIndexedFiles: () => Object.entries(sources).map(([path, source]) => ({
      path,
      contentHash: createHash("sha256").update(source).digest("hex"),
      parseStatus: "ok" as const,
      diagnosticCount: 0,
      errorCoverage: 0,
      nodeCount: nodes.filter((node) => node.filePath === path).length,
    })),
  };
  deps = {
    open: () => ({ graph, db: {} as never, close: vi.fn() }),
    write: (line) => output.push(line),
  };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("protocol v3 JSONL goldens", () => {
  it("freezes graph scope output", () => {
    expect(capture(() => runGraphScope("Leaf", root, deps))).toEqual(golden("graph-scope"));
  });

  it("freezes graph get output", () => {
    expect(capture(() => runGraphGet(
      ["function:leaf", "function:missing"], root, deps,
    ))).toEqual(golden("graph-get"));
  });

  it("freezes graph query output", () => {
    expect(capture(() => runGraphQuery(
      "who-calls", "leaf", root, deps,
    ))).toEqual(golden("graph-query"));
  });

  it("keeps successful streams canonically encoded and protocol framed", () => {
    for (const [name, stream] of [
      ["graph-scope", capture(() => runGraphScope("Leaf", root, deps))],
      ["graph-get", capture(() => runGraphGet(["function:leaf"], root, deps))],
      ["graph-query", capture(() => runGraphQuery("who-calls", "leaf", root, deps))],
    ] as const) {
      const records = stream.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(stream.map((line, index) => JSON.stringify(records[index])), name).toEqual(stream);
      expect(records[0], name).toMatchObject({
        type: "meta",
        protocolVersion: 3,
        schemaVersion: 3,
      });
      expect(records.at(-1), name).toMatchObject({ type: "summary" });
    }
  });
});
