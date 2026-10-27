import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: vi.fn(), createCapture: vi.fn(), startTelemetry: vi.fn(), stopTelemetry: vi.fn(async () => undefined),
  startServer: vi.fn(), closeServer: vi.fn(async () => undefined),
  createApp: vi.fn(), initializeJobs: vi.fn(), shutdownJobs: vi.fn(async () => undefined),
  jobOptions: vi.fn(), order: [] as string[],
}));
vi.mock("../../telemetry/index.js", () => ({ createProjectTelemetryCapture: mocks.createCapture, startHubTelemetry: mocks.startTelemetry }));
vi.mock("../static/assets.js", () => ({ HubAssetManifest: class {} }));
vi.mock("../security/session.js", () => ({ createBootstrapToken: () => "private-bootstrap-token", HubSessionManager: class {} }));
vi.mock("../app.js", () => ({ createHubApp: mocks.createApp }));
vi.mock("../jobs/index.js", () => ({ HubJobManager: class {
  constructor(options: unknown) { mocks.jobOptions(options); }
  initialize = mocks.initializeJobs;
  shutdown = mocks.shutdownJobs;
} }));
vi.mock("../jobs/graph.js", () => ({ createGraphJobExecutors: () => ({}) }));
vi.mock("../jobs/wiki.js", () => ({ createWikiJobExecutors: () => ({}) }));
vi.mock("../node-server.js", () => ({ startHubNodeServer: mocks.startServer }));
vi.mock("../services.js", () => ({ createLocalHubReadServices: () => ({}), createHubWikiMigration: () => ({}) }));
vi.mock("../../team/local-state/index.js", () => ({ TeamLocalState: class {} }));
vi.mock("../../graph/application-adapter.js", () => ({ createRepositoryGraphPort: () => ({}) }));
vi.mock("../../wiki/application-adapter.js", () => ({ createRepositoryWikiPort: () => ({}) }));
vi.mock("../../team/workflow/repository-team-workflow-port.js", () => ({
  createRepositoryTeamWorkflowPort: async () => ({ initializeIdentityActivitySigner() {} }),
}));
vi.mock("../../team/specs/index.js", () => ({ createSpecReadService: () => ({}) }));

import { runHubCommand } from "../command.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.closeServer.mockImplementation(async () => { mocks.order.push("http"); });
  mocks.shutdownJobs.mockImplementation(async () => { mocks.order.push("jobs"); });
  mocks.stopTelemetry.mockImplementation(async () => { mocks.order.push("telemetry"); });
  mocks.startTelemetry.mockReturnValue(mocks.stopTelemetry);
  mocks.createCapture.mockReturnValue(mocks.events);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("Hub production telemetry lifecycle", () => {
  it("starts one session only after readiness and stops after HTTP intake and jobs", async () => {
    let ready!: (server: { origin: string; close: typeof mocks.closeServer }) => void;
    mocks.startServer.mockReturnValue(new Promise(resolve => { ready = resolve; }));
    const priorListeners = new Set(process.listeners("SIGTERM"));
    const running = runHubCommand({ projectRoot: "/Users/private/project", scaffoldId: "private-scaffold", openBrowser: false });
    await vi.waitFor(() => expect(mocks.startServer).toHaveBeenCalledOnce());
    expect(mocks.events).not.toHaveBeenCalled();
    expect(mocks.createCapture).toHaveBeenCalledWith("/Users/private/project");
    expect(mocks.startTelemetry).not.toHaveBeenCalled();
    ready({ origin: "http://127.0.0.1:48123", close: mocks.closeServer });
    await vi.waitFor(() => expect(mocks.events).toHaveBeenCalledOnce());
    const stop = process.listeners("SIGTERM").find(listener => !priorListeners.has(listener));
    if (!stop) throw new Error("Hub did not install its shutdown handler.");
    stop("SIGTERM");
    await running;
    expect(mocks.events.mock.calls).toEqual([["hub.session_started", {}]]);
    expect(mocks.startTelemetry).toHaveBeenCalledOnce();
    expect(mocks.order).toEqual(["http", "jobs", "telemetry"]);
    expect(mocks.createApp).toHaveBeenCalledWith(expect.objectContaining({ telemetry: mocks.events }));
    expect(mocks.jobOptions).toHaveBeenCalledWith(expect.objectContaining({ telemetry: mocks.events }));
    expect(process.listeners("SIGTERM").filter(listener => !priorListeners.has(listener))).toEqual([]);
  });

  it("does not count a failed listener startup as a Hub session", async () => {
    mocks.startServer.mockRejectedValue(new Error("listener failed"));
    await expect(runHubCommand({ projectRoot: "/private", scaffoldId: "private", openBrowser: false })).rejects.toThrow("listener failed");
    expect(mocks.events).not.toHaveBeenCalled();
    expect(mocks.startTelemetry).not.toHaveBeenCalled();
    expect(mocks.shutdownJobs).toHaveBeenCalledOnce();
  });
});
