import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTypeScriptExtraction } from "../extraction/compiler.js";
import { ApiProjectCompiler, loadTsrsServer, type TypeScriptApiServer } from "../extraction/compiler-api.js";
import {
  checkTsrsOnRepository,
  graphCompilerChoice,
  loadGraphCompilers,
  pinnedCompilerVersions,
  storedTsrsVerdict,
  TSRS_CHECK_SETTING,
  TSRS_FULL_CHECK_JOB,
  type TsrsGateVerdict,
} from "../extraction/compiler-policy.js";
import { openRecord } from "../../record/index.js";
import { jobKind } from "../../record/jobs.js";
import "../../record/job-kinds.js";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "mex-compiler-policy-"));
  temporary.push(path);
  return path;
}

function repository(): string {
  const root = directory();
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", strict: true }, include: ["src"] }),
    "src/a.ts": "export function helper(n: number): number { return n + 1; }\n",
    "src/b.ts": "import { helper } from './a';\nexport function run(): number { return helper(1) + helper(2); }\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function verdict(server: "tsrs" | "tsgo", versions = pinnedCompilerVersions()): TsrsGateVerdict {
  return { tsrs: versions.tsrs, tsgo: versions.typescript7, server, ...(server === "tsgo" ? { reason: "disagreed" } : {}) };
}

describe("choosing the TypeScript compiler", () => {
  it("reads MEX_GRAPH_COMPILER, auto by default", () => {
    expect(graphCompilerChoice({})).toBe("auto");
    expect(graphCompilerChoice({ MEX_GRAPH_COMPILER: "TSRS" })).toBe("tsrs");
    expect(graphCompilerChoice({ MEX_GRAPH_COMPILER: "tsgo" })).toBe("tsgo");
    expect(graphCompilerChoice({ MEX_GRAPH_COMPILER: "5.9" })).toBe("typescript-5.9");
    expect(() => graphCompilerChoice({ MEX_GRAPH_COMPILER: "babel" })).toThrow(/auto, tsrs, tsgo or typescript-5\.9/u);
  });

  it("builds with tsgo until tsrs agreed with it on this repository, and with tsrs after", async () => {
    expect((await loadGraphCompilers("auto", undefined)).identity).toMatch(/^tsgo:/u);
    const agreed = await loadGraphCompilers("auto", verdict("tsrs"));
    expect(agreed.identity).toMatch(/^tsrs:/u);
    expect(agreed.description).toMatch(/^tsrs .*matches tsgo on this repository/u);
    const disagreed = await loadGraphCompilers("auto", verdict("tsgo"));
    expect(disagreed.identity).toMatch(/^tsgo:/u);
    expect(disagreed.description).toContain("disagreed");
  });

  it("ignores a verdict reached with other compiler versions", async () => {
    const outdated = { ...verdict("tsrs"), tsrs: "0.1.0" };
    expect((await loadGraphCompilers("auto", outdated)).identity).toMatch(/^tsgo:/u);
  });

  it("falls back from tsrs to tsgo for a project, and keeps 5.9 for an explicit choice", async () => {
    const pinned = await loadGraphCompilers("tsrs", undefined);
    const compiler = pinned.options.selectCompiler!({ id: "p", configPath: null, options: {} })!;
    expect(compiler.name).toMatch(/^tsrs-/u);
    expect(compiler.fallback?.name).toMatch(/^tsgo-/u);
    expect((await loadGraphCompilers("typescript-5.9", undefined)).options).toEqual({});
  });
});

describe("the tsrs check", () => {
  it("passes when tsrs and tsgo agree on the whole repository", async () => {
    const result = await checkTsrsOnRepository(repository());
    expect(result).toEqual(verdict("tsrs"));
  });

  it("moves the repository to tsgo when tsrs disagrees, and says why", async () => {
    // A forced mismatch: this "tsrs" reads one file with a different body.
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
    const result = await checkTsrsOnRepository(repository(), { tsrs: skewed });
    expect(result.server).toBe("tsgo");
    expect(result.reason).toMatch(/^tsrs and tsgo disagree on \d+ of \d+ edges in the full comparison$/u);
  });

  it("moves the repository to tsgo when tsrs cannot start", async () => {
    const real = await loadTsrsServer();
    const broken: TypeScriptApiServer = { ...real, start: () => { throw new Error("no binary for this platform"); } };
    const result = await checkTsrsOnRepository(repository(), { tsrs: broken });
    expect(result.server).toBe("tsgo");
    expect(result.reason).toMatch(/tsrs failed on the repository: .*no binary for this platform/u);
    // The project the check could not build with tsrs still built, with tsgo.
    expect(buildTypeScriptExtraction(repository(), undefined, {
      selectCompiler: () => new ApiProjectCompiler(broken, new ApiProjectCompiler((real as TypeScriptApiServer))),
    }).files).toHaveLength(2);
  });

  it("keeps the verdict in the local record, where every build of the repository reads it", async () => {
    vi.stubEnv("MEX_HOME", directory());
    const root = repository();
    const writer = openRecord({ projectPath: root });
    const projectId = writer.checkout(root)!.project_id;
    expect(storedTsrsVerdict(root)).toBeUndefined();
    const kind = jobKind(TSRS_FULL_CHECK_JOB)!;
    expect(kind.label).toBe("TypeScript compiler check");
    const outcome = await kind.runBatch({
      job: { project_id: projectId } as never, params: { root }, checkpoint: undefined, writer,
    });
    expect(outcome).toMatchObject({ done: true, summary: "tsrs matches tsgo on the whole repository" });
    expect(JSON.parse(writer.setting(projectId, TSRS_CHECK_SETTING)!)).toEqual(verdict("tsrs"));
    writer.close();
    expect(storedTsrsVerdict(root)).toEqual(verdict("tsrs"));
  });
});
