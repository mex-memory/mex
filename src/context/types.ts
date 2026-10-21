/**
 * Shapes shared by the context composer.
 *
 * The context index is a derived, checkout-local file (`.mex/local/context-index.json`).
 * It is never canonical: delete it and `mex context index` rebuilds it from the
 * tracked Wiki Markdown and the disposable code graph.
 */

import type { RecipeName } from "./frozen.js";

export const CONTEXT_INDEX_SCHEMA_VERSION = 2;

/** One recorded code link of an entity, as its Markdown wrote it. */
export interface ContextGrounding {
  node: string;
  /** The file the grounding recorded, when it recorded one. */
  file: string | null;
  /** The body hash the link was recorded against; absent means unverified. */
  bodyHash: string | null;
}

/** A graph node a grounding resolves to *now* (at index time). */
export interface ContextSymbol {
  node: string;
  name: string;
  file: string;
  start: number;
  end: number;
  bodyHash: string | null;
}

export interface ContextEntity {
  id: string;
  type: string;
  title: string;
  /** Plain text: link syntax removed, whitespace collapsed, at most 1500 characters. */
  body: string;
  aliases: string[];
  /** The `.mex`-relative Markdown file, POSIX separators. */
  file: string;
  /** One-based line of the heading (or body) inside that file. */
  line: number;
  /** Heading depth; 0 for a file-level entity, 9 for a block with no heading. */
  level: number;
  groundings: ContextGrounding[];
  /** Distinct files the groundings name (falling back to the resolved node's file). */
  code: string[];
  symbols: ContextSymbol[];
}

export interface ContextVector {
  /** Hash of the document text the vector was computed from. */
  hash: string;
  /** Little-endian float32 values, base64. */
  data: string;
}

/** What the index was derived from; a change in any of it makes the index stale. */
export interface ContextInputs {
  wiki: {
    files: Array<{ path: string; hash: string; stat: string }>;
    digest: string;
  };
  graph: {
    /** Hash of the graph snapshot metadata, or null when there is no readable graph. */
    identity: string | null;
  };
  /** Digest of the checkout-local alias overlay, or null when there is none. */
  aliasOverlay: string | null;
}

export interface ContextIndex {
  schemaVersion: typeof CONTEXT_INDEX_SCHEMA_VERSION;
  builtAt: string;
  inputs: ContextInputs;
  /** Words naming the project (directory, package name); stop words for this project. */
  projectWords: string[];
  entities: ContextEntity[];
  /** Fact vectors keyed by model id, then entity id. */
  vectors: Record<string, Record<string, ContextVector>>;
}

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

/** Why a prompt produced no packet. */
export type AbstentionReason =
  | "no-index"
  | "no-candidates"
  | "no-match"
  | "below-floor"
  | "uncorroborated"
  | "low-cosine"
  | "low-cosine-veto"
  | "low-fused-score"
  | "dense-only"
  | "weak-margin"
  | "already-shown"
  | "empty-prompt"
  | "task-notification";

export type LiveHealth = "fresh" | "changed" | "missing" | "unverified" | "unchecked" | "none";

export interface ContextDiagnostic {
  code: ContextDiagnosticCode;
  severity: "error" | "warning" | "info";
  message: string;
  remediation?: string;
}

export type ContextDiagnosticCode =
  | "CONTEXT_NO_SCAFFOLD"
  | "CONTEXT_INDEX_MISSING"
  | "CONTEXT_INDEX_INCOMPATIBLE"
  | "CONTEXT_GRAPH_UNAVAILABLE"
  | "CONTEXT_WIKI_UNREADABLE"
  | "CONTEXT_SEMANTIC_UNAVAILABLE"
  | "CONTEXT_SEMANTIC_FAILED"
  | "CONTEXT_SESSION_INVALID"
  | "CONTEXT_USAGE"
  | "CONTEXT_FAILED";

export interface CandidateExplain {
  rank: number;
  id: string;
  title: string;
  type: string;
  score: number;
  norm: number;
  groups: number;
  exact: number;
  cos?: number;
  fused?: number;
  decision: string;
}

export interface PromptResult {
  /** The recipe that ranked, or null when nothing could rank. */
  recipe: RecipeName | null;
  channel: "hybrid" | "lexical" | null;
  injected: Array<{ id: string; title: string; type: string; health: LiveHealth }>;
  /** Why nothing was injected, when nothing was. */
  abstention: AbstentionReason | null;
  /** The packet text to hand the host; empty when nothing was injected. */
  packet: string;
  candidates: CandidateExplain[];
  /** Entity ids dropped because this session already saw them. */
  alreadyShown: string[];
}
