import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runSetupNext } from "../next.js";
import { createPlanState, loadPlanState, savePlanState, unitBatchFile } from "../subsystem-state.js";
import { buildSetupUnitPrompt, discoverSkippedSourceFolders } from "../subsystem-runs.js";
import * as links from "../subsystem-links.js";
import type { SetupBatchApplier } from "../subsystem-apply.js";
import * as nextGraph from "../next-graph.js";
import { setupTemplatesDirectory } from "../phases.js";

vi.mock("../next-graph.js", () => ({ ensureNextGraph: vi.fn(async () => ({ status: "ready" })) }));

vi.mock("../index.js", async (original) => ({
  ...await original<typeof import("../index.js")>(),
  finalizeCodeRepoSetup: vi.fn(async () => ({ dropped: [], drift: null })),
}));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mex-next-unit-"));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  for (const file of ["AGENTS.md", "ROUTER.md", "context/architecture.md", "context/conventions.md", "context/stack.md", "context/decisions.md", "context/setup.md", "patterns/INDEX.md", "context/a.md"]) {
    write(`.mex/${file}`, "---\nname: fixture\ndescription: Fixture content\n---\n# Fixture\nFilled.\n");
  }
  const state = createPlanState({ source: "tree", ranking: "size", sourceFiles: 20, target: { min: 1, max: 2 }, candidates: [
    { path: "src/a", files: 20, commits: null, budget: { min: 4, max: 6 } },
  ] });
  state.queue = { mode: "units" };
  state.navigationVersion = 1;
  state.shared.state = "done";
  const apply = vi.fn<SetupBatchApplier["apply"]>(async () => ({ kind: "applied", facts: 1, operations: 1, replayed: false, warnings: [] }));
  const applier = () => ({ apply, close: async () => ({ changed: false }) });
  const save = () => savePlanState(root, state);
  const next = (retry?: string) => runSetupNext({ projectRoot: root, ...(retry ? { retry } : {}), applier, env: { MEX_SETUP_PARALLEL_RUNS: "1" } });
  const read = (file: string) => readFileSync(join(root, file), "utf8");
  const complete = (id: string) => {
    const entry = loadPlanState(root).state!.queue!.awaiting!.find((entry) => entry.unit === id)!;
    write(`.mex/local/setup-next/${id.replace(":", "-")}.done`, entry.completionToken!);
  };
  return { root, state, write, read, save, next, apply, complete };
}

it("uses the background prompt including navigation data and the complete planned list", async () => {
  const f = fixture();
  f.state.shared.state = "pending";
  f.save();
  let result = await f.next();
  expect(f.read(result.taskFile!)).toContain(buildSetupUnitPrompt(f.root, f.state, null));
  f.write(unitBatchFile("shared"), JSON.stringify([{ setup: { links: [], patterns: [] } }]));
  f.complete("shared");
  result = await f.next();
  expect(f.read(result.taskFile!)).toContain(buildSetupUnitPrompt(f.root, loadPlanState(f.root).state!, null, f.state.subsystems[0]));
});

it("holds completed batches for the graph, refills free slots, and applies them once ready", async () => {
  const f = parallelFixture(); f.save(); await f.next();
  f.batch("shared"); f.batch("a");
  vi.mocked(nextGraph.ensureNextGraph).mockResolvedValueOnce({ version: 1, token: "test", pid: process.pid,
    startedAt: Date.now(), status: "running", completed: 7, total: 20 });
  const waiting = await f.next();
  expect(waiting.output).toContain("still building (7 of 20 files)");
  expect(f.apply).not.toHaveBeenCalled();
  expect(waiting.taskFiles).toEqual(["c", "d"].map(slug => `.mex/local/setup-next/subsystem-${slug}.md`));
  expect(loadPlanState(f.root).state!.shared.state).not.toBe("done");
  await f.next();
  expect(f.apply.mock.calls.filter(([file]) => file.includes("shared.operations"))).toHaveLength(1);
  expect(loadPlanState(f.root).state!.shared.state).toBe("done");
});

it("keeps --start batches without receipts waiting across calls and names failed-worker recovery", async () => {
  const f = fixture(); f.save(); await f.next();
  f.write(unitBatchFile("a"), '[{"opId":"setup_a_one"}]');
  vi.mocked(nextGraph.ensureNextGraph).mockResolvedValueOnce({ version: 1, token: "test", pid: process.pid,
    startedAt: Date.now(), status: "running", completed: 1, total: 20 });
  const waiting = await runSetupNext({ projectRoot: f.root, start: true,
    applier: () => ({ apply: f.apply, close: async () => ({ changed: false }) }) });
  expect(waiting.taskFile).toBeUndefined();
  expect(waiting.output).toContain("Finished tasks waiting for the code graph");
  expect(waiting.output).not.toContain("Wait for one to finish");
  expect(f.apply).not.toHaveBeenCalled();
  vi.mocked(nextGraph.ensureNextGraph).mockResolvedValueOnce({ version: 1, token: "test", pid: process.pid,
    startedAt: Date.now(), status: "failed", completed: 1, total: 20,
    message: "Graph worker (failed; exit; signal SIGKILL).", diagnostic: "Worker diagnostics: bounded tail" });
  const failed = await f.next();
  expect(failed.status).toBe("blocked");
  expect(failed.output).toContain("SIGKILL");
  expect(failed.output).toContain("mex setup next --start");
  expect(f.apply).not.toHaveBeenCalled();
  expect((await f.next()).status).toBe("complete");
  expect(f.apply).toHaveBeenCalledTimes(1);
});

it.each([null, [], { links: "bad" }, { patterns: [{ file: "patterns/task.md", content: "bad" }] }])("refuses malformed setup metadata %j before apply, then accepts the repaired split", async (setup) => {
  const f = fixture();
  f.save();
  await f.next();
  f.write(unitBatchFile("a"), JSON.stringify([{ opId: "setup_a_one", setup }]));
  f.complete("subsystem:a");
  const refused = await f.next();
  expect(refused.status).toBe("task");
  expect(refused.output).toContain("fix the batch");
  expect(f.read(refused.taskFile!)).toContain("SETUP_APPLY_FAILED");
  expect(f.apply).not.toHaveBeenCalled();
  f.write(unitBatchFile("a"), JSON.stringify([{ opId: "setup_a_one", setup: { links: [] } }]));
  f.complete("subsystem:a");
  expect((await f.next()).status).toBe("complete");
  expect(f.apply).toHaveBeenCalledWith(".mex/local/setup-ops/a.operations.json", expect.any(Object));
  expect(JSON.parse(f.read(".mex/local/setup-ops/a.operations.json"))).toEqual([{ opId: "setup_a_one" }]);
});

it("hands back diagnostics for a malformed batch left by an earlier run", async () => {
  const f = fixture();
  f.write(unitBatchFile("a"), '[{"setup":{"links":"bad"}}]');
  f.save();
  const result = await f.next();
  expect(result.output).toContain("fix the batch");
  expect(f.read(result.taskFile!)).toContain("setup.links must hold at most 32 links");
  expect(f.apply).not.toHaveBeenCalled();
  expect(loadPlanState(f.root).state!.queue!.awaiting).toMatchObject([{ unit: "subsystem:a", kind: "fix" }]);
});

it.each(["pending", "handed-out", "background"])("resumes an old %s final step without a final agent task and reconciles only once", async (kind) => {
  const f = fixture();
  delete f.state.navigationVersion;
  f.state.subsystems[0]!.state = "done";
  if (kind === "background") delete f.state.queue;
  if (kind === "handed-out") {
    f.state.final.state = "running";
    f.state.queue!.awaiting = [{ unit: "final", kind: "write", repeats: 0 }];
    f.write(".mex/local/setup-next/final.md", "Old final task");
  }
  // Legacy subsystem batches without setup metadata still use default edges.
  f.write(unitBatchFile("a"), "[]");
  f.save();
  const reconcile = vi.spyOn(links, "reconcileSetupNavigation");
  expect((await f.next()).status).toBe("complete");
  expect(loadPlanState(f.root).state!.final.state).toBe("done");
  expect(existsSync(join(f.root, ".mex/local/setup-next/final.md"))).toBe(false);
  expect(f.read(".mex/context/a.md")).toContain("target: context/architecture.md");
  const before = f.read(".mex/ROUTER.md");
  expect((await f.next()).status).toBe("complete");
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(f.read(".mex/ROUTER.md")).toBe(before);
});

it("upgrades legacy shared patterns without replaying facts, and keeps the prior fact count", async () => {
  const f = fixture();
  delete f.state.navigationVersion;
  f.state.shared.facts = 9;
  f.state.subsystems[0]!.state = "done";
  f.state.queue!.awaiting = [{ unit: "final", kind: "write", repeats: 0 }];
  f.write(unitBatchFile("shared"), '[{"opId":"old"}]');
  f.save();
  const task = await f.next();
  expect(f.read(task.taskFile!)).toContain("missing cross-cutting patterns");
  expect(existsSync(join(f.root, unitBatchFile("shared")))).toBe(false);
  expect(f.apply).not.toHaveBeenCalled();
  f.write(unitBatchFile("shared"), '[{"setup":{"patterns":[]}}]');
  f.complete("shared");
  expect((await f.next()).status).toBe("complete");
  expect(loadPlanState(f.root).state).toMatchObject({ navigationVersion: 1, shared: { state: "done", facts: 9 }, final: { state: "done" } });
});

it("records final skipped while shared files are unfilled, then resumes the shared task", async () => {
  const f = fixture();
  f.state.shared.state = "skipped";
  f.state.subsystems[0]!.state = "done";
  f.write(".mex/AGENTS.md", readFileSync(join(setupTemplatesDirectory(), "AGENTS.md"), "utf8"));
  f.save();
  const result = await f.next();
  expect(result.status).toBe("blocked");
  expect(result.output).toContain("Run `mex setup next`");
  expect(loadPlanState(f.root).state).toMatchObject({ final: { state: "skipped", reason: "the shared files are not filled yet" }, shared: { state: "pending" } });
  expect((await f.next()).taskFile).toBe(".mex/local/setup-next/shared.md");
});

it("saves navigation failure as pending, names recovery, and retries without an agent", async () => {
  const f = fixture();
  f.state.subsystems[0]!.state = "done";
  f.write(".mex/context/a.md", "---\nname: [invalid\n---\n");
  f.save();
  const result = await f.next();
  expect(result.status).toBe("blocked");
  expect(result.output).toContain("rerun `mex setup next`");
  expect(result.output).toContain(".mex/context/a.md");
  expect(loadPlanState(f.root).state!.final.state).toBe("pending");
  f.write(".mex/context/a.md", "---\nname: a\n---\n# A\n");
  expect((await f.next()).status).toBe("complete");
});

function parallelFixture() {
  const f = fixture();
  const state = createPlanState({ ...f.state.plan, candidates: ["a", "b", "c", "d"].map((slug) => ({
    path: `src/${slug}`, files: 20, commits: null, budget: { min: 4, max: 6 },
  })) });
  state.queue = { mode: "units" };
  state.navigationVersion = 1;
  f.apply.mockImplementation(async (file) => existsSync(join(f.root, file))
    ? { kind: "applied", facts: 1, operations: 1, replayed: false, warnings: [] }
    : { kind: "missing" });
  const save = () => savePlanState(f.root, state);
  const next = (retry?: string) => runSetupNext({ projectRoot: f.root, ...(retry ? { retry } : {}), applier: () => ({ apply: f.apply, close: async () => ({ changed: false }) }), env: {} });
  const batch = (slug: string) => {
    f.write(unitBatchFile(slug), JSON.stringify([{ opId: `setup_${slug}_one`, setup: { links: [], patterns: [] } }]));
    f.complete(slug === "shared" ? slug : `subsystem:${slug}`);
  };
  return { ...f, state, save, next, batch };
}

it("cleans abandoned legacy prompt folders when setup next starts", async () => {
  const f = fixture(); f.save();
  f.write(".mex/local/setup-population-abandoned/prompt.md", "abandoned");
  const path = join(f.root, ".mex/local/setup-population-abandoned");
  const old = new Date(Date.now() - 3_600_001); utimesSync(path, old, old);
  await f.next();
  expect(existsSync(path)).toBe(false);
});

it("hands out three tasks, applies out-of-order completions in plan order, and mixes fixes with new work", async () => {
  const f = parallelFixture(); f.save();
  const first = await f.next();
  expect(first.taskFiles).toEqual(["shared", "subsystem-a", "subsystem-b"].map((slug) => `.mex/local/setup-next/${slug}.md`));
  expect(first.output).toContain("As soon as any one finishes");
  expect(first.output).toContain("Without subagents, finish these tasks one by one, then run `mex setup next`.");
  f.batch("b"); f.batch("a"); f.batch("shared");
  f.apply.mockImplementation(async (file) => file.includes("/a.")
    ? { kind: "refused", problems: [{ code: "GROUNDING_NOT_FOUND", message: "repair this fact" }] }
    : { kind: "applied", facts: 1, operations: 1, replayed: false, warnings: [] });
  const mixed = await f.next();
  expect(f.apply.mock.calls.map(([file]) => file)).toEqual(["shared", "a", "b"].map((slug) => `.mex/local/setup-ops/${slug}.operations.json`));
  expect(mixed.taskFiles).toEqual(["subsystem-a", "subsystem-c", "subsystem-d"].map((slug) => `.mex/local/setup-next/${slug}.md`));
  expect(f.read(mixed.taskFiles![0]!)).toContain("repair this fact");
  expect(loadPlanState(f.root).state!.queue!.awaiting!.map((entry) => [entry.unit, entry.kind])).toEqual([
    ["subsystem:a", "fix"], ["subsystem:c", "write"], ["subsystem:d", "write"],
  ]);
});

it("keeps unfinished tasks running without repeats and fills only free slots", async () => {
  const f = parallelFixture(); f.save(); await f.next();
  f.batch("b");
  const refill = await f.next();
  expect(refill.taskFile).toBe(".mex/local/setup-next/subsystem-c.md");
  expect(f.apply.mock.calls.map(([file]) => file)).toEqual([".mex/local/setup-ops/b.operations.json"]);
  expect(loadPlanState(f.root).state!.queue!.awaiting).toMatchObject([
    { unit: "shared", repeats: 0 }, { unit: "subsystem:a", repeats: 0 }, { unit: "subsystem:c", repeats: 0 },
  ]);
  const waiting = await f.next();
  expect(waiting.taskFile).toBeUndefined();
  expect(waiting.output).toContain("Wait for one to finish");
  expect(waiting.output).toContain("--retry <task>");
  expect(waiting.output).toContain("subsystem:a");
});

it("never applies a partial batch or an obsolete receipt, and retries explicitly", async () => {
  const f = parallelFixture(); f.save(); await f.next();
  f.write(unitBatchFile("a"), '[{"opId":');
  const oldToken = loadPlanState(f.root).state!.queue!.awaiting![1]!.completionToken!;
  expect((await f.next()).taskFile).toBeUndefined();
  expect(f.apply).not.toHaveBeenCalled();
  const retried = await f.next("subsystem:a");
  expect(retried.taskFile).toBe(".mex/local/setup-next/subsystem-a.md");
  expect(loadPlanState(f.root).state!.queue!.awaiting![1]).toMatchObject({ repeats: 1 });
  f.write(".mex/local/setup-next/subsystem-a.done", oldToken);
  expect((await f.next()).taskFile).toBeUndefined();
  expect(f.apply).not.toHaveBeenCalled();
  f.batch("a");
  expect((await f.next()).taskFile).toBe(".mex/local/setup-next/subsystem-c.md");
  expect(f.apply).toHaveBeenCalledTimes(1);
});

it("bounds abandoned-task retries and leaves other running units untouched", async () => {
  const f = parallelFixture(); f.save(); await f.next();
  await f.next("subsystem:a"); await f.next("subsystem:a");
  const skipped = await f.next("subsystem:a");
  expect(skipped.output).toContain("no completion signal after 3 retries");
  expect(loadPlanState(f.root).state!.subsystems[0]!.state).toBe("skipped");
  expect(loadPlanState(f.root).state!.queue!.awaiting).toMatchObject([
    { unit: "shared", repeats: 0 }, { unit: "subsystem:b", repeats: 0 }, { unit: "subsystem:c", repeats: 0 },
  ]);
  expect(f.apply).not.toHaveBeenCalled();
  expect((await f.next("subsystem:absent")).status).toBe("blocked");
});

it("resumes a stored single-awaiting object and writes the list format", async () => {
  const f = parallelFixture(); f.state.shared.state = "done"; f.save();
  const path = ".mex/local/setup-plan.json";
  const raw = JSON.parse(f.read(path));
  raw.queue.awaiting = { unit: "subsystem:a", kind: "write", repeats: 1 };
  f.write(path, JSON.stringify(raw));
  const result = await f.next();
  expect(result.taskFiles).toHaveLength(2);
  expect(loadPlanState(f.root).state!.queue!.awaiting![0]).toMatchObject({ unit: "subsystem:a", repeats: 1 });
  expect((await f.next("subsystem:a")).taskFile).toBe(".mex/local/setup-next/subsystem-a.md");
});

it("names tracked source folders skipped by corpus rules once per plan, omitting the line when none are skipped", () => {
  const f = fixture();
  execFileSync("git", ["init", "-q"], { cwd: f.root });
  f.write("src/a/index.ts", "export const indexed = true;");
  execFileSync("git", ["add", "src"], { cwd: f.root });
  expect(discoverSkippedSourceFolders(f.root)).toEqual([]);
  const clean = buildSetupUnitPrompt(f.root, f.state, null);
  expect(clean).not.toContain("Source folders outside the code graph");
  f.write("build/tasks.ts", "export function build() {}");
  execFileSync("git", ["add", "build"], { cwd: f.root });
  expect(discoverSkippedSourceFolders(f.root)).toEqual(["build/"]);
  // Existing plan is cached; a fresh plan includes the newly observed source folder.
  expect(buildSetupUnitPrompt(f.root, f.state, null)).toBe(clean);
  delete f.state.skippedSourceFolders;
  const line = "Source folders outside the code graph: `build/`. Ground facts to indexed code instead.";
  expect(buildSetupUnitPrompt(f.root, f.state, null)).toContain(line);
  expect(buildSetupUnitPrompt(f.root, f.state, null, f.state.subsystems[0])).toContain(line);
});

it("keeps uninspected outstanding tasks if a later apply stops for graph recovery", async () => {
  const f = parallelFixture(); f.save(); await f.next();
  f.batch("shared"); f.batch("a");
  f.apply.mockImplementation(async (file) => file.includes("/a.")
    ? { kind: "refused", problems: [{ code: "GRAPH_STALE", message: "refresh needed" }] }
    : { kind: "applied", facts: 1, operations: 1, replayed: false, warnings: [] });
  const stopped = await runSetupNext({ projectRoot: f.root,
    applier: () => ({ apply: f.apply, close: async () => ({ changed: false }) }),
    refreshGraph: async () => { throw new Error("graph refresh stopped"); },
  });
  expect(stopped.status).toBe("blocked");
  const state = loadPlanState(f.root).state!;
  expect(state.shared.state).toBe("done");
  expect(state.queue!.awaiting!.map((entry) => entry.unit)).toEqual(["subsystem:a", "subsystem:b"]);
});

it("applies a leftover batch without handing its unit out or requiring a receipt", async () => {
  const f = fixture(); f.save();
  f.write(unitBatchFile("a"), '[{"opId":"setup_a_one"}]');
  const result = await f.next();
  expect(result.status).toBe("complete");
  expect(result.output).toContain("Applied the batch an earlier run left for subsystem src/a/");
  expect(f.apply).toHaveBeenCalledTimes(1);
  expect(loadPlanState(f.root).state!.subsystems[0]!.state).toBe("done");
});

it("starts a new chat by applying complete batches without receipts and repeating only missing work", async () => {
  const f = parallelFixture(); f.save(); await f.next();
  f.write(unitBatchFile("shared"), '[{"opId":"setup_shared_one","setup":{"links":[],"patterns":[]}}]');
  f.write(unitBatchFile("a"), '[{"opId":"setup_a_one"}]');
  const original = loadPlanState(f.root).state!.queue!.awaiting![2]!.completionToken;
  expect((await f.next()).taskFile).toBeUndefined();
  expect(f.apply).not.toHaveBeenCalled();
  const result = await runSetupNext({ projectRoot: f.root, start: true, applier: () => ({ apply: f.apply, close: async () => ({ changed: false }) }), env: {} });
  expect(f.apply.mock.calls.map(([file]) => file)).toEqual([".mex/local/setup-ops/shared.operations.json", ".mex/local/setup-ops/a.json", ".mex/local/setup-ops/b.json"]);
  expect(result.taskFiles).toEqual(["b", "c", "d"].map(slug => ".mex/local/setup-next/subsystem-" + slug + ".md"));
  const state = loadPlanState(f.root).state!;
  expect(state.shared.state).toBe("done"); expect(state.subsystems[0]!.state).toBe("done");
  expect(state.queue!.awaiting![0]).toMatchObject({unit:"subsystem:b", repeats:1});
  expect(state.queue!.awaiting![0]!.completionToken).not.toBe(original);
  expect(result.output).toContain("Applied the batch an earlier run left");
});

it.each(["unparseable", "refused"])("starts a new chat with a fix for a %s batch without a receipt", async (kind) => {
  const f = fixture(); f.save(); await f.next();
  f.write(unitBatchFile("a"), kind === "unparseable" ? '[{' : '[{"opId":"setup_a_one"}]');
  if (kind === "refused") f.apply.mockResolvedValue({ kind: "refused", problems: [{code:"GROUNDING_NOT_FOUND", message:"repair this fact"}] });
  const result = await runSetupNext({ projectRoot: f.root, start:true, applier: () => ({apply:f.apply,close:async()=>({changed:false})}) });
  expect(result.output).toContain("fix the batch");
  expect(f.read(result.taskFile!)).toContain(kind === "unparseable" ? "SETUP_APPLY_FAILED" : "GROUNDING_NOT_FOUND");
  expect(loadPlanState(f.root).state!.queue!.awaiting).toMatchObject([{unit:"subsystem:a",kind:"fix",repeats:0}]);
});

it("repeats a shared task with no batch on --start even when its scaffold edits were saved", async () => {
  const f = parallelFixture(); f.save(); await f.next();
  const result = await runSetupNext({ projectRoot: f.root, start: true, applier: () => ({ apply: f.apply, close: async () => ({ changed: false }) }), env: {} });
  expect(result.taskFiles).toHaveLength(3);
  expect(loadPlanState(f.root).state!.queue!.awaiting).toMatchObject([
    {unit:"shared",repeats:1}, {unit:"subsystem:a",repeats:1}, {unit:"subsystem:b",repeats:1},
  ]);
  expect(loadPlanState(f.root).state!.shared.state).not.toBe("done");
});
