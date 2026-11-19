import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GRAPH_CORPUS_LIMITS } from "../corpus-policy.js";
import { createGraphEngine } from "../engine-impl.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-graph-corpus-skip-"));
  roots.push(root);
  return root;
}

function write(root: string, path: string, source: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source, "utf8");
}

/** A syntactically valid module far above the per-file ceiling. */
function oversizedModule(): string {
  const filler = `// ${"x".repeat(120)}\n`;
  return `export const oversized = true;\n`
    + filler.repeat(Math.ceil(GRAPH_CORPUS_LIMITS.maxSourceFileBytes / filler.length) + 1);
}

describe("oversized files do not abort a graph build", () => {
  it("indexes every other file and reports the one it skipped", async () => {
    const root = temporaryRoot();
    write(root, "src/service.ts", "export function servicePrimary(): number { return 1; }\n");
    write(root, "src/other.ts", "export function otherPrimary(): number { return 2; }\n");
    write(root, "src/generated.ts", oversizedModule());
    const engine = createGraphEngine({ rootDir: root });

    try {
      const result = await engine.build();

      expect(result.filesIndexed).toBe(2);
      expect(result.skipped).toEqual([{
        filePath: "src/generated.ts",
        reason: "corpus-limit",
        limit: "maxSourceFileBytes",
        limitBytes: GRAPH_CORPUS_LIMITS.maxSourceFileBytes,
        observedBytes: expect.any(Number),
        message: expect.stringContaining("maxSourceFileBytes safety bound:"),
      }]);
      expect(engine.getIndexedFiles?.().map((file) => file.path))
        .toEqual(["src/other.ts", "src/service.ts"]);
    } finally {
      engine.close();
    }
  }, 60_000);

  it("keeps compiler extraction when another file imports the skipped file", async () => {
    // The compiler sees the skipped file as absent. Reading it used to fail
    // the project on every compiler, and every file lost its compiler capture.
    const root = temporaryRoot();
    write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "es2022", module: "esnext", moduleResolution: "bundler", strict: true }, include: ["src"] }));
    write(root, "src/generated.ts", oversizedModule());
    write(root, "src/other.ts", "export function otherPrimary(): number { return 2; }\n");
    write(root, "src/use.ts", "import { oversized } from \"./generated\";\nimport { otherPrimary } from \"./other\";\n\nexport function use(): number {\n  return oversized ? otherPrimary() : 0;\n}\n");
    const engine = createGraphEngine({ rootDir: root });

    try {
      const result = await engine.build() as Awaited<ReturnType<typeof engine.build>> & { typescript?: { projects: Record<string, string>; notes?: Array<{ note: string }> } };
      expect(result.skipped?.map((skip) => skip.filePath)).toEqual(["src/generated.ts"]);
      expect(result.typescript?.notes ?? [], JSON.stringify(result.typescript?.notes)).toEqual([]);
      expect(Object.values(result.typescript?.projects ?? {}).every((compiler) => compiler.startsWith("tsrs-"))).toBe(true);
      const callers = engine.getCallers(engine.searchNodes("otherPrimary").find((node) => node.name === "otherPrimary")!.id);
      expect(callers.map((caller) => caller.name)).toEqual(["use"]);
    } finally {
      engine.close();
    }
  }, 60_000);

  it("does not treat a skipped file as a lost source on sync", async () => {
    const root = temporaryRoot();
    write(root, "src/service.ts", "export function syncedPrimary(): number { return 1; }\n");
    write(root, "src/generated.ts", oversizedModule());
    const engine = createGraphEngine({ rootDir: root });

    try {
      await engine.build();
      // The skipped file is absent from the staged corpus by design, so naming
      // it as changed must not read as a source that disappeared mid-build.
      await expect(engine.sync(["src/generated.ts"])).resolves.toBeDefined();
      const reader = createGraphEngine({ rootDir: root, readOnly: true });
      try { expect(reader.coverageFor("src/generated.ts")).toEqual({ indexed: false, reason: "too big" }); }
      finally { reader.close(); }
    } finally {
      engine.close();
    }
  }, 60_000);

  it("honours an additive ignore glob configured by the repository", async () => {
    const root = temporaryRoot();
    write(root, "src/service.ts", "export function keptPrimary(): number { return 1; }\n");
    write(root, "vendor/bundle.ts", "export function droppedPrimary(): number { return 2; }\n");
    write(root, ".mex/config.json", JSON.stringify({ graph: { ignore: ["vendor/**"] } }));
    const engine = createGraphEngine({ rootDir: root });

    try {
      const result = await engine.build();

      expect(result.filesIndexed).toBe(1);
      expect(engine.getIndexedFiles?.().map((file) => file.path)).toEqual(["src/service.ts"]);
    } finally {
      engine.close();
    }
  }, 60_000);
});
