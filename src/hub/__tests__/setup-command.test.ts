import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: vi.fn(),
  createCapture: vi.fn(),
  startTelemetry: vi.fn(),
  stopTelemetry: vi.fn(async () => undefined),
  startServer: vi.fn(),
  closeServer: vi.fn(async () => undefined),
  createApp: vi.fn(),
  createSetup: vi.fn(),
  inspect: vi.fn(),
  committedIdentity: vi.fn(),
  stopSetup: vi.fn(async () => undefined),
  findRoot: vi.fn(),
  findConfig: vi.fn(),
  identity: vi.fn(),
  createTeam: vi.fn(),
  openBrowser: vi.fn(),
  order: [] as string[],
}));

vi.mock("../../telemetry/index.js", () => ({
  createProjectTelemetryCapture: mocks.createCapture,
  startHubTelemetry: mocks.startTelemetry,
}));
vi.mock("../static/assets.js", () => ({ HubAssetManifest: class {} }));
vi.mock("../security/session.js", () => ({
  createBootstrapToken: () => "private-bootstrap-token",
  HubSessionManager: class {},
}));
vi.mock("../app.js", () => ({ createHubApp: mocks.createApp }));
vi.mock("../node-server.js", () => ({ startHubNodeServer: mocks.startServer }));
vi.mock("../browser.js", () => ({ openHubBrowser: mocks.openBrowser }));
vi.mock("../setup/services.js", () => ({ createSetupHubServices: mocks.createSetup }));
vi.mock("../../setup/headless.js", () => ({ inspectSetupStatus: mocks.inspect }));
vi.mock("../setup/readiness.js", () => ({ hasCommittedHubIdentity: mocks.committedIdentity }));
vi.mock("../../setup/index.js", () => ({ findSetupProjectRoot: mocks.findRoot }));
vi.mock("../../config.js", () => ({
  findConfig: mocks.findConfig,
  readScaffoldId: () => mocks.identity()?.scaffold_id,
}));
vi.mock("../jobs/index.js", () => ({ HubJobManager: class {
  initialize() {}
  shutdown = async () => { mocks.order.push("jobs"); };
} }));
vi.mock("../jobs/graph.js", () => ({ createGraphJobExecutors: () => ({}) }));
vi.mock("../jobs/wiki.js", () => ({ createWikiJobExecutors: () => ({}) }));
vi.mock("../services.js", () => ({ createLocalHubReadServices: () => ({}) }));
vi.mock("../../team/local-state/index.js", () => ({ TeamLocalState: class {} }));
vi.mock("../../graph/application-adapter.js", () => ({ createRepositoryGraphPort: () => ({}) }));
vi.mock("../../wiki/application-adapter.js", () => ({ createRepositoryWikiPort: () => ({}) }));
vi.mock("../../team/workflow/repository-team-workflow-port.js", () => ({
  createRepositoryTeamWorkflowPort: mocks.createTeam,
}));
vi.mock("../../team/specs/index.js", () => ({ createSpecReadService: () => ({}) }));

import { launchHub, runSetupHubCommand } from "../command.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.committedIdentity.mockResolvedValue(false);
  mocks.createTeam.mockResolvedValue({ initializeIdentityActivitySigner() {} });
  mocks.findConfig.mockReturnValue({ projectRoot: "/Users/private/project", scaffoldRoot: "/Users/private/project/.mex" });
  mocks.identity.mockReturnValue({ scaffold_id: "private-scaffold" });
  mocks.stopSetup.mockImplementation(async () => { mocks.order.push("setup"); });
  mocks.closeServer.mockImplementation(async () => { mocks.order.push("http"); });
  mocks.stopTelemetry.mockImplementation(async () => { mocks.order.push("telemetry"); });
  mocks.startTelemetry.mockReturnValue(mocks.stopTelemetry);
  mocks.createCapture.mockReturnValue(mocks.events);
  mocks.createSetup.mockReturnValue({
    services: { tag: "setup-services" },
    setup: { tag: "setup-runner", status: () => ({ ready: false }), shutdown: mocks.stopSetup },
  });
  mocks.findRoot.mockReturnValue("/Users/private/project");
  mocks.inspect.mockReturnValue({ mode: "code-repo", hasScaffold: false, ready: false, stage: "needs_setup" });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("Hub setup process", () => {
  it("does not start resources when the finishing lane is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const onListening = vi.fn();
    await runSetupHubCommand({ projectRoot: "/Users/private/project", openBrowser: true, signal: controller.signal, onListening });
    expect(mocks.createSetup).not.toHaveBeenCalled();
    expect(mocks.startServer).not.toHaveBeenCalled();
    expect(mocks.startTelemetry).not.toHaveBeenCalled();
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(onListening).not.toHaveBeenCalled();
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it("closes a listener that finishes starting after cancellation", async () => {
    let ready!: (server: { origin: string; close: typeof mocks.closeServer; replaceApp: () => void }) => void;
    mocks.startServer.mockReturnValue(new Promise((resolve) => { ready = resolve; }));
    const controller = new AbortController();
    const onListening = vi.fn();
    const running = runSetupHubCommand({ projectRoot: "/Users/private/project", openBrowser: true, signal: controller.signal, onListening });
    await vi.waitFor(() => expect(mocks.startServer).toHaveBeenCalledOnce());
    controller.abort();
    ready({ origin: "http://127.0.0.1:48123", close: mocks.closeServer, replaceApp: vi.fn() });
    await running;
    expect(mocks.order).toEqual(["http", "setup"]);
    expect(mocks.startTelemetry).not.toHaveBeenCalled();
    expect(onListening).not.toHaveBeenCalled();
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it("hands the bound finishing link to the HUD and removes shutdown listeners on abort", async () => {
    const controller = new AbortController();
    const onListening = vi.fn();
    const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
    const priorInterrupt = process.listeners("SIGINT");
    const priorTerminate = process.listeners("SIGTERM");
    mocks.startServer.mockResolvedValue({ origin: "http://127.0.0.1:48123", close: mocks.closeServer, replaceApp: vi.fn() });
    const running = runSetupHubCommand({
      projectRoot: "/Users/private/project", openBrowser: true, port: 48123,
      initialMode: "agent-memory", signal: controller.signal, onListening,
    });
    await vi.waitFor(() => expect(onListening).toHaveBeenCalledOnce());
    expect(onListening).toHaveBeenCalledWith({ origin: "http://127.0.0.1:48123", bootstrapUrl: "http://127.0.0.1:48123/#token=private-bootstrap-token" });
    expect(mocks.createSetup).toHaveBeenCalledWith("/Users/private/project", expect.objectContaining({ initialMode: "agent-memory" }));
    expect(mocks.startServer).toHaveBeenCalledWith(expect.objectContaining({ port: 48123 }));
    expect(mocks.openBrowser).toHaveBeenCalledWith("http://127.0.0.1:48123/#token=private-bootstrap-token");
    expect(process.stdout.write).not.toHaveBeenCalled();
    controller.abort();
    await running;
    expect(mocks.order).toEqual(["http", "setup", "telemetry"]);
    expect(process.listeners("SIGINT")).toEqual(priorInterrupt);
    expect(process.listeners("SIGTERM")).toEqual(priorTerminate);
    expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("handles cancellation from onListening before browser launch or shutdown wait", async () => {
    const controller = new AbortController();
    const priorInterrupt = process.listeners("SIGINT");
    const priorTerminate = process.listeners("SIGTERM");
    mocks.startServer.mockResolvedValue({ origin: "http://127.0.0.1:48123", close: mocks.closeServer, replaceApp: vi.fn() });
    await runSetupHubCommand({
      projectRoot: "/Users/private/project", openBrowser: true, signal: controller.signal,
      onListening: () => controller.abort(),
    });
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(mocks.order).toEqual(["http", "setup", "telemetry"]);
    expect(process.listeners("SIGINT")).toEqual(priorInterrupt);
    expect(process.listeners("SIGTERM")).toEqual(priorTerminate);
  });

  it("routes startup output through onMessage when no listener callback is supplied", async () => {
    const controller = new AbortController();
    const onMessage = vi.fn(() => controller.abort());
    mocks.startServer.mockResolvedValue({ origin: "http://127.0.0.1:48123", close: mocks.closeServer, replaceApp: vi.fn() });
    await runSetupHubCommand({ projectRoot: "/Users/private/project", openBrowser: false, signal: controller.signal, onMessage });
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("http://127.0.0.1:48123/#token=private-bootstrap-token"));
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(mocks.order).toEqual(["http", "setup", "telemetry"]);
  });

  it("cleans up setup and reports a listener startup failure to its caller", async () => {
    const onListening = vi.fn();
    mocks.startServer.mockRejectedValue(new Error("Port is occupied."));
    await expect(runSetupHubCommand({ projectRoot: "/Users/private/project", openBrowser: true, onListening })).rejects.toThrow("Port is occupied.");
    expect(onListening).not.toHaveBeenCalled();
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(mocks.order).toEqual(["setup"]);
  });

  it("starts the setup Hub without jobs when the checkout is not ready", async () => {
    let ready!: (server: { origin: string; close: typeof mocks.closeServer; replaceApp: () => void }) => void;
    mocks.startServer.mockReturnValue(new Promise((resolve) => { ready = resolve; }));
    const priorListeners = new Set(process.listeners("SIGTERM"));
    const running = runSetupHubCommand({ projectRoot: "/Users/private/project", openBrowser: false });
    await vi.waitFor(() => expect(mocks.startServer).toHaveBeenCalledOnce());
    expect(mocks.createSetup).toHaveBeenCalledWith(
      "/Users/private/project",
      expect.objectContaining({ onReady: expect.any(Function) }),
    );
    expect(mocks.createApp).toHaveBeenCalledWith(expect.objectContaining({
      setup: expect.objectContaining({ tag: "setup-runner" }),
      services: { tag: "setup-services" },
      telemetry: mocks.events,
    }));
    expect(mocks.createApp.mock.calls[0][0].jobs).toBeUndefined();
    ready({ origin: "http://127.0.0.1:48123", close: mocks.closeServer, replaceApp: vi.fn() });
    await vi.waitFor(() => expect(mocks.events).toHaveBeenCalledOnce());
    const stop = process.listeners("SIGTERM").find((listener) => !priorListeners.has(listener));
    if (!stop) throw new Error("Hub did not install its shutdown handler.");
    stop("SIGTERM");
    await running;
    expect(mocks.events.mock.calls).toEqual([["hub.session_started", {}]]);
    expect(mocks.order).toEqual(["http", "setup", "telemetry"]);
  });

  it("opens the setup wizard from launchHub when setup is incomplete", async () => {
    let ready!: (server: { origin: string; close: typeof mocks.closeServer; replaceApp: () => void }) => void;
    mocks.startServer.mockReturnValue(new Promise((resolve) => { ready = resolve; }));
    const priorListeners = new Set(process.listeners("SIGTERM"));
    const running = launchHub({ openBrowser: false });
    await vi.waitFor(() => expect(mocks.startServer).toHaveBeenCalledOnce());
    expect(mocks.findConfig).not.toHaveBeenCalled();
    expect(mocks.createSetup).toHaveBeenCalledWith(
      "/Users/private/project",
      expect.objectContaining({ onReady: expect.any(Function) }),
    );
    ready({ origin: "http://127.0.0.1:48123", close: mocks.closeServer, replaceApp: vi.fn() });
    await vi.waitFor(() => expect(mocks.events).toHaveBeenCalledOnce());
    const stop = process.listeners("SIGTERM").find((listener) => !priorListeners.has(listener));
    if (!stop) throw new Error("Hub did not install its shutdown handler.");
    stop("SIGTERM");
    await running;
  });

  it.each([
    { mode: "agent-memory", hasScaffold: true },
    { mode: "code-repo", hasScaffold: false },
  ])("keeps $mode with hasScaffold=$hasScaffold in setup despite committed config", async (state) => {
    mocks.inspect.mockReturnValue({ ...state, ready: false, stage: "needs_setup" });
    mocks.committedIdentity.mockResolvedValue(true);
    mocks.startServer.mockResolvedValue({ origin: "http://127.0.0.1:48123", close: mocks.closeServer, replaceApp: vi.fn() });
    const priorListeners = new Set(process.listeners("SIGTERM"));
    const running = launchHub({ openBrowser: false });
    await vi.waitFor(() => expect(mocks.events).toHaveBeenCalledOnce());
    expect(mocks.createSetup).toHaveBeenCalledOnce();
    expect(mocks.findConfig).not.toHaveBeenCalled();
    stopHub(priorListeners);
    await running;
  });

  it("retains the full Hub recovery surfaces when only disposable indexes are missing", async () => {
    mocks.inspect.mockReturnValue({ mode: "code-repo", hasScaffold: true, ready: false,
      populated: false, graphReady: false, wikiReady: false, stage: "needs_finalize" });
    mocks.committedIdentity.mockResolvedValue(true);
    mocks.startServer.mockResolvedValue({ origin: "http://127.0.0.1:48123", close: mocks.closeServer, replaceApp: vi.fn() });
    const priorListeners = new Set(process.listeners("SIGTERM"));
    const running = launchHub({ openBrowser: false });
    await vi.waitFor(() => expect(mocks.events).toHaveBeenCalledOnce());
    expect(mocks.createSetup).not.toHaveBeenCalled();
    expect(mocks.createApp).toHaveBeenCalledWith(expect.objectContaining({ jobs: expect.anything() }));
    stopHub(priorListeners);
    await running;
    expect(mocks.order).toEqual(["http", "jobs", "telemetry"]);
  });

  it.each([{ setup: true }, { mode: "code-repo" }])("retains the setup finishing screen for explicit launch options %j", async (options) => {
    mocks.inspect.mockReturnValue({ mode: "code-repo", hasScaffold: true, ready: true, stage: "ready" });
    mocks.committedIdentity.mockResolvedValue(true);
    mocks.startServer.mockResolvedValue({ origin: "http://127.0.0.1:48123", close: mocks.closeServer, replaceApp: vi.fn() });
    const priorListeners = new Set(process.listeners("SIGTERM"));
    const running = launchHub({ openBrowser: false, ...options });
    await vi.waitFor(() => expect(mocks.events).toHaveBeenCalledOnce());
    expect(mocks.createSetup).toHaveBeenCalledWith("/Users/private/project", expect.objectContaining({ initialMode: "mode" in options ? options.mode : undefined }));
    expect(mocks.createTeam).not.toHaveBeenCalled();
    stopHub(priorListeners);
    await running;
  });

  it.each(["ready", "failed"])("routes a %s promotion notice through the HUD callback", async (outcome) => {
    let onReady!: (signal: AbortSignal) => Promise<void>;
    const replaceApp = vi.fn();
    mocks.createSetup.mockImplementation((_root, options: { onReady: typeof onReady }) => {
      onReady = options.onReady;
      return { services: {}, setup: { shutdown: mocks.stopSetup } };
    });
    mocks.startServer.mockResolvedValue({ origin: "http://127.0.0.1:48123", close: mocks.closeServer, replaceApp });
    const controller = new AbortController();
    const onListening = vi.fn();
    const onMessage = vi.fn();
    const running = runSetupHubCommand({ projectRoot: "/Users/private/project", openBrowser: false, signal: controller.signal, onListening, onMessage });
    await vi.waitFor(() => expect(onListening).toHaveBeenCalledOnce());
    if (outcome === "ready") {
      await onReady(new AbortController().signal);
      expect(replaceApp).toHaveBeenCalledOnce();
      expect(onMessage).toHaveBeenCalledWith("Project Hub is ready at http://127.0.0.1:48123");
    } else {
      mocks.findConfig.mockImplementation(() => { throw new Error("Config could not be read."); });
      await expect(onReady(new AbortController().signal)).rejects.toThrow("Config could not be read.");
      expect(replaceApp).not.toHaveBeenCalled();
      expect(onMessage).toHaveBeenCalledWith("Project Hub could not open after setup: Config could not be read.");
    }
    expect(process.stdout.write).not.toHaveBeenCalled();
    controller.abort();
    await running;
  });

  it("cleans up pending composition after cancellation without replacing the setup app", async () => {
    const replaceApp = vi.fn();
    let onReady!: (signal: AbortSignal) => Promise<void>;
    mocks.createSetup.mockImplementation((_root, options: { onReady: typeof onReady }) => {
      onReady = options.onReady;
      return { services: {}, setup: { shutdown: mocks.stopSetup } };
    });
    let finishTeam!: (team: { initializeIdentityActivitySigner(): void }) => void;
    mocks.createTeam.mockReturnValue(new Promise((resolve) => { finishTeam = resolve; }));
    mocks.startServer.mockResolvedValue({ origin: "http://127.0.0.1:48123", close: mocks.closeServer, replaceApp });
    const priorListeners = new Set(process.listeners("SIGTERM"));
    const running = runSetupHubCommand({ projectRoot: "/Users/private/project", openBrowser: false });
    await vi.waitFor(() => expect(mocks.events).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const promotion = onReady(controller.signal);
    const failure = expect(promotion).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(mocks.createTeam).toHaveBeenCalledOnce());
    controller.abort();
    finishTeam({ initializeIdentityActivitySigner() {} });
    await failure;
    expect(replaceApp).not.toHaveBeenCalled();
    expect(mocks.order).toEqual(["jobs"]);
    stopHub(priorListeners);
    await running;
    expect(mocks.order).toEqual(["jobs", "http", "setup", "telemetry"]);
  });

  it("promotes the running listener to the Project Hub when setup becomes ready", async () => {
    const replaceApp = vi.fn();
    let onReady!: (signal: AbortSignal) => Promise<void>;
    mocks.createSetup.mockImplementation((_root, options: { onReady: (signal: AbortSignal) => Promise<void> }) => {
      onReady = options.onReady;
      return {
        services: { tag: "setup-services" },
        setup: { tag: "setup-runner", status: () => ({ ready: false }), shutdown: mocks.stopSetup },
      };
    });
    mocks.findConfig.mockReturnValue({ projectRoot: "/Users/private/project" });
    mocks.identity.mockReturnValue({ scaffold_id: "private-scaffold" });
    mocks.createApp
      .mockReturnValueOnce({ tag: "setup-app" })
      .mockReturnValueOnce({ tag: "hub-app" });
    let ready!: (server: { origin: string; close: typeof mocks.closeServer; replaceApp: typeof replaceApp }) => void;
    mocks.startServer.mockReturnValue(new Promise((resolve) => { ready = resolve; }));
    const priorListeners = new Set(process.listeners("SIGTERM"));
    const running = runSetupHubCommand({ projectRoot: "/Users/private/project", openBrowser: false });
    await vi.waitFor(() => expect(mocks.startServer).toHaveBeenCalledOnce());
    ready({ origin: "http://127.0.0.1:48123", close: mocks.closeServer, replaceApp });
    await vi.waitFor(() => expect(mocks.events).toHaveBeenCalledOnce());
    await onReady(new AbortController().signal);
    expect(replaceApp).toHaveBeenCalledWith({ tag: "hub-app" });
    expect(mocks.createApp).toHaveBeenNthCalledWith(2, expect.objectContaining({
      jobs: expect.anything(),
      telemetry: mocks.events,
    }));
    expect(mocks.createApp.mock.calls[1]?.[0].setup).toBeUndefined();
    expect(vi.mocked(process.stdout.write).mock.calls.some((call) => String(call[0]).includes("Project Hub is ready"))).toBe(true);
    const stop = process.listeners("SIGTERM").find((listener) => !priorListeners.has(listener));
    if (!stop) throw new Error("Hub did not install its shutdown handler.");
    stop("SIGTERM");
    await running;
    expect(mocks.order).toEqual(["http", "setup", "jobs", "telemetry"]);
  });
});

function stopHub(priorListeners: Set<(...args: any[]) => void>): void {
  const stop = process.listeners("SIGTERM").find((listener) => !priorListeners.has(listener));
  if (!stop) throw new Error("Hub did not install its shutdown handler.");
  stop("SIGTERM");
}
