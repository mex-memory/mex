import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { rebuildGraph, refreshGraph } from "../maintenance.js";
import { openGraphRead } from "../overlay-open.js";
import { graphLocation, readGraphPointer } from "../storage.js";
import { WarmCheckout } from "../warm.js";

/**
 * A refresh that changes what a file exports captures its importers again to
 * record the new signature, though their rows stay the same. The overlay must
 * carry those captures: base plus overlay reads what a fresh build stores, and
 * the next body edit to the file is taken warm.
 */

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function inHome<T>(home: string, work: () => Promise<T> | T): Promise<T> {
  vi.stubEnv("MEX_HOME", home);
  try { return await work(); } finally { vi.unstubAllEnvs(); }
}
function captures(root: string): string[] {
  const db = openGraphRead(root)!;
  try {
    return (db.prepare("SELECT path, content_hash, hex(payload) AS payload FROM file_extraction_cache ORDER BY path").all() as unknown[])
      .map((row) => JSON.stringify(row));
  } finally { db.close(); }
}

const A = "export function f(): number {\n  return 1;\n}\n";
const B = "import { f } from \"./a\";\n\nexport function useF(): number {\n  return f();\n}\n";

describe("overlay captures", () => {
  it("carries importers captured again for a new signature", async () => {
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

    // A new export: b.ts's rows are unchanged, its recorded signature of a.ts is not.
    writeFileSync(join(root, "src/a.ts"), `${A}\nexport function g(): number {\n  return 2;\n}\n`);
    await inHome(home, () => refreshGraph(root));
    expect((await inHome(home, () => readGraphPointer(graphLocation(root))))?.overlay).toBeTruthy();
    await inHome(fresh, () => rebuildGraph(root));
    expect(await inHome(home, () => captures(root))).toEqual(await inHome(fresh, () => captures(root)));

    const warm = await inHome(home, () => WarmCheckout.open(root));
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
    const warm = await inHome(home, () => WarmCheckout.open(root));
    try {
      writeFileSync(join(root, "src/a.ts"), A.replace("  return 1;\n", "  const one = 1;\n  return one;\n"));
      expect(await inHome(home, () => warm.edit(["src/a.ts"]))).toMatchObject({ status: "published" });
    } finally { warm.close(); }
  }, 120_000);
});
