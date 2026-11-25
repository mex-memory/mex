import { describe, expect, it } from "vitest";
import { entry } from "./fixtures.js";
import type { KnowledgeEntry } from "../entry.js";
import { areaOf, isBroad, learnedSupport, MAX_LEARNED_ALWAYS_ON_TOKENS, selectNative, type Candidate } from "../native-select.js";

const team = (e: KnowledgeEntry): Candidate => ({ level: "team", entry: e });
const pr = (n: number) => `https://github.com/acme/app/pull/${n}`;
/** A learned repo-wide entry cited by the given pull requests, with text of `tokens` tokens. */
function learned(id: string, pulls: number[], tokens = 10, over: Partial<KnowledgeEntry["mex"]> = {}): KnowledgeEntry {
  const checks = pulls.map(n => ({ kind: "source", role: "supporting", files: {}, target: { url: `${pr(n)}#discussion_r${n}` },
    saw: { hash: `sha256:${"0".repeat(64)}` } })) as KnowledgeEntry["mex"]["checks"];
  return entry(id, { source: { type: "review", ref: pulls.length ? pr(pulls[0]!) : "https://example.com/x", producer: "learn-deeper" },
    evidence: "review", checks, ...over }, "x".repeat(tokens * 4));
}
const held = (...ids: string[]) => new Map(ids.map(id => [`team/${id}`, "held" as const]));

describe("layer A selection", () => {
  it("knows an area from a file pattern", () => {
    expect(isBroad("**")).toBe(true);
    expect(isBroad("apps/api/**")).toBe(true);
    expect(isBroad("src/**/*.ts")).toBe(false);
    expect(isBroad("src/index.ts")).toBe(false);
    expect(areaOf("apps/api/**")).toBe("apps/api");
    expect(areaOf("apps\\api\\**")).toBe("apps/api");
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
    ], new Map([["team/mx_brok01", "broken"], ["team/mx_chng01", "changed"], ["team/mx_good01", "held"]]));
    expect(selected.map(c => c.entry.mex.id)).toEqual(["mx_good01"]);
    expect(Object.fromEntries(skipped.map(s => [s.id, s.reason]))).toEqual({
      mx_fact01: "a fact isn't loaded every session", mx_mine01: "evidence too weak", mx_file01: "scoped to files, not an area",
      mx_rule01: "already in a rule file", mx_brok01: "verdict is broken", mx_chng01: "verdict is changed",
      mx_long01: "too long for a rule file", mx_gone01: "retired",
    });
  });

  describe("always-on budget for learned repo-wide entries", () => {
    it("counts distinct pull requests, and none for a docs lesson", () => {
      expect(learnedSupport(learned("mx_deepa1", [1, 2, 2, 3]))).toBe(3);
      expect(learnedSupport(learned("mx_deepa2", [4], 10, { source: { type: "docs", ref: "docs/a.md", producer: "learn-deeper" }, evidence: "docs" }))).toBe(0);
    });

    it("ranks by support, then kind, then id", () => {
      const ids = ["mx_deepzz1", "mx_deepaa1", "mx_deepbb1", "mx_deepcc1", "mx_deepdd1"];
      const many = learned("mx_deepzz1", [1, 2, 3], 80);
      const ruleA = learned("mx_deepaa1", [4], 80, { kind: "procedure" });
      const ruleB = learned("mx_deepbb1", [5], 80, { kind: "decision" });
      const ruleC = learned("mx_deepcc1", [6], 80, { kind: "decision" });
      const docs = learned("mx_deepdd1", [], 10, { source: { type: "docs", ref: "docs/a.md", producer: "learn-deeper" }, evidence: "docs" });
      const { selected, skipped } = selectNative([ruleA, ruleB, docs, ruleC, many].map(team), held(...ids));
      // 80 + 80 + 80 = 240 fits; the procedure (80) would make 320, so it and everything after it are cut.
      expect(selected.map(c => c.entry.mex.id)).toEqual(["mx_deepbb1", "mx_deepcc1", "mx_deepzz1"]);
      expect(skipped.map(s => s.id)).toEqual(["mx_deepaa1", "mx_deepdd1"]);
    });

    it("cuts at the budget and stops at the first entry that does not fit", () => {
      const ids = ["mx_deepbig1", "mx_deepbig2", "mx_deepmid1", "mx_deepsml1"];
      const { selected, skipped } = selectNative([
        team(learned("mx_deepbig1", [1, 2, 3], 150)),
        team(learned("mx_deepbig2", [7, 8, 9], 100)),
        team(learned("mx_deepmid1", [4, 5], 60)),
        team(learned("mx_deepsml1", [6], 5)),
      ], held(...ids));
      // 150 + 100 = 250; 60 more would be 310, so it is cut, and so is the 5 that would still fit.
      expect(selected.map(c => c.entry.mex.id)).toEqual(["mx_deepbig1", "mx_deepbig2"]);
      expect(skipped).toEqual([
        { id: "mx_deepmid1", reason: "over the always-on budget for learned rules; available through recall" },
        { id: "mx_deepsml1", reason: "over the always-on budget for learned rules; available through recall" },
      ]);
      const exact = selectNative([team(learned("mx_deepfit1", [1], 150)), team(learned("mx_deepfit2", [1], 150))], held("mx_deepfit1", "mx_deepfit2"));
      expect(exact.selected).toHaveLength(2);
      expect(MAX_LEARNED_ALWAYS_ON_TOKENS).toBe(300);
    });

    it("shares one budget across team and personal levels", () => {
      const { selected, skipped } = selectNative([
        team(learned("mx_deepteam1", [1, 2], 150)),
        { level: "personal", entry: learned("mx_deepmine1", [3], 100) },
        { level: "personal", entry: learned("mx_deepmine2", [4], 100) },
      ], new Map([["team/mx_deepteam1", "held"], ["personal/mx_deepmine1", "held"], ["personal/mx_deepmine2", "held"]]));
      expect(selected.map(c => c.entry.mex.id)).toEqual(["mx_deepmine1", "mx_deepteam1"]);
      expect(skipped.map(s => s.id)).toEqual(["mx_deepmine2"]);
    });

    it("leaves human entries and learned area entries alone", () => {
      const ids = ["mx_deepfull1", "mx_deepfull2", "mx_deeparea1"];
      const { selected, skipped } = selectNative([
        team(learned("mx_deepfull1", [1], 150)),
        team(learned("mx_deepfull2", [2], 150)),
        team(learned("mx_deeparea1", [2], 140, { scope: ["src/**"] })),
        team(entry("mx_human01", {}, "y".repeat(560))),
        team(entry("mx_human02", { scope: ["src/**"] }, "z".repeat(560))),
      ], held(...ids));
      expect(selected.map(c => c.entry.mex.id)).toEqual(["mx_deeparea1", "mx_deepfull1", "mx_deepfull2", "mx_human01", "mx_human02"]);
      expect(skipped).toEqual([]);
    });
  });
});
