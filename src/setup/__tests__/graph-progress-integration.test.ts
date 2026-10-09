import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphMaintenanceProgress } from "../../team/contracts/graph.js";
import { runHeadlessSetup, type SetupProgressStep } from "../headless.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("real setup graph progress", () => {
  it("forwards isolated worker phases and file counts while the parent remains responsive", async () => {
    const root = fixture();
    const setupSteps: SetupProgressStep[] = [];
    const updates: GraphMaintenanceProgress[] = [];
    let parsing = false;
    let beatsDuringParsing = 0;
    const heartbeat = setInterval(() => { if (parsing) beatsDuringParsing++; }, 5);
    let result: Awaited<ReturnType<typeof runHeadlessSetup>>;
    try {
      result = await runHeadlessSetup({
        projectRoot: root, mode: "code-repo", tools: [], confirmPopulation: true,
        onProgress: ({ step }) => { setupSteps.push(step); },
        onGraphProgress: (update) => {
          expect(setupSteps.at(-1)).toBe("graph");
          updates.push(update);
          parsing = update.phase === "parse";
        },
      });
    } finally {
      clearInterval(heartbeat);
    }
    expect(result).toMatchObject({ mode: "code-repo", ready: false, stage: "needs_population" });
    expect(setupSteps.filter(step => step === "graph")).toHaveLength(1);
    expect(setupSteps.at(-1)).toBe("population");
    expect(updates.map(update => update.phase)).toEqual(expect.arrayContaining(["discover", "stage", "parse", "resolve", "validate", "publish"]));
    const parsed = updates.filter(update => update.phase === "parse");
    expect(parsed[0]).toMatchObject({ completed: 0, total: 3 });
    expect(parsed.at(-1)).toMatchObject({ completed: 3, total: 3 });
    expect(parsed.every((update, index) => index === 0 || update.completed! >= parsed[index - 1].completed!)).toBe(true);
    expect(beatsDuringParsing).toBeGreaterThan(0);
    expect(JSON.stringify(updates)).not.toContain(root);
    expect(JSON.stringify(updates)).not.toContain("private-calculation.ts");
    expect(existsSync(join(root, ".mex/graph.db"))).toBe(true);
    expect(existsSync(join(root, ".mex/wiki.db"))).toBe(false);
    expect(readdirSync(join(root, ".mex")).filter(name => name.includes("candidate") || name.endsWith(".lock"))).toEqual([]);
    expect(() => execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, stdio: "ignore" })).toThrow();
  });

  it("does not report graph work for agent-memory setup", async () => {
    const root = fixture();
    const updates: GraphMaintenanceProgress[] = [];
    await runHeadlessSetup({ projectRoot: root, mode: "agent-memory", tools: [], confirmPopulation: true,
      onGraphProgress: update => updates.push(update) });
    expect(updates).toEqual([]);
    expect(existsSync(join(root, ".mex/graph.db"))).toBe(false);
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-progress-"));
  roots.push(root);
  execFileSync("git", ["-c", "init.templateDir=", "init", "--quiet"], { cwd: root, stdio: "pipe" });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/private-calculation.ts"), "export function double(value: number): number { return value * 2; }\n");
  writeFileSync(join(root, "src/message.ts"), "export const prefix = 'Result';\n");
  writeFileSync(join(root, "src/index.ts"), "import { double } from './private-calculation';\nimport { prefix } from './message';\nexport const message = `${prefix}: ${double(21)}`;\n");
  return root;
}
