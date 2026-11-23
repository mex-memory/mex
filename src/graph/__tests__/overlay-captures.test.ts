import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rebuildGraph, refreshGraph } from "../maintenance.js";
import { openGraphRead } from "../overlay-open.js";
import { graphLocation, readGraphPointer } from "../storage.js";
import { graphEngineBinary } from "../native-engine.js";
import { openWarmCheckout } from "../warm.js";

/**
 * An overlay after a change to an imported module must match a fresh build.
 * The resident engine also needs to resume edits from that overlay.
 */

const binary = graphEngineBinary();
const roots: string[] = [];
beforeAll(() => {
  vi.stubEnv("MEX_GRAPH_STORAGE", "v5");
  vi.stubEnv("MEX_GRAPH_ENGINE_LANGUAGES", "typescript,javascript");
});
afterAll(() => vi.unstubAllEnvs());
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function inHome<T>(home: string, work: () => Promise<T> | T): Promise<T> {
  const previous = process.env.MEX_HOME;
  process.env.MEX_HOME = home;
  try { return await work(); }
  finally {
    if (previous === undefined) delete process.env.MEX_HOME;
    else process.env.MEX_HOME = previous;
  }
}
function calls(root: string): unknown[] {
  const db = openGraphRead(root)!;
  try {
    return db.prepare(`SELECT s.qualified_name AS caller, t.qualified_name AS callee, e.line, e.col
      FROM edges e JOIN nodes s ON e.source = s.id JOIN nodes t ON e.target = t.id
      WHERE e.kind = 'calls' ORDER BY 1, 2, 3, 4`).all();
  } finally { db.close(); }
}

const A = "export function f(): number {\n  return 1;\n}\n";
const B = "import { f } from \"./a\";\n\nexport function useF(): number {\n  return f();\n}\n";

describe.skipIf(!binary)("overlay dependencies", () => {
  it("matches a standalone build after a new export and resumes warm edits", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-captures-"));
    const home = mkdtempSync(join(tmpdir(), "mex-captures-home-"));
    const fresh = mkdtempSync(join(tmpdir(), "mex-captures-fresh-"));
    roots.push(root, home, fresh);
    execFileSync("git", ["init", "-q", "."], { cwd: root });
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true }, include: ["src"] }));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), A);
    writeFileSync(join(root, "src/b.ts"), B);
    await inHome(home, () => rebuildGraph(root));

    // A new export changes the module surface seen by b.ts.
    writeFileSync(join(root, "src/a.ts"), `${A}\nexport function g(): number {\n  return 2;\n}\n`);
    await inHome(home, () => refreshGraph(root));
    expect((await inHome(home, () => readGraphPointer(graphLocation(root))))?.overlay).toBeTruthy();
    await inHome(fresh, () => rebuildGraph(root));
    const expected = await inHome(fresh, () => calls(root));
    expect(expected).toEqual([expect.objectContaining({ caller: "useF", callee: "f" })]);
    expect(await inHome(home, () => calls(root))).toEqual(expected);

    const warm = await inHome(home, () => openWarmCheckout(root));
    try {
      writeFileSync(join(root, "src/a.ts"), `${A.replace("return 1;", "return 3;")}\nexport function g(): number {\n  return 2;\n}\n`);
      expect(await inHome(home, () => warm.edit(["src/a.ts"]))).toMatchObject({ status: "published" });
    } finally { warm.close(); }
  }, 120_000);

  it("takes a body edit warm in a project that emits declaration maps", async () => {
    // A declaration map records where each body ends; a line added inside a
    // body moves it, though nothing an importer sees changed.
    const root = mkdtempSync(join(tmpdir(), "mex-declmap-"));
    const home = mkdtempSync(join(tmpdir(), "mex-declmap-home-"));
    roots.push(root, home);
    execFileSync("git", ["init", "-q", "."], { cwd: root });
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true, declaration: true, declarationMap: true, outDir: "dist" }, include: ["src"] }));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), A);
    writeFileSync(join(root, "src/b.ts"), B);
    await inHome(home, () => rebuildGraph(root));
    const warm = await inHome(home, () => openWarmCheckout(root));
    try {
      writeFileSync(join(root, "src/a.ts"), A.replace("  return 1;\n", "  const one = 1;\n  return one;\n"));
      expect(await inHome(home, () => warm.edit(["src/a.ts"]))).toMatchObject({ status: "published" });
    } finally { warm.close(); }
  }, 120_000);
});
