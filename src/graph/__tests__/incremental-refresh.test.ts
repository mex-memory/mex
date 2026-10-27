// ============================================================================
// Incremental refresh convergence (issue #209)
// ============================================================================
//
// Every step applies one edit to a fixture repository and refreshes two stores
// from the same tree: DB-I through the default (incremental) sync and DB-F
// through the full-restage oracle. The complete derived-table dumps must be
// identical after every step. After each sequence the graph is also compared
// with a clean build of a fresh copy of the tree, where only continuity
// aliases (history by design) and path-dependent metadata are excluded.
//
// The edit kinds include the classic incremental-resolution failure: a
// same-named definition appearing or disappearing in a file other than its
// callers, where an indexer that re-resolves only changed files leaves
// unchanged callers bound to the old target.

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { incrementalClosureBudget } from "../extraction-cache.js";
import { createGraphEngine, GraphSourceStagingError, type GraphRefreshStrategy } from "../engine-impl.js";
import type { BuildResult } from "../engine.js";
import { openGraphDatabase } from "../db/database.js";
import { FingerprintStore } from "../fingerprint-store.js";
import { MinHashReconciler } from "../reconcile-engine.js";
import { createGroundingGraph, deriveGrounding, type GroundingGraph } from "../../wiki/grounding/adapter.js";
import { resolveGrounding } from "../../wiki/grounding/resolve.js";
import { diffGraphDumps, dumpGraphDatabase, type GraphDump } from "./graph-dump.js";
import {
  all, FIXTURES, MONOREPO_FIXTURE, PYTHON_FIXTURE, random, replace, TS_FIXTURE, write, writeTree,
  type Edit, type Fixture,
} from "./refresh-fixtures.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

async function refresh(
  root: string,
  dbPath: string,
  strategy: GraphRefreshStrategy,
): Promise<BuildResult | GraphSourceStagingError> {
  const engine = createGraphEngine({
    rootDir: root,
    dbPath,
    __internalRefreshStrategy: strategy,
  } as Parameters<typeof createGraphEngine>[0]);
  try {
    return await engine.sync([]);
  } catch (error) {
    if (error instanceof GraphSourceStagingError) return error;
    throw error;
  } finally {
    engine.close();
  }
}

async function build(root: string, dbPath: string): Promise<void> {
  const engine = createGraphEngine({ rootDir: root, dbPath });
  try {
    await engine.build(root);
  } finally {
    engine.close();
  }
}

const EXACT_TABLES = undefined;
/**
 * Another checkout of the same tree: a clean build has no continuity history,
 * and file mtimes and path-dependent metadata belong to its own directory.
 */
const CROSS_TREE_TABLES: (keyof GraphDump)[] = [
  "fileContents", "nodes", "edges", "importBindings", "unresolvedRefs", "fingerprints",
  "lshBuckets", "sourceChunks", "rowDigests", "extractionCache", "sourceChunksFts", "nodesFts",
];

function expectSameGraph(left: string, right: string, tables: (keyof GraphDump)[] | undefined, context: string): void {
  const differences = diffGraphDumps(dumpGraphDatabase(left), dumpGraphDatabase(right), tables);
  expect(differences, context).toEqual([]);
}

interface Harness {
  root: string;
  incrementalDb: string;
  fullDb: string;
  results: Array<{ edit: string; incremental: BuildResult | GraphSourceStagingError }>;
}

async function startHarness(fixture: Fixture): Promise<Harness> {
  const root = tempDir(`mex-incr-${fixture.name}-`);
  const stores = tempDir("mex-incr-stores-");
  writeTree(root, fixture.files);
  const harness: Harness = {
    root,
    incrementalDb: join(stores, "incremental.db"),
    fullDb: join(stores, "full.db"),
    results: [],
  };
  await build(root, harness.incrementalDb);
  await build(root, harness.fullDb);
  expectSameGraph(harness.incrementalDb, harness.fullDb, EXACT_TABLES, `${fixture.name}: initial build`);
  return harness;
}

async function step(harness: Harness, edit: Edit, context: string): Promise<void> {
  // Each refresh is long synchronous compiler work; let the test worker answer
  // its runner between steps.
  await new Promise((resolve) => setImmediate(resolve));
  edit.apply(harness.root);
  const incremental = await refresh(harness.root, harness.incrementalDb, "incremental");
  const full = await refresh(harness.root, harness.fullDb, "full");
  harness.results.push({ edit: edit.name, incremental });
  if (edit.refuses) {
    expect(incremental, `${context}: incremental refusal`).toBeInstanceOf(GraphSourceStagingError);
    expect(full, `${context}: full refusal`).toBeInstanceOf(GraphSourceStagingError);
    expect((incremental as GraphSourceStagingError).failures.map((failure) => failure.code))
      .toEqual((full as GraphSourceStagingError).failures.map((failure) => failure.code));
  } else {
    expect(incremental, `${context}: incremental refresh`).not.toBeInstanceOf(GraphSourceStagingError);
    expect(full, `${context}: full refresh`).not.toBeInstanceOf(GraphSourceStagingError);
    // An edit that changes nothing the graph depends on is a no-op for both.
    // Otherwise the stores carry row digests from their first build, so the
    // incremental refresh must publish as a delta, and the oracle never does.
    if ((full as BuildResult).refresh === undefined) {
      expect((incremental as BuildResult).refresh, `${context}: incremental no-op`).toBeUndefined();
    } else {
      expect((incremental as BuildResult).refresh?.publication, `${context}: incremental publication`).toBe("delta");
      expect((full as BuildResult).refresh?.publication, `${context}: oracle publication`).toBe("full");
    }
  }
  expectSameGraph(harness.incrementalDb, harness.fullDb, EXACT_TABLES, context);
}

async function expectCleanBuildConvergence(harness: Harness, context: string): Promise<void> {
  const fresh = tempDir("mex-incr-clean-");
  cpSync(harness.root, fresh, { recursive: true });
  const cleanDb = join(tempDir("mex-incr-clean-store-"), "clean.db");
  await build(fresh, cleanDb);
  expectSameGraph(harness.incrementalDb, cleanDb, CROSS_TREE_TABLES, `${context}: clean build`);
}

/** Deterministic xorshift PRNG so a failing random sequence replays exactly. */
// ── Tests ───────────────────────────────────────────────────────────────────

describe("incremental refresh converges with the full-restage oracle", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name}: every scripted edit kind leaves identical stores`, async () => {
      const harness = await startHarness(fixture);
      if (fixture.framework) {
        expect(dumpGraphDatabase(harness.incrementalDb).edges.some((edge) => edge.includes('"provenance":"framework"')),
          `${fixture.name}: framework wiring`).toBe(true);
      }
      for (const [index, edit] of fixture.edits.entries()) {
        await step(harness, edit, `${fixture.name} step ${index + 1} (${edit.name})`);
      }
      await expectCleanBuildConvergence(harness, fixture.name);
    }, 240_000);
  }

  for (const fixture of [TS_FIXTURE, PYTHON_FIXTURE]) {
    it(`${fixture.name}: a seeded random edit order leaves identical stores`, async () => {
      const next = random(209);
      const pool = fixture.edits.filter((edit) => !edit.refuses);
      const harness = await startHarness(fixture);
      for (let index = 0; index < 6; index++) {
        const edit = pool[Math.floor(next() * pool.length)]!;
        // A scripted edit may not apply to every random tree; skip it rather
        // than conflate a fixture mismatch with a convergence failure.
        try {
          await step(harness, edit, `${fixture.name} random step ${index + 1} (${edit.name})`);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("Fixture edit did not match")) continue;
          throw error;
        }
      }
      await expectCleanBuildConvergence(harness, `${fixture.name} random`);
    }, 240_000);
  }

  it("two incremental histories ending at the same tree produce identical stores", async () => {
    const first = await startHarness(TS_FIXTURE);
    const second = await startHarness(TS_FIXTURE);
    const edit = (name: string): Edit => TS_FIXTURE.edits.find((entry) => entry.name === name)!;
    const [comment, rename, addFile] = [edit("trailing comment"), edit("rename function"), edit("add file")];
    for (const edit of [comment!, rename!, addFile!]) await step(first, edit, `history A (${edit.name})`);
    for (const edit of [addFile!, rename!, comment!]) await step(second, edit, `history B (${edit.name})`);
    // Continuity aliases record each history's own id transitions by design.
    expectSameGraph(first.incrementalDb, second.incrementalDb, CROSS_TREE_TABLES, "two histories");
  }, 240_000);
});

// Written before the optimisation landed (issue #209): the incremental path is
// actually taken where it is safe, and the conservative fallbacks (a global
// declaration, any config change) report themselves.
describe("incremental refresh reports its mode", () => {
  it("takes the incremental path for safe edits and the full path for config or global changes", async () => {
    const harness = await startHarness(TS_FIXTURE);
    for (const [index, edit] of TS_FIXTURE.edits.entries()) {
      await step(harness, edit, `mode step ${index + 1} (${edit.name})`);
    }
    for (const [index, edit] of TS_FIXTURE.edits.entries()) {
      const result = harness.results[index]!.incremental;
      if (!edit.expectMode || result instanceof GraphSourceStagingError) continue;
      expect((result as BuildResult & { refresh?: { mode?: string } }).refresh?.mode, edit.name).toBe(edit.expectMode);
    }
  }, 240_000);
});

function withGroundingGraph<T>(root: string, dbPath: string, body: (graph: GroundingGraph) => T): T {
  const engine = createGraphEngine({ rootDir: root, dbPath });
  const db = openGraphDatabase(dbPath);
  try {
    return body(createGroundingGraph(engine, new MinHashReconciler(new FingerprintStore(db)), db));
  } finally {
    engine.close();
    db.close();
  }
}

// Grounding continuity (MOVED / AMBIGUOUS / GONE) reads node ids, aliases and
// fingerprints; the alias equality above covers it table by table, and this
// walks one grounded symbol across an incremental move end to end.
describe("incremental refresh of a monorepo", () => {
  it("builds programs only for the projects that read a changed file (#281)", async () => {
    const root = tempDir("mex-incr-projects-");
    const dbPath = join(tempDir("mex-incr-projects-store-"), "graph.db");
    writeTree(root, MONOREPO_FIXTURE.files);
    let built: string[] = [];
    const countPrograms = (): void => {
      built = [];
    };
    const run = async (operation: "build" | "sync"): Promise<BuildResult> => {
      const engine = createGraphEngine({
        rootDir: root,
        dbPath,
        compilerExtraction: {
          programFactory(options: ts.CreateProgramOptions) {
            built.push(String(options.rootNames.find((name) => !/\.d\.ts$/u.test(name))).replace(/^.*packages\/([^/]+)\/.*$/u, "$1"));
            return ts.createProgram(options);
          },
        },
        __internalRefreshStrategy: "incremental",
      } as Parameters<typeof createGraphEngine>[0]);
      try {
        return operation === "build" ? await engine.build(root) : await engine.sync([]);
      } finally {
        engine.close();
      }
    };
    await run("build");
    expect(built.sort()).toEqual(["app", "core", "tools"]);

    countPrograms();
    replace("packages/tools/src/report.ts", "lint(source)", "lint(source.trim())")(root);
    expect((await run("sync")).refresh?.mode).toBe("incremental");
    expect(built).toEqual(["tools"]);

    countPrograms();
    replace("packages/core/src/math.ts", "return a + b;", "return b + a;")(root);
    expect((await run("sync")).refresh?.mode).toBe("incremental");
    expect(built.sort()).toEqual(["app", "core"]);

    countPrograms();
    write("packages/tools/src/extra.ts", "export const extra = 1;\n")(root);
    await run("sync");
    expect(built.sort()).toEqual(["app", "core", "tools"]);
  }, 120_000);
});

describe("grounding across an incremental move", () => {
  it("resolves a grounded function moved to another file exactly as the oracle does", async () => {
    const body = "export function rotateRefreshToken(userId: string): number {\n  const windowSeconds = 3600;\n  const attempts = userId.length;\n  const budget = attempts * windowSeconds;\n  return budget > 100 ? budget : windowSeconds;\n}\n";
    const harness = await startHarness({
      name: "grounding",
      files: {
        "src/auth.ts": `${body}\nexport function issueAccessToken(subject: string): string {\n  return "at_" + subject.slice(0, 8);\n}\n`,
        "src/session.ts": "import { rotateRefreshToken } from \"./auth\";\n\nexport function renew(user: string): number {\n  return rotateRefreshToken(user);\n}\n",
      },
      edits: [],
    });
    const engine = createGraphEngine({ rootDir: harness.root, dbPath: harness.incrementalDb });
    let nodeId: string;
    try {
      nodeId = engine.searchNodes("rotateRefreshToken").find((node) => node.kind === "function")!.id;
    } finally {
      engine.close();
    }
    const grounding = withGroundingGraph(harness.root, harness.incrementalDb, (graph) => deriveGrounding(graph, nodeId))!;
    expect(grounding).not.toBeNull();

    await step(harness, {
      name: "move the grounded function",
      apply: all(
        replace("src/auth.ts", body, ""),
        write("src/tokens.ts", body),
        replace("src/session.ts", "from \"./auth\"", "from \"./tokens\""),
      ),
    }, "grounding move");

    const incremental = withGroundingGraph(harness.root, harness.incrementalDb, (graph) => resolveGrounding(grounding, graph));
    const full = withGroundingGraph(harness.root, harness.fullDb, (graph) => resolveGrounding(grounding, graph));
    expect(incremental).toEqual(full);
    expect(incremental).toMatchObject({ state: "fresh", rebound: true });
    const moved = withGroundingGraph(harness.root, harness.incrementalDb, (graph) =>
      graph.getNode((incremental as { resolvedNode: string }).resolvedNode));
    expect(moved?.filePath).toBe("src/tokens.ts");
  }, 240_000);
});

// A refresh whose re-extraction closure reaches past the budget costs more than
// a build, so it must publish through the full path and say why.
describe("incremental refresh falls back to a full extraction past the closure budget", () => {
  const HUB_FILES = 130;
  const hubFixture: Fixture = {
    name: "hub",
    files: {
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true }, include: ["src"] }),
      "package.json": JSON.stringify({ name: "fixture-hub", type: "module" }),
      "src/hub.ts": "export function hub(value: number): number {\n  return value + 1;\n}\n",
      ...Object.fromEntries(Array.from({ length: HUB_FILES }, (_, index) => [
        `src/user${index}.ts`,
        `import { hub } from "./hub";\n\nexport function use${index}(): number {\n  return hub(${index});\n}\n`,
      ])),
    },
    edits: [],
  };

  it("budgets 100 files up to 200 compiler files, then half of them", () => {
    expect(incrementalClosureBudget(10)).toBe(100);
    expect(incrementalClosureBudget(200)).toBe(100);
    expect(incrementalClosureBudget(1000)).toBe(500);
  });

  it("stays incremental below the budget, falls back above it, and matches a full build", async () => {
    const harness = await startHarness(hubFixture);
    const modeOf = (index: number): { mode?: string; fallbackReason?: string } | undefined =>
      (harness.results[index]!.incremental as BuildResult & { refresh?: { mode?: string; fallbackReason?: string } }).refresh;

    await step(harness, {
      name: "leaf body edit",
      apply: replace("src/user3.ts", "hub(3)", "hub(3) + 1"),
    }, "leaf edit");
    expect(modeOf(0)?.mode).toBe("incremental");

    await step(harness, {
      name: "hub signature change",
      apply: replace("src/hub.ts", "value: number): number", "value: number, extra = 0): string"),
    }, "hub signature edit");
    expect(modeOf(1)?.mode).toBe("full");
    expect(modeOf(1)?.fallbackReason).toMatch(/^the changed set reaches \d+ of 131 compiler files$/);
  }, 240_000);

  it("holds no previous cache payload when the fallback extraction starts", async () => {
    const harness = await startHarness(hubFixture);
    replace("src/hub.ts", "value: number): number", "value: number, extra = 0): string")(harness.root);
    const retained: number[] = [];
    const engine = createGraphEngine({
      rootDir: harness.root,
      dbPath: harness.incrementalDb,
      __internalRefreshStrategy: "incremental",
      __internalGraphEngineHooks: { beforeFullExtraction: (count: number) => retained.push(count) },
    } as Parameters<typeof createGraphEngine>[0]);
    try {
      const result = await engine.sync([]) as BuildResult & { refresh?: { mode?: string } };
      expect(result.refresh?.mode).toBe("full");
    } finally {
      engine.close();
    }
    expect(retained).toEqual([0]);
    await refresh(harness.root, harness.fullDb, "full");
    expectSameGraph(harness.incrementalDb, harness.fullDb, EXACT_TABLES, "fallback vs full build, cache rows included");
  }, 240_000);
});
