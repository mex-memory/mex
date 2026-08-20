// ============================================================================
// mex code-graph — end-to-end engine test
// ============================================================================
//
// Builds a real graph over a tiny two-file project on disk and exercises the
// whole pipeline: extraction → persistence → cross-file resolution → the
// synchronous reader surface (search / getNode / getCallers / getCallees) →
// incremental sync. Also asserts the two contracts the handoff calls out:
// body_hash is populated, and a schema_versions row is written.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGraphEngine } from "../index.js";
import type { GraphEngine } from "../engine.js";
import { openSqlite } from "../db/sqlite.js";
import { DB_SCHEMA_VERSION, readSchemaVersion } from "../db/database.js";

let root: string;
let engine: GraphEngine;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mex-graph-"));
  writeFileSync(
    join(root, "util.ts"),
    `export function helper(x: number): number {\n  return x + 1;\n}\n`,
  );
  writeFileSync(
    join(root, "main.ts"),
    `import { helper } from "./util";\n` +
      `export function run(): number {\n  return helper(41);\n}\n` +
      `export class App {\n  start(): number { return run(); }\n}\n`,
  );
  // Same-named methods in distinct containers must retain distinct identities.
  writeFileSync(
    join(root, "duplicate-methods.ts"),
    `export class First {\n  execute(): number { return 1; }\n}\n` +
      `export class Second {\n  execute(): number { return 2; }\n}\n`,
  );
  writeFileSync(
    join(root, "semantic-error.ts"),
    `export const semanticallyInvalid: number = "not a number";\n`,
  );
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { express: "^5.0.0" } }));
  writeFileSync(join(root, "handlers.ts"), "export function importedHandler(): void {}\n");
  const bridgeLines = Array.from({ length: 110 }, (_, index) => `  // source bridge filler ${index + 1}`);
  bridgeLines[0] = "export function sourceChunkOwner(): string {";
  bridgeLines[89] = "  return 'deterministicEngineBridgeNeedle';";
  bridgeLines[109] = "}";
  writeFileSync(join(root, "source-bridge.ts"), bridgeLines.join("\n"));
  writeFileSync(
    join(root, "routes.ts"),
    `import express from "express";\nimport { importedHandler } from "./handlers";\nconst app = express();\n` +
      `export function healthHandler(): void {}\napp.get("/health", healthHandler);\n` +
      `app.post("/imported", importedHandler);\n`,
  );
  engine = createGraphEngine({ rootDir: root });
  await engine.build(root);
});

afterAll(() => {
  engine.close();
  rmSync(root, { recursive: true, force: true });
});

const findId = (name: string): string => {
  const hit = engine.searchNodes(name).find((n) => n.name === name);
  expect(hit, `expected to find node "${name}"`).toBeDefined();
  return hit!.id;
};

describe("GraphEngine build + reads", () => {
  it("indexes symbols across files (FTS search)", () => {
    expect(engine.searchNodes("helper").some((n) => n.name === "helper")).toBe(true);
    expect(engine.searchNodes("run").some((n) => n.name === "run")).toBe(true);
    expect(engine.searchNodes("App").some((n) => n.name === "App")).toBe(true);
    expect(engine.searchNodes("execute").some((n) => n.name === "execute")).toBe(true);
  });

  it("returns the named declaration enclosing an FTS source window", () => {
    const ownerId = findId("sourceChunkOwner");
    const readIds = (): string[] | undefined => engine.searchSource?.("deterministicEngineBridgeNeedle")
      .find((hit) => hit.filePath === "source-bridge.ts" && hit.startLine === 61)?.nodeIds;
    const firstRead = readIds();
    expect(firstRead).toEqual([ownerId]);
    expect(readIds()).toEqual(firstRead);
  });

  it("keeps the external-content FTS index consistent after duplicate node ids", () => {
    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      const nodes = db.prepare("SELECT COUNT(*) AS count FROM nodes").get() as { count: number };
      const indexed = db.prepare("SELECT COUNT(*) AS count FROM nodes_fts_docsize").get() as { count: number };
      const orphans = db.prepare(
        `SELECT COUNT(*) AS count
         FROM nodes_fts_docsize AS fts
         LEFT JOIN nodes ON nodes.rowid = fts.id
         WHERE nodes.rowid IS NULL`,
      ).get() as { count: number };
      expect(indexed.count).toBe(nodes.count);
      expect(orphans.count).toBe(0);
      const methods = db.prepare(
        "SELECT id, qualified_name FROM nodes WHERE name = 'execute' ORDER BY qualified_name",
      ).all() as Array<{ id: string; qualified_name: string }>;
      expect(methods.map((method) => method.qualified_name)).toEqual(["First::execute", "Second::execute"]);
      expect(new Set(methods.map((method) => method.id)).size).toBe(2);
    } finally {
      db.close();
    }
  });

  it("getNode returns a node and populates body_hash for body kinds", () => {
    const helper = engine.getNode(findId("helper"));
    expect(helper).not.toBeNull();
    expect(helper!.kind).toBe("function");
    expect(helper!.filePath).toBe("util.ts");
    expect(helper!.bodyHash).toBeTruthy();
  });

  it("getNode returns null for an unknown id (Tier-1 miss)", () => {
    expect(engine.getNode("function:deadbeef")).toBeNull();
  });

  it("resolves cross-file calls (callers/callees)", () => {
    const helperId = findId("helper");
    const runId = findId("run");
    // main.ts run() → util.ts helper()
    expect(engine.getCallees(runId).some((n) => n.name === "helper")).toBe(true);
    expect(engine.getCallers(helperId).some((n) => n.name === "run")).toBe(true);
  });

  it("resolves same-file calls (App.start → run)", () => {
    const runId = findId("run");
    expect(engine.getCallers(runId).some((n) => n.name === "start")).toBe(true);
  });

  it("writes a schema_versions row (migration safety)", () => {
    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      expect(readSchemaVersion(db)).toBe(DB_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("does not report ordinary type-checking errors as structural parser loss", () => {
    const file = engine.getIndexedFiles?.().find((entry) => entry.path === "semantic-error.ts");
    expect(file).toMatchObject({ parseStatus: "ok", diagnosticCount: 0, errorCoverage: 0 });
    expect(engine.searchNodes("semanticallyInvalid").some((node) => node.filePath === "semantic-error.ts")).toBe(true);
  });

  it("activates the Express resolver and links a route to its handler", () => {
    const route = engine.searchNodes("health").find((node) => node.kind === "route");
    const handlerId = findId("healthHandler");
    expect(route).toBeDefined();
    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      expect(db.prepare("SELECT kind, provenance FROM edges WHERE source = ? AND target = ?")
        .get(route!.id, handlerId)).toMatchObject({ kind: "references", provenance: "framework" });
    } finally { db.close(); }
  });

  it("uses an explicit compiler import binding for an Express route handler", () => {
    const route = engine.searchNodes("POST /imported").find((node) => node.kind === "route");
    const handlerId = findId("importedHandler");
    expect(route).toBeDefined();
    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      expect(db.prepare(
        "SELECT kind, provenance, confidence, resolution_method FROM edges WHERE source = ? AND target = ?",
      ).get(route!.id, handlerId)).toMatchObject({
        kind: "references",
        provenance: "framework",
        confidence: 0.8,
        resolution_method: "express-route-handler",
      });
    } finally { db.close(); }
  });
});

describe("GraphEngine sync", () => {
  it("re-indexes a changed file and updates body_hash while keeping incoming edges", async () => {
    const before = engine.getNode(findId("helper"))!;
    // Edit helper's body (same name/path → same id; body_hash must change).
    writeFileSync(
      join(root, "util.ts"),
      `export function helper(x: number): number {\n  return x + 100;\n}\n`,
    );
    await engine.sync(["util.ts"]);

    const after = engine.getNode(before.id);
    expect(after).not.toBeNull();
    expect(after!.id).toBe(before.id); // line-independent id survives the edit
    expect(after!.bodyHash).not.toBe(before.bodyHash); // body changed → drift signal
    // Incoming cross-file edge (run → helper) survives the re-index.
    expect(engine.getCallers(after!.id).some((n) => n.name === "run")).toBe(true);
  });
});
