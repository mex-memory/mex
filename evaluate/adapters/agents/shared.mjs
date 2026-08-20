import { parseJsonLines } from "../../core/jsonl.mjs";
import { round } from "../../core/stats.mjs";
import { evidenceMatchesRecord } from "../../core/evidence.mjs";
import { firstResponseMetrics } from "../../graders/retrieval.mjs";

const FILE_SHELL = /(?:^|\s)(?:rg|grep|find|fd|cat|head|tail|sed|awk|ls)(?:\s|$)/;

export function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => typeof block === "string" ? block : block?.text ?? JSON.stringify(block)).join("\n");
  return content == null ? "" : JSON.stringify(content);
}

export function usageRecord(fields, raw, audit = {}) {
  const uncachedInput = Number.isFinite(fields.uncachedInput) ? fields.uncachedInput : null;
  const cacheWrite = Number.isFinite(fields.cacheWrite) ? fields.cacheWrite : null;
  const cacheRead = Number.isFinite(fields.cacheRead) ? fields.cacheRead : null;
  const output = Number.isFinite(fields.output) ? fields.output : null;
  const reportedInput = Number.isFinite(fields.reportedInput) ? fields.reportedInput : null;
  const reportedTotal = Number.isFinite(fields.reportedTotal) ? fields.reportedTotal : null;
  const reportedCostUsd = Number.isFinite(fields.reportedCostUsd) ? fields.reportedCostUsd : null;
  const newTokens = uncachedInput !== null && output !== null ? uncachedInput + (cacheWrite ?? 0) + output : null;
  const cacheDenominator = reportedInput ?? ([uncachedInput, cacheWrite, cacheRead].every((value) => value !== null)
    ? uncachedInput + cacheWrite + cacheRead
    : null);
  return {
    uncachedInput,
    cacheWrite,
    cacheRead,
    output,
    reasoningOutput: Number.isFinite(fields.reasoningOutput) ? fields.reasoningOutput : null,
    reportedInput,
    reportedTotal,
    reportedCostUsd,
    newTokens,
    cacheUseRatio: cacheRead !== null && cacheDenominator ? round(cacheRead / cacheDenominator) : null,
    accountingValid: fields.accountingValid !== false,
    accountingReason: fields.accountingReason ?? null,
    terminal: audit.terminal ?? null,
    perMessage: audit.perMessage ?? null,
    raw,
  };
}

export function initialScopeRank(payload, task) {
  const { records } = parseJsonLines(payload, "scope tool result");
  const facts = records.filter((record) => record.type === "fact");
  const gold = task.gold ?? [];
  if (gold.length) {
    const index = facts.findIndex((fact) => gold.some((evidence) => evidenceMatchesRecord(evidence, fact)));
    return index < 0 ? null : index + 1;
  }
  const expected = task.expectedSymbols ?? [];
  const index = facts.findIndex((fact) => expected.includes(fact.name) || expected.includes(fact.symbol));
  return index < 0 ? null : index + 1;
}

export function initialScopeEvidence(payload, task) {
  const { records, errors } = parseJsonLines(payload, "scope tool result");
  const metrics = firstResponseMetrics(task, records);
  return { ...metrics, parseErrors: errors };
}

function graphKind(command) {
  if (/\bgraph\s+scope\b/.test(command)) return "scope";
  if (/\bgraph\s+get\b/.test(command)) return "get";
  if (/\bgraph\s+query\b/.test(command)) return "query";
  if (/\bimpact\b/.test(command)) return "impact";
  return null;
}

function scopeQuery(command) {
  const match = command.match(/\bgraph\s+scope\s+(?:"([^"]*)"|'([^']*)'|([^\n]+?))(?:\s+--|$)/);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function toolMetrics(toolCalls, task) {
  const graph = {
    scope: 0, get: 0, query: 0, impact: 0, calls: 0, distinctScopeQueries: 0, fallbacks: 0,
    initialScopeRank: null, initialFileRank: null, initialFileRecallAt5: null, initialFileHitAt5: null,
    initialSourceSpanRecall: null, initialDirectedFlowCoverage: null, initialReturnedFiles: [],
  };
  const scopeQueries = new Set();
  let toolErrors = 0;
  let permissionDenials = 0;
  let toolResultChars = 0;
  for (const call of toolCalls) {
    if (call.status === "error") toolErrors += 1;
    if (call.status === "denied") permissionDenials += 1;
    if (typeof call.output === "string") toolResultChars += call.output.length;
    if (call.status !== "denied" && ["Read", "Grep", "Glob"].includes(call.name)) graph.fallbacks += 1;
    if (call.name !== "Bash") continue;
    if (call.status === "denied") continue;
    const command = String(call.input?.command ?? "");
    const kind = graphKind(command);
    if (kind) {
      graph[kind] += 1;
      graph.calls += 1;
      if (kind === "scope") {
        scopeQueries.add(scopeQuery(command));
        if (graph.scope === 1 && typeof call.output === "string") {
          graph.initialScopeRank = initialScopeRank(call.output, task);
          const evidence = initialScopeEvidence(call.output, task);
          graph.initialFileRank = evidence.firstRelevantFileRank;
          graph.initialFileRecallAt5 = evidence.fileRecallAt5;
          graph.initialFileHitAt5 = evidence.fileHitAt5;
          graph.initialSourceSpanRecall = evidence.returnedSourceSpanRecall;
          graph.initialDirectedFlowCoverage = evidence.directedFlowCoverage;
          graph.initialReturnedFiles = evidence.returnedFiles;
        }
      }
    } else if (FILE_SHELL.test(command)) graph.fallbacks += 1;
  }
  graph.distinctScopeQueries = [...scopeQueries].filter(Boolean).length;
  return { graph, toolErrors, permissionDenials, toolResultChars, toolResultTokensApprox: Math.ceil(toolResultChars / 4) };
}

export function parseEventStream(raw, label) {
  const events = [];
  let malformedLines = 0;
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); }
    catch { malformedLines += 1; }
  }
  return { events, malformedLines, label };
}
