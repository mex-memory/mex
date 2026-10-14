/**
 * Context extraction, against the inherited oracle.
 *
 * Nine of these came with the pipeline, unchanged apart from import paths, the
 * synchronous call and the reader's method names. They pin the importance
 * ranking, the padding rule, the two fallbacks and the file-summary tally —
 * every one of which is a place where a plausible-looking change quietly
 * degrades what an agent is shown.
 *
 * The budget cases at the end are mex's, because the reference had no budget.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAllClusterContexts, extractClusterContext } from "../context.js";
import { estimateTokens } from "../../query/budget.js";
import type { Cluster, ContextGraphNode, ContextGraphReader } from "../types.js";

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function freshRepo(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "mex-wiki-ctx-"));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(dir, relative);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content, "utf-8");
  }
  return dir;
}

function stubGraph(
  nodes: Record<string, ContextGraphNode>,
  edges?: { callers?: Record<string, string[]>; callees?: Record<string, string[]> },
): ContextGraphReader {
  return {
    describeNode: (id) => nodes[id] ?? null,
    callersOf: (nodeId) => edges?.callers?.[nodeId] ?? [],
    calleesOf: (nodeId) => edges?.callees?.[nodeId] ?? [],
  };
}

describe("extractClusterContext", () => {
  it("uses snapshot-bound source for every span instead of re-reading the live file", () => {
    const repoRoot = freshRepo({ "auth/token.ts": "export function issueToken() { return 'unverified live bytes'; }" });
    const graph = stubGraph({ "function:issueToken": { id: "function:issueToken", kind: "function",
      name: "issueToken", filePath: "auth/token.ts", startLine: 1, endLine: 1 } });
    let reads = 0;
    graph.readFileLines = () => { reads += 1; return ["export function issueToken() { return 'verified indexed bytes'; }"]; };
    const context = extractClusterContext(graph, { name: "auth", nodeIds: ["function:issueToken"], files: ["auth/token.ts"] }, repoRoot);
    expect(reads).toBe(1);
    expect(context.codeBlocks[0]?.content).toContain("verified indexed bytes");
    expect(context.codeBlocks[0]?.content).not.toContain("unverified live bytes");
  });

  it("resolves structural nodes and exact line-span code blocks", () => {
    const repoRoot = freshRepo({
      "auth/tokens.ts": [
        'import { x } from "./x";',
        "",
        "/** Issue a token */",
        "export function issueToken(userId: string): string {",
        "  return `tok:${userId}`;",
        "}",
        "",
        "export function revokeToken(): void {}",
      ].join("\n"),
    });

    const cluster: Cluster = {
      name: "auth",
      nodeIds: ["function:issueToken", "function:revokeToken"],
      files: ["auth/tokens.ts"],
    };

    const graph = stubGraph(
      {
        "function:issueToken": {
          id: "function:issueToken",
          kind: "function",
          name: "issueToken",
          filePath: "auth/tokens.ts",
          qualifiedName: "auth/tokens.ts::issueToken",
          signature: "issueToken(userId: string): string",
          docstring: "Issue a token",
          startLine: 4,
          endLine: 6,
        },
        "function:revokeToken": {
          id: "function:revokeToken",
          kind: "function",
          name: "revokeToken",
          filePath: "auth/tokens.ts",
          signature: "revokeToken(): void",
          startLine: 8,
          endLine: 8,
        },
      },
      {
        callers: { "function:issueToken": ["function:login"] },
        callees: { "function:issueToken": ["function:hash"] },
      },
    );

    const context = extractClusterContext(graph, cluster, repoRoot, { primaryContextLines: 0 });

    expect(context.cluster).toBe(cluster);
    expect(context.nodes).toHaveLength(2);
    expect(context.nodes[0]!.id).toBe("function:issueToken");
    expect(context.nodes[0]!.callers).toEqual(["function:login"]);
    expect(context.nodes[0]!.callees).toEqual(["function:hash"]);
    expect(context.nodes[0]!.docstring).toBe("Issue a token");
    expect(context.nodes[0]!.importance).toBe("primary");
    expect(context.nodes[0]!.reason).toContain("central function");

    expect(context.codeBlocks).toHaveLength(2);
    expect(context.codeBlocks[0]!.content).toContain("export function issueToken");
    expect(context.codeBlocks[0]!.startLine).toBe(4);
    expect(context.codeBlocks[0]!.endLine).toBe(6);
    expect(context.codeBlocks[0]!.kind).toBe("exact_node_body");
    expect(context.codeBlocks[0]!.importance).toBe("primary");
    expect(context.codeBlocks[0]!.id).toBe("function:issueToken@4-6");
    expect(context.codeBlocks[1]!.content).toContain("revokeToken");
  });

  it("pads primary node spans with surrounding context lines", () => {
    const repoRoot = freshRepo({
      "auth/tokens.ts": [
        'import { x } from "./x";',
        "",
        "/** Issue a token */",
        "export function issueToken(userId: string): string {",
        "  return `tok:${userId}`;",
        "}",
      ].join("\n"),
    });

    const cluster: Cluster = { name: "auth", nodeIds: ["function:issueToken"], files: ["auth/tokens.ts"] };
    const graph = stubGraph({
      "function:issueToken": {
        id: "function:issueToken",
        kind: "function",
        name: "issueToken",
        filePath: "auth/tokens.ts",
        startLine: 4,
        endLine: 6,
      },
    });

    const context = extractClusterContext(graph, cluster, repoRoot, { primaryContextLines: 2 });

    const block = context.codeBlocks[0]!;
    expect(block.kind).toBe("node_with_context");
    expect(block.startLine).toBe(2);
    expect(block.endLine).toBe(6);
    expect(block.content).toContain("/** Issue a token */");
  });

  it("falls back to full file when the span read is empty", () => {
    const repoRoot = freshRepo({ "billing/invoice.ts": "export function createInvoice() { return 1; }\n" });
    const cluster: Cluster = { name: "billing", nodeIds: ["function:createInvoice"], files: ["billing/invoice.ts"] };
    const graph = stubGraph({
      "function:createInvoice": {
        id: "function:createInvoice",
        kind: "function",
        name: "createInvoice",
        filePath: "billing/invoice.ts",
        startLine: 0,
        endLine: 0,
      },
    });

    const context = extractClusterContext(graph, cluster, repoRoot);

    expect(context.codeBlocks).toHaveLength(1);
    expect(context.codeBlocks[0]!.content).toContain("createInvoice");
    expect(context.codeBlocks[0]!.startLine).toBeUndefined();
    expect(context.codeBlocks[0]!.kind).toBe("full_file");
    expect(context.codeBlocks[0]!.nodeId).toBe("function:createInvoice");
  });

  it("adds full-file blocks for cluster files without symbol blocks", () => {
    const repoRoot = freshRepo({ "api/routes.ts": "export const routes = [];\n" });
    const cluster: Cluster = { name: "api", nodeIds: ["function:missing"], files: ["api/routes.ts"] };

    const context = extractClusterContext(stubGraph({}), cluster, repoRoot);

    expect(context.nodes).toHaveLength(0);
    expect(context.codeBlocks).toHaveLength(1);
    expect(context.codeBlocks[0]!.filePath).toBe("api/routes.ts");
    expect(context.codeBlocks[0]!.content).toContain("routes");
    expect(context.codeBlocks[0]!.nodeId).toBeUndefined();
    expect(context.codeBlocks[0]!.importance).toBe("supporting");
    expect(context.codeBlocks[0]!.kind).toBe("full_file");
  });

  it("truncates oversized file fallbacks to a bounded file_section", () => {
    const longFile = Array.from({ length: 50 }, (_, index) => `export const v${index} = ${index};`).join("\n");
    const repoRoot = freshRepo({ "api/big.ts": `${longFile}\n` });
    const cluster: Cluster = { name: "api", nodeIds: [], files: ["api/big.ts"] };

    const context = extractClusterContext(stubGraph({}), cluster, repoRoot, { supportingMaxLines: 10 });

    expect(context.codeBlocks).toHaveLength(1);
    expect(context.codeBlocks[0]!.kind).toBe("file_section");
    expect(context.codeBlocks[0]!.startLine).toBe(1);
    expect(context.codeBlocks[0]!.endLine).toBe(10);
    expect(context.codeBlocks[0]!.content).toContain("v0");
    expect(context.codeBlocks[0]!.content).not.toContain("v20");
  });

  it("ranks leaf declarations as supporting unless exported or connected", () => {
    const repoRoot = freshRepo({
      "config/settings.ts": ["const internalFlag = false;", "export const publicLimit = 10;"].join("\n"),
    });
    const cluster: Cluster = {
      name: "config",
      nodeIds: ["const:internalFlag", "const:publicLimit"],
      files: ["config/settings.ts"],
    };
    const graph = stubGraph({
      "const:internalFlag": {
        id: "const:internalFlag",
        kind: "constant",
        name: "internalFlag",
        filePath: "config/settings.ts",
        startLine: 1,
        endLine: 1,
      },
      "const:publicLimit": {
        id: "const:publicLimit",
        kind: "constant",
        name: "publicLimit",
        filePath: "config/settings.ts",
        startLine: 2,
        endLine: 2,
        isExported: true,
      },
    });

    const context = extractClusterContext(graph, cluster, repoRoot);

    expect(context.nodes.find((node) => node.id === "const:internalFlag")!.importance).toBe("supporting");
    expect(context.nodes.find((node) => node.id === "const:publicLimit")!.importance).toBe("primary");
    expect(
      context.fileSummaries?.find((summary) => summary.filePath === "config/settings.ts")?.exports,
    ).toEqual(["publicLimit"]);
  });

  it("skips the call graph for non-callable kinds by default", () => {
    const repoRoot = freshRepo({ "shared/types.ts": "export interface User { id: string }\n" });
    const cluster: Cluster = { name: "shared", nodeIds: ["interface:User"], files: ["shared/types.ts"] };
    const graph = stubGraph(
      {
        "interface:User": {
          id: "interface:User",
          kind: "interface",
          name: "User",
          filePath: "shared/types.ts",
          startLine: 1,
          endLine: 1,
        },
      },
      { callers: { "interface:User": ["function:login"] }, callees: { "interface:User": ["interface:Base"] } },
    );

    const context = extractClusterContext(graph, cluster, repoRoot);

    expect(context.nodes[0]!.callers).toBeUndefined();
    expect(context.nodes[0]!.callees).toBeUndefined();
  });

  it("gracefully skips missing graph nodes", () => {
    const repoRoot = freshRepo({ "auth/login.ts": "export function login() {}\n" });
    const cluster: Cluster = { name: "auth", nodeIds: ["function:login", "function:gone"], files: ["auth/login.ts"] };
    const graph = stubGraph({
      "function:login": {
        id: "function:login",
        kind: "function",
        name: "login",
        filePath: "auth/login.ts",
        startLine: 1,
        endLine: 1,
      },
    });

    const context = extractClusterContext(graph, cluster, repoRoot);

    expect(context.nodes).toHaveLength(1);
    expect(context.nodes[0]!.id).toBe("function:login");
  });
});

describe("extractAllClusterContexts", () => {
  it("returns one context per cluster in order", () => {
    const repoRoot = freshRepo({
      "auth/a.ts": "export function a() {}\n",
      "billing/b.ts": "export function b() {}\n",
    });
    const clusters: Cluster[] = [
      { name: "auth", nodeIds: ["function:a"], files: ["auth/a.ts"] },
      { name: "billing", nodeIds: ["function:b"], files: ["billing/b.ts"] },
    ];
    const graph = stubGraph({
      "function:a": { id: "function:a", kind: "function", name: "a", filePath: "auth/a.ts", startLine: 1, endLine: 1 },
      "function:b": {
        id: "function:b",
        kind: "function",
        name: "b",
        filePath: "billing/b.ts",
        startLine: 1,
        endLine: 1,
      },
    });

    const contexts = extractAllClusterContexts(graph, clusters, repoRoot);

    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.cluster.name).toBe("auth");
    expect(contexts[1]!.cluster.name).toBe("billing");
  });
});

describe("the token budget", () => {
  function bigCluster(): { repoRoot: string; cluster: Cluster; graph: ContextGraphReader } {
    const body = Array.from({ length: 40 }, (_, index) => `  const line${index} = ${index};`).join("\n");
    const repoRoot = freshRepo({
      "svc/core.ts": `export function core() {\n${body}\n}\n`,
      "svc/helper-a.ts": `export const helperA = () => {\n${body}\n};\n`,
      "svc/helper-b.ts": `export const helperB = () => {\n${body}\n};\n`,
    });
    const cluster: Cluster = {
      name: "svc",
      nodeIds: ["function:core", "const:helperA", "const:helperB"],
      files: ["svc/core.ts", "svc/helper-a.ts", "svc/helper-b.ts"],
    };
    const graph = stubGraph({
      "function:core": {
        id: "function:core",
        kind: "function",
        name: "core",
        filePath: "svc/core.ts",
        startLine: 1,
        endLine: 42,
      },
      "const:helperA": {
        id: "const:helperA",
        kind: "constant",
        name: "helperA",
        filePath: "svc/helper-a.ts",
        startLine: 1,
        endLine: 42,
      },
      "const:helperB": {
        id: "const:helperB",
        kind: "constant",
        name: "helperB",
        filePath: "svc/helper-b.ts",
        startLine: 1,
        endLine: 42,
      },
    });
    return { repoRoot, cluster, graph };
  }

  it("is not engaged when the context fits", () => {
    // The guard against a vacuous budget test: assert the unbounded shape
    // first, so "the budget dropped nothing" is a measurement rather than the
    // default state of an empty context.
    const { repoRoot, cluster, graph } = bigCluster();
    const context = extractClusterContext(graph, cluster, repoRoot);
    expect(context.codeBlocks.length).toBe(3);
    expect(context.truncated).toBe(false);
  });

  it("drops from the tail and counts exactly what it dropped", () => {
    const { repoRoot, cluster, graph } = bigCluster();
    const unbounded = extractClusterContext(graph, cluster, repoRoot);

    // A ceiling that fits the first block and not the second, so exactly one
    // survives and the arithmetic below is checkable rather than approximate.
    const first = estimateTokens(unbounded.codeBlocks[0]!);
    const bounded = extractClusterContext(graph, cluster, repoRoot, { maxTokens: first });

    expect(bounded.truncated).toBe(true);
    expect(bounded.codeBlocks).toHaveLength(1);
    // Primary survives longest, because the sort put it first — which is what
    // makes dropping from the tail the right thing rather than an arbitrary one.
    expect(bounded.codeBlocks[0]!.importance).toBe("primary");
    // The count is the whole point: an agent told "40 blocks are missing" will
    // not write a unit claiming this cluster does not do something.
    const dropped = bounded.dropped!;
    expect(dropped.primaryBlocks + dropped.supportingBlocks).toBe(unbounded.codeBlocks.length - 1);
  });

  it("bounds primary evidence too, rather than emitting a prompt no model can read", () => {
    // The correction a measured run forced: exempting primary blocks produced
    // a 4.5 MB prompt for one real cluster, so the exemption protected nothing.
    const { repoRoot, cluster, graph } = bigCluster();
    const bounded = extractClusterContext(graph, cluster, repoRoot, { maxTokens: 1 });
    expect(bounded.codeBlocks).toHaveLength(0);
    expect(bounded.truncated).toBe(true);
    expect(bounded.dropped!.primaryBlocks).toBeGreaterThan(0);
  });

  it("bounds the symbol list, which is what may be grounded to", () => {
    const { repoRoot, cluster, graph } = bigCluster();
    const bounded = extractClusterContext(graph, cluster, repoRoot, { maxNodes: 1 });
    expect(bounded.nodes).toHaveLength(1);
    expect(bounded.dropped!.nodes).toBe(2);
    // And no evidence survives for a symbol the agent cannot see: an id it
    // cannot read is an id it cannot ground to, so the block is pure cost.
    for (const block of bounded.codeBlocks) {
      if (block.nodeId !== undefined) expect(block.nodeId).toBe(bounded.nodes[0]!.id);
    }
  });

  it("is deterministic over the same repository", () => {
    const { repoRoot, cluster, graph } = bigCluster();
    expect(JSON.stringify(extractClusterContext(graph, cluster, repoRoot, { maxTokens: 220 }))).toBe(
      JSON.stringify(extractClusterContext(graph, cluster, repoRoot, { maxTokens: 220 })),
    );
  });
});

describe("source containment", () => {
  it("refuses to read outside the repository root", () => {
    const repoRoot = freshRepo({ "auth/a.ts": "export function a() {}\n" });
    const cluster: Cluster = { name: "auth", nodeIds: ["function:escape"], files: ["../escape.ts"] };
    const graph = stubGraph({
      "function:escape": {
        id: "function:escape",
        kind: "function",
        name: "escape",
        filePath: "../escape.ts",
        startLine: 1,
        endLine: 1,
      },
    });

    const context = extractClusterContext(graph, cluster, repoRoot);

    // The node is still described — that came from the graph, not from disk —
    // but nothing outside the root was read, so no block carries its content.
    expect(context.nodes).toHaveLength(1);
    expect(context.codeBlocks).toHaveLength(0);
  });
});
