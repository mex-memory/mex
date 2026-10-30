import { randomBytes } from "node:crypto";
import { MexPortError } from "../../team/contracts/shared.js";
import { TeamLocalState } from "../../team/local-state/index.js";
import { boundedHubDuration, emitHubTelemetry, type HubTelemetrySink } from "../telemetry.js";
import {
  HUB_JOB_KINDS,
  HUB_JOB_PROGRESS_PHASES,
  HubJobError,
} from "./types.js";
import type {
  HubJobEventType,
  HubJobExecutor,
  HubJobExecutors,
  HubJobListRequest,
  HubJobListener,
  HubJobPage,
  HubJobProgressUpdate,
  HubJobSnapshot,
  HubJobStartRequest,
} from "./types.js";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_ULID_TIME = 0xffffffffffff;

interface ActiveExecution {
  generation: number;
  controller: AbortController;
  userCancelRequested: boolean;
  shutdownRequested: boolean;
  failureRequested: boolean;
  settled: boolean;
  terminalReported: boolean;
  promise?: Promise<void>;
}

type ManagerLifecycle = "new" | "running" | "closing" | "closed" | "fatal";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 60_000;
const GENERIC_JOB_PROBLEM = Object.freeze({
  type: "about:blank" as const,
  status: 500 as const,
  code: "JOB_FAILED" as const,
  title: "Hub job failed",
  detail: "The job did not complete. Retry it or inspect repository health.",
});

export interface HubJobManagerOptions {
  localState: TeamLocalState;
  executors?: HubJobExecutors;
  now?: () => string;
  generateId?: (timestampMs: number) => string;
  processId?: number;
  leaseToken?: string;
  shutdownTimeoutMs?: number;
  telemetry?: HubTelemetrySink;
}

export interface HubJobService {
  initialize(): void;
  list(request?: HubJobListRequest): HubJobPage;
  get(id: string): HubJobSnapshot | null;
  start(request: HubJobStartRequest): HubJobSnapshot;
  cancel(id: string): HubJobSnapshot;
  subscribe(id: string, listener: HubJobListener): () => void;
}

/**
 * Process-local orchestration over durable, repository-local job summaries.
 *
 * Executors are capability-injected; an absent executor never creates a fake
 * job. Durable transitions are generation/revision bound before listeners are
 * notified, so SSE adapters can treat each event as a current snapshot.
 */
export class HubJobManager implements HubJobService {
  private readonly localState: TeamLocalState;
  private readonly executors: HubJobExecutors;
  private readonly now: () => string;
  private readonly generateId: (timestampMs: number) => string;
  private readonly processId: number;
  private readonly leaseToken: string;
  private readonly shutdownTimeoutMs: number;
  private readonly telemetry?: HubTelemetrySink;
  private readonly executions = new Map<string, ActiveExecution>();
  private readonly listeners = new Map<string, Set<HubJobListener>>();
  private lifecycle: ManagerLifecycle = "new";
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: HubJobManagerOptions) {
    this.localState = options.localState;
    this.telemetry = options.telemetry;
    this.executors = Object.freeze({ ...(options.executors ?? {}) });
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateId = options.generateId ?? generateHubJobId;
    this.processId = validateProcessId(options.processId ?? process.pid);
    this.leaseToken = validateManagerLeaseToken(
      options.leaseToken ?? randomBytes(32).toString("hex"),
    );
    this.shutdownTimeoutMs = validateShutdownTimeout(
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );
  }

  initialize(): void {
    if (this.lifecycle !== "new") {
      throw managerLifecycleError("The Hub job manager has already been initialized.");
    }
    try {
      const timestamp = this.now();
      this.localState.acquireHubJobLease({
        pid: this.processId,
        token: this.leaseToken,
        acquiredAt: timestamp,
      });
      this.localState.reconcileHubJobs(timestamp, this.leaseToken);
      this.lifecycle = "running";
    } catch (error) {
      this.lifecycle = "fatal";
      throw translateInitializationError(error);
    }
  }

  list(request: HubJobListRequest = {}): HubJobPage {
    this.assertReadable();
    try {
      return this.localState.listHubJobs(request);
    } catch (error) {
      if (isValidationFailure(error)) throw error;
      this.enterFatal();
      throw managerStorageError();
    }
  }

  get(id: string): HubJobSnapshot | null {
    this.assertReadable();
    try {
      return this.localState.getHubJob(id);
    } catch (error) {
      if (isValidationFailure(error)) throw error;
      this.enterFatal();
      throw managerStorageError();
    }
  }

  start(request: HubJobStartRequest): HubJobSnapshot {
    this.assertOperational();
    const kind = validateRequestedKind(request?.kind);
    const executor = this.executors[kind];
    if (!executor) throw capabilityUnavailable(kind);

    const createdAt = this.now();
    const id = this.generateId(new Date(createdAt).valueOf());
    let queued: HubJobSnapshot;
    try {
      queued = this.localState.createHubJobRecord({
        leaseToken: this.leaseToken,
        id,
        kind,
        phase: "queued",
        createdAt,
      });
    } catch (error) {
      if (isExpectedStartError(error)) throw error;
      this.enterFatal();
      throw managerStorageError();
    }
    const execution: ActiveExecution = {
      generation: queued.generation,
      controller: new AbortController(),
      userCancelRequested: false,
      shutdownRequested: false,
      failureRequested: false,
      settled: false,
      terminalReported: false,
    };
    this.executions.set(queued.id, execution);
    execution.promise = Promise.resolve()
      .then(() => this.execute(queued, executor, execution, request.migrationPreview))
      .catch((error: unknown) => {
        this.handleUnexpectedExecutionFailure(queued.id, execution, error);
      })
      .finally(() => {
        execution.settled = true;
        this.releaseExecutionIfTerminal(queued.id, execution);
      });
    return queued;
  }

  cancel(id: string): HubJobSnapshot {
    this.assertOperational();
    const current = this.requireJob(id);
    if (isTerminal(current)) return current;

    const execution = this.executions.get(current.id);
    if (!execution || execution.generation !== current.generation) {
      this.enterFatal();
      throw managerStorageError();
    }
    if (current.state === "queued") {
      try {
        const interrupted = this.localState.updateHubJobRecord({
          leaseToken: this.leaseToken,
          id: current.id,
          generation: current.generation,
          expectedRevision: current.revision,
          phase: "interrupted",
          progress: current.progress,
          cancelRequested: true,
          state: "interrupted",
          finishedAt: this.now(),
          interruptedReason: "user_cancelled",
        });
        execution.userCancelRequested = true;
        execution.controller.abort();
        this.publish(interrupted, "terminal");
        return interrupted;
      } catch (error) {
        this.enterFatal();
        throw managerStorageError();
      }
    }
    if (current.cancelRequested) return current;

    try {
      const requested = this.localState.updateHubJobRecord({
        leaseToken: this.leaseToken,
        id: current.id,
        generation: current.generation,
        expectedRevision: current.revision,
        phase: current.phase,
        progress: current.progress,
        cancelRequested: true,
        state: "running",
        startedAt: current.startedAt!,
      });
      execution.userCancelRequested = true;
      execution.controller.abort();
      this.publish(requested, "progress");
      return requested;
    } catch (error) {
      this.enterFatal();
      throw managerStorageError();
    }
  }

  subscribe(id: string, listener: HubJobListener): () => void {
    this.assertReadable();
    if (typeof listener !== "function") {
      throw invalidJobRequest("A Hub job subscriber must be a function.");
    }
    const current = this.requireJob(id);
    const listeners = this.listeners.get(current.id) ?? new Set<HubJobListener>();
    listeners.add(listener);
    this.listeners.set(current.id, listeners);
    callListener(listener, { type: "snapshot", job: current });

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(current.id);
    };
  }

  /** Stops accepting work, aborts executors, settles durable state, then releases the lease. */
  shutdown(): Promise<void> {
    if (this.lifecycle === "new" || this.lifecycle === "closed") return Promise.resolve();
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown().finally(() => {
      this.shutdownPromise = undefined;
    });
    return this.shutdownPromise;
  }

  private async execute(
    queued: HubJobSnapshot,
    executor: HubJobExecutor,
    execution: ActiveExecution,
    migrationPreview?: string,
  ): Promise<void> {
    if (execution.controller.signal.aborted) return;
    let running: HubJobSnapshot;
    try {
      running = this.localState.updateHubJobRecord({
        leaseToken: this.leaseToken,
        id: queued.id,
        generation: queued.generation,
        expectedRevision: queued.revision,
        phase: "running",
        progress: null,
        cancelRequested: false,
        state: "running",
        startedAt: this.now(),
      });
      this.publish(running, "progress");
    } catch (error) {
      if (execution.controller.signal.aborted && this.isDurablyTerminal(queued.id, execution)) return;
      throw error;
    }

    let executorFailed = false;
    try {
      await executor({
        migrationPreview,
        job: running,
        signal: execution.controller.signal,
        reportProgress: (update) => this.reportProgress(running.id, running.generation, update),
      });
    } catch {
      executorFailed = true;
    }

    const current = this.readOwnedActiveJob(running.id, execution);
    if (current === null) return;
    if (execution.userCancelRequested || current.cancelRequested) {
      const interrupted = this.persistInterrupted(current, "user_cancelled", true);
      this.publish(interrupted, "terminal");
      return;
    }
    if (execution.shutdownRequested) {
      const interrupted = this.persistInterrupted(
        current,
        "process_shutdown",
        current.cancelRequested,
      );
      this.publish(interrupted, "terminal");
      return;
    }
    if (executorFailed || execution.failureRequested) {
      this.persistFailed(current);
      return;
    }
    const succeeded = this.localState.updateHubJobRecord({
      leaseToken: this.leaseToken,
      id: current.id,
      generation: current.generation,
      expectedRevision: current.revision,
      phase: "complete",
      progress: current.progress,
      cancelRequested: false,
      state: "succeeded",
      startedAt: current.startedAt!,
      finishedAt: this.now(),
    });
    this.publish(succeeded, "terminal");
  }

  private reportProgress(
    id: string,
    generation: number,
    update: HubJobProgressUpdate,
  ): void {
    const execution = this.executions.get(id);
    if (
      !execution
      || execution.generation !== generation
      || execution.controller.signal.aborted
    ) {
      return;
    }
    const safeUpdate = validateExecutorProgressUpdate(update);
    let current: HubJobSnapshot | null;
    try {
      current = this.localState.getHubJob(id);
    } catch (error) {
      if (!isValidationFailure(error)) this.enterFatal();
      throw error;
    }
    if (!current || current.generation !== generation || current.state !== "running") return;

    const progress = safeUpdate.completed === undefined
      ? current.progress
      : {
          completed: safeUpdate.completed,
          ...(safeUpdate.total === undefined && current.progress?.total !== undefined
            ? { total: current.progress.total }
            : safeUpdate.total === undefined ? {} : { total: safeUpdate.total }),
        };
    const phase = safeUpdate.phase ?? current.phase;
    if (phase === current.phase && sameJobProgress(progress, current.progress)) return;
    try {
      const updated = this.localState.updateHubJobRecord({
        leaseToken: this.leaseToken,
        id: current.id,
        generation,
        expectedRevision: current.revision,
        phase,
        progress,
        cancelRequested: current.cancelRequested,
        state: "running",
        startedAt: current.startedAt!,
      });
      this.publish(updated, "progress");
    } catch (error) {
      if (execution.controller.signal.aborted) return;
      if (!isValidationFailure(error)) this.enterFatal();
      throw error;
    }
  }

  private async performShutdown(): Promise<void> {
    this.lifecycle = "closing";
    for (const [id, execution] of this.executions) {
      execution.shutdownRequested = true;
      try {
        const current = this.localState.getHubJob(id);
        if (current?.state === "queued") {
          const interrupted = this.persistInterrupted(
            current,
            execution.userCancelRequested ? "user_cancelled" : "process_shutdown",
            execution.userCancelRequested,
          );
          this.publish(interrupted, "terminal");
        }
      } catch {
        this.enterFatal();
      }
      execution.controller.abort();
    }

    const promises = [...this.executions.values()]
      .map((execution) => execution.promise)
      .filter((promise): promise is Promise<void> => promise !== undefined);
    try {
      await withTimeout(Promise.all(promises).then(() => undefined), this.shutdownTimeoutMs);
    } catch {
      this.lifecycle = "fatal";
      throw shutdownTimeoutError();
    }

    for (const [id, execution] of [...this.executions]) {
      if (!execution.settled) continue;
      try {
        const current = this.localState.getHubJob(id);
        if (current && !isTerminal(current)) {
          const interrupted = this.persistInterrupted(
            current,
            execution.userCancelRequested ? "user_cancelled" : "process_shutdown",
            execution.userCancelRequested || current.cancelRequested,
          );
          this.publish(interrupted, "terminal");
        }
        this.releaseExecutionIfTerminal(id, execution);
      } catch {
        this.enterFatal();
      }
    }

    let active: HubJobSnapshot | null;
    try {
      active = this.localState.getActiveHubJob();
    } catch {
      this.enterFatal();
      throw managerStorageError();
    }
    if (active || [...this.executions.values()].some((execution) => !execution.settled)) {
      this.lifecycle = "fatal";
      throw managerStorageError();
    }
    try {
      this.localState.releaseHubJobLease(this.leaseToken);
    } catch {
      this.enterFatal();
      throw managerStorageError();
    }
    this.lifecycle = "closed";
    this.listeners.clear();
  }

  private readOwnedActiveJob(
    id: string,
    execution: ActiveExecution,
  ): HubJobSnapshot | null {
    const current = this.localState.getHubJob(id);
    if (
      !current
      || current.generation !== execution.generation
    ) {
      throw managerStorageError();
    }
    return isTerminal(current) ? null : current;
  }

  private persistInterrupted(
    current: HubJobSnapshot,
    reason: "user_cancelled" | "process_shutdown",
    cancelRequested: boolean,
  ): HubJobSnapshot {
    return this.localState.updateHubJobRecord({
      leaseToken: this.leaseToken,
      id: current.id,
      generation: current.generation,
      expectedRevision: current.revision,
      phase: "interrupted",
      progress: current.progress,
      cancelRequested,
      state: "interrupted",
      ...(current.startedAt === undefined ? {} : { startedAt: current.startedAt }),
      finishedAt: this.now(),
      interruptedReason: reason,
    });
  }

  private persistFailed(current: HubJobSnapshot): HubJobSnapshot {
    const failed = this.localState.updateHubJobRecord({
      leaseToken: this.leaseToken,
      id: current.id,
      generation: current.generation,
      expectedRevision: current.revision,
      phase: "failed",
      progress: current.progress,
      cancelRequested: false,
      state: "failed",
      startedAt: current.startedAt ?? current.createdAt,
      finishedAt: this.now(),
      problem: GENERIC_JOB_PROBLEM,
    });
    this.publish(failed, "terminal");
    return failed;
  }

  private handleUnexpectedExecutionFailure(
    id: string,
    execution: ActiveExecution,
    _error: unknown,
  ): void {
    this.enterFatal();
    try {
      const current = this.localState.getHubJob(id);
      if (
        !current
        || current.generation !== execution.generation
        || isTerminal(current)
      ) {
        return;
      }
      if (execution.userCancelRequested || current.cancelRequested) {
        const interrupted = this.persistInterrupted(current, "user_cancelled", true);
        this.publish(interrupted, "terminal");
      } else if (execution.shutdownRequested) {
        const interrupted = this.persistInterrupted(current, "process_shutdown", false);
        this.publish(interrupted, "terminal");
      } else {
        this.persistFailed(current);
      }
    } catch {
      // Keep the execution handle and durable active slot. A later shutdown may
      // retry, while the repository lease prevents unsafe concurrent recovery.
    }
  }

  private isDurablyTerminal(id: string, execution: ActiveExecution): boolean {
    try {
      const current = this.localState.getHubJob(id);
      return current !== null
        && current.generation === execution.generation
        && isTerminal(current);
    } catch {
      this.enterFatal();
      return false;
    }
  }

  private releaseExecutionIfTerminal(id: string, execution: ActiveExecution): void {
    if (this.executions.get(id) !== execution || !execution.settled) return;
    try {
      const current = this.localState.getHubJob(id);
      if (
        current
        && current.generation === execution.generation
        && isTerminal(current)
      ) {
        this.executions.delete(id);
      } else if (!current || current.generation !== execution.generation) {
        this.enterFatal();
      }
    } catch {
      this.enterFatal();
    }
  }

  private enterFatal(): void {
    if (this.lifecycle === "closed") return;
    this.lifecycle = "fatal";
    for (const execution of this.executions.values()) {
      execution.failureRequested = true;
      execution.controller.abort();
    }
  }

  private requireJob(id: string): HubJobSnapshot {
    let job: HubJobSnapshot | null;
    try {
      job = this.localState.getHubJob(id);
    } catch (error) {
      if (isValidationFailure(error)) throw error;
      this.enterFatal();
      throw managerStorageError();
    }
    if (job) return job;
    throw new HubJobError({
      status: 404,
      code: "NOT_FOUND",
      title: "Hub job not found",
      detail: "The requested Hub job does not exist in this project.",
    });
  }

  private publish(job: HubJobSnapshot, type: HubJobEventType): void {
    const execution = this.executions.get(job.id);
    if (type === "terminal" && isTerminal(job) && execution
      && execution.generation === job.generation && !execution.terminalReported) {
      execution.terminalReported = true;
      emitHubTelemetry(this.telemetry, "hub.job_completed", {
        job_kind: job.kind,
        // Orderly shutdown and user cancellation both interrupt active work.
        // Historical startup reconciliation is deliberately not reported.
        outcome: job.state === "succeeded" ? "success" : job.state === "failed" ? "failure" : "cancelled",
        duration_ms: boundedHubDuration(Date.parse(job.finishedAt!) - Date.parse(job.startedAt ?? job.createdAt)),
      });
    }
    const listeners = this.listeners.get(job.id);
    if (!listeners) return;
    for (const listener of [...listeners]) callListener(listener, { type, job });
    if (type === "terminal") this.listeners.delete(job.id);
  }

  private assertReadable(): void {
    if (this.lifecycle !== "new") return;
    throw new HubJobError({
      status: 500,
      code: "INTERNAL_ERROR",
      title: "Hub job manager is not initialized",
      detail: "Initialize local Hub state before using the job manager.",
    });
  }

  private assertOperational(): void {
    if (this.lifecycle === "running") return;
    if (this.lifecycle === "new") this.assertReadable();
    throw managerLifecycleError(
      this.lifecycle === "closing"
        ? "The Hub job manager is shutting down and cannot accept work."
        : "The Hub job manager cannot accept work in its current state.",
    );
  }
}

export function generateHubJobId(
  timestampMs = Date.now(),
  entropy: Uint8Array = randomBytes(10),
): string {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs > MAX_ULID_TIME) {
    throw new RangeError("Hub job ULID time must be a non-negative 48-bit integer.");
  }
  if (entropy.byteLength !== 10) {
    throw new RangeError("Hub job ULID entropy must contain exactly 10 bytes.");
  }

  let time = BigInt(timestampMs);
  let encodedTime = "";
  for (let index = 0; index < 10; index += 1) {
    encodedTime = CROCKFORD_BASE32[Number(time & 31n)]! + encodedTime;
    time >>= 5n;
  }

  let random = 0n;
  for (const byte of entropy) random = (random << 8n) | BigInt(byte);
  let encodedRandom = "";
  for (let index = 0; index < 16; index += 1) {
    encodedRandom = CROCKFORD_BASE32[Number(random & 31n)]! + encodedRandom;
    random >>= 5n;
  }
  return `job_${encodedTime}${encodedRandom}`;
}

function validateRequestedKind(value: unknown): (typeof HUB_JOB_KINDS)[number] {
  if (typeof value !== "string" || !HUB_JOB_KINDS.includes(value as never)) {
    throw invalidJobRequest("The requested Hub job kind is not supported.");
  }
  return value as (typeof HUB_JOB_KINDS)[number];
}

function validateExecutorProgressUpdate(value: unknown): HubJobProgressUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidJobRequest("Executor progress must be a numeric progress object.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["completed", "total", "phase"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw invalidJobRequest("Executor progress cannot contain free-text or unknown fields.");
  }
  if (
    record.completed !== undefined
    && (!Number.isSafeInteger(record.completed) || (record.completed as number) < 0)
  ) {
    throw invalidJobRequest("Executor completed progress must be a non-negative safe integer.");
  }
  if (
    record.total !== undefined
    && (!Number.isSafeInteger(record.total) || (record.total as number) < 1)
  ) {
    throw invalidJobRequest("Executor total progress must be a positive safe integer.");
  }
  if (
    record.phase !== undefined
    && (
      typeof record.phase !== "string"
      || !HUB_JOB_PROGRESS_PHASES.includes(record.phase as never)
    )
  ) {
    throw invalidJobRequest("Executor progress phase is not allowed.");
  }
  if (record.completed === undefined && record.total !== undefined) {
    throw invalidJobRequest("Executor total progress requires completed progress.");
  }
  if (record.completed === undefined && record.phase === undefined) {
    throw invalidJobRequest("Executor progress must contain a phase or numeric progress.");
  }
  return {
    ...(record.completed === undefined ? {} : { completed: record.completed as number }),
    ...(record.total === undefined ? {} : { total: record.total as number }),
    ...(record.phase === undefined
      ? {}
      : { phase: record.phase as HubJobProgressUpdate["phase"] }),
  };
}

function isTerminal(job: HubJobSnapshot): boolean {
  return job.state === "succeeded" || job.state === "failed" || job.state === "interrupted";
}

function sameJobProgress(
  left: HubJobSnapshot["progress"],
  right: HubJobSnapshot["progress"],
): boolean {
  if (left === null || right === null) return left === right;
  return left.completed === right.completed
    && left.total === right.total
    && left.message === right.message;
}

function isValidationFailure(error: unknown): boolean {
  return error instanceof MexPortError && error.problem.code === "VALIDATION_FAILED";
}

function isExpectedStartError(error: unknown): boolean {
  return error instanceof MexPortError
    && error.problem.code === "JOB_ALREADY_RUNNING";
}

function callListener(listener: HubJobListener, event: Parameters<HubJobListener>[0]): void {
  try {
    listener(event);
  } catch {
    // A disconnected/buggy observer must not affect durable execution.
  }
}

function invalidJobRequest(detail: string): HubJobError {
  return new HubJobError({
    status: 422,
    code: "VALIDATION_FAILED",
    title: "Invalid Hub job request",
    detail,
  });
}

function capabilityUnavailable(kind: string): HubJobError {
  return new HubJobError({
    status: 503,
    code: "CAPABILITY_UNAVAILABLE",
    title: "Hub capability unavailable",
    detail: `No production executor is registered for ${kind}.`,
  });
}

function validateProcessId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidJobRequest("The Hub process ID must be a positive safe integer.");
  }
  return value;
}

function validateManagerLeaseToken(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw invalidJobRequest("The Hub lease token must be a lower-case 256-bit value.");
  }
  return value;
}

function validateShutdownTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SHUTDOWN_TIMEOUT_MS) {
    throw invalidJobRequest(
      `The Hub shutdown timeout must be between 1 and ${MAX_SHUTDOWN_TIMEOUT_MS} milliseconds.`,
    );
  }
  return value;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(shutdownTimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function translateInitializationError(error: unknown): unknown {
  if (error instanceof MexPortError && error.problem.code === "JOB_ALREADY_RUNNING") {
    return error;
  }
  return managerStorageError();
}

function managerStorageError(): HubJobError {
  return new HubJobError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Hub job state unavailable",
    detail: "The Hub could not safely update local job state. Restart it before retrying.",
  });
}

function managerLifecycleError(detail: string): HubJobError {
  return new HubJobError({
    status: 503,
    code: "OPERATION_INTERRUPTED",
    title: "Hub job manager unavailable",
    detail,
  });
}

function shutdownTimeoutError(): HubJobError {
  return new HubJobError({
    status: 503,
    code: "OPERATION_INTERRUPTED",
    title: "Hub job shutdown timed out",
    detail: "A Hub job did not settle before the bounded shutdown deadline.",
  });
}

export type {
  HubJobEvent,
  HubJobExecutor,
  HubJobExecutorContext,
  HubJobExecutors,
  HubJobInterruptionReason,
  HubJobKind,
  HubJobListRequest,
  HubJobListener,
  HubJobPage,
  HubJobProblem,
  HubJobPhase,
  HubJobProgress,
  HubJobProgressPhase,
  HubJobProgressUpdate,
  HubJobSnapshot,
  HubJobStartRequest,
} from "./types.js";
export {
  HUB_JOB_INTERRUPTION_REASONS,
  HUB_JOB_KINDS,
  HUB_JOB_PHASES,
  HUB_JOB_PROGRESS_PHASES,
  HubJobError,
} from "./types.js";
