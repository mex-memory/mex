import { afterEach, describe, expect, it, vi } from "vitest";
import { noteProbe, surfaces, whatLine, type SessionSummary } from "../what.js";

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawnSync,
}));
vi.mock("../native-rank.js", () => ({ rankBinary: () => "fixture-hook" }));
vi.mock("../context.js", () => ({ knowledgeProject: () => ({ projectId: "fixture", root: "checkout" }) }));
afterEach(() => spawnSync.mockReset());

describe("session receipt explanation", () => {
  it("shows counts and titles without entry text or clock times", () => {
    const s: SessionSummary = { session: "s", gave: 2, withheld: 1, replaced: 0, estimatedFalse: 0, closedDeliveries: 0, partial: false, items: [
      { id: "mx_ruleaa", kind: "rule", level: "team", title: "Use the pool", action: "given", detail: "" },
      { id: "mx_recipe", kind: "recipe", level: "team", title: "Run unit tests", action: "given", detail: "" },
    ] };
    expect(whatLine(s)).toBe("MEX · this session: gave 2 items (1 recipe, 1 team rule) · withheld 1 out of date · replaced 0 long outputs · details: mex status");
  });
});

it("keeps the two-second optional probes separate from the surface ledger read", () => {
  const options = { projectPath: "checkout" };
  spawnSync.mockReturnValue({ status: null, stdout: "", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) });
  for (const kind of ["opened", "wrong"] as const) {
    expect(noteProbe("mx_ruleaa", kind, options)).toBe(false);
    expect(spawnSync).toHaveBeenLastCalledWith("fixture-hook", ["--probe"], expect.objectContaining({ timeout: 2000 }));
  }
  expect(() => surfaces(options)).toThrow("The surface ledger is unavailable.");
  expect(spawnSync).toHaveBeenLastCalledWith("fixture-hook", ["--surfaces"], expect.objectContaining({ timeout: 2000 }));
  expect(noteProbe("mx_ruleaa", "wrong", options, { invocation: "report" })).toBe(false);
  expect(spawnSync).toHaveBeenLastCalledWith("fixture-hook", ["--probe"], expect.objectContaining({ timeout: 10_000 }));
});
