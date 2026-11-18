import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEntry } from "../entry.js";

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
