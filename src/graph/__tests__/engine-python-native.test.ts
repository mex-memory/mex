import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { openSqlite } from "../db/sqlite.js";
import { GRAPH_ENGINE_ENV, GRAPH_ENGINE_LANGUAGES_ENV, graphEngineBinary } from "../native-engine.js";
import { createGraphEngine } from "../index.js";
import { corpusExtractorVersion, CORPUS_EXTRACTOR_VERSION } from "../manifest.js";
import { currentGraphPath } from "../storage.js";
import type { BuildResult } from "../engine.js";

/**
 * Python from the Rust engine into today's schema v4 graph (OSS-73), behind
 * `MEX_GRAPH_ENGINE_LANGUAGES=python`. Runs where an engine is built; the
 * fallback test runs everywhere.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "python-package");
const roots: string[] = [];
const saved = { languages: process.env[GRAPH_ENGINE_LANGUAGES_ENV], binary: process.env[GRAPH_ENGINE_ENV] };

afterEach(() => {
  for (const [key, value] of [[GRAPH_ENGINE_LANGUAGES_ENV, saved.languages], [GRAPH_ENGINE_ENV, saved.binary]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-engine-python-"));
  roots.push(root);
  cpSync(FIXTURE, join(root, "pkg"), { recursive: true });
  writeFileSync(join(root, "pkg/alias_service.py"),
    "from . import exported as named_export\n\ndef alias_call():\n    return named_export()\n");
  writeFileSync(join(root, "pkg/broken.py"), "def broken(:\n");
  writeFileSync(join(root, "app.ts"), "export function hello(): number { return 1; }\n");
  return root;
}

async function build(root: string, languages?: string): Promise<BuildResult> {
  if (languages === undefined) delete process.env[GRAPH_ENGINE_LANGUAGES_ENV];
  else process.env[GRAPH_ENGINE_LANGUAGES_ENV] = languages;
  const engine = createGraphEngine({ rootDir: root });
  try {
    return await engine.build(root);
  } finally {
    engine.close();
  }
}

interface Rows {
  nodes: unknown[];
  contains: unknown[];
  calls: Array<{ source: string; target: string }>;
  fingerprints: unknown[];
  files: Array<{ path: string; extractor_version: string; parse_status: string }>;
}

function rows(root: string): Rows {
  const db = openSqlite(currentGraphPath(root), { readonly: true });
  try {
    const fingerprintTable = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'node_fingerprints%' ORDER BY name DESC",
    ).get() as { name: string }).name;
    const nodes = (db.prepare("SELECT * FROM nodes ORDER BY id").all() as Array<Record<string, unknown>>)
      .map(({ updated_at: _updatedAt, ...node }) => node);
    return {
      nodes,
      contains: db.prepare("SELECT source, target, line FROM edges WHERE kind = 'contains' ORDER BY source, target").all(),
      calls: db.prepare(
        `SELECT s.qualified_name AS source, t.qualified_name AS target FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'calls' ORDER BY 1, 2`,
      ).all() as Rows["calls"],
      fingerprints: db.prepare(`SELECT node_id, minhash, neighbors, token_count FROM ${fingerprintTable} ORDER BY node_id`).all(),
      files: db.prepare("SELECT path, extractor_version, parse_status FROM files ORDER BY path").all() as Rows["files"],
    };
  } finally {
    db.close();
  }
}

describe.skipIf(!graphEngineBinary())("Python from the Rust engine into today's graph", () => {
  it("writes the same nodes, containment and fingerprints as today, with the engine's calls", async () => {
    const today = repo();
    const engine = repo();
    const todayBuild = await build(today);
    const engineBuild = await build(engine, "python");
    expect(todayBuild.engine).toBeUndefined();
    expect(engineBuild.engine).toMatchObject({ languages: ["python"], files: 5, fallbackFiles: 0 });
    expect(engineBuild.engine?.fellBack).toBeUndefined();

    const before = rows(today);
    const after = rows(engine);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.contains).toEqual(before.contains);
    expect(after.fingerprints.length).toBeGreaterThan(0);
    expect(after.fingerprints).toEqual(before.fingerprints);
    expect(after.calls).toContainEqual({ source: "alias_call", target: "exported" });

    const python = after.files.filter((file) => file.path.endsWith(".py"));
    expect(new Set(python.map((file) => file.extractor_version))).toEqual(new Set(["tree-sitter-v4+engine-python-v1"]));
    expect(after.files.find((file) => file.path === "pkg/broken.py")?.parse_status)
      .toBe(before.files.find((file) => file.path === "pkg/broken.py")?.parse_status);
    expect(after.files.find((file) => file.path === "app.ts")).toEqual(before.files.find((file) => file.path === "app.ts"));
  });
});

describe("the engine flag", () => {
  it("folds the engine's languages into the extractor version", () => {
    expect(corpusExtractorVersion({})).toBe(CORPUS_EXTRACTOR_VERSION);
    expect(corpusExtractorVersion({ [GRAPH_ENGINE_LANGUAGES_ENV]: "Python, cobol" }))
      .toBe(`${CORPUS_EXTRACTOR_VERSION}+engine-python-v1`);
  });

  it("keeps today's extractors and says why when no engine can run", async () => {
    const today = repo();
    const fallback = repo();
    await build(today);
    process.env[GRAPH_ENGINE_ENV] = join(fallback, "no-such-engine");
    const result = await build(fallback, "python");
    expect(result.engine).toMatchObject({ languages: ["python"], files: 0, fellBack: "no mex-graph binary was found" });
    const before = rows(today);
    const after = rows(fallback);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.calls).toEqual(before.calls);
    expect(after.files.map((file) => file.extractor_version)).toEqual(before.files.map((file) => file.extractor_version));
  });
});
