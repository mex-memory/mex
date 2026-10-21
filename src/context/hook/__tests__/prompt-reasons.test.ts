import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupProjects } from "../../__tests__/fixture.js";
import { loadEmbedder } from "../../semantic.js";
import { handlePrompt } from "../prompt.js";
import { HOOK_LOG_NAME } from "../run.js";
import { createHookProject, promptPayload } from "./fixture.js";

vi.mock("../../semantic.js", () => ({
  semanticStatus: () => ({ state: "installed" }),
  loadEmbedder: vi.fn(() => { throw new Error("Unexpected model load"); }),
}));
afterEach(() => { cleanupProjects(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("logs the knowledge abstention alongside the identifier tier", async () => {
  const p = await createHookProject();
  await p.run(promptPayload("reasons", "Locate buildReport"));
  const log = JSON.parse(readFileSync(join(p.fx.context.localDir, HOOK_LOG_NAME), "utf8").trim());
  expect(log.note).toMatch(/^graph-identifier; knowledge:(below-floor|uncorroborated|no-match|weak-margin)$/);
});

it("does not load the model for a long prompt without lexical matches", async () => {
  const p = await createHookProject();
  const outcome = await handlePrompt(p.fx.context, Array(50).fill("zzzzzz").join(" "), null, { lexical: false });
  expect(outcome.text).toBe("");
  expect(loadEmbedder).not.toHaveBeenCalled();
});
