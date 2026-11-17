import { describe, expect, it } from "vitest";
import { ENTRY_KINDS } from "../../knowledge/entry.js";
import { filterPrompt } from "../job.js";

describe("filter response instructions", () => {
  it("gives the complete entry-kind contract separately from lifetime labels and check kinds", () => {
    const prompt = filterPrompt({ messages: [], notes: [], files: [], delivered_notes: [] });
    const kinds = prompt.match(/Allowed entry kinds for kind: ([^.]+)\./u)?.[1]?.split(", ");
    expect(kinds).toEqual([...ENTRY_KINDS]);
    expect(prompt).toContain("Use one of these for every item, regardless of label.");
    expect(prompt).toContain("label describes its lifetime");
    expect(prompt).toContain("checks[].kind uses the separate check kinds listed below");
    expect(prompt).toContain("Allowed check kinds: key, command, section, source, value, symbol, pattern, relation.");
  });
});
