// ============================================================================
// Job registry — progress-reporting for long engine operations
// ============================================================================
//
// The engine APIs are request/response: `graph.build()` and the setup steps
// return a result and print nothing a server can subscribe to. A browser needs
// the opposite — incremental feedback while a multi-minute build runs.
//
// This is the thin adapter between the two. A job declares its steps up front
// (so the UI can render the whole checklist immediately), then the work marks
// each one running/done/failed. Subscribers get every state change; the current
// state is also readable at any time so a page reload or a client without
// EventSource can just poll.

import { randomUUID } from "node:crypto";

export type JobKind = "setup" | "graph-build" | "grounding-capture";

export type JobStatus = "running" | "succeeded" | "failed";

export type JobStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface JobStep {
  id: string;
  label: string;
  status: JobStepStatus;
  /** Short human-readable outcome, e.g. "412 nodes across 38 files". */
  detail: string | null;
  /** Live fraction for long steps (graph build); null when not applicable. */
  progress: JobStepProgress | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobStepProgress {
  done: number;
  total: number;
}

export interface JobLogEntry {
  at: string;
  level: "info" | "success" | "warn" | "error";
  message: string;
}

export interface Job<TResult = unknown> {
  id: string;
  kind: JobKind;
  status: JobStatus;
  steps: JobStep[];
  log: JobLogEntry[];
  /** Populated once the job succeeds. */
  result: TResult | null;
  /** Populated once the job fails. */
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface JobStepDeclaration {
  id: string;
  label: string;
}

/**
 * The handle a job body uses to report progress. Every method is safe to call
 * with an unknown step id (it is ignored) so a partially-refactored job body
 * can never crash the operation it is narrating.
 */
export interface JobContext {
  startStep(id: string, detail?: string): void;
  /** Update a running step's detail/progress without finishing it (SSE-friendly). */
  updateStep(id: string, detail?: string, progress?: JobStepProgress | null): void;
  finishStep(id: string, detail?: string): void;
  skipStep(id: string, detail?: string): void;
  failStep(id: string, detail?: string): void;
  log(level: JobLogEntry["level"], message: string): void;
}

export type JobListener = (job: Job) => void;

const MAX_RETAINED_JOBS = 20;

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Map<string, Set<JobListener>>();
  /** Insertion order, used to evict the oldest finished jobs. */
  private readonly order: string[] = [];

  /**
   * Register a job and start running `body` immediately. Returns the initial
   * job snapshot synchronously so an HTTP handler can respond with the id
   * before any work happens.
   */
  start<TResult>(
    kind: JobKind,
    steps: readonly JobStepDeclaration[],
    body: (ctx: JobContext) => Promise<TResult>,
  ): Job<TResult> {
    const job: Job<TResult> = {
      id: randomUUID(),
      kind,
      status: "running",
      steps: steps.map((step) => ({
        id: step.id,
        label: step.label,
        status: "pending",
        detail: null,
        progress: null,
        startedAt: null,
        finishedAt: null,
      })),
      log: [],
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };

    this.jobs.set(job.id, job as Job);
    this.order.push(job.id);
    this.evictOldest();

    const ctx = this.createContext(job as Job);

    // Defer so the HTTP 202 and the SSE handshake can flush before any work
    // runs. An async job that does not await until deep in a scan or graph
    // build otherwise occupies the event loop: the browser has a job id but
    // never receives a snapshot, and the wizard sits on "Starting setup…".
    setImmediate(() => {
      void body(ctx).then(
        (result) => {
          job.result = result;
          // A resolved body means the operation completed even if an individual
          // step failed — setup, for instance, survives an unbuildable graph.
          job.status = "succeeded";
          // Any step still running when the body returns is implicitly done.
          for (const step of job.steps) {
            if (step.status === "running") {
              step.status = "succeeded";
              step.finishedAt = new Date().toISOString();
            }
          }
          job.finishedAt = new Date().toISOString();
          this.emit(job as Job);
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          job.status = "failed";
          job.error = message;
          for (const step of job.steps) {
            if (step.status === "running") {
              step.status = "failed";
              step.detail = message;
              step.finishedAt = new Date().toISOString();
            }
          }
          job.log.push({ at: new Date().toISOString(), level: "error", message });
          job.finishedAt = new Date().toISOString();
          this.emit(job as Job);
        },
      );
    });

    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Jobs newest first. */
  list(): Job[] {
    return [...this.order]
      .reverse()
      .map((id) => this.jobs.get(id))
      .filter((job): job is Job => Boolean(job));
  }

  /** Subscribe to state changes for one job. Returns an unsubscribe function. */
  subscribe(id: string, listener: JobListener): () => void {
    let listeners = this.listeners.get(id);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(id, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.listeners.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(id);
    };
  }

  private createContext(job: Job): JobContext {
    const step = (id: string): JobStep | undefined => job.steps.find((s) => s.id === id);
    const now = () => new Date().toISOString();

    return {
      startStep: (id, detail) => {
        const target = step(id);
        if (!target) return;
        target.status = "running";
        target.startedAt = now();
        target.progress = null;
        if (detail !== undefined) target.detail = detail;
        this.emit(job);
      },
      updateStep: (id, detail, progress) => {
        const target = step(id);
        if (!target || target.status !== "running") return;
        if (detail !== undefined) target.detail = detail;
        if (progress !== undefined) target.progress = progress;
        this.emit(job);
      },
      finishStep: (id, detail) => {
        const target = step(id);
        if (!target) return;
        target.status = "succeeded";
        target.finishedAt = now();
        target.progress = null;
        if (detail !== undefined) target.detail = detail;
        this.emit(job);
      },
      skipStep: (id, detail) => {
        const target = step(id);
        if (!target) return;
        target.status = "skipped";
        target.finishedAt = now();
        target.progress = null;
        if (detail !== undefined) target.detail = detail;
        this.emit(job);
      },
      failStep: (id, detail) => {
        const target = step(id);
        if (!target) return;
        target.status = "failed";
        target.finishedAt = now();
        target.progress = null;
        if (detail !== undefined) target.detail = detail;
        this.emit(job);
      },
      log: (level, message) => {
        job.log.push({ at: now(), level, message });
        this.emit(job);
      },
    };
  }

  private emit(job: Job): void {
    const listeners = this.listeners.get(job.id);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(job);
      } catch {
        // A broken subscriber (closed socket) must not fail the job.
      }
    }
  }

  /**
   * Keep memory bounded across a long-lived server session. Only finished jobs
   * are evicted, and never one that still has subscribers attached.
   */
  private evictOldest(): void {
    while (this.order.length > MAX_RETAINED_JOBS) {
      const index = this.order.findIndex((id) => {
        const job = this.jobs.get(id);
        return job?.status !== "running" && !this.listeners.has(id);
      });
      if (index === -1) return;
      const [evicted] = this.order.splice(index, 1);
      this.jobs.delete(evicted);
    }
  }
}
