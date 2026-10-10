import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSetup } from "../index.js";
import * as population from "../headless-population.js";
import { runHeadlessSetup } from "../headless.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
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
});
