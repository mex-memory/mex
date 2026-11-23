import { currentGraphPath } from "../storage.js";
import { plantGraph } from "./plant-graph.js";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureGraphCurrent } from "../maintenance.js";
import { openSqlite } from "../db/sqlite.js";

const roots: string[] = [];
// These fixtures edit the v4 tables directly.
beforeEach(() => vi.stubEnv("MEX_GRAPH_STORAGE", "v4"));
afterEach(() => vi.unstubAllEnvs());

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-ensure-graph-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/service.ts"), "export const service = 1;\n");
  return root;
}

describe("ensure current graph", () => {
  it("builds cold, writes nothing when fresh, refreshes edits, and honors force", async () => {
    const root = fixture();
    expect(await ensureGraphCurrent(root)).toMatchObject({ operation: "rebuild", filesIndexed: 1 });
    const database = currentGraphPath(root);
    const directory = dirname(database);
    const bytes = readFileSync(database);
    const stats = statSync(database);
    const names = readdirSync(directory);
    expect(await ensureGraphCurrent(root)).toMatchObject({ operation: "unchanged", filesIndexed: 0 });
    expect(readFileSync(database)).toEqual(bytes);
    expect(statSync(database)).toMatchObject({ mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino });
    expect(readdirSync(directory)).toEqual(names);
    writeFileSync(join(root, "src/service.ts"), "export const service = 2;\n");
    expect(await ensureGraphCurrent(root)).toMatchObject({ operation: "refresh", filesIndexed: 1 });
    expect(await ensureGraphCurrent(root, { force: true })).toMatchObject({ operation: "rebuild", filesIndexed: 1 });
  });

  it.each(["incompatible", "corrupt"])("rebuilds an %s store", async (kind) => {
    const root = fixture();
    await ensureGraphCurrent(root);
    if (kind === "corrupt") plantGraph(root, "invalid database");
    else {
      const built = readFileSync(currentGraphPath(root));
      plantGraph(root, (file) => {
        writeFileSync(file, built);
        const db = openSqlite(file);
        try { db.exec("UPDATE schema_versions SET version = 999"); } finally { db.close(); }
      });
    }
    expect(await ensureGraphCurrent(root)).toMatchObject({ operation: "rebuild", filesIndexed: 1 });
  });

  it("honors cancellation before any filesystem writes", async () => {
    const root = fixture();
    const signal = AbortSignal.abort();
    await expect(ensureGraphCurrent(root, { signal })).rejects.toMatchObject({ code: "GRAPH_MAINTENANCE_CANCELLED" });
    expect(readdirSync(root)).toEqual(["src"]);
  });
});
