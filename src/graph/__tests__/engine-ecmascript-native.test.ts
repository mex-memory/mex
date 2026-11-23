import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSqlite } from "../db/sqlite.js";
import { createGraphEngine } from "../index.js";
import { corpusExtractorVersion, CORPUS_EXTRACTOR_VERSION, discoverGraphConfigSources, graphManifest } from "../manifest.js";
import { GRAPH_ENGINE_ENV, GRAPH_ENGINE_LANGUAGES_ENV, graphEngineBinary } from "../native-engine.js";
import { ensureGraphCurrent, rebuildGraph, refreshGraph } from "../maintenance.js";
import { inspectGraphStatus, inspectGraphStatusWithFreshObservation } from "../status.js";
import { GRAPH_SNAPSHOT_METADATA_KEY } from "../snapshot.js";
import { currentGraphPath } from "../storage.js";
import { WARM_DEFAULTS, WarmRegistry } from "../warm-registry.js";
import { openWarmCheckout } from "../warm.js";

const binary = graphEngineBinary();
const service = `/** Runs the supplied callback. */
export function invoke(callback: () => string): string { return callback(); }
export function reply(): string;
export function reply(name: string): string;
export function reply(name = "world"): string { return name.toUpperCase(); }
`;
const client = `import { invoke as run, reply as handler } from "@lib/service";
/** A generic worker. */
export abstract class Worker<T> {
  protected static async copy<U>(value: U): Promise<U> { return value; }
}
export function client(): string { return run(handler); }
router.get("/hello", handler);
`;
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-engine-ecmascript-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { allowJs: true, jsx: "preserve", paths: { "@lib/*": ["./src/*"] } },
  }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { express: "5.0.0" } }));
  writeFileSync(join(root, "src/service.ts"), service);
  writeFileSync(join(root, "src/client.ts"), client);
  writeFileSync(join(root, "src/view.tsx"), "export function View() { return <main />; }\n");
  writeFileSync(join(root, "src/other.jsx"), "export function Other() { return <div />; }\n");
  writeFileSync(join(root, "src/script.mjs"), 'import { reply } from "./service.js";\nexport function run() { return reply(); }\n');
  return root;
}

async function build(root: string) {
  vi.stubEnv("MEX_GRAPH_STORAGE", "v4");
  const engine = createGraphEngine({ rootDir: root });
  try { return await engine.build(); }
  finally { engine.close(); }
}

function rows(root: string, dbPath = currentGraphPath(root)) {
  const db = openSqlite(dbPath, { readOnly: true });
  try {
    const nodes = (db.prepare("SELECT * FROM nodes ORDER BY id").all() as Array<Record<string, unknown>>)
      .map(({ updated_at: _updatedAt, ...node }) => node);
    return {
      nodes,
      contains: db.prepare(
        "SELECT source, target, line, col, provenance, metadata FROM edges WHERE kind = 'contains' ORDER BY source, target",
      ).all(),
      edges: db.prepare(`
        SELECT s.qualified_name AS source, t.qualified_name AS target, e.kind,
               e.line, e.col, e.provenance, e.confidence, e.resolution_method, e.metadata, e.evidence
        FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
        ORDER BY 1, 2, 3, 4, 5
      `).all(),
      unresolved: db.prepare(
        "SELECT reference_name, reference_kind, resolver, status, metadata FROM unresolved_refs ORDER BY ref_key",
      ).all(),
      // Neighbours depend on the reference resolver. Sketches depend only on the definition.
      fingerprints: db.prepare("SELECT node_id, minhash, token_count FROM node_fingerprints ORDER BY node_id").all(),
      cache: db.prepare("SELECT path FROM file_extraction_cache ORDER BY path").all(),
      files: db.prepare("SELECT path, language, extractor_version FROM files ORDER BY path").all(),
    };
  } finally {
    db.close();
  }
}

describe.skipIf(!binary)("TypeScript and JavaScript from the Rust engine into schema v4", () => {
  it("preserves node identities, containment and sketches and stages engine and framework edges", async () => {
    const root = repo();
    vi.stubEnv(GRAPH_ENGINE_LANGUAGES_ENV, undefined);
    const result = await build(root);
    expect(result.engine).toMatchObject({ languages: ["javascript", "typescript"], files: 5, fallbackFiles: 0 });
    expect(result.engine?.fellBack).toBeUndefined();

    const after = rows(root);
    // Public ids and spans recorded from the staged engine on 04862dd2.
    expect(after.nodes.map(({ id, start_line, start_column, end_line, end_column }) =>
      [id, start_line, start_column, end_line, end_column])).toEqual([
      ["class:ebef1e9da97e6da6cc0844a1fec26a76", 3, 0, 5, 1],
      ["file:2a30765a357426885d3b56b8f5bb630d", 1, 0, 3, 0],
      ["file:492e9c2efafe29265fdc6cc2da58600e", 2, 0, 6, 0],
      ["file:5a1129aa765990bd481cce21d4f864a5", 1, 0, 2, 0],
      ["file:6caac54bca8eaf0aa5cf826457a81bac", 1, 0, 2, 0],
      ["file:eeb0b68f6fde214f99c12a02d2f2f430", 1, 0, 8, 0],
      ["function:14e5a2c3edb7f27ed78e1603ea2af487", 3, 0, 5, 76],
      ["function:1af7b7c5c7f21f3d4b53befb5b33c5ea", 1, 0, 1, 43],
      ["function:28f9054e073c565d33011d03c6020736", 2, 0, 2, 77],
      ["function:4cc0973bafbe939db93630ea20bba942", 1, 0, 1, 43],
      ["function:8397053dec78ba43a684aa65b266556e", 6, 0, 6, 57],
      ["function:8d4edec0331393ed20ade0670a58f335", 2, 0, 2, 41],
      ["method:9d7e9f9217d057744d2e9a0d94c7f666", 4, 2, 4, 72],
      ["route:3e2fdb3ded137be1c97df823cf8b45da", 7, 0, 7, 28],
    ]);
    expect(after.nodes).toContainEqual(expect.objectContaining({
      qualified_name: "Worker", docstring: "A generic worker.", is_abstract: 1, type_parameters: '["T"]',
    }));
    expect(after.nodes).toContainEqual(expect.objectContaining({
      qualified_name: "Worker::copy", visibility: "protected", is_static: 1, is_async: 1, return_type: "Promise<U>",
    }));
    expect(after.contains).toContainEqual(expect.objectContaining({
      source: "class:ebef1e9da97e6da6cc0844a1fec26a76", target: "method:9d7e9f9217d057744d2e9a0d94c7f666",
    }));
    expect(after.fingerprints).toContainEqual(expect.objectContaining({
      node_id: "method:9d7e9f9217d057744d2e9a0d94c7f666", token_count: 22,
    }));
    expect(after.cache).toEqual([]);
    expect(after.files).toEqual([
      { path: "src/client.ts", language: "typescript", extractor_version: "tree-sitter-v5+engine-typescript-v1" },
      { path: "src/other.jsx", language: "jsx", extractor_version: "tree-sitter-v5+engine-javascript-v1" },
      { path: "src/script.mjs", language: "javascript", extractor_version: "tree-sitter-v5+engine-javascript-v1" },
      { path: "src/service.ts", language: "typescript", extractor_version: "tree-sitter-v5+engine-typescript-v1" },
      { path: "src/view.tsx", language: "tsx", extractor_version: "tree-sitter-v5+engine-typescript-v1" },
    ]);
    expect(after.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "client", target: "invoke", kind: "calls", resolution_method: "engine-ecmascript",
        line: 6, metadata: '{"targetName":"run","targetQualifiedName":"invoke"}',
      }),
      expect.objectContaining({
        source: "invoke", target: "reply", kind: "calls", provenance: "callback-synthesis",
        line: 6, confidence: 0.85, resolution_method: "engine-ecmascript",
        evidence: expect.stringContaining('"filePath":"src/client.ts"'),
      }),
      expect.objectContaining({ source: "run", target: "reply", kind: "calls", resolution_method: "engine-ecmascript" }),
      expect.objectContaining({ source: "GET /hello", target: "reply", kind: "references", provenance: "framework" }),
    ]));
    expect(after.unresolved).toContainEqual(expect.objectContaining({
      reference_name: "get", reference_kind: "calls", resolver: "engine-ecmascript", status: "unresolved",
    }));
  });

  it.each([["typescript", 3], ["javascript", 2]] as const)("limits the engine to the %s family when requested", async (flag, files) => {
    const root = repo();
    vi.stubEnv(GRAPH_ENGINE_LANGUAGES_ENV, flag);
    expect((await build(root)).engine).toMatchObject({ languages: [flag], files, fallbackFiles: 0 });
    expect(rows(root).cache).toHaveLength(5 - files);
  });

  it("falls back to the captured source for a changed file and demotes its dangling engine edges", async () => {
    const root = repo();
    const path = join(root, "src/service.ts");
    const dbPath = join(root, "graph.db");
    const graph = createGraphEngine({
      rootDir: root,
      dbPath,
      __internalGraphEngineHooks: {
        afterSourcesStaged: () => writeFileSync(path, `function rerouted(cb: () => string) { return cb(); }
          export { rerouted as invoke };
          export function reply(): string { return "different"; }\n`),
        afterExtraction: () => writeFileSync(path, service),
      },
    } as Parameters<typeof createGraphEngine>[0]);
    try {
      const result = await graph.build(root);
      expect(result.engine).toMatchObject({ files: 4, fallbackFiles: 1 });
      const staged = rows(root, dbPath);
      expect(staged.cache).toEqual([{ path: "src/service.ts" }]);
      expect(staged.nodes).toContainEqual(expect.objectContaining({ qualified_name: "invoke" }));
      expect(staged.nodes).not.toContainEqual(expect.objectContaining({ qualified_name: "rerouted" }));
      expect(staged.unresolved).toContainEqual(expect.objectContaining({
        reference_name: "run", reference_kind: "calls", resolver: "engine-ecmascript",
        metadata: '{"reason":"target_changed_during_build"}',
      }));
    } finally {
      graph.close();
    }
  });

  it("queues a normal refresh for v4 edits", async () => {
    vi.stubEnv("MEX_GRAPH_STORAGE", "v4");
    const root = repo();
    await build(root);
    const reason = "Schema v4 edits use a normal graph refresh.";
    await expect(openWarmCheckout(root)).rejects.toThrow(reason);
    const open = vi.fn();
    const queueRefresh = vi.fn();
    const log = vi.fn();
    const registry = new WarmRegistry({ open, queueRefresh, log }, { ...WARM_DEFAULTS, quietMs: 0 });
    registry.note("project", root, ["src/client.ts"]);
    await registry.run();
    expect(open).not.toHaveBeenCalled();
    expect(queueRefresh).toHaveBeenCalledWith("project", root);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(reason));
  });
});

function fallbackFixture(): string {
  const root = repo();
  writeFileSync(join(root, "src/a.ts"), "export function helper() { return 1; }");
  writeFileSync(join(root, "src/b.js"), 'import { helper } from "./a"; export function caller() { return helper(); }');
  return root;
}

async function expectFallback(root: string, reason: string, expectedFiles = 7): Promise<void> {
  const status = await inspectGraphStatus({ projectRoot: root });
  expect(status.status).toBe("fresh");
  expect(status.schemaVersion).toBe(4);
  expect(status.engineFallback).toEqual({
    languages: ["javascript", "typescript"], files: 0, fallbackFiles: expectedFiles, fellBack: reason,
  });
  expect(status.diagnostics).toContainEqual(expect.objectContaining({
    code: "GRAPH_ENGINE_FALLBACK",
    message: expect.stringContaining(reason),
  }));
  const graph = rows(root);
  expect(graph.files.every(file => (file as { extractor_version: string }).extractor_version === "tree-sitter-v5")).toBe(true);
  expect(graph.edges).toContainEqual(expect.objectContaining({
    source: "caller", target: "helper", kind: "calls",
  }));
}

it.each(["v4", undefined])("publishes Node extraction and coverage without an engine (storage %s)", async (storage) => {
  const root = fallbackFixture();
  vi.stubEnv(GRAPH_ENGINE_ENV, join(root, "missing-mex-graph.wasm"));
  vi.stubEnv("MEX_GRAPH_STORAGE", storage);
  const result = await rebuildGraph(root);
  const reason = "no mex-graph binary was found";
  expect(result.engine).toMatchObject({ files: 0, fallbackFiles: 7, fellBack: reason });
  await expectFallback(root, reason);
  await expect(ensureGraphCurrent(root)).resolves.toMatchObject({
    operation: "unchanged", engine: { files: 0, fallbackFiles: 7, fellBack: reason },
  });
});

function failedEngine(root: string): string {
  const path = join(root, "failed-engine");
  writeFileSync(path, `#!/bin/sh
if [ "$1" = version ]; then
  echo '{"version":"0.1.0","contract":3}'
  exit 0
fi
echo '{"type":"error","code":"graph_memory_limit","message":"internal diagnostics"}'
exit 3
`, { mode: 0o755 });
  return path;
}

it.skipIf(process.platform === "win32").each(["v4", "v5"])(
  "publishes Node extraction and coverage after an engine job fails (storage %s)", async (storage) => {
    const root = fallbackFixture();
    vi.stubEnv("MEX_GRAPH_STORAGE", storage);
    vi.stubEnv(GRAPH_ENGINE_ENV, failedEngine(root));
    const result = await rebuildGraph(root);
    const reason = "the engine stopped (graph_memory_limit)";
    expect(result.engine).toMatchObject({ files: 0, fallbackFiles: 7, fellBack: reason });
    await expectFallback(root, reason);
  },
);

it.skipIf(!binary || process.platform === "win32")("falls back from a failed v5 refresh and retries the engine when it recovers", async () => {
  const root = fallbackFixture();
  vi.stubEnv("MEX_GRAPH_STORAGE", "v5");
  expect((await rebuildGraph(root)).status.schemaVersion).toBe(5);
  writeFileSync(join(root, "src/a.ts"), "export function helper() { return 2; }");
  vi.stubEnv(GRAPH_ENGINE_ENV, failedEngine(root));
  expect((await refreshGraph(root)).status.schemaVersion).toBe(4);
  await expectFallback(root, "the engine stopped (graph_memory_limit)");
  vi.stubEnv(GRAPH_ENGINE_ENV, binary);
  const recovered = await ensureGraphCurrent(root);
  expect(recovered.status).toMatchObject({ status: "fresh", schemaVersion: 5 });
  expect(recovered.status.engineFallback).toBeUndefined();
  expect(recovered.engine).toMatchObject({ files: 7, fallbackFiles: 0 });
});

it("refuses to bind a compiler-era manifest even when source drift is bounded", async () => {
  const root = repo();
  vi.stubEnv("MEX_GRAPH_STORAGE", "v4");
  await build(root);
  const path = currentGraphPath(root);
  const { db, corpusPolicyHash, grammarHash, configHash } = graphManifest(root).inputs;
  const extractorVersion = "typescript-api-v8+tree-sitter-v4";
  const resolverVersion = "compiler-first-v3";
  const manifestHash = createHash("sha256").update(JSON.stringify({
    db, compiler: "5.9.3", extractor: extractorVersion, resolver: resolverVersion,
    corpusPolicyHash, grammarHash, configHash,
  })).digest("hex");
  const store = openSqlite(path);
  try {
    const read = store.prepare("SELECT value FROM project_metadata WHERE key = ?");
    const raw = (read.get(GRAPH_SNAPSHOT_METADATA_KEY) as { value: string }).value;
    const { engineFallback: _fallback, ...snapshot } = JSON.parse(raw);
    const update = store.prepare("UPDATE project_metadata SET value = ? WHERE key = ?");
    update.run(manifestHash, "manifest_hash");
    update.run(JSON.stringify({
      ...snapshot, manifestHash, extractorVersion, resolverVersion, compilerVersion: "tsrs-0.25.0", semanticInputs: [],
    }), GRAPH_SNAPSHOT_METADATA_KEY);
    store.prepare("INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)").run("compiler_version", "tsrs-0.25.0", 0);
  } finally { store.close(); }
  writeFileSync(join(root, "src/service.ts"), `${service}\n// changed\n`);
  const observed = await inspectGraphStatusWithFreshObservation({ projectRoot: root });
  expect(observed.graphStatus).toMatchObject({ status: "stale", changes: { manifestChanged: true, total: 1 } });
  expect(observed.degradedObservation).toBeNull();
  expect((await ensureGraphCurrent(root)).status.status).toBe("fresh");
  const published = openSqlite(currentGraphPath(root), { readOnly: true, immutable: true });
  try {
    expect(published.prepare("SELECT value FROM project_metadata WHERE key = 'compiler_version'").get()).toBeUndefined();
  } finally { published.close(); }
});

it("versions all default engine languages and records the exact override", () => {
  expect(corpusExtractorVersion({}))
    .toBe(`${CORPUS_EXTRACTOR_VERSION}+engine-csharp-javascript-python-rust-typescript-v1`);
  expect(corpusExtractorVersion({ [GRAPH_ENGINE_LANGUAGES_ENV]: "tsx, Javascript, Python, TypeScript" }))
    .toBe(`${CORPUS_EXTRACTOR_VERSION}+engine-javascript-python-typescript-v1`);
});

it("uses tracked package manifests even when generated package manifests are ignored", () => {
  const root = repo();
  const tracked = "src/package.json";
  mkdirSync(join(root, "src/generated"));
  writeFileSync(join(root, "src/.gitignore"), "package.json\n");
  writeFileSync(join(root, tracked), '{"name":"workspace","version":"1.0.0"}');
  writeFileSync(join(root, "src/generated/package.json"), '{"name":"generated"}');
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "--force", tracked], { cwd: root });
  vi.stubEnv(GRAPH_ENGINE_LANGUAGES_ENV, "");
  const configs = discoverGraphConfigSources(root);
  expect(configs.has(tracked)).toBe(true);
  expect(configs.has("src/generated/package.json")).toBe(false);
  const before = graphManifest(root);
  writeFileSync(join(root, tracked), '{"name":"workspace","version":"2.0.0"}');
  expect(graphManifest(root).configHash).toBe(before.configHash);
  writeFileSync(join(root, tracked), '{"name":"renamed","version":"2.0.0"}');
  expect(graphManifest(root).configHash).not.toBe(before.configHash);
});
