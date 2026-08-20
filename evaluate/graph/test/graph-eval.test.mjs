import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertGraphOutputIsolation, restoreGraphDbAndRemoveScratch } from "../../core/artifacts.mjs";
import { commandBundleIdentity, repositoryIdentity } from "../../core/hash.mjs";
import { parseJsonLines, validateGraphResponse } from "../../core/jsonl.mjs";
import { gradeRetrieval, summarizeRetrievalRows } from "../../graders/retrieval.mjs";
import { graphTaskArgs, loadGraphSuite, validateGraphSuite } from "../../schemas/graph-suite.mjs";
import { validateEvidenceInSource } from "../lib/fixture.mjs";
import { inspectGoldCoverage } from "../lib/coverage.mjs";
import { inspectGraphDatabase } from "../lib/integrity.mjs";
import { prepareGraphEvaluation } from "../lib/prepare.mjs";
import { generateGraphReport } from "../lib/report.mjs";
import { runGraphEvaluation } from "../lib/runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const HARNESS_ROOT = resolve(HERE, "..", "..", "..");
const FAKE = join(HERE, "fixtures", "fake-graph.mjs");

function rawSuite(tasks) {
  return {
    schemaVersion: 2,
    id: "fake-suite",
    subject: { name: "fake" },
    determinismRebuilds: 2,
    systems: { fake: { role: "candidate", command: [process.execPath, FAKE] } },
    tasks,
    gates: { floors: { budgetComplianceRate: 1 }, ceilings: { invalidRuns: 0 } },
  };
}

function positiveTask() {
  return {
    id: "target",
    category: "natural-language-symbol",
    operation: "scope",
    query: "Where is the target behavior?",
    gold: [{ symbol: "TargetSymbol", kind: "function", path: "src/subject.ts" }],
  };
}

function fixture(gates = null) {
  const subjectRoot = mkdtempSync(join(tmpdir(), "mex-graph-subject-"));
  mkdirSync(join(subjectRoot, "src"), { recursive: true });
  writeFileSync(join(subjectRoot, "src", "subject.ts"), "export function TargetSymbol() {}\nexport function OtherSymbol() {}\n");
  const suitePath = join(subjectRoot, "suite.json");
  const suite = rawSuite([positiveTask()]);
  if (gates) suite.gates = gates;
  writeFileSync(suitePath, `${JSON.stringify(suite, null, 2)}\n`);
  return { subjectRoot, suite: loadGraphSuite(suitePath), outputDir: mkdtempSync(join(tmpdir(), "mex-graph-output-")) };
}

test("suite schema rejects empty, duplicate, and underspecified task fixtures", () => {
  assert.throws(() => validateGraphSuite(rawSuite([])), /tasks must be non-empty/);
  const duplicate = rawSuite([positiveTask(), positiveTask()]);
  assert.throws(() => validateGraphSuite(duplicate), /duplicated/);
  const noGold = rawSuite([{ id: "bad", category: "scope", operation: "scope", query: "x", gold: [] }]);
  assert.throws(() => validateGraphSuite(noGold), /at least 1 evidence/);
});

test("suite scope options validate and forward maxFiles", () => {
  const task = { ...positiveTask(), options: { maxFiles: 7 } };
  assert.doesNotThrow(() => validateGraphSuite(rawSuite([task])));
  assert.deepEqual(graphTaskArgs(task).slice(-2), ["--max-files", "7"]);
  assert.throws(() => validateGraphSuite(rawSuite([{ ...positiveTask(), options: { maxFiles: 0 } }])), /positive integer/);
});

test("suite integrity thresholds must be finite numeric metric maps", () => {
  const nonfinite = rawSuite([positiveTask()]);
  nonfinite.gates.integrityFloors = { nodes: Number.NaN };
  assert.throws(() => validateGraphSuite(nonfinite), /gates\.integrityFloors\.nodes must be a finite number/);

  const wrongShape = rawSuite([positiveTask()]);
  wrongShape.gates.integrityCeilings = [];
  assert.throws(() => validateGraphSuite(wrongShape), /gates\.integrityCeilings must be an object/);
});

test("v2 integrity hashing includes semantic metadata but ignores timestamps", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-integrity-v2-"));
  const path = join(root, "graph.db");
  const db = new DatabaseSync(path);
  db.exec(readFileSync(join(HARNESS_ROOT, "src", "graph", "schema.sql"), "utf8"));
  db.prepare(`INSERT INTO files (
    path, content_hash, language, size, modified_at, indexed_at, node_count, errors,
    parse_status, diagnostic_count, missing_count, error_coverage, extractor_version
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "src/a.ts", "file-hash", "typescript", 100, 1, 2, 1, "[]", "partial", 2, 1, 0.1, "typescript-5.9.3",
  );
  db.prepare(`INSERT INTO nodes (
    id, kind, name, qualified_name, container_id, identity_key, file_path, language,
    start_line, end_line, start_column, end_column, body_hash, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "node:a", "function", "a", "a", null, "identity:a", "src/a.ts", "typescript", 1, 3, 0, 1, "body", 3,
  );
  db.prepare(`INSERT INTO edges (
    source, target, kind, line, col, provenance, confidence, resolution_method, evidence
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "node:a", "node:a", "calls", 2, 1, "compiler", 0.85, "typescript-symbol", "{\"site\":\"direct\"}",
  );
  db.prepare(`INSERT INTO unresolved_refs (
    ref_key, from_node_id, reference_name, reference_kind, line, col, file_path, language,
    status, target_id, confidence, resolver
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "ref:a", "node:a", "a", "calls", 2, 1, "src/a.ts", "typescript", "resolved", "node:a", 1, "typescript-symbol",
  );
  db.prepare(`INSERT INTO import_bindings (
    binding_key, file_path, local_name, imported_name, module_specifier, resolved_file_path, target_id, is_type_only
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "binding:a", "src/a.ts", "a", "a", "./a", "src/a.ts", "node:a", 0,
  );
  db.prepare("INSERT INTO node_aliases VALUES (?, ?, ?, ?, ?)").run("old:a", "node:a", "qualified-name", 1, 4);
  db.prepare(`INSERT INTO source_chunks (
    file_path, start_line, end_line, content_hash, path_terms, identifier_terms, comment_terms
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("src/a.ts", 1, 3, "file-hash", "src a ts", "a", "");
  db.prepare(`INSERT INTO source_chunks_fts (
    rowid, path_terms, identifier_terms, comment_terms, source_text
  ) VALUES (?, ?, ?, ?, ?)`).run(1, "src a ts", "a", "", "function a() {}");
  db.prepare("INSERT INTO project_metadata VALUES (?, ?, ?)").run("compiler_version", "5.9.3", 5);
  db.close();

  const first = inspectGraphDatabase(path, { nodesCreated: 1 });
  assert.equal(first.schemaVersion, 2);
  assert.deepEqual(first.parseStatusCounts, { partial: 1 });
  assert.equal(first.totalDiagnostics, 2);
  assert.equal(first.resolvedReferences, 1);
  assert.equal(first.unresolvedReferences, 0);
  assert.equal(first.traversableEdges, 1);
  assert.deepEqual(first.edgeProvenance, { compiler: 1 });
  assert.equal(first.sourceChunkFtsRowDelta, 0);
  assert.equal(first.danglingAliases, 0);

  const timestamps = new DatabaseSync(path);
  timestamps.exec("UPDATE files SET modified_at = 100, indexed_at = 200; UPDATE nodes SET updated_at = 300; UPDATE project_metadata SET updated_at = 400; UPDATE node_aliases SET created_at = 500");
  timestamps.close();
  assert.equal(inspectGraphDatabase(path).normalizedGraphSha256, first.normalizedGraphSha256);

  const semantic = new DatabaseSync(path);
  semantic.exec("UPDATE edges SET confidence = 0.75");
  semantic.close();
  const changed = inspectGraphDatabase(path);
  assert.notEqual(changed.normalizedGraphSha256, first.normalizedGraphSha256);
  assert.equal(changed.belowFlowThresholdEdges, 1);
});

test("production-to-test integrity permits proven callback wiring but rejects unsupported edges", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-prod-test-"));
  const path = join(root, "graph.db");
  const db = new DatabaseSync(path);
  db.exec(readFileSync(join(HARNESS_ROOT, "src", "graph", "schema.sql"), "utf8"));
  const insertFile = db.prepare(`INSERT INTO files (
    path, content_hash, language, size, modified_at, indexed_at, node_count
  ) VALUES (?, ?, 'typescript', 1, 1, 1, ?)`);
  insertFile.run("src/subject.ts", "prod", 1);
  insertFile.run("src/subject.test.ts", "test", 2);
  const insertNode = db.prepare(`INSERT INTO nodes (
    id, kind, name, qualified_name, identity_key, file_path, language,
    start_line, end_line, start_column, end_column, updated_at
  ) VALUES (?, 'function', ?, ?, ?, ?, 'typescript', 1, 1, 0, 1, 1)`);
  insertNode.run("prod", "invoke", "invoke", "identity:prod", "src/subject.ts");
  insertNode.run("callback", "<callback:invoke[0]>", "test::<callback:invoke[0]>", "identity:callback", "src/subject.test.ts");
  insertNode.run("unsupported", "unrelated", "test::unrelated", "identity:unsupported", "src/subject.test.ts");
  db.prepare(`INSERT INTO edges (
    source, target, kind, line, col, provenance, confidence, resolution_method, evidence
  ) VALUES ('prod', 'callback', 'calls', 10, 1, 'callback-synthesis', 0.85, 'typescript-callback-parameter', ?)`)
    .run(JSON.stringify([{ argumentIndex: 0, parameterName: "callback", wiringSite: "invoke(() => work())" }]));
  db.prepare(`INSERT INTO edges (
    source, target, kind, line, col, provenance, confidence, resolution_method, evidence
  ) VALUES ('prod', 'unsupported', 'calls', 11, 1, 'typescript-compiler', 1, 'typescript-symbol', '[]')`).run();
  db.close();
  const integrity = inspectGraphDatabase(path);
  assert.equal(integrity.suspiciousProductionToTestEdges, 1);
  assert.equal(integrity.suspiciousProductionToTestEdgeSamples[0].target, "unsupported");
});

test("graph outputs cannot place source artifacts in the indexed subject", () => {
  const root = resolve(tmpdir(), "subject");
  assert.throws(() => assertGraphOutputIsolation(root, join(root, "evaluate", "results", "run")), /not scanner-isolated/);
  assert.doesNotThrow(() => assertGraphOutputIsolation(root, join(root, ".mex", "eval-results", "run")));
  assert.doesNotThrow(() => assertGraphOutputIsolation(root, resolve(tmpdir(), "separate-output")));
});

test("CLI provenance recognizes PATH-resolved Node launchers", () => {
  const identity = commandBundleIdentity(["node", FAKE]);
  assert.equal(identity.entrypoint, FAKE);
  assert.match(identity.bundleSha256, /^[a-f0-9]{64}$/);
});

test("repository identity ignores only GraphDbGuard artifacts in repositories that do not ignore .mex", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-identity-graph-db-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "subject.ts"), "export const subject = true;\n");
  for (const args of [["init", "-q"], ["config", "user.email", "eval@example.invalid"], ["config", "user.name", "Eval Test"], ["add", "src/subject.ts"], ["commit", "-qm", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }

  const baseline = repositoryIdentity(root).treeStateSha256;
  mkdirSync(join(root, ".mex"), { recursive: true });
  for (const name of ["graph.db", "graph.db-shm", "graph.db-wal"]) {
    writeFileSync(join(root, ".mex", name), `generated-${name}`);
  }
  assert.equal(repositoryIdentity(root).treeStateSha256, baseline);

  writeFileSync(join(root, ".mex", "other-generated.txt"), "must remain visible");
  assert.notEqual(repositoryIdentity(root).treeStateSha256, baseline);
});

test("graph restore cleanup retains recovery scratch when restore throws", () => {
  const scratch = mkdtempSync(join(tmpdir(), "mex-graph-restore-scratch-"));
  const backup = join(scratch, "original.graph.db");
  writeFileSync(backup, "recoverable");
  try {
    assert.throws(() => restoreGraphDbAndRemoveScratch({
      restore() { throw new Error("restore failed"); },
    }, scratch), /restore failed/);
    assert.equal(readFileSync(backup, "utf8"), "recoverable");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("source evidence validation rejects stale, escaping, and ambiguous declarations", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-gold-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export function Same() {}\nexport function Same() {}\n");
  assert.throws(() => validateEvidenceInSource(root, { symbol: "Missing", kind: "function", path: "src/a.ts" }), /was not found/);
  assert.throws(() => validateEvidenceInSource(root, { symbol: "Same", kind: "function", path: "src/a.ts" }), /ambiguous/);
  assert.throws(() => validateEvidenceInSource(root, { symbol: "Same", kind: "function", path: "../outside.ts" }), /escapes/);
});

test("retrieval grading keys on symbol, path, and source span while treating kind as advisory", () => {
  const task = {
    ...positiveTask(),
    gold: [
      { symbol: "TargetSymbol", kind: "function", path: "src/subject.ts" },
      { symbol: "SecondSymbol", kind: "class", path: "src/second.ts" },
    ],
  };
  const wrongSubstring = { type: "fact", name: "TargetSymbolHelper", kind: "function", filePath: "src/subject.ts" };
  const wrongSpan = { type: "fact", name: "TargetSymbol", kind: "class", filePath: "src/subject.ts", startLine: 20, endLine: 30 };
  const exact = { type: "fact", name: "TargetSymbol", kind: "class", filePath: "src/subject.ts", startLine: 1, endLine: 2 };
  task.gold[0].startLine = 1;
  task.gold[0].endLine = 1;
  const metrics = gradeRetrieval(task, [wrongSubstring, wrongSpan, exact], { stdout: "x", elapsedMs: 1 });
  assert.equal(metrics.goldRanks[0].rank, 3);
  assert.equal(metrics.goldRanks[1].rank, null);
  assert.equal(metrics.completeEvidence, false);
  const rows = [
    { valid: true, task, metrics },
    { valid: true, task, metrics: { ...metrics, reciprocalRank: 0, goldRanks: metrics.goldRanks.map((entry) => ({ ...entry, rank: null })) } },
  ];
  assert.equal(summarizeRetrievalRows(rows).mrr, 0.1666);
});

test("first-response file and source aggregates apply only to source-bearing Scope", () => {
  const evidence = [{ ...positiveTask().gold[0], startLine: 1, endLine: 1 }];
  const scopeTask = { ...positiveTask(), operation: "scope", gold: evidence };
  const queryTask = { ...positiveTask(), id: "query", operation: "query", relation: "where-defined", gold: evidence };
  const covered = gradeRetrieval(scopeTask, [
    { type: "fact", name: "TargetSymbol", filePath: "src/subject.ts", startLine: 1, endLine: 1 },
    { type: "source", filePath: "src/subject.ts", ranges: [{ startLine: 1, endLine: 1, content: "x" }] },
  ]);
  const intentionallySourceless = gradeRetrieval(queryTask, [
    { type: "fact", name: "TargetSymbol", filePath: "src/subject.ts", startLine: 1, endLine: 1 },
  ]);
  const summary = summarizeRetrievalRows([
    { valid: true, task: scopeTask, metrics: covered },
    { valid: true, task: queryTask, metrics: intentionallySourceless },
  ]);
  assert.equal(summary.topFiveFileHitRate, 1);
  assert.equal(summary.returnedRequiredSourceSpanRecall, 1);
});

test("source-span grading unions adjacent ranges on one path but rejects a line gap", () => {
  const task = {
    ...positiveTask(),
    gold: [{ ...positiveTask().gold[0], startLine: 10, endLine: 20 }],
  };
  const adjacent = gradeRetrieval(task, [
    { type: "source", filePath: "src/subject.ts", ranges: [{ startLine: 10, endLine: 14 }] },
    { type: "source", filePath: "./src/subject.ts", ranges: [{ startLine: 15, endLine: 20 }] },
  ]);
  assert.equal(adjacent.returnedSourceSpanRecall, 1);
  assert.equal(adjacent.sourceSpans[0].covered, true);

  const gapped = gradeRetrieval(task, [
    { type: "source", filePath: "src/subject.ts", ranges: [{ startLine: 10, endLine: 14 }] },
    { type: "source", filePath: "src/other.ts", ranges: [{ startLine: 15, endLine: 15 }] },
    { type: "source", filePath: "src/subject.ts", ranges: [{ startLine: 16, endLine: 20 }] },
  ]);
  assert.equal(gapped.returnedSourceSpanRecall, 0);
  assert.equal(gapped.sourceSpans[0].covered, false);
});

test("first-response grading measures file rank, source spans, and protocol-v3 directed flow", () => {
  const task = {
    ...positiveTask(),
    gold: [
      { symbol: "Caller", path: "src/a.ts", startLine: 10, endLine: 20 },
      { symbol: "Callee", path: "src/b.ts", startLine: 30, endLine: 35 },
    ],
    requiredFlows: [
      { from: { symbol: "Caller", path: "src/a.ts" }, to: { symbol: "Callee", path: "src/b.ts" }, kinds: ["calls"] },
      { from: { symbol: "Callee", path: "src/b.ts" }, to: { symbol: "Caller", path: "src/a.ts" }, kinds: ["calls"] },
    ],
  };
  const records = [
    { type: "fact", id: "other", name: "Other", filePath: "src/other.ts", startLine: 1, endLine: 2 },
    { type: "fact", id: "caller", name: "Caller", kind: "method", filePath: "src/a.ts", startLine: 10, endLine: 20 },
    { type: "fact", id: "callee", name: "Callee", kind: "variable", filePath: "src/b.ts", startLine: 30, endLine: 35 },
    { type: "flow", steps: [{ source: "caller", target: "callee", kind: "calls", confidence: 1 }] },
    { type: "source", filePath: "src/a.ts", ranges: [{ startLine: 8, endLine: 22, content: "..." }] },
    { type: "source", filePath: "src/b.ts", ranges: [{ startLine: 32, endLine: 40, content: "..." }] },
  ];
  const metrics = gradeRetrieval(task, records, { stdout: records.map(JSON.stringify).join("\n") });
  assert.equal(metrics.firstRelevantFileRank, 2);
  assert.equal(metrics.fileHitAt5, true);
  assert.equal(metrics.returnedSourceSpanRecall, 0.5);
  assert.deepEqual(metrics.requiredFlows.map((flow) => flow.covered), [true, false]);
  assert.equal(metrics.directedFlowCoverage, 0.5);
});

test("first-response flow grading retains legacy edge and ordered-step support", () => {
  const task = {
    ...positiveTask(),
    gold: [
      { symbol: "Caller", path: "src/a.ts" },
      { symbol: "Callee", path: "src/b.ts" },
    ],
    requiredFlows: [{ from: { symbol: "Caller", path: "src/a.ts" }, to: { symbol: "Callee", path: "src/b.ts" }, kinds: ["calls"] }],
  };
  const nodes = [
    { type: "fact", id: "caller", name: "Caller", filePath: "src/a.ts" },
    { type: "fact", id: "callee", name: "Callee", filePath: "src/b.ts" },
  ];
  assert.equal(gradeRetrieval(task, [...nodes, { type: "edge", source: "caller", target: "callee", kind: "calls" }]).directedFlowCoverage, 1);
  const orderedTask = { ...task, requiredFlows: [{ ...task.requiredFlows[0], kinds: ["flow"] }] };
  assert.equal(gradeRetrieval(orderedTask, [...nodes, { type: "flow", steps: ["caller", "callee"] }]).directedFlowCoverage, 1);
});

test("protocol-v3 flow endpoint metadata grades without budget-dependent fact records", () => {
  const task = {
    ...positiveTask(),
    gold: [
      { symbol: "Caller", path: "src/a.ts" },
      { symbol: "Callee", path: "src/b.ts" },
    ],
    requiredFlows: [{ from: { symbol: "Caller", path: "src/a.ts" }, to: { symbol: "Callee", path: "src/b.ts" }, kinds: ["calls"] }],
  };
  const records = [{
    type: "flow",
    nodes: [
      { id: "caller", name: "Caller", qualifiedName: "App::Caller", filePath: "src/a.ts" },
      { id: "callee", name: "Callee", qualifiedName: "App::Callee", filePath: "src/b.ts" },
    ],
    steps: [{ source: "caller", target: "callee", kind: "calls", confidence: 1 }],
  }];
  assert.equal(gradeRetrieval(task, records).directedFlowCoverage, 1);
});

test("directed-flow grading permits one transparent anonymous callback containment bridge", () => {
  const task = {
    ...positiveTask(),
    gold: [
      { symbol: "outer", path: "src/a.ts" },
      { symbol: "target", path: "src/b.ts" },
    ],
    requiredFlows: [{ from: { symbol: "outer", path: "src/a.ts" }, to: { symbol: "target", path: "src/b.ts" }, kinds: ["calls"] }],
  };
  const records = [{
    type: "flow",
    nodes: [
      { id: "outer", name: "outer", filePath: "src/a.ts" },
      { id: "callback", name: "<callback:ReturnStatement>", filePath: "src/a.ts" },
      { id: "target", name: "target", filePath: "src/b.ts" },
    ],
    steps: [
      { source: "outer", target: "callback", kind: "contains", confidence: 1 },
      { source: "callback", target: "target", kind: "calls", confidence: 1 },
    ],
  }];
  assert.equal(gradeRetrieval(task, records).directedFlowCoverage, 1);
});

test("construction coverage recognizes a bounded callback-mediated directed path", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-flow-coverage-"));
  const path = join(root, "graph.db");
  const db = new DatabaseSync(path);
  db.exec(readFileSync(join(HARNESS_ROOT, "src", "graph", "schema.sql"), "utf8"));
  const insertNode = db.prepare(`INSERT INTO nodes (
    id, kind, name, qualified_name, identity_key, file_path, language,
    start_line, end_line, start_column, end_column, updated_at
  ) VALUES (?, 'function', ?, ?, ?, ?, 'typescript', ?, ?, 0, 1, 1)`);
  insertNode.run("outer", "outer", "outer", "identity:outer", "src/a.ts", 1, 10);
  insertNode.run("callback", "<callback:ReturnStatement>", "outer::<callback:ReturnStatement>", "identity:callback", "src/a.ts", 2, 9);
  insertNode.run("target", "target", "target", "identity:target", "src/b.ts", 1, 2);
  db.prepare("INSERT INTO edges (source, target, kind, confidence) VALUES (?, ?, ?, 1)").run("outer", "callback", "contains");
  db.prepare("INSERT INTO edges (source, target, kind, confidence) VALUES (?, ?, ?, 1)").run("callback", "target", "calls");
  db.close();
  const task = {
    id: "callback-flow",
    gold: [
      { symbol: "outer", path: "src/a.ts" },
      { symbol: "target", path: "src/b.ts" },
    ],
    requiredFlows: [{ from: { symbol: "outer", path: "src/a.ts" }, to: { symbol: "target", path: "src/b.ts" }, kinds: ["calls"] }],
  };
  const coverage = inspectGoldCoverage(path, [task]);
  assert.equal(coverage.directedFlowCoverage, 1);
  assert.deepEqual(coverage.tasks[0].requiredFlows[0].paths[0].map((edge) => edge.kind), ["contains", "calls"]);
});

test("construction misses are reported separately and excluded from retrieval recall", () => {
  const task = {
    ...positiveTask(),
    gold: [
      { symbol: "Present", path: "src/a.ts", startLine: 1, endLine: 2 },
      { symbol: "LostDuringBuild", path: "src/b.ts", startLine: 4, endLine: 5 },
    ],
  };
  const coverage = {
    evidenceCoverage: 0.5,
    evidence: [
      { symbol: "Present", path: "src/a.ts", startLine: 1, endLine: 2, covered: true },
      { symbol: "LostDuringBuild", path: "src/b.ts", startLine: 4, endLine: 5, covered: false },
    ],
  };
  const metrics = gradeRetrieval(task, [{ type: "fact", name: "Present", filePath: "src/a.ts", startLine: 1, endLine: 2 }], {}, coverage);
  assert.equal(metrics.goldCount, 1);
  assert.equal(metrics.recallAt1, 1);
  assert.equal(metrics.constructionMissingGold.length, 1);
  assert.equal(metrics.graphEvidenceCoverage, 0.5);
});

test("negative error codes are an allowlist, not a required response shape", () => {
  const task = {
    id: "negative",
    category: "negative",
    operation: "query",
    relation: "where-defined",
    query: "Missing",
    gold: [],
    expect: { noResult: true, errorCodes: ["TARGET_NOT_FOUND"] },
  };
  const notFound = gradeRetrieval(task, [{ type: "not-found", target: "Missing" }], { stdout: "", elapsedMs: 1 });
  assert.equal(notFound.errorExpectationMet, true);
  assert.equal(notFound.noResultCorrect, true);
  const allowedError = gradeRetrieval(task, [{ type: "error", code: "TARGET_NOT_FOUND" }], { stdout: "", elapsedMs: 1 });
  assert.equal(allowedError.noResultCorrect, true);
  const irrelevantFacts = gradeRetrieval(task, [{ type: "result", name: "Other", kind: "function", filePath: "src/other.ts" }], { stdout: "", elapsedMs: 1 });
  assert.equal(irrelevantFacts.noResultCorrect, false);
  const wrongError = gradeRetrieval(task, [{ type: "error", code: "INTERNAL_ERROR" }], { stdout: "", elapsedMs: 1 });
  assert.equal(wrongError.errorExpectationMet, false);
});

test("JSONL validation rejects malformed, empty, and structured-error success", () => {
  assert.match(parseJsonLines("not-json\n").errors.join("\n"), /malformed/);
  assert.match(parseJsonLines("").errors.join("\n"), /empty/);
  const records = [{ type: "meta", command: "graph scope" }, { type: "error", code: "BROKEN" }, { type: "summary" }];
  assert.match(validateGraphResponse(records, "graph scope").join("\n"), /error record/);
});

test("prepared runs capture graph loss and successful exact retrieval", { concurrency: false }, async () => {
  const { subjectRoot, suite, outputDir } = fixture();
  const commands = { fake: [process.execPath, FAKE] };
  const prepared = prepareGraphEvaluation({ suite, subjectRoot, harnessRoot: HARNESS_ROOT, outputDir, systemCommands: commands });
  assert.equal(prepared.systems.fake.deterministic, true);
  assert.equal(prepared.systems.fake.rebuilds[0].integrity.extractedToStoredLoss, 1);
  assert.equal(prepared.systems.fake.goldCoverage.evidenceCoverage, 1);
  const result = await runGraphEvaluation({ suite, subjectRoot, outputDir, systemCommands: commands, timeoutMs: 2_000 });
  assert.equal(result.rows[0].valid, true);
  assert.equal(result.rows[0].metrics.recallAt1, 1);
  const report = generateGraphReport({ suite, outputDir, suppliedRows: result.rows });
  assert.equal(report.gate.passed, true);
  assert.equal(readFileSync(join(outputDir, "raw", "queries", "001-target--fake.stdout.jsonl"), "utf8").includes("TargetSymbol"), true);
});

test("native identity checks ignore the owned graph swap for a subject nested below the harness", { concurrency: false }, async () => {
  const harnessRoot = mkdtempSync(join(tmpdir(), "mex-graph-nested-harness-"));
  const subjectRoot = join(harnessRoot, "fixtures", "subject");
  mkdirSync(join(subjectRoot, "src"), { recursive: true });
  writeFileSync(join(subjectRoot, "src", "subject.ts"), "export function TargetSymbol() {}\n");
  const suitePath = join(subjectRoot, "suite.json");
  writeFileSync(suitePath, `${JSON.stringify(rawSuite([positiveTask()]), null, 2)}\n`);
  const suite = loadGraphSuite(suitePath);
  const outputDir = mkdtempSync(join(tmpdir(), "mex-graph-nested-output-"));
  const commands = { fake: [process.execPath, FAKE] };

  prepareGraphEvaluation({ suite, subjectRoot, harnessRoot, outputDir, systemCommands: commands });
  const result = await runGraphEvaluation({ suite, subjectRoot, outputDir, systemCommands: commands, timeoutMs: 2_000 });

  assert.equal(result.manifest.status, "complete");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].valid, true);
  assert.equal(existsSync(join(subjectRoot, ".mex", "graph.db")), false);
});

test("integrity gates use the final rebuild and fail closed for exceeded, missing, and non-finite metrics", { concurrency: false }, async () => {
  const gates = {
    floors: { budgetComplianceRate: 1 },
    ceilings: { invalidRuns: 0 },
    integrityFloors: { nodes: 1 },
    integrityCeilings: { extractedToStoredLoss: 1 },
  };
  const { subjectRoot, suite, outputDir } = fixture(gates);
  const commands = { fake: [process.execPath, FAKE] };
  prepareGraphEvaluation({ suite, subjectRoot, harnessRoot: HARNESS_ROOT, outputDir, systemCommands: commands });
  const result = await runGraphEvaluation({ suite, subjectRoot, outputDir, systemCommands: commands, timeoutMs: 2_000 });
  const preparePath = join(outputDir, "prepare.json");
  const prepared = JSON.parse(readFileSync(preparePath, "utf8"));

  prepared.systems.fake.rebuilds[0].integrity.extractedToStoredLoss = 999;
  writeFileSync(preparePath, `${JSON.stringify(prepared, null, 2)}\n`);
  assert.equal(generateGraphReport({ suite, outputDir, suppliedRows: result.rows }).gate.passed, true);

  prepared.systems.fake.rebuilds.at(-1).integrity.extractedToStoredLoss = 2;
  writeFileSync(preparePath, `${JSON.stringify(prepared, null, 2)}\n`);
  let report = generateGraphReport({ suite, outputDir, suppliedRows: result.rows });
  assert.equal(report.gate.passed, false);
  assert.ok(report.gate.failures.includes("integrity:fake:extractedToStoredLoss 2 > ceiling 1"));

  prepared.systems.fake.rebuilds.at(-1).integrity.extractedToStoredLoss = 1;
  prepared.systems.fake.rebuilds.at(-1).integrity.nodes = 0;
  writeFileSync(preparePath, `${JSON.stringify(prepared, null, 2)}\n`);
  report = generateGraphReport({ suite, outputDir, suppliedRows: result.rows });
  assert.ok(report.gate.failures.includes("integrity:fake:nodes 0 < floor 1"));

  delete prepared.systems.fake.rebuilds.at(-1).integrity.nodes;
  writeFileSync(preparePath, `${JSON.stringify(prepared, null, 2)}\n`);
  report = generateGraphReport({ suite, outputDir, suppliedRows: result.rows });
  assert.ok(report.gate.failures.includes("integrity:fake:nodes is missing from final prepared rebuild"));

  prepared.systems.fake.rebuilds.at(-1).integrity.nodes = "NaN";
  writeFileSync(preparePath, `${JSON.stringify(prepared, null, 2)}\n`);
  report = generateGraphReport({ suite, outputDir, suppliedRows: result.rows });
  assert.ok(report.gate.failures.includes("integrity:fake:nodes=NaN is not finite"));
});

test("nonzero CLI exits are invalid and cannot become empty successful retrievals", { concurrency: false }, async () => {
  const { subjectRoot, suite, outputDir } = fixture();
  const commands = { fake: [process.execPath, FAKE] };
  prepareGraphEvaluation({ suite, subjectRoot, harnessRoot: HARNESS_ROOT, outputDir, systemCommands: commands });
  const previous = process.env.FAKE_GRAPH_QUERY_MODE;
  process.env.FAKE_GRAPH_QUERY_MODE = "failure";
  try {
    const result = await runGraphEvaluation({ suite, subjectRoot, outputDir, systemCommands: commands, timeoutMs: 2_000 });
    assert.equal(result.rows[0].valid, false);
    assert.match(result.rows[0].violations.join("\n"), /exited 7/);
  } finally {
    if (previous === undefined) delete process.env.FAKE_GRAPH_QUERY_MODE;
    else process.env.FAKE_GRAPH_QUERY_MODE = previous;
  }
});

test("native schedules abort when the subject changes during a query", { concurrency: false }, async () => {
  const { subjectRoot, suite, outputDir } = fixture();
  const driftQuery = "Trigger concurrent identity drift";
  suite.tasks.push({ ...positiveTask(), id: "drift", query: driftQuery });
  const commands = { fake: [process.execPath, FAKE] };
  prepareGraphEvaluation({ suite, subjectRoot, harnessRoot: HARNESS_ROOT, outputDir, systemCommands: commands });
  const previous = process.env.FAKE_GRAPH_MUTATE_SUBJECT;
  const previousQuery = process.env.FAKE_GRAPH_MUTATE_QUERY;
  process.env.FAKE_GRAPH_MUTATE_SUBJECT = "1";
  process.env.FAKE_GRAPH_MUTATE_QUERY = driftQuery;
  try {
    await assert.rejects(
      runGraphEvaluation({ suite, subjectRoot, outputDir, systemCommands: commands, timeoutMs: 2_000 }),
      /identity drift after 002-drift--fake: subject repository changed after preparation/,
    );
  } finally {
    if (previous === undefined) delete process.env.FAKE_GRAPH_MUTATE_SUBJECT;
    else process.env.FAKE_GRAPH_MUTATE_SUBJECT = previous;
    if (previousQuery === undefined) delete process.env.FAKE_GRAPH_MUTATE_QUERY;
    else process.env.FAKE_GRAPH_MUTATE_QUERY = previousQuery;
  }
  const manifest = JSON.parse(readFileSync(join(outputDir, "run-manifest.json"), "utf8"));
  assert.equal(manifest.status, "aborted");
  assert.equal(manifest.failedRunId, "002-drift--fake");
  assert.equal(manifest.resultCount, 1);
  assert.match(manifest.error, /subject repository changed/);
  assert.equal(existsSync(join(outputDir, "runs", "001-target--fake.json")), true);
  assert.equal(existsSync(join(outputDir, "runs", "002-drift--fake.json")), false);
  assert.equal(existsSync(join(outputDir, "raw", "queries", "002-drift--fake.stdout.jsonl")), true);
  assert.equal(existsSync(join(subjectRoot, ".mex", "graph.db")), false);
});

test("native schedules abort when a command bundle changes during a query", { concurrency: false }, async () => {
  const { subjectRoot, suite, outputDir } = fixture();
  const driftQuery = "Trigger concurrent identity drift";
  suite.tasks.push({ ...positiveTask(), id: "drift", query: driftQuery });
  const bundleDir = mkdtempSync(join(tmpdir(), "mex-graph-mutable-bundle-"));
  const mutableFake = join(bundleDir, "fake-graph.mjs");
  copyFileSync(FAKE, mutableFake);
  const commands = { fake: [process.execPath, mutableFake] };
  prepareGraphEvaluation({ suite, subjectRoot, harnessRoot: HARNESS_ROOT, outputDir, systemCommands: commands });
  const previous = process.env.FAKE_GRAPH_MUTATE_BUNDLE;
  const previousQuery = process.env.FAKE_GRAPH_MUTATE_QUERY;
  process.env.FAKE_GRAPH_MUTATE_BUNDLE = "1";
  process.env.FAKE_GRAPH_MUTATE_QUERY = driftQuery;
  try {
    await assert.rejects(
      runGraphEvaluation({ suite, subjectRoot, outputDir, systemCommands: commands, timeoutMs: 2_000 }),
      /identity drift after 002-drift--fake: system fake CLI bundle changed after preparation/,
    );
  } finally {
    if (previous === undefined) delete process.env.FAKE_GRAPH_MUTATE_BUNDLE;
    else process.env.FAKE_GRAPH_MUTATE_BUNDLE = previous;
    if (previousQuery === undefined) delete process.env.FAKE_GRAPH_MUTATE_QUERY;
    else process.env.FAKE_GRAPH_MUTATE_QUERY = previousQuery;
  }
  const manifest = JSON.parse(readFileSync(join(outputDir, "run-manifest.json"), "utf8"));
  assert.equal(manifest.status, "aborted");
  assert.equal(manifest.failedRunId, "002-drift--fake");
  assert.equal(manifest.resultCount, 1);
  assert.match(manifest.error, /CLI bundle changed/);
  assert.equal(existsSync(join(outputDir, "runs", "001-target--fake.json")), true);
  assert.equal(existsSync(join(outputDir, "runs", "002-drift--fake.json")), false);
  assert.equal(existsSync(join(subjectRoot, ".mex", "graph.db")), false);
});

test("native schedules abort when the evaluation harness changes during a query", { concurrency: false }, async () => {
  const { subjectRoot, suite, outputDir } = fixture();
  const harnessRoot = mkdtempSync(join(tmpdir(), "mex-graph-mutable-harness-"));
  const harnessFile = join(harnessRoot, "evaluator.mjs");
  writeFileSync(harnessFile, "export const evaluator = true;\n");
  const commands = { fake: [process.execPath, FAKE] };
  prepareGraphEvaluation({ suite, subjectRoot, harnessRoot, outputDir, systemCommands: commands });
  const previous = process.env.FAKE_GRAPH_MUTATE_HARNESS_PATH;
  process.env.FAKE_GRAPH_MUTATE_HARNESS_PATH = harnessFile;
  try {
    await assert.rejects(
      runGraphEvaluation({ suite, subjectRoot, outputDir, systemCommands: commands, timeoutMs: 2_000 }),
      /identity drift after 001-target--fake: evaluation harness changed after preparation/,
    );
  } finally {
    if (previous === undefined) delete process.env.FAKE_GRAPH_MUTATE_HARNESS_PATH;
    else process.env.FAKE_GRAPH_MUTATE_HARNESS_PATH = previous;
  }
  const manifest = JSON.parse(readFileSync(join(outputDir, "run-manifest.json"), "utf8"));
  assert.equal(manifest.status, "aborted");
  assert.equal(manifest.failedRunId, "001-target--fake");
  assert.equal(manifest.resultCount, 0);
  assert.match(manifest.error, /evaluation harness changed/);
  assert.equal(existsSync(join(outputDir, "runs", "001-target--fake.json")), false);
  assert.equal(existsSync(join(outputDir, "raw", "queries", "001-target--fake.stdout.jsonl")), true);
  assert.equal(existsSync(join(subjectRoot, ".mex", "graph.db")), false);
});

test("resume rejects a changed run identity", { concurrency: false }, async () => {
  const { subjectRoot, suite, outputDir } = fixture();
  const commands = { fake: [process.execPath, FAKE] };
  prepareGraphEvaluation({ suite, subjectRoot, harnessRoot: HARNESS_ROOT, outputDir, systemCommands: commands });
  await runGraphEvaluation({ suite, subjectRoot, outputDir, systemCommands: commands, timeoutMs: 2_000 });
  await assert.rejects(
    runGraphEvaluation({ suite, subjectRoot, outputDir, systemCommands: commands, timeoutMs: 3_000, resume: true }),
    /run identity/,
  );
});
