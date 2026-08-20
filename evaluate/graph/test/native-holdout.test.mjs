import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadGraphSuite } from "../../schemas/graph-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(HERE, "..", "..", "..");
const compare = JSON.parse(readFileSync(join(HARNESS_ROOT, "evaluate", "compare", "suites", "typescript.json"), "utf8"));
const native = loadGraphSuite(join(HARNESS_ROOT, "evaluate", "suites", "native", "graph", "typescript.json"));

test("native TypeScript holdout preserves the frozen questions and expected symbols", () => {
  assert.equal(native.subject.name, compare.subject.name);
  assert.equal(native.subject.repository, compare.subject.repository);
  assert.equal(native.subject.revision, compare.subject.revision);
  assert.deepEqual(native.tasks.map((task) => task.id), compare.tasks.map((task) => task.id));
  assert.deepEqual(native.tasks.map((task) => task.query), compare.tasks.map((task) => task.question));
  assert.deepEqual(
    native.tasks.map((task) => task.gold.map((evidence) => evidence.symbol)),
    compare.tasks.map((task) => task.expectedSymbols),
  );
  assert.equal(native.gates.floors.topFiveFileHitRate, 0.9);
  assert.equal(native.gates.floors.returnedRequiredSourceSpanRecall, 0.8);
});
