/**
 * Setup population asks for one code-linked claim per entity, grounded to
 * every symbol the claim depends on, and GROW asks the same of new claims.
 * Coarse entities flag every claim they hold when any grounded symbol
 * changes; single-symbol grounding misses drift in the symbols a claim relies
 * on without citing.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildExistingNoBriefPrompt, buildExistingWithBriefPrompt } from "../src/setup/prompts.js";

describe("population guidance for code-linked claims", () => {
  for (const [name, prompt] of [
    ["with brief", buildExistingWithBriefPrompt("{}")],
    ["without brief", buildExistingNoBriefPrompt()],
  ] as const) {
    it(`asks for one entity per code-linked claim (${name})`, () => {
      expect(prompt).toContain("One code-linked claim per entity");
      expect(prompt).toContain('"type": "create-entry"');
      expect(prompt).toContain("mex wiki apply .mex/local/setup-ops/<subsystem>.json --apply");
    });

    it(`asks to ground every symbol a claim depends on (${name})`, () => {
      expect(prompt).toContain("Ground a claim to every symbol whose change could make it false");
    });

    it(`leaves structural links to MEX instead of asking the agent to wire them (${name})`, () => {
      expect(prompt).not.toContain("link-sections");
      expect(prompt).toContain("MEX links each fact to its file");
      expect(prompt).toContain("Never invent connections");
    });
  }

  it("carries the same rule into GROW", () => {
    const router = readFileSync(new URL("../templates/ROUTER.md", import.meta.url), "utf8");
    expect(router).toContain("grounded to every symbol whose change could make it false");
    expect(router).toContain("mex wiki link-sections");
  });
});
