// ============================================================================
// mex code-graph — agent JSONL protocol + budgeted serializer
// ============================================================================
//
// The agent-facing commands (`graph scope` / `query` / `get`, `impact`) stream
// newline-delimited JSON. Every stream is framed by a `meta` record first and a
// `summary` record last, with `fact` / `edge` / `source` data records between.
// Source is opt-in; the default `minimal` detail returns structure + relationship
// counts only. A hard token budget is enforced WHILE emitting, not after.

import type { CompactFact, DetailLevel, SourceRange } from "./scope.js";

export const SCHEMA_VERSION = 1;
const CHARS_PER_TOKEN = 4;

/** Tunable retrieval controls shared by every agent command. */
export interface AgentOptions {
  detail: DetailLevel;
  maxNodes: number;
  maxOutputTokens: number;
  maxSourceLines: number;
  depth: number;
  /** Attach the full serialized fingerprint to each fact (grounding workflow only). */
  fingerprint: boolean;
}

export const DEFAULT_OPTIONS: AgentOptions = {
  detail: "minimal",
  maxNodes: 10,
  maxOutputTokens: 1500,
  maxSourceLines: 120,
  depth: 2,
  fingerprint: false,
};

/** Coerce raw CLI option strings into a validated {@link AgentOptions}. */
export function resolveOptions(raw: Partial<Record<keyof AgentOptions, unknown>> = {}): AgentOptions {
  const detail = raw.detail === "standard" || raw.detail === "source" ? raw.detail : DEFAULT_OPTIONS.detail;
  const num = (value: unknown, fallback: number): number => {
    const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    detail,
    maxNodes: num(raw.maxNodes, DEFAULT_OPTIONS.maxNodes),
    maxOutputTokens: num(raw.maxOutputTokens, DEFAULT_OPTIONS.maxOutputTokens),
    maxSourceLines: num(raw.maxSourceLines, DEFAULT_OPTIONS.maxSourceLines),
    depth: num(raw.depth, DEFAULT_OPTIONS.depth),
    fingerprint: raw.fingerprint === true || raw.fingerprint === "true",
  };
}

/** Deterministic, model-agnostic token estimate. Conservative, labeled "estimated". */
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);
}

// ── record shapes (for callers/tests) ──────────────────────────────────────

export interface MetaRecord {
  type: "meta";
  schemaVersion: number;
  command: string;
  task?: string;
  detail: DetailLevel;
  maxNodes: number;
  maxOutputTokens: number;
}

export interface EdgeRecord {
  type: "edge";
  kind: string;
  source: string;
  target: string;
  provenance: "static";
}

export interface SourceRecord {
  type: "source";
  filePath: string;
  ranges: SourceRange[];
}

export interface SummaryRecord {
  type: "summary";
  matchedNodes: number;
  returnedNodes: number;
  returnedEdges: number;
  estimatedOutputTokens: number;
  maxOutputTokens: number;
  truncated: boolean;
  suggestedNextCommands: string[];
}

export type FactRecord = CompactFact & { type: "fact" };

/**
 * Streams JSONL records under a hard token budget. `force` always writes (meta,
 * summary); `offer` writes only if the record fits under the budget minus a
 * reserve kept for the trailing summary, returning false when it would overflow.
 */
export class BudgetedEmitter {
  private used = 0;
  constructor(
    private readonly write: (line: string) => void,
    private readonly maxOutputTokens: number,
    private readonly summaryReserve = 80,
  ) {}

  force(record: unknown): void {
    this.write(JSON.stringify(record));
    this.used += estimateTokens(record);
  }

  offer(record: unknown): boolean {
    const cost = estimateTokens(record);
    if (this.used + cost + this.summaryReserve > this.maxOutputTokens) return false;
    this.write(JSON.stringify(record));
    this.used += cost;
    return true;
  }

  get estimatedTokens(): number {
    return this.used;
  }
}
