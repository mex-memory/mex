import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGraphEngine, GraphSourceStagingError } from "../engine-impl.js";
import {
  DB_SCHEMA_VERSION,
  graphRequiresRebuild,
  openGraphDatabase,
  readSchemaVersion,
} from "../db/database.js";
import { openSqlite, type SqliteDatabase } from "../db/sqlite.js";
import { GraphStore } from "../db/store.js";
import { GraphRebuildRequiredError } from "../errors.js";
import { runGraphScope } from "../cli-agent.js";
import type { GraphEdge, GraphNode } from "../types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function node(id: string, name: string, filePath = "src/sample.ts"): GraphNode {
  return {
    id,
    kind: "function",
    name,
    qualifiedName: name,
    identityKey: `${filePath}\0function\0${name}`,
    filePath,
    language: "typescript",
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1,
  };
}

/** A minimal pre-v2 database. The migration must add everything else itself. */
function createV1Database(path: string): void {
  const db = openSqlite(path);
  try {
    db.exec(`
      CREATE TABLE schema_versions (
        version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT
      );
      INSERT INTO schema_versions VALUES (1, 1, 'legacy graph');
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
        qualified_name TEXT NOT NULL, file_path TEXT NOT NULL, language TEXT NOT NULL,
        start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
        start_column INTEGER NOT NULL, end_column INTEGER NOT NULL,
        docstring TEXT, signature TEXT, visibility TEXT,
        is_exported INTEGER DEFAULT 0, is_async INTEGER DEFAULT 0,
        is_static INTEGER DEFAULT 0, is_abstract INTEGER DEFAULT 0,
        decorators TEXT, type_parameters TEXT, return_type TEXT, body_hash TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, target TEXT NOT NULL,
        kind TEXT NOT NULL, metadata TEXT, line INTEGER, col INTEGER, provenance TEXT
      );
      CREATE TABLE files (
        path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, language TEXT NOT NULL,
        size INTEGER NOT NULL, modified_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL,
        node_count INTEGER DEFAULT 0, errors TEXT
      );
      CREATE TABLE unresolved_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, from_node_id TEXT NOT NULL,
        reference_name TEXT NOT NULL, reference_kind TEXT NOT NULL,
        line INTEGER NOT NULL, col INTEGER NOT NULL, candidates TEXT,
        file_path TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT 'unknown'
      );
      CREATE TABLE _mex_grounded_source (
        scaffold_file TEXT NOT NULL, node_id TEXT NOT NULL, body_hash TEXT NOT NULL,
        captured_at INTEGER NOT NULL, PRIMARY KEY (scaffold_file, node_id)
      );
      INSERT INTO _mex_grounded_source VALUES ('docs/unit.md', 'function:old', 'abc', 1);
    `);
  } finally {
    db.close();
  }
}

function rows(db: SqliteDatabase, sql: string): unknown[] {
  return db.prepare(sql).all() as unknown[];
}

function semanticSnapshot(path: string): Record<string, unknown[]> {
  const db = openSqlite(path);
  try {
    return {
      files: rows(db, `SELECT path, content_hash, language, size, node_count,
        parse_status, diagnostic_count, missing_count, error_coverage, extractor_version
        FROM files ORDER BY path`),
      nodes: rows(db, `SELECT id, kind, name, qualified_name, container_id, identity_key,
        file_path, language, start_line, end_line, start_column, end_column, signature,
        visibility, is_exported, is_async, is_static, is_abstract, return_type, body_hash
        FROM nodes ORDER BY id`),
      edges: rows(db, `SELECT source, target, kind, metadata, line, col, provenance,
        confidence, resolution_method, evidence FROM edges
        ORDER BY source, target, kind, IFNULL(line, -1), IFNULL(col, -1)`),
      references: rows(db, `SELECT ref_key, from_node_id, reference_name, reference_kind,
        line, col, candidates, file_path, language, receiver, qualifier, import_source,
        metadata, status, target_id, confidence, resolver FROM unresolved_refs ORDER BY ref_key`),
      imports: rows(db, `SELECT binding_key, file_path, local_name, imported_name,
        module_specifier, resolved_file_path, target_id, is_type_only, metadata
        FROM import_bindings ORDER BY binding_key`),
      chunks: rows(db, `SELECT file_path, start_line, end_line, content_hash,
        path_terms, identifier_terms, comment_terms FROM source_chunks
        ORDER BY file_path, start_line`),
    };
  } finally {
    db.close();
  }
}

describe("graph schema v2 migration and storage", () => {
  it("migrates v1 additively, preserves grounding, and requires a full rebuild", () => {
    const root = temporaryRoot("mex-schema-v2-");
    const dbPath = join(root, "graph.db");
    createV1Database(dbPath);

    expect(() => openGraphDatabase(dbPath)).toThrow(GraphRebuildRequiredError);

    const db = openGraphDatabase(dbPath, { allowRebuild: true });
    try {
      expect(readSchemaVersion(db)).toBe(DB_SCHEMA_VERSION);
      expect(graphRequiresRebuild(db)).toBe(true);
      expect(rows(db, "SELECT scaffold_file, node_id, body_hash FROM _mex_grounded_source"))
        .toEqual([{ scaffold_file: "docs/unit.md", node_id: "function:old", body_hash: "abc" }]);
      const nodeColumns = rows(db, "PRAGMA table_info(nodes)") as Array<{ name: string }>;
      expect(nodeColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "container_id", "identity_key",
      ]));
      expect(rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual(
        expect.arrayContaining([
          { name: "node_aliases" },
          { name: "source_chunks" },
          { name: "import_bindings" },
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("resolves legacy ids through aliases without changing the canonical result", () => {
    const root = temporaryRoot("mex-alias-v2-");
    const db = openGraphDatabase(join(root, "graph.db"));
    const store = new GraphStore(db);
    try {
      const canonical = node("function:new", "renamed");
      store.insertNode(canonical);
      expect(store.insertAlias("function:old", canonical.id, "body-hash", 0.95)).toBe(true);
      expect(store.getNodeById("function:old")).toMatchObject({ id: canonical.id, name: "renamed" });
      expect(store.getNodeById(canonical.id)).toMatchObject({ id: canonical.id });
      expect(store.getNodeById("function:missing")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("serves Scope through genuinely read-only graph connections", async () => {
    const root = temporaryRoot("mex-readonly-v2-");
    writeFileSync(join(root, "sample.ts"), "export function healthyNeedle(): number { return 1; }\n");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build(root);
    engine.close();

    const graphDir = join(root, ".mex");
    const dbPath = join(graphDir, "graph.db");
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${dbPath}${suffix}`;
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
    chmodSync(dbPath, 0o444);
    chmodSync(graphDir, 0o555);

    try {
      const readOnly = openGraphDatabase(dbPath, { readOnly: true });
      expect(() => readOnly.prepare(
        "INSERT INTO project_metadata (key, value) VALUES ('forbidden', 'write')",
      ).run()).toThrow(/read.?only/i);
      readOnly.close();

      const output: string[] = [];
      runGraphScope("healthyNeedle", root, { write: (line) => output.push(line) });
      const records = output.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records[0]).toMatchObject({ type: "meta", command: "graph scope" });
      expect(records.some((record) => record.type === "source")).toBe(true);
      expect(records.some((record) => record.type === "error")).toBe(false);
    } finally {
      chmodSync(graphDir, 0o755);
      chmodSync(dbPath, 0o644);
    }
  });

  it("deduplicates semantic callsites and retains the strongest resolution", () => {
    const root = temporaryRoot("mex-edges-v2-");
    const db = openGraphDatabase(join(root, "graph.db"));
    const store = new GraphStore(db);
    try {
      store.insertNode(node("function:source", "source"));
      store.insertNode(node("function:target", "target"));
      const weak: GraphEdge = {
        source: "function:source", target: "function:target", kind: "calls",
        line: 4, column: 8, confidence: 0.6, provenance: "heuristic",
        resolutionMethod: "name-match", evidence: [{ kind: "name" }],
      };
      store.insertEdge(weak);
      store.insertEdge({
        ...weak, confidence: 1, provenance: "typescript-compiler",
        resolutionMethod: "typescript-symbol", evidence: [{ kind: "compiler" }],
      });
      store.insertEdge({ ...weak, line: 5, confidence: 0.9 });

      expect(rows(db, "SELECT COUNT(*) AS count FROM edges")).toEqual([{ count: 2 }]);
      expect(store.getOutgoingEdges("function:source", ["calls"])).toEqual(expect.arrayContaining([
        expect.objectContaining({
          line: 4,
          confidence: 1,
          provenance: "typescript-compiler",
          resolutionMethod: "typescript-symbol",
          evidence: expect.arrayContaining([
            { kind: "compiler" },
            { kind: "name" },
            expect.objectContaining({
              type: "resolution-support", confidence: 1,
              provenance: "typescript-compiler", resolutionMethod: "typescript-symbol",
            }),
            expect.objectContaining({
              type: "resolution-support", confidence: 0.6,
              provenance: "heuristic", resolutionMethod: "name-match",
            }),
          ]),
        }),
      ]));
      expect(store.validateInvariants()).toMatchObject({ duplicateEdges: 0, danglingEdges: 0 });
    } finally {
      db.close();
    }
  });

  it("replaces overlapping source chunks and removes their FTS rows", () => {
    const root = temporaryRoot("mex-chunks-v2-");
    const db = openGraphDatabase(join(root, "graph.db"));
    const store = new GraphStore(db);
    try {
      const lines = Array.from({ length: 150 }, (_, index) => `const line${index + 1} = ${index + 1};`);
      lines[69] = "export const astonishingGraphNeedle = true;";
      expect(store.replaceSourceChunks("src/large.ts", lines.join("\n"), "hash-one")).toBe(3);
      expect(store.searchSourceChunks("astonishingGraphNeedle")).toEqual(expect.arrayContaining([
        expect.objectContaining({ filePath: "src/large.ts", startLine: 1, endLine: 80 }),
        expect.objectContaining({ filePath: "src/large.ts", startLine: 61, endLine: 140 }),
      ]));

      expect(store.replaceSourceChunks("src/large.ts", "export const replacementToken = 1;\n", "hash-two"))
        .toBe(1);
      expect(store.searchSourceChunks("astonishingGraphNeedle")).toEqual([]);
      expect(store.searchSourceChunks("replacementToken")).toEqual([
        expect.objectContaining({ filePath: "src/large.ts", contentHash: "hash-two" }),
      ]);
      store.deleteSourceChunks("src/large.ts");
      expect(store.searchSourceChunks("replacementToken")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("round-trips parser health and summarizes every health state", () => {
    const root = temporaryRoot("mex-health-v2-");
    const db = openGraphDatabase(join(root, "graph.db"));
    const store = new GraphStore(db);
    try {
      store.upsertFile({
        path: "src/partial.ts", contentHash: "partial", language: "typescript", size: 10,
        modifiedAt: 1, indexedAt: 2, nodeCount: 1, parseStatus: "partial",
        diagnosticCount: 2, missingCount: 1, errorCoverage: 0.125,
        extractorVersion: "typescript-compiler:5.9.3",
        errors: [{ code: 1109, message: "Expression expected" }],
      });
      for (const [path, parseStatus] of [["src/ok.ts", "ok"], ["src/failed.ts", "failed"]] as const) {
        store.upsertFile({
          path, contentHash: path, language: "typescript", size: 1,
          modifiedAt: 1, indexedAt: 2, nodeCount: 0, parseStatus,
        });
      }
      expect(store.getFileRecord("src/partial.ts")).toMatchObject({
        parseStatus: "partial", diagnosticCount: 2, missingCount: 1,
        errorCoverage: 0.125, extractorVersion: "typescript-compiler:5.9.3",
        errors: [{ code: 1109, message: "Expression expected" }],
      });
      expect(store.getHealthSummary()).toEqual({
        indexedFiles: 3, okFiles: 1, partialFiles: 1, failedFiles: 1,
      });
    } finally {
      db.close();
    }
  });
});

describe("graph construction integration", () => {
  it("creates compatibility aliases by signature, then by an unambiguous high-confidence fingerprint", async () => {
    const signatureRoot = temporaryRoot("mex-signature-alias-");
    mkdirSync(join(signatureRoot, "src"), { recursive: true });
    const originalPath = join(signatureRoot, "src", "original.ts");
    writeFileSync(originalPath, "export function stableMove(value: number): number { return value + 1; }\n");
    const signatureEngine = createGraphEngine({ rootDir: signatureRoot, dbPath: join(signatureRoot, "graph.db") });
    await signatureEngine.build();
    const oldSignatureId = signatureEngine.searchNodes("stableMove").find((entry) => entry.name === "stableMove")!.id;
    unlinkSync(originalPath);
    writeFileSync(
      join(signatureRoot, "src", "moved.ts"),
      "export function stableMove(value: number): number { return Math.max(0, value + 2); }\n",
    );
    await signatureEngine.sync(["src/original.ts", "src/moved.ts"]);
    expect(signatureEngine.getNode(oldSignatureId)).toMatchObject({ filePath: "src/moved.ts" });
    signatureEngine.close();
    const signatureDb = openGraphDatabase(join(signatureRoot, "graph.db"));
    expect(rows(signatureDb, "SELECT alias_id, match_method FROM node_aliases")).toContainEqual({
      alias_id: oldSignatureId, match_method: "signature",
    });
    signatureDb.close();

    const fingerprintRoot = temporaryRoot("mex-fingerprint-alias-");
    mkdirSync(join(fingerprintRoot, "src"), { recursive: true });
    const source = join(fingerprintRoot, "src", "handler.ts");
    writeFileSync(source, `export function legacyHandler(value: number): number {
  const first = value + 1;
  const second = first * 2;
  const third = second - 3;
  const fourth = Math.max(third, 4);
  const fifth = Math.min(fourth, 5);
  return first + second + third + fourth + fifth;
}\n`);
    const fingerprintEngine = createGraphEngine({ rootDir: fingerprintRoot, dbPath: join(fingerprintRoot, "graph.db") });
    await fingerprintEngine.build();
    const oldFingerprintId = fingerprintEngine.searchNodes("legacyHandler")
      .find((entry) => entry.name === "legacyHandler")!.id;
    writeFileSync(source, `export function modernHandler(input: number): number {
  const alpha = input + 10;
  const beta = alpha * 20;
  const gamma = beta - 30;
  const delta = Math.max(gamma, 40);
  const epsilon = Math.min(delta, 50);
  return alpha + beta + gamma + delta + epsilon;
}\n`);
    await fingerprintEngine.sync(["src/handler.ts"]);
    expect(fingerprintEngine.getNode(oldFingerprintId)).toMatchObject({ name: "modernHandler" });
    fingerprintEngine.close();
    const fingerprintDb = openGraphDatabase(join(fingerprintRoot, "graph.db"));
    expect(rows(fingerprintDb, "SELECT alias_id, match_method FROM node_aliases")).toContainEqual({
      alias_id: oldFingerprintId, match_method: "fingerprint",
    });
    fingerprintDb.close();
  });

  it("does not alias a deleted symbol to a newly added differently named signature match", async () => {
    const root = temporaryRoot("mex-signature-name-guard-");
    mkdirSync(join(root, "src"), { recursive: true });
    const removedPath = join(root, "src", "removed.ts");
    const replacementPath = join(root, "src", "replacement.ts");
    writeFileSync(removedPath, "export function removed(value: number): number { return value + 1; }\n");
    const dbPath = join(root, ".mex", "graph.db");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    const oldId = engine.searchNodes("removed").find((entry) => entry.name === "removed")!.id;

    unlinkSync(removedPath);
    writeFileSync(replacementPath, "export function replacement(value: number): number { return value * 2; }\n");
    await engine.sync(["src/removed.ts", "src/replacement.ts"]);
    expect(engine.getNode(oldId)).toBeNull();
    engine.close();

    const db = openGraphDatabase(dbPath);
    expect(rows(db, "SELECT alias_id FROM node_aliases")).not.toContainEqual({ alias_id: oldId });
    db.close();
  });

  it("does not alias one of two old same-name signatures to the sole survivor", async () => {
    const root = temporaryRoot("mex-signature-old-ambiguity-");
    mkdirSync(join(root, "src"), { recursive: true });
    const removedPath = join(root, "src", "first.ts");
    writeFileSync(removedPath, "export function shared(value: number): number { return value + 1; }\n");
    writeFileSync(
      join(root, "src", "second.ts"),
      "export function shared(value: number): number { return value * 2; }\n",
    );
    const dbPath = join(root, ".mex", "graph.db");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    const oldId = engine.searchNodes("shared", { limit: 10 })
      .find((entry) => entry.filePath === "src/first.ts")!.id;

    unlinkSync(removedPath);
    await engine.sync(["src/first.ts"]);
    expect(engine.getNode(oldId)).toBeNull();
    engine.close();

    const db = openGraphDatabase(dbPath);
    expect(rows(db, "SELECT alias_id FROM node_aliases")).not.toContainEqual({ alias_id: oldId });
    db.close();
  });

  it("never guesses a fingerprint alias when equally strong candidates exist", async () => {
    const root = temporaryRoot("mex-ambiguous-alias-");
    mkdirSync(join(root, "src"), { recursive: true });
    const source = join(root, "src", "handler.ts");
    const body = (name: string, value: number) => `export function ${name}(input: number): number {
  const alpha = input + ${value};
  const beta = alpha * ${value + 1};
  const gamma = beta - ${value + 2};
  const delta = Math.max(gamma, ${value + 3});
  const epsilon = Math.min(delta, ${value + 4});
  return alpha + beta + gamma + delta + epsilon;
}\n`;
    writeFileSync(source, body("legacyHandler", 1));
    const dbPath = join(root, ".mex", "graph.db");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    const oldId = engine.searchNodes("legacyHandler").find((entry) => entry.name === "legacyHandler")!.id;
    writeFileSync(source, body("firstCandidate", 10) + body("secondCandidate", 20));
    await engine.sync(["src/handler.ts"]);
    expect(engine.getNode(oldId)).toBeNull();
    engine.close();
    const db = openGraphDatabase(dbPath);
    expect(rows(db, "SELECT alias_id FROM node_aliases")).not.toContainEqual({ alias_id: oldId });
    db.close();
  });

  it("forces a deterministic rebuild when compiler configuration changes without a source edit", async () => {
    const root = temporaryRoot("mex-graph-manifest-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "manifest-fixture", type: "module" }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext" },
      include: ["src/**/*.ts"],
    }));
    writeFileSync(join(root, "src", "entry.ts"), "export const manifestNeedle = 1;\n");

    const dbPath = join(root, ".mex", "graph.db");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    const beforeDb = openGraphDatabase(dbPath);
    const before = new GraphStore(beforeDb);
    const manifestBefore = before.getMetadata("manifest_hash");
    const configBefore = before.getMetadata("config_hash");
    expect(before.getMetadata("grammar_hash")).toMatch(/^[a-f0-9]{64}$/);
    expect(before.getMetadata("compiler_version")).toBe("5.9.3");
    expect(before.getMetadata("extractor_version")).toContain("typescript-5.9");
    beforeDb.close();

    expect(await engine.sync([])).toMatchObject({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0 });
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
      include: ["src/**/*.ts"],
    }));
    const staleOutput: string[] = [];
    runGraphScope("manifestNeedle", root, { write: (line) => staleOutput.push(line) });
    expect(staleOutput.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ code: "GRAPH_REBUILD_REQUIRED", recoveryCommand: "mex graph" }),
    ]);
    expect(await engine.sync(["tsconfig.json"])).toMatchObject({ filesIndexed: 1 });
    engine.close();

    const afterDb = openGraphDatabase(dbPath);
    const after = new GraphStore(afterDb);
    expect(after.getMetadata("manifest_hash")).not.toBe(manifestBefore);
    expect(after.getMetadata("config_hash")).not.toBe(configBefore);
    afterDb.close();
  });

  it("aborts a failed incremental parse and preserves the last trustworthy snapshot", async () => {
    const root = temporaryRoot("mex-failed-sync-");
    mkdirSync(join(root, "src"), { recursive: true });
    const source = join(root, "src", "stable.ts");
    writeFileSync(source, "export function stableNeedle(): number { return 7; }\n");
    const engine = createGraphEngine({ rootDir: root, dbPath: join(root, "graph.db") });
    await engine.build();
    const prior = engine.searchNodes("stableNeedle").find((entry) => entry.name === "stableNeedle")!;
    writeFileSync(source, "}\n");

    const result = await engine.sync(["src/stable.ts"]);
    expect(result).toMatchObject({ filesIndexed: 0, nodesCreated: 0, edgesCreated: 0 });
    expect(result.health?.failed).toBe(1);
    expect(engine.getNode(prior.id)).toMatchObject({ id: prior.id, bodyHash: prior.bodyHash });
    engine.close();
  });

  it("aborts an unreadable changed source without confusing it for a deletion", async () => {
    const root = temporaryRoot("mex-unreadable-sync-");
    mkdirSync(join(root, "src"), { recursive: true });
    const source = join(root, "src", "stable.ts");
    writeFileSync(source, "export function stableIoNeedle(): number { return 7; }\n");
    let failRead = false;
    const engine = createGraphEngine({
      rootDir: root,
      dbPath: join(root, "graph.db"),
      sourceFileAccess: {
        read: (absolutePath) => {
          if (failRead && absolutePath === source) {
            throw Object.assign(new Error("injected unreadable source"), { code: "EACCES" });
          }
          return readFileSync(absolutePath, "utf-8");
        },
      },
    });
    await engine.build();
    const prior = engine.searchNodes("stableIoNeedle")
      .find((entry) => entry.name === "stableIoNeedle")!;
    writeFileSync(source, "export function stableIoNeedle(): number { return 9; }\n");
    failRead = true;

    const rejected = engine.sync(["src/stable.ts"]);
    await expect(rejected).rejects.toBeInstanceOf(GraphSourceStagingError);
    await expect(rejected).rejects.toMatchObject({
      code: "GRAPH_SOURCE_STAGING_FAILED",
      failures: [{ filePath: "src/stable.ts", operation: "read", code: "EACCES" }],
    });
    expect(engine.getNode(prior.id)).toMatchObject({ id: prior.id, bodyHash: prior.bodyHash });
    expect(engine.getIndexedFiles?.().map((file) => file.path)).toContain("src/stable.ts");

    failRead = false;
    const updated = await engine.sync(["src/stable.ts"]);
    expect(updated.filesIndexed).toBe(1);
    expect(engine.getNode(prior.id)?.bodyHash).not.toBe(prior.bodyHash);

    unlinkSync(source);
    const deleted = await engine.sync(["src/stable.ts"]);
    expect(deleted.filesIndexed).toBe(0);
    expect(engine.getNode(prior.id)).toBeNull();
    expect(engine.getIndexedFiles?.().map((file) => file.path)).not.toContain("src/stable.ts");
    engine.close();
  });

  it("sync deletion converges to a clean build and never binds production calls to tests", async () => {
    const root = temporaryRoot("mex-graph-convergence-");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
      include: ["src/**/*.ts", "test/**/*.ts"],
    }));
    writeFileSync(join(root, "src", "helper.ts"), "export function duplicate(): number { return 1; }\n");
    writeFileSync(join(root, "test", "helper.test.ts"), "export function duplicate(): number { return -1; }\n");
    writeFileSync(
      join(root, "src", "use.ts"),
      "import { duplicate } from './helper';\nexport function use(): number { return duplicate(); }\n",
    );
    writeFileSync(
      join(root, "src", "containers.ts"),
      "export class First { execute(): number { return 1; } }\n" +
        "export class Second { execute(): number { return 2; } }\n",
    );
    writeFileSync(join(root, "src", "obsolete.ts"), "export function obsolete(): void {}\n");

    const incrementalPath = join(root, "incremental.db");
    const incremental = createGraphEngine({ rootDir: root, dbPath: incrementalPath });
    await incremental.build();
    const executeNodes = incremental.searchNodes("execute").filter((candidate) => candidate.name === "execute");
    expect(executeNodes.map((candidate) => candidate.qualifiedName).sort()).toEqual([
      "First::execute", "Second::execute",
    ]);
    expect(new Set(executeNodes.map((candidate) => candidate.id)).size).toBe(2);

    const production = incremental.searchNodes("duplicate")
      .find((candidate) => candidate.filePath === "src/helper.ts")!;
    const testOnly = incremental.searchNodes("duplicate")
      .find((candidate) => candidate.filePath === "test/helper.test.ts")!;
    const use = incremental.searchNodes("use").find((candidate) => candidate.name === "use")!;
    expect(incremental.getCallees(use.id).map((candidate) => candidate.id)).toContain(production.id);
    expect(incremental.getCallees(use.id).map((candidate) => candidate.id)).not.toContain(testOnly.id);

    writeFileSync(join(root, "src", "helper.ts"), "export function duplicate(): number { return 2; }\n");
    writeFileSync(join(root, "src", "added.ts"), "export function added(): string { return 'new'; }\n");
    unlinkSync(join(root, "src", "obsolete.ts"));
    await incremental.sync(["src/helper.ts", "src/added.ts", "src/obsolete.ts"]);
    expect(incremental.searchNodes("obsolete")).toEqual([]);
    expect(incremental.getIndexedFiles?.().map((file) => file.path)).not.toContain("src/obsolete.ts");
    const incrementalSnapshot = semanticSnapshot(incrementalPath);
    incremental.close();

    const cleanPath = join(root, "clean.db");
    const clean = createGraphEngine({ rootDir: root, dbPath: cleanPath });
    await clean.build();
    const cleanSnapshot = semanticSnapshot(cleanPath);
    clean.close();
    expect(incrementalSnapshot).toEqual(cleanSnapshot);
  });
});
