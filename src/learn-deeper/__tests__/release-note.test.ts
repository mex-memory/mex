import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("describes beta.2 and says real-agent metrics wait for an independent blocker check", () => {
  const notes = readFileSync(new URL("../../../RELEASE_NOTES.md", import.meta.url), "utf8");
  expect(notes).toContain("# MEX 0.9.0-beta.2");
  expect(notes).toContain("The audit's blockers have to be confirmed on their own before real-agent metrics are read as a result of this release.");
});
