import { describe, expect, it, vi } from "vitest";
import { runGraphQuery, runGraphScope, runImpact, type AgentCommandDeps } from "../src/graph/cli-agent.js";
import type { GraphEngine } from "../src/graph/engine.js";
import type { GraphNode } from "../src/graph/types.js";
import { __setTransport, captureCommand, flush } from "../src/telemetry/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function node(id: string, name: string, file = "src/a.ts", line = 1): GraphNode {
  return { id, name, kind: "function", qualifiedName: name, filePath: file, language: "typescript", startLine: line, endLine: line + 1, startColumn: 0, endColumn: 1, updatedAt: 1 };
}

function deps(): { deps: AgentCommandDeps; output: string[]; close: ReturnType<typeof vi.fn> } {
  const leaf = node("function:leaf", "leaf");
  const parent = node("function:parent", "parent", "src/parent.ts", 4);
  const top = node("function:top", "top", "src/top.ts", 7);
  const nodes = [leaf, parent, top];
  const graph: GraphEngine = {
    build: vi.fn(), sync: vi.fn(), close: vi.fn(),
    getNode: (id) => nodes.find((entry) => entry.id === id) ?? null,
    searchNodes: (query) => nodes.filter((entry) => entry.name.includes(query)),
    getCallers: (id) => id === leaf.id ? [parent] : id === parent.id ? [top] : [],
    getCallees: (id) => id === top.id ? [parent] : id === parent.id ? [leaf] : [],
  };
  const close = vi.fn();
  const db = {
    prepare: (sql: string) => ({
      run: vi.fn(), get: vi.fn(), iterate: vi.fn(),
      all: (...params: unknown[]) => sql.includes("FROM nodes")
        ? (params[0] === "src/a.ts" ? [{ id: leaf.id }] : [])
        : [{ scaffold_file: ".mex/context/architecture.md", node_id: leaf.id }],
    }),
    exec: vi.fn(), pragma: vi.fn(), transaction: <T>(fn: () => T) => fn(), close: vi.fn(), open: true,
  };
  const output: string[] = [];
  return { deps: { open: () => ({ graph, db, close }), write: (line) => output.push(line) }, output, close };
}

describe("agent graph commands", () => {
  it("impact emits deterministic JSONL with transitive callers and grounded memory", () => {
    const fixture = deps();
    runImpact("leaf", "/repo", fixture.deps);
    const rows = fixture.output.map((line) => JSON.parse(line));
    expect(rows.map((row) => row.type)).toEqual(["meta", "target", "defines", "caller", "caller", "grounding", "summary"]);
    expect(rows.filter((row) => row.type === "caller").map((row) => row.depth)).toEqual([1, 2]);
    expect(rows.find((row) => row.type === "grounding")).toMatchObject({ file: ".mex/context/architecture.md", node: "function:leaf" });
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("impact accepts a file and reports each node it defines", () => {
    const fixture = deps();
    runImpact("src/a.ts", "/repo", fixture.deps);
    const rows = fixture.output.map((line) => JSON.parse(line));
    expect(rows.find((row) => row.type === "target")).toMatchObject({ type: "target", targetType: "file" });
  });

  it("supports all three structural query relations", () => {
    for (const [relation, expected] of [["who-calls", "parent"], ["what-calls", undefined], ["where-defined", "leaf"]] as const) {
      const fixture = deps();
      runGraphQuery(relation, "leaf", "/repo", fixture.deps);
      const results = fixture.output.map((line) => JSON.parse(line)).filter((row) => row.type === "result");
      if (expected) expect(results[0].name).toBe(expected);
      else expect(results).toEqual([]);
    }
  });

  it("scope emits seeds and their one-hop neighborhood as hydrated facts", () => {
    const fixture = deps();
    runGraphScope("leaf", "/repo", fixture.deps);
    const facts = fixture.output.map((line) => JSON.parse(line)).filter((row) => row.type === "fact");
    expect(facts.map((row) => row.id)).toEqual(["function:leaf", "function:parent"]);
    expect(facts[0]).toMatchObject({
      type: "fact", kind: "function", name: "leaf", qualifiedName: "leaf",
      filePath: "src/a.ts", callerCount: 1, calleeCount: 0, sourceIncluded: false,
    });
    expect(facts[0]).not.toHaveProperty("source");
    expect(facts[0]).not.toHaveProperty("callers");
  });

  it("scope degrades to a machine-readable error when the graph is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-no-graph-"));
    const output: string[] = [];
    try {
      runGraphScope("anything", root, { write: (line) => output.push(line) });
      expect(JSON.parse(output[0])).toMatchObject({ type: "error", code: "GRAPH_UNAVAILABLE" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("degrades to a machine-readable error when graph loading fails", () => {
    const output: string[] = [];
    runGraphQuery("where-defined", "leaf", "/repo", {
      open: () => { throw new Error("simulated engine failure"); },
      write: (line) => output.push(line),
    });
    expect(JSON.parse(output[0])).toMatchObject({ type: "error", code: "GRAPH_UNAVAILABLE", message: "simulated engine failure" });
  });

  it("also degrades when the first engine read fails", () => {
    const fixture = deps();
    const base = fixture.deps.open!("/repo");
    fixture.deps.open = () => ({
      graph: { ...base.graph, getNode: () => { throw new Error("sqlite unavailable"); } },
      db: base.db,
      close: fixture.close,
    });
    runGraphQuery("where-defined", "leaf", "/repo", fixture.deps);
    expect(JSON.parse(fixture.output[0])).toMatchObject({ type: "error", code: "GRAPH_UNAVAILABLE", message: "sqlite unavailable" });
  });

  it("keeps JSONL and stderr clean when telemetry delivery fails", async () => {
    const fixture = deps();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const cwd = process.cwd();
    const home = process.env.MEX_HOME;
    const env = { dnt: process.env.DO_NOT_TRACK, telemetry: process.env.MEX_TELEMETRY, dev: process.env.MEX_DEV };
    const isolated = mkdtempSync(join(tmpdir(), "mex-offline-command-"));
    const attempted = vi.fn(() => { throw new Error("offline"); });
    try {
      process.chdir(isolated);
      process.env.MEX_HOME = isolated;
      delete process.env.DO_NOT_TRACK;
      delete process.env.MEX_TELEMETRY;
      delete process.env.MEX_DEV;
      __setTransport(attempted);
      captureCommand("graph query");
      runGraphQuery("where-defined", "leaf", "/repo", fixture.deps);
      await flush();
      expect(attempted).toHaveBeenCalledOnce();
      expect(stderr).not.toHaveBeenCalled();
      const results = fixture.output.map((line) => JSON.parse(line)).filter((row) => row.type === "result");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ type: "result", relation: "where-defined", name: "leaf" });
    } finally {
      __setTransport(null);
      process.chdir(cwd);
      if (home === undefined) delete process.env.MEX_HOME;
      else process.env.MEX_HOME = home;
      if (env.dnt === undefined) delete process.env.DO_NOT_TRACK; else process.env.DO_NOT_TRACK = env.dnt;
      if (env.telemetry === undefined) delete process.env.MEX_TELEMETRY; else process.env.MEX_TELEMETRY = env.telemetry;
      if (env.dev === undefined) delete process.env.MEX_DEV; else process.env.MEX_DEV = env.dev;
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});
