/**
 * `mex setup next`, the one-paste setup, against a real code graph and the real
 * in-process Wiki apply. The user's agent is simulated: it reads the task file
 * each call names and writes what a session would write.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectSetupStatus, runHeadlessSetup } from "../src/setup/headless.js";
import { QUEUE_POPULATION_FINISH, runSetupNext, type SetupNextResult } from "../src/setup/next.js";
import { loadPlanState } from "../src/setup/subsystem-state.js";
import { readNextGraph } from "../src/setup/next-graph.js";
import { SETUP_HANDOFF_PROMPT, describeUnfinishedSetup } from "../src/setup/unfinished.js";
import { createRepositoryWikiPort } from "../src/wiki/application-adapter.js";
import { projectSetupStatus } from "../src/hub/setup/readiness.js";
import { inventoryScaffold } from "../src/wiki/migration/inventory.js";

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
const FORCE = { MEX_SETUP_PER_SUBSYSTEM: "1", MEX_SETUP_PARALLEL_RUNS: "1" };
const NOW = "2026-10-24T10:00:00Z";
/** A tool anchor MEX manages (it points at the scaffold), and a user's own rules file it must never touch. */
const MANAGED_ANCHOR = "# Rules\r\n\r\nAt the start of every session, read `.mex/ROUTER.md`.\r\n";
const USER_RULES = "my own rules, nothing about MEX\n";

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-next-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [folder, names] of Object.entries(FOLDERS)) {
    mkdirSync(join(root, "src", folder), { recursive: true });
    for (const name of names) {
      writeFileSync(join(root, "src", folder, `${name}.ts`), `export function ${name}${folder}(input: string): string {\n  if (input.length > 64) return input.slice(0, 64);\n  return input.trim();\n}\n`);
    }
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  writeFileSync(join(root, "CLAUDE.md"), MANAGED_ANCHOR);
  writeFileSync(join(root, ".windsurfrules"), USER_RULES);
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

function fillPlaceholders(root: string): void {
  for (const file of walkMarkdown(join(root, ".mex"))) {
    const text = readFileSync(file, "utf8");
    const filled = text.replaceAll("[Project Name]", "fixture").replaceAll("[YYYY-MM-DD]", "2026-10-24");
    if (filled !== text) {
      // Project knowledge goes in the project sections, not after MEX-managed boilerplate.
      const slot = /^## (?:What This Is|Current (?:Project|Operational) State)[^\n]*\r?\n/mu.exec(filled);
      const at = slot ? slot.index + slot[0].length : filled.length;
      writeFileSync(file, filled.slice(0, at) + "\nAuthored project guidance from source inspection.\n" + filled.slice(at));
    }
  }
}

const fact = (opId: string, file: string, title: string, groundsTo: unknown[]) => ({
  opId, type: "create-entry", actor: { kind: "agent", id: "simulated" }, timestamp: NOW, reason: "test",
  payload: { file, insertAt: { at: "end-of-file" }, type: "fact", title, body: `${title}.`, headingDepth: 2, status: "promoted",
    groundsTo, aliases: [`${title} one`, `${title} two`, `${title} three`] },
});

/** What a user's agent (or its subagent) does with one task file. `badOnce` folders first get a wrong symbol. */
function writeTask(root: string, task: string, options: { badOnce?: Set<string>; fixes?: boolean } = {}): string {
  const write = (relative: string, value: unknown) => {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), JSON.stringify(value, null, 2));
  };
  if (task.includes("this first one fills the shared files")) {
    fillPlaceholders(root);
    write(".mex/local/setup-ops/shared.json", [{ ...fact("setup_shared_entry", "context/architecture.md", "Inputs are trimmed by parsealpha", [{ file: "src/alpha/parse.ts", symbol: "parsealpha" }]), setup: { patterns: [{ file: "patterns/verify-input.md", content: "---\nname: verify-input\ndescription: Verify input changes\n---\n# Verify input\n" + ["Context", "Steps", "Gotchas", "Verify", "Debug", "Update Scaffold"].map((heading) => `## ${heading}\nInspect the input helpers and run their tests.\n`).join("") }] } }]);
    return "shared";
  }
  if (task.startsWith("You are writing the MEX knowledge for one subsystem")) {
    const folder = /- Code: src\/(\w+)\//u.exec(task)![1]! as keyof typeof FOLDERS;
    const slug = /write "file": "context\/([^"]+)\.md"/u.exec(task)![1]!;
    const prefix = `setup_${slug.replace(/-/gu, "_")}_`;
    const bad = options.badOnce?.delete(folder) ?? false;
    write(`.mex/local/setup-ops/${slug}.json`, [
      { opId: `${prefix}overview`, type: "create-entry", actor: { kind: "agent", id: "simulated" }, timestamp: NOW, reason: "overview",
        payload: { file: `context/${slug}.md`, insertAt: { at: "end-of-file" }, type: "component", title: `The ${folder} subsystem`,
          body: `The ${folder} helpers.`, description: `Helpers in src/${folder}`, headingDepth: 2, status: "promoted" } },
      ...FOLDERS[folder].map((name, index) => fact(`${prefix}${name}`, `context/${slug}.md`, `${name}${folder} caps input at 64 characters`,
        [{ file: `src/${folder}/${name}.ts`, symbol: bad && index === 0 ? `${name}Missing` : `${name}${folder}` }])),
    ]);
    return `subsystem ${folder}${bad ? " (bad)" : ""}`;
  }
  if (task.startsWith("MEX could not apply the batch file for")) {
    if (options.fixes === false) return "fix ignored";
    const batch = /Batch file: (\S+)/u.exec(task)![1]!;
    const path = join(root, batch);
    writeFileSync(path, readFileSync(path, "utf8").replace(/(\w+)Missing/u, (_match, name: string) => {
      const folder = Object.entries(FOLDERS).find(([, names]) => (names as readonly string[]).includes(name))![0];
      return `${name}${folder}`;
    }));
    return "fix";
  }
  if (task.startsWith("You are finishing an AI context scaffold")) {
    const router = join(root, ".mex", "ROUTER.md");
    writeFileSync(router, `${readFileSync(router, "utf8").trimEnd()}\n\nRouting rows checked.\n`);
    return "final";
  }
  if (task.includes("You are going to populate an AI context scaffold")) {
    fillPlaceholders(root);
    return "single";
  }
  throw new Error(`unknown task: ${task.slice(0, 80)}`);
}

function doTask(root: string, task: string, options: { badOnce?: Set<string>; fixes?: boolean } = {}): string {
  const result = writeTask(root, task, options);
  signalCompletion(root, task);
  return result;
}

function signalCompletion(root: string, task: string): void {
  const receipt = /write exactly ([a-f0-9-]+) to (\.mex\/local\/setup-next\/[^ ]+\.done)/u.exec(task)!;
  writeFileSync(join(root, receipt[2]!), receipt[1]!);
}

async function next(root: string, env: NodeJS.ProcessEnv = FORCE): Promise<SetupNextResult> {
  // Simulated sessions finish immediately. Let the real detached graph catch up
  // before expecting their batches to apply; the initial task is returned first.
  if (existsSync(join(root, ".mex/local/setup-next-graph.json"))) {
    for (let attempt = 0; readNextGraph(root)?.status === "running" && attempt < 600; attempt++) {
      await new Promise((accept) => setTimeout(accept, 100));
    }
  }
  return runSetupNext({ projectRoot: root, env });
}

function taskText(root: string, result: SetupNextResult): string {
  expect(result.status).toBe("task");
  return readFileSync(join(root, result.taskFile!), "utf8");
}

async function wikiState(root: string): Promise<string> {
  return (await createRepositoryWikiPort(root).inspectIndex()).state;
}

describe("mex setup next on a real graph", () => {
  it("runs every unit, fixes a refused batch from the real diagnostics, keeps a half-finished setup valid, and finalizes", async () => {
    const root = repository();
    const badOnce = new Set(["beta"]);
    const outputs: string[] = [];

    // First call: prepare once, hand out the shared files.
    let result = await next(root);
    outputs.push(result.output);
    expect(result.output).toContain("MEX setup 0/4: the shared files");
    expect(result.output).toContain("Start this task in its own subagent, in a fresh context");
    expect(result.output).toContain("As soon as any task finishes, run `mex setup next` again without waiting for the others.");
    expect(result.taskFile).toBe(".mex/local/setup-next/shared.md");
    // Template identities exist before an agent writes its first fact (#286).
    expect(readFileSync(join(root, ".mex/context/architecture.md"), "utf8")).toMatch(/^mex:\r?\n {2}id: mx_/mu);
    expect(result.output).toContain("The code graph is still building");
    expect(readNextGraph(root)?.status).toBe("running");
    doTask(root, taskText(root, result), { badOnce });

    // Half-finished: status lines, the managed block, a valid Wiki that is not `migration_required` (#268).
    result = await next(root);
    expect(result.output).toContain("Applied the shared files: 1 fact.");
    expect(result.output).toContain("MEX setup 1/4: subsystem src/alpha/");
    expect(describeUnfinishedSetup(root)).toMatchObject({ done: 1, total: 4, driver: "queue" });
    expect(describeUnfinishedSetup(root)!.line).toBe("MEX setup 1/4, not finished. To continue, run `mex setup next --start` in your agent's chat and do what it prints.");
    expect(inspectSetupStatus(root).stage).toBe("needs_population");
    expect((await projectSetupStatus(root)).unfinished).toMatchObject({ done: 1, total: 4 });
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("MEX setup is not finished (1/4). Run `mex setup next --start`");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("\r\n<!-- mex-setup:end -->\r\n");
    expect(readFileSync(join(root, ".windsurfrules"), "utf8")).toBe(USER_RULES);
    expect(await wikiState(root)).toBe("fresh");
    expect((await createRepositoryWikiPort(root).validate()).valid).toBe(true);

    let fixTask = "";
    for (let step = 0; step < 12 && result.status === "task"; step += 1) {
      const text = taskText(root, result);
      if (text.startsWith("MEX could not apply")) fixTask = text;
      doTask(root, text, { badOnce });
      result = await next(root);
      outputs.push(result.output);
    }
    expect(result.status).toBe("complete");
    expect(result.output).toContain("MEX setup is complete. Subsystems covered: 3 of 3, 10 facts written.");
    expect(result.output).toContain("git add .mex");
    // The fix task got the engine's own refusal, with the declarations that do exist.
    expect(fixTask).toContain("GROUNDING_NOT_FOUND");
    expect(fixTask).toContain("routeMissing");
    expect(fixTask).toContain("routebeta");
    expect(outputs.join("\n")).toContain("MEX setup 2/4: fix the batch for subsystem src/beta/");

    const state = loadPlanState(root).state!;
    expect(state.queue).toMatchObject({ mode: "units", finalized: true });
    expect(state.finalizedAt).toEqual(expect.any(String));
    expect(state.subsystems.map((unit) => [unit.state, unit.facts])).toEqual([["done", 3], ["done", 3], ["done", 3]]);
    // Completion removes the managed block byte for byte and leaves the Wiki migrated and indexed.
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(MANAGED_ANCHOR);
    expect(readFileSync(join(root, ".windsurfrules"), "utf8")).toBe(USER_RULES);
    expect(describeUnfinishedSetup(root)).toBeNull();
    expect(inspectSetupStatus(root)).toMatchObject({ stage: "ready", ready: true });
    expect(await wikiState(root)).toBe("fresh");
    expect(readFileSync(join(root, ".mex/context/beta.md"), "utf8")).toContain("routebeta caps input at 64 characters");
    // Subsystem files created by batches also have a parent and linked facts.
    const inventory = inventoryScaffold({ scaffoldRoot: join(root, ".mex") });
    for (const unit of state.subsystems) {
      const file = inventory.files.find(entry => entry.path === `context/${unit.slug}.md`)!;
      const parent = file.parsed.entities.find(entry => entry.metadataKind === "frontmatter")!;
      expect(parent, unit.slug).toBeDefined();
      for (const fact of file.parsed.entities.filter(entry => entry.entity.type === "fact")) {
        expect(fact.entity.relations).toContainEqual(expect.objectContaining({ type: "refines", target: parent.entity.id }));
      }
    }
    expect(readdirSync(join(root, ".mex/local/setup-next")).filter((name) => name.endsWith(".md"))).toEqual([]);

    expect(outputs.join("\n")).not.toContain("Next task: its instructions are in .mex/local/setup-next/final.md");
    expect(state.final.state).toBe("done");
    expect(state.navigationVersion).toBe(1);
    const split = JSON.parse(readFileSync(join(root, ".mex/local/setup-ops/shared.operations.json"), "utf8"));
    expect(split[0]).not.toHaveProperty("setup");
    const navigation = ["ROUTER.md", "context/alpha.md", "context/architecture.md", "patterns/verify-input.md", "patterns/INDEX.md"];
    const before = navigation.map((file) => readFileSync(join(root, ".mex", file), "utf8"));
    expect(before[0]).toContain("| Working in src/alpha/ | `context/alpha.md` |");
    expect(before[1]).toContain("target: context/architecture.md");
    expect(before[2]).toContain("target: context/alpha.md");
    expect(before[4]).toContain("verify-input.md");
    // Calling again is safe: nothing left to do.
    const again = await next(root);
    expect(again).toMatchObject({ status: "complete", exitCode: 0 });
    expect(again.output).toContain("MEX setup is already complete. There is nothing left to do.");
    expect(navigation.map((file) => readFileSync(join(root, ".mex", file), "utf8"))).toEqual(before);
  }, 300_000);

  it("skips a unit refused twice or with no batch after three tries, never counts an unchanged batch twice, and resumes an abandoned chat", async () => {
    const root = repository();
    let result = await next(root);
    doTask(root, taskText(root, result));
    result = await next(root); // shared applied; alpha handed out

    // Early calls keep the running task; an abandoned chat can retry explicitly.
    expect((await next(root)).output).toContain("Wait for one to finish");
    const abandoned = await runSetupNext({ projectRoot: root, env: FORCE, retry: "subsystem:alpha" });
    expect(abandoned.output).toContain("Retrying subsystem:alpha");
    expect(abandoned.taskFile).toBe(result.taskFile);

    // alpha: a wrong symbol, and a fix task the agent does not act on.
    doTask(root, taskText(root, abandoned), { badOnce: new Set(["alpha"]) });
    result = await next(root);
    expect(result.output).toContain("fix the batch for subsystem src/alpha/");
    signalCompletion(root, taskText(root, result));
    const unchanged = await next(root);
    expect(unchanged.output).toContain("The batch file has not changed since the fix task was handed out.");
    expect(loadPlanState(root).state!.subsystems[0]!.state).not.toBe("skipped");
    signalCompletion(root, taskText(root, unchanged));
    result = await next(root);
    expect(result.output).toContain("Warning: Skipped subsystem src/alpha/: its batch was refused twice (GROUNDING_NOT_FOUND");
    expect(result.output).toContain("subsystem src/beta/");

    // beta: the agent signals completion without writing a batch.
    signalCompletion(root, taskText(root, result));
    result = await next(root);
    signalCompletion(root, taskText(root, result));
    result = await next(root);
    expect(result.output).toContain("subsystem src/beta/");
    signalCompletion(root, taskText(root, result));
    result = await next(root);
    expect(result.output).toContain("Warning: Skipped subsystem src/beta/: no batch file was written at .mex/local/setup-ops/beta.json after 3 tries");
    expect(result.output).toContain("MEX setup 3/4: subsystem src/gamma/");

    doTask(root, taskText(root, result));
    result = await next(root);
    expect(result.output).toContain("Wrote setup patterns, routing rows and edges.");
    expect(result.status).toBe("complete");
    expect(result.output).toContain("Subsystems covered: 1 of 3, 4 facts written. Skipped: src/alpha/ (its batch was refused twice");
    expect(result.output).toContain("src/beta/ (no batch file was written");
    expect(inspectSetupStatus(root).ready).toBe(true);
  }, 300_000);

  it("continues after a crash: a lock from a dead call is taken over, a live one blocks, a corrupt plan is replaced", async () => {
    const root = repository();
    let result = await next(root);
    doTask(root, taskText(root, result));
    // A call that died mid-way left its lock behind.
    writeFileSync(join(root, ".mex/local/setup-next.lock"), JSON.stringify({ pid: 2_147_000_000, at: Date.now() }));
    result = await next(root);
    expect(result.output).toContain("Applied the shared files");
    // A call still running (this process) blocks a second one with a clear message.
    writeFileSync(join(root, ".mex/local/setup-next.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    const blocked = await next(root);
    expect(blocked).toMatchObject({ status: "blocked", exitCode: 1 });
    expect(blocked.output).toContain("Another `mex setup next` is running in this project.");
    rmSync(join(root, ".mex/local/setup-next.lock"));
    // A corrupt stored plan is set aside with a notice; the applied shared batch replays instead of running again.
    writeFileSync(join(root, ".mex/local/setup-plan.json"), "{ not json");
    result = await next(root);
    expect(result.output).toContain("Warning: The stored setup plan (.mex/local/setup-plan.json) could not be used because it is not valid JSON");
    // With the plan lost, the completed batch replays without another agent task.
    expect(result.output).toContain("Applied the batch an earlier run left for the shared files: 1 fact.");
    expect(result.output).toContain("MEX setup 1/4: subsystem src/alpha/");
    expect(readdirSync(join(root, ".mex/local")).some((name) => name.startsWith("setup-plan.json.unreadable-"))).toBe(true);
  }, 300_000);

  it("gives a small repository its whole population as one unit", async () => {
    const root = repository();
    let result = await next(root, {});
    expect(result.output).toContain("MEX setup 0/1: the scaffold population");
    const task = taskText(root, result);
    expect(task).toContain("COVERAGE — cover the whole project");
    expect(task).toContain(QUEUE_POPULATION_FINISH);
    expect(task).not.toContain("rerun `mex setup`");
    // Called before completion: leave the task running without handing it out again.
    const early = await next(root, {});
    expect(early.output).toContain("Wait for one to finish");
    expect(early.taskFile).toBeUndefined();
    doTask(root, task);
    result = await next(root, {});
    expect(result.status).toBe("complete");
    // The fixture only fills the template slots, so setup finishes with the thin-knowledge warning.
    expect(result.output).toContain("Warning: Population finished without project patterns");
    expect(inspectSetupStatus(root).ready).toBe(true);
  }, 300_000);

  it("hands out one short prompt when no agent can run, and a later `mex setup` never finalizes a part-done plan", async () => {
    const root = repository();
    const paused = await runHeadlessSetup({ projectRoot: root, tools: ["windsurf"], perSubsystem: { env: FORCE } });
    expect(paused).toMatchObject({ stage: "needs_population", populationTool: null, prompt: SETUP_HANDOFF_PROMPT });
    expect(paused.message).toContain("MEX setup 0/4, not finished.");
    expect(await wikiState(root)).toBe("fresh");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("MEX setup is not finished (0/4)");

    let result = await next(root);
    expect(result.output).toContain("MEX setup 0/4: the shared files");
    doTask(root, taskText(root, result));
    result = await next(root);
    expect(result.output).toContain("MEX setup 1/4");

    // The shared files are filled, but subsystems remain: setup pauses with the line to continue.
    const rerun = await runHeadlessSetup({ projectRoot: root, confirmPopulation: true, perSubsystem: { env: FORCE } });
    expect(rerun).toMatchObject({ stage: "needs_population", ready: false, prompt: SETUP_HANDOFF_PROMPT });
    expect(rerun.message).toContain("MEX setup 1/4, not finished.");
    expect(loadPlanState(root).state!.queue!.finalized).toBeUndefined();
    expect(inspectSetupStatus(root).ready).toBe(false);
  }, 300_000);
});
