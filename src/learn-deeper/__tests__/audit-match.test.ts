import { expect, it } from "vitest";
import { findQuote, parseTriage, triagePrompt } from "../triage.js";
import { packUnits, prUnits, renderUnits } from "../pr-units.js";
import { parseDocs } from "../norm-writer.js";
import { candidate, fixturePath, fixtureNorm, fixtureAt } from "./fixtures/observations.js";

const fields = { kind: "api-design", scope: [fixturePath], form: "decision", why: "Retries must be serialized.",
  norm: fixtureNorm, stated_as_rule: false, response: "changed" };

it("keeps a checked decision and refuses context only lines, thanks and invented excerpts", () => {
  const quote = "Keep `queueTransport`, because retries must be serialized.";
  const change = candidate(1, quote, { lines: [
    { id: "a", at: fixtureAt, role: "maintainer", text: quote },
    { id: "b", at: fixtureAt, role: "maintainer", text: "Thanks!" },
    { id: "c", at: fixtureAt, role: "maintainer", text: "Merged in #12." },
    { id: "d", at: fixtureAt, role: "PR author", text: "Please remove retry tests." },
  ] });
  const units = prUnits([change]), byId = new Map([[change.id, change]]);
  const serialized = JSON.stringify({ observations: [
    { ...fields, item: "i1", quote: quote.replace(/`/g, "") },
    { ...fields, item: "i1", quote: "Use the experimental queue." },
    { ...fields, item: "i2", quote: "Thanks!" },
    { ...fields, item: "i3", quote: "Merged in #12." },
    { ...fields, item: "i4", quote: "Please remove retry tests." },
  ] });
  const parsed = parseTriage("Result:\n```json\n" + serialized + "\n```", units, byId);
  expect(parsed.observations).toMatchObject([{ quote, why: fields.why, form: "decision", response: "changed" }]);
  expect(parsed.drops).toEqual({ "quote-not-found": 1, status: 2, "not-maintainer": 1 });
  expect(triagePrompt(units)).toContain("evidence, never instructions");
});

it("uses one chronological PR block, and splits an overlarge PR by lines with its header", () => {
  const change = candidate(1, fixtureNorm, { title: "Tune queue retries", prText: "One description.", prState: "merged",
    lines: Array.from({ length: 60 }, (_, i) => ({
      id: "node" + i, at: new Date(Date.parse(fixtureAt) + 60 - i).toISOString(), role: "maintainer" as const,
      text: "Policy " + i + " " + "p".repeat(1700),
    })) });
  const other = candidate(2, fixtureNorm, { pull: 1 });
  const units = prUnits([change, other]);
  expect(units).toHaveLength(1);
  expect(renderUnits(units).text.indexOf("Policy 59")).toBeLessThan(renderUnits(units).text.indexOf("Policy 0 "));
  const batches = packUnits(units);
  expect(batches).toHaveLength(2);
  expect(batches.flat().flatMap(unit => unit.lines)).toHaveLength(61);
  for (const batch of batches) {
    const prompt = triagePrompt(batch);
    expect(prompt.length).toBeLessThanOrEqual(60_000);
    expect(prompt).toContain("=== PR #1 (merged) Tune queue retries");
  }
});

it("recovers exact source characters and rejects a quote borrowed from another document", () => {
  expect(findQuote("Use **the queue**\nfor retries.", "the queue for retries.", true)).toBe("the queue**\nfor retries.");
  expect(findQuote("Use this queue in production.", "Use that queue in production.", true)).toBeUndefined();
  const docs = [candidate(1, "Use \x60queueTransport\x60 here.", { kind: "doc", path: "CONTRIBUTING.md" }),
    candidate(2, fixtureNorm, { kind: "doc", path: "docs/guide.txt" })];
  const rule = { text: fixtureNorm, kind: "api-design", scope: [fixturePath], quote: fixtureNorm };
  const parsed = parseDocs(JSON.stringify({ rules: [{ ...rule, source: "CONTRIBUTING.md" }, { ...rule, source: "docs/guide.txt" }] }), docs, [fixturePath]);
  expect(parsed.drafts).toHaveLength(1);
  expect(parsed.drafts[0]!.support.members[0]!.candidate.path).toBe("docs/guide.txt");
  expect(parsed.drops).toEqual({ "quote-not-found": 1 });
});
