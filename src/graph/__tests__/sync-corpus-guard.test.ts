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
});
