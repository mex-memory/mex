import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSqlite } from "../db/sqlite.js";
import { createGraphEngine } from "../index.js";
import { corpusExtractorVersion, CORPUS_EXTRACTOR_VERSION, discoverGraphConfigSources, graphManifest } from "../manifest.js";
import { GRAPH_ENGINE_ENV, GRAPH_ENGINE_LANGUAGES_ENV, graphEngineBinary } from "../native-engine.js";
import { currentGraphPath } from "../storage.js";
import { WARM_DEFAULTS, WarmRegistry } from "../warm-registry.js";
import { openWarmCheckout } from "../warm.js";

const languages = "typescript,javascript";
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

async function build(root: string, flag: string, options: Omit<Parameters<typeof createGraphEngine>[0], "rootDir"> = {}) {
  vi.stubEnv(GRAPH_ENGINE_LANGUAGES_ENV, flag);
  const engine = createGraphEngine({ rootDir: root, ...options });
  try {
    return await engine.build(root);
  } finally {
    engine.close();
  }
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

describe.skipIf(!graphEngineBinary())("TypeScript and JavaScript from the Rust engine into schema v4", () => {
  it("preserves node identities, containment and sketches and stages engine and framework edges", async () => {
    const baseline = repo();
    const native = repo();
    vi.stubEnv("MEX_GRAPH_COMPILER", "typescript-5.9");
    expect((await build(baseline, "")).typescript).toBeDefined();
    // A build fully on the engine never reads the compiler selection.
    vi.stubEnv("MEX_GRAPH_COMPILER", "invalid-for-this-test");
    const result = await build(native, languages);
    expect(result.engine).toMatchObject({ languages: ["javascript", "typescript"], files: 5, fallbackFiles: 0 });
    expect(result.engine?.fellBack).toBeUndefined();
    expect(result.typescript).toBeUndefined();

    const before = rows(baseline);
    const after = rows(native);
    // Syntax supplies display strings on the engine. Everything that identifies
    // or grounds a node must match the compiler.
    const structural = ({ signature: _signature, return_type: _returnType, docstring: _docstring, ...node }: Record<string, unknown>) => node;
    expect(after.nodes.map(structural)).toEqual(before.nodes.map(structural));
    expect(after.nodes).toContainEqual(expect.objectContaining({
      qualified_name: "Worker", docstring: "A generic worker.", is_abstract: 1, type_parameters: '["T"]',
    }));
    expect(after.nodes).toContainEqual(expect.objectContaining({
      qualified_name: "Worker::copy", visibility: "protected", is_static: 1, is_async: 1, return_type: "Promise<U>",
    }));
    expect(after.contains).toEqual(before.contains);
    expect(after.fingerprints.length).toBeGreaterThan(0);
    expect(after.fingerprints).toEqual(before.fingerprints);
    expect(after.cache).toEqual([]);
    expect(after.files).toEqual([
      { path: "src/client.ts", language: "typescript", extractor_version: "typescript-api-v8+engine-typescript-v1" },
      { path: "src/other.jsx", language: "jsx", extractor_version: "typescript-api-v8+engine-javascript-v1" },
      { path: "src/script.mjs", language: "javascript", extractor_version: "typescript-api-v8+engine-javascript-v1" },
      { path: "src/service.ts", language: "typescript", extractor_version: "typescript-api-v8+engine-typescript-v1" },
      { path: "src/view.tsx", language: "tsx", extractor_version: "typescript-api-v8+engine-typescript-v1" },
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

  it.each([
    ["typescript", 3, ["src/other.jsx", "src/script.mjs"]],
    ["javascript", 2, ["src/client.ts", "src/service.ts", "src/view.tsx"]],
  ] as const)("routes %s independently, including its JSX variant", async (flag, files, captured) => {
    const root = repo();
    const dbPath = join(root, "graph.db");
    const programFiles = new Set<string>();
    const programFactory = vi.fn((options: ts.CreateProgramOptions) => {
      const program = ts.createProgram(options);
      for (const file of program.getSourceFiles()) {
        if (file.fileName.startsWith(root)) programFiles.add(file.fileName.slice(root.length + 1));
      }
      return program;
    });
    const result = await build(root, flag, { dbPath, compilerExtraction: { programFactory } });
    expect(programFactory).toHaveBeenCalled();
    expect([...programFiles].sort()).toEqual(captured);
    expect(result.engine).toMatchObject({ languages: [flag], files, fallbackFiles: 0 });
    expect(result.typescript).toBeDefined();
    expect(rows(root, dbPath).cache).toEqual(captured.map((path) => ({ path })));
  });

  it("falls back to the captured source for a changed file and demotes its dangling engine edges", async () => {
    const root = repo();
    const path = join(root, "src/service.ts");
    const dbPath = join(root, "graph.db");
    vi.stubEnv(GRAPH_ENGINE_LANGUAGES_ENV, languages);
    vi.stubEnv("MEX_GRAPH_COMPILER", "typescript-5.9");
    const graph = createGraphEngine({
      rootDir: root,
      dbPath,
      __internalGraphEngineHooks: {
        afterSemanticInputsStaged: () => writeFileSync(path, `function rerouted(cb: () => string) { return cb(); }
          export { rerouted as invoke };
          export function reply(): string { return "different"; }\n`),
        afterCompilerExtraction: () => writeFileSync(path, service),
      },
    } as Parameters<typeof createGraphEngine>[0]);
    try {
      const result = await graph.build(root);
      expect(result.engine).toMatchObject({ files: 4, fallbackFiles: 1 });
      expect(result.typescript).toBeDefined();
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
    const root = repo();
    await build(root, languages);
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

it("keeps the compiler build and captures when the engine is unavailable", async () => {
  const baseline = repo();
  const fallback = repo();
  vi.stubEnv("MEX_GRAPH_COMPILER", "typescript-5.9");
  const before = await build(baseline, "");
  vi.stubEnv(GRAPH_ENGINE_ENV, join(fallback, "missing-mex-graph"));
  const after = await build(fallback, languages);
  expect(after.engine).toMatchObject({
    languages: ["javascript", "typescript"], files: 0, fellBack: "no mex-graph binary was found",
  });
  expect(after.typescript).toEqual(before.typescript);
  expect(rows(fallback)).toEqual(rows(baseline));
});

it("versions the engine's TypeScript, JavaScript and combined routes", () => {
  expect(corpusExtractorVersion({ [GRAPH_ENGINE_LANGUAGES_ENV]: "typescript" }))
    .toBe(`${CORPUS_EXTRACTOR_VERSION}+engine-typescript-v1`);
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
  expect(discoverGraphConfigSources(root).has(tracked)).toBe(false);
  vi.stubEnv(GRAPH_ENGINE_LANGUAGES_ENV, languages);
  const configs = discoverGraphConfigSources(root);
  expect(configs.has(tracked)).toBe(true);
  expect(configs.has("src/generated/package.json")).toBe(false);
  const before = graphManifest(root);
  writeFileSync(join(root, tracked), '{"name":"workspace","version":"2.0.0"}');
  expect(graphManifest(root).configHash).toBe(before.configHash);
  writeFileSync(join(root, tracked), '{"name":"renamed","version":"2.0.0"}');
  expect(graphManifest(root).configHash).not.toBe(before.configHash);
});
