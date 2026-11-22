import type { ForgeClient } from "../forge.js";
import type { PinnedTree } from "../git.js";
import type { Repository, SourceWindow } from "../source.js";

export type CandidateKind = "review-thread" | "pr-text" | "closed-pr" | "revert" | "cause-commit" | "adr" | "doc" | "issue";
export interface Region { path: string; commit: string; start: number; end: number; text: string; hash: string; }
export interface Candidate {
  id: string;
  kind: CandidateKind;
  link: string;
  hash: string;
  nodeIds: string[];
  at: string;
  pull?: number;
  title?: string;
  path?: string;
  text: string;
  prText?: string;
  code?: { before?: Region; after?: Region; head?: Region; anchor?: string };
  related?: { pulls?: number[]; commits?: string[]; reland?: { before: Region; after: Region } };
  reviewers: string[];
  weights: { actedOn: boolean; familiar: boolean; guidelineLink: boolean; generalising: boolean; smallPr: boolean; hotUnknown: boolean };
  signal: "strong" | "weak";
  /** Metadata needed for narrow scope, verbatim quotes, and per-node verification. */
  changedPaths?: string[];
  document?: { headings: string[]; consumerUsage: boolean };
  commentHashes?: Record<string, string>;
}

export type HarvestSource = "merged" | "closed" | "revert" | "cause" | "adr" | "doc" | "issue";
export type ForgeSource = Extract<HarvestSource, "merged" | "closed" | "issue">;
export interface HarvestPoint { id: string; at: string; }
export interface SourceRead { oldest: HarvestPoint; newest: HarvestPoint; }
export interface SearchPage { window: SourceWindow; after?: string; }
export interface HarvestLane {
  source: HarvestSource;
  remaining: SearchPage[];
  ready: HarvestPoint[];
}
export interface HarvestScan {
  window: SourceWindow;
  head: string;
  lanes: HarvestLane[];
  next: number;
  partial: { source: HarvestSource; point: HarvestPoint; emitted: string[] }[];
  boundary: Partial<Record<HarvestSource, HarvestPoint>>;
  completed: Partial<Record<HarvestSource, number>>;
  totals: Partial<Record<ForgeSource, number>>;
}
export interface HarvestCursor {
  sources: Partial<Record<HarvestSource, SourceRead>>;
  backfill?: HarvestScan;
  weekly?: HarvestScan;
  run?: { id: string; counts: CandidateCounts };
  /** Hashed reviewer/path-or-package pairs and the dates of their two earliest observed PRs. */
  familiarity?: Record<string, Array<{ pull: number; at: string }>>;
}
export type CandidateCounts = Partial<Record<CandidateKind, number>>;
export interface HarvestBatch { candidates: Candidate[]; cursor: HarvestCursor; spentEstimate: number; gaps: string[]; done: boolean; }
export interface HarvestOptions extends SourceWindow {
  checkout: string;
  head: string;
  source: Repository;
  agent: "claude" | "codex";
  mode?: "backfill" | "weekly";
  budget?: number;
  issues?: boolean;
  /** Pinned upstream default branch when it differs from the checkout's HEAD. */
  defaultHead?: string;
}
export interface HarvestPlan extends Omit<HarvestOptions, "mode" | "budget" | "defaultHead"> {
  id: string;
  mode: "backfill" | "weekly";
  budget: number;
  defaultHead: string;
  estimate: number;
  ceiling: number;
  inventory: {
    bands: Array<SourceWindow & { source: ForgeSource; count: number }>;
    local: Record<"revert" | "cause" | "adr" | "doc", HarvestPoint[]>;
    hotPaths: string[];
    revertLinks: Record<string, { original?: string; reland?: string }>;
  };
  gaps: string[];
}
export interface HarvestDeps {
  client?: Pick<ForgeClient, "repo" | "anonymous" | "graphql" | "get">;
  /** Reuse a tree already opened by setup or by the worker. */
  tree?: PinnedTree;
  knownPaths?: ReadonlySet<string>;
  /** Verified team membership keyed by lower-case login. CODEOWNERS alone cannot establish it. */
  teams?: ReadonlyMap<string, readonly string[]>;
}
