import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { distribution, mean, round } from "../../core/stats.mjs";
import { summarizeRetrievalRows } from "../../graders/retrieval.mjs";
import { graphSuiteHash } from "../../schemas/graph-suite.mjs";
import { loadPreparedGraphEvaluation } from "./prepare.mjs";
import { loadGraphRows } from "./runner.mjs";

function csv(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function groupBy(values, key) {
  const groups = new Map();
  for (const value of values) {
    const id = key(value);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(value);
  }
  return groups;
}

function summarizeRows(rows) {
  const retrieval = summarizeRetrievalRows(rows);
  const valid = rows.filter((row) => row.valid);
  return {
    ...retrieval,
    latencyMs: distribution(valid.map((row) => row.metrics.elapsedMs)),
    outputTokensApprox: distribution(valid.map((row) => row.metrics.outputTokensApprox)),
    returnedFacts: distribution(valid.map((row) => row.metrics.returned)),
    relevantFactsPer1kTokens: round(mean(valid.map((row) => row.metrics.relevantFactsPer1kTokens))),
  };
}

function categorySummary(rows) {
  return Object.fromEntries([...groupBy(rows, (row) => row.task.category)].map(([category, entries]) => [category, summarizeRows(entries)]));
}

function paraphraseSummary(rows) {
  const families = [...groupBy(rows.filter((row) => row.task.family), (row) => row.task.family)];
  return Object.fromEntries(families.map(([family, entries]) => {
    const valid = entries.filter((row) => row.valid);
    const recalls = valid.map((row) => row.metrics.recallAt5).filter(Number.isFinite);
    const misses = valid.filter((row) => row.metrics.miss).length;
    const ranks = valid.map((row) => row.metrics.firstRelevantRank).filter(Number.isFinite);
    return [family, {
      variants: entries.length,
      worstRecallAt5: recalls.length ? Math.min(...recalls) : null,
      worstRank: misses ? null : ranks.length ? Math.max(...ranks) : null,
      misses,
    }];
  }));
}

const PAIRED_METRICS = [
  "fileRecallAt5", "fileReciprocalRank", "returnedSourceSpanRecall", "directedFlowCoverage",
  "recallAt5", "reciprocalRank", "ndcgAt10", "completeEvidence", "outputTokensApprox", "elapsedMs", "returned",
];

function pairedComparisons(rows, systemIds) {
  const byTask = groupBy(rows, (row) => row.taskId);
  const comparisons = [];
  for (let left = 0; left < systemIds.length; left++) {
    for (let right = left + 1; right < systemIds.length; right++) {
      const [from, to] = [systemIds[left], systemIds[right]];
      const perTask = [];
      for (const [taskId, taskRows] of byTask) {
        const baseline = taskRows.find((row) => row.system === from);
        const candidate = taskRows.find((row) => row.system === to);
        if (!baseline || !candidate || !baseline.valid || !candidate.valid) continue;
        perTask.push({
          taskId,
          ...Object.fromEntries(PAIRED_METRICS.map((metric) => {
            const a = Number(baseline.metrics[metric]);
            const b = Number(candidate.metrics[metric]);
            return [metric, Number.isFinite(a) && Number.isFinite(b) ? round(b - a) : null];
          })),
        });
      }
      comparisons.push({
        from,
        to,
        matchedTasks: perTask.length,
        perTask,
        mean: Object.fromEntries(PAIRED_METRICS.map((metric) => [metric, round(mean(perTask.map((row) => row[metric]).filter(Number.isFinite)))])),
      });
    }
  }
  return comparisons;
}

function integrityMetric(prepared, systemId, metric) {
  const integrity = prepared.systems[systemId]?.rebuilds?.at(-1)?.integrity;
  if (!integrity || !Object.prototype.hasOwnProperty.call(integrity, metric)) {
    return { valid: false, failure: `integrity:${systemId}:${metric} is missing from final prepared rebuild` };
  }
  const value = integrity[metric];
  if (!Number.isFinite(value)) {
    return { valid: false, failure: `integrity:${systemId}:${metric}=${String(value)} is not finite` };
  }
  return { valid: true, value };
}

function gateReport(suite, rows, bySystem, byCategory, prepared, runManifest, executionIdentityValid) {
  const failures = [];
  const expectedRuns = suite.tasks.length * Object.keys(suite.systems).length;
  if (rows.length !== expectedRuns) failures.push(`execution: ${rows.length}/${expectedRuns} results exist`);
  if (runManifest.status !== "complete") failures.push(`execution: run manifest status is ${runManifest.status}`);
  if (!executionIdentityValid) failures.push("execution: one or more results do not match the run/preparation identity");
  if (rows.some((row) => !row.valid)) failures.push(`execution: ${rows.filter((row) => !row.valid).length} invalid result(s)`);
  for (const [systemId, system] of Object.entries(prepared.systems)) {
    if (!system.deterministic) failures.push(`integrity:${systemId}: normalized graph hash changed across rebuilds`);
  }
  const gates = suite.gates ?? {};
  const targetIds = gates.systems ?? Object.keys(suite.systems);
  for (const systemId of targetIds) {
    const summary = bySystem[systemId];
    if (!summary) { failures.push(`gates: unknown system ${systemId}`); continue; }
    for (const [metric, floor] of Object.entries(gates.floors ?? {})) {
      if (!Number.isFinite(summary[metric]) || summary[metric] < floor) failures.push(`quality:${systemId}:${metric} ${summary[metric]} < ${floor}`);
    }
    for (const [metric, ceiling] of Object.entries(gates.ceilings ?? {})) {
      if (!Number.isFinite(summary[metric]) || summary[metric] > ceiling) failures.push(`quality:${systemId}:${metric} ${summary[metric]} > ${ceiling}`);
    }
    for (const [metric, floor] of Object.entries(gates.integrityFloors ?? {})) {
      const measured = integrityMetric(prepared, systemId, metric);
      if (!measured.valid) failures.push(measured.failure);
      else if (measured.value < floor) failures.push(`integrity:${systemId}:${metric} ${measured.value} < floor ${floor}`);
    }
    for (const [metric, ceiling] of Object.entries(gates.integrityCeilings ?? {})) {
      const measured = integrityMetric(prepared, systemId, metric);
      if (!measured.valid) failures.push(measured.failure);
      else if (measured.value > ceiling) failures.push(`integrity:${systemId}:${metric} ${measured.value} > ceiling ${ceiling}`);
    }
    for (const [category, floors] of Object.entries(gates.categoryFloors ?? {})) {
      const categoryRow = byCategory[systemId]?.[category];
      if (!categoryRow) { failures.push(`quality:${systemId}: missing gated category ${category}`); continue; }
      for (const [metric, floor] of Object.entries(floors)) {
        if (!Number.isFinite(categoryRow[metric]) || categoryRow[metric] < floor) failures.push(`quality:${systemId}:${category}:${metric} ${categoryRow[metric]} < ${floor}`);
      }
    }
    if (gates.criticalMustPass) {
      const misses = rows.filter((row) => row.system === systemId && row.task.critical && !row.metrics.completeEvidence);
      for (const miss of misses) failures.push(`quality:${systemId}: critical task missed: ${miss.taskId}`);
    }
  }
  if (gates.noRegression) {
    const baselineId = Object.keys(suite.systems).find((id) => suite.systems[id].role === "baseline" || suite.systems[id].role === "released");
    const candidateId = Object.keys(suite.systems).find((id) => suite.systems[id].role === "candidate" || suite.systems[id].role === "patched");
    if (!baselineId || !candidateId) failures.push("noRegression requires baseline/released and candidate/patched system roles");
    else {
      for (const [metric, tolerance] of Object.entries(gates.noRegression)) {
        const baseline = bySystem[baselineId]?.[metric];
        const candidate = bySystem[candidateId]?.[metric];
        if (!Number.isFinite(baseline) || !Number.isFinite(candidate) || candidate < baseline - tolerance) {
          failures.push(`regression:${metric} ${candidateId}=${candidate}, ${baselineId}=${baseline}, tolerance=${tolerance}`);
        }
      }
    }
  }
  const baselineId = Object.keys(suite.systems).find((id) => suite.systems[id].role === "baseline" || suite.systems[id].role === "released");
  const candidateId = Object.keys(suite.systems).find((id) => suite.systems[id].role === "candidate" || suite.systems[id].role === "patched");
  if (gates.categoryNoRegression && baselineId && candidateId) {
    for (const [category, metrics] of Object.entries(gates.categoryNoRegression)) {
      for (const [metric, tolerance] of Object.entries(metrics)) {
        const baseline = byCategory[baselineId]?.[category]?.[metric];
        const candidate = byCategory[candidateId]?.[category]?.[metric];
        if (!Number.isFinite(baseline) || !Number.isFinite(candidate) || candidate < baseline - tolerance) {
          failures.push(`regression:${category}:${metric} ${candidateId}=${candidate}, ${baselineId}=${baseline}, tolerance=${tolerance}`);
        }
      }
    }
  }
  if (gates.criticalNoRegression && baselineId && candidateId) {
    for (const task of suite.tasks.filter((entry) => entry.critical)) {
      const baseline = rows.find((row) => row.system === baselineId && row.taskId === task.id);
      const candidate = rows.find((row) => row.system === candidateId && row.taskId === task.id);
      if (baseline?.metrics.completeEvidence && !candidate?.metrics.completeEvidence) failures.push(`regression: critical task ${task.id} lost complete evidence`);
    }
  }
  if (gates.integrityNoRegression && baselineId && candidateId) {
    const baseline = prepared.systems[baselineId]?.rebuilds?.at(-1)?.integrity;
    const candidate = prepared.systems[candidateId]?.rebuilds?.at(-1)?.integrity;
    for (const [metric, direction] of Object.entries(gates.integrityNoRegression)) {
      const a = baseline?.[metric];
      const b = candidate?.[metric];
      const regressed = direction === "higher" ? b < a : b > a;
      if (!Number.isFinite(a) || !Number.isFinite(b) || regressed) failures.push(`integrity-regression:${metric} ${candidateId}=${b}, ${baselineId}=${a}, preferred=${direction}`);
    }
  }
  return { passed: failures.length === 0, failures };
}

function markdownReport(report) {
  const lines = [
    `# Graph evaluation: ${report.suiteId}`,
    "",
    `Run identity: \`${report.runIdentity}\``,
    "",
    `Gate: **${report.gate.passed ? "PASS" : "FAIL"}**`,
    "",
    "| system | valid | file@5 | source span | flow | graph coverage | R@5 | MRR | p50 tokens | p95 ms |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const [systemId, row] of Object.entries(report.bySystem)) {
    lines.push(`| ${systemId} | ${row.validRuns}/${row.runs} | ${row.topFiveFileHitRate ?? "-"} | ${row.returnedRequiredSourceSpanRecall ?? "-"} | ${row.meanDirectedFlowCoverage ?? "-"} | ${row.graphEvidenceCoverage ?? "-"} | ${row.recallAt5 ?? "-"} | ${row.mrr ?? "-"} | ${row.outputTokensApprox.p50 ?? "-"} | ${row.latencyMs.p95 ?? "-"} |`);
  }
  if (report.gate.failures.length) {
    lines.push("", "## Gate failures", "");
    for (const failure of report.gate.failures) lines.push(`- ${failure}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function generateGraphReport({ suite, outputDir, suppliedRows = null }) {
  const prepared = loadPreparedGraphEvaluation(outputDir);
  if (prepared.suiteId !== suite.id || prepared.suiteSha256 !== graphSuiteHash(suite)) {
    throw new Error("suite or shared task fixture changed after preparation; create a new immutable run");
  }
  const manifestPath = join(outputDir, "run-manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`missing run manifest: ${manifestPath}`);
  const runManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (runManifest.preparedRunIdentity !== prepared.runIdentity) throw new Error("run manifest does not match the preparation identity");
  const rows = suppliedRows ?? loadGraphRows(outputDir);
  const executionIdentityValid = rows.every((row) => row.runIdentity === runManifest.runIdentity);
  const systemIds = Object.keys(suite.systems);
  const bySystem = Object.fromEntries(systemIds.map((systemId) => [systemId, summarizeRows(rows.filter((row) => row.system === systemId))]));
  const byCategory = Object.fromEntries(systemIds.map((systemId) => [systemId, categorySummary(rows.filter((row) => row.system === systemId))]));
  const report = {
    schemaVersion: 2,
    suiteId: suite.id,
    generatedAt: new Date().toISOString(),
    runIdentity: runManifest.runIdentity,
    preparedRunIdentity: prepared.runIdentity,
    expectedRuns: suite.tasks.length * systemIds.length,
    actualRuns: rows.length,
    executionIdentityValid,
    bySystem,
    byCategory,
    paraphraseFamilies: Object.fromEntries(systemIds.map((systemId) => [systemId, paraphraseSummary(rows.filter((row) => row.system === systemId))])),
    graphIntegrity: Object.fromEntries(systemIds.map((systemId) => [systemId, {
      deterministic: prepared.systems[systemId].deterministic,
      rebuilds: prepared.systems[systemId].rebuilds,
    }])),
    pairedComparisons: pairedComparisons(rows, systemIds),
  };
  report.gate = gateReport(suite, rows, bySystem, byCategory, prepared, runManifest, executionIdentityValid);
  writeFileSync(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outputDir, "report.md"), markdownReport(report));
  const header = ["runId", "system", "taskId", "category", "valid", "fileRecallAt5", "returnedSourceSpanRecall", "directedFlowCoverage", "graphEvidenceCoverage", "recallAt5", "reciprocalRank", "returned", "outputTokensApprox", "elapsedMs", "violations"];
  const csvRows = rows.map((row) => [row.runId, row.system, row.taskId, row.task.category, row.valid, row.metrics.fileRecallAt5, row.metrics.returnedSourceSpanRecall, row.metrics.directedFlowCoverage, row.metrics.graphEvidenceCoverage, row.metrics.recallAt5, row.metrics.reciprocalRank, row.metrics.returned, row.metrics.outputTokensApprox, row.metrics.elapsedMs, row.violations.join("; ")]);
  writeFileSync(join(outputDir, "rows.csv"), `${[header, ...csvRows].map((line) => line.map(csv).join(",")).join("\n")}\n`);
  return report;
}
