import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { graphEngineBinary } from "../native-engine.js";
import { detectLanguage } from "../extraction/grammars.js";
import { isEcmaScriptLanguage } from "../engine-languages.js";
import { stageEcmaScript } from "./engine-stage-fixture.js";
import {
  EXPRESS_FIXTURE, JS_FIXTURE, NESTJS_FIXTURE, NEXT_FIXTURE, ORDER_FIXTURE, random, TS_FIXTURE, writeTree,
  type Fixture,
} from "./refresh-fixtures.js";

const engine = graphEngineBinary();
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

const ORDERS: Array<[string, VisitOrder]> = [
  ["reversed", (files) => [...files].reverse()],
  ...[11, 29, 47, 83].map((seed): [string, VisitOrder] => [`seed ${seed}`, shuffled(seed)]),
];

describe.skipIf(!engine)("engine stage order", () => {
  for (const fixture of [ORDER_FIXTURE, TS_FIXTURE, JS_FIXTURE, EXPRESS_FIXTURE, NESTJS_FIXTURE, NEXT_FIXTURE] as Fixture[]) {
    it(`${fixture.name}: every staged fact is identical across visit orders and thread counts`, async () => {
      const root = tempDir(`mex-engine-order-${fixture.name}-`);
      writeTree(root, fixture.files);
      const paths = Object.keys(fixture.files).filter(path => isEcmaScriptLanguage(detectLanguage(path))).sort();
      const sorted = async (ordered: readonly string[], threads: number) => {
        const result = await stageEcmaScript(engine!, root, ordered, threads);
        return result.files
          .sort((left, right) => left.path.localeCompare(right.path))
          .map(({ nodes, edges, unresolved, imports, ...file }) => ({
            ...file,
            nodes: nodes.map(node => JSON.stringify(node)).sort(),
            edges: edges.map(edge => JSON.stringify(edge)).sort(),
            unresolved: unresolved.map(ref => JSON.stringify(ref)).sort(),
            imports: imports?.map(binding => JSON.stringify(binding)).sort(),
          }));
      };
      const baseline = await sorted(paths, 1);
      for (const [label, order] of ORDERS) {
        expect(await sorted(order(paths), 4), `${fixture.name}: ${label}`).toEqual(baseline);
      }
    });
  }
});
