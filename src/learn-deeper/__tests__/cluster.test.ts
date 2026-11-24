import { expect, it } from "vitest";
import { parseNorms, packObservations, normPrompt } from "../norm-writer.js";
import { observation, fixtureNorm, fixturePath } from "./fixtures/observations.js";

const norm = { text: fixtureNorm, kind: "api-design", scope: [fixturePath], patternable: false };
const parse = (items: ReturnType<typeof observation>[], support = items.map(item => item.id), extra = {}) =>
  parseNorms(JSON.stringify({ policies: [], norms: [{ ...norm, support, ...extra }] }), items, [], new Map(), [fixturePath]);

it("combines repeated decisions across distinct PRs and counts each PR only once", () => {
  const first = observation(1, { form: "decision", why: "Queue ordering.", stated_as_rule: false });
  const second = observation(2, { form: "decision", why: "Ordering must not change.", stated_as_rule: false });
  const samePull = observation(3, { pull: 2, stated_as_rule: false });
  const { drafts } = parse([first, second, samePull], [first.id, second.id, second.id, samePull.id]);
  expect(drafts).toHaveLength(1);
  expect(drafts[0]!.support).toMatchObject({ support: 2, pulls: [1, 2] });
  expect(drafts[0]!.entry.clauses[0]!.quotes).toHaveLength(3);
});

it("accepts an undisputed general rule and rejects a single PR with a one-off decision", () => {
  expect(parse([observation(1)]).drafts).toHaveLength(1);
  expect(parse([observation(1, { stated_as_rule: false })]).drops).toEqual({ support: 1 });
  expect(parse([observation(1, { response: "disputed" })]).drops).toEqual({ support: 1 });
});

it("refuses unsupported ids, generic wording, unknown scope and later disputed evidence", () => {
  const one = observation(1);
  expect(parse([one], [one.id, "made-up"]).drops).toEqual({ "unknown-support": 1 });
  expect(parse([one], [one.id], { text: "Keep code clear and validate input." }).drops).toEqual({ unnamed: 1 });
  expect(parse([one], [one.id], { scope: ["other/**"] }).drops).toEqual({ "invalid-claim-or-scope": 1 });
  const later = observation(2, { at: "2026-11-16T00:00:00.000Z", response: "disputed" });
  expect(parse([later, one]).drops).toEqual({ support: 1 });
});

it("sorts the writer's observations and splits a large input by related kinds", () => {
  const recent = observation(1, { at: "2026-11-17T00:00:00.000Z" });
  const past = observation(2, { at: "2026-11-16T00:00:00.000Z" });
  const prompt = normPrompt([recent, past], [{ id: "existing", claim: fixtureNorm }]);
  expect(prompt.indexOf(past.id)).toBeLessThan(prompt.indexOf(recent.id));
  expect(prompt).toContain("Work in two steps");
  expect(prompt).toContain('"id":"existing"');
  const group = Array.from({ length: 150 }, (_, i) => observation(i + 1, {
    why: "x".repeat(400), kind: i % 2 ? "api-design" : "tests",
  }));
  const batches = packObservations(group, []);
  expect(batches.length).toBeGreaterThanOrEqual(2);
  expect(batches.flat()).toHaveLength(group.length);
  expect(batches.every(batch => new Set(batch.map(item => item.kind)).size === 1)).toBe(true);
});
