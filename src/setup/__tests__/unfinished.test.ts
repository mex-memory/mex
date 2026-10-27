import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkToolConfigSync } from "../../drift/checkers/tool-config-sync.js";
import { MEX_ANCHOR_END, MEX_ANCHOR_START } from "../../tool-config.js";
import { createPlanState, savePlanState } from "../subsystem-state.js";
import type { SubsystemPlan } from "../subsystems.js";
import {
  MEX_SETUP_NOTICE_END,
  MEX_SETUP_NOTICE_START,
  SETUP_HANDOFF_PROMPT,
  countSetupUnits,
  describeUnfinishedSetup,
  managedInstructionFiles,
  removeSetupNotice,
  syncSetupNotice,
} from "../unfinished.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-unfinished-"));
  roots.push(root);
  mkdirSync(join(root, ".mex", "local"), { recursive: true });
  return root;
}

const PLAN: SubsystemPlan = {
  source: "graph", ranking: "activity", sourceFiles: 400, target: { min: 5, max: 8 },
  candidates: [
    { path: "src/a", files: 30, commits: 3, budget: { min: 10, max: 15 } },
    { path: "src/b", files: 20, commits: 1, budget: { min: 6, max: 10 } },
  ],
};

describe("the managed setup block", () => {
  it("goes only into instruction files MEX already manages, and comes out byte for byte", () => {
    const root = project();
    const claude = "# Mine\n\nRead `.mex/ROUTER.md` first.\n";
    const cursor = `my rules\r\n\r\n${MEX_ANCHOR_START}\r\npointer\r\n${MEX_ANCHOR_END}\r\n`;
    const windsurf = "my own rules, no MEX here\n";
    writeFileSync(join(root, "CLAUDE.md"), claude);
    writeFileSync(join(root, ".cursorrules"), cursor);
    writeFileSync(join(root, ".windsurfrules"), windsurf);
    expect(managedInstructionFiles(root).sort()).toEqual([".cursorrules", "CLAUDE.md"]);

    expect(syncSetupNotice(root, { done: 2, total: 9 }).sort()).toEqual([".cursorrules", "CLAUDE.md"]);
    const withBlock = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(withBlock).toBe(`${claude}\n${MEX_SETUP_NOTICE_START}\nMEX setup is not finished (2/9). Run \`mex setup next --start\` first and do what it prints; repeat until it says setup is complete.\n${MEX_SETUP_NOTICE_END}\n`);
    expect(readFileSync(join(root, ".cursorrules"), "utf8")).toContain(`\r\n${MEX_SETUP_NOTICE_END}\r\n`);
    expect(readFileSync(join(root, ".windsurfrules"), "utf8")).toBe(windsurf);

    // Progress updates the block in place; a second write with the same progress changes nothing.
    syncSetupNotice(root, { done: 3, total: 9 });
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("(3/9)");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8").match(/mex-setup:start/gu)).toHaveLength(1);
    expect(syncSetupNotice(root, { done: 3, total: 9 })).toEqual([]);

    expect(syncSetupNotice(root, null).sort()).toEqual([".cursorrules", "CLAUDE.md"]);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(claude);
    expect(readFileSync(join(root, ".cursorrules"), "utf8")).toBe(cursor);
    expect(syncSetupNotice(root, null)).toEqual([]);
  });

  it("never creates an instruction file and leaves malformed markers alone", () => {
    const root = project();
    expect(syncSetupNotice(root, { done: 0, total: 1 })).toEqual([]);
    const broken = `Read .mex/ROUTER.md\n${MEX_SETUP_NOTICE_START}\nno end marker\n`;
    writeFileSync(join(root, "AGENTS.md"), broken);
    expect(syncSetupNotice(root, null)).toEqual([]);
    expect(syncSetupNotice(root, { done: 0, total: 1 })).toEqual([]);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(broken);
    expect(removeSetupNotice(Buffer.from("no block\n"))).toBeNull();
  });

  it("does not count as drift between tool config copies", () => {
    const root = project();
    const copy = "<!-- mex-tool-config v1 -->\nRead .mex/ROUTER.md\n";
    writeFileSync(join(root, "CLAUDE.md"), copy);
    writeFileSync(join(root, ".cursorrules"), copy);
    syncSetupNotice(root, { done: 1, total: 4 });
    writeFileSync(join(root, ".cursorrules"), copy);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain(MEX_SETUP_NOTICE_START);
    expect(checkToolConfigSync(root)).toEqual([]);
  });
});

describe("the unfinished-setup line", () => {
  it("counts settled units and names the command that continues the setup", () => {
    const root = project();
    expect(describeUnfinishedSetup(root)).toBeNull();
    const state = createPlanState(PLAN);
    state.queue = { mode: "units" };
    state.shared.state = "done";
    state.subsystems[0]!.state = "skipped";
    savePlanState(root, state);
    expect(countSetupUnits(state)).toEqual({ done: 2, total: 3 });
    expect(describeUnfinishedSetup(root)).toEqual({
      done: 2, total: 3, driver: "queue",
      line: "MEX setup 2/3, not finished. To continue, run `mex setup next --start` in your agent's chat and do what it prints.",
    });
    state.queue.finalized = true;
    savePlanState(root, state);
    expect(describeUnfinishedSetup(root)).toBeNull();
  });

  it("covers a background plan that stopped part-way until finalize records it", () => {
    const root = project();
    const state = createPlanState(PLAN);
    state.shared.state = "done";
    savePlanState(root, state);
    expect(describeUnfinishedSetup(root)).toMatchObject({ done: 1, total: 3, driver: "background" });
    expect(describeUnfinishedSetup(root)!.line).toContain("run `mex setup` (or `mex setup next --start` in your agent's chat)");
    state.finalizedAt = new Date().toISOString();
    savePlanState(root, state);
    expect(describeUnfinishedSetup(root)).toBeNull();
  });

  it("reads an unreadable plan as no plan without moving it (status reads never write)", () => {
    const root = project();
    writeFileSync(join(root, ".mex/local/setup-plan.json"), "{ broken");
    expect(describeUnfinishedSetup(root)).toBeNull();
    expect(readFileSync(join(root, ".mex/local/setup-plan.json"), "utf8")).toBe("{ broken");
  });

  it("asks the user to paste one short prompt", () => {
    expect(SETUP_HANDOFF_PROMPT.split("\n")).toHaveLength(2);
    expect(SETUP_HANDOFF_PROMPT).toContain("run `mex setup next --start` first, then do exactly what it prints");
    expect(SETUP_HANDOFF_PROMPT).toContain("Repeat until it prints that setup is complete");
  });
});
