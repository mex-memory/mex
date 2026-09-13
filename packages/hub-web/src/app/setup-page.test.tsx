import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HubApiError, type HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import { createFixtureApi } from "../dev/fixture-api";
import type { SetupCommitPreview, SetupRun, SetupStartRequest, SetupStatus, SetupTranscriptBatch } from "../api/types";
import { AppRoutes } from "./App";

const status: SetupStatus = {
  mode: "code-repo",
  projectName: "demo",
  hasGit: true,
  hasScaffold: false,
  populated: false,
  graphReady: false,
  wikiReady: false,
  state: "existing",
  stage: "needs_setup",
  configuredTools: [],
  tools: [
    { id: "claude", name: "Claude Code", selected: false, cliAvailable: false },
    { id: "cursor", name: "Cursor", selected: false, cliAvailable: false },
    { id: "codex", name: "Codex", selected: false, cliAvailable: true },
    { id: "windsurf", name: "Windsurf", selected: false, cliAvailable: false },
    { id: "copilot", name: "Copilot", selected: false, cliAvailable: false },
    { id: "opencode", name: "OpenCode", selected: false, cliAvailable: false },
  ],
  ready: false,
  commitCommands: [],
};

const idleRun: SetupRun = {
  status: "idle",
  mode: "code-repo",
  stage: "needs_setup",
  populated: false,
  ready: false,
  selectedTools: [],
  prompt: null,
  populationTool: null,
  populationCompleted: false,
  commitCommands: [],
  anchorNotes: [],
  message: "MEX is not set up in this checkout yet.",
  progress: null,
  error: null,
  startedAt: null,
  finishedAt: null,
};
const commitCommands = ["git diff -- .mex", "git add .mex", 'git commit -m "chore: initialize MEX"'];
const commitPreview = (): SetupCommitPreview => ({
  revision: "a944e8d9-7e02-4d04-9a62-d8b347b8e7dc", expiresAt: new Date(Date.now() + 600_000).toISOString(),
  branch: "main", head: null, defaultMessage: "chore: initialize MEX", canCommit: true, blockedReason: null,
  files: [{ path: ".mex/config.json", status: "added", additions: 1, deletions: 0, diffCharacters: 21, truncated: false }],
});
const commitDiff = vi.fn(async ({ revision, path }: { revision: string; path: string }) => ({ revision, path, diff: "+new project identity", truncated: false }));
const setupUnavailable = new HubApiError({
  type: "about:blank", title: "Setup unavailable", status: 409,
  code: "CAPABILITY_UNAVAILABLE", detail: "This process is serving the Project Hub.", requestId: "setup-test",
});

function renderSetup(api: HubApi) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HubApiProvider api={api}>
        <MemoryRouter initialEntries={["/"]}>
          <AppRoutes />
        </MemoryRouter>
      </HubApiProvider>
    </QueryClientProvider>,
  );
}

function setupHarness(initialStatus: Partial<SetupStatus> = {}, initialRun: Partial<SetupRun> = {}) {
  let currentStatus: SetupStatus = { ...status, ...initialStatus };
  let run: SetupRun = { ...idleRun, mode: currentStatus.mode, ...initialRun };
  let listener: ((next: SetupRun) => void) | undefined;
  let onDisconnect: (() => void) | undefined;
  let transcriptListener: ((next: SetupTranscriptBatch) => void) | undefined;
  let transcript: SetupTranscriptBatch | undefined;
  let operational = false;
  const fixture = createFixtureApi();
  const getCapabilities = fixture.getCapabilities.bind(fixture);
  const close = vi.fn(() => { listener = undefined; });
  const getSetupStatus = vi.fn(async () => {
    if (operational) throw setupUnavailable;
    return currentStatus;
  });
  const startSetup = vi.fn(async (request: SetupStartRequest): Promise<SetupRun> => {
    currentStatus = { ...currentStatus, mode: request.mode, configuredTools: request.tools };
    run = {
      ...run, mode: request.mode, selectedTools: request.tools, status: "running", ready: false,
      message: "Starting MEX setup…", progress: { step: "detect", label: "Detect project state" },
      error: null, startedAt: "2026-09-10T10:00:00.000Z", finishedAt: null,
    };
    return run;
  });
  const api = Object.assign(fixture, {
    getSetupStatus,
    getSetupRun: vi.fn(async () => run),
    startSetup,
    async getCapabilities() {
      const caps = await getCapabilities();
      if (operational) return caps;
      const unavailable = { availability: "unavailable" as const, reason: "Finish MEX setup before using this Hub workbench." };
      return { ...caps, graph: { read: unavailable, refresh: unavailable, rebuild: unavailable }, wiki: { read: unavailable, refresh: unavailable, rebuild: unavailable } };
    },
    subscribeToSetup: vi.fn((onSnapshot: (next: SetupRun) => void, disconnected?: () => void) => {
      listener = onSnapshot;
      onDisconnect = disconnected;
      return { close };
    }),
    subscribeToSetupTranscript: vi.fn((_runId: string, onBatch: (next: SetupTranscriptBatch) => void) => {
      transcriptListener = onBatch;
      if (transcript) onBatch(transcript);
      return { close: () => { transcriptListener = undefined; } };
    }),
    cancelSetup: vi.fn(async () => {
      run = { ...run, status: "cancelled" as const, message: "The background setup was cancelled. You can resume when ready." };
      return run;
    }),
  });
  return {
    api, close,
    sendTranscript(batch: SetupTranscriptBatch) {
      if (!transcriptListener) throw new Error("Wait for the transcript subscription first.");
      transcript = batch;
      transcriptListener(batch);
    },
    updateStatus(update: Partial<SetupStatus>) { currentStatus = { ...currentStatus, ...update }; },
    snapshot(update: Partial<SetupRun>) {
      if (!listener) throw new Error("Wait for the running setup subscription before sending activity.");
      run = { ...run, ...update };
      listener(run);
    },
    disconnect(promoted = false, nextRun: Partial<SetupRun> = {}) {
      operational = promoted;
      run = { ...run, ...nextRun };
      if (!onDisconnect) throw new Error("Wait for the setup subscription before disconnecting it.");
      onDisconnect();
    },
    complete(update: Partial<SetupRun>, nextStatus: Partial<SetupStatus> = {}, promoted = false) {
      if (!listener) throw new Error("Wait for the running setup subscription before completing it.");
      currentStatus = { ...currentStatus, ...nextStatus };
      run = { ...run, ...update, finishedAt: "2026-09-10T10:00:01.000Z" };
      operational = promoted;
      listener(run);
    },
  };
}

async function openConfiguration(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Set up this project" }, { timeout: 5_000 }));
  expect(await screen.findByRole("heading", { level: 1, name: "Set up MEX" })).toBeVisible();
}

async function waitForSubscription(harness: ReturnType<typeof setupHarness>, times: number) {
  await waitFor(() => expect(harness.api.subscribeToSetup).toHaveBeenCalledTimes(times));
}

describe("Hub setup wizard", () => {
  it("shows integration pointers as advisory guidance without turning completion into failure", async () => {
    const harness = setupHarness({ stage: "ready", ready: true, hasScaffold: true, populated: true }, {
      stage: "ready", ready: true, status: "succeeded", anchorNotes: ["Add .mex/ROUTER.md to your existing .cursorrules."],
    });
    renderSetup(harness.api);
    const guidance = await screen.findByLabelText("Integration guidance");
    expect(guidance).toHaveTextContent("Your project setup can continue.");
    expect(guidance).toHaveTextContent(".cursorrules");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Open Hub" })).toBeEnabled();
  });

  it("reviews an exact setup commit, shows completion, and opens the Hub only on request", async () => {
    const user = userEvent.setup();
    const harness = setupHarness({ hasScaffold: true, populated: true, graphReady: true, wikiReady: true, stage: "needs_commit", commitCommands }, {
      status: "paused", stage: "needs_commit", populated: true, commitCommands,
    });
    const preview = commitPreview();
    const api = Object.assign(harness.api, {
      previewSetupCommit: vi.fn(async () => preview),
      setupCommitDiff: commitDiff,
      commitSetup: vi.fn(async () => ({ commit: "a".repeat(40), files: [".mex/config.json"], message: "Setup committed locally.", run: { ...idleRun, status: "succeeded" as const, ready: true, populated: true, stage: "ready" as const } })),
    });
    renderSetup(api);
    await user.click(await screen.findByRole("button", { name: "Review setup changes" }, { timeout: 5_000 }));
    expect(screen.getByText("Commit manually")).toBeVisible();
    expect(screen.getByText("Commit manually").closest("details")).not.toHaveAttribute("open");
    await user.click(await screen.findByRole("button", { name: "Commit setup" }));
    expect(api.commitSetup).toHaveBeenCalledExactlyOnceWith({ revision: preview.revision, message: preview.defaultMessage });
    expect(api.startSetup).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "You’re ready" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Start a fresh agent session" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open Hub" }));
    expect(api.startSetup).toHaveBeenCalledExactlyOnceWith({ mode: "code-repo", tools: [], confirmPopulation: true, openHub: true });
    await waitForSubscription(harness, 1);
    act(() => harness.complete({ status: "succeeded", stage: "ready", ready: true }, { stage: "ready", ready: true }, true));
    expect(await screen.findByRole("heading", { name: "Overview", level: 1 }, { timeout: 5_000 })).toBeVisible();
  });

  it("offers only Hub opening after commit succeeds but promotion fails", async () => {
    const user = userEvent.setup();
    const harness = setupHarness({ hasScaffold: true, populated: true, graphReady: true, wikiReady: true, stage: "needs_commit", commitCommands }, {
      status: "paused", stage: "needs_commit", populated: true, commitCommands,
    });
    const api = Object.assign(harness.api, {
      previewSetupCommit: vi.fn(async () => commitPreview()),
      setupCommitDiff: commitDiff,
      commitSetup: vi.fn(async () => ({ commit: "a".repeat(40), files: [".mex/config.json"], message: "Setup committed locally.", run: { ...idleRun, status: "failed" as const, populated: true, stage: "ready" as const, error: "The Project Hub could not open." } })),
    });
    renderSetup(api);
    await user.click(await screen.findByRole("button", { name: "Review setup changes" }, { timeout: 5_000 }));
    await user.click(await screen.findByRole("button", { name: "Commit setup" }));
    await user.click(await screen.findByRole("button", { name: "Retry opening Hub" }));
    expect(api.startSetup).toHaveBeenCalledExactlyOnceWith({ mode: "code-repo", tools: [], confirmPopulation: true, openHub: true });
    expect(api.commitSetup).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Commit setup" })).toBeNull();
  });

  it("keeps Git recovery prominent after a durable commit even when refreshed setup reports ready", async () => {
    const user = userEvent.setup();
    const harness = setupHarness({ hasScaffold: true, populated: true, graphReady: true, wikiReady: true, stage: "needs_commit", commitCommands }, {
      status: "paused", stage: "needs_commit", populated: true, commitCommands,
    });
    const warning = "The commit is saved. Keep the index.lock recovery file and inspect Git status before continuing manually.";
    const api = Object.assign(harness.api, {
      previewSetupCommit: vi.fn(async () => commitPreview()),
      setupCommitDiff: commitDiff,
      commitSetup: vi.fn(async () => {
        harness.updateStatus({ stage: "ready", ready: true });
        return { commit: "a".repeat(40), files: [".mex/config.json"], recoveryRequired: true, message: warning, run: { ...idleRun, status: "failed" as const, populated: true, stage: "ready" as const, ready: true, error: warning } };
      }),
    });
    renderSetup(api);
    await user.click(await screen.findByRole("button", { name: "Review setup changes" }, { timeout: 5_000 }));
    await user.click(await screen.findByRole("button", { name: "Commit setup" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(warning);
    expect(screen.getByRole("alert")).toHaveTextContent("Setup committed; Git needs attention");
    expect(screen.getByText("Your setup commit is saved. Resolve the Git issue above, then check again.")).toBeVisible();
    expect(api.startSetup).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Commit setup" })).toBeNull();
    expect(screen.queryByText("Commit manually")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Check recovery and open Hub" }));
    expect(api.startSetup).toHaveBeenCalledExactlyOnceWith({ mode: "code-repo", tools: [], confirmPopulation: true, openHub: true });
    expect(api.commitSetup).toHaveBeenCalledOnce();
  });

  it.each(["claude", "codex"] as const)("shows the actual %s session while retaining activity timing, cancellation, and terminal output", async (tool) => {
    const user = userEvent.setup();
    const startedAt = new Date().toISOString();
    const transcriptId = "a944e8d9-7e02-4d04-9a62-d8b347b8e7dc";
    const harness = setupHarness({ hasScaffold: true }, {
      status: "running", selectedTools: [tool], populationTool: tool, transcriptId,
      progress: { step: "population", label: "Populating MEX" },
      populationActivity: { tool, startedAt, lastActivityAt: startedAt, totalEvents: 1, events: [{ id: 1, at: startedAt, kind: "reading", state: "running" }] },
    });
    renderSetup(harness.api);
    expect(await screen.findByRole("region", { name: "Agent session transcript" }, { timeout: 5_000 })).toBeVisible();
    expect(screen.getByRole("heading", { name: `${tool === "claude" ? "Claude Code" : "Codex"} is building your project memory` })).toBeVisible();
    expect(screen.getByText(/Running for/)).toBeVisible();
    expect(screen.queryByRole("list", { name: "Recent agent activity" })).toBeNull();
    act(() => harness.sendTranscript({
      runId: transcriptId, cursor: 2, firstId: 1, truncated: false, done: false,
      entries: [
        { id: 1, at: startedAt, kind: "assistant", text: "I will inspect the project's README and package manifest.", truncated: false },
        { id: 2, at: startedAt, kind: "command", text: "cat README.md package.json", truncated: false },
      ],
    }));
    expect(screen.getByText("I will inspect the project's README and package manifest.")).toBeVisible();
    expect(screen.getByText("Ran a command")).toBeVisible();
    expect(screen.queryByText("cat README.md package.json")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel setup" }));
    expect(await screen.findByText("Setup cancelled")).toBeVisible();
    expect(screen.getByText("Ran a command")).toBeVisible();
    expect(screen.queryByText("cat README.md package.json")).toBeNull();
    expect(screen.getByRole("button", { name: "Resume setup" })).toBeEnabled();
  });

  it.each(["claude", "codex"] as const)("restores %s population activity on refresh and accepts real SSE updates without a percentage", async (tool) => {
    // Keep async bootstrap/render duration out of the elapsed-time assertion.
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const startedAt = new Date(Date.now() - 30_000).toISOString();
    const activity: NonNullable<SetupRun["populationActivity"]> = {
      tool, startedAt, lastActivityAt: startedAt, totalEvents: 1,
      events: [{ id: 1, at: startedAt, kind: "reading", state: "completed" }],
    };
    const harness = setupHarness({ hasScaffold: true }, {
      status: "running", selectedTools: [tool], populationTool: tool, populationActivity: activity,
      progress: { step: "population", label: "Populating MEX" },
    });
    renderSetup(harness.api);
    expect(await screen.findByRole("heading", { name: `${tool === "claude" ? "Claude Code" : "Codex"} is building your project memory` }, { timeout: 5_000 })).toBeVisible();
    await waitForSubscription(harness, 1);
    expect(screen.getByText(/Running for 30s/)).toBeVisible();
    expect(within(screen.getByRole("list", { name: "Recent agent activity" })).getByText("Read repository files")).toBeVisible();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/\d+%/)).toBeNull();
    expect(screen.getByText(/You can leave this tab; setup continues while the local Hub is running/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel setup" })).toBeEnabled();
    const before = harness.api.getSetupRun.mock.calls.length;
    const at = new Date(Date.now()).toISOString();
    act(() => harness.snapshot({ populationActivity: {
      ...activity, lastActivityAt: at, totalEvents: 2,
      events: [...activity.events, { id: 2, at, kind: "writing", state: "completed", target: "architecture" }],
    } }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Recent agent activity" })).getAllByRole("listitem")[0]).toHaveTextContent("Updated architecture notes"));
    expect(harness.api.getSetupRun).toHaveBeenCalledTimes(before);
    act(() => harness.complete({ status: "paused", stage: "needs_commit", populated: true, commitCommands }, {
      stage: "needs_commit", populated: true, commitCommands,
    }));
    expect(await screen.findByRole("button", { name: "Check commit and continue" })).toBeVisible();
    expect(screen.queryByRole("list", { name: "Recent agent activity" })).toBeNull();
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it("drops the percentage as soon as population begins, before the first provider report", async () => {
    const harness = setupHarness({ hasScaffold: true }, {
      status: "running", progress: { step: "population", label: "Populating MEX" },
    });
    renderSetup(harness.api);
    expect(await screen.findByText(/Waiting for the first activity report/, undefined, { timeout: 5_000 })).toBeVisible();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/\d+%/)).toBeNull();
  });

  it("keeps the populated fixture on the ordinary Hub shell", async () => {
    renderSetup(createFixtureApi());
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" }, { timeout: 5_000 })).toBeVisible();
    expect(screen.queryByRole("heading", { level: 1, name: "Set up MEX" })).toBeNull();
  });

  it("refreshes terminal SSE state, waits for the commit checkpoint, then opens the promoted Hub", async () => {
    const user = userEvent.setup();
    const harness = setupHarness();
    renderSetup(harness.api);
    await openConfiguration(user);
    await user.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    await user.click(screen.getByRole("button", { name: "Start setup" }));
    expect(harness.api.startSetup).toHaveBeenCalledWith({ mode: "code-repo", tools: ["cursor"] });
    await waitForSubscription(harness, 1);
    expect(screen.getByRole("heading", { name: "Running setup" })).toBeVisible();
    const beforePause = harness.api.getSetupStatus.mock.calls.length;

    act(() => harness.complete({
      status: "paused", stage: "needs_population", prompt: "Populate ROUTER.md and AGENTS.md from this repository.",
      message: "No supported CLI was selected. Populate the scaffold with your agent.",
    }, { hasScaffold: true, stage: "needs_population" }));
    expect(await screen.findByLabelText("Population prompt")).toHaveValue("Populate ROUTER.md and AGENTS.md from this repository.");
    await waitFor(() => expect(harness.api.getSetupStatus.mock.calls.length).toBeGreaterThan(beforePause));
    expect(harness.close).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "I've populated the scaffold" }));
    expect(harness.api.startSetup).toHaveBeenLastCalledWith({ mode: "code-repo", tools: ["cursor"], confirmPopulation: true });
    await waitForSubscription(harness, 2);
    act(() => harness.complete({
      status: "succeeded", stage: "needs_commit", populated: true, prompt: null, commitCommands,
      message: "Review and commit the canonical MEX setup.",
    }, { populated: true, graphReady: true, wikiReady: true, stage: "needs_commit", commitCommands }));
    expect(await screen.findByLabelText("Commit commands")).toHaveValue(commitCommands.join("\n"));
    expect(screen.queryByRole("heading", { name: "Opening the Project Hub" })).toBeNull();
    const copy = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: "Copy commands" }));
    expect(copy).toHaveBeenCalledWith(commitCommands.join("\n"));

    await user.click(screen.getByRole("button", { name: "Check commit and continue" }));
    await waitForSubscription(harness, 3);
    act(() => harness.complete({ status: "succeeded", stage: "ready", ready: true }, { stage: "ready", ready: true }, true));
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" }, { timeout: 5_000 })).toBeVisible();
    expect(screen.queryByRole("heading", { level: 1, name: "Set up MEX" })).toBeNull();
    expect(screen.queryByText("Setup status could not be loaded")).toBeNull();
    expect(harness.close).toHaveBeenCalledTimes(3);
  });

  it("opens the Hub when fast promotion replaces the setup app before its terminal event reaches the browser", async () => {
    const user = userEvent.setup();
    const harness = setupHarness({ hasScaffold: true, populated: true, graphReady: true, wikiReady: true, stage: "ready", ready: true });
    renderSetup(harness.api);
    await user.click(await screen.findByRole("button", { name: "Open Hub" }, { timeout: 5_000 }));
    await waitForSubscription(harness, 1);
    expect(screen.getByRole("heading", { name: "Running setup" })).toBeVisible();
    // The POST returned running, but /setup/events now belongs to the promoted
    // app and fails before delivering either a snapshot or the terminal event.
    act(() => harness.disconnect(true));
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" }, { timeout: 5_000 })).toBeVisible();
    expect(screen.queryByText("Setup status could not be loaded")).toBeNull();
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it("recovers a missed pause snapshot with bounded reads when the setup stream disconnects", async () => {
    const harness = setupHarness({ hasScaffold: true }, { status: "running" });
    renderSetup(harness.api);
    await waitForSubscription(harness, 1);
    const statusReads = harness.api.getSetupStatus.mock.calls.length;
    const runReads = harness.api.getSetupRun.mock.calls.length;
    act(() => {
      harness.disconnect(false, { status: "paused", stage: "needs_population", prompt: "Populate the recovered scaffold." });
      harness.disconnect();
      harness.disconnect();
    });
    expect(await screen.findByLabelText("Population prompt")).toHaveValue("Populate the recovered scaffold.");
    expect(harness.api.getSetupStatus).toHaveBeenCalledTimes(statusReads + 1);
    expect(harness.api.getSetupRun).toHaveBeenCalledTimes(runReads + 1);
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it("requires an explicit open action after an external commit and does not poll idle setup", async () => {
    const user = userEvent.setup();
    const harness = setupHarness({ hasScaffold: true, populated: true, graphReady: true, wikiReady: true, stage: "ready", ready: true });
    renderSetup(harness.api);
    expect(await screen.findByRole("button", { name: "Open Hub" }, { timeout: 5_000 })).toBeEnabled();
    expect(screen.queryByRole("heading", { level: 1, name: "Overview" })).toBeNull();
    const reads = harness.api.getSetupStatus.mock.calls.length;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
    expect(harness.api.getSetupStatus).toHaveBeenCalledTimes(reads);
    expect(harness.api.startSetup).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Open Hub" }));
    expect(harness.api.startSetup).toHaveBeenCalledWith({ mode: "code-repo", tools: [], confirmPopulation: true, openHub: true });
  });

  it("restores a paused Agent memory run after reload and preserves its empty tool selection", async () => {
    const user = userEvent.setup();
    const harness = setupHarness({ hasGit: false, hasScaffold: true, mode: "agent-memory", configuredTools: ["codex"], stage: "needs_population" }, {
      status: "paused", mode: "agent-memory", stage: "needs_population", selectedTools: [], prompt: "Populate your agent memory.", message: "Population needs your agent.",
    });
    renderSetup(harness.api);
    expect(await screen.findByLabelText("Population prompt", undefined, { timeout: 5_000 })).toHaveValue("Populate your agent memory.");
    expect(screen.queryByText("Git repository required")).toBeNull();
    await user.click(screen.getByRole("button", { name: "I've populated the scaffold" }));
    expect(harness.api.startSetup).toHaveBeenCalledWith({ mode: "agent-memory", tools: [], confirmPopulation: true });
  });

  it.each([false, true])("finishes Agent memory without dashboard loading or indexes (Git: %s)", async (hasGit) => {
    const harness = setupHarness({ hasGit, hasScaffold: true, mode: "agent-memory", populated: true, stage: "complete" });
    renderSetup(harness.api);
    expect(await screen.findByRole("heading", { name: "Agent memory setup complete" }, { timeout: 5_000 })).toBeVisible();
    expect(screen.getByText(/You can close this tab/)).toBeVisible();
    expect(screen.queryByText("Opening the Project Hub")).toBeNull();
    expect(screen.queryByRole("button", { name: /Finish setup|Open Project Hub|Start setup/ })).toBeNull();
    expect(harness.api.startSetup).not.toHaveBeenCalled();
  });

  it("restores persisted Agent memory mode from status when no run has started", async () => {
    const harness = setupHarness({ hasGit: false, hasScaffold: true, mode: "agent-memory", stage: "needs_population" });
    renderSetup(harness.api);
    expect(await screen.findByRole("radio", { name: /Agent memory/ }, { timeout: 5_000 })).toBeChecked();
    expect(screen.queryByText("Git repository required")).toBeNull();
    expect(screen.getByRole("button", { name: "Start setup" })).toBeEnabled();
  });

  it("shows failed agent diagnostics and keeps manual completion and retry available", async () => {
    const user = userEvent.setup();
    const harness = setupHarness({ hasScaffold: true, stage: "needs_population", configuredTools: ["codex"] }, {
      status: "failed", stage: "needs_population", selectedTools: ["codex"], populationTool: "codex",
      prompt: "Populate the project scaffold.", error: "Codex exited with code 1: authentication required.", message: "Codex population failed.",
    });
    renderSetup(harness.api);
    expect(await screen.findByRole("alert", undefined, { timeout: 5_000 })).toHaveTextContent("authentication required");
    expect(screen.getByLabelText("Population prompt")).toHaveValue("Populate the project scaffold.");
    expect(screen.getByRole("button", { name: "I've populated the scaffold" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Retry population" }));
    expect(harness.api.startSetup).toHaveBeenCalledWith({ mode: "code-repo", tools: ["codex"] });
  });

  it("lets users change tools after agent failure and save a deliberately empty selection", async () => {
    const user = userEvent.setup();
    const harness = setupHarness({ hasScaffold: true, configuredTools: ["codex"], stage: "needs_population" }, {
      status: "failed", stage: "needs_population", selectedTools: ["codex"], prompt: "Populate memory.", error: "Codex could not start.",
    });
    renderSetup(harness.api);
    await user.click(await screen.findByRole("button", { name: "Change AI tools" }, { timeout: 5_000 }));
    await user.click(screen.getByRole("checkbox", { name: /Codex/ }));
    await user.click(screen.getByRole("button", { name: "Retry setup" }));
    expect(harness.api.startSetup).toHaveBeenCalledWith({ mode: "code-repo", tools: [] });
  });

  it("cancels background setup and offers to resume the selected mode", async () => {
    const user = userEvent.setup();
    const harness = setupHarness({ mode: "agent-memory", hasGit: false, hasScaffold: true }, {
      status: "running", mode: "agent-memory", selectedTools: ["codex"], progress: { step: "population", label: "Populating agent memory" },
    });
    renderSetup(harness.api);
    await user.click(await screen.findByRole("button", { name: "Cancel setup" }, { timeout: 5_000 }));
    expect(harness.api.cancelSetup).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Setup cancelled")).toBeVisible();
    expect(screen.getByRole("radio", { name: /Agent memory/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Resume setup" }));
    expect(harness.api.startSetup).toHaveBeenCalledWith({ mode: "agent-memory", tools: ["codex"] });
  });

  it("keeps the stop control disabled until the background process exits and resets it on resume", async () => {
    const user = userEvent.setup();
    const running: SetupRun = {
      ...idleRun, status: "running", stage: "needs_population", selectedTools: ["codex"],
      progress: { step: "population", label: "Populating MEX" },
    };
    const harness = setupHarness({ hasScaffold: true }, running);
    harness.api.cancelSetup.mockImplementationOnce(async () => ({ ...running, message: "Stopping setup…" }));
    renderSetup(harness.api);
    await waitForSubscription(harness, 1);
    await user.click(screen.getByRole("button", { name: "Cancel setup" }));
    expect(await screen.findByRole("button", { name: "Stopping…" })).toBeDisabled();
    expect(harness.close).not.toHaveBeenCalled();
    act(() => harness.complete({ status: "cancelled", message: "The background setup was cancelled." }));
    await user.click(await screen.findByRole("button", { name: "Resume setup" }));
    expect(await screen.findByRole("button", { name: "Cancel setup" })).toBeEnabled();
  });

  it("refreshes the Git prerequisite after the user initializes the repository", async () => {
    const user = userEvent.setup();
    const harness = setupHarness({ hasGit: false, stage: "needs_git" });
    renderSetup(harness.api);
    await openConfiguration(user);
    expect(screen.getByRole("heading", { name: "Git repository required" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Start setup" })).toBeDisabled();
    harness.updateStatus({ hasGit: true, stage: "needs_setup" });
    await user.click(screen.getByRole("button", { name: "Check repository again" }));
    expect(await screen.findByRole("button", { name: "Start setup" })).toBeEnabled();
    expect(harness.api.startSetup).not.toHaveBeenCalled();
  });

  it("allows Agent memory configuration without Git", async () => {
    const user = userEvent.setup();
    const harness = setupHarness({ hasGit: false, stage: "needs_git" });
    renderSetup(harness.api);
    await openConfiguration(user);
    await user.click(screen.getByRole("radio", { name: /Agent memory/ }));
    expect(screen.getByRole("button", { name: "Start setup" })).toBeEnabled();
    expect(screen.queryByText("Git repository required")).toBeNull();
  });

  it("retries failed promotion as confirmed population instead of rebuilding completed setup", async () => {
    const user = userEvent.setup();
    const harness = setupHarness({ hasScaffold: true, populated: true, graphReady: true, wikiReady: true, stage: "ready", ready: true }, {
      status: "failed", stage: "ready", populated: true, error: "Project Hub could not open. Fix the repository state and retry.",
    });
    renderSetup(harness.api);
    expect(await screen.findByRole("alert", undefined, { timeout: 5_000 })).toHaveTextContent("Project Hub could not open");
    expect(screen.getByRole("button", { name: "Retry opening Hub" })).toBeEnabled();
    expect(screen.queryByText("Opening the Project Hub")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry opening Hub" }));
    expect(harness.api.startSetup).toHaveBeenCalledWith({ mode: "code-repo", tools: [], confirmPopulation: true, openHub: true });
  });

  it("reloads a failed run read before allowing setup to continue", async () => {
    const user = userEvent.setup();
    const harness = setupHarness({ hasScaffold: true });
    harness.api.getSetupRun.mockRejectedValueOnce(new Error("Connection interrupted"));
    renderSetup(harness.api);
    await user.click(await screen.findByRole("button", { name: "Reload progress" }, { timeout: 5_000 }));
    expect(await screen.findByRole("button", { name: "Start setup" })).toBeEnabled();
  });
});
