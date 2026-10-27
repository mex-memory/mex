import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSetup } from "../index.js";
import * as population from "../headless-population.js";
import { runHeadlessSetup } from "../headless.js";
import * as headless from "../headless.js";
import { SETUP_HANDOFF_PROMPT } from "../unfinished.js";

const roots: string[] = [];
const restoreTTY: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const restore of restoreTTY.splice(0).reverse()) restore();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
function project() {
  const root = mkdtempSync(join(tmpdir(), "mex-terminal-")); roots.push(root);
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.spyOn(console, "log").mockImplementation(() => {});
  return root;
}
function populate(root: string) {
  for (const path of ["AGENTS.md", "ROUTER.md", "context/architecture.md", "context/stack.md", "context/conventions.md", "context/decisions.md", "context/setup.md"]) {
    writeFileSync(join(root, ".mex", path), "# Authored knowledge\n\nRetain this work.\n");
  }
}

describe("terminal setup outcomes", () => {
  it("--yes never launches a headless agent and returns an explicit resumable pause", async () => {
    const root = project();
    const launch = vi.spyOn(population, "launchHeadlessSetupPopulation");
    const result = await runSetup({ mode: "agent-memory", tools: ["codex"], yes: true });
    expect(result).toMatchObject({ outcome: "paused", exitCode: 2 });
    expect(launch).not.toHaveBeenCalled();
    expect(readFileSync(join(root, ".mex/config.json"), "utf8")).toContain('"codex"');
  });

  it("CI uses empty default choices without waiting for input", async () => {
    const root = project(); vi.stubEnv("CI", "1");
    expect(await runSetup({ mode: "agent-memory" })).toMatchObject({ outcome: "paused", exitCode: 2 });
    expect(JSON.parse(readFileSync(join(root, ".mex/config.json"), "utf8")).aiTools).toEqual([]);
  });

  it("plain completion preserves authored files and returns without a Hub server", async () => {
    const root = project();
    await runSetup({ mode: "agent-memory", tools: [], yes: true });
    populate(root);
    const before = readFileSync(join(root, ".mex/ROUTER.md"), "utf8");
    expect(await runSetup({ yes: true, openBrowser: true })).toMatchObject({ outcome: "complete", exitCode: 0 });
    expect(readFileSync(join(root, ".mex/ROUTER.md"), "utf8")).toBe(before);
    expect(readdirSync(join(root, ".mex"))).not.toContain("graph.db");
  });

  it("fresh dry-run has no prompts, agent launch, config or local writes", async () => {
    const root = project();
    const launch = vi.spyOn(population, "launchHeadlessSetupPopulation");
    expect(await runSetup({ mode: "agent-memory", tools: ["codex"], dryRun: true })).toMatchObject({ outcome: "dry-run", exitCode: 0 });
    expect(readdirSync(root)).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("the shared engine checks files even when a presentation adapter claims completion", async () => {
    const root = project();
    const run = vi.fn(async () => ({ tool: "codex" as const, completed: true }));
    expect(await runHeadlessSetup({ projectRoot: root, mode: "agent-memory", tools: [], populate: run })).toMatchObject({ ready: false, stage: "needs_population" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("the presentation callback can populate then continue through the shared engine", async () => {
    const root = project();
    expect(await runHeadlessSetup({ projectRoot: root, mode: "agent-memory", tools: [],
      populate: async () => { populate(root); return { tool: null, completed: true }; },
    })).toMatchObject({ ready: true, stage: "ready", mode: "agent-memory" });
  });

  it.each([
    { stdin: false, stdout: false, ci: "", yes: false },
    { stdin: false, stdout: false, ci: "1", yes: false },
    { stdin: false, stdout: false, ci: "", yes: true },
    { stdin: false, stdout: false, ci: "1", yes: true },
    { stdin: false, stdout: true, ci: "", yes: false },
    { stdin: true, stdout: false, ci: "", yes: false },
    { stdin: true, stdout: true, ci: "", yes: true },
    { stdin: true, stdout: true, ci: "1", yes: false },
    { stdin: true, stdout: true, ci: "", yes: false, term: "dumb" },
  ])("handoff addresses the caller for %j (#285)", async ({ stdin, stdout, ci, yes, term }) => {
    const root = project();
    terminalStreams(stdin, stdout); vi.stubEnv("CI", ci); vi.stubEnv("TERM", term ?? "xterm");
    const lines = captureOutput();
    for (let run = 0; run < 2; run++) {
      lines.length = 0;
      expect(await runSetup({ mode: "agent-memory", tools: [], yes })).toMatchObject({ outcome: "paused", exitCode: 2 });
      const out = lines.join("\n");
      expect(out).toContain(SETUP_HANDOFF_PROMPT);
      if (stdin && stdout) {
        expect(out).toContain("Population prompt (paste it into your agent):");
        expect(out).not.toContain("You are the population agent");
      } else {
        expect(out).toContain("You are the population agent. Run `mex setup next --start` in this session");
        expect(out).toContain("Do not commit until setup reports complete.");
        expect(out).toContain("Existing authored files are preserved.");
        expect(out).not.toMatch(/paste|your agent's chat|run `mex setup` again to finalize/i);
        expect(out).toContain("Population prompt:");
      }
    }
    expect(readFileSync(join(root, ".mex/local/setup-plan.json"), "utf8")).toContain('"queue"');
  });

  it.each([[], ["cursor"], ["claude"]] as const)("code-repo handoff with selected tools %j", async (...tools) => {
    const root = project(); mkdirSync(join(root, ".git"));
    const result = await runHeadlessSetup({ projectRoot: root, mode: "agent-memory", tools: [], confirmPopulation: true });
    const run = vi.spyOn(headless, "runHeadlessSetup").mockResolvedValue({ ...result, mode: "code-repo" });
    const launch = vi.spyOn(population, "launchHeadlessSetupPopulation");
    for (const tty of [false, true]) {
      terminalStreams(tty, tty);
      const lines = captureOutput();
      expect(await runSetup({ mode: "code-repo", tools, yes: true })).toMatchObject({ exitCode: 2 });
      expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "code-repo", tools, confirmPopulation: true }));
      expect(lines.join("\n")).toContain(tty ? "Population prompt (paste it into your agent):"
        : "You are the population agent. Run `mex setup next --start` in this session");
    }
    expect(launch).not.toHaveBeenCalled();
  });

  // Plain setup never launches agents. Exercise all result variants at the
  // presentation boundary, including the full-prompt fallback when recording a queue fails.
  it.each([
    "Required scaffold placeholders remain. Finish the manual population prompt, then check again.",
    "The agent exited successfully, but required scaffold placeholders remain.",
    "The agent failed before population completed. Finish the manual population prompt, then check again.",
    "Usage limit reached. Rerun `mex setup` after the limit resets at 3:50pm.",
  ])("full population prompt: %s", async message => {
    project();
    const result = await runHeadlessSetup({ projectRoot: process.cwd(), mode: "agent-memory", tools: [], confirmPopulation: true });
    vi.spyOn(headless, "runHeadlessSetup").mockResolvedValue({ ...result, prompt: "Populate the scaffold files.", message });
    for (const tty of [false, true]) {
      terminalStreams(tty, tty);
      const lines = captureOutput();
      expect(await runSetup({ mode: "agent-memory", tools: [], yes: true })).toMatchObject({ outcome: "paused", exitCode: 2 });
      const out = lines.join("\n");
      expect(out).toContain("Population prompt:\n\nPopulate the scaffold files.");
      if (tty) {
        expect(out).toContain("Run `mex setup` to continue. Existing authored files are preserved.");
        expect(out).not.toContain("You are the population agent");
      } else {
        expect(out).toContain(message);
        expect(out).toContain("You are the population agent. Follow the prompt below in this session.");
        expect(out).toContain("When done, run `mex setup` again to finalize.");
        expect(out).toContain("Do not commit until setup reports complete (`mex setup` exits with code 0).");
      }
    }
  });

  it.each([false, true])("a pause without a prompt does not refer to a missing prompt (TTY=%s)", async tty => {
    project(); terminalStreams(tty, tty);
    const result = await runHeadlessSetup({ projectRoot: process.cwd(), mode: "agent-memory", tools: [], confirmPopulation: true });
    vi.spyOn(headless, "runHeadlessSetup").mockResolvedValue({ ...result, prompt: null, message: "Population is unfinished." });
    const lines = captureOutput();
    expect(await runSetup({ mode: "agent-memory", yes: true })).toMatchObject({ exitCode: 2 });
    const out = lines.join("\n");
    expect(out).not.toContain("prompt below");
    expect(out).not.toContain("Population prompt:");
    if (tty) {
      expect(out).toContain("Run `mex setup` to continue. Existing authored files are preserved.");
      expect(out).not.toContain("You are the population agent");
    } else {
      expect(out).toContain("Population is unfinished.");
      expect(out).toContain("Run `mex setup` again to continue.");
      expect(out).toContain("Do not commit until setup reports complete");
    }
  });
});

function terminalStreams(input: boolean, output: boolean) {
  for (const [stream, terminal] of [[process.stdin, input], [process.stdout, output]] as const) {
    const original = Object.getOwnPropertyDescriptor(stream, "isTTY");
    Object.defineProperty(stream, "isTTY", { value: terminal, configurable: true });
    restoreTTY.push(() => original ? Object.defineProperty(stream, "isTTY", original) : delete (stream as { isTTY?: boolean }).isTTY);
  }
}
function captureOutput(): string[] {
  const lines: string[] = [];
  vi.mocked(console.log).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  return lines;
}
