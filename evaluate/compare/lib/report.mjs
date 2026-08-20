import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrapMeanInterval, distribution, mean, median, round, sum } from "../../core/stats.mjs";
import { normalizeRepoPath, uniqueRequiredPaths } from "../../core/evidence.mjs";
import { objectHash } from "../../core/hash.mjs";
import { resolveSelectedArmIds, suiteHash } from "./suite.mjs";

const DELTA_METRICS = [
  "newTokens", "uncachedInput", "cacheWrite", "cacheRead", "output", "reportedTotal", "processed", "costUsd",
  "uniqueToolResultChars", "uniqueToolResultTokens", "elapsedMs", "turns", "toolCalls", "graphCalls",
  "scopeCalls", "distinctScopeQueries", "fallbacks",
];
const ACCOUNTING_METRICS = new Set([
  "newTokens", "uncachedInput", "cacheWrite", "cacheRead", "output", "reportedTotal", "processed", "costUsd", "cacheUseRatio",
]);
const MIN_GATE_TASKS = 2;

function numericDelta(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
}

function numericPercentChange(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && a > 0 ? (b - a) * 100 / a : null;
}

export function pairedDeltas(rows, armIds) {
  const byPair = Map.groupBy(rows, (row) => `${row.taskId}\0${row.repetition ?? 1}`);
  const pairs = [];
  for (let left = 0; left < armIds.length; left++) {
    for (let right = left + 1; right < armIds.length; right++) {
      const [from, to] = [armIds[left], armIds[right]];
      const matched = [];
      for (const taskRows of byPair.values()) {
        const a = taskRows.find((row) => row.arm === from);
        const b = taskRows.find((row) => row.arm === to);
        if (!a || !b || a.valid === false || b.valid === false) continue;
        const accountingValid = a.metrics.tokenAccountingValid !== false && b.metrics.tokenAccountingValid !== false;
        matched.push({
          taskId: a.taskId,
          repetition: a.repetition ?? 1,
          ...Object.fromEntries(DELTA_METRICS.map((metric) => [metric,
            ACCOUNTING_METRICS.has(metric) && !accountingValid
              ? null
              : numericDelta(a.metrics[metric], b.metrics[metric]),
          ])),
          percentChange: Object.fromEntries(DELTA_METRICS.map((metric) => [metric,
            ACCOUNTING_METRICS.has(metric) && !accountingValid
              ? null
              : numericPercentChange(a.metrics[metric], b.metrics[metric]),
          ])),
        });
      }
      const means = {};
      const macroMedians = {};
      const confidence95 = {};
      const perTaskMedian = [...Map.groupBy(matched, (row) => row.taskId)].map(([taskId, taskRows]) => ({
        taskId,
        ...Object.fromEntries(DELTA_METRICS.map((metric) => [metric, round(median(taskRows.map((row) => row[metric]).filter(Number.isFinite)))])),
        percentChange: Object.fromEntries(DELTA_METRICS.map((metric) => [metric,
          round(median(taskRows.map((row) => row.percentChange[metric]).filter(Number.isFinite))),
        ])),
      }));
      const percentMeans = {};
      const percentMacroMedians = {};
      const percentConfidence95 = {};
      for (const metric of DELTA_METRICS) {
        const values = matched.map((row) => row[metric]).filter(Number.isFinite);
        means[metric] = round(mean(values));
        macroMedians[metric] = round(median(perTaskMedian.map((row) => row[metric]).filter(Number.isFinite)));
        const interval = bootstrapMeanInterval(values);
        confidence95[metric] = { low: round(interval.low), high: round(interval.high), samples: interval.samples };
        const taskPercentValues = perTaskMedian.map((row) => row.percentChange[metric]).filter(Number.isFinite);
        percentMeans[metric] = round(mean(taskPercentValues));
        percentMacroMedians[metric] = round(median(taskPercentValues));
        const percentInterval = bootstrapMeanInterval(taskPercentValues);
        percentConfidence95[metric] = {
          low: round(percentInterval.low), high: round(percentInterval.high), samples: percentInterval.samples,
          tasks: taskPercentValues.length,
        };
      }
      pairs.push({
        from, to, matchedPairs: matched.length,
        tokenEligiblePairs: matched.filter((row) => Number.isFinite(row.newTokens)).length,
        costEligiblePairs: matched.filter((row) => Number.isFinite(row.costUsd)).length,
        perTaskRepetition: matched, perTask: perTaskMedian, mean: means, macroMedian: macroMedians, confidence95,
        percentChange: { mean: percentMeans, macroMedian: percentMacroMedians, confidence95: percentConfidence95 },
      });
    }
  }
  return pairs;
}

function blindId(suiteId, runId) {
  return objectHash(`${suiteId}\0${runId}`);
}

function reviewIdentity(suiteId, runIdentity, rows) {
  return objectHash({ suiteId, runIdentity, rows: [...rows].sort((a, b) => a.runId.localeCompare(b.runId)).map((row) => ({ runId: row.runId, answer: row.answer })) });
}

export function buildBlindReview(suiteId, rows, runIdentity = null) {
  const identity = reviewIdentity(suiteId, runIdentity, rows);
  const shuffled = [...rows].sort((a, b) => blindId(suiteId, a.runId).localeCompare(blindId(suiteId, b.runId)));
  const answers = shuffled.map((row, index) => ({
    blindId: `A${String(index + 1).padStart(3, "0")}`,
    taskId: row.taskId,
    repetition: row.repetition ?? 1,
    answer: row.answer,
    manual: { correct: null, complete: null, unsupportedClaims: null, adjudicated: null, notes: "" },
  }));
  const reveal = Object.fromEntries(answers.map((answer, index) => [answer.blindId, { runId: shuffled[index].runId, arm: shuffled[index].arm }]));
  return {
    answersDocument: { schemaVersion: 2, reviewIdentity: identity, answers },
    revealDocument: { schemaVersion: 2, reviewIdentity: identity, reveal },
  };
}

function readBlindFiles(blindPath, revealPath, generated) {
  if (!existsSync(blindPath) || !existsSync(revealPath)) return { ...generated, validIdentity: true, existing: false };
  const answersRaw = JSON.parse(readFileSync(blindPath, "utf8"));
  const revealRaw = JSON.parse(readFileSync(revealPath, "utf8"));
  const answersDocument = Array.isArray(answersRaw) ? { schemaVersion: 1, reviewIdentity: null, answers: answersRaw } : answersRaw;
  const revealDocument = revealRaw?.reveal ? revealRaw : { schemaVersion: 1, reviewIdentity: null, reveal: revealRaw };
  return {
    answersDocument,
    revealDocument,
    validIdentity: answersDocument.reviewIdentity === generated.answersDocument.reviewIdentity
      && revealDocument.reviewIdentity === generated.revealDocument.reviewIdentity,
    existing: true,
  };
}

function summarizeArm(armRows) {
  const valid = armRows.filter((row) => row.valid);
  const tokenValid = valid.filter((row) => row.metrics.tokenAccountingValid !== false);
  const scopeRows = valid.filter((row) => Number(row.metrics.scopeCalls ?? row.metrics.graphCalls) > 0);
  const finite = (metric) => (ACCOUNTING_METRICS.has(metric) ? tokenValid : valid).map((row) => row.metrics[metric]).filter(Number.isFinite);
  const usage = {};
  for (const metric of ["uncachedInput", "cacheWrite", "cacheRead", "output", "reportedTotal", "processed", "newTokens", "costUsd"]) {
    usage[metric] = distribution(finite(metric));
    usage[metric].total = finite(metric).length ? round(sum(finite(metric))) : null;
  }
  return {
    runs: armRows.length,
    valid: valid.length,
    tokenAccountingEligible: tokenValid.length,
    tokenAccountingInvalid: valid.length - tokenValid.length,
    tokenAccountingInvalidReasons: Object.fromEntries([...Map.groupBy(
      valid.filter((row) => row.metrics.tokenAccountingValid === false),
      (row) => row.metrics.tokenAccountingReason ?? "unknown",
    )].map(([reason, entries]) => [reason, entries.length])),
    automaticCorrect: valid.filter((row) => row.grade.correct).length,
    complete: valid.filter((row) => row.answer?.complete).length,
    usage,
    meanCacheUseRatio: round(mean(finite("cacheUseRatio"))),
    meanFallbacks: round(mean(finite("fallbacks"))),
    meanScopeCalls: round(mean(finite("scopeCalls"))),
    meanDistinctScopeQueries: round(mean(finite("distinctScopeQueries"))),
    permissionDenials: distribution(finite("permissionDenials")),
    deniedFileShellAttempts: distribution(finite("deniedFileShellAttempts")),
    unexplainedPermissionDenials: distribution(finite("unexplainedPermissionDenials")),
    firstResponseTopFiveFileHitRate: scopeRows.length ? round(scopeRows.filter((row) => row.metrics.firstResponseFileHitAt5 === true).length / scopeRows.length) : null,
    firstResponseFileMissRate: scopeRows.length ? round(scopeRows.filter((row) => !Number.isFinite(row.metrics.firstResponseFileRank)).length / scopeRows.length) : null,
    firstResponseFileMrr: scopeRows.length ? round(mean(scopeRows.map((row) => Number.isFinite(row.metrics.firstResponseFileRank) ? 1 / row.metrics.firstResponseFileRank : 0))) : null,
    firstResponseSourceSpanRecall: round(mean(scopeRows.map((row) => row.metrics.firstResponseSourceSpanRecall).filter(Number.isFinite))),
    firstResponseDirectedFlowCoverage: round(mean(scopeRows.map((row) => row.metrics.firstResponseDirectedFlowCoverage).filter(Number.isFinite))),
    graphEvidenceCoverage: round(mean(scopeRows.map((row) => row.metrics.graphEvidenceCoverage).filter(Number.isFinite))),
    latencyMs: distribution(finite("elapsedMs")),
    toolResultChars: distribution(finite("uniqueToolResultChars")),
  };
}

function manualLabels(blind, rows) {
  const byRun = new Map();
  for (const item of blind.answersDocument.answers) {
    const runId = blind.revealDocument.reveal[item.blindId]?.runId;
    if (runId) byRun.set(runId, item.manual);
  }
  return rows.map((row) => ({ row, manual: byRun.get(row.runId) }));
}

function criterionStatus(passed) {
  return passed === null ? "insufficient-sample" : passed ? "pass" : "fail";
}

function pairedNewTokenCriterion(pair) {
  const taskValues = pair?.perTask?.map((row) => row.percentChange?.newTokens).filter(Number.isFinite) ?? [];
  const observed = pair?.percentChange?.macroMedian?.newTokens;
  const rawInterval = pair?.percentChange?.confidence95?.newTokens;
  const sufficient = taskValues.length >= MIN_GATE_TASKS
    && Number.isFinite(observed) && Number.isFinite(rawInterval?.low) && Number.isFinite(rawInterval?.high);
  const passed = sufficient ? observed <= -30 && rawInterval.high < 0 : null;
  return {
    comparison: pair ? `${pair.from}->${pair.to}` : null,
    metric: "newTokens",
    statistic: "macro-median paired percent change",
    eligibleTasks: taskValues.length,
    minimumTasks: MIN_GATE_TASKS,
    observedPercent: sufficient ? round(observed) : null,
    maximumPercent: -30,
    bootstrapMean95Percent: {
      low: sufficient ? round(rawInterval.low) : null,
      high: sufficient ? round(rawInterval.high) : null,
      samples: sufficient ? rawInterval.samples : 0,
    },
    requiresConfidenceHighBelow: 0,
    eligible: sufficient,
    status: criterionStatus(passed),
    passed,
  };
}

function pairedNonRegressionCriterion(pair, metric) {
  const taskValues = pair?.perTask?.map((row) => row[metric]).filter(Number.isFinite) ?? [];
  const observedMacroMedian = pair?.macroMedian?.[metric];
  const observedMean = pair?.mean?.[metric];
  const sufficient = taskValues.length >= MIN_GATE_TASKS
    && Number.isFinite(observedMacroMedian) && Number.isFinite(observedMean);
  const passed = sufficient ? observedMacroMedian <= 0 && observedMean <= 0 : null;
  return {
    comparison: pair ? `${pair.from}->${pair.to}` : null,
    metric,
    statistic: "paired mean and macro-median delta",
    eligibleTasks: taskValues.length,
    minimumTasks: MIN_GATE_TASKS,
    observedDelta: sufficient ? round(observedMacroMedian) : null,
    observedMacroMedianDelta: sufficient ? round(observedMacroMedian) : null,
    observedMeanDelta: sufficient ? round(observedMean) : null,
    maximumDelta: 0,
    eligible: sufficient,
    status: criterionStatus(passed),
    passed,
  };
}

function fallbackReductionCriterion(rows, releasedId, candidateId) {
  const values = (armId) => rows.filter((row) => row.arm === armId && row.valid !== false)
    .map((row) => row.metrics.fallbacks).filter(Number.isFinite);
  const released = releasedId ? values(releasedId) : [];
  const candidate = candidateId ? values(candidateId) : [];
  const releasedMean = mean(released);
  const candidateMean = mean(candidate);
  const sufficient = released.length >= MIN_GATE_TASKS && candidate.length >= MIN_GATE_TASKS
    && Number.isFinite(releasedMean) && releasedMean > 0 && Number.isFinite(candidateMean);
  const reduction = sufficient ? (releasedMean - candidateMean) * 100 / releasedMean : null;
  const passed = sufficient ? reduction >= 60 : null;
  return {
    comparison: releasedId && candidateId ? `${releasedId}->${candidateId}` : null,
    metric: "fileToolFallbacks",
    statistic: "mean fallback reduction",
    releasedSamples: released.length,
    candidateSamples: candidate.length,
    minimumSamplesPerArm: MIN_GATE_TASKS,
    releasedMean: sufficient ? round(releasedMean) : null,
    candidateMean: sufficient ? round(candidateMean) : null,
    observedReductionPercent: sufficient ? round(reduction) : null,
    minimumReductionPercent: 60,
    eligible: sufficient,
    status: criterionStatus(passed),
    passed,
  };
}

function correctnessCriterion(finalCorrectness, candidateId, controlIds, pilotValid) {
  const controls = Object.fromEntries(controlIds.map((armId) => [armId, finalCorrectness[armId] ?? null]));
  const candidate = candidateId ? finalCorrectness[candidateId] : null;
  const sufficient = pilotValid && Boolean(candidateId) && controlIds.length >= 1
    && Number.isFinite(candidate) && Object.values(controls).every(Number.isFinite);
  const passed = sufficient ? Object.values(controls).every((value) => candidate >= value) : null;
  return {
    comparison: candidateId ? `${candidateId}->${controlIds.join(",")}` : null,
    metric: "finalCorrectness",
    statistic: "correct run count",
    candidate: sufficient ? candidate : null,
    controls: sufficient ? controls : Object.fromEntries(controlIds.map((armId) => [armId, null])),
    requiresCompletedBlindReview: true,
    eligible: sufficient,
    status: criterionStatus(passed),
    passed,
  };
}

function configuredSamples(suite, rows, candidateId, taskFilter = () => true) {
  const tasks = (suite?.tasks ?? []).filter(taskFilter);
  const repetitions = suite?.requiredRepetitions;
  if (!candidateId || !Number.isInteger(repetitions) || repetitions < 1) {
    return { tasks, expected: 0, samples: [], missing: tasks.map((task) => ({ taskId: task.id, repetition: null })) };
  }
  const samples = [];
  const missing = [];
  for (const task of tasks) {
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const matches = rows.filter((row) => row.arm === candidateId && row.taskId === task.id && (row.repetition ?? 1) === repetition);
      if (matches.length === 1) samples.push({ task, repetition, row: matches[0] });
      else missing.push({ taskId: task.id, repetition, matches: matches.length });
    }
  }
  return { tasks, expected: tasks.length * repetitions, samples, missing };
}

function repetitionCriterion(suite, rows, selectedArmIds = null) {
  const required = suite?.requiredRepetitions;
  const armIds = suite?.arms ? resolveSelectedArmIds(suite, selectedArmIds) : [];
  const tasks = suite?.tasks ?? [];
  if (!Number.isInteger(required) || required < 1 || !armIds.length || !tasks.length) {
    return {
      metric: "repetitions", required: required ?? null, observed: [], expectedRuns: null, actualRuns: rows.length,
      missing: [], duplicates: [], extras: [], eligible: false, status: "insufficient-sample", passed: null,
    };
  }
  const expectedKeys = new Set();
  for (const task of tasks) for (const armId of armIds) for (let repetition = 1; repetition <= required; repetition++) {
    expectedKeys.add(`${task.id}\0${armId}\0${repetition}`);
  }
  const counts = new Map();
  const extras = [];
  for (const row of rows) {
    const key = `${row.taskId}\0${row.arm}\0${row.repetition ?? 1}`;
    if (!expectedKeys.has(key)) extras.push({ taskId: row.taskId, arm: row.arm, repetition: row.repetition ?? 1 });
    else counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const unpack = (key) => {
    const [taskId, arm, repetition] = key.split("\0");
    return { taskId, arm, repetition: Number(repetition) };
  };
  const missing = [...expectedKeys].filter((key) => !counts.has(key)).map(unpack);
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([key, count]) => ({ ...unpack(key), count }));
  const observed = [...new Set(rows.map((row) => row.repetition ?? 1).filter(Number.isInteger))].sort((a, b) => a - b);
  const sufficient = missing.length === 0;
  const passed = sufficient ? duplicates.length === 0 && extras.length === 0 : null;
  return {
    metric: "repetitions",
    required,
    observed,
    expectedRuns: expectedKeys.size,
    actualRuns: rows.length,
    missing,
    duplicates,
    extras,
    eligible: sufficient,
    status: criterionStatus(passed),
    passed,
  };
}

function distinctScopeCriterion(suite, rows, candidateId, maximum) {
  const sampleSet = configuredSamples(suite, rows, candidateId);
  const values = sampleSet.samples.map(({ row }) => row.metrics.distinctScopeQueries);
  const sufficient = sampleSet.expected > 0 && sampleSet.missing.length === 0 && values.every(Number.isFinite);
  const observedMaximum = sufficient ? Math.max(...values) : null;
  const passed = sufficient ? observedMaximum <= maximum : null;
  return {
    comparison: candidateId ?? null,
    metric: "distinctScopeQueries",
    statistic: "maximum per candidate run",
    expectedSamples: sampleSet.expected,
    eligibleSamples: values.filter(Number.isFinite).length,
    missingSamples: sampleSet.missing,
    observedMaximum,
    maximum,
    eligible: sufficient,
    status: criterionStatus(passed),
    passed,
  };
}

function fileHitAt5Criterion(suite, rows, candidateId, minimum) {
  const sampleSet = configuredSamples(suite, rows, candidateId, (task) => uniqueRequiredPaths(task.gold ?? []).length > 0);
  const values = sampleSet.samples.map(({ row }) => row.metrics.firstResponseFileHitAt5);
  const sufficient = sampleSet.expected > 0 && sampleSet.missing.length === 0 && values.every((value) => typeof value === "boolean");
  const observed = sufficient ? values.filter(Boolean).length / values.length : null;
  const passed = sufficient ? observed >= minimum : null;
  return {
    comparison: candidateId ?? null,
    metric: "firstResponseFileHitAt5",
    statistic: "candidate run rate",
    eligibleTasks: sampleSet.tasks.length,
    expectedSamples: sampleSet.expected,
    eligibleSamples: values.filter((value) => typeof value === "boolean").length,
    missingSamples: sampleSet.missing,
    observed: round(observed),
    minimum,
    eligible: sufficient,
    status: criterionStatus(passed),
    passed,
  };
}

function hasSourceSpan(evidence) {
  const start = evidence?.startLine ?? evidence?.line;
  const end = evidence?.endLine ?? start;
  return Number.isInteger(start) && start > 0 && Number.isInteger(end) && end >= start;
}

function sourceSpanCriterion(suite, rows, candidateId, minimum) {
  const sampleSet = configuredSamples(suite, rows, candidateId, (task) =>
    Array.isArray(task.gold) && task.gold.length > 0 && task.gold.every(hasSourceSpan));
  const values = sampleSet.samples.map(({ row }) => row.metrics.firstResponseSourceSpanRecall);
  const sufficient = sampleSet.expected > 0 && sampleSet.missing.length === 0 && values.every(Number.isFinite);
  const observed = sufficient ? mean(values) : null;
  const passed = sufficient ? observed >= minimum : null;
  return {
    comparison: candidateId ?? null,
    metric: "firstResponseSourceSpanRecall",
    statistic: "mean candidate run recall",
    eligibleTasks: sampleSet.tasks.length,
    expectedSamples: sampleSet.expected,
    eligibleSamples: values.filter(Number.isFinite).length,
    missingSamples: sampleSet.missing,
    observed: round(observed),
    minimum,
    eligible: sufficient,
    status: criterionStatus(passed),
    passed,
  };
}

function requiredFilesCriterion(suite, rows, candidateId) {
  const allTasksHaveFiles = (suite?.tasks ?? []).every((task) => uniqueRequiredPaths(task.gold ?? []).length > 0);
  const sampleSet = configuredSamples(suite, rows, candidateId, (task) => uniqueRequiredPaths(task.gold ?? []).length > 0);
  const failures = [];
  let observationsAvailable = true;
  for (const { task, repetition, row } of sampleSet.samples) {
    const returned = row.metrics.firstResponseReturnedFiles;
    if (!Array.isArray(returned)) { observationsAvailable = false; continue; }
    const returnedSet = new Set(returned.map(normalizeRepoPath).filter(Boolean));
    const missingFiles = uniqueRequiredPaths(task.gold ?? []).filter((path) => !returnedSet.has(path));
    if (missingFiles.length) failures.push({ taskId: task.id, repetition, missingFiles });
  }
  const sufficient = allTasksHaveFiles && sampleSet.expected > 0 && sampleSet.missing.length === 0 && observationsAvailable;
  const passed = sufficient ? failures.length === 0 : null;
  return {
    comparison: candidateId ?? null,
    metric: "allRequiredFilesInFirstScope",
    statistic: "every configured task and repetition",
    requiredTasks: suite?.tasks?.length ?? 0,
    eligibleTasks: sampleSet.tasks.length,
    expectedSamples: sampleSet.expected,
    observedSamples: sampleSet.samples.length,
    missingSamples: sampleSet.missing,
    failures: sufficient ? failures : [],
    eligible: sufficient,
    status: criterionStatus(passed),
    passed,
  };
}

export function buildReleaseGate({
  candidateVsFiles, rows, releasedId, candidateId, controlIds, finalCorrectness, pilotValid,
  suite = null, selectedArmIds = null,
}) {
  const criteria = {
    newTokensVsFiles: pairedNewTokenCriterion(candidateVsFiles),
    processedTokensVsFiles: pairedNonRegressionCriterion(candidateVsFiles, "processed"),
    costVsFiles: pairedNonRegressionCriterion(candidateVsFiles, "costUsd"),
    ...(releasedId ? { fallbacksVsReleased: fallbackReductionCriterion(rows, releasedId, candidateId) } : {}),
    correctnessVsControls: correctnessCriterion(finalCorrectness, candidateId, controlIds, pilotValid),
  };
  if (suite?.requiredRepetitions !== undefined) {
    criteria.repetitions = repetitionCriterion(suite, rows, selectedArmIds);
  }
  const configured = suite?.releaseGates ?? {};
  if (configured.maxDistinctScopeQueries !== undefined) {
    criteria.candidateDistinctScopes = distinctScopeCriterion(suite, rows, candidateId, configured.maxDistinctScopeQueries);
  }
  if (configured.firstResponseFileHitAt5 !== undefined) {
    criteria.firstResponseFileHitAt5 = fileHitAt5Criterion(suite, rows, candidateId, configured.firstResponseFileHitAt5);
  }
  if (configured.firstResponseSourceSpanRecall !== undefined) {
    criteria.firstResponseSourceSpanRecall = sourceSpanCriterion(suite, rows, candidateId, configured.firstResponseSourceSpanRecall);
  }
  if (configured.allRequiredFilesInFirstScope === true) {
    criteria.allRequiredFilesInFirstScope = requiredFilesCriterion(suite, rows, candidateId);
  }
  const failures = Object.entries(criteria).filter(([, criterion]) => criterion.passed === false).map(([name]) => name);
  const insufficient = Object.entries(criteria).filter(([, criterion]) => criterion.passed === null).map(([name]) => name);
  const passed = failures.length ? false : insufficient.length ? null : true;
  return {
    kind: releasedId ? "hard-release-gate" : "candidate-vs-files-gate",
    status: criterionStatus(passed),
    eligible: insufficient.length === 0,
    passed,
    failures,
    insufficient,
    criteria,
  };
}

export function generateReport({ suite, outputDir, rows: suppliedRows, selectedArmIds = null }) {
  const loadedRows = suppliedRows ?? loadRows(outputDir);
  const preparePath = join(outputDir, "prepare.json");
  if (existsSync(preparePath)) {
    const prepared = JSON.parse(readFileSync(preparePath, "utf8"));
    if (prepared.suiteSha256 && prepared.suiteSha256 !== suiteHash(suite)) throw new Error("suite changed after preparation");
  }
  const manifestPath = join(outputDir, "run-manifest.json");
  const runManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  const runIdentity = runManifest?.runIdentity ?? null;
  const scheduledArmIds = runManifest?.schedule
    ? Object.keys(suite.arms).filter((armId) => runManifest.schedule.some((item) => item.armId === armId))
    : null;
  const manifestArmIds = runManifest?.selectedArmIds
    ? resolveSelectedArmIds(suite, runManifest.selectedArmIds)
    : scheduledArmIds && [2, 3].includes(scheduledArmIds.length)
      ? resolveSelectedArmIds(suite, scheduledArmIds)
      : null;
  const requestedArmIds = selectedArmIds === null
    ? null
    : resolveSelectedArmIds(suite, selectedArmIds);
  if (requestedArmIds && manifestArmIds
    && JSON.stringify(requestedArmIds) !== JSON.stringify(manifestArmIds)) {
    throw new Error("report arm selection does not match the run manifest");
  }
  const armIds = requestedArmIds ?? manifestArmIds ?? Object.keys(suite.arms);
  const selectedArmSet = new Set(armIds);
  const rows = loadedRows.filter((row) => selectedArmSet.has(row.arm));
  const byArm = Object.fromEntries(armIds.map((armId) => [armId, summarizeArm(rows.filter((row) => row.arm === armId))]));
  const expectedRunCount = runManifest?.schedule?.length
    ?? suite.tasks.length * armIds.length * (suite.requiredRepetitions ?? 1);
  const executionValid = runManifest?.status === "complete"
    && rows.length === expectedRunCount && rows.every((row) => row.valid)
    && (!runIdentity || rows.every((row) => row.runIdentity === runIdentity));
  const blindPath = join(outputDir, "blind-review.json");
  const revealPath = join(outputDir, "blind-reveal.json");
  const generatedBlind = buildBlindReview(suite.id, rows, runIdentity);
  const blind = readBlindFiles(blindPath, revealPath, generatedBlind);
  const labels = manualLabels(blind, rows);
  const manuallyScored = blind.validIdentity && labels.length === rows.length && labels.every(({ manual }) =>
    typeof manual?.correct === "boolean" && typeof manual?.complete === "boolean" && typeof manual?.unsupportedClaims === "boolean",
  );
  const disagreements = labels.flatMap(({ row, manual }) => {
    return row && typeof manual?.correct === "boolean" && manual.correct !== row.grade.correct
      ? [{ runId: row.runId, automatic: row.grade.correct, manual: manual.correct, adjudicated: manual.adjudicated === true }]
      : [];
  });
  const disagreementsAdjudicated = disagreements.every((item) => item.adjudicated);
  const pilotValid = executionValid && manuallyScored && disagreementsAdjudicated;
  const roleId = (role, fallback) => armIds.find((id) => suite.arms[id].role === role)
    ?? (armIds.includes(fallback) ? fallback : null);
  const filesId = roleId("control", "grep");
  const baselineId = roleId("released", "baseline");
  const controlIds = [...new Set([filesId, baselineId].filter(Boolean))];
  const patchedId = roleId("patched", "patched");
  const finalCorrectness = Object.fromEntries(armIds.map((armId) => [armId, rows.filter((row) => row.arm === armId).reduce((count, row) => {
    if (!manuallyScored) return count + Number(row.grade.correct);
    const manual = labels.find((entry) => entry.row.runId === row.runId)?.manual;
    return count + Number(manual?.correct === true);
  }, 0)]));
  const noCorrectnessRegression = Boolean(patchedId) && controlIds.every((armId) => finalCorrectness[patchedId] >= finalCorrectness[armId]);
  const allDeltas = pairedDeltas(rows, armIds);
  // Build role-oriented pairs separately so gate signs never depend on JSON
  // arm ordering. `allDeltas` remains unchanged for descriptive comparisons.
  const candidateVsFiles = filesId && patchedId ? pairedDeltas(rows, [filesId, patchedId])[0] ?? null : null;
  const baselineToPatched = baselineId && patchedId ? pairedDeltas(rows, [baselineId, patchedId])[0] ?? null : null;
  // A selected two-arm run is an explicitly descriptive tuning pilot. Its
  // configured retrieval checks apply to the repetitions actually scheduled
  // for that pilot, while the suite's full-release repetition contract remains
  // visible at the top level and is still required by aggregate release gates.
  const gateSuite = !baselineId && Number.isInteger(runManifest?.repetitions)
    ? { ...suite, requiredRepetitions: runManifest.repetitions }
    : suite;
  const improvements = {
    retrievalMrr: Boolean(baselineId && patchedId && byArm[patchedId].firstResponseFileMrr > byArm[baselineId].firstResponseFileMrr),
    fallbackBehavior: Boolean(baselineId && patchedId && byArm[patchedId].meanFallbacks < byArm[baselineId].meanFallbacks),
    pairedNewTokens: Boolean(baselineToPatched && Number.isFinite(baselineToPatched.mean.newTokens) && baselineToPatched.mean.newTokens < 0),
    pairedCost: Boolean(baselineToPatched && Number.isFinite(baselineToPatched.mean.costUsd) && baselineToPatched.mean.costUsd < 0),
  };
  const gate = buildReleaseGate({
    candidateVsFiles, rows, releasedId: baselineId, candidateId: patchedId, controlIds,
    finalCorrectness, pilotValid, suite: gateSuite, selectedArmIds: armIds,
  });
  const decision = {
    descriptivePilotOnly: !baselineId,
    releasedComparisonDescriptive: Boolean(baselineToPatched),
    usesManualFinalLabels: manuallyScored,
    noCorrectnessRegression,
    improvements,
    hardGateStatus: gate.status,
    patchedWin: gate.passed === true,
  };
  const report = {
    schemaVersion: 2,
    suiteId: suite.id,
    requiredRepetitions: suite.requiredRepetitions ?? null,
    runRepetitions: runManifest?.repetitions ?? null,
    releaseGateConfiguration: suite.releaseGates ?? null,
    selectedArmIds: armIds,
    runIdentity,
    generatedAt: new Date().toISOString(),
    executionValid,
    reviewIdentityValid: blind.validIdentity,
    manuallyScored,
    disagreementsAdjudicated,
    pilotValid,
    disagreements,
    runCount: rows.length,
    expectedRunCount,
    byArm,
    pairedDeltas: allDeltas,
    primaryPair: candidateVsFiles,
    releasedPair: baselineToPatched,
    usageAccounting: rows.map((row) => ({
      runId: row.runId,
      arm: row.arm,
      taskId: row.taskId,
      repetition: row.repetition ?? 1,
      valid: row.metrics.tokenAccountingValid !== false,
      reason: row.metrics.tokenAccountingReason ?? null,
      terminal: row.metrics.terminalUsage ?? null,
      perMessage: row.metrics.perMessageUsage ?? null,
      selected: {
        uncachedInput: row.metrics.uncachedInput ?? null,
        cacheWrite: row.metrics.cacheWrite ?? null,
        cacheRead: row.metrics.cacheRead ?? null,
        output: row.metrics.output ?? null,
        processed: row.metrics.processed ?? null,
        newTokens: row.metrics.newTokens ?? null,
        costUsd: row.metrics.costUsd ?? null,
      },
    })),
    finalCorrectness,
    gate,
    decision,
  };
  writeFileSync(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (!blind.existing) {
    writeFileSync(blindPath, `${JSON.stringify(blind.answersDocument, null, 2)}\n`);
    writeFileSync(revealPath, `${JSON.stringify(blind.revealDocument, null, 2)}\n`);
  }
  return report;
}

export function loadRows(outputDir) {
  const runsDir = join(outputDir, "runs");
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).filter((name) => name.endsWith(".json")).sort().map((name) => JSON.parse(readFileSync(join(runsDir, name), "utf8")));
}

/** Combine independently generated suite reports into one release decision. */
export function aggregateReleaseReports(entries) {
  const criteria = {};
  for (const entry of entries ?? []) {
    const suite = entry?.suite;
    const suiteId = suite?.id;
    if (typeof suiteId !== "string" || !suiteId) throw new Error("aggregate entries require a suite with an id");
    if (criteria[suiteId]) throw new Error(`duplicate aggregate suite: ${suiteId}`);
    const report = entry?.report ?? null;
    const repetition = report?.gate?.criteria?.repetitions ?? null;
    const identityMatches = report ? report.suiteId === suiteId : null;
    const required = suite.requiredRepetitions ?? null;
    const expectedObserved = Number.isInteger(required)
      ? Array.from({ length: required }, (_, index) => index + 1)
      : null;
    const repetitionMetadataAvailable = Boolean(report) && Number.isInteger(report.requiredRepetitions)
      && Number.isInteger(repetition?.required) && Array.isArray(repetition?.observed);
    const configuredRepetitionsMatch = !report || !repetitionMetadataAvailable
      ? null
      : report.requiredRepetitions === required
        && repetition.required === required
        && JSON.stringify(repetition.observed) === JSON.stringify(expectedObserved);
    const decisionsAvailable = typeof repetition?.passed === "boolean" && typeof report?.gate?.passed === "boolean";
    const sufficient = Boolean(report) && identityMatches === true && configuredRepetitionsMatch === true && decisionsAvailable;
    const passed = !report
      ? null
      : identityMatches === false || configuredRepetitionsMatch === false
        ? false
        : sufficient
          ? repetition.passed === true && report.gate.passed === true
          : null;
    criteria[suiteId] = {
      requiredRepetitions: suite.requiredRepetitions ?? null,
      reportPresent: Boolean(report),
      reportSuiteId: report?.suiteId ?? null,
      observedRepetitions: repetition?.observed ?? [],
      configuredRepetitionsMatch,
      suiteGateStatus: report?.gate?.status ?? null,
      eligible: sufficient,
      status: criterionStatus(passed),
      passed,
    };
  }
  const failures = Object.entries(criteria).filter(([, criterion]) => criterion.passed === false).map(([suiteId]) => suiteId);
  const insufficient = Object.entries(criteria).filter(([, criterion]) => criterion.passed === null).map(([suiteId]) => suiteId);
  const passed = failures.length ? false : insufficient.length || Object.keys(criteria).length === 0 ? null : true;
  return {
    kind: "multi-suite-hard-release-gate",
    status: criterionStatus(passed),
    eligible: insufficient.length === 0 && Object.keys(criteria).length > 0,
    passed,
    failures,
    insufficient,
    criteria,
  };
}
