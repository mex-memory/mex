import { describe, expect, it } from "vitest";
import { entry } from "./fixtures.js";
import type { KnowledgeEntry } from "../entry.js";
import { areaOf, isBroad, learnedSupport, MAX_LEARNED_ALWAYS_ON_TOKENS, nativeRuleText, selectNative, type Candidate } from "../native-select.js";

const team = (e: KnowledgeEntry): Candidate => ({ level: "team", entry: e });
const pr = (n: number) => `https://github.com/acme/app/pull/${n}`;
const hash = `sha256:${"0".repeat(64)}`;
/** A learned entry whose rendered bullet occupies exactly `tokens` estimated tokens. */
function learned(id: string, pulls: number[], tokens = 10, over: Partial<KnowledgeEntry["mex"]> = {}): KnowledgeEntry {
  const checks = pulls.map(n => ({ kind: "source", role: "supporting", files: {}, target: { url: `${pr(n)}#discussion_r${n}` },
    saw: { hash } })) as KnowledgeEntry["mex"]["checks"];
  const text = "x".repeat(tokens * 4 - `-  <!-- mex:${id} -->\n`.length);
  return entry(id, { source: { type: "review", ref: pulls.length ? pr(pulls[0]!) : "https://example.com/x", producer: "learn-deeper" },
    evidence: "review", checks, ...over }, text);
}
const held = (...ids: string[]) => new Map(ids.map(id => [`team/${id}`, "held" as const]));
const quote: KnowledgeEntry["mex"]["checks"][number] = { kind: "quote", role: "complete", files: {}, saw: { hash },
  target: { file: "CONTRIBUTING.md", exact: "Always use the stable branch for release fixes.", prefix: "", suffix: "" } };
const docs: Partial<KnowledgeEntry["mex"]> = {
  source: { type: "docs", ref: "CONTRIBUTING.md", producer: "learn-deeper" }, evidence: "docs", checks: [quote],
};
const fixture: KnowledgeEntry["mex"]["checks"][number] = {
  kind: "fixture", role: "complete", files: {}, saw: { ok: true },
  target: { proves: [0], pairs: [{ path: "src/api.ts", commit: "a".repeat(40),
    before: { start: 1, end: 1, text: "oldApi()", hash }, after: { start: 1, end: 1, text: "newApi()", hash } }] },
};

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

  it("leaves learned file globs and mixed folder and file scopes to scoped delivery", () => {
    const ids = ["mx_deeparea", "mx_deepglob", "mx_deepmix"];
    const { selected, skipped } = selectNative([
      team(learned(ids[0]!, [1], 10, { scope: ["src/**"] })),
      team(learned(ids[1]!, [1], 10, { scope: ["src/{api,web}/**"] })),
      team(learned(ids[2]!, [1], 10, { scope: ["src/**", "tests/api.ts"] })),
    ], held(...ids));
    expect(selected.map(c => c.entry.mex.id)).toEqual([ids[0]]);
    expect(skipped.map(item => item.id)).toEqual(ids.slice(1));
  });

  describe("always-on budget for learned repo-wide entries", () => {
    it("counts distinct pull requests across the ref and source checks", () => {
      const reviewed = learned("mx_deepa1", [1, 2, 2, 3], 10, {
        source: { type: "review", ref: "https://github.com/ACME/APP/pull/1/files?change=1", producer: "learn-deeper" },
      });
      reviewed.mex.checks.push({ kind: "source", role: "supporting", files: {}, target: { url: `${pr(4)}-extra` }, saw: { hash } });
      expect(learnedSupport(reviewed)).toBe(3);
    });

    it.each([docs, { checks: [quote] }])("ranks held explicit policy, repeated reviews and a proven pattern", quoted => {
      const entries = [
        learned("mx_deepsingle", [1], 150),
        learned("mx_deepweakdoc", [], 150, { ...docs, checks: [{ ...quote, role: "supporting" }] }),
        learned("mx_deepproof", [], 150, { checks: [fixture] }),
        learned("mx_deeprepeat", [2, 3], 150),
        learned("mx_deepdocs", [], 150, { kind: "procedure", ...quoted }),
        learned("mx_deepstale", [], 150, docs),
      ].map(team);
      const verdicts = held(...entries.map(c => c.entry.mex.id));
      const { selected, skipped } = selectNative(entries, new Map([...verdicts, ["team/mx_deepstale", "changed"]]));
      expect(selected.map(c => c.entry.mex.id)).toEqual(["mx_deepdocs", "mx_deepproof", "mx_deeprepeat"]);
      expect(skipped.map(s => s.id)).toEqual(["mx_deepstale", "mx_deepsingle", "mx_deepweakdoc"]);
    });

    it("breaks evidence ties with distinct PRs, then kind and id", () => {
      const entries = [
        learned("mx_deepcc1", [2, 3], 150, { kind: "decision" }),
        learned("mx_deeprcp", [2, 3], 150, { kind: "recipe" }),
        learned("mx_deepbb1", [2, 3], 150, { kind: "decision" }),
        learned("mx_deepzz1", [1, 2, 3], 150, { kind: "procedure" }),
        learned("mx_deepaa1", [3, 4], 150, { kind: "decision" }),
        learned("mx_deeprul", [3, 4], 150),
      ].map(team);
      const verdicts = held(...entries.map(c => c.entry.mex.id));
      const selection = selectNative(entries, verdicts);
      expect(selection.selected.map(c => c.entry.mex.id)).toEqual(["mx_deepaa1", "mx_deeprul", "mx_deepzz1"]);
      expect(selectNative([...entries].reverse(), verdicts)).toEqual(selection);
    });

    it("charges complete rendered lines in UTF-8 bytes and tries later rules when one won't fit", () => {
      const unicode = learned("mx_deepwide", [1, 2], 150);
      unicode.text = "界".repeat(200); // 600 bytes before the bullet, id and newline.
      unicode.mex.one_line = unicode.text;
      const entries = [
        learned("mx_deepbig1", [1, 2, 3], 150),
        learned("mx_deepbig2", [7, 8, 9], 150),
        unicode,
        learned("mx_deepfit1", [6], 150),
      ].map(team);
      const { selected, skipped } = selectNative(entries, held(...entries.map(c => c.entry.mex.id)));
      expect(selected.map(c => c.entry.mex.id)).toEqual(["mx_deepbig1", "mx_deepbig2", "mx_deepfit1"]);
      expect(skipped).toEqual([{ id: "mx_deepwide", reason: "over the always-on budget for learned rules; available through recall" }]);
      expect(MAX_LEARNED_ALWAYS_ON_TOKENS).toBe(450);
    });

    it("uses the body when a saved one-line claim could leave off a condition", () => {
      const body = "Use the stable branch for fixes only after the freeze.";
      const rule = learned("mx_deeplegacy", [1]);
      rule.text = body;
      rule.mex.one_line = "Use the stable branch";
      expect(nativeRuleText(rule)).toBe(body);
      rule.mex.one_line = "Use the development branch for fixes.";
      expect(nativeRuleText(rule)).toBe(body);
    });

    it("shares one budget across team and personal levels", () => {
      const { selected, skipped } = selectNative([
        team(learned("mx_deepteam1", [1, 2], 150)),
        team(learned("mx_deepteam2", [1, 2], 150)),
        { level: "personal", entry: learned("mx_deepmine1", [3], 150) },
        { level: "personal", entry: learned("mx_deepmine2", [4], 150) },
      ], new Map([...held("mx_deepteam1", "mx_deepteam2"), ["personal/mx_deepmine1", "held"], ["personal/mx_deepmine2", "held"]]));
      expect(selected.map(c => c.entry.mex.id)).toEqual(["mx_deepmine1", "mx_deepteam1", "mx_deepteam2"]);
      expect(skipped.map(s => s.id)).toEqual(["mx_deepmine2"]);
    });

    it("leaves human entries and learned area entries alone", () => {
      const ids = ["mx_deepfull1", "mx_deepfull2", "mx_deepfull3", "mx_deeparea1"];
      const { selected, skipped } = selectNative([
        team(learned("mx_deepfull1", [1], 150)),
        team(learned("mx_deepfull2", [2], 150)),
        team(learned("mx_deepfull3", [3], 150)),
        team(learned("mx_deeparea1", [2], 140, { scope: ["src/**"] })),
        team(entry("mx_human01", {}, "y".repeat(560))),
        team(entry("mx_human02", { scope: ["src/**"] }, "z".repeat(560))),
      ], held(...ids));
      expect(selected.map(c => c.entry.mex.id)).toEqual(["mx_deeparea1", "mx_deepfull1", "mx_deepfull2", "mx_deepfull3", "mx_human01", "mx_human02"]);
      expect(skipped).toEqual([]);
    });
  });
});
