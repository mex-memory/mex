import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSetupPopulationPrompt } from "../phases.js";

const roots: string[] = [];
function project(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "mex-population-plan-"));
  roots.push(root);
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "export {};\n");
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sources = [
  ...Array.from({ length: 6 }, (_, i) => `src/billing/b${i}.ts`),
  ...Array.from({ length: 4 }, (_, i) => `src/search/s${i}.ts`),
  ...Array.from({ length: 3 }, (_, i) => `src/auth/a${i}.ts`),
];

describe("buildSetupPopulationPrompt coverage target", () => {
  it("embeds candidates from the project for an existing project, with or without a brief", async () => {
    const root = project(sources);
    for (const brief of ["{}", null]) {
      const prompt = await buildSetupPopulationPrompt("code-repo", "existing", brief, root);
      expect(prompt).toContain("src/billing/ — 6 files, 10 to 15 facts");
      expect(prompt).toContain("src/search/ — 4 files, 6 to 10 facts");
      expect(prompt).toContain("3 subsystems");
      expect(prompt).toContain("MEX has fixed the plan below");
    }
  });

  it("falls back to the size rule when no project root is given or nothing can be ranked", async () => {
    const root = project(["README.md"]);
    for (const projectRoot of [undefined, root]) {
      const prompt = await buildSetupPopulationPrompt("code-repo", "existing", "{}", projectRoot);
      expect(prompt).toContain("Choose the major subsystems yourself");
    }
  });

  it("adds no coverage target to fresh or agent-memory prompts", async () => {
    const root = project(sources);
    expect(await buildSetupPopulationPrompt("code-repo", "fresh", null, root)).not.toContain("COVERAGE");
    expect(await buildSetupPopulationPrompt("agent-memory", "existing", "{}", root)).not.toContain("COVERAGE");
  });
});
