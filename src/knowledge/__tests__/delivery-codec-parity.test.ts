import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEntry, serializeEntry } from "../entry.js";

import { entryLabel } from "../labels.js";

const fixtures = JSON.parse(readFileSync(new URL("../../../native/delivery/entries/testdata/codec.json", import.meta.url), "utf8")) as Array<{name: string; accept: boolean; content: string; expectedSaw?: unknown}>;
describe("delivery codec shared fixtures", () => {
  for (const fixture of fixtures) it(fixture.name, () => {
    let accepted = true;
    try {
      const entry = parseEntry(fixture.content);
      if (fixture.expectedSaw) expect(entry.mex.checks[0].saw).toEqual(fixture.expectedSaw);
    } catch { accepted = false; }
    expect(accepted).toBe(fixture.accept);
  });
});

it("serializes the producer metadata fixture for the native codec", () => {
  const raw = readFileSync(new URL("../../../native/delivery/entries/testdata/producer.md", import.meta.url), "utf8").replace(/\r\n/gu, "\n");
  const entry = parseEntry(raw);
  expect(serializeEntry(entry)).toBe(raw);
  expect(entry.mex.source).toMatchObject({ producer: "code-facts", model: { id: "fixture", version: "1" } });
  expect(entryLabel(entry, "personal")).toBe("[mined from code, 9 of 10 sites]");
});
