/**
 * Setup's steps as job rows (contracts/setup-jobs.md). The setup screen (rich and plain),
 * the live view when `mex` runs again, and the Hub's Setup page read setup only through
 * `readSetupSteps`, and start or stop its work only through the jobs API, so the terminal
 * and the Hub can't show different things.
 */
import type { JobState, RecordReader, RecordWriter } from "../record/index.js";
import { jobKind, requestJob, TERMINAL_STATES, type JobRow } from "../record/jobs.js";

/** The setup steps that outlive the screen, in the order the screen shows them. */
export const SETUP_STEP_KINDS = ["file-index", "code-facts", "graph-build", "learn-deeper"] as const;
export type SetupStepKind = typeof SETUP_STEP_KINDS[number];
/** Reserved and never queued in this version: past-session learning. */
export const RESERVED_SETUP_KINDS = ["session-learn"] as const;

/** Plain words for each step, when the job kind isn't registered in this process. */
const LABELS: Record<SetupStepKind, string> = {
  "file-index": "File index", "code-facts": "Code facts", "graph-build": "Code map", "learn-deeper": "Learn deeper",
};

export interface StepProgress { done?: number; total?: number; unit?: string; message: string; }
export interface StepCost { uncachedInput: number; cacheWrite: number; cacheRead: number; output: number; }
export interface SetupStep {
  kind: SetupStepKind;
  jobId: string;
  label: string;
  /** The checkout the step ran for. */
  scope: string | null;
  state: JobState;
  pending?: "pause" | "cancel";
  /** Set before a paid step starts; seconds are derived from the tokens at the quote's rate. */
  estimate?: { tokens?: number; seconds?: number };
  progress?: StepProgress;
  /** The last batch's result line; when the state is "done with gaps", it names the gaps. */
  summary?: string;
  /** Model tokens by class; zero for the free steps. */
  cost: StepCost;
  startedAt: string;
  finishedAt: string | null;
  /** Why it failed or is waiting, in plain words. */
  error?: string;
}

/** Learn deeper quotes about 12,000 tokens a minute through the person's agent. */
export const QUOTE_TOKENS_PER_MINUTE = 12_000;

/** "4,210 of 12,306 files" → done, total and unit; anything else is only a message. */
export function parseProgress(text: string | null | undefined): StepProgress | undefined {
  if (!text) return undefined;
  const m = /^([\d,]+) of ([\d,]+)(?: (\S+))?/u.exec(text);
  if (!m) return { message: text };
  return { done: Number(m[1]!.replace(/,/gu, "")), total: Number(m[2]!.replace(/,/gu, "")), ...(m[3] ? { unit: m[3] } : {}), message: text };
}

type Reader = Pick<RecordReader, "all">;

function costOf(reader: Reader, jobId: string): StepCost {
  try {
    const row = reader.all<{ input: number; cache_write: number; cache_read: number; output: number }>(`SELECT
      coalesce(sum(c.input),0) input,coalesce(sum(c.cache_write),0) cache_write,coalesce(sum(c.cache_read),0) cache_read,coalesce(sum(c.output),0) output
      FROM model_batches b JOIN model_calls c ON c.batch_id=b.id WHERE b.job_id=?`, jobId)[0];
    if (row) return { uncachedInput: row.input, cacheWrite: row.cache_write, cacheRead: row.cache_read, output: row.output };
  } catch { /* a record without model tables has spent nothing */ }
  return { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
}

function lastSummary(reader: Reader, jobId: string): string | undefined {
  return reader.all<{ summary: string }>("SELECT summary FROM job_results WHERE job_id=? ORDER BY batch DESC LIMIT 1", jobId)[0]?.summary;
}

export function setupStepCheckout(row: Pick<JobRow, "params">): string | null {
  try {
    const params = JSON.parse(row.params || "{}") as { checkout?: unknown } | null;
    return typeof params?.checkout === "string" ? params.checkout : null;
  } catch { return null; }
}

/** One step from its job row. */
export function stepFromRow(reader: Reader, row: JobRow): SetupStep {
  const kind = row.kind as SetupStepKind;
  const scope = setupStepCheckout(row);
  const terminal = TERMINAL_STATES.includes(row.state);
  const summary = lastSummary(reader, row.id);
  const estimate = row.tokens_estimate ? { tokens: row.tokens_estimate, seconds: Math.max(1, Math.ceil(row.tokens_estimate / QUOTE_TOKENS_PER_MINUTE)) * 60 } : undefined;
  const progress = terminal ? undefined : parseProgress(row.progress);
  return {
    kind, jobId: row.id, label: jobKind(row.kind)?.label ?? LABELS[kind] ?? row.kind, scope, state: row.state,
    ...(row.state === "running" && row.request ? { pending: row.request } : {}),
    ...(estimate ? { estimate } : {}), ...(progress ? { progress } : {}), ...(summary ? { summary } : {}),
    cost: costOf(reader, row.id), startedAt: row.created_at, finishedAt: row.finished_at,
    ...(row.reason && (row.state === "failed" || row.state === "waiting" || row.state === "cancelled") ? { error: row.reason } : {}),
  };
}

/**
 * The latest job of each setup step for a project, in screen order. An unfinished job wins
 * over a newer finished one, so a step the person can still pause or stop is the one shown.
 * A step with no row was never queued here (skipped, or not reached yet).
 */
export function readSetupStepRows(reader: Reader, projectId: string): JobRow[] {
  const steps: JobRow[] = [];
  for (const kind of SETUP_STEP_KINDS) {
    const row = reader.all<JobRow>(`SELECT * FROM jobs WHERE project_id=? AND kind=?
      ORDER BY CASE WHEN state IN ('done','done with gaps','failed','cancelled') THEN 1 ELSE 0 END, created_at DESC, id DESC LIMIT 1`, projectId, kind)[0];
    if (row) steps.push(row);
  }
  return steps;
}

export function readSetupSteps(reader: Reader, projectId: string): SetupStep[];
export function readSetupSteps<T>(reader: Reader, projectId: string, project: (step: SetupStep, row: JobRow) => T): T[];
export function readSetupSteps<T>(reader: Reader, projectId: string, project?: (step: SetupStep, row: JobRow) => T): (SetupStep | T)[] {
  return readSetupStepRows(reader, projectId).map(row => {
    const step = stepFromRow(reader, row);
    return project ? project(step, row) : step;
  });
}

export type StepAction = "pause" | "resume" | "cancel";
/** The only way a view starts or stops setup work: through the jobs API, never a process. */
export function actOnStep(writer: RecordWriter, jobId: string, action: StepAction, requireCurrent?: (row: JobRow) => void): SetupStep {
  const row = requestJob(writer, jobId, action, requireCurrent);
  return stepFromRow({ all: (sql, ...args) => writer.db.prepare(sql).all(...(args as never[])) as never }, row);
}
