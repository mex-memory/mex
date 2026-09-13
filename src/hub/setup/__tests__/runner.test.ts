import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupRunSchema } from "@mex/hub-contracts/setup";
import type { HeadlessSetupOptions } from "../../../setup/headless.js";
import { SetupPopulationError } from "../../../setup/population.js";
import { SetupFinalizationError } from "../../../setup/index.js";

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), execute: vi.fn(), status: vi.fn(), initial: vi.fn() }));
vi.mock("../../../setup/headless.js", () => ({ inspectSetupStatus: mocks.inspect, runHeadlessSetup: mocks.execute }));
vi.mock("../readiness.js", () => ({ initialSetupStatus: mocks.initial, projectSetupStatus: mocks.status }));

import { HubSetupRunner } from "../runner.js";

const status = {
  mode: "code-repo", projectName: "Test", hasGit: true, hasScaffold: true,
  populated: false, graphReady: true, wikiReady: false, state: "existing",
  stage: "needs_population", configuredTools: ["codex"], tools: [], ready: false, commitCommands: [],
};
const result = {
  mode: "code-repo", stage: "ready", populated: true, ready: true,
  selectedTools: ["codex"], prompt: null, populationTool: "codex", populationCompleted: true,
  commitCommands: ["git add .mex", 'git commit -m "Initialize MEX"'], anchorNotes: [], message: "Setup complete.",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.initial.mockReturnValue(status);
  mocks.inspect.mockReturnValue(status);
  mocks.status.mockResolvedValue(status);
});
afterEach(() => vi.useRealTimers());

describe("setup run lifecycle", () => {
  it("honors an explicit mode on both idle reads without reusing another mode's commit checkpoint", async () => {
    const completedCode = { ...status, populated: true, stage: "needs_commit" };
    mocks.initial.mockReturnValue(completedCode);
    mocks.status.mockResolvedValue({ ...completedCode, stage: "ready", ready: true });
    const runner = new HubSetupRunner({ projectRoot: "/test", initialMode: "agent-memory" });
    expect(runner.snapshot()).toMatchObject({ mode: "agent-memory", stage: "needs_setup", ready: false });
    expect(await runner.status()).toMatchObject({ mode: "agent-memory", stage: "needs_setup", ready: false });
    expect(mocks.execute).not.toHaveBeenCalled();
    await runner.shutdown();
  });

  it("refuses a global install before setup is complete and rechecks shutdown after awaiting status", async () => {
    const runner = new HubSetupRunner({ projectRoot: "/test" });
    await expect(runner.installGlobally()).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    let finish!: (value: unknown) => void;
    mocks.status.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const installing = runner.installGlobally();
    const rejected = expect(installing).rejects.toMatchObject({ code: "JOB_ALREADY_RUNNING" });
    await runner.shutdown();
    finish({ ...status, stage: "ready", ready: true });
    await rejected;
    expect(runner.installation().state).toBe("idle");
  });

  it("retains separate transcript pages, batches notifications, and isolates new runs and late output", async () => {
    vi.useFakeTimers();
    let report!: NonNullable<HeadlessSetupOptions["onPopulationTranscript"]>;
    let finish!: () => void;
    mocks.execute.mockImplementation((options: HeadlessSetupOptions) => {
      report = options.onPopulationTranscript!;
      return new Promise((resolve) => { finish = () => resolve(result); });
    });
    const runner = new HubSetupRunner({ projectRoot: "/test" });
    const run = runner.start({ mode: "code-repo", tools: ["codex"] });
    await Promise.resolve();
    const listener = vi.fn();
    const unsubscribe = runner.subscribeTranscript(listener);
    for (let i = 0; i < 50; i++) report({ tool: "codex", kind: "assistant", text: `Session message ${i}\n` });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(runner.snapshot())).not.toContain("Session message");
    expect(runner.readTranscript(run.transcriptId!, 0)).toMatchObject({ cursor: 32, done: false });
    await vi.advanceTimersByTimeAsync(200);
    expect(listener).toHaveBeenCalledTimes(2);
    runner.cancel();
    const cancelledReport = report;
    cancelledReport({ tool: "codex", kind: "assistant", text: "Late private output" });
    finish();
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("cancelled"));
    expect(runner.readTranscript(run.transcriptId!, 32)).toMatchObject({ cursor: 50, done: true });
    const next = runner.start({ mode: "code-repo", tools: ["claude"] });
    await Promise.resolve();
    expect(next.transcriptId).not.toBe(run.transcriptId);
    expect(() => runner.readTranscript(run.transcriptId!, 0)).toThrow("Reconnect");
    cancelledReport({ tool: "codex", kind: "assistant", text: "Prior session" });
    expect(runner.readTranscript(next.transcriptId!, 0).entries).toEqual([]);
    report({ tool: "claude", kind: "command", text: "Ran a command" });
    runner.cancel();
    finish();
    await runner.shutdown();
    expect(runner.readTranscript(next.transcriptId!, 0).entries.map((entry) => entry.text)).toEqual(["Ran a command"]);
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
  });

  it.each(["claude", "codex"] as const)("streams bounded %s activity before completion and preserves it for reconnects", async (tool) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:00:00.000Z"));
    let report!: NonNullable<HeadlessSetupOptions["onPopulationActivity"]>;
    let progress!: NonNullable<HeadlessSetupOptions["onProgress"]>;
    let finish!: () => void;
    mocks.execute.mockImplementation((options: HeadlessSetupOptions) => {
      report = options.onPopulationActivity!;
      progress = options.onProgress!;
      return new Promise((resolve) => { finish = () => resolve({ ...result, populationTool: tool }); });
    });
    const runner = new HubSetupRunner({ projectRoot: "/test" });
    const listener = vi.fn();
    runner.subscribe(listener);
    runner.start({ mode: "code-repo", tools: [tool] });
    await Promise.resolve();
    report({ tool, kind: "starting", state: "running" });
    const startupEmissions = listener.mock.calls.length;
    expect(runner.snapshot().populationActivity).toMatchObject({ tool, lastActivityAt: null, totalEvents: 1 });
    for (let i = 0; i < 100; i++) {
      const activity = {
        tool, kind: i % 2 ? "writing" as const : "reading" as const,
        state: "completed" as const, target: "architecture" as const,
        text: "private prompt and /secret/project/path",
      };
      report(activity);
    }
    // Fast CLI output cannot flood subscribers, and the GET snapshot is current.
    expect(listener).toHaveBeenCalledTimes(startupEmissions);
    const snapshot = SetupRunSchema.parse(runner.snapshot());
    expect(snapshot.status).toBe("running");
    expect(snapshot.populationActivity?.events).toHaveLength(40);
    expect(snapshot.populationActivity?.totalEvents).toBe(101);
    expect(snapshot.populationActivity?.events.at(-1)?.id).toBe(101);
    expect(JSON.stringify(snapshot)).not.toMatch(/private prompt|secret\/project/);
    const reconnect = vi.fn();
    const disconnect = runner.subscribe(reconnect);
    expect(reconnect).toHaveBeenCalledWith(snapshot);
    disconnect();
    await vi.advanceTimersByTimeAsync(500);
    expect(listener).toHaveBeenCalledTimes(startupEmissions + 1);
    finish();
    await runner.shutdown();
    expect(runner.snapshot().populationActivity).toEqual(snapshot.populationActivity);
    const terminal = runner.snapshot();
    report({ tool, kind: "writing", state: "completed" });
    progress({ step: "finalize", label: "Late phase" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runner.snapshot()).toBe(terminal);
  });

  it("keeps quiet time truthful, coalesces repeated work, and flushes terminal activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:00:00.000Z"));
    let report!: NonNullable<HeadlessSetupOptions["onPopulationActivity"]>;
    let finish!: () => void;
    mocks.execute.mockImplementation((options: HeadlessSetupOptions) => {
      report = options.onPopulationActivity!;
      return new Promise((resolve) => { finish = () => resolve(result); });
    });
    const runner = new HubSetupRunner({ projectRoot: "/test" });
    runner.start({ mode: "code-repo", tools: ["codex"] });
    await Promise.resolve();
    report({ tool: "codex", kind: "starting", state: "running" });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(runner.snapshot().populationActivity?.lastActivityAt).toBeNull();
    report({ tool: "codex", kind: "working", state: "running" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.snapshot().populationActivity?.lastActivityAt).toBe("2026-09-10T12:01:30.000Z");
    report({ tool: "codex", kind: "working", state: "running" });
    expect(runner.snapshot().populationActivity?.events).toHaveLength(2);
    expect(runner.snapshot().populationActivity?.lastActivityAt).toBe("2026-09-10T12:01:40.000Z");
    report({ tool: "codex", kind: "completed", state: "completed" });
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.snapshot()).toMatchObject({ status: "paused", populationActivity: { totalEvents: 3 } });
    expect(runner.snapshot().populationActivity?.events.at(-1)?.kind).toBe("completed");
    await runner.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an active slot while execution and promotion finish", async () => {
    let finish!: (value: typeof result) => void;
    mocks.execute.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    mocks.status.mockResolvedValue({ ...status, stage: "ready", populated: true, ready: true });
    let finishPromotion!: () => void;
    const onReady = vi.fn(() => new Promise<void>((resolve) => { finishPromotion = resolve; }));
    const runner = new HubSetupRunner({ projectRoot: "/test", onReady });
    expect(runner.start({ mode: "code-repo", tools: ["codex"], openHub: true }).status).toBe("running");
    expect(() => runner.start({ mode: "code-repo", tools: [] })).toThrow("already in progress");
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    finish(result);
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(runner.snapshot().status).toBe("running");
    finishPromotion();
    await vi.waitFor(() => expect(runner.snapshot()).toMatchObject({ status: "succeeded", ready: true }));
    await runner.shutdown();
  });

  it("reports failed population as failure with safe diagnostics", async () => {
    mocks.execute.mockImplementation(async (options) => {
      options.onPopulationPrompt("Read the project and populate its MEX scaffold.");
      options.onAnchorNotes(["Add a MEX pointer to your existing instructions."]);
      throw new SetupPopulationError("Codex could not authenticate. Sign in to Codex and retry setup.");
    });
    const runner = new HubSetupRunner({ projectRoot: "/test" });
    runner.start({ mode: "code-repo", tools: ["codex"] });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("failed"));
    expect(runner.snapshot()).toMatchObject({ prompt: "Read the project and populate its MEX scaffold.", anchorNotes: ["Add a MEX pointer to your existing instructions."], error: expect.stringContaining("authenticate") });
    await runner.shutdown();
  });

  it("reports a finalization failure's authored remediation instead of a generic failure", async () => {
    mocks.execute.mockRejectedValue(new SetupFinalizationError(
      "Grounding finalization failed: 1 authored grounding reference could not be verified against the code graph. "
        + "Skipped grounding baseline for unavailable node <exact-node-id> in .mex/AGENTS.md.",
    ));
    const runner = new HubSetupRunner({ projectRoot: "/test" });
    runner.start({ mode: "code-repo", tools: ["claude"] });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("failed"));
    expect(runner.snapshot().error).toContain("<exact-node-id> in .mex/AGENTS.md");
    expect(runner.snapshot().error).not.toContain("Run mex setup in this project for details");
    await runner.shutdown();
  });

  it("does not serialize an arbitrary internal failure into the browser", async () => {
    mocks.execute.mockRejectedValue(new Error("secret token in /private/project/file.md"));
    const runner = new HubSetupRunner({ projectRoot: "/test" });
    runner.start({ mode: "code-repo", tools: [] });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("failed"));
    expect(JSON.stringify(runner.snapshot())).not.toMatch(/secret token|\/private\/project/);
    await runner.shutdown();
  });

  it("stays at a commit checkpoint instead of attempting premature promotion", async () => {
    mocks.execute.mockResolvedValue(result);
    mocks.status.mockResolvedValue({ ...status, stage: "needs_commit", populated: true });
    const onReady = vi.fn();
    const runner = new HubSetupRunner({ projectRoot: "/test", onReady });
    runner.start({ mode: "code-repo", tools: ["codex"] });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("paused"));
    expect(runner.snapshot()).toMatchObject({ stage: "needs_commit", ready: false, commitCommands: result.commitCommands });
    expect(onReady).not.toHaveBeenCalled();
    await runner.shutdown();
  });

  it("checks an already completed setup without rebuilding or relaunching its agent", async () => {
    mocks.inspect.mockReturnValue({ ...status, ready: true, populated: true, stage: "ready" });
    mocks.status.mockResolvedValue({ ...status, ready: true, populated: true, stage: "ready" });
    const onReady = vi.fn();
    const runner = new HubSetupRunner({ projectRoot: "/test", onReady });
    runner.start({ mode: "code-repo", tools: ["codex"], confirmPopulation: true });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("succeeded"));
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    runner.start({ mode: "code-repo", tools: ["codex"], confirmPopulation: true, openHub: true });
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(mocks.execute).not.toHaveBeenCalled();
    await runner.shutdown();
  });

  it("keeps completed Agent memory free of commit commands and Hub promotion", async () => {
    mocks.inspect.mockReturnValue({ ...status, mode: "agent-memory", ready: true, populated: true, stage: "ready" });
    mocks.status.mockResolvedValue({ ...status, mode: "agent-memory", ready: false, populated: true, stage: "complete" });
    const onReady = vi.fn();
    const runner = new HubSetupRunner({ projectRoot: "/test", onReady });
    runner.start({ mode: "agent-memory", tools: ["codex"], confirmPopulation: true });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("succeeded"));
    expect(runner.snapshot()).toMatchObject({ stage: "complete", commitCommands: [], ready: false });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    await runner.shutdown();
  });

  it("passes cancellation through pending promotion", async () => {
    mocks.execute.mockResolvedValue(result);
    mocks.status.mockResolvedValue({ ...status, ready: true, stage: "ready" });
    let release!: () => void;
    let promotionSignal!: AbortSignal;
    const onReady = vi.fn((signal: AbortSignal) => {
      promotionSignal = signal;
      return new Promise<void>((resolve) => { release = resolve; });
    });
    const runner = new HubSetupRunner({ projectRoot: "/test", onReady });
    runner.start({ mode: "code-repo", tools: ["codex"], openHub: true });
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    runner.cancel();
    expect(promotionSignal.aborted).toBe(true);
    release();
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("cancelled"));
    expect(runner.snapshot().ready).toBe(false);
    await runner.shutdown();
  });

  it("retains cancellation ownership when a terminal listener starts the next run", async () => {
    let secondSignal!: AbortSignal;
    let finishSecond!: () => void;
    mocks.execute.mockResolvedValueOnce({ ...result, ready: false });
    mocks.execute.mockImplementationOnce((options: { signal: AbortSignal }) => {
      secondSignal = options.signal;
      return new Promise((resolve) => { finishSecond = () => resolve(result); });
    });
    const runner = new HubSetupRunner({ projectRoot: "/test" });
    let restarted = false;
    runner.subscribe((run) => {
      if (run.status === "paused" && !restarted) {
        restarted = true;
        runner.start({ mode: "code-repo", tools: ["codex"] });
      }
    });
    runner.start({ mode: "code-repo", tools: ["codex"] });
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(2));
    expect(runner.snapshot().status).toBe("running");
    runner.cancel();
    expect(secondSignal.aborted).toBe(true);
    finishSecond();
    await runner.shutdown();
    expect(runner.snapshot().status).toBe("cancelled");
  });

  it("surfaces promotion failure instead of emitting a successful terminal event", async () => {
    mocks.execute.mockResolvedValue(result);
    mocks.status.mockResolvedValue({ ...status, ready: true, stage: "ready" });
    const runner = new HubSetupRunner({ projectRoot: "/test", onReady: async () => { throw new Error("private failure"); } });
    runner.start({ mode: "code-repo", tools: ["codex"], openHub: true });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("failed"));
    expect(runner.snapshot().ready).toBe(false);
    await runner.shutdown();
  });

  it("cancels and waits for active work before finishing shutdown", async () => {
    let release!: () => void;
    let signal!: AbortSignal;
    mocks.execute.mockImplementation((options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise((resolve) => { release = () => resolve(result); });
    });
    const onReady = vi.fn();
    const runner = new HubSetupRunner({ projectRoot: "/test", onReady });
    runner.start({ mode: "code-repo", tools: ["codex"] });
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = runner.shutdown().then(() => { stopped = true; });
    expect(signal.aborted).toBe(true);
    expect(stopped).toBe(false);
    expect(() => runner.start({ mode: "code-repo", tools: [] })).toThrow("Restart the Hub");
    release();
    await stopping;
    expect(runner.snapshot()).toMatchObject({ status: "cancelled", ready: false, error: null });
    expect(onReady).not.toHaveBeenCalled();
  });
});
