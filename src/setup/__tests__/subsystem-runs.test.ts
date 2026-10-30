import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HeadlessPopulationError, type HeadlessPopulationOptions } from "../headless-population.js";
import type { BatchApplyOutcome, BatchScope, SetupBatchApplier } from "../subsystem-apply.js";
import {
  AGENT_RUN_FOOTPRINT_BYTES,
  FREE_MEMORY_FLOOR_BYTES,
  GRAPH_NATIVE_OVERHEAD_BYTES,
  SMALL_GRAPH_BUILD_RESERVE_BYTES,
  SubsystemPhaseStoppedError,
  graphBuildReserveBytes,
  resolveParallelRuns,
  runSubsystemPopulation,
  shouldRunPerSubsystem,
  perSubsystemSwitch,
  type SetupCoverageProgress,
} from "../subsystem-runs.js";
import { createPlanState, loadPlanState, savePlanState, type SetupPlanState } from "../subsystem-state.js";
import type { SubsystemPlan } from "../subsystems.js";
import { populateDuringGraph } from "../concurrent-graph.js";
import { setupTemplatesDirectory } from "../phases.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const SHARED_FILES = ["AGENTS.md", "ROUTER.md", "context/architecture.md", "context/stack.md", "context/conventions.md", "context/decisions.md", "context/setup.md"];

function project(populated = false): string {
  const root = mkdtempSync(join(tmpdir(), "mex-subsystem-runs-"));
  roots.push(root);
  for (const file of SHARED_FILES) {
    const path = join(root, ".mex", file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, populated ? `# ${file}\n\nFilled.\n` : readFileSync(join(setupTemplatesDirectory(), file), "utf8"));
  }
  return root;
}

function plan(count: number): SubsystemPlan {
  return {
    source: "graph", ranking: "activity", sourceFiles: 900, target: { min: 5, max: 8 },
    candidates: Array.from({ length: count }, (_, index) => ({
      path: `src/${String.fromCharCode(97 + index)}`, files: 20 - index, commits: 10 - index,
      budget: index < 2 ? { min: 10, max: 15 } : { min: 4, max: 6 },
    })),
  };
}

type Action = "ok" | "bad" | "fix" | "nofix" | "crash" | "crash-after-batch" | "usage-after-batch" | "timeout" | "auth" | "usage" | "hang" | "no-batch" | "touch-router" | "tool-missing";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A fake agent that does each session's job from the prompt, and a fake applier that checks batches. */
function harness(root: string, script: Record<string, Action[]> = {}, options: { delayMs?: number } = {}) {
  const launches: Array<{ kind: string; slug: string }> = [];
  let active = 0;
  let maxActive = 0;
  let applying = 0;
  let overlappingApplies = 0;
  const applies: string[] = [];
  const next = (key: string): Action => script[key]?.shift() ?? (key.startsWith("fix:") ? "fix" : "ok");
  const write = (relative: string, value: unknown) => {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  };
  const launch = async (input: HeadlessPopulationOptions) => {
    const prompt = input.prompt;
    const batch = /(?:- Batch file: |Batch file: |JSON array in `)(\.mex\/local\/setup-ops\/[^`\s]+\.json)/u.exec(prompt)?.[1];
    const slug = batch?.split("/").pop()!.replace(/\.json$/u, "") ?? "final";
    const kind = prompt.startsWith("MEX could not apply") ? "fix"
      : prompt.includes("this first one fills the shared files") ? "shared"
        : prompt.startsWith("You are finishing") ? "final" : "subsystem";
    launches.push({ kind, slug });
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await sleep(options.delayMs ?? 15);
      const action = next(kind === "fix" ? `fix:${slug}` : slug);
      if (action === "tool-missing") return { tool: null, completed: false };
      if (action === "hang") {
        await new Promise<void>((done) => {
          if (input.signal?.aborted) done();
          input.signal?.addEventListener("abort", () => done(), { once: true });
        });
        throw new HeadlessPopulationError("cancelled", "claude");
      }
      if (input.signal?.aborted) throw new HeadlessPopulationError("cancelled", "claude");
      if (action === "auth") throw new HeadlessPopulationError("authentication", "claude");
      if (action === "usage") throw new HeadlessPopulationError("usage_limit", "claude");
      if (action === "timeout") throw new HeadlessPopulationError("timeout", "claude");
      if (action === "crash") throw new HeadlessPopulationError("failed", "claude");
      if (kind === "shared") {
        for (const file of SHARED_FILES) writeFileSync(join(root, ".mex", file), `# ${file}\n\nFilled by the shared session.\n`);
        write(batch!, [{ opId: "setup_shared_one", type: "create-entry", payload: { file: "context/architecture.md", type: "fact" } }]);
      } else if (kind === "subsystem" && action !== "no-batch") {
        const ops = [
          { opId: `setup_${slug}_overview`, type: "create-entry", payload: { file: `context/${slug}.md`, type: "component" } },
          { opId: `setup_${slug}_fact`, type: "create-entry", payload: { file: `context/${slug}.md`, type: "fact" } },
          ...(action === "bad" ? [{ opId: `setup_${slug}_bad`, type: "create-entry", bad: true, payload: { file: `context/${slug}.md`, type: "fact" } }] : []),
        ];
        write(batch!, ops);
        if (action === "touch-router") writeFileSync(join(root, ".mex", "ROUTER.md"), "# Edited by a subsystem session\n");
        if (action === "usage-after-batch") throw new HeadlessPopulationError("usage_limit", "claude");
        if (action === "crash-after-batch") throw new HeadlessPopulationError("failed", "claude");
      } else if (kind === "fix" && action === "fix") {
        const ops = JSON.parse(readFileSync(join(root, batch!), "utf8")) as Array<{ bad?: boolean }>;
        write(batch!, ops.filter((op) => !op.bad));
      } else if (kind === "final") {
        writeFileSync(join(root, ".mex", "ROUTER.md"), `${readFileSync(join(root, ".mex", "ROUTER.md"), "utf8")}| subsystem rows |\n`);
      }
      input.onUsage?.({ inputTokens: 100, outputTokens: 10 });
      return { tool: "claude" as const, completed: true };
    } finally {
      active -= 1;
    }
  };
  const applier: SetupBatchApplier = {
    async apply(batchFile: string, scope: BatchScope): Promise<BatchApplyOutcome> {
      applying += 1;
      if (applying > 1) overlappingApplies += 1;
      try {
        await sleep(5);
        applies.push(batchFile);
        const path = join(root, batchFile);
        if (!existsSync(path)) return { kind: "missing" };
        const ops = JSON.parse(readFileSync(path, "utf8")) as Array<{ opId: string; bad?: boolean; payload: { type: string } }>;
        const bad = ops.filter((op) => op.bad || !op.opId.startsWith(scope.opIdPrefix));
        if (bad.length > 0) {
          return { kind: "refused", problems: bad.map((op) => ({ code: "GROUNDING_NOT_FOUND", message: `Operation (${op.opId}): No declaration named \`nope\`. Nearest: real (function).` })) };
        }
        return { kind: "applied", facts: ops.filter((op) => op.payload.type === "fact").length, operations: ops.length, replayed: false, warnings: [] };
      } finally {
        applying -= 1;
      }
    },
    async close() { return { changed: false }; },
  };
  return {
    launch, applier, launches, applies,
    get maxActive() { return maxActive; },
    get overlappingApplies() { return overlappingApplies; },
  };
}

function run(root: string, state: SetupPlanState, h: ReturnType<typeof harness>, extra: Partial<Parameters<typeof runSubsystemPopulation>[0]> = {}) {
  const messages: string[] = [];
  const coverage: SetupCoverageProgress[] = [];
  const promise = runSubsystemPopulation({
    projectRoot: root, state, selectedTools: ["claude"], scannerBrief: null,
    launch: h.launch, applier: h.applier, freeMemory: () => 64 * 1024 ** 3, trackSource: false,
    onMessage: (message) => messages.push(message), onCoverage: (entry) => coverage.push(entry),
    ...extra,
  });
  return { promise, messages, coverage };
}

describe("choosing the per-subsystem path", () => {
  it("keeps one session below the size tier unless forced, and continues a stored plan", () => {
    const small = { ...plan(3), sourceFiles: 120 };
    expect(shouldRunPerSubsystem({ plan: small, resuming: false, env: {} })).toBe(false);
    expect(shouldRunPerSubsystem({ plan: plan(3), resuming: false, env: {} })).toBe(true);
    expect(shouldRunPerSubsystem({ plan: small, resuming: false, env: { MEX_SETUP_PER_SUBSYSTEM: "1" } })).toBe(true);
    expect(shouldRunPerSubsystem({ plan: plan(3), resuming: true, env: { MEX_SETUP_PER_SUBSYSTEM: "off" } })).toBe(false);
    expect(shouldRunPerSubsystem({ plan: null, resuming: false, env: { MEX_SETUP_PER_SUBSYSTEM: "force" } })).toBe(false);
    expect(shouldRunPerSubsystem({ plan: null, resuming: true, env: {} })).toBe(true);
    expect(perSubsystemSwitch({ MEX_SETUP_PER_SUBSYSTEM: "maybe" })).toBe("auto");
  });

  it("caps the session limit from the option or the environment", () => {
    expect(resolveParallelRuns(undefined, {})).toBe(3);
    expect(resolveParallelRuns(undefined, { MEX_SETUP_PARALLEL_RUNS: "2" })).toBe(2);
    expect(resolveParallelRuns(undefined, { MEX_SETUP_PARALLEL_RUNS: "zero" })).toBe(3);
    expect(resolveParallelRuns(0, {})).toBe(1);
    expect(resolveParallelRuns(50, {})).toBe(8);
  });
});

describe("one session per subsystem", () => {
  it("starts shared and every subsystem before graph completion, releases session slots, and applies in finish order", async () => {
    const root = project();
    const state = createPlanState(plan(5));
    const h = harness(root);
    let finish!: () => void;
    const graphReady = new Promise<void>((resolve) => { finish = resolve; });
    const { promise } = run(root, state, h, { graphReady, parallelRuns: 2 });
    while (h.launches.length < 6 || state.subsystems.some((unit) => !unit.runs.length)) await sleep(5);
    expect(h.applies).toEqual([]);
    expect(h.maxActive).toBe(2);
    finish();
    expect((await promise).covered).toBe(5);
    expect(h.applies).toEqual(["shared", "a", "b", "c", "d", "e"].map((slug) => `.mex/local/setup-ops/${slug}.json`));
    expect(h.overlappingApplies).toBe(0);
  });

  it("keeps completed batches after graph failure and resumes without rerunning those agents", async () => {
    const root = project(); const state = createPlanState(plan(3)); const h = harness(root);
    let fail!: (error: Error) => void;
    const graph = new Promise<void>((_resolve, reject) => { fail = reject; });
    const result = populateDuringGraph({ build: () => graph, populate: (graphReady, signal) => run(root, state, h, { graphReady, signal }).promise });
    const observed = result.catch((error: unknown) => error);
    while (state.subsystems.some((unit) => !unit.runs.length)) await sleep(5);
    fail(new Error("Graph heap limit; rerun mex setup"));
    expect(await observed).toMatchObject({ message: "Graph heap limit; rerun mex setup" });
    expect(h.applies).toEqual([]);
    const resumed = harness(root);
    const loaded = loadPlanState(root).state!;
    expect((await run(root, loaded, resumed, { graphReady: Promise.resolve() }).promise).covered).toBe(3);
    expect(resumed.launches).toEqual([]);
  });

  it("reserves graph peak memory even for the first session and starts after the graph frees it", async () => {
    const root = project(); const state = createPlanState(plan(2)); const h = harness(root);
    let finish!: () => void;
    const graphReady = new Promise<void>((resolve) => { finish = resolve; });
    const free = graphBuildReserveBytes(state.plan.sourceFiles) + FREE_MEMORY_FLOOR_BYTES + AGENT_RUN_FOOTPRINT_BYTES / 2;
    const { promise } = run(root, state, h, { graphReady, freeMemory: () => free });
    await sleep(35); expect(h.launches).toEqual([]);
    finish(); expect((await promise).covered).toBe(2);
  });

  it("scales the graph reserve with repository size, bounded by the worker heap", () => {
    const gb = 1024 ** 3;
    expect(graphBuildReserveBytes(300, 14 * gb)).toBe(SMALL_GRAPH_BUILD_RESERVE_BYTES);
    expect(graphBuildReserveBytes(4_000, 14 * gb)).toBeCloseTo(4_000 * 1.2 * 1024 ** 2);
    // The measured novu peak (10.5 GB, 9.4k files, automatic heap) stays inside the reserve.
    expect(graphBuildReserveBytes(9_427, 14 * gb)).toBeGreaterThan(10.5 * gb);
    // An explicit 8 GB heap caps the reserve (8.1 GB was measured with it).
    expect(graphBuildReserveBytes(10_500, 8 * gb)).toBe(8 * gb + GRAPH_NATIVE_OVERHEAD_BYTES);
  });

  it("cancels the graph on a stopping session failure and retains the session's actionable error", async () => {
    const root = project(); const state = createPlanState(plan(2));
    const h = harness(root, { shared: ["auth"], a: ["hang"], b: ["hang"] });
    let graphStopped = false;
    const result = populateDuringGraph({
      build: (signal) => new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
        graphStopped = true; reject(new Error("Graph cancelled"));
      }, { once: true })),
      populate: (graphReady, signal) => run(root, state, h, { graphReady, signal }).promise,
    });
    await expect(result).rejects.toMatchObject({ category: "authentication", message: expect.stringContaining("could not authenticate") });
    expect(graphStopped).toBe(true);
  });

  it("cancels sessions waiting to apply without waiting for graph completion", async () => {
    const root = project(); const state = createPlanState(plan(2)); const h = harness(root);
    const controller = new AbortController();
    const graphReady = new Promise<void>(() => undefined);
    const { promise } = run(root, state, h, { graphReady, signal: controller.signal });
    const stopped = promise.catch((error: unknown) => error);
    while (!state.subsystems[0]!.runs.length) await sleep(5);
    controller.abort();
    expect(await stopped).toMatchObject({ category: "cancelled" });
    expect(h.applies).toEqual([]);
  });
  it("finishes an old plan whose only pending unit is the final pass without launching an agent", async () => {
    const root = project(true);
    const state = createPlanState(plan(2));
    state.shared.state = "done";
    state.subsystems.forEach((unit) => { unit.state = "done"; });
    const h = harness(root);
    await run(root, state, h).promise;
    expect(h.launches).toEqual([]);
    expect(loadPlanState(root).state!.final.state).toBe("done");
  });

  it("upgrades legacy shared batches with a patterns-only session while preserving applied facts", async () => {
    const root = project(true); const state = createPlanState(plan(1));
    delete state.navigationVersion;
    Object.assign(state.shared, { state: "done", applied: true, facts: 8 });
    state.subsystems[0]!.state = "done";
    mkdirSync(join(root, ".mex/local/setup-ops"), { recursive: true });
    writeFileSync(join(root, ".mex/local/setup-ops/shared.json"), "[]");
    const h = harness(root);
    const prompts: string[] = [];
    const launch = async (input: HeadlessPopulationOptions) => {
      prompts.push(input.prompt);
      writeFileSync(join(root, ".mex/local/setup-ops/shared.json"), JSON.stringify([{ setup: { patterns: [] } }]));
      return { tool: "codex" as const, completed: true };
    };
    await run(root, state, h, { launch }).promise;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Do not rewrite shared content or facts");
    expect(state.shared.facts).toBe(8);
    expect(state.final.state).toBe("done");
  });
  it("runs the shared files first, up to three subsystems at once with serialized applies, then reconciles navigation without another agent", async () => {
    const root = project();
    const state = createPlanState(plan(5));
    const h = harness(root, {}, { delayMs: 40 });
    const { promise, messages, coverage } = run(root, state, h);
    const outcome = await promise;
    expect(h.launches[0]).toEqual({ kind: "shared", slug: "shared" });
    expect(h.launches.some((entry) => entry.kind === "final")).toBe(false);
    expect(h.launches.filter((entry) => entry.kind === "subsystem")).toHaveLength(5);
    expect(h.maxActive).toBe(3);
    expect(h.overlappingApplies).toBe(0);
    expect(outcome).toMatchObject({ covered: 5, total: 5, facts: 6, skipped: [], sharedDone: true, tool: "claude" });
    expect(outcome.summary).toBe("Subsystems covered: 5 of 5, 6 facts written.");
    const stored = loadPlanState(root).state!;
    expect(stored.subsystems.every((unit) => unit.state === "done" && unit.applied)).toBe(true);
    expect(stored.shared.state).toBe("done");
    expect(stored.final.state).toBe("done");
    expect(stored.subsystems[0]!.runs.map((entry) => `${entry.kind}:${entry.outcome}`)).toEqual(["write:completed", "apply:applied"]);
    expect(stored.subsystems[0]!.runs[0]).toMatchObject({ tool: "claude", usage: { inputTokens: 100, outputTokens: 10 }, durationMs: expect.any(Number) });
    expect(readFileSync(join(root, ".mex/local/setup-plan.txt"), "utf8")).toContain("- [x] src/a/ -> .mex/context/a.md — done, 1 facts");
    expect(coverage.at(-1)).toMatchObject({ phase: "complete", total: 5, done: 5, skipped: 0 });
    expect(coverage.some((entry) => entry.subsystems.filter((unit) => unit.state === "running").length === 3)).toBe(true);
    expect(messages.filter((message) => message.startsWith("Warning"))).toEqual([]);
  });

  it("gives a refused batch one fix session, then applies it", async () => {
    const root = project(true);
    const state = createPlanState(plan(2));
    state.shared.state = "done";
    const h = harness(root, { b: ["bad"], "fix:b": ["fix"] });
    const { promise, messages } = run(root, state, h);
    const outcome = await promise;
    expect(outcome.covered).toBe(2);
    expect(h.launches.filter((entry) => entry.slug === "b").map((entry) => entry.kind)).toEqual(["subsystem", "fix"]);
    expect(state.subsystems[1]!.runs.map((entry) => `${entry.kind}:${entry.outcome}`)).toEqual(["write:completed", "apply:refused", "fix:completed", "apply:applied"]);
    expect(messages).toContain("Fixed and applied the batch for subsystem src/b/.");
  });

  it("skips a subsystem whose batch is refused twice, with a warning, and finishes the rest", async () => {
    const root = project(true);
    const state = createPlanState(plan(3));
    state.shared.state = "done";
    const finalPrompts: string[] = [];
    const h = harness(root, { b: ["bad"], "fix:b": ["nofix"] });
    const launch = async (input: HeadlessPopulationOptions) => {
      if (input.prompt.startsWith("You are finishing")) finalPrompts.push(input.prompt);
      return h.launch(input);
    };
    const { promise, messages } = run(root, state, { ...h, launch } as typeof h);
    const outcome = await promise;
    expect(outcome.covered).toBe(2);
    expect(outcome.skipped).toEqual([{ path: "src/b", reason: expect.stringContaining("its batch was refused twice (GROUNDING_NOT_FOUND") }]);
    expect(outcome.summary).toContain("Skipped 1: src/b/ (its batch was refused twice");
    expect(outcome.summary).toContain("Rerun `mex setup` to try it again.");
    expect(messages.some((message) => message.startsWith("Warning: Skipped subsystem src/b/: its batch was refused twice"))).toBe(true);
    expect(finalPrompts).toEqual([]);
    expect(loadPlanState(root).state!.subsystems[1]).toMatchObject({ state: "skipped", reason: expect.stringContaining("refused twice") });
  });

  it("skips a crashed or idle-stopped session but keeps a valid batch a crashed session left", async () => {
    const root = project(true);
    const state = createPlanState(plan(3));
    state.shared.state = "done";
    const h = harness(root, { a: ["crash"], b: ["timeout"], c: ["crash-after-batch"] }, { delayMs: 5 });
    const { promise, messages } = run(root, state, h, { parallelRuns: 1 });
    const outcome = await promise;
    expect(outcome.skipped.map((entry) => entry.path)).toEqual(["src/a", "src/b"]);
    expect(outcome.skipped[0]!.reason).toBe("the session failed (failed)");
    expect(outcome.skipped[1]!.reason).toBe("the session failed (timeout)");
    expect(state.subsystems[2]).toMatchObject({ state: "done", facts: 1 });
    expect(messages.some((message) => message.includes("did not finish cleanly") && message.includes("is applied"))).toBe(true);
    expect(state.subsystems[0]!.runs[0]).toMatchObject({ kind: "write", outcome: "failed", failure: "failed" });
  });

  it("skips a session that wrote no batch file", async () => {
    const root = project(true);
    const state = createPlanState(plan(1));
    state.shared.state = "done";
    const outcome = await run(root, state, harness(root, { a: ["no-batch"] })).promise;
    expect(outcome.skipped).toEqual([{ path: "src/a", reason: "the session wrote no batch file at .mex/local/setup-ops/a.json" }]);
  });

  it("stops every running session on cancel, keeps what is done, and saves the rest as pending", async () => {
    const root = project(true);
    const state = createPlanState(plan(5));
    state.shared.state = "done";
    state.subsystems[0]!.state = "done";
    const controller = new AbortController();
    const h = harness(root, { b: ["hang"], c: ["hang"], d: ["hang"] });
    const { promise, coverage } = run(root, state, h, { signal: controller.signal });
    while (coverage.at(-1)?.subsystems.filter((unit) => unit.state === "running").length !== 3) await sleep(5);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ category: "cancelled" });
    expect(h.launches.map((entry) => entry.slug)).toEqual(["b", "c", "d"]);
    const stored = loadPlanState(root).state!;
    expect(stored.subsystems.map((unit) => unit.state)).toEqual(["done", "pending", "pending", "pending", "pending"]);
    expect(stored.subsystems[1]!.runs[0]).toMatchObject({ outcome: "stopped" });
    expect(stored.final.state).toBe("pending");
  });

  it.each([
    ["authentication", "auth", "could not authenticate"],
    ["usage limit", "usage", "reached its usage limit"],
  ] as const)("stops the phase on %s, stops the other sessions, and says a rerun continues", async (_name, action, text) => {
    const root = project(true);
    const state = createPlanState(plan(5));
    state.shared.state = "done";
    // a finished in an earlier run, so the three slots go to b, c and d at once
    // and no freed slot can race c's failure.
    state.subsystems[0]!.state = "done";
    const h = harness(root, { b: ["hang"], c: [action], d: ["hang"] }, { delayMs: 20 });
    const { promise } = run(root, state, h);
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubsystemPhaseStoppedError);
    expect((error as Error).message).toContain(text);
    expect((error as Error).message).toContain("Population stopped with 1 of 5 subsystems done; rerun `mex setup` to continue where it stopped");
    const stored = loadPlanState(root).state!;
    expect(stored.subsystems.map((unit) => unit.state)).toEqual(["done", "pending", "pending", "pending", "pending"]);
    expect(h.launches.map((entry) => entry.slug)).toEqual(["b", "c", "d"]);
    expect(h.launches.map((entry) => entry.kind)).not.toContain("final");
  });

  it("stops the phase when no agent CLI can be found", async () => {
    const root = project(true);
    const state = createPlanState(plan(2));
    state.shared.state = "done";
    const error = await run(root, state, harness(root, { a: ["tool-missing"], b: ["tool-missing"] })).promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubsystemPhaseStoppedError);
    expect((error as Error).message).toContain("No supported agent CLI is available");
    expect(loadPlanState(root).state!.subsystems.map((unit) => unit.state)).toEqual(["pending", "pending"]);
  });

  it("stops instead of skipping everything when sessions keep failing", async () => {
    const root = project(true);
    const state = createPlanState(plan(5));
    state.shared.state = "done";
    const h = harness(root, { a: ["crash"], b: ["crash"], c: ["crash"] }, { delayMs: 1 });
    const error = await run(root, state, h, { parallelRuns: 1 }).promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubsystemPhaseStoppedError);
    expect((error as Error).message).toContain("3 agent sessions in a row failed");
    expect(h.launches.map((entry) => entry.slug)).toEqual(["a", "b", "c"]);
    expect(loadPlanState(root).state!.subsystems.map((unit) => unit.state)).toEqual(["skipped", "skipped", "pending", "pending", "pending"]);
  });

  it("resumes: done kept, skipped retried, an unapplied batch applied first without a session", async () => {
    const root = project(true);
    const state = createPlanState(plan(4));
    state.shared.state = "done";
    state.shared.applied = true;
    state.final.state = "done";
    state.subsystems[0]!.state = "done";
    state.subsystems[0]!.applied = true;
    state.subsystems[1]!.state = "skipped";
    state.subsystems[1]!.reason = "the session failed (timeout)";
    savePlanState(root, state);
    mkdirSync(join(root, ".mex/local/setup-ops"), { recursive: true });
    writeFileSync(join(root, ".mex/local/setup-ops/c.json"), JSON.stringify([
      { opId: "setup_c_overview", type: "create-entry", payload: { file: "context/c.md", type: "component" } },
      { opId: "setup_c_fact", type: "create-entry", payload: { file: "context/c.md", type: "fact" } },
    ]));
    const reloaded = loadPlanState(root).state!;
    const h = harness(root);
    const { promise, messages } = run(root, reloaded, h);
    const outcome = await promise;
    expect(h.launches).toEqual([{ kind: "subsystem", slug: "b" }, { kind: "subsystem", slug: "d" }]);
    expect(messages).toContain("Applied the batch an earlier run left for subsystem src/c/.");
    expect(outcome.covered).toBe(4);
    expect(h.applies).not.toContain(".mex/local/setup-ops/a.json");
  });

  it("applies a refused leftover batch's fix on resume instead of rewriting it", async () => {
    const root = project(true);
    const state = createPlanState(plan(1));
    state.shared.state = "done";
    mkdirSync(join(root, ".mex/local/setup-ops"), { recursive: true });
    writeFileSync(join(root, ".mex/local/setup-ops/a.json"), JSON.stringify([
      { opId: "setup_a_fact", type: "create-entry", bad: true, payload: { file: "context/a.md", type: "fact" } },
      { opId: "setup_a_ok", type: "create-entry", payload: { file: "context/a.md", type: "fact" } },
    ]));
    const h = harness(root);
    expect((await run(root, state, h).promise).covered).toBe(1);
    expect(h.launches.map((entry) => entry.kind)).toEqual(["fix"]);
  });

  it("runs fewer sessions at once when free memory is low, never fewer than one", async () => {
    const root = project(true);
    const state = createPlanState(plan(4));
    state.shared.state = "done";
    const h = harness(root, {}, { delayMs: 20 });
    const lowMemory = FREE_MEMORY_FLOOR_BYTES + AGENT_RUN_FOOTPRINT_BYTES * 0.5;
    const { promise, messages } = run(root, state, h, { freeMemory: () => lowMemory });
    expect((await promise).covered).toBe(4);
    expect(h.maxActive).toBe(1);
    expect(messages.some((message) => message.startsWith("Free memory is low"))).toBe(true);
    const roomForTwo = FREE_MEMORY_FLOOR_BYTES + AGENT_RUN_FOOTPRINT_BYTES * 2.2;
    const root2 = project(true);
    const state2 = createPlanState(plan(4));
    state2.shared.state = "done";
    const h2 = harness(root2, {}, { delayMs: 20 });
    await run(root2, state2, h2, { freeMemory: () => roomForTwo }).promise;
    expect(h2.maxActive).toBe(2);
  });

  it("warns by name about a change outside the session's batch file and never reverts it", async () => {
    const root = project(true);
    const state = createPlanState(plan(2));
    state.shared.state = "done";
    state.final.state = "done";
    const h = harness(root, { a: ["touch-router"] });
    const { promise, messages } = run(root, state, h, { parallelRuns: 1 });
    await promise;
    const warning = messages.find((message) => message.includes("Files changed outside the expected scope"));
    expect(warning).toContain("by the session for subsystem src/a/, which may write only .mex/local/setup-ops/a.json");
    expect(warning).toContain(".mex/ROUTER.md");
    expect(warning).toContain("MEX did not revert anything");
    expect(readFileSync(join(root, ".mex/ROUTER.md"), "utf8")).toMatch(/^# Edited by a subsystem session\n/);
  });

  it("does not run the final pass, and reports the shared files unfinished, while placeholders remain", async () => {
    const root = project(false);
    const state = createPlanState(plan(2));
    const h = harness(root);
    const launch = async (input: HeadlessPopulationOptions) => {
      if (input.prompt.includes("this first one fills the shared files")) {
        h.launches.push({ kind: "shared", slug: "shared" });
        return { tool: "claude" as const, completed: true };
      }
      return h.launch(input);
    };
    const outcome = await run(root, state, { ...h, launch } as typeof h).promise;
    expect(outcome.sharedDone).toBe(false);
    expect(outcome.covered).toBe(2);
    expect(state.shared).toMatchObject({ state: "skipped", reason: "required scaffold placeholders remain in the shared files" });
    expect(state.final).toMatchObject({ state: "skipped", reason: "the shared files are not filled yet" });
    expect(h.launches.map((entry) => entry.kind)).not.toContain("final");
  });
});

describe("the progress line", () => {
  it("says what is done, skipped and running in every phase", async () => {
    const { describeCoverage } = await import("../headless.js");
    const subsystems = [{ path: "src/a", state: "done" as const }, { path: "src/b", state: "skipped" as const }, { path: "src/c", state: "running" as const }];
    expect(describeCoverage({ phase: "shared", total: 3, done: 0, skipped: 0, subsystems })).toBe("Filling the shared files before 3 subsystem sessions");
    expect(describeCoverage({ phase: "subsystems", total: 3, done: 1, skipped: 1, subsystems })).toBe("1/3 subsystems done, 1 skipped · working on src/c/");
    expect(describeCoverage({ phase: "final", total: 3, done: 1, skipped: 1, subsystems })).toBe("1/3 subsystems done, 1 skipped; writing patterns, routing rows and edges");
  });
});


describe("usage-limit resume at every unit", () => {
  it.each(["shared", "b"])("pauses %s without skipping and finishes on rerun", async (slug) => {
    const root = project();
    const state = createPlanState(plan(3));
    const first = harness(root, { [slug]: ["usage"] });
    await expect(run(root, state, first, { parallelRuns: 1 }).promise).rejects.toMatchObject({ category: "usage_limit" });
    const stored = loadPlanState(root).state!;
    const units = [stored.shared, ...stored.subsystems, stored.final];
    expect(units.some((unit) => unit.state === "skipped")).toBe(false);
    expect(units.some((unit) => unit.runs.some((entry) => entry.failure === "usage_limit"))).toBe(true);
    const done = first.launches.map((entry) => entry.slug).filter((entry) => entry !== slug);
    const second = harness(root);
    await expect(run(root, stored, second, { parallelRuns: 1 }).promise).resolves.toMatchObject({ covered: 3, skipped: [] });
    for (const entry of done) expect(second.launches.map((launch) => launch.slug)).not.toContain(entry);
    expect(stored.final.state).toBe("done");
  });
});

it("defers a limited session's partial batch exactly as cancellation does, then replays on resume", async () => {
  const root = project(true);
  const state = createPlanState(plan(1));
  state.shared.state = "done";
  const first = harness(root, { a: ["usage-after-batch"] });
  await expect(run(root, state, first).promise).rejects.toMatchObject({ category: "usage_limit" });
  expect(first.applies).toEqual([]);
  expect(state.subsystems[0]!.state).toBe("pending");
  expect(existsSync(join(root, ".mex/local/setup-ops/a.json"))).toBe(true);
  const second = harness(root);
  await run(root, loadPlanState(root).state!, second).promise;
  expect(second.applies).toContain(".mex/local/setup-ops/a.json");
  expect(second.launches.map((entry) => entry.slug)).not.toContain("a");
});

it("starts subsystems before the shared task finishes without a graph barrier", async () => {
  const root = project(); const state = createPlanState(plan(3)); const h = harness(root);
  let release!: () => void;
  const shared = new Promise<void>((resolve) => { release = resolve; });
  const prompts: string[] = [];
  const launch = async (input: HeadlessPopulationOptions) => {
    prompts.push(input.prompt);
    if (input.prompt.includes("this first one fills the shared files")) await shared;
    return h.launch(input);
  };
  const { promise } = run(root, state, h, { launch, parallelRuns: 3 });
  while (prompts.length < 3) await sleep(5);
  expect(state.shared.state).toBe("running");
  expect(prompts.slice(1).every((prompt) => prompt.includes("Do not rely on or edit"))).toBe(true);
  release();
  expect((await promise).covered).toBe(3);
});
