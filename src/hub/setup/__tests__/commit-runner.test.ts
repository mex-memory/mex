import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupCommitRequest, SetupStatus } from "@mex/hub-contracts/setup";
import { HubHttpError } from "../../http/errors.js";

const mocks = vi.hoisted(() => ({ status: vi.fn(), initial: vi.fn(), inspect: vi.fn(), execute: vi.fn(), preview: vi.fn(), commit: vi.fn(), clear: vi.fn(), verifyRecovery: vi.fn() }));
vi.mock("../../../setup/headless.js", () => ({ inspectSetupStatus: mocks.inspect, runHeadlessSetup: mocks.execute }));
vi.mock("../readiness.js", () => ({ initialSetupStatus: mocks.initial, projectSetupStatus: mocks.status }));
vi.mock("../commit.js", () => ({ SetupCommitService: class {
  preview(tools: readonly string[]) { return mocks.preview(tools); }
  commit(request: SetupCommitRequest) { return mocks.commit(request); }
  clear() { mocks.clear(); }
  verifyRecovery() { return mocks.verifyRecovery(); }
} }));

import { HubSetupRunner } from "../runner.js";

const status: SetupStatus = {
  mode: "code-repo", projectName: "Test", hasGit: true, hasScaffold: true, populated: true,
  graphReady: true, wikiReady: true, state: "existing", stage: "needs_commit",
  configuredTools: ["codex"], tools: [], ready: false, commitCommands: [],
};
const ready: SetupStatus = { ...status, stage: "ready", ready: true };
const revision = "00000000-0000-4000-8000-000000000192";
const request = { revision, message: "Initialize MEX" };
const receipt = { commit: "a".repeat(40), files: [".mex/config.json"], message: "Setup files committed." };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.initial.mockReturnValue(status);
  mocks.inspect.mockReturnValue(status);
  mocks.status.mockResolvedValue(status);
  mocks.preview.mockResolvedValue({ revision });
  mocks.commit.mockImplementation(async () => { mocks.status.mockResolvedValue(ready); return receipt; });
});

describe("setup commit orchestration", () => {
  it("reviews and commits setup, then waits for explicit Hub opening without repeating population", async () => {
    const onReady = vi.fn();
    const runner = new HubSetupRunner({ projectRoot: "/test", onReady });
    expect(await runner.previewCommit()).toEqual({ revision });
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith(["codex"]);
    const response = await runner.commitSetup(request);
    expect(mocks.commit).toHaveBeenCalledExactlyOnceWith(request);
    expect(response).toMatchObject({ ...receipt, run: { status: "succeeded", ready: true, stage: "ready", error: null } });
    expect(onReady).not.toHaveBeenCalled();
    mocks.inspect.mockReturnValue(ready);
    runner.start({ mode: "code-repo", tools: ["codex"], confirmPopulation: true, openHub: true });
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(mocks.execute).not.toHaveBeenCalled();
    await runner.shutdown();
  });

  it("replays the saved commit receipt after promotion failure without creating another commit", async () => {
    const runner = new HubSetupRunner({ projectRoot: "/test", onReady: async () => { throw new Error("private root and stack"); } });
    const response = await runner.commitSetup(request);
    expect(response.commit).toBe(receipt.commit);
    expect(response.run).toMatchObject({ status: "succeeded", ready: true });
    mocks.inspect.mockReturnValue(ready);
    runner.start({ mode: "code-repo", tools: ["codex"], confirmPopulation: true, openHub: true });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("failed"));
    expect(runner.snapshot().error).not.toContain("private root");
    expect(JSON.stringify(response)).not.toContain("private root");
    await expect(runner.commitSetup(request)).resolves.toEqual(response);
    await expect(runner.commitSetup({ ...request, message: "Different message" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(mocks.commit).toHaveBeenCalledOnce();
    await runner.shutdown();
  });

  it("keeps stale-review errors retryable without promoting or invoking population", async () => {
    const onReady = vi.fn();
    const runner = new HubSetupRunner({ projectRoot: "/test", onReady });
    mocks.commit.mockRejectedValueOnce(new HubHttpError(409, "REVISION_CONFLICT", "Review changed", "Refresh the review."));
    await expect(runner.commitSetup(request)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(runner.previewCommit()).resolves.toEqual({ revision });
    expect(onReady).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    await runner.shutdown();
  });

  it("preserves a durable commit and manual-recovery warning without opening the Hub", async () => {
    const onReady = vi.fn();
    const runner = new HubSetupRunner({ projectRoot: "/test", onReady });
    mocks.commit.mockImplementation(async () => {
      mocks.status.mockRejectedValue(new Error("Readiness inspection failed"));
      return { ...receipt, recoveryRequired: true, message: "The commit is saved. Resolve the Git index recovery file before continuing." };
    });
    const response = await runner.commitSetup(request);
    expect(response).toMatchObject({ commit: receipt.commit, recoveryRequired: true, run: { status: "failed", error: "The commit is saved. Resolve the Git index recovery file before continuing." } });
    expect(onReady).not.toHaveBeenCalled();
    expect(mocks.commit).toHaveBeenCalledOnce();
    await runner.shutdown();
  });

  it("checks unresolved Git recovery before retrying Hub promotion", async () => {
    const onReady = vi.fn();
    const runner = new HubSetupRunner({ projectRoot: "/test", onReady });
    mocks.commit.mockImplementation(async () => {
      mocks.status.mockResolvedValue(ready);
      mocks.inspect.mockReturnValue(ready);
      return { ...receipt, recoveryRequired: true, message: "Resolve the Git index recovery file before continuing." };
    });
    await runner.commitSetup(request);
    mocks.verifyRecovery.mockRejectedValue(new HubHttpError(409, "CAPABILITY_UNAVAILABLE", "Recovery required", "Resolve the Git index recovery file before continuing."));
    runner.start({ mode: "code-repo", tools: ["codex"], confirmPopulation: true });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("failed"));
    expect(runner.snapshot().error).toContain("Git index recovery file");
    expect(mocks.verifyRecovery).toHaveBeenCalledOnce();
    expect(onReady).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    await runner.shutdown();
  });

  it.each(["needs_population", "needs_finalize", "ready"] as const)("rejects commit operations at %s before invoking Git", async (stage) => {
    mocks.status.mockResolvedValue({ ...status, stage });
    const runner = new HubSetupRunner({ projectRoot: "/test" });
    await expect(runner.previewCommit()).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(runner.commitSetup(request)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("serializes review/commit against setup runs and waits for Git before shutting down", async () => {
    let finish!: () => void;
    mocks.commit.mockImplementation(() => new Promise((resolve) => {
      finish = () => { mocks.status.mockResolvedValue(ready); resolve(receipt); };
    }));
    const onReady = vi.fn();
    const runner = new HubSetupRunner({ projectRoot: "/test", onReady });
    const committing = runner.commitSetup(request);
    await vi.waitFor(() => expect(mocks.commit).toHaveBeenCalledOnce());
    await expect(runner.previewCommit()).rejects.toMatchObject({ code: "JOB_ALREADY_RUNNING" });
    await expect(runner.commitSetup(request)).rejects.toMatchObject({ code: "JOB_ALREADY_RUNNING" });
    expect(() => runner.start({ mode: "code-repo", tools: ["codex"] })).toThrow("already in progress");
    let stopped = false;
    const stopping = runner.shutdown().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await expect(committing).resolves.toMatchObject(receipt);
    await stopping;
    expect(onReady).not.toHaveBeenCalled();
    expect(mocks.clear).toHaveBeenCalled();
  });

  it("does not turn notification failures into a failed Git commit", async () => {
    const runner = new HubSetupRunner({ projectRoot: "/test" });
    runner.subscribe((run) => { if (run.status === "succeeded") throw new Error("listener closed"); });
    await expect(runner.commitSetup(request)).resolves.toMatchObject(receipt);
    expect(mocks.commit).toHaveBeenCalledOnce();
    await runner.shutdown();
  });
});
