import { currentGraphPath } from "../storage.js";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqlite } from "../db/sqlite.js";
import { createGraphEngine } from "../engine-impl.js";
import {
  GRAPH_SNAPSHOT_METADATA_KEY,
  parseGraphSnapshot,
  type GraphSnapshotSemanticInput,
} from "../snapshot.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-empty-sync-"));
  roots.push(root);
  return root;
}

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function semanticInputs(root: string): GraphSnapshotSemanticInput[] {
  const db = openSqlite(currentGraphPath(root));
  try {
    const row = db.prepare("SELECT value FROM project_metadata WHERE key = ?")
      .get(GRAPH_SNAPSHOT_METADATA_KEY) as { value?: unknown } | undefined;
    const snapshot = parseGraphSnapshot(typeof row?.value === "string" ? row.value : null);
    if (!snapshot) throw new Error("Expected a valid graph snapshot.");
    return snapshot.semanticInputs;
  } finally {
    db.close();
  }
}

describe("GraphEngine empty sync corpus guard", () => {
  it("only no-ops when the supported paths and exact content hashes still match", async () => {
    const root = temporaryRoot();
    const sourcePath = join(root, "src", "entry.ts");
    const original = "export function emptySyncAlpha(): number { return 1; }\n";
    const replacement = "export function emptySyncBravo(): number { return 2; }\n";
    const fixedTime = new Date("2024-01-01T00:00:00.000Z");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, original);
    utimesSync(sourcePath, fixedTime, fixedTime);

    const engine = createGraphEngine({ rootDir: root });
    try {
      await engine.build();

      expect(await engine.sync([])).toMatchObject({
        filesIndexed: 0,
        nodesCreated: 0,
        edgesCreated: 0,
      });

      writeFileSync(sourcePath, replacement);
      utimesSync(sourcePath, fixedTime, fixedTime);
      expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
      expect(statSync(sourcePath).mtimeMs).toBe(fixedTime.getTime());

      expect(await engine.sync([])).toMatchObject({ filesIndexed: 1 });
      expect(engine.searchNodes("emptySyncAlpha").some((node) => node.name === "emptySyncAlpha")).toBe(false);
      expect(engine.searchNodes("emptySyncBravo").some((node) => node.name === "emptySyncBravo")).toBe(true);
      expect(engine.getIndexedFiles?.()).toEqual([
        expect.objectContaining({ path: "src/entry.ts", contentHash: sha256(replacement) }),
      ]);

      writeFileSync(join(root, "src", "added.ts"), "export const addedDuringEmptySync = true;\n");
      expect(await engine.sync([])).toMatchObject({ filesIndexed: 2 });
      expect(engine.getIndexedFiles?.().map((file) => file.path)).toEqual([
        "src/added.ts",
        "src/entry.ts",
      ]);

      rmSync(sourcePath);
      expect(await engine.sync([])).toMatchObject({ filesIndexed: 1 });
      expect(engine.getIndexedFiles?.().map((file) => file.path)).toEqual(["src/added.ts"]);
    } finally {
      engine.close();
    }
  }, 20_000);

  it("rebuilds when persisted positive or negative semantic inputs change", async () => {
    const root = temporaryRoot();
    const basePath = join(root, "config", "base.json");
    const optionalPath = join(root, "config", "optional.json");
    const initialBase = JSON.stringify({ compilerOptions: { strict: true } });
    const changedBase = JSON.stringify({ compilerOptions: { strict: false } });
    const optional = JSON.stringify({ compilerOptions: { composite: true }, files: [] });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "src", "entry.ts"), "export const semanticGuardFact: number = 1;\n");
    writeFileSync(basePath, initialBase);
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      extends: "./config/base.json",
      references: [{ path: "./config/optional.json" }],
      include: ["src/**/*.ts"],
    }));

    const engine = createGraphEngine({ rootDir: root });
    try {
      await engine.build();
      expect(semanticInputs(root)).toEqual(expect.arrayContaining([
        { path: "config/base.json", contentHash: sha256(initialBase) },
        { path: "config/optional.json", contentHash: null },
      ]));

      writeFileSync(basePath, changedBase);
      expect(await engine.sync([])).toMatchObject({ filesIndexed: 1 });
      expect(semanticInputs(root)).toContainEqual({
        path: "config/base.json",
        contentHash: sha256(changedBase),
      });

      writeFileSync(optionalPath, optional);
      expect(await engine.sync([])).toMatchObject({ filesIndexed: 1 });
      expect(semanticInputs(root)).toContainEqual({
        path: "config/optional.json",
        contentHash: sha256(optional),
      });
    } finally {
      engine.close();
    }
  });
});
