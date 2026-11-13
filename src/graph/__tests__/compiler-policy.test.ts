import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTypeScriptExtraction } from "../extraction/compiler.js";
import { ApiProjectCompiler, loadTsrsServer, tsgoServer, type TypeScriptApiServer } from "../extraction/compiler-api.js";
import {
  compareServersOnRepository,
  graphCompilerChoice,
  loadGraphCompilers,
  pinnedCompilerVersions,
} from "../extraction/compiler-policy.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-compiler-policy-"));
  temporary.push(root);
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true }, include: ["src"] }),
    "src/a.ts": "export function helper(n: number): number { return n + 1; }\n",
    "src/b.ts": "import { helper } from './a';\nexport function run(): number { return helper(1) + helper(2); }\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("choosing the TypeScript compiler", () => {
  it("reads MEX_GRAPH_COMPILER, auto by default", () => {
    expect(graphCompilerChoice({})).toBe("auto");
    expect(graphCompilerChoice({ MEX_GRAPH_COMPILER: "TSRS" })).toBe("tsrs");
    expect(graphCompilerChoice({ MEX_GRAPH_COMPILER: "tsgo" })).toBe("tsgo");
    expect(graphCompilerChoice({ MEX_GRAPH_COMPILER: "5.9" })).toBe("typescript-5.9");
    expect(() => graphCompilerChoice({ MEX_GRAPH_COMPILER: "babel" })).toThrow(/auto, tsrs, tsgo or typescript-5\.9/u);
  });

  it("builds with tsrs by default, with tsgo behind it and 5.9 behind that", async () => {
    const versions = pinnedCompilerVersions();
    const auto = await loadGraphCompilers("auto");
    expect(auto.identity).toBe(`tsrs:${versions.tsrs}+typescript-${versions.typescript59}`);
    expect(auto.description).toBe(`tsrs ${versions.tsrs}`);
    const compiler = auto.options.selectCompiler!({ id: "p", configPath: null, options: {} })!;
    expect(compiler.name).toMatch(/^tsrs-/u);
    expect(compiler.fallback?.name).toMatch(/^tsgo-/u);
    expect(compiler.fallback?.fallback).toBeUndefined();
  });

  it("pins tsgo or 5.9 when asked", async () => {
    expect((await loadGraphCompilers("tsgo")).identity).toMatch(/^tsgo:/u);
    expect((await loadGraphCompilers("typescript-5.9")).options).toEqual({});
  });

  it("moves a project tsrs cannot build to tsgo, and says why", async () => {
    const real = await loadTsrsServer();
    const broken: TypeScriptApiServer = { ...real, start: () => { throw new Error("no binary for this platform"); } };
    const result = buildTypeScriptExtraction(repository(), undefined, {
      selectCompiler: () => new ApiProjectCompiler(broken, new ApiProjectCompiler(tsgoServer())),
    });
    expect(result.files).toHaveLength(2);
    expect(Object.values(result.projectCompilers)).toEqual([expect.stringMatching(/^tsgo-/u)]);
    expect(Object.values(result.projectCompilerNotes).flat()).toEqual([
      expect.stringMatching(/^tsrs-.* failed \(no binary for this platform\); tsgo-.* used$/u),
    ]);
  });
});

describe("the release check of tsrs against tsgo", () => {
  it("agrees on a repository both servers extract alike", async () => {
    const comparison = await compareServersOnRepository(repository());
    expect(comparison.agrees).toBe(true);
    expect(comparison.report?.edges.matched).toBeGreaterThan(0);
  });

  it("reports a forced mismatch", async () => {
    // This "tsrs" reads one file with a different body.
    const real = await loadTsrsServer();
    const skewed: TypeScriptApiServer = {
      ...real,
      start: ({ cwd, fs }) => real.start({
        cwd,
        fs: {
          ...fs,
          readFile: (fileName) => fileName.endsWith("/src/b.ts")
            ? "import { helper } from './a';\nexport function run(): number { return 0; }\nexport function extra(): number { return helper(3); }\n"
            : typeof fs.readFile === "function" ? fs.readFile(fileName) : fs.readFile,
        },
      }),
    };
    const comparison = await compareServersOnRepository(repository(), { tsrs: skewed });
    expect(comparison.agrees).toBe(false);
    expect(comparison.reason).toMatch(/^tsrs and tsgo disagree on \d+ of \d+ edges, \d+ nodes and \d+ imports$/u);
  });

  it("reports a tsrs that cannot start", async () => {
    const real = await loadTsrsServer();
    const broken: TypeScriptApiServer = { ...real, start: () => { throw new Error("no binary for this platform"); } };
    const comparison = await compareServersOnRepository(repository(), { tsrs: broken });
    expect(comparison.agrees).toBe(false);
    expect(comparison.reason).toMatch(/tsrs failed on the repository: .*no binary for this platform/u);
  });
});
