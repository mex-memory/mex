import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ hub: vi.fn(), setup: vi.fn(), entry: vi.fn(), parseTools: vi.fn(), tui: vi.fn(), capture: vi.fn() }));
vi.mock("../src/hub/command.js", () => ({ launchHub: mocks.hub }));
vi.mock("../src/setup/index.js", () => ({ runSetup: mocks.setup, parseSetupTools: mocks.parseTools }));
vi.mock("../src/setup/entry.js", () => ({ resolveDefaultEntry: mocks.entry }));
vi.mock("../src/tui.js", () => ({ launchTui: mocks.tui }));
vi.mock("../src/telemetry/index.js", async (original) => ({
  ...await original<typeof import("../src/telemetry/index.js")>(), captureEvent: mocks.capture, flush: async () => {},
}));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.stubEnv("MEX_TELEMETRY", "0");
  mocks.setup.mockResolvedValue({ outcome: "complete", message: "Setup complete.", exitCode: 0 });
  mocks.entry.mockResolvedValue("setup");
  mocks.parseTools.mockImplementation((tools: string[]) => tools.includes("none") ? [] : tools);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = 0; });

describe("setup entry points", () => {
  it.each([
    [["setup", "--browser"], { openBrowser: true, setup: true }],
    [["setup", "--browser", "--mode", "agent-memory", "--no-open", "--port", "48124"], { openBrowser: false, setup: true, mode: "agent-memory", port: 48124 }],
    [["hub", "--no-open"], { openBrowser: false }],
  ] as const)("launches the browser flow for %j", async (args, options) => {
    const { program } = await import("../src/cli.js");
    await program.parseAsync([...args], { from: "user" });
    expect(mocks.hub).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(options));
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(mocks.tui).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.entry).not.toHaveBeenCalled();
  });

  it.each(["setup", "hub"] as const)("opens the correct default surface for a checkout needing %s", async (entry) => {
    mocks.entry.mockResolvedValue(entry);
    const { program } = await import("../src/cli.js");
    await program.parseAsync(["--no-open", "--port", "48123"], { from: "user" });
    expect(mocks.entry).toHaveBeenCalledExactlyOnceWith();
    if (entry === "setup") {
      expect(mocks.setup).toHaveBeenCalledExactlyOnceWith({ dryRun: undefined, mode: undefined, port: 48123, openBrowser: false });
      expect(mocks.hub).not.toHaveBeenCalled();
    } else {
      expect(mocks.hub).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ port: 48123, openBrowser: false }));
      expect(mocks.setup).not.toHaveBeenCalled();
    }
  });

  it.each([["setup"], ["setup", "--cli"], ["setup", "--dry-run"], ["setup", "--mode", "agent-memory"]])("uses terminal setup for %j", async (...args) => {
    const { program } = await import("../src/cli.js");
    await program.parseAsync(args, { from: "user" });
    expect(mocks.setup).toHaveBeenCalledExactlyOnceWith({
      dryRun: args.includes("--dry-run") || undefined,
      mode: args.includes("--mode") ? "agent-memory" : undefined,
      port: undefined, openBrowser: true,
    });
    expect(mocks.hub).not.toHaveBeenCalled();
    expect(mocks.entry).not.toHaveBeenCalled();
  });

  it.each([["--cli"], ["--dry-run"], ["--yes"], ["--tool", "codex"]])("rejects browser setup combined with terminal option %s", async (...flags) => {
    const { program } = await import("../src/cli.js");
    const command = program.commands.find(command => command.name() === "setup")!;
    command.exitOverride().configureOutput({ writeErr: () => {} });
    await expect(program.parseAsync(["setup", "--browser", ...flags], { from: "user" }))
      .rejects.toMatchObject({ code: "commander.conflictingOption" });
    expect(mocks.hub).not.toHaveBeenCalled();
    expect(mocks.setup).not.toHaveBeenCalled();
  });

  it("keeps the TUI explicitly available", async () => {
    const { program } = await import("../src/cli.js");
    await program.parseAsync(["tui"], { from: "user" });
    expect(mocks.tui).toHaveBeenCalledOnce();
    expect(mocks.hub).not.toHaveBeenCalled();
  });

  it.each(["--cli", "--dry-run", "--yes"])("passes finishing Hub options to terminal setup with %s", async (flag) => {
    const { program } = await import("../src/cli.js");
    await program.parseAsync(["setup", flag, "--no-open", "--port", "48125"], { from: "user" });
    expect(mocks.setup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ port: 48125, openBrowser: false }));
    expect(mocks.hub).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("retains explicit empty tool selection for terminal setup", async () => {
    const { program } = await import("../src/cli.js");
    await program.parseAsync(["setup", "--tool", "none", "--no-open"], { from: "user" });
    expect(mocks.parseTools).toHaveBeenCalledExactlyOnceWith(["none"]);
    expect(mocks.setup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tools: [], openBrowser: false }));
    expect(mocks.hub).not.toHaveBeenCalled();
  });

  it.each([
    ["complete", 0], ["paused", 2], ["cancelled", 130], ["failed", 1], ["dry-run", 0],
  ])("maps the %s result to its exit code", async (outcome, exitCode) => {
    const { program } = await import("../src/cli.js");
    mocks.setup.mockResolvedValue({ outcome, exitCode, message: "Setup result." });
    await program.parseAsync(["setup"], { from: "user" });
    expect(process.exitCode).toBe(exitCode);
  });

  it("handles a failed bare-command inspection without starting setup or the Hub", async () => {
    const { program } = await import("../src/cli.js");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.entry.mockRejectedValue(new Error("Could not inspect the project."));
    await program.parseAsync([], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("Could not inspect the project.");
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(mocks.hub).not.toHaveBeenCalled();
  });

  it("reports thrown terminal setup failures with exit code one", async () => {
    const { program } = await import("../src/cli.js");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.setup.mockRejectedValue(new Error("Setup could not start."));
    await program.parseAsync(["setup", "--cli"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("Setup could not start.");
    expect(mocks.hub).not.toHaveBeenCalled();
  });

  it("prints recovery instructions before local diagnostics for expected terminal failures", async () => {
    const { program } = await import("../src/cli.js");
    const { SetupError } = await import("../src/setup/errors.js");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.setup.mockRejectedValue(new SetupError("EACCES: /local/config", { userMessage: "Could not save configuration. Fix its permissions and retry setup." }));
    await program.parseAsync(["setup", "--cli", "--yes"], { from: "user" });
    expect(error.mock.calls).toEqual([
      ["Could not save configuration. Fix its permissions and retry setup."],
      ["Diagnostics: EACCES: /local/config"],
    ]);
    expect(process.exitCode).toBe(1);
  });
});
