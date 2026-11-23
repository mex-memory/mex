import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rebuildGraph, refreshGraph } from "../maintenance.js";
import { FingerprintStore } from "../fingerprint-store.js";
import { openGraphRead } from "../overlay-open.js";
import { createGraphReadEngine } from "../read-engine.js";
import { readGraphPointer, graphLocation } from "../storage.js";
import { graphEngineBinary } from "../native-engine.js";
import { openWarmCheckout, type WarmGraphCheckout } from "../warm.js";

/**
 * The warm path must publish exactly what a cold refresh publishes for the
 * same edits. Two MEX homes hold the same repository: one is kept warm, the
 * other refreshes cold after every edit; their graphs, read through base plus
 * overlay, must match row for row. Edits the warm path cannot reproduce must
 * go cold instead of publishing anything.
 */

const binary = graphEngineBinary();
const roots: string[] = [];
beforeAll(() => {
  vi.stubEnv("MEX_GRAPH_STORAGE", "v5");
  vi.stubEnv("MEX_GRAPH_ENGINE_LANGUAGES", "typescript,javascript");
});
afterAll(() => vi.unstubAllEnvs());
const checkouts: WarmGraphCheckout[] = [];
afterAll(() => {
  for (const checkout of checkouts.splice(0)) checkout.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=warm", "-c", "user.email=warm@example.com", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
}
function put(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

const IMAGES: Record<string, string> = {
  nodes: "SELECT id, kind, name, qualified_name, container_id, identity_key, file_path, language, start_line, end_line, start_column, end_column, docstring, signature, visibility, is_exported, is_async, is_static, is_abstract, decorators, type_parameters, return_type, body_hash FROM nodes",
  edges: "SELECT source, target, kind, metadata, line, col, provenance, confidence, resolution_method, evidence FROM edges",
  files: "SELECT path, content_hash, language, size, parse_status, diagnostic_count, missing_count, error_coverage, errors, node_count, extractor_version FROM files",
  unresolved_refs: "SELECT ref_key, from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language, receiver, qualifier, import_source, metadata, status, target_id, resolver FROM unresolved_refs",
  coverage: "SELECT path, reason FROM coverage",
  source_chunks: "SELECT file_path, start_line, end_line, content_hash FROM source_chunks",
};

function images(root: string): Record<string, string[]> {
  const db = openGraphRead(root)!;
  try {
    const out: Record<string, string[]> = {};
    for (const [table, sql] of Object.entries(IMAGES)) {
      out[table] = (db.prepare(sql).all() as unknown[]).map((row) => JSON.stringify(Object.values(row as object))).sort();
    }
    const fingerprints = new FingerprintStore(db);
    out.fingerprints = (db.prepare("SELECT node_id FROM node_fingerprints ORDER BY node_id").all() as Array<{ node_id: string }>)
      .map(({ node_id }) => JSON.stringify([node_id, fingerprints.get(node_id)]));
    return out;
  } finally { db.close(); }
}

async function inHome<T>(home: string, work: () => Promise<T> | T): Promise<T> {
  const previous = process.env.MEX_HOME;
  process.env.MEX_HOME = home;
  try { return await work(); }
  finally {
    if (previous === undefined) delete process.env.MEX_HOME;
    else process.env.MEX_HOME = previous;
  }
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-warm-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main", ".");
  put(root, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "es2022", module: "esnext", moduleResolution: "bundler", strict: true }, include: ["src"] }));
  put(root, "src/util.ts", "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n");
  put(root, "src/math.ts", "import { add } from \"./util\";\n\nexport function sum(values: number[]): number {\n  let total = 0;\n  for (const value of values) total = add(total, value);\n  return total;\n}\n");
  put(root, "src/app.ts", "import { sum } from \"./math\";\nimport { mul } from \"./util\";\n\nexport function run(): number {\n  return sum([1, 2, 3]);\n}\n\nexport const twice = (value: number): number => mul(value, 2);\n");
  put(root, "src/other.ts", "export function lonely(): number {\n  return 1;\n}\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "start");
  return root;
}

describe.skipIf(!binary)("warm edits", () => {
  it("publishes the same rows as normal refresh across body, signature, and import edits", async () => {
    const root = repository();
    const warmHome = mkdtempSync(join(tmpdir(), "mex-warm-home-"));
    const coldHome = mkdtempSync(join(tmpdir(), "mex-cold-home-"));
    roots.push(warmHome, coldHome);
    await inHome(warmHome, () => rebuildGraph(root));
    await inHome(coldHome, () => rebuildGraph(root));
    const warm = await inHome(warmHome, () => openWarmCheckout(root));
    checkouts.push(warm);

    const steps: Array<{ name: string; path: string; text: string; expect: "published" | "unchanged" }> = [
      { name: "body edit", path: "src/math.ts", expect: "published",
        text: "import { add } from \"./util\";\n\nexport function sum(values: number[]): number {\n  let total = 10;\n  for (const value of values) total = add(total, value);\n  return total;\n}\n" },
      { name: "a new call into another file", path: "src/app.ts", expect: "published",
        text: "import { sum } from \"./math\";\nimport { mul } from \"./util\";\n\nexport function run(): number {\n  return mul(sum([1, 2, 3]), 3);\n}\n\nexport const twice = (value: number): number => mul(value, 2);\n" },
      { name: "a new private function", path: "src/other.ts", expect: "published",
        text: "export function lonely(): number {\n  return helper();\n}\n\nfunction helper(): number {\n  return 1;\n}\n" },
      { name: "the call removed again", path: "src/app.ts", expect: "published",
        text: "import { sum } from \"./math\";\nimport { mul } from \"./util\";\n\nexport function run(): number {\n  return sum([1, 2, 3]);\n}\n\nexport const twice = (value: number): number => mul(value, 2);\n" },
      { name: "the same bytes again", path: "src/app.ts", expect: "unchanged",
        text: "import { sum } from \"./math\";\nimport { mul } from \"./util\";\n\nexport function run(): number {\n  return sum([1, 2, 3]);\n}\n\nexport const twice = (value: number): number => mul(value, 2);\n" },
      { name: "an exported signature other files import", path: "src/util.ts", expect: "published",
        text: "export function add(a: number, b: number, c = 0): number {\n  return a + b + c;\n}\n\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n" },
      { name: "a removed declaration", path: "src/other.ts", expect: "published",
        text: "export function lonely(): number {\n  return 1;\n}\n" },
      { name: "another name from a module it already imports", path: "src/math.ts", expect: "published",
        text: "import { add, mul } from \"./util\";\n\nexport function sum(values: number[]): number {\n  let total = 10;\n  for (const value of values) total = add(total, mul(value, 1));\n  return total;\n}\n" },
      { name: "an import of a module it did not import", path: "src/math.ts", expect: "published",
        text: "import { add, mul } from \"./util\";\nimport { lonely } from \"./other\";\n\nexport function sum(values: number[]): number {\n  let total = lonely();\n  for (const value of values) total = add(total, mul(value, 1));\n  return total;\n}\n" },
      { name: "a body edit after a dependency change", path: "src/math.ts", expect: "published",
        text: "import { add, mul } from \"./util\";\nimport { lonely } from \"./other\";\n\nexport function sum(values: number[]): number {\n  let total = lonely() + 1;\n  for (const value of values) total = add(total, mul(value, 1));\n  return total;\n}\n" },
      { name: "two changed callsites", path: "src/app.ts", expect: "published",
        text: "import { sum } from \"./math\";\nimport { mul } from \"./util\";\n\nexport function run(): number {\n  return sum([4, 5, 6]);\n}\n\nexport const twice = (value: number): number => mul(value, 3);\n" },
    ];
    for (const step of steps) {
      if (step.expect !== "unchanged") put(root, step.path, step.text);
      const result = await inHome(warmHome, () => warm.edit([step.path]));
      expect(result.status, `${step.name}: ${result.reason ?? ""}`).toBe(step.expect);
      await inHome(coldHome, () => refreshGraph(root));
      const warmRows = await inHome(warmHome, () => images(root));
      const coldRows = await inHome(coldHome, () => images(root));
      for (const table of Object.keys(coldRows)) expect(warmRows[table], `${step.name}: ${table}`).toEqual(coldRows[table]);
    }
  }, 240_000);

  it("rebuilds a checkout whose pointer has an overlay from base plus overlay", async () => {
    const root = repository();
    const home = mkdtempSync(join(tmpdir(), "mex-warm-rebuild-"));
    const fresh = mkdtempSync(join(tmpdir(), "mex-warm-fresh-"));
    roots.push(home, fresh);
    await inHome(home, () => rebuildGraph(root));
    const warm = await inHome(home, () => openWarmCheckout(root));
    checkouts.push(warm);
    put(root, "src/app.ts", "import { sum } from \"./math\";\nimport { mul } from \"./util\";\n\nexport function run(): number {\n  return mul(sum([1, 2, 3]), 2);\n}\n\nexport const twice = (value: number): number => mul(value, 2);\n");
    expect((await inHome(home, () => warm.edit(["src/app.ts"]))).status).toBe("published");
    warm.close();
    expect((await inHome(home, () => readGraphPointer(graphLocation(root))))?.overlay).toBeTruthy();
    await inHome(home, () => rebuildGraph(root));
    await inHome(fresh, () => rebuildGraph(root));
    const rebuilt = await inHome(home, () => images(root));
    const expected = await inHome(fresh, () => images(root));
    for (const table of Object.keys(expected)) expect(rebuilt[table], table).toEqual(expected[table]);
  }, 120_000);

  it("answers a caller query from the overlay it just published", async () => {
    const root = repository();
    const home = mkdtempSync(join(tmpdir(), "mex-warm-read-"));
    roots.push(home);
    await inHome(home, () => rebuildGraph(root));
    const warm = await inHome(home, () => openWarmCheckout(root));
    checkouts.push(warm);
    put(root, "src/app.ts", "import { sum } from \"./math\";\nimport { mul } from \"./util\";\n\nexport function run(): number {\n  return mul(sum([1, 2, 3]), 2);\n}\n\nexport const twice = (value: number): number => mul(value, 2);\n");
    const result = await inHome(home, () => warm.edit(["src/app.ts"]));
    expect(result.status, result.reason).toBe("published");
    const callers = await inHome(home, () => {
      const db = openGraphRead(root)!;
      const engine = createGraphReadEngine(db, root);
      try {
        const mul = engine.searchNodes("mul").find((node) => node.name === "mul" && node.filePath === "src/util.ts")!;
        return engine.getCallers(mul.id).map((node) => node.name).sort();
      } finally { engine.close(); }
    });
    expect(callers).toContain("run");
  }, 120_000);
});
