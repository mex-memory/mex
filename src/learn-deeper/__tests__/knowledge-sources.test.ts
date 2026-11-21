import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { duplicateMatcher } from "../existing-knowledge.js";
import { branchScope, staleDoc } from "../history-docs.js";

function fixture(path: string) {
  return readFileSync(new URL("./fixtures/" + path, import.meta.url), "utf8");
}

const corpus = duplicateMatcher([fixture("oss67-mex-knowledge.md")]);
const priorRules: { id: string; text: string; oneLine: string; duplicate: boolean }[] =
  JSON.parse(fixture("oss67-mex-rules.json"));

it.each(priorRules)("checks prior mex rule $id against the knowledge present at the time", ({ text, oneLine, duplicate }) => {
  expect(corpus(text, oneLine)).toBe(duplicate);
});

it("keeps changed values and explicit reversals of existing instructions", () => {
  const existing = "Enable the worker's automatic requeue feature when an offline checkout reconnects. Save the pending job and retry after 30 seconds.";
  const repeats = duplicateMatcher([existing]);
  const reversed = existing.replace("Enable", "Never enable");
  expect(repeats(existing, "Enable automatic requeue when an offline checkout reconnects.")).toBe(true);
  expect(repeats(existing.replace("30 seconds", "60 seconds"), "Retry the pending job after 60 seconds.")).toBe(false);
  expect(repeats(reversed, "Never enable the worker's automatic requeue feature.")).toBe(false);
  expect(duplicateMatcher([reversed])(existing, "Enable the worker's automatic requeue feature.")).toBe(false);
});

const current = branchScope("> **0.9 build**\n> This branch is the 0.9 rebuild; `main` stays on 0.8 for fixes.");

it("recognizes release snapshots, declared status, and explicit scope conflicts", () => {
  expect(staleDoc("docs/design/0.8.4-release-plan.md", "", current)).toBe("release-plan");
  expect(staleDoc("docs/release-plan-2026-01-03.md", "", current)).toBe("release-plan");
  expect(staleDoc("docs/archive.md", "---\nstatus: \"historical\"\n---\n# Design", current)).toBe("explicit-status");
  expect(staleDoc("docs/adr.md", "# Old layout\n\n**Status:** Superseded by ADR 9.", current)).toBe("explicit-status");
  expect(staleDoc("docs/frozen.md", "# Threading plan (frozen)\n\nSome advice.", current)).toBe("explicit-status");
  expect(staleDoc("docs/extractors.md", "These interfaces are frozen for the 0.7.x contributor program. Contributions target `main`.", current)).toBe("version-scope");
  expect(staleDoc("docs/old-contributing.md", "Contributions target `main`.", current)).toBe("branch-scope");
});

it("keeps current guidance with dates, earlier-version references, or no declared scope", () => {
  expect(staleDoc("docs/migration.md", "# Guide\n\nMigrates from v0.7.0. Older benchmarks are historical.\n\n```yaml\nstatus: archived\n```", current)).toBeUndefined();
  expect(staleDoc("docs/extractors.md", "These interfaces are frozen for the 0.9.x contributor program.", current)).toBeUndefined();
  expect(staleDoc("docs/design/model-budget.md", "# Model allowance\n\nExplicit user commands join the same lane and remain uncapped.", current)).toBeUndefined();
  expect(staleDoc("docs/guide.md", "Contributions target `main`.", branchScope(undefined))).toBeUndefined();
});
