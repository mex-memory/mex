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
import { afterEach, describe, expect, it } from "vitest";
import { createGraphEngine, GraphSourceStagingError, type GraphRefreshStrategy } from "../engine-impl.js";
import type { BuildResult } from "../engine.js";
import { openGraphDatabase } from "../db/database.js";
import { FingerprintStore } from "../fingerprint-store.js";
import { MinHashReconciler } from "../reconcile-engine.js";
import { createGroundingGraph, deriveGrounding, type GroundingGraph } from "../../wiki/grounding/adapter.js";
import { resolveGrounding } from "../../wiki/grounding/resolve.js";
import { diffGraphDumps, dumpGraphDatabase, type GraphDump } from "./graph-dump.js";
import {
  all, FIXTURES, PYTHON_FIXTURE, random, replace, TS_FIXTURE, write, writeTree,
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
    const [comment, rename, , addFile] = TS_FIXTURE.edits;
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
