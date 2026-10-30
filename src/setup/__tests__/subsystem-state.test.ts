import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SETUP_PLAN_STATE_FILE,
  createPlanState,
  hasUnfinishedPlanState,
  isPlanStateComplete,
  loadPlanState,
  parsePlanState,
  savePlanState,
  subsystemSlugs,
  subsystemWikiFile,
  unitBatchFile,
} from "../subsystem-state.js";
import type { SubsystemPlan } from "../subsystems.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-plan-state-"));
  roots.push(root);
  mkdirSync(join(root, ".mex"));
  return root;
}

const PLAN: SubsystemPlan = {
  source: "graph",
  ranking: "activity",
  sourceFiles: 900,
  target: { min: 5, max: 8 },
  candidates: [
    { path: "src/router", files: 40, commits: 12, budget: { min: 10, max: 15 } },
    { path: "lib/router", files: 20, commits: 3, budget: { min: 6, max: 10 } },
    { path: "src", files: 12, commits: 2, remainder: true, budget: { min: 6, max: 10 } },
    { path: "packages/setup", files: 9, commits: 1, budget: { min: 4, max: 6 } },
  ],
};

describe("subsystem slugs", () => {
  it("uses the folder name, more of the path on a clash, -core for a folder's own files, never a shared file's name", () => {
    expect(subsystemSlugs(PLAN.candidates)).toEqual(["src-router", "lib-router", "src-core", "packages-setup"]);
    expect(subsystemSlugs([{ path: "src/middleware" }, { path: "src/jsx" }])).toEqual(["middleware", "jsx"]);
    expect(subsystemSlugs([{ path: "architecture" }])).toEqual(["architecture-code"]);
    expect(subsystemSlugs([{ path: "a/x" }, { path: "a/x", remainder: true }, { path: "b/A X!" }])).toEqual(["x", "x-core", "a-x"]);
  });

  it("is always distinct and file-name safe", () => {
    const slugs = subsystemSlugs([{ path: "src/x" }, { path: "src/x" }, { path: "src/x" }, { path: "ünï/çödé" }]);
    expect(new Set(slugs).size).toBe(4);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it("derives the Wiki file and batch file from the slug only", () => {
    expect(subsystemWikiFile("router")).toBe("context/router.md");
    expect(unitBatchFile("router")).toBe(".mex/local/setup-ops/router.json");
  });
});

describe("stored plan state", () => {
  it("round-trips through the file and reopens an interrupted run as pending", () => {
    const root = project();
    const state = createPlanState(PLAN, new Date("2026-10-23T10:00:00Z"));
    state.subsystems[0]!.state = "done";
    state.subsystems[0]!.facts = 7;
    state.subsystems[0]!.runs.push({ kind: "write", startedAt: "2026-10-23T10:00:00.000Z", durationMs: 1234, outcome: "completed", tool: "claude", usage: { inputTokens: 10, outputTokens: 2 } });
    state.subsystems[1]!.state = "running";
    state.subsystems[2]!.state = "skipped";
    state.subsystems[2]!.reason = "its batch was refused twice";
    savePlanState(root, state);
    const loaded = loadPlanState(root);
    expect(loaded.notice).toBeUndefined();
    expect(loaded.state!.plan).toEqual(PLAN);
    expect(loaded.state!.subsystems.map((unit) => unit.state)).toEqual(["done", "pending", "skipped", "pending"]);
    expect(loaded.state!.subsystems[0]).toMatchObject({ facts: 7, runs: [{ durationMs: 1234, usage: { inputTokens: 10, outputTokens: 2 } }] });
    expect(loaded.state!.subsystems[2]!.reason).toBe("its batch was refused twice");
    expect(hasUnfinishedPlanState(root)).toBe(true);
  });

  it("knows when every unit is done", () => {
    const state = createPlanState(PLAN);
    expect(isPlanStateComplete(state)).toBe(false);
    state.shared.state = "done";
    state.final.state = "done";
    for (const unit of state.subsystems) unit.state = "done";
    expect(isPlanStateComplete(state)).toBe(true);
    const root = project();
    savePlanState(root, state);
    expect(hasUnfinishedPlanState(root)).toBe(false);
  });

  it.each([
    ["not JSON", "{broken", "it is not valid JSON"],
    ["another file", JSON.stringify({ hello: "world" }), "it is not a MEX setup plan"],
    ["another version", JSON.stringify({ kind: "mex-setup-subsystem-plan", version: 99 }), "written by another MEX version"],
    ["truncated", JSON.stringify({ kind: "mex-setup-subsystem-plan", version: 1, plan: PLAN }), "incomplete or malformed"],
  ])("sets a %s state file aside with a clear notice instead of failing", (_name, text, reason) => {
    const root = project();
    mkdirSync(join(root, ".mex", "local"));
    writeFileSync(join(root, SETUP_PLAN_STATE_FILE), text);
    // Unreadable means "continue": loading replaces it and replay recognizes applied batches.
    expect(hasUnfinishedPlanState(root)).toBe(true);
    const loaded = loadPlanState(root);
    expect(loaded.state).toBeNull();
    expect(loaded.notice).toContain(reason);
    expect(loaded.notice).toContain("computed the plan again");
    expect(existsSync(join(root, SETUP_PLAN_STATE_FILE))).toBe(false);
    const aside = readdirSync(join(root, ".mex", "local")).filter((name) => name.startsWith("setup-plan.json.unreadable-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(root, ".mex", "local", aside[0]!), "utf8")).toBe(text);
  });

  it("refuses an edited slug that could redirect a write", () => {
    const state = createPlanState(PLAN);
    const raw = JSON.parse(JSON.stringify(state));
    raw.subsystems[0].slug = "../../src/evil";
    expect(parsePlanState(JSON.stringify(raw)).state).toBeNull();
    raw.subsystems[0].slug = "architecture";
    expect(parsePlanState(JSON.stringify(raw)).state).toBeNull();
    raw.subsystems[0].slug = raw.subsystems[1].slug;
    expect(parsePlanState(JSON.stringify(raw)).state).toBeNull();
  });

  it("has no state and no notice when no plan was stored", () => {
    const root = project();
    expect(loadPlanState(root)).toEqual({ state: null });
    expect(hasUnfinishedPlanState(root)).toBe(false);
  });
});
