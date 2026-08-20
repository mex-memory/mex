import {
  evidenceIdentity,
  evidenceMatchesRecord,
  evidencePath,
  evidenceSpan,
  evidenceSymbol,
  normalizeRepoPath,
  uniqueRequiredPaths,
} from "../core/evidence.mjs";
import { mean, round } from "../core/stats.mjs";

export { normalizeRepoPath };

export function evidenceKey(evidence) {
  return evidenceIdentity(evidence);
}

export function recordEvidenceKey(record) {
  return evidenceSymbol(record) && evidencePath(record) ? evidenceIdentity(record) : null;
}

export function resultRecordsForTask(task, records) {
  const types = task.operation === "scope"
    ? new Set(["fact"])
    : task.operation === "query"
      ? new Set(["result"])
      : new Set(["defines", "caller"]);
  return records.filter((record) => types.has(record.type));
}

function rankEvidence(results, evidence) {
  const index = results.findIndex((record) => evidenceMatchesRecord(evidence, record));
  return index < 0 ? null : index + 1;
}

function recallAt(ranks, k) {
  return ranks.length ? ranks.filter((rank) => rank !== null && rank <= k).length / ranks.length : null;
}

function dcg(relevance) {
  return relevance.reduce((total, value, index) => total + (value ? 1 / Math.log2(index + 2) : 0), 0);
}

function ndcgAt(results, relevant, k) {
  if (!relevant.length) return null;
  const relevance = results.slice(0, k).map((record) => Number(relevant.some((evidence) => evidenceMatchesRecord(evidence, record))));
  while (relevance.length < k) relevance.push(0);
  const ideal = Array.from({ length: k }, (_, index) => Number(index < Math.min(k, relevant.length)));
  const idealDcg = dcg(ideal);
  return idealDcg ? dcg(relevance) / idealDcg : null;
}

function filesInResponse(records) {
  const files = [];
  const seen = new Set();
  const add = (value) => {
    const path = evidencePath(value);
    if (path && !seen.has(path)) { seen.add(path); files.push(path); }
  };
  for (const record of records) {
    add(record);
    for (const node of record.nodes ?? record.steps ?? []) if (node && typeof node === "object") add(node);
    for (const range of record.ranges ?? []) add({ ...range, filePath: range.filePath ?? record.filePath });
  }
  return files;
}

function returnedSourceRanges(records) {
  return records.flatMap((record) => {
    if (record.type !== "source") return [];
    const path = evidencePath(record);
    if (!path) return [];
    const ranges = Array.isArray(record.ranges) ? record.ranges : [record];
    return ranges.flatMap((range) => {
      const span = evidenceSpan(range);
      return span ? [{ path, ...span, nodeIds: range.nodeIds ?? [] }] : [];
    });
  });
}

function sourceSpanCovered(evidence, ranges) {
  const expected = evidenceSpan(evidence);
  const path = evidencePath(evidence);
  if (!expected || !path) return false;
  const matching = ranges.filter((range) => range.path === path
    && range.endLine >= expected.startLine && range.startLine <= expected.endLine)
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  let coveredThrough = expected.startLine - 1;
  for (const range of matching) {
    // Source planning may split one declaration across several JSONL records.
    // Adjacent and overlapping intervals are equivalent to one returned span;
    // an actual missing line must still fail the coverage check.
    if (range.startLine > coveredThrough + 1) return false;
    coveredThrough = Math.max(coveredThrough, range.endLine);
    if (coveredThrough >= expected.endLine) return true;
  }
  return false;
}

function flowGraph(records) {
  const nodes = new Map();
  const edges = [];
  const remember = (node) => {
    if (!node || typeof node !== "object") return null;
    const id = node.id ?? node.nodeId;
    if (typeof id === "string") nodes.set(id, { ...(nodes.get(id) ?? {}), ...node });
    return typeof id === "string" ? id : null;
  };
  for (const record of records) {
    remember(record);
    for (const node of record.nodes ?? []) remember(node);
    const steps = Array.isArray(record.steps) ? record.steps : [];
    const stepIds = [];
    for (const step of steps) {
      if (step && typeof step === "object" && ("source" in step || "target" in step)) {
        const source = typeof step.source === "string" ? step.source : remember(step.source);
        const target = typeof step.target === "string" ? step.target : remember(step.target);
        if (source && target) edges.push({ ...step, source, target });
        continue;
      }
      const id = typeof step === "string" ? step : remember(step);
      if (id) stepIds.push(id);
    }
    // Protocol v1/v2 fixtures represented a flow as an ordered list of node
    // ids (or node objects). Keep that compatibility path alongside protocol
    // v3, whose `flow.steps` entries are already directed edge objects.
    for (let index = 1; index < stepIds.length; index++) edges.push({ source: stepIds[index - 1], target: stepIds[index], kind: "flow" });
    if (record.type === "edge" && typeof record.source === "string" && typeof record.target === "string") edges.push(record);
    for (const edge of record.edges ?? []) {
      const source = typeof edge.source === "string" ? edge.source : remember(edge.source);
      const target = typeof edge.target === "string" ? edge.target : remember(edge.target);
      if (source && target) edges.push({ ...edge, source, target });
    }
  }
  return { nodes, edges };
}

function directedFlowCovered(required, graph) {
  const starts = [...graph.nodes].filter(([, node]) => evidenceMatchesRecord(required.from, node)).map(([id]) => id);
  const targets = new Set([...graph.nodes].filter(([, node]) => evidenceMatchesRecord(required.to, node)).map(([id]) => id));
  if (!starts.length || !targets.size) return false;
  const adjacency = new Map();
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source).push(edge);
  }
  const queue = starts.map((id) => ({ id, depth: 0, unnamedBridges: 0 }));
  const visited = new Set(queue.map((entry) => `${entry.id}\0${entry.unnamedBridges}`));
  while (queue.length) {
    const current = queue.shift();
    if (targets.has(current.id)) return true;
    if (current.depth >= 7) continue;
    for (const edge of adjacency.get(current.id) ?? []) {
      const target = graph.nodes.get(edge.target);
      const callbackBridge = edge.kind === "contains" && isUnnamedFlowNode(target);
      if (required.kinds?.length && !required.kinds.includes(edge.kind) && !callbackBridge) continue;
      const unnamedBridges = current.unnamedBridges + Number(isUnnamedFlowNode(target));
      if (unnamedBridges > 1) continue;
      const key = `${edge.target}\0${unnamedBridges}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ id: edge.target, depth: current.depth + 1, unnamedBridges });
    }
  }
  return false;
}

function isUnnamedFlowNode(node) {
  const name = typeof node?.name === "string" ? node.name : "";
  return name.length === 0 || /^<.*>$/.test(name) || name.startsWith("<callback:");
}

export function firstResponseMetrics(task, records) {
  const gold = task.gold ?? [];
  const files = filesInResponse(records);
  const requiredPaths = uniqueRequiredPaths(gold);
  const requiredFileRanks = requiredPaths.map((path) => ({ path, rank: files.includes(path) ? files.indexOf(path) + 1 : null }));
  const sourceRanges = returnedSourceRanges(records);
  const sourceSpans = gold.map((evidence) => ({
    symbol: evidence.symbol,
    path: evidencePath(evidence),
    span: evidenceSpan(evidence),
    covered: sourceSpanCovered(evidence, sourceRanges),
  }));
  const requiredFlows = task.requiredFlows ?? [];
  const graph = flowGraph(records);
  const flows = requiredFlows.map((flow) => ({ ...flow, covered: directedFlowCovered(flow, graph) }));
  const firstRelevantFileRank = requiredFileRanks.map((entry) => entry.rank).filter(Number.isFinite).sort((a, b) => a - b)[0] ?? null;
  return {
    returnedFiles: files,
    requiredFileRanks,
    firstRelevantFileRank,
    fileRecallAt5: requiredFileRanks.length ? round(requiredFileRanks.filter((entry) => entry.rank !== null && entry.rank <= 5).length / requiredFileRanks.length) : null,
    fileHitAt5: requiredFileRanks.length ? requiredFileRanks.every((entry) => entry.rank !== null && entry.rank <= 5) : null,
    fileReciprocalRank: firstRelevantFileRank ? round(1 / firstRelevantFileRank) : 0,
    returnedSourceRanges: sourceRanges,
    sourceSpans,
    returnedSourceSpanRecall: sourceSpans.length ? round(sourceSpans.filter((entry) => entry.covered).length / sourceSpans.length) : null,
    requiredFlows: flows,
    directedFlowCoverage: flows.length ? round(flows.filter((entry) => entry.covered).length / flows.length) : null,
  };
}

function coveredGold(task, coverage) {
  if (!coverage?.evidence) return { eligible: task.gold ?? [], missing: [] };
  const eligible = [];
  const missing = [];
  for (const evidence of task.gold ?? []) {
    const coverageEntry = coverage.evidence.find((entry) => evidenceMatchesRecord(evidence, entry));
    const covered = coverageEntry?.covered;
    (covered === false ? missing : eligible).push(evidence);
  }
  return { eligible, missing };
}

export function gradeRetrieval(task, records, processResult = {}, graphCoverage = null) {
  const results = resultRecordsForTask(task, records);
  const gold = task.gold ?? [];
  const { eligible: retrievalGold, missing: constructionMissing } = coveredGold(task, graphCoverage);
  const alternates = task.acceptableAlternates ?? [];
  const prohibited = task.mustNotReturn ?? [];
  const goldRanks = gold.map((evidence) => ({ ...evidence, graphCovered: !constructionMissing.some((missing) => evidenceMatchesRecord(evidence, missing)), rank: rankEvidence(results, evidence) }));
  const retrievalGoldRanks = goldRanks.filter((entry) => entry.graphCovered);
  const alternateRanks = alternates.map((evidence) => ({ ...evidence, rank: rankEvidence(results, evidence) }));
  const prohibitedRanks = prohibited.map((evidence) => ({ ...evidence, rank: rankEvidence(results, evidence) }));
  const ranks = retrievalGoldRanks.map((entry) => entry.rank);
  const firstRelevantRank = [...retrievalGoldRanks, ...alternateRanks].map((entry) => entry.rank).filter(Number.isFinite).sort((a, b) => a - b)[0] ?? null;
  const relevant = [...retrievalGold, ...alternates];
  const relevantTop5 = results.slice(0, 5).filter((record) => relevant.some((evidence) => evidenceMatchesRecord(evidence, record))).length;
  const errorCodes = records.filter((record) => record.type === "error").map((record) => record.code ?? "UNKNOWN");
  const expectedErrorCodes = task.expect?.errorCodes ?? [];
  const noResultExpected = task.expect?.noResult === true;
  const unexpectedErrorCodes = errorCodes.filter((code) => !expectedErrorCodes.includes(code));
  const errorExpectationMet = unexpectedErrorCodes.length === 0;
  const noResultCorrect = noResultExpected ? results.length === 0 && errorExpectationMet : null;
  const completeEvidence = noResultExpected ? noResultCorrect : ranks.length > 0 && ranks.every(Number.isFinite);
  const prohibitedHit = prohibitedRanks.some((entry) => Number.isFinite(entry.rank));
  const summary = records.findLast((record) => record.type === "summary") ?? null;
  const outputChars = String(processResult.stdout ?? "").length;
  const outputTokensApprox = Math.ceil(outputChars / 4);
  const maxOutputTokens = Number(summary?.maxOutputTokens ?? task.options?.maxOutputTokens ?? NaN);
  const estimatedOutputTokens = Number(summary?.estimatedOutputTokens ?? NaN);
  const budgetCompliant = Number.isFinite(maxOutputTokens) && Number.isFinite(estimatedOutputTokens) ? estimatedOutputTokens <= maxOutputTokens : null;
  const relevantReturned = results.filter((record) => relevant.some((evidence) => evidenceMatchesRecord(evidence, record))).length;
  const firstResponse = firstResponseMetrics(task, records);
  return {
    returned: results.length,
    goldCount: retrievalGold.length,
    sourceGoldCount: gold.length,
    graphCoveredGold: retrievalGold.length,
    constructionMissingGold: constructionMissing,
    graphEvidenceCoverage: graphCoverage?.evidenceCoverage ?? null,
    goldRanks,
    retrievalGoldRanks,
    alternateRanks,
    prohibitedRanks,
    recallAt1: round(recallAt(ranks, 1)),
    recallAt5: round(recallAt(ranks, 5)),
    recallAt10: round(recallAt(ranks, 10)),
    reciprocalRank: firstRelevantRank ? round(1 / firstRelevantRank) : 0,
    ndcgAt10: round(ndcgAt(results, relevant, 10)),
    precisionAt5: round(relevantTop5 / 5),
    precisionAmongReturnedAt5: round(results.length ? relevantTop5 / Math.min(5, results.length) : 0),
    irrelevantRate: round(results.length ? (results.length - relevantReturned) / results.length : 0),
    completeEvidence,
    noResultCorrect,
    prohibitedHit,
    firstRelevantRank,
    miss: !noResultExpected && retrievalGold.length > 0 && firstRelevantRank === null,
    ...firstResponse,
    errorCodes,
    unexpectedErrorCodes,
    errorExpectationMet,
    truncated: summary?.truncated ?? null,
    budgetCompliant,
    outputChars,
    outputTokensApprox,
    elapsedMs: processResult.elapsedMs ?? null,
    relevantFactsPer1kTokens: outputTokensApprox ? round(relevantReturned * 1_000 / outputTokensApprox) : 0,
  };
}

export function summarizeRetrievalRows(rows) {
  const valid = rows.filter((row) => row.valid);
  const positive = valid.filter((row) => row.task.expect?.noResult !== true);
  // Source-bearing first-response gates apply to Scope. Exact query/impact are
  // intentionally narrow structural tools and do not promise source payloads.
  const scopePositive = positive.filter((row) => row.task.operation === "scope");
  const negative = valid.filter((row) => row.task.expect?.noResult === true);
  const evidenceCount = positive.reduce((total, row) => total + row.metrics.goldCount, 0);
  const evidenceAt = (k) => positive.reduce((total, row) => total + row.metrics.retrievalGoldRanks.filter((entry) => entry.rank !== null && entry.rank <= k).length, 0);
  const sourceEvidenceCount = scopePositive.reduce((total, row) => total + row.metrics.sourceGoldCount, 0);
  const sourceEvidenceCovered = scopePositive.reduce((total, row) => total + row.metrics.sourceSpans.filter((entry) => entry.covered).length, 0);
  const fileTasks = scopePositive.filter((row) => row.metrics.requiredFileRanks.length > 0);
  const flowTasks = positive.filter((row) => Number.isFinite(row.metrics.directedFlowCoverage));
  const constructionRows = positive.filter((row) => Number.isFinite(row.metrics.graphEvidenceCoverage));
  const constructionTotal = constructionRows.reduce((total, row) => total + row.metrics.sourceGoldCount, 0);
  const constructionCovered = constructionRows.reduce((total, row) => total + row.metrics.graphCoveredGold, 0);
  return {
    runs: rows.length,
    validRuns: valid.length,
    invalidRuns: rows.length - valid.length,
    recallAt1: evidenceCount ? round(evidenceAt(1) / evidenceCount) : null,
    recallAt5: evidenceCount ? round(evidenceAt(5) / evidenceCount) : null,
    recallAt10: evidenceCount ? round(evidenceAt(10) / evidenceCount) : null,
    mrr: round(mean(positive.map((row) => row.metrics.reciprocalRank))),
    topFiveFileHitRate: fileTasks.length ? round(fileTasks.filter((row) => row.metrics.fileHitAt5).length / fileTasks.length) : null,
    fileMrr: round(mean(fileTasks.map((row) => row.metrics.fileReciprocalRank))),
    returnedRequiredSourceSpanRecall: sourceEvidenceCount ? round(sourceEvidenceCovered / sourceEvidenceCount) : null,
    meanDirectedFlowCoverage: flowTasks.length ? round(mean(flowTasks.map((row) => row.metrics.directedFlowCoverage))) : null,
    graphEvidenceCoverage: constructionTotal ? round(constructionCovered / constructionTotal) : null,
    graphConstructionMisses: constructionTotal ? constructionTotal - constructionCovered : null,
    meanNdcgAt10: round(mean(positive.map((row) => row.metrics.ndcgAt10).filter(Number.isFinite))),
    completeEvidenceRate: positive.length ? round(positive.filter((row) => row.metrics.completeEvidence).length / positive.length) : null,
    missRate: positive.length ? round(positive.filter((row) => row.metrics.miss).length / positive.length) : null,
    negativeAccuracy: negative.length ? round(negative.filter((row) => row.metrics.noResultCorrect).length / negative.length) : null,
    prohibitedHitRate: valid.length ? round(valid.filter((row) => row.metrics.prohibitedHit).length / valid.length) : null,
    budgetComplianceRate: valid.filter((row) => row.metrics.budgetCompliant !== null).length
      ? round(valid.filter((row) => row.metrics.budgetCompliant).length / valid.filter((row) => row.metrics.budgetCompliant !== null).length)
      : null,
  };
}
