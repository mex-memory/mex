import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHeadlessSetup } from "../headless.js";
import * as headless from "../headless.js";
import { runSetup } from "../index.js";
import * as setup from "../index.js";
import { assessSetupHealth } from "../health.js";
import { SCAFFOLD_FILES } from "../phases.js";
import { runSetupNext } from "../next.js";
import { createPlanState, savePlanState } from "../subsystem-state.js";

// #284: rerunning setup on a set-up checkout reports its status instead of
// redoing work, and otherwise names what is missing before finishing it.

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); }
    catch { /* Windows can hold a sqlite handle briefly. */ }
  }
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-health-"));
  roots.push(root);
  return root;
}

function populate(root: string): () => Promise<{ tool: "codex"; completed: true }> {
  return async () => {
    for (const file of SCAFFOLD_FILES) {
      writeFileSync(join(root, ".mex", file), "---\nlast_updated: 2026-10-25\n---\n# Authored knowledge\n\nRetain this work.\n");
    }
    mkdirSync(join(root, ".mex", "patterns"), { recursive: true });
    writeFileSync(join(root, ".mex", "patterns", "restart-service.md"), "# Restart the service\n\nStop, then start.\n");
    return { tool: "codex", completed: true };
  };
}

/** Run the plain terminal setup in `root`, returning its result and printed lines. */
async function rerun(root: string, options: Parameters<typeof runSetup>[0] = {}) {
  vi.spyOn(process, "cwd").mockReturnValue(root);
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  const result = await runSetup({ yes: true, ...options });
  vi.mocked(console.log).mockRestore();
  return { result, output: lines.join("\n") };
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, `${prefix}${entry.name}/`);
      else files[`${prefix}${entry.name}`] = readFileSync(path, "utf8");
    }
  };
  visit(root, "");
  return files;
}

describe("status-first setup rerun (#284)", () => {
  it("keeps authored-file placeholders on the finalization path even when population is complete", async () => {
    const root = fixture();
    await runHeadlessSetup({ projectRoot: root, mode: "agent-memory", tools: [], populate: populate(root) });
    writeFileSync(join(root, ".mex/context/stack.md"), "# Authored stack\nUpdated [YYYY-MM-DD] for [Project Name].\n");
    const status = headless.inspectSetupStatus(root);
    vi.spyOn(headless, "inspectSetupStatus").mockReturnValue({ ...status, populated: true });
    const before = snapshot(root);
    const health = await assessSetupHealth(root);
    expect(health.healthy).toBe(false);
    expect(health.needsCommitOnly).toBe(false);
    expect(health.missing).toContain("Setup finalization still needs to fill placeholders in .mex/context/stack.md.");
    expect(snapshot(root)).toEqual(before);
  });
  it("reports an already set-up workspace and changes nothing", async () => {
    const root = fixture();
    expect(await runHeadlessSetup({ projectRoot: root, mode: "agent-memory", tools: [], populate: populate(root) }))
      .toMatchObject({ ready: true });
    const before = snapshot(root);
    const { result, output } = await rerun(root);
    expect(result).toMatchObject({ outcome: "complete", exitCode: 0 });
    expect(output).toMatch(/^MEX is already set up here \(\d+ entities, \d+ facts?\)\./u);
    expect(output).toContain("Nothing to do. Check memory health with `mex check`");
    expect(output).toContain("Run `mex setup --force` to run the full setup again");
    expect(output).not.toContain("MEX setup ·");
    expect(snapshot(root)).toEqual(before);
  });

  it("reports a plan-less completed workspace in setup next without writing a plan or tasks", async () => {
    const root = fixture();
    await runHeadlessSetup({ projectRoot: root, mode: "agent-memory", tools: [], populate: populate(root) });
    const before = snapshot(root);
    const result = await runSetupNext({ projectRoot: root, start: true });
    expect(result).toMatchObject({ status: "complete", exitCode: 0 });
    expect(result.output).toContain("MEX is already set up here");
    expect(snapshot(root)).toEqual(before);
  });

  it("continues an unfinished plan even when all shared placeholders are filled", async () => {
    const root = fixture();
    await runHeadlessSetup({ projectRoot: root, mode: "agent-memory", tools: [], populate: populate(root) });
    const plan = createPlanState({ source: "tree", ranking: "size", sourceFiles: 0, target: { min: 1, max: 1 }, candidates: [] });
    plan.queue = { mode: "single" };
    plan.shared.state = "running";
    // A real interrupted unit has a run record; a plan with none never started (#283).
    plan.shared.runs.push({ kind: "write", startedAt: new Date().toISOString(), durationMs: 1000, outcome: "stopped" });
    savePlanState(root, plan);
    expect(await assessSetupHealth(root)).toMatchObject({ healthy: false, needsCommitOnly: false });
    const result = await runSetupNext({ projectRoot: root });
    expect(result.status).toBe("task");
    expect(result.output).not.toContain("MEX is already set up here");
  });

  it("--force and an explicit new tool still run the full flow", async () => {
    vi.spyOn(setup, "installSetupAgentAssets").mockImplementation(() => null);
    const root = fixture();
    await runHeadlessSetup({ projectRoot: root, mode: "agent-memory", tools: [], populate: populate(root) });
    const forced = await rerun(root, { force: true });
    expect(forced.output).toContain("MEX setup ·");
    expect(forced.output).not.toContain("MEX is already set up here");
    const added = await rerun(root, { tools: ["claude"] });
    expect(added.output).toContain("MEX setup ·");
    expect(added.result).toMatchObject({ outcome: "complete", exitCode: 0 });
  });

  it("names an interrupted population and finishes only that part", async () => {
    const root = fixture();
    await runHeadlessSetup({
      projectRoot: root, mode: "agent-memory", tools: [],
      populate: async () => ({ tool: "codex", completed: false }),
    });
    const { result, output } = await rerun(root);
    expect(output).toContain("Setup will finish what is missing:");
    expect(output).toContain("Scaffold population is not finished.");
    expect(output).toContain("MEX setup ·");
    expect(result).toMatchObject({ outcome: "paused", exitCode: 2 });
  });

  it("a code repository goes from commit pointer to healthy, and reports changed code as drift", async () => {
    const root = fixture();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "health@example.com"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Health"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "export function ready(): boolean { return true; }\n");
    expect(await runHeadlessSetup({ projectRoot: root, tools: [], populate: populate(root) })).toMatchObject({ populated: true });

    const uncommitted = await rerun(root);
    expect(uncommitted.output).toContain("MEX is prepared here but the setup is not committed yet. Run `mex setup --browser`");
    expect(uncommitted.result).toMatchObject({ outcome: "complete", exitCode: 0 });

    execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "Set up MEX"], { cwd: root, stdio: "ignore" });
    const healthy = await rerun(root);
    expect(healthy.output).toMatch(/MEX is already set up here \(\d+ entities, \d+ facts?, graph current\)\./u);

    writeFileSync(join(root, "src", "index.ts"), "export function ready(): boolean { return false; }\n");
    const drift = await rerun(root);
    expect(drift.result).toMatchObject({ outcome: "complete", exitCode: 0 });
    expect(drift.output).toContain("graph behind the code");
    expect(drift.output).toContain("1 source file has changed since the graph was built. Run `mex sync`");
    const health = await assessSetupHealth(root);
    expect(health).toMatchObject({ healthy: true, needsCommitOnly: false, missing: [] });
  }, 60_000);
});
