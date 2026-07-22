// Integration test for the agent-facing JSONL commands. Builds a real graph over
// a tiny project and drives runGraphScope / runGraphQuery / runGraphGet / runImpact
// through injected session + capturing writer, asserting the protocol contract:
// meta first, compact source-off facts by default, summary last, budget truncation,
// and source-on-demand via `graph get`.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGraphEngine } from "../index.js";
import type { GraphEngine } from "../engine.js";
import { openSqlite } from "../db/sqlite.js";
import { runGraphGet, runGraphQuery, runGraphScope, runImpact, type AgentCommandDeps } from "../cli-agent.js";

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

describe("runGraphScope", () => {
  it("frames output with meta and summary and omits source by default", () => {
    const records = capture(() => runGraphScope("run", root, deps, {}));
    expect(records[0]).toMatchObject({ type: "meta", schemaVersion: 1, command: "graph scope", detail: "minimal" });
    const facts = records.filter((r) => r.type === "fact");
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) {
      expect(fact).not.toHaveProperty("source");
      expect(fact).not.toHaveProperty("callers");
      expect(fact.sourceIncluded).toBe(false);
      expect(typeof fact.callerCount).toBe("number");
      expect(typeof fact.score).toBe("number");
      expect(Array.isArray(fact.selectionReasons)).toBe(true);
    }
    const summary = records.at(-1)!;
    expect(summary).toMatchObject({ type: "summary" });
    expect(typeof summary.estimatedOutputTokens).toBe("number");
    expect(typeof summary.truncated).toBe("boolean");
    expect(records.some((r) => r.type === "source")).toBe(false);
  });

  it("emits grouped source records when detail is source", () => {
    const records = capture(() => runGraphScope("run", root, deps, { detail: "source" }));
    const source = records.filter((r) => r.type === "source");
    expect(source.length).toBeGreaterThan(0);
    const joined = JSON.stringify(source);
    expect(joined).toContain("helper");
  });

  it("truncates under a tight output-token budget", () => {
    const records = capture(() => runGraphScope("run", root, deps, { maxOutputTokens: 60 }));
    const summary = records.at(-1)!;
    expect(summary.type).toBe("summary");
    expect(summary.truncated).toBe(true);
  });

  it("caps the number of returned facts at maxNodes", () => {
    const records = capture(() => runGraphScope("run", root, deps, { maxNodes: 1 }));
    expect(records.filter((r) => r.type === "fact")).toHaveLength(1);
  });
});

describe("runGraphGet", () => {
  it("returns capped source for a known id and NODE_NOT_FOUND for an unknown one", () => {
    const records = capture(() => runGraphGet([idOf("run"), "function:missing"], root, deps, {}));
    expect(records.some((r) => r.type === "source" && JSON.stringify(r).includes("helper(41)"))).toBe(true);
    expect(records.some((r) => r.type === "error" && r.code === "NODE_NOT_FOUND")).toBe(true);
  });

  it("keeps a hard ceiling: an undersized budget is clamped to the framing floor and flagged", () => {
    const records = capture(() => runGraphGet(["missing:a", "missing:b", "missing:c"], root, deps, { maxOutputTokens: 20 }));
    const summary = records.at(-1)!;
    expect(summary.type).toBe("summary");
    expect(summary.truncated).toBe(true);
    // Clamped up from the impossible 20 to a framing floor, and honored as a real ceiling.
    expect(summary.maxOutputTokens as number).toBeGreaterThan(20);
    expect(summary.estimatedOutputTokens as number).toBeLessThanOrEqual(summary.maxOutputTokens as number);
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
  it("flags truncation when edges are budget-dropped in standard detail", () => {
    const full = capture(() => runGraphScope("run", root, deps, { detail: "standard" }));
    const fullEdges = full.filter((r) => r.type === "edge").length;
    expect(fullEdges).toBeGreaterThan(0);
    // A budget that fits the facts but not the edges must report truncated, not silently drop them.
    const tight = capture(() => runGraphScope("run", root, deps, { detail: "standard", maxOutputTokens: 260 }));
    const summary = tight.at(-1)!;
    if ((summary.returnedEdges as number) < fullEdges) expect(summary.truncated).toBe(true);
  });

  it("only claims sourceIncluded on facts whose source was actually emitted", () => {
    const records = capture(() => runGraphScope("run", root, deps, { detail: "source" }));
    const facts = records.filter((r) => r.type === "fact");
    const sourcedNodeIds = new Set(
      records.filter((r) => r.type === "source").flatMap((r) => (r.ranges as Array<{ nodeIds: string[] }>).flatMap((x) => x.nodeIds)),
    );
    for (const fact of facts) {
      expect(fact.sourceIncluded).toBe(sourcedNodeIds.has(fact.id as string));
    }
  });

  it("never stamps sourceIncluded on non-fact records (e.g. impact target)", () => {
    const records = capture(() => runImpact("helper", root, deps, { detail: "source" }));
    const targetRecord = records.find((r) => r.type === "target");
    expect(targetRecord).toBeDefined();
    expect(targetRecord).not.toHaveProperty("sourceIncluded");
  });

  it("does not under-report tokens: estimate covers the actually emitted bytes and stays under the ceiling", () => {
    for (const maxOutputTokens of [200, 1500]) {
      const records = capture(() => runGraphScope("run", root, deps, { detail: "source", maxOutputTokens }));
      const summary = records.at(-1)!;
      const actual = records.reduce((sum, r) => sum + Math.ceil(JSON.stringify(r).length / 4), 0);
      expect(summary.estimatedOutputTokens as number).toBeGreaterThanOrEqual(actual);
      expect(summary.estimatedOutputTokens as number).toBeLessThanOrEqual(summary.maxOutputTokens as number);
    }
  });
});
