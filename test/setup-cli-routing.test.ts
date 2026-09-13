import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ hub: vi.fn(), setup: vi.fn(), tui: vi.fn(), capture: vi.fn() }));
vi.mock("../src/hub/command.js", () => ({ launchHub: mocks.hub }));
vi.mock("../src/setup/index.js", () => ({ runSetup: mocks.setup }));
vi.mock("../src/tui.js", () => ({ launchTui: mocks.tui }));
vi.mock("../src/telemetry/index.js", async (original) => ({
  ...await original<typeof import("../src/telemetry/index.js")>(), captureEvent: mocks.capture, flush: async () => {},
}));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.stubEnv("MEX_TELEMETRY", "0"); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = 0; });

describe("setup entry points", () => {
  it.each([
    [[], { openBrowser: true }],
    [["--no-open", "--port", "48123"], { openBrowser: false, port: 48123 }],
    [["setup"], { openBrowser: true, setup: true }],
    [["setup", "--mode", "agent-memory", "--no-open", "--port", "48124"], { openBrowser: false, setup: true, mode: "agent-memory", port: 48124 }],
    [["hub", "--no-open"], { openBrowser: false }],
  ] as const)("launches the browser flow for %j", async (args, options) => {
    const { program } = await import("../src/cli.js");
    await program.parseAsync([...args], { from: "user" });
    expect(mocks.hub).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(options));
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(mocks.tui).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it.each([["setup", "--cli"], ["setup", "--dry-run"], ["setup", "--cli", "--mode", "agent-memory"]])("keeps terminal setup for %j", async (...args) => {
    const { program } = await import("../src/cli.js");
    await program.parseAsync(args, { from: "user" });
    expect(mocks.setup).toHaveBeenCalledExactlyOnceWith({ dryRun: args.includes("--dry-run") || undefined, mode: args.includes("--mode") ? "agent-memory" : undefined });
    expect(mocks.hub).not.toHaveBeenCalled();
  });

  it("keeps the TUI explicitly available", async () => {
    const { program } = await import("../src/cli.js");
    await program.parseAsync(["tui"], { from: "user" });
    expect(mocks.tui).toHaveBeenCalledOnce();
    expect(mocks.hub).not.toHaveBeenCalled();
  });

  it("rejects browser flags with a terminal dry run before either action", async () => {
    const { program } = await import("../src/cli.js");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await program.parseAsync(["setup", "--dry-run", "--no-open"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(mocks.hub).not.toHaveBeenCalled(); expect(mocks.setup).not.toHaveBeenCalled();
  });
});
