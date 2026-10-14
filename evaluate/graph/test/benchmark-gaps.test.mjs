import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { repositoryIdentity } from "../../core/hash.mjs";
import { gradeRetrieval } from "../../graders/retrieval.mjs";
import { inspectGraphDatabase } from "../lib/integrity.mjs";
import { inspectGoldCoverage } from "../lib/coverage.mjs";

test("64-bit LSH hashes remain exact and deterministic in integrity reads", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-eval-bigint-"));
  const path = join(root, "graph.db");
  try {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE lsh_buckets (band INTEGER, band_hash INTEGER, node_id TEXT)");
    db.prepare("INSERT INTO lsh_buckets VALUES (0, ?, 'function:a')").run(9223372036854775807n);
    db.close();
    const first = inspectGraphDatabase(path);
    assert.equal(first.normalizedGraphSha256, inspectGraphDatabase(path).normalizedGraphSha256);
    const edit = new DatabaseSync(path);
    edit.prepare("UPDATE lsh_buckets SET band_hash = ?").run(9223372036854775806n);
    edit.close();
    assert.notEqual(first.normalizedGraphSha256, inspectGraphDatabase(path).normalizedGraphSha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("production specs services are not mislabeled as test directories", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-eval-specs-"));
  try {
    const path = join(root, "graph.db");
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE nodes (id TEXT, file_path TEXT);
      CREATE TABLE edges (source TEXT, target TEXT, kind TEXT);
      INSERT INTO nodes VALUES ('a', 'src/cli.ts'), ('b', 'src/team/specs/service.ts'), ('c', 'test/unit.ts');
      INSERT INTO edges VALUES ('a', 'b', 'calls'), ('a', 'c', 'calls');`);
    db.close();
    const result = inspectGraphDatabase(path);
    assert.equal(result.suspiciousProductionToTestEdges, 1);
    assert.equal(result.suspiciousProductionToTestEdgeSamples[0].target, "c");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const task = { operation: "scope", gold: [{ symbol: "Target", path: "src/a.ts", startLine: 4, endLine: 6 }] };
const coverage = { evidence: [{ ...task.gold[0], covered: true, matches: [{ id: "function:target", startLine: 4, endLine: 6 }] }] };
const source = (filePath, nodeIds, startLine = 1, endLine = 8) => ({ type: "source", filePath, ranges: [{ startLine, endLine, nodeIds }] });

test("source-only symbols use exact graph ids and retain preceding misses in rank", () => {
  const result = gradeRetrieval(task, [source("src/a.ts", ["function:noise", "function:target", "function:target"])], {}, coverage);
  assert.equal(result.goldRanks[0].rank, 2);
  assert.equal(result.reciprocalRank, 0.5);
});

test("source-only ranking does not guess from prose, wrong paths, missing coverage or unrelated spans", () => {
  for (const [records, prepared] of [
    [[source("src/b.ts", ["function:target"])], coverage],
    [[source("src/a.ts", ["function:target"], 20, 25)], coverage],
    [[source("src/a.ts", ["function:target"])], null],
    [[{ ...source("src/a.ts", ["function:noise"]), content: "function Target() {}" }], coverage],
  ]) assert.equal(gradeRetrieval(task, records, {}, prepared).goldRanks[0].rank, null);
});

test("fact/source duplicate nodes keep the existing fact rank", () => {
  const result = gradeRetrieval(task, [
    { type: "fact", id: "function:target", name: "Target", filePath: "src/a.ts", startLine: 4, endLine: 6 },
    source("src/a.ts", ["function:target"]),
  ], {}, coverage);
  assert.equal(result.goldRanks[0].rank, 1);
});

test("source-only alternate and prohibited ids are graded without changing the gold denominator", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-eval-selectors-"));
  try {
    const path = join(root, "graph.db");
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE nodes (id TEXT, name TEXT, qualified_name TEXT, file_path TEXT, kind TEXT, start_line INTEGER, end_line INTEGER);
      INSERT INTO nodes VALUES ('function:target', 'Target', 'Target', 'src/a.ts', 'function', 4, 6),
        ('function:alternate', 'Alternate', 'Alternate', 'src/a.ts', 'function', 8, 9),
        ('function:prohibited', 'Prohibited', 'Prohibited', 'src/a.ts', 'function', 11, 12);`);
    db.close();
    const fixture = { ...task, id: "selectors",
      acceptableAlternates: [{ symbol: "Alternate", path: "src/a.ts", startLine: 8, endLine: 9 }],
      mustNotReturn: [{ symbol: "Prohibited", path: "src/a.ts", startLine: 11, endLine: 12 }] };
    const prepared = inspectGoldCoverage(path, [fixture]).tasks[0];
    assert.equal(prepared.totalEvidence, 1);
    const result = gradeRetrieval(fixture, [source("src/a.ts", ["function:alternate", "function:prohibited"], 8, 12)], {}, prepared);
    assert.equal(result.alternateRanks[0].rank, 1);
    assert.equal(result.prohibitedRanks[0].rank, 2);
    assert.equal(result.prohibitedHit, true);
    assert.equal(result.graphCoveredGold, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("synthetic first-build protection is ignored while canonical knowledge still changes identity", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-eval-identity-"));
  try {
    writeFileSync(join(root, "subject.ts"), "export const x = 1;");
    const before = repositoryIdentity(root).treeStateSha256;
    mkdirSync(join(root, ".mex"));
    writeFileSync(join(root, ".mex/.gitignore"), "graph.db*\nwiki.db*\nlocal/\n");
    writeFileSync(join(root, ".mex/graph.db"), "generated");
    assert.equal(repositoryIdentity(root).treeStateSha256, before);
    writeFileSync(join(root, ".mex/AGENTS.md"), "canonical knowledge");
    assert.notEqual(repositoryIdentity(root).treeStateSha256, before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
