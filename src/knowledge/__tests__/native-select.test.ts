import { describe, expect, it } from "vitest";
import type { KnowledgeEntry } from "../entry.js";
import { areaOf, isBroad, selectNative, type Candidate } from "../native-select.js";

export function entry(id: string, over: Partial<KnowledgeEntry["mex"]> = {}, text = "Use date-fns, because moment is unmaintained."): KnowledgeEntry {
  return {
    mex: { id, kind: "rule", scope: ["**"], source: { type: "person", ref: "mex note 2026-11-15", quote: text }, evidence: "person", one_line: text, checks: [], status: "active", created: "2026-11-15", ...over },
    text,
  };
}
const team = (e: KnowledgeEntry): Candidate => ({ level: "team", entry: e });

describe("layer A selection", () => {
  it("knows an area from a file pattern", () => {
    expect(isBroad("**")).toBe(true);
    expect(isBroad("apps/api/**")).toBe(true);
    expect(isBroad("src/**/*.ts")).toBe(false);
    expect(isBroad("src/index.ts")).toBe(false);
    expect(areaOf("apps/api/**")).toBe("apps/api");
    expect(areaOf("**")).toBe("");
  });

  it("keeps only broad, strong, stable entries", () => {
    const { selected, skipped } = selectNative([
      team(entry("mx_good01")),
      team(entry("mx_fact01", { kind: "fact" })),
      team(entry("mx_mine01", { evidence: "mined", source: { type: "mined", ref: "git" } })),
      team(entry("mx_file01", { scope: ["src/**/*.ts"] })),
      team(entry("mx_rule01", { source: { type: "rule-file", ref: "CLAUDE.md" }, evidence: "docs" })),
      team(entry("mx_brok01")),
      team(entry("mx_chng01")),
      team(entry("mx_long01", {}, "x".repeat(700))),
      team(entry("mx_gone01", { status: "retired", retired: { reason: "old", by: "me", at: "2026-11-15" } })),
    ], new Map([["mx_brok01", "broken"], ["mx_chng01", "changed"], ["mx_good01", "held"]]));
    expect(selected.map(c => c.entry.mex.id)).toEqual(["mx_good01"]);
    expect(Object.fromEntries(skipped.map(s => [s.id, s.reason]))).toEqual({
      mx_fact01: "a fact isn't loaded every session", mx_mine01: "evidence too weak", mx_file01: "scoped to files, not an area",
      mx_rule01: "already in a rule file", mx_brok01: "verdict is broken", mx_chng01: "verdict is changed",
      mx_long01: "too long for a rule file", mx_gone01: "retired",
    });
  });
});
