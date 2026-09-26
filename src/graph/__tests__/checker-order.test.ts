// ============================================================================
// Checker order independence (issue #209)
// ============================================================================
//
// An incremental refresh captures only the files a change can affect, so the
// checker visits fewer files, in a different order, than a full extraction.
// Every value the graph stores from the checker must therefore be a function
// of the code alone and never of the order files were visited in. Each tree
// here is built repeatedly with the checker visiting every project's files in
// a different seeded order; every derived table must come out identical.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGraphEngine } from "../engine-impl.js";
import { buildTypeScriptExtraction, type CompilerExtractionResult } from "../extraction/compiler.js";
import { diffGraphDumps, dumpGraphDatabase, type GraphDump } from "./graph-dump.js";
import {
  EXPRESS_FIXTURE, JS_FIXTURE, NESTJS_FIXTURE, NEXT_FIXTURE, ORDER_FIXTURE, random, TS_FIXTURE, writeTree,
  type Fixture,
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

type VisitOrder = (files: readonly string[]) => readonly string[];

function shuffled(seed: number): VisitOrder {
  return (files) => {
    const next = random(seed);
    const order = [...files];
    for (let index = order.length - 1; index > 0; index--) {
      const swap = Math.floor(next() * (index + 1));
      [order[index], order[swap]] = [order[swap]!, order[index]!];
    }
    return order;
  };
}

async function buildDump(root: string, visitOrder: VisitOrder): Promise<GraphDump> {
  const dbPath = join(tempDir("mex-checker-order-store-"), "graph.db");
  const engine = createGraphEngine({ rootDir: root, dbPath, compilerExtraction: { visitOrder } });
  try {
    await engine.build();
  } finally {
    engine.close();
  }
  return dumpGraphDatabase(dbPath);
}

const ORDERS: Array<[string, VisitOrder]> = [
  ["reversed", (files) => [...files].reverse()],
  ...[11, 29, 47, 83].map((seed): [string, VisitOrder] => [`seed ${seed}`, shuffled(seed)]),
];

describe("checker output is independent of file visit order", () => {
  for (const fixture of [ORDER_FIXTURE, TS_FIXTURE, JS_FIXTURE, EXPRESS_FIXTURE, NESTJS_FIXTURE, NEXT_FIXTURE] as Fixture[]) {
    it(`${fixture.name}: every derived table is identical in every visit order`, async () => {
      const root = tempDir(`mex-checker-order-${fixture.name}-`);
      writeTree(root, fixture.files);
      const baseline = await buildDump(root, (files) => files);
      for (const [label, order] of ORDERS) {
        await new Promise((resolve) => setImmediate(resolve));
        expect(diffGraphDumps(baseline, await buildDump(root, order)), `${fixture.name}: ${label}`).toEqual([]);
      }
    }, 240_000);
  }
});

function extract(root: string, options: Parameters<typeof buildTypeScriptExtraction>[2] = {}): CompilerExtractionResult {
  return buildTypeScriptExtraction(root, undefined, options);
}

/** Every stored fact of one extraction, keyed by file; reuse bookkeeping aside. */
function compilerFacts(result: CompilerExtractionResult): Map<string, string> {
  const captures = new Map(result.captures.map((capture) => [capture.filePath, capture]));
  return new Map(result.files.map((file) => [file.filePath, JSON.stringify({ file, capture: captures.get(file.filePath) })]));
}

// An incremental refresh captures an arbitrary subset of files from a fresh
// checker and reuses the rest. For any subset and any visit order, every
// file's facts must equal a full extraction's.
describe("partial capture is indistinguishable from a full extraction", () => {
  for (const fixture of [ORDER_FIXTURE, TS_FIXTURE, JS_FIXTURE, NESTJS_FIXTURE, NEXT_FIXTURE] as Fixture[]) {
    it(`${fixture.name}: any affected subset in any visit order reproduces every file`, async () => {
      const root = tempDir(`mex-checker-subset-${fixture.name}-`);
      writeTree(root, fixture.files);
      const full = extract(root);
      const baseline = compilerFacts(full);
      const previous = new Map(full.captures.map((capture) => [capture.filePath, capture]));
      const paths = [...previous.keys()];
      const seeds = fixture === ORDER_FIXTURE
        ? Array.from({ length: 40 }, (_, index) => 3 + index * 7)
        : [3, 5, 7, 13, 17, 19, 23, 31];
      for (const seed of seeds) {
        await new Promise((resolve) => setImmediate(resolve));
        const next = random(seed);
        const affected = new Set(paths.filter(() => next() < 0.35));
        const partial = extract(root, {
          incremental: { previous, affected, projectStates: full.projectStates },
          visitOrder: shuffled(seed),
        });
        const facts = compilerFacts(partial);
        const differing = paths.filter((path) => facts.get(path) !== baseline.get(path));
        expect(differing, `${fixture.name} seed ${seed} (affected: ${[...affected].join(", ")})`).toEqual([]);
      }
    }, 240_000);
  }
});
