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

/** Tokens reserved for the mandatory trailing `summary` record. */
export const FRAMING_RESERVE = 140;

/**
 * Plan-then-emit token accounting. A command first accounts its mandatory framing
 * (`meta`) with {@link frame}, then reserves each data record with {@link tryAdd}
 * (which returns false — and remembers it — when the record would push past the
 * budget minus the summary reserve). The command writes only the records that fit,
 * then frames the `summary`. Because every record is accounted — framing included —
 * `estimatedTokens` is honest and `overBudget` is true iff mandatory framing alone
 * exceeded the ceiling. `droppedAny` OR `overBudget` means the response is truncated.
 */
export class BudgetLedger {
  private usedTokens = 0;
  private dropped = false;
  constructor(
    private readonly maxOutputTokens: number,
    private readonly reserve = FRAMING_RESERVE,
  ) {}

  /** Account a mandatory framing record (meta/summary). Always counted. */
  frame(record: unknown): void {
    this.usedTokens += estimateTokens(record);
  }

  /** Whether a record would fit — no side effects, does not mark truncation. */
  fits(record: unknown): boolean {
    return this.usedTokens + estimateTokens(record) <= this.maxOutputTokens - this.reserve;
  }

  /** Reserve budget for a data record; true (and reserved) iff it fits under the ceiling. */
  tryAdd(record: unknown): boolean {
    if (!this.fits(record)) {
      this.dropped = true;
      return false;
    }
    this.usedTokens += estimateTokens(record);
    return true;
  }

  get droppedAny(): boolean {
    return this.dropped;
  }

  get overBudget(): boolean {
    return this.usedTokens > this.maxOutputTokens;
  }

  get estimatedTokens(): number {
    return this.usedTokens;
  }
}
