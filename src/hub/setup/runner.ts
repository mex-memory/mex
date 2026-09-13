import { createHash, randomUUID } from "node:crypto";
import type {
  SetupRun,
  SetupStartRequest,
  SetupStatus,
  SetupTranscriptBatch,
  SetupCommitPreview,
  SetupCommitRequest,
  SetupCommitResponse,
  SetupCommitDiff,
  SetupCommitDiffRequest,
} from "@mex/hub-contracts/setup";
import { SETUP_ACTIVITY_LIMIT } from "@mex/hub-contracts/setup";
import {
  inspectSetupStatus,
  runHeadlessSetup,
  type HeadlessSetupResult,
} from "../../setup/headless.js";
import { HubHttpError } from "../http/errors.js";
import { setupCommitCheckpointCommands, SetupFinalizationError } from "../../setup/index.js";
import { SetupPopulationError } from "../../setup/population.js";
import { initialSetupStatus, projectSetupStatus } from "./readiness.js";
import { SetupTranscriptStore } from "./transcript.js";
import { SetupCommitService } from "./commit.js";
import { SetupGlobalInstaller } from "../../setup/global-install.js";

const SETUP_UNAVAILABLE = "Finish MEX setup before using this Hub workbench.";
const ACTIVITY_EMIT_INTERVAL_MS = 500;
const TRANSCRIPT_EMIT_INTERVAL_MS = 200;

export interface HubSetupRunnerOptions {
  readonly projectRoot: string;
  readonly now?: () => Date;
  readonly onReady?: (signal: AbortSignal) => void | Promise<void>;
  readonly initialMode?: "code-repo" | "agent-memory";
}

export type HubSetupListener = (run: SetupRun) => void;

export class HubSetupRunner {
  private readonly projectRoot: string;
  private readonly now: () => Date;
  private readonly onReady?: (signal: AbortSignal) => void | Promise<void>;
  private readonly initialMode?: "code-repo" | "agent-memory";
  private readonly listeners = new Set<HubSetupListener>();
  private run: SetupRun;
  private controller: AbortController | null = null;
  private queue: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptStore: SetupTranscriptStore | null = null;
  private readonly transcriptListeners = new Set<() => void>();
  private commitService: SetupCommitService | null = null;
  private commitBusy = false;
  private commitOperation: Promise<unknown> | null = null;
  private commitReceipt: { request: SetupCommitRequest; response: SetupCommitResponse } | null = null;
  private readonly installer = new SetupGlobalInstaller();

  constructor(options: HubSetupRunnerOptions) {
    this.projectRoot = options.projectRoot;
    this.now = options.now ?? (() => new Date());
    this.onReady = options.onReady;
    this.initialMode = options.initialMode;
    this.run = idleRun(this.withInitialMode(initialSetupStatus(this.projectRoot)), this.now());
  }

  async status(): Promise<SetupStatus> {
    const status = await projectSetupStatus(this.projectRoot);
    return this.run.status === "idle" ? this.withInitialMode(status) : status;
  }

  private withInitialMode(status: SetupStatus): SetupStatus {
    return this.initialMode && status.mode !== this.initialMode
      ? { ...status, mode: this.initialMode, ready: false,
        stage: this.initialMode === "code-repo" && !status.hasGit ? "needs_git" : "needs_setup" }
      : status;
  }

  snapshot(): SetupRun {
    return this.run;
  }

  installation() { return this.installer.snapshot(); }

  async installGlobally() {
    if (this.shuttingDown || this.run.status === "running" || this.commitBusy) {
      throw new HubHttpError(409, "JOB_ALREADY_RUNNING", "Setup is busy", "Wait for setup to finish before installing the command.");
    }
    const status = await this.status();
    if (this.shuttingDown || this.snapshot().status === "running" || this.commitBusy) {
      throw new HubHttpError(409, "JOB_ALREADY_RUNNING", "Setup is busy", "Wait for setup to finish before installing the command.");
    }
    if (!status.ready && status.stage !== "complete") {
      throw new HubHttpError(409, "REVISION_CONFLICT", "Setup is incomplete", "Complete setup and its commit checkpoint first.");
    }
    return this.installer.start();
  }

  subscribe(listener: HubSetupListener): () => void {
    this.listeners.add(listener);
    listener(this.run);
    return () => {
      this.listeners.delete(listener);
    };
  }

  readTranscript(runId: string, after: number): SetupTranscriptBatch {
    if (!this.transcriptStore || this.run.transcriptId !== runId) {
      throw new HubHttpError(409, "REVISION_CONFLICT", "Setup session changed", "Reconnect to the current setup session.");
    }
    return this.transcriptStore.read(after, this.run.status !== "running");
  }

  subscribeTranscript(listener: () => void): () => void {
    this.transcriptListeners.add(listener);
    listener();
    return () => { this.transcriptListeners.delete(listener); };
  }

  previewCommit(): Promise<SetupCommitPreview> {
    return this.withCommitOperation(async () => {
      await this.queue;
      const status = await this.requireCommitCheckpoint();
      return this.commits().preview(status.configuredTools);
    });
  }

  /** In-memory review read; it does not wait on or block the Git review lease. */
  commitDiff(request: SetupCommitDiffRequest): SetupCommitDiff {
    if (this.shuttingDown) throw new HubHttpError(503, "CAPABILITY_UNAVAILABLE", "Setup is stopping", "Restart the Hub before reviewing setup files.");
    if (this.commitService === null) {
      throw new HubHttpError(409, "REVISION_CONFLICT", "Review changed", "Review the setup changes again before opening a file.");
    }
    return this.commitService.diff(request);
  }

  commitSetup(request: SetupCommitRequest): Promise<SetupCommitResponse> {
    return this.withCommitOperation(async () => {
      await this.queue;
      if (this.commitReceipt?.request.revision === request.revision) {
        if (this.commitReceipt.request.message !== request.message.trim()) {
          throw new HubHttpError(409, "REVISION_CONFLICT", "Commit already saved", "This review already created a commit with a different message. Check the saved commit before continuing.");
        }
        return structuredClone(this.commitReceipt.response);
      }
      await this.requireCommitCheckpoint();
      const result = await this.commits().commit(request);
      // Retain the successful Git receipt even if readiness inspection fails.
      // Opening the Hub is a separate action after the completion guide.
      let status: SetupStatus | null = null;
      let error: string | null = result.recoveryRequired ? result.message : null;
      try {
        status = await this.status();
        if (result.recoveryRequired) {
          error = result.message;
        } else if (!status.ready) {
          error = "The setup files were committed, but setup readiness changed. Check the project and try opening the Hub again.";
        }
      } catch {
        error ??= "The setup files were committed, but readiness could not be checked. Check setup again; the commit is already saved.";
      }
      this.run = {
        ...this.run,
        status: error ? "failed" : "succeeded",
        mode: "code-repo",
        stage: status?.stage ?? "ready",
        populated: status?.populated ?? this.run.populated,
        ready: status?.ready ?? false,
        prompt: null,
        progress: null,
        message: error ?? result.message,
        error,
        finishedAt: this.now().toISOString(),
      };
      const response = { ...result, run: this.run };
      this.commitReceipt = { request: { ...request, message: request.message.trim() }, response: structuredClone(response) };
      try { this.emit(); } catch { /* A notification failure cannot undo the saved Git commit. */ }
      return response;
    });
  }

  private commits(): SetupCommitService {
    return this.commitService ??= new SetupCommitService({ projectRoot: this.projectRoot, now: this.now });
  }

  private async requireCommitCheckpoint(): Promise<SetupStatus> {
    if (this.shuttingDown) throw new HubHttpError(503, "CAPABILITY_UNAVAILABLE", "Setup is stopping", "Restart the Hub before reviewing setup files.");
    const status = await this.status();
    if (this.shuttingDown) throw new HubHttpError(503, "CAPABILITY_UNAVAILABLE", "Setup is stopping", "Restart the Hub before reviewing setup files.");
    if (status.mode !== "code-repo" || status.stage !== "needs_commit") {
      throw new HubHttpError(409, "REVISION_CONFLICT", "Setup checkpoint changed", "Finish population and check setup again before reviewing a commit.");
    }
    return status;
  }

  private withCommitOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new HubHttpError(503, "CAPABILITY_UNAVAILABLE", "Setup is stopping", "Restart the Hub before reviewing setup files."));
    if (this.commitBusy || this.run.status === "running") {
      return Promise.reject(new HubHttpError(409, "JOB_ALREADY_RUNNING", "Setup operation already running", "Wait for the current setup operation to finish."));
    }
    this.commitBusy = true;
    const pending = operation();
    this.commitOperation = pending;
    return pending.finally(() => {
      if (this.commitOperation === pending) this.commitOperation = null;
      this.commitBusy = false;
    });
  }

  start(request: SetupStartRequest): SetupRun {
    if (this.shuttingDown) {
      throw new HubHttpError(503, "CAPABILITY_UNAVAILABLE", "Setup is stopping", "Restart the Hub before starting setup again.");
    }
    if (this.run.status === "running" || this.commitBusy || this.installer.snapshot().state === "running") {
      throw new HubHttpError(
        409,
        "JOB_ALREADY_RUNNING",
        "Setup already running",
        "A setup run is already in progress for this checkout.",
      );
    }
    this.commitService?.clear();
    const status = initialSetupStatus(this.projectRoot);
    if (request.mode === "code-repo" && !status.hasGit) {
      throw new HubHttpError(
        400,
        "VALIDATION_FAILED",
        "Git repository required",
        "Initialize git first, then start setup. MEX does not run git init.",
      );
    }

    const anchorNotes = this.run.anchorNotes;
    const startedAt = this.now().toISOString();
    const controller = new AbortController();
    this.controller = controller;
    const transcriptId = randomUUID();
    this.transcriptStore = new SetupTranscriptStore(transcriptId, this.now);
    this.run = {
      status: "running",
      mode: request.mode,
      stage: status.stage,
      populated: status.populated,
      ready: false,
      selectedTools: request.tools,
      prompt: null,
      populationTool: null,
      populationCompleted: false,
      transcriptId,
      commitCommands: [],
      anchorNotes,
      message: "Starting MEX setup…",
      progress: { step: "detect", label: "Detect project state" },
      error: null,
      startedAt,
      finishedAt: null,
    };
    this.queue = this.queue.then(() => this.execute(request, controller.signal));
    this.emit();
    return this.run;
  }

  cancel(): SetupRun {
    if (this.controller && this.run.status === "running") {
      this.controller.abort();
      this.run = { ...this.run, message: "Stopping setup…" };
      this.emit();
    }
    return this.run;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.cancel();
    await this.queue;
    await this.installer.shutdown();
    await this.commitOperation?.catch(() => undefined);
    this.commitService?.clear();
    this.listeners.clear();
    this.transcriptListeners.clear();
  }

  private async execute(request: SetupStartRequest, signal: AbortSignal): Promise<void> {
    try {
      if (this.commitService) await this.commitService.verifyRecovery();
      const current = inspectSetupStatus(this.projectRoot);
      const canFinishExisting = request.confirmPopulation === true
        && current.ready && current.mode === request.mode
        && JSON.stringify(current.configuredTools) === JSON.stringify(request.tools);
      const result: HeadlessSetupResult = canFinishExisting ? {
        mode: current.mode,
        stage: current.stage,
        ready: current.ready,
        populated: current.populated,
        selectedTools: current.configuredTools,
        prompt: null,
        populationTool: null,
        populationCompleted: true,
        commitCommands: current.mode === "code-repo" ? setupCommitCheckpointCommands(current.configuredTools) : [],
        anchorNotes: this.run.anchorNotes,
        message: "Setup is complete.",
      } : await runHeadlessSetup({
        projectRoot: this.projectRoot,
        mode: request.mode,
        tools: request.tools,
        ...(request.confirmPopulation === undefined ? {} : { confirmPopulation: request.confirmPopulation }),
        signal,
        onPopulationPrompt: (prompt) => { this.run = { ...this.run, prompt }; },
        onAnchorNotes: (anchorNotes) => { this.run = { ...this.run, anchorNotes: [...anchorNotes] }; },
        onPopulationTranscript: (entry) => {
          if (signal.aborted || this.run.status !== "running" || this.controller?.signal !== signal) return;
          this.transcriptStore?.append({ kind: entry.kind, text: entry.text });
          if (this.transcriptTimer === null) {
            this.transcriptTimer = setTimeout(() => this.notifyTranscript(), TRANSCRIPT_EMIT_INTERVAL_MS);
            this.transcriptTimer.unref();
          }
        },
        onPopulationActivity: (activity) => {
          if (signal.aborted || this.run.status !== "running" || this.controller?.signal !== signal) return;
          const at = this.now().toISOString();
          const previous = this.run.populationActivity;
          const events = previous?.events ?? [];
          const last = events.at(-1);
          const changed = !last || last.kind !== activity.kind || last.state !== activity.state || last.target !== activity.target;
          const totalEvents = Math.min(Number.MAX_SAFE_INTEGER, (previous?.totalEvents ?? 0) + (changed ? 1 : 0));
          this.run = {
            ...this.run,
            populationTool: activity.tool,
            populationActivity: {
              tool: activity.tool,
              startedAt: previous?.startedAt ?? at,
              // Process startup is not proof that the agent has reported work.
              lastActivityAt: activity.kind === "starting" ? previous?.lastActivityAt ?? null : at,
              totalEvents,
              events: changed ? [...events.slice(-(SETUP_ACTIVITY_LIMIT - 1)), {
                id: totalEvents, at, kind: activity.kind, state: activity.state,
                ...(activity.target === undefined ? {} : { target: activity.target }),
              }] : events,
            },
          };
          if (!previous) this.emit();
          else if (this.activityTimer === null) {
            this.activityTimer = setTimeout(() => {
              this.activityTimer = null;
              if (!signal.aborted && this.run.status === "running" && this.controller?.signal === signal) this.emit();
            }, ACTIVITY_EMIT_INTERVAL_MS);
            this.activityTimer.unref();
          }
        },
        onProgress: (update) => {
          if (signal.aborted || this.run.status !== "running" || this.controller?.signal !== signal) return;
          this.run = {
            ...this.run,
            progress: {
              step: update.step,
              label: update.label,
              ...(update.detail === undefined ? {} : { detail: update.detail }),
            },
            message: update.detail ?? update.label,
          };
          this.emit();
        },
      });
      if (signal.aborted) throw new Error("Setup was cancelled.");
      await this.finishFromResult(result, signal, request.openHub === true);
    } catch (error) {
      // Child output and arbitrary filesystem exceptions are never a browser payload.
      const message = signal.aborted ? "Setup was cancelled. You can resume it when ready."
        : error instanceof SetupPopulationError || error instanceof SetupFinalizationError || error instanceof HubHttpError ? error.message
        : "Setup could not finish. Run mex setup --cli in this project for details, then retry.";
      this.run = {
        ...this.run,
        status: signal.aborted ? "cancelled" : "failed",
        ready: false,
        message,
        error: signal.aborted ? null : message.slice(0, 512),
        finishedAt: this.now().toISOString(),
        progress: this.run.progress,
      };
      this.emit();
    } finally {
      if (this.controller?.signal === signal) this.controller = null;
    }
  }

  private async finishFromResult(result: HeadlessSetupResult, signal: AbortSignal, openHub: boolean): Promise<void> {
    const status = await this.status();
    if (signal.aborted) throw new Error("Setup was cancelled.");
    if (status.ready && openHub && this.onReady) {
      await this.onReady(signal);
      if (signal.aborted) throw new Error("Setup was cancelled.");
    }
    const paused = status.stage === "needs_population" || status.stage === "needs_commit";
    const message = status.stage === "needs_commit"
      ? "Graph and Wiki are ready. Review and commit the canonical MEX files, then check again to open the Hub."
      : status.stage === "complete"
        ? "Agent memory is ready. Your selected AI tools can use this workspace."
        : result.message;
    this.run = {
      status: paused ? "paused" : result.ready || result.populated ? "succeeded" : "paused",
      mode: result.mode,
      stage: status.stage,
      populated: result.populated,
      ready: status.ready,
      selectedTools: result.selectedTools,
      prompt: result.prompt,
      populationTool: result.populationTool,
      populationCompleted: result.populationCompleted,
      ...(this.run.populationActivity === undefined ? {} : { populationActivity: this.run.populationActivity }),
      ...(this.run.transcriptId === undefined ? {} : { transcriptId: this.run.transcriptId }),
      commitCommands: result.commitCommands,
      anchorNotes: result.anchorNotes,
      message,
      progress: this.run.progress,
      error: null,
      startedAt: this.run.startedAt,
      finishedAt: this.now().toISOString(),
    };
    this.emit();
  }

  private emit(): void {
    if (this.activityTimer !== null) {
      clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
    for (const listener of this.listeners) listener(this.run);
    this.notifyTranscript();
  }

  private notifyTranscript(): void {
    if (this.transcriptTimer !== null) {
      clearTimeout(this.transcriptTimer);
      this.transcriptTimer = null;
    }
    // Subscribers carry only a wake-up signal; each stream reads bounded pages
    // using its own cursor instead of retaining another copy of CLI output.
    for (const listener of this.transcriptListeners) listener();
  }
}

export { projectSetupStatus } from "./readiness.js";

export function setupWorkbenchReason(): string {
  return SETUP_UNAVAILABLE;
}

export function setupSnapshotRevision(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function idleRun(status: SetupStatus, now: Date): SetupRun {
  return {
    status: "idle",
    mode: status.mode,
    stage: status.stage,
    populated: status.populated,
    ready: status.ready,
    selectedTools: status.configuredTools,
    prompt: null,
    populationTool: null,
    populationCompleted: false,
    commitCommands: status.commitCommands,
    anchorNotes: [],
    message: status.ready
      ? "MEX setup is complete for this checkout."
      : "MEX is not set up in this checkout yet.",
    progress: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}
