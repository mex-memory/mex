import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectSetupStatus, runHeadlessSetup } from "../headless.js";
import * as population from "../headless-population.js";
import { runSetup } from "../index.js";
import { MEX_ANCHOR_START } from "../anchor.js";
import { loadConfiguredAiTools, loadConfiguredSetupMode, hasConfiguredAiTools } from "../../config.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); }
    catch { /* Windows can hold a sqlite handle briefly. */ }
  }
});

describe("headless setup status", () => {
  it("asks for git before code-repo setup in a folder with no repository", () => {
    const root = fixture();
    expect(inspectSetupStatus(root).stage).toBe("needs_git");
    expect(inspectSetupStatus(root).ready).toBe(false);
  });

  it("keeps ordinary inspection byte-empty and defaults legacy projects to code-repo", () => {
    const root = fixture();
    expect(inspectSetupStatus(root).mode).toBe("code-repo");
    expect(readdirSync(root)).toEqual([]);
    const mex = join(root, ".mex");
    writePopulatedScaffold(mex);
    const before = snapshot(root);
    expect(inspectSetupStatus(root)).toMatchObject({ mode: "code-repo", stage: "needs_git", ready: false });
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(mex, "config.json"))).toBe(false);
  });

  it("does not repair malformed configuration during status inspection", () => {
    const root = fixture();
    const mex = join(root, ".mex");
    mkdirSync(mex);
    writeFileSync(join(mex, "config.json"), "{broken\n");
    const before = snapshot(root);
    expect(inspectSetupStatus(root).mode).toBe("code-repo");
    expect(snapshot(root)).toEqual(before);
  });

  it("asks for setup in a git repo without a scaffold", () => {
    const root = gitRepo();
    expect(inspectSetupStatus(root)).toMatchObject({
      hasGit: true,
      hasScaffold: false,
      stage: "needs_setup",
      ready: false,
    });
  });
});

describe("headless setup run", () => {
  it("delivers the real manual prompt and integration guidance before a population failure", async () => {
    const root = fixture();
    const authoredRules = `My existing agent rules.\n${MEX_ANCHOR_START}\n`;
    writeFileSync(join(root, ".cursorrules"), authoredRules);
    const prompt = vi.fn();
    const notes = vi.fn();
    vi.spyOn(population, "launchHeadlessSetupPopulation").mockImplementation(async options => {
      expect(prompt).toHaveBeenCalledExactlyOnceWith(options.prompt);
      expect(options.prompt.length).toBeGreaterThan(100);
      expect(notes).toHaveBeenCalledOnce();
      throw new Error("Simulated agent failure");
    });
    await expect(runHeadlessSetup({ projectRoot: root, mode: "agent-memory", tools: ["cursor"],
      onPopulationPrompt: prompt, onAnchorNotes: notes })).rejects.toThrow("Simulated agent failure");
    expect(notes.mock.calls[0][0].join(" ")).toContain(".cursorrules");
    expect(readFileSync(join(root, ".cursorrules"), "utf8")).toBe(authoredRules);
  });

  it("builds a code-repo graph through the isolated worker and pauses without committing", async () => {
    const root = gitRepo();
    const steps: string[] = [];
    const result = await runHeadlessSetup({ projectRoot: root, tools: [], confirmPopulation: true,
      onProgress: ({ step }) => steps.push(step) });
    expect(result).toMatchObject({ mode: "code-repo", stage: "needs_population", ready: false });
    expect(existsSync(join(root, ".mex", "graph.db"))).toBe(true);
    expect(existsSync(join(root, ".mex", "wiki.db"))).toBe(false);
    expect(steps).toContain("graph");
    expect(() => execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, stdio: "ignore" })).toThrow();
  });

  it("refuses code-repo setup before writing any files when Git is absent", async () => {
    const root = fixture();
    await expect(runHeadlessSetup({ projectRoot: root, tools: [] })).rejects.toThrow("No Git repository");
    expect(readdirSync(root)).toEqual([]);
  });

  it("persists agent-memory intent across a fresh status read and omitted-mode resume", async () => {
    const root = fixture();
    await runHeadlessSetup({ projectRoot: root, mode: "agent-memory", tools: ["cursor"] });
    const before = snapshot(root);
    expect(inspectSetupStatus(root)).toMatchObject({ mode: "agent-memory", stage: "needs_population" });
    expect(snapshot(root)).toEqual(before);
    const resumed = await runHeadlessSetup({ projectRoot: root, confirmPopulation: true });
    expect(resumed).toMatchObject({ mode: "agent-memory", stage: "needs_population", selectedTools: ["cursor"] });
    expect(loadConfiguredSetupMode(join(root, ".mex"))).toBe("agent-memory");
  });

  it("persists an explicitly empty tool choice and retains unrelated configuration", async () => {
    const root = fixture();
    const mex = join(root, ".mex");
    mkdirSync(mex);
    writeFileSync(join(mex, "config.json"), JSON.stringify({
      aiTools: ["cursor"], setupMode: "agent-memory", scaffold_id: "existing-id", custom: { retained: true },
    }));
    await runHeadlessSetup({ projectRoot: root, tools: [], confirmPopulation: true });
    expect(loadConfiguredAiTools(mex)).toEqual([]);
    expect(hasConfiguredAiTools(mex)).toBe(true);
    expect(JSON.parse(readFileSync(join(mex, "config.json"), "utf8"))).toMatchObject({
      aiTools: [], scaffold_id: "existing-id", custom: { retained: true }, setupMode: "agent-memory",
    });
    expect(inspectSetupStatus(root).tools.every((tool) => !tool.selected)).toBe(true);
    const resumed = await runHeadlessSetup({ projectRoot: root, confirmPopulation: true });
    expect(resumed.selectedTools).toEqual([]);
  });

  it.each([false, true])("completes agent-memory with Git=%s without building indexes", async (withGit) => {
    const root = withGit ? gitRepo() : fixture();
    await runHeadlessSetup({ projectRoot: root, mode: "agent-memory", tools: [] });
    const mex = join(root, ".mex");
    writePopulatedScaffold(mex);
    const authoredRouter = readFileSync(join(mex, "ROUTER.md"), "utf8");
    const steps: string[] = [];
    const resumed = await runHeadlessSetup({ projectRoot: root, confirmPopulation: true,
      onProgress: ({ step }) => steps.push(step) });
    expect(resumed).toMatchObject({ mode: "agent-memory", ready: true, stage: "ready", commitCommands: [] });
    expect(inspectSetupStatus(root)).toMatchObject({ mode: "agent-memory", ready: true, graphReady: false, wikiReady: false });
    expect(steps).not.toContain("graph");
    expect(steps).not.toContain("finalize");
    expect(readFileSync(join(mex, "ROUTER.md"), "utf8")).toBe(authoredRouter);
  });

  it("checks incomplete manual population without launching another AI session", async () => {
    const root = fixture();
    const launch = vi.spyOn(population, "launchHeadlessSetupPopulation").mockResolvedValue({ tool: "codex", completed: false });
    await runHeadlessSetup({ projectRoot: root, mode: "agent-memory", tools: ["codex"] });
    expect(launch).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ allowNonGit: true }));
    launch.mockClear();
    const result = await runHeadlessSetup({ projectRoot: root, confirmPopulation: true });
    expect(result).toMatchObject({ stage: "needs_population", populationTool: null, ready: false });
    expect(result.prompt).toEqual(expect.any(String));
    expect(result.message).toContain("placeholders remain");
    expect(launch).not.toHaveBeenCalled();
  });

  it("forwards actual population transcript output to the browser observer", async () => {
    const root = fixture();
    const entry = { tool: "codex" as const, kind: "assistant" as const, text: "Reading the repository." };
    vi.spyOn(population, "launchHeadlessSetupPopulation").mockImplementation(async options => {
      options.onTranscript?.(entry);
      return { tool: "codex", completed: false };
    });
    const onPopulationTranscript = vi.fn();
    await runHeadlessSetup({ projectRoot: root, mode: "agent-memory", tools: ["codex"], onPopulationTranscript });
    expect(onPopulationTranscript).toHaveBeenCalledExactlyOnceWith(entry);
  });

  it("the CLI resumes saved agent-memory mode and empty tools during a nonmutating dry run", async () => {
    const root = fixture();
    await runHeadlessSetup({ projectRoot: root, mode: "agent-memory", tools: [] });
    const before = snapshot(root);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runSetup({ dryRun: true });
    expect(snapshot(root)).toEqual(before);
    expect(output.mock.calls.flat().join("\n")).toContain("agent-memory workspace");
    expect(output.mock.calls.flat().join("\n")).toContain("Using configured AI tools: none");
  });

  it("writes the same scaffold files as CLI setup and pauses at population", async () => {
    const root = fixture();
    const result = await runHeadlessSetup({
      projectRoot: root,
      mode: "agent-memory",
      tools: ["cursor"],
    });

    expect(result.stage).toBe("needs_population");
    expect(result.populated).toBe(false);
    expect(result.prompt).toEqual(expect.any(String));
    expect(result.prompt?.length).toBeGreaterThan(20);
    expect(existsSync(join(root, ".mex", "ROUTER.md"))).toBe(true);
    expect(existsSync(join(root, ".mex", "AGENTS.md"))).toBe(true);
    expect(existsSync(join(root, ".mex", "HEARTBEAT.md"))).toBe(true);
    expect(existsSync(join(root, ".cursorrules"))).toBe(true);
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-headless-setup-"));
  roots.push(root);
  return root;
}

function gitRepo(): string {
  const root = fixture();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "setup@example.com"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Setup"], { cwd: root, stdio: "ignore" });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "export const ready = true;\n");
  return root;
}

function writePopulatedScaffold(mex: string): void {
  for (const file of ["AGENTS.md", "ROUTER.md", "context/architecture.md", "context/stack.md",
    "context/conventions.md", "context/decisions.md", "context/setup.md"]) {
    const path = join(mex, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "last_updated: 2026-09-10\n# Authored knowledge\nPreserve this content.\n");
  }
}

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const relative = prefix + entry.name;
      if (entry.isDirectory()) visit(join(directory, entry.name), relative + "/");
      else result[relative] = readFileSync(join(directory, entry.name), "base64");
    }
  };
  visit(root, "");
  return result;
}
