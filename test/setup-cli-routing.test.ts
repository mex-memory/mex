import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ hub: vi.fn(), setup: vi.fn(), entry: vi.fn(), parseTools: vi.fn(), capture: vi.fn(), next: vi.fn(), repoStart: vi.fn() }));
vi.mock("../src/repo-start/command.js", () => ({ runRepoStart: mocks.repoStart }));
vi.mock("../src/hub/command.js", () => ({ launchHub: mocks.hub }));
vi.mock("../src/setup/index.js", () => ({ runSetup: mocks.setup, parseSetupTools: mocks.parseTools }));
vi.mock("../src/setup/entry.js", () => ({ resolveDefaultEntry: mocks.entry, findSetupProjectRoot: () => "/project" }));
vi.mock("../src/setup/next.js", () => ({ runSetupNext: mocks.next }));
vi.mock("../src/telemetry/index.js", async (original) => ({
  ...await original<typeof import("../src/telemetry/index.js")>(), captureEvent: mocks.capture, flush: async () => {},
}));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.stubEnv("MEX_TELEMETRY", "0");
  mocks.setup.mockResolvedValue({ outcome: "complete", message: "Setup complete.", exitCode: 0 });
  mocks.entry.mockResolvedValue("setup");
  mocks.repoStart.mockResolvedValue({ exitCode: 0, place: "git" });
  mocks.parseTools.mockImplementation((tools: string[]) => tools.includes("none") ? [] : tools);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = 0; });

describe("setup entry points", () => {
  it("leaves prompt cleanup to the setup engine after the status shortcut", async () => {
    const prompts = await import("../src/agent-prompt.js");
    const cleanup = vi.spyOn(prompts, "cleanupStaleSetupPrompts");
    const { program } = await import("../src/cli.js");
    await program.parseAsync(["setup", "--legacy"], { from: "user" });
    expect(mocks.setup).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
  });
  it("routes `mex setup next` to the one-step command, prints its output and keeps its exit code", async () => {
    mocks.next.mockResolvedValue({ status: "task", exitCode: 0, progress: { done: 1, total: 5 }, output: "MEX setup 1/5: subsystem src/a/" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { program } = await import("../src/cli.js");
    await program.parseAsync(["setup", "next"], { from: "user" });
    expect(mocks.next).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectRoot: "/project" }));
    expect(log).toHaveBeenCalledWith("MEX setup 1/5: subsystem src/a/");
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    mocks.next.mockResolvedValue({ status: "blocked", exitCode: 1, progress: null, output: "No Git repository found." });
    await program.parseAsync(["setup", "next"], { from: "user" });
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [["setup", "--browser"], { openBrowser: true, setup: true }],
    [["setup", "--browser", "--mode", "agent-memory", "--no-open", "--port", "48124"], { openBrowser: false, setup: true, mode: "agent-memory", port: 48124 }],
    [["hub", "--no-open"], { openBrowser: false }],
  ] as const)("launches the browser flow for %j", async (args, options) => {
    const { program } = await import("../src/cli.js");
    await program.parseAsync([...args], { from: "user" });
    expect(mocks.hub).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(options));
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.entry).not.toHaveBeenCalled();
  });

  it.each([[[]], [["setup"]], [["--no-open", "--port", "48123"]]] as const)("turns the repo on for %j without the 0.8 setup or the Hub", async (args) => {
    mocks.repoStart.mockResolvedValue({ exitCode: 1, place: "refused" });
    const { program } = await import("../src/cli.js");
    await program.parseAsync([...args], { from: "user" });
    expect(mocks.repoStart).toHaveBeenCalledExactlyOnceWith();
    expect(process.exitCode).toBe(1);
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(mocks.hub).not.toHaveBeenCalled();
    expect(mocks.entry).not.toHaveBeenCalled();
  });

  it.each([["setup", "--legacy"], ["setup", "--cli"], ["setup", "--dry-run"], ["setup", "--mode", "agent-memory"]])("uses the 0.8 terminal setup for %j", async (...args) => {
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

  it("describes setup as the alias of `mex`, keeps --browser and hides the 0.8 terminal flags in --help", async () => {
    const { program } = await import("../src/cli.js");
    const command = program.commands.find(command => command.name() === "setup")!;
    let help = "";
    command.configureOutput({ writeOut: (text) => { help += text; } });
    command.outputHelp();
    expect(help).toContain("Turn MEX on for this repo (the same as `mex`)");
    expect(help).toContain("--browser");
    expect(help).toContain("--no-open");
    for (const hidden of ["--legacy", "--cli", "--tool", "--yes", "--force", "--dry-run", "--mode"]) expect(help).not.toContain(hidden);
  });

  it("passes --force to terminal setup so a set-up checkout reruns the full flow (#284)", async () => {
    const { program } = await import("../src/cli.js");
    await program.parseAsync(["setup", "--force", "--no-open"], { from: "user" });
    expect(mocks.setup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ force: true, openBrowser: false }));
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
    await program.parseAsync(["setup", "--legacy"], { from: "user" });
    expect(process.exitCode).toBe(exitCode);
  });

  it("reports a failed bare command without starting the 0.8 setup or the Hub", async () => {
    const { program } = await import("../src/cli.js");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.repoStart.mockRejectedValue(new Error("Could not inspect the project."));
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
