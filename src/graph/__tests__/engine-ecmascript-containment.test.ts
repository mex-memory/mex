import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { graphEngineBinary } from "../native-engine.js";
import { createGraphEngine } from "../engine-impl.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project nested one level down, so `..` is a real directory outside it. */
function nestedProject(): { workspace: string; root: string } {
  const workspace = mkdtempSync(join(tmpdir(), "mex-graph-containment-"));
  roots.push(workspace);
  const root = join(workspace, "package");
  mkdirSync(root, { recursive: true });
  return { workspace, root };
}

function write(root: string, path: string, source: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source, "utf8");
}

describe.skipIf(!graphEngineBinary())("ECMAScript engine input containment", () => {
  it("finishes a build whose tsconfig extends a package hoisted above the root", async () => {
    const { workspace, root } = nestedProject();
    // The hoisted layout every pnpm/yarn workspace produces: the package the
    // config extends resolves above the indexed root.
    write(workspace, "node_modules/shared-config/tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: true } }));
    write(workspace, "node_modules/shared-config/package.json",
      JSON.stringify({ name: "shared-config", version: "1.0.0" }));
    write(root, "tsconfig.json", JSON.stringify({
      extends: "shared-config/tsconfig.json",
      compilerOptions: { target: "ES2022" },
    }));
    write(root, "package.json", JSON.stringify({ name: "package", version: "1.0.0" }));
    write(root, "src/service.ts", "export function containedPrimary(): number { return 1; }\n");
    const engine = createGraphEngine({ rootDir: root });

    try {
      const result = await engine.build();

      expect(result.filesIndexed).toBe(1);
      expect(result.engine).toMatchObject({ files: 1, fallbackFiles: 0 });
      expect(engine.searchNodes("containedPrimary").length).toBeGreaterThan(0);
    } finally {
      engine.close();
    }
  }, 60_000);

  it("excludes a source and a project reference above the root", async () => {
    const { workspace, root } = nestedProject();
    write(workspace, "sibling/tsconfig.json", JSON.stringify({ compilerOptions: {} }));
    write(workspace, "sibling/src/other.ts", "export const other = 1;\n");
    write(root, "tsconfig.json", JSON.stringify({
      compilerOptions: { composite: true },
      include: ["src/**/*", "../sibling/src/**/*"],
      references: [{ path: "../sibling" }],
    }));
    write(root, "src/service.ts", "export function referencedPrimary(): number { return 1; }\n");

    const engine = createGraphEngine({ rootDir: root });
    try {
      const result = await engine.build();
      expect(result.engine).toMatchObject({ files: 1, fallbackFiles: 0 });
      expect(engine.searchNodes("referencedPrimary")).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "referencedPrimary" }),
      ]));
      expect(engine.searchNodes("other")).toEqual([]);
    } finally { engine.close(); }
  });
});
