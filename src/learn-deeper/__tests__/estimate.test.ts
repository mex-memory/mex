import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { PinnedTree } from "../git.js";
import { estimateCensus, type Census } from "../harvest/estimate.js";
import { harvestBatch, previewHarvest, type HarvestPlan } from "../harvest/index.js";
import { quoteCeiling } from "../plan.js";

// Successful Codex backfills from the two recorded evaluations. Usage includes
// input, output and cache tokens for the learning calls.
const runs: { repo: string; real: number; oldEstimate: number; census: Census }[] =
  JSON.parse(readFileSync(new URL("fixtures/harvest/recorded-spend.json", import.meta.url), "utf8"));

it("forecasts recorded Codex spend while retaining the original hard ceilings", () => {
  expect(runs).toHaveLength(18);
  const ratios = runs.map(({ repo, real, oldEstimate, census }) => {
    const { total, ceiling } = estimateCensus(census, "codex");
    const ratio = real / total;
    expect(ratio, repo).toBeGreaterThanOrEqual(0.6);
    expect(ratio, repo).toBeLessThanOrEqual(1.4);
    expect(real * 1.2, repo).toBeLessThanOrEqual(ceiling);
    expect(ceiling, repo).toBe(quoteCeiling(oldEstimate));
    return ratio;
  }).sort((a, b) => a - b);
  const middle = ratios.length / 2;
  const median = (ratios[middle - 1]! + ratios[middle]!) / 2;
  expect(median).toBeGreaterThanOrEqual(0.85);
  expect(median).toBeLessThanOrEqual(1.15);
});

it("harvests the same candidates when the budget binds under the calibrated Codex quote", async () => {
  const checkout = process.cwd(), head = "a".repeat(40), at = "2026-01-02T00:00:00.000Z";
  const adr = "docs/adr/001.md", doc = "CONTRIBUTING.md";
  const bodies = new Map([
    [adr, "# Adapter\n\n## Considered options\n\nA second transport adds a deployment boundary.\n\n## Decision\n\nKeep the in-process transport."],
    [doc, "# Development\n\nYou must run smoke tests.\n\n## Release\n\nYou must update the changelog."],
  ]);
  const tree = new PinnedTree(checkout, head, new Map([[adr, head], [doc, head]]));
  vi.spyOn(tree, "read").mockImplementation(async path => bodies.get(path));
  const originalQuote = { estimate: 49_688, ceiling: 74_532 };
  const plan: HarvestPlan = {
    checkout, head, defaultHead: head, id: "fixture", source: { host: "github.com", slug: "example/transport" },
    agent: "codex", since: "2026-01-01T00:00:00.000Z", until: at, mode: "backfill",
    budget: 92_000, requestBudget: 0, gaps: [], ...originalQuote,
    inventory: { bands: [], hotPaths: [], revertLinks: {}, local: { revert: [], cause: [], adr: [{ id: adr, at }], doc: [{ id: doc, at }] } },
  };
  const calibrated = await previewHarvest(plan, { tree });
  expect(calibrated.estimate).toBeLessThan(originalQuote.estimate);
  expect(calibrated.ceiling).toBe(originalQuote.ceiling);
  const before = await harvestBatch(plan, undefined, { tree });
  const after = await harvestBatch(calibrated, undefined, { tree });
  expect(before.done).toBe(true);
  expect(before.gaps).toContain("Learning reached its estimated token budget.");
  expect(before.candidates.map(candidate => candidate.id)).toEqual([`doc:${adr}#considered-options`, `doc:${adr}#decision`]);
  expect(after).toEqual(before);
});
