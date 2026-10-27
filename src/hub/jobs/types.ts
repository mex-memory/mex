import type { JobState, Revision } from "../../team/contracts/shared.js";

export const HUB_JOB_KINDS = [
  "graph_refresh",
  "graph_rebuild",
  "wiki_refresh",
  "wiki_rebuild",
] as const;

export const HUB_JOB_INTERRUPTION_REASONS = [
  "user_cancelled",
  "process_restart",
  "process_shutdown",
] as const;

export const HUB_JOB_PHASES = [
  "queued",
  "running",
  "refreshing",
  "rebuilding",
  "finalizing",
  "discover",
  "stage",
  "parse",
  "resolve",
  "validate",
  "publish",
  "complete",
  "failed",
  "interrupted",
] as const;

export const HUB_JOB_PROGRESS_PHASES = [
  "running",
  "refreshing",
  "rebuilding",
  "finalizing",
  "discover",
  "stage",
  "parse",
  "resolve",
  "validate",
  "publish",
] as const;

export type HubJobKind = (typeof HUB_JOB_KINDS)[number];
export type HubJobInterruptionReason = (typeof HUB_JOB_INTERRUPTION_REASONS)[number];
export type HubJobPhase = (typeof HUB_JOB_PHASES)[number];
export type HubJobProgressPhase = (typeof HUB_JOB_PROGRESS_PHASES)[number];

export interface HubJobProgress {
  completed: number;
  total?: number;
  message?: string;
}

export interface HubJobProblem {
  type: "about:blank";
  status: 500;
  code: "JOB_FAILED";
  title: string;
  detail: string;
}

export interface HubJobSnapshot {
  id: string;
  scaffoldId: string;
  kind: HubJobKind;
  generation: number;
  phase: HubJobPhase;
  progress: HubJobProgress | null;
  cancelRequested: boolean;
  state: JobState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  interruptedReason?: HubJobInterruptionReason;
  problem?: HubJobProblem;
  summary?: string;
  revision: Revision;
}

export interface HubJobListRequest {
  cursor?: string;
  limit?: number;
}

export interface HubJobPage {
  items: readonly HubJobSnapshot[];
  nextCursor?: string;
}

export interface HubJobStartRequest {
  kind: HubJobKind;
  migrationPreview?: string;
}

export interface HubJobProgressUpdate {
  completed?: number;
  total?: number;
  phase?: HubJobProgressPhase;
}

export interface HubJobExecutorContext {
  migrationPreview?: string;
  job: HubJobSnapshot;
  signal: AbortSignal;
  reportProgress(update: HubJobProgressUpdate): void;
}

export type HubJobExecutor = (
  context: HubJobExecutorContext,
) => Promise<void>;

export type HubJobExecutors = Partial<Record<HubJobKind, HubJobExecutor>>;

export type HubJobEventType = "snapshot" | "progress" | "terminal";

export interface HubJobEvent {
  type: HubJobEventType;
  job: HubJobSnapshot;
}

export type HubJobListener = (event: HubJobEvent) => void;

export interface HubJobErrorProblem {
  status: number;
  code: string;
  title: string;
  detail: string;
  activeJobId?: string;
}

export class HubJobError extends Error {
  readonly problem: HubJobErrorProblem;

  constructor(problem: HubJobErrorProblem) {
    super(problem.detail);
    this.name = "HubJobError";
    this.problem = problem;
  }
}
