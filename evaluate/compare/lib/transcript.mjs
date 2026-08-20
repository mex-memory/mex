import { claudeAdapter } from "../../adapters/agents/claude.mjs";

/**
 * Compatibility wrapper for historical comparison consumers. New runs use the
 * Claude adapter directly; sharing it here prevents usage accounting from
 * drifting between the legacy reader and the active runner.
 */
export function parseTranscript(raw, expectedSymbols = []) {
  const parsed = claudeAdapter.parseTranscript(raw, { expectedSymbols });
  return {
    usage: {
      uncachedInput: parsed.usage.uncachedInput,
      cacheCreation: parsed.usage.cacheWrite,
      cacheRead: parsed.usage.cacheRead,
      output: parsed.usage.output,
      processed: parsed.usage.reportedTotal,
      accountingValid: parsed.usage.accountingValid,
      accountingReason: parsed.usage.accountingReason,
      terminal: parsed.usage.terminal,
      perMessage: parsed.usage.perMessage,
    },
    costUsd: parsed.usage.reportedCostUsd,
    turns: parsed.turns,
    permissionDenials: parsed.permissionDenials,
    malformedLines: parsed.malformedLines,
    toolCalls: parsed.toolCalls,
    graph: {
      calls: parsed.graph.calls,
      scope: parsed.graph.scope,
      get: parsed.graph.get,
      query: parsed.graph.query,
      impact: parsed.graph.impact,
      distinctScopeQueries: parsed.graph.distinctScopeQueries,
      fallbacks: parsed.graph.fallbacks,
      initialScopeRank: parsed.graph.initialScopeRank,
    },
    uniqueToolResultChars: parsed.toolResultChars,
    uniqueToolResultTokens: parsed.toolResultTokensApprox,
    structured: parsed.structured,
    providerFailure: parsed.providerFailure,
  };
}
