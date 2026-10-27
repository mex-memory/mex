/**
 * Per-subsystem population through the shared setup engine, against a real
 * code graph and the real in-process Wiki apply. Agents are simulated: each
 * fake session reads its MEX prompt and writes what a session would write.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHeadlessSetup } from "../src/setup/headless.js";
import type { HeadlessPopulationOptions } from "../src/setup/headless-population.js";
import type { SetupCoverageProgress } from "../src/setup/subsystem-runs.js";
import { checkBatchFile } from "../src/setup/subsystem-apply.js";
import { SETUP_PLAN_STATE_FILE, loadPlanState, unitBatchFile } from "../src/setup/subsystem-state.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a SQLite handle briefly */ }
  }
});

const FOLDERS = {
  alpha: ["parse", "format", "trim"],
  beta: ["route", "match", "group"],
  gamma: ["store", "load", "clear"],
} as const;

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-per-subsystem-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [folder, names] of Object.entries(FOLDERS)) {
    mkdirSync(join(root, "src", folder), { recursive: true });
    for (const name of names) {
      writeFileSync(join(root, "src", folder, `${name}.ts`), `export function ${name}${folder}(input: string): string {\n  if (input.length > 64) return input.slice(0, 64);\n  return input.trim();\n}\n`);
    }
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base"], { cwd: root });
  return root;
}

function walkMarkdown(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "local") return [];
    return statSync(path).isDirectory() ? walkMarkdown(path) : path.endsWith(".md") ? [path] : [];
  });
}

/** A simulated agent for every kind of session; `badOnce` names subsystems whose first batch has a wrong symbol. */
function simulatedAgent(root: string, options: { badOnce?: string[] } = {}) {
  const prompts: string[] = [];
  const launch = async (input: HeadlessPopulationOptions) => {
    prompts.push(input.prompt);
    const prompt = input.prompt;
    const now = "2026-10-23T10:00:00Z";
    const write = (relative: string, value: unknown) => {
      mkdirSync(dirname(join(root, relative)), { recursive: true });
      writeFileSync(join(root, relative), JSON.stringify(value, null, 2));
    };
    const fact = (opId: string, file: string, title: string, groundsTo: unknown[]) => ({
      opId, type: "create-entry", actor: { kind: "agent", id: "simulated" }, timestamp: now, reason: "test",
      payload: { file, insertAt: { at: "end-of-file" }, type: "fact", title, body: `${title}.`, headingDepth: 2, status: "promoted",
        groundsTo, aliases: [`${title} one`, `${title} two`, `${title} three`] },
    });
    if (prompt.includes("this first one fills the shared files")) {
      // Only the files this session may write; the scope guard reports anything else.
      const shared = ["AGENTS.md", "ROUTER.md", ...["architecture", "stack", "conventions", "decisions", "setup"].map((name) => `context/${name}.md`)];
      for (const file of walkMarkdown(join(root, ".mex")).filter((path) => shared.some((name) => path.replaceAll("\\", "/").endsWith(`.mex/${name}`)))) {
        const text = readFileSync(file, "utf8");
        const filled = text.replaceAll("[Project Name]", "fixture").replaceAll("[YYYY-MM-DD]", "2026-10-23");
        if (filled !== text) {
          // Project knowledge goes in the project sections, not after MEX-managed boilerplate.
          const slot = /^## (?:What This Is|Current (?:Project|Operational) State)[^\n]*\r?\n/mu.exec(filled);
          const at = slot ? slot.index + slot[0].length : filled.length;
          writeFileSync(file, filled.slice(0, at) + "\nAuthored project guidance from source inspection.\n" + filled.slice(at));
        }
      }
      write(".mex/local/setup-ops/shared.json", [fact("setup_shared_entry", "context/architecture.md", "Inputs are trimmed by parsealpha", [{ file: "src/alpha/parse.ts", symbol: "parsealpha" }])]);
    } else if (prompt.startsWith("You are writing the MEX knowledge for one subsystem")) {
      const folder = /- Code: src\/(\w+)\//u.exec(prompt)![1]! as keyof typeof FOLDERS;
      const slug = /write "file": "context\/([^"]+)\.md"/u.exec(prompt)![1]!;
      const prefix = `setup_${slug.replace(/-/gu, "_")}_`;
      const bad = options.badOnce?.includes(folder);
      if (bad) options.badOnce = options.badOnce!.filter((entry) => entry !== folder);
      write(`.mex/local/setup-ops/${slug}.json`, [
        { opId: `${prefix}overview`, type: "create-entry", actor: { kind: "agent", id: "simulated" }, timestamp: now, reason: "overview",
          payload: { file: `context/${slug}.md`, insertAt: { at: "end-of-file" }, type: "component", title: `The ${folder} subsystem`,
            body: `The ${folder} helpers.`, description: `Helpers in src/${folder}`, headingDepth: 2, status: "promoted" } },
        ...(FOLDERS[folder] ?? []).map((name) => fact(`${prefix}${name}`, `context/${slug}.md`, `${name}${folder} caps input at 64 characters`,
          [{ file: `src/${folder}/${name}.ts`, symbol: bad && name === FOLDERS[folder][0] ? `${name}Missing` : `${name}${folder}` }])),
      ]);
    } else if (prompt.startsWith("MEX could not apply the batch file for")) {
      // Leaves the batch as it is (a session that could not fix it).
    } else if (prompt.startsWith("You are finishing an AI context scaffold")) {
      const router = join(root, ".mex", "ROUTER.md");
      writeFileSync(router, `${readFileSync(router, "utf8").trimEnd()}\n`);
    }
    return { tool: "claude" as const, completed: true };
  };
  return { launch, prompts };
}

describe("per-subsystem setup on a real graph", () => {
  it("covers every subsystem with in-process applies, fixes a refused batch from the real diagnostics, and finalizes", async () => {
    const root = repository();
    const agent = simulatedAgent(root, { badOnce: ["beta"] });
    // The fix session swaps the wrong name for the real one, as a session would after reading the code.
    const launch = async (input: HeadlessPopulationOptions) => {
      if (input.prompt.startsWith("MEX could not apply the batch file for")) {
        agent.prompts.push(input.prompt);
        const batch = /Batch file: (\S+)/u.exec(input.prompt)![1]!;
        const path = join(root, batch);
        writeFileSync(path, readFileSync(path, "utf8").replace("routeMissing", "routebeta"));
        return { tool: "claude" as const, completed: true };
      }
      return agent.launch(input);
    };
    const coverage: SetupCoverageProgress[] = [];
    const messages: string[] = [];
    const result = await runHeadlessSetup({
      projectRoot: root, tools: ["claude"],
      perSubsystem: { env: { MEX_SETUP_PER_SUBSYSTEM: "1" }, launch, trackSource: true },
      onPopulationCoverage: (entry) => coverage.push(entry),
      onMessage: (message) => messages.push(message),
    });
    expect(result).toMatchObject({ stage: "ready", ready: true, populated: true, populationTool: "claude" });
    expect(result.coverageNotice).toBe("Subsystems covered: 3 of 3, 10 facts written.");
    expect(result.message).toContain("Subsystems covered: 3 of 3");

    // The fix session got the engine's own refusal, with the declarations that do exist.
    const fixPrompt = agent.prompts.find((prompt) => prompt.startsWith("MEX could not apply"))!;
    expect(fixPrompt).toContain("GROUNDING_NOT_FOUND");
    expect(fixPrompt).toContain("routeMissing");
    expect(fixPrompt).toContain("routebeta");
    expect(agent.prompts.filter((prompt) => prompt.startsWith("You are writing the MEX knowledge"))).toHaveLength(3);

    const beta = readFileSync(join(root, ".mex/context/beta.md"), "utf8");
    expect(beta).toMatch(/^---\nname: beta\ndescription: Helpers in src\/beta\n/u);
    expect(beta).toContain("routebeta caps input at 64 characters");
    expect(beta).toContain("fingerprint");
    const state = loadPlanState(root).state!;
    expect(Object.fromEntries(state.subsystems.map((unit) => [unit.path, [unit.state, unit.facts]]))).toEqual({
      "src/alpha": ["done", 3], "src/beta": ["done", 3], "src/gamma": ["done", 3],
    });
    expect(state.shared).toMatchObject({ state: "done", facts: 1 });
    expect(state.final.state).toBe("done");
    expect(coverage.at(-1)).toMatchObject({ phase: "complete", done: 3, total: 3 });
    expect(messages.filter((message) => message.includes("expected scope")), messages.join(" | ")).toEqual([]);
    expect(checkBatchFile(join(root, ".mex/local/setup-ops/beta.json"), { opIdPrefix: "setup_beta_", files: ["context/beta.md"] }).ok).toBe(true);

    // A rerun has nothing left to do and launches nothing.
    const rerun = simulatedAgent(root);
    const again = await runHeadlessSetup({ projectRoot: root, tools: ["claude"], perSubsystem: { env: { MEX_SETUP_PER_SUBSYSTEM: "1" }, launch: rerun.launch } });
    expect(again.ready).toBe(true);
    expect(rerun.prompts).toEqual([]);
  }, 240_000);

  it("keeps the single session for a small repository unless forced", async () => {
    const root = repository();
    const prompts: string[] = [];
    const subsystemLaunch = simulatedAgent(root);
    const result = await runHeadlessSetup({
      projectRoot: root, tools: ["claude"],
      perSubsystem: { env: {}, launch: subsystemLaunch.launch },
      populate: async (input) => {
        prompts.push(input.prompt);
        return { tool: "claude", completed: false };
      },
    });
    expect(result.stage).toBe("needs_population");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("COVERAGE — cover the whole project");
    expect(subsystemLaunch.prompts).toEqual([]);
    expect(loadPlanState(root).state).toMatchObject({ queue: { mode: "single" }, shared: { state: "pending" }, subsystems: [] });
  }, 240_000);

  it("runs per-subsystem sessions on a small repository when the only agent has file tools, and says which agent runs", async () => {
    const root = repository();
    const agent = simulatedAgent(root);
    const tools: Array<string | undefined> = [];
    const launch = async (input: HeadlessPopulationOptions) => {
      tools.push(input.tool);
      return { ...(await agent.launch(input)), tool: "copilot" as const };
    };
    const messages: string[] = [];
    const result = await runHeadlessSetup({
      projectRoot: root, tools: ["windsurf"],
      perSubsystem: { env: {}, launch, findAgent: async (_selected, requireCommands) => requireCommands ? null : { tool: "copilot", selected: false } },
      populate: async () => { throw new Error("the single session needs mex commands; a file-only agent must never get it"); },
      onMessage: (message) => messages.push(message),
    });
    expect(result).toMatchObject({ stage: "ready", ready: true, populationTool: "copilot" });
    expect(new Set(tools)).toEqual(new Set(["copilot"]));
    expect(agent.prompts.filter((prompt) => prompt.startsWith("You are writing the MEX knowledge"))).toHaveLength(3);
    expect(messages).toContain("Windsurf has no CLI MEX can run in the background here, so MEX runs Copilot (`copilot`) for the setup sessions. To choose another agent, rerun `mex setup` and select it.");
  }, 240_000);

  it("reuses the stored plan on a rerun, and replaces a corrupt one with a notice", async () => {
    const root = repository();
    const first = simulatedAgent(root);
    const stopAfterShared = async (input: HeadlessPopulationOptions) => {
      if (input.prompt.startsWith("You are writing the MEX knowledge")) {
        const { HeadlessPopulationError } = await import("../src/setup/headless-population.js");
        throw new HeadlessPopulationError("authentication", "claude");
      }
      return first.launch(input);
    };
    await expect(runHeadlessSetup({ projectRoot: root, tools: ["claude"], perSubsystem: { env: { MEX_SETUP_PER_SUBSYSTEM: "1" }, launch: stopAfterShared, parallelRuns: 1 } }))
      .rejects.toThrow(/could not authenticate.*rerun `mex setup` to continue/su);
    const stored = loadPlanState(root).state!;
    // The shared batch may still be waiting for the graph when the stop lands; it is on disk either way.
    expect(stored.shared.state === "done" || existsSync(join(root, unitBatchFile("shared")))).toBe(true);
    // A new folder would change a freshly computed plan; the stored one is kept.
    mkdirSync(join(root, "src", "delta"));
    for (const name of ["one", "two", "three", "four", "five"]) writeFileSync(join(root, "src", "delta", `${name}.ts`), `export const ${name} = 1;\n`);
    const second = simulatedAgent(root);
    const resumed = await runHeadlessSetup({ projectRoot: root, tools: ["claude"], perSubsystem: { env: {}, launch: second.launch } });
    expect(resumed.ready).toBe(true);
    expect(second.prompts.some((prompt) => prompt.includes("this first one fills the shared files"))).toBe(false);
    expect(second.prompts.filter((prompt) => prompt.startsWith("You are writing the MEX knowledge"))).toHaveLength(3);
    expect(second.prompts.join("\n")).not.toContain("src/delta");
    expect(loadPlanState(root).state!.plan).toEqual(stored.plan);

    // An unreadable stored plan is set aside with a notice and replaced; the batches
    // already on disk replay, so no earlier unit runs a session again.
    writeFileSync(join(root, SETUP_PLAN_STATE_FILE), "{ not json");
    const messages: string[] = [];
    const third = simulatedAgent(root);
    const replaced = await runHeadlessSetup({ projectRoot: root, tools: ["claude"], perSubsystem: { env: { MEX_SETUP_PER_SUBSYSTEM: "1" }, launch: third.launch }, onMessage: (message) => messages.push(message) });
    expect(replaced.ready).toBe(true);
    expect(messages.some((message) => message.startsWith("Warning: The stored setup plan (.mex/local/setup-plan.json) could not be used because it is not valid JSON"))).toBe(true);
    // The new plan also has the folder added since; only it needs a session.
    expect(third.prompts.map((prompt) => prompt.slice(0, 40))).toEqual(["You are writing the MEX knowledge for on"]);
    expect(third.prompts[0]).toContain("- Code: src/delta/");
    expect(loadPlanState(root).state!.subsystems.every((unit) => unit.state === "done")).toBe(true);
    expect(readdirSync(join(root, ".mex", "local")).some((name) => name.startsWith("setup-plan.json.unreadable-"))).toBe(true);
  }, 300_000);
});
