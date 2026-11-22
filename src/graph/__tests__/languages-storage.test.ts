import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rebuildGraph, refreshGraph } from "../maintenance.js";
import { FingerprintStore } from "../fingerprint-store.js";
import { openGraphRead } from "../overlay-open.js";
import { graphLocation, readGraphPointer } from "../storage.js";
import { graphEngineBinary } from "../native-engine.js";
import { openWarmCheckout } from "../warm.js";

/**
 * Every language's extractor writes to the new storage: a build puts each
 * language's nodes in the base, an edit to each language's file lands in the
 * checkout's overlay, and base plus overlay equals a fresh build row for row.
 */

const binary = graphEngineBinary();
const roots: string[] = [];
beforeAll(() => {
  vi.stubEnv("MEX_GRAPH_STORAGE", "v5");
  vi.stubEnv("MEX_GRAPH_ENGINE_LANGUAGES", "typescript,javascript,python,rust,csharp");
});
afterAll(() => vi.unstubAllEnvs());
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const FILES: Record<string, [string, string]> = {
  "src/a.ts": ["typescript", "export function alpha(): number {\n  return beta();\n}\n\nexport function beta(): number {\n  return 1;\n}\n"],
  "src/b.tsx": ["tsx", "export function View(): number {\n  return 2;\n}\n"],
  "src/c.js": ["javascript", "export function gamma() {\n  return 3;\n}\n"],
  "src/d.jsx": ["jsx", "export function Item() {\n  return 4;\n}\n"],
  "py/e.py": ["python", "def epsilon():\n    return zeta()\n\ndef zeta():\n    return 5\n"],
  "rs/f.rs": ["rust", "pub fn eta() -> i32 {\n    theta()\n}\n\nfn theta() -> i32 {\n    6\n}\n"],
  "cs/G.cs": ["csharp", "public class G {\n    public int Iota() { return Kappa(); }\n    private int Kappa() { return 7; }\n}\n"],
};

const TABLES: Record<string, string> = {
  nodes: "SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, signature, body_hash FROM nodes",
  edges: "SELECT source, target, kind, line, col, provenance, confidence, resolution_method FROM edges",
  files: "SELECT path, content_hash, language, parse_status, node_count FROM files",
};

function images(root: string): Record<string, string[]> {
  const db = openGraphRead(root)!;
  try {
    const rows = Object.fromEntries(Object.entries(TABLES).map(([table, sql]) =>
      [table, (db.prepare(sql).all() as unknown[]).map((row) => JSON.stringify(Object.values(row as object))).sort()]));
    const fingerprints = new FingerprintStore(db);
    rows.fingerprints = (db.prepare("SELECT node_id FROM node_fingerprints ORDER BY node_id").all() as Array<{ node_id: string }>)
      .map(({ node_id }) => JSON.stringify([node_id, fingerprints.get(node_id)]));
    return rows;
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

describe.skipIf(!binary)("every language on the new storage", () => {
  it("builds, overlays and matches a fresh build in every language", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-languages-"));
    const home = mkdtempSync(join(tmpdir(), "mex-languages-home-"));
    const fresh = mkdtempSync(join(tmpdir(), "mex-languages-fresh-"));
    roots.push(root, home, fresh);
    execFileSync("git", ["init", "-q", "."], { cwd: root });
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, jsx: "preserve", module: "esnext", moduleResolution: "bundler" }, include: ["src"] }));
    for (const [path, [, text]] of Object.entries(FILES)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    expect((await inHome(home, () => rebuildGraph(root))).status.schemaVersion).toBe(5);
    const languages = await inHome(home, () => {
      const db = openGraphRead(root)!;
      try { return (db.prepare("SELECT DISTINCT language FROM nodes ORDER BY language").all() as Array<{ language: string }>).map((row) => row.language); }
      finally { db.close(); }
    });
    expect(languages).toEqual([...new Set(Object.values(FILES).map(([language]) => language))].sort());

    // One edit per language, each refreshed into the checkout's overlay.
    for (const [path, [language, text]] of Object.entries(FILES)) {
      const edited = language === "python" ? `${text}\ndef added_${language}():\n    return epsilon()\n`
        : language === "rust" ? `${text}\npub fn added_rust() -> i32 {\n    eta()\n}\n`
        : language === "csharp" ? text.replace("private int Kappa() { return 7; }", "private int Kappa() { return 8; }\n    public int Added() { return Iota(); }")
        : `${text}\nexport function added_${language}() {\n  return 0;\n}\n`;
      writeFileSync(join(root, path), edited);
      await inHome(home, () => refreshGraph(root));
      expect((await inHome(home, () => readGraphPointer(graphLocation(root))))?.overlay, path).toBeTruthy();
    }
    await inHome(fresh, () => rebuildGraph(root));
    const overlaid = await inHome(home, () => images(root));
    const built = await inHome(fresh, () => images(root));
    for (const table of Object.keys(built)) expect(overlaid[table], table).toEqual(built[table]);

    // Python also uses the resident engine when opted in on v5.
    const warm = await inHome(home, () => openWarmCheckout(root));
    try {
      writeFileSync(join(root, "py/e.py"), `${FILES["py/e.py"]![1]}\n# edited\n`);
      expect(await inHome(home, () => warm.edit(["py/e.py"]))).toMatchObject({ status: "published" });
    } finally { warm.close(); }
  }, 180_000);
});
