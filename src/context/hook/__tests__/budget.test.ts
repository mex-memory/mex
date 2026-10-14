import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONTEXT_SESSION_BUDGET_CHARS, loadConfiguredContextConfig } from "../../../config.js";
import { cleanupProjects } from "../../__tests__/fixture.js";
import { loadInjectedChars } from "../../session.js";
import { decideBudget, EXHAUSTED_FACTOR, POINTER_MAX_CHARS, pointerLine } from "../budget.js";
import { HOOK_LOG_NAME } from "../run.js";
import { createHookProject, toolPayload, type HookProject } from "./fixture.js";

afterEach(() => {
  cleanupProjects();
  vi.unstubAllEnvs();
});

describe("pointerLine", () => {
  it("has the documented shape and never exceeds 120 characters, whatever the title", () => {
    const id = "mx_01M4H5M9B1QCYZEW8Y2QK01E1E";
    expect(pointerLine({ id, title: "Route registration", health: "fresh" })).toBe(`MEX: Route registration applies (fresh) — mex wiki show ${id}`);
    const long = pointerLine({ id, title: "T".repeat(400), health: "changed" });
    expect(long.length).toBeLessThanOrEqual(POINTER_MAX_CHARS);
    expect(long).toContain("applies (changed ⚠)");
    expect(long.endsWith(`mex wiki show ${id}`)).toBe(true);
    expect(long).toContain("…");
  });
});

describe("decideBudget", () => {
  const pointers = [{ id: "mx_1", title: "A fact", health: "fresh" as const }];
  const text = "x".repeat(500);

  it("sends whole packets while they fit the budget", () => {
    expect(decideBudget({ used: 0, budget: 1000, text, pointers })).toEqual({ kind: "full" });
    expect(decideBudget({ used: 500, budget: 1000, text, pointers })).toEqual({ kind: "full" });
  });

  it("degrades to pointers once the packet would push the total over", () => {
    const decision = decideBudget({ used: 501, budget: 1000, text, pointers });
    expect(decision).toEqual({ kind: "pointers", text: "MEX: A fact applies (fresh) — mex wiki show mx_1" });
  });

  it("sends nothing from 1.5 times the budget, and when even pointers would pass it", () => {
    expect(decideBudget({ used: 1000 * EXHAUSTED_FACTOR, budget: 1000, text, pointers })).toEqual({ kind: "exhausted" });
    expect(decideBudget({ used: 1499, budget: 1000, text, pointers })).toEqual({ kind: "exhausted" });
    expect(decideBudget({ used: 900, budget: 1000, text, pointers: [] })).toEqual({ kind: "exhausted" });
  });
});

describe("session budget in a hooked session", () => {
  let project: HookProject;
  const limitedRead = (session: string) =>
    toolPayload(session, "Read", { file_path: join(project.fx.root, "src/billing.ts"), offset: 1, limit: 3 });

  async function useBudget(chars: unknown): Promise<void> {
    project.fx.writeScaffoldFile("config.json", JSON.stringify({ aiTools: [], context: { sessionBudgetChars: chars } }));
  }

  it("counts what is injected, degrades to pointers over the budget, then goes silent", async () => {
    project = await createHookProject({ extraFacts: 40 });
    await useBudget(2500);
    const outputs: string[] = [];
    for (let i = 0; i < 22; i += 1) outputs.push(project.text(await project.run(limitedRead("s-budget"))));

    expect(outputs[0]).toContain("MEX knowledge (");
    const pointerOutputs = outputs.filter((o) => o.startsWith("MEX: "));
    expect(pointerOutputs.length).toBeGreaterThan(0);
    for (const output of pointerOutputs) {
      for (const line of output.split("\n")) expect(line.length).toBeLessThanOrEqual(POINTER_MAX_CHARS);
    }
    // Whole packets come first, then pointers, then silence; pointers count toward the total.
    const kinds = outputs.map((o) => (o === "" ? "none" : o.startsWith("MEX: ") ? "pointer" : "full"));
    expect(kinds.indexOf("full")).toBeLessThan(kinds.indexOf("pointer"));
    expect(kinds.indexOf("pointer")).toBeLessThan(kinds.lastIndexOf("none"));
    expect(kinds.slice(kinds.indexOf("none"))).not.toContain("full");
    expect(kinds.slice(kinds.indexOf("none"))).not.toContain("pointer");

    const injected = loadInjectedChars(project.fx.context.localDir, "s-budget");
    expect(injected).toBe(outputs.reduce((sum, o) => sum + o.length, 0));
    expect(injected).toBeLessThan(2500 * EXHAUSTED_FACTOR + POINTER_MAX_CHARS * 2 + 1500);
    const log = readFileSync(join(project.fx.context.localDir, HOOK_LOG_NAME), "utf8");
    expect(log).toContain("budget-pointers");
    expect(log).toContain("budget-exhausted");
  });

  it("applies the default budget when the config does not set one, and ignores invalid values", async () => {
    project = await createHookProject();
    const scaffold = project.fx.context.scaffoldRoot;
    expect(loadConfiguredContextConfig(scaffold).sessionBudgetChars).toBe(DEFAULT_CONTEXT_SESSION_BUDGET_CHARS);
    expect(DEFAULT_CONTEXT_SESSION_BUDGET_CHARS).toBe(12_000);
    await useBudget(2500);
    expect(loadConfiguredContextConfig(scaffold).sessionBudgetChars).toBe(2500);
    for (const bad of ["lots", 0, -5, 1.5, 5_000_000, null, [3000]]) {
      await useBudget(bad);
      expect(loadConfiguredContextConfig(scaffold).sessionBudgetChars).toBe(DEFAULT_CONTEXT_SESSION_BUDGET_CHARS);
    }
    writeFileSync(join(scaffold, "config.json"), "{ not json");
    expect(loadConfiguredContextConfig(scaffold).sessionBudgetChars).toBe(DEFAULT_CONTEXT_SESSION_BUDGET_CHARS);
    writeFileSync(join(scaffold, "config.json"), JSON.stringify({ context: "yes" }));
    expect(loadConfiguredContextConfig(scaffold).sessionBudgetChars).toBe(DEFAULT_CONTEXT_SESSION_BUDGET_CHARS);
  });

  it("budgets each session on its own and still de-duplicates before degrading", async () => {
    project = await createHookProject();
    await useBudget(100);
    // A tiny budget: the first packet is already over, so it degrades; a repeat is de-duplicated to silence.
    const first = project.text(await project.run(limitedRead("s-tiny")));
    expect(first.startsWith("MEX: ")).toBe(true);
    expect(project.text(await project.run(limitedRead("s-tiny")))).toBe("");
    expect(project.text(await project.run(limitedRead("s-tiny-2"))).startsWith("MEX: ")).toBe(true);
  });
});
