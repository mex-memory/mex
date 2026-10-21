import { describe, expect, it } from "vitest";
import { composePrompt } from "../compose.js";
import { RECIPES } from "../frozen.js";
import { buildRankIndex, gateCandidates, sharesGrounding, type RankedCandidate } from "../rank.js";
import { promptWindows } from "../windows.js";
import type { ContextEntity, ContextIndex } from "../types.js";

const entity = (id: string, code = ["src/a.ts"]): ContextEntity => ({
  id, code, type: "fact", title: "Invoice rounding", body: "Invoice totals round tax per line before summing the invoice total.",
  aliases: [], file: "facts.md", line: 1, level: 2,
  groundings: [{ node: `function:${code[0]}`, file: code[0]!, bodyHash: null }], symbols: [],
});
const indexOf = (entities: ContextEntity[]): ContextIndex => ({
  schemaVersion: 2, builtAt: "", projectWords: [], entities, vectors: {},
  inputs: { wiki: { files: [], digest: "" }, graph: { identity: null }, aliasOverlay: null },
});
const options = { scaffoldRoot: "", liveState: () => () => ({ health: "fresh" as const, locations: [] }) };
const question = "Does the invoice total round tax per line before summing?";

describe("prompt policy", () => {
  it("merges a tiny chunk remainder, including one at a later chunk boundary", () => {
    for (const size of [41, 49, 81, 89]) {
      const text = Array.from({ length: size }, (_, i) => `word${i}`).join(" ");
      const windows = promptWindows(text);
      expect(windows.every((w) => w.split(/\s+/).length >= 10)).toBe(true);
      expect(windows.join(" ")).toBe(text);
    }
    expect(promptWindows("  keep these bytes  ")).toEqual(["  keep these bytes  "]);
  });

  it("compares the margin with an independent candidate beyond the gate window", () => {
    const docs = buildRankIndex(Array.from({ length: 14 }, (_, i) => ({ ...entity(String(i), [i < 13 ? "src/a.ts" : "src/b.ts"]), symbolNames: [], symbolFiles: [] }))).docs;
    const list: RankedCandidate[] = docs.map((doc, i) => ({ doc, norm: i < 13 ? 1 : 0.1, score: 1, groups: 5, exact: 0 }));
    expect(gateCandidates(list, RECIPES.R2w, true).selected).toEqual([]);
    expect(gateCandidates(list, RECIPES.R2w, true, true).selected[0]).toBe(list[0]);
    list[1]!.doc.entity.code = ["src/b.ts"];
    expect(gateCandidates(list, RECIPES.R2w, true, true).selected).toEqual([]);
    list[0]!.exact = 3;
    expect(gateCandidates(list, RECIPES.R2w, true, true).selected[0]).toBe(list[0]);
    expect(gateCandidates(list, RECIPES.R2w, true).selected).toEqual([]);
  });

  it("recognises sibling files and symbols, without treating empty grounding as shared", () => {
    const a = { ...entity("a", []), symbolNames: ["calculate"], symbolFiles: [] };
    expect(sharesGrounding(a, { ...a, id: "b" })).toBe(true);
    expect(sharesGrounding({ ...a, symbolNames: [] }, { ...a, symbolNames: [] })).toBe(false);
  });

  it("keeps short packets identical unless opted in, and excludes overview types only at the gate", async () => {
    const index = indexOf([{ ...entity("overview"), type: "component" }]);
    const normal = await composePrompt(index, question, options);
    expect(normal.result.injected[0]?.id).toBe("overview");
    const revised = await composePrompt(index, question, { ...options, shortPromptPolicy: true });
    expect(revised.result.injected).toEqual([]);
    expect((await composePrompt(index, question, options)).result.packet).toBe(normal.result.packet);
    expect((await composePrompt(index, question, { ...options, independentMargin: true })).result.packet).toBe(normal.result.packet);
  });

  it("adds at most one shared-node pointer and remembers pointer visibility separately", async () => {
    const main = entity("main");
    const others = ["b", "c"].map((id) => ({ ...entity(id), title: "Invoice constraints", body: "Obscure constraints for archived records." }));
    const index = indexOf([main, ...others]);
    const normal = await composePrompt(index, question, options);
    expect(normal.result.injected.map((e) => e.type)).toEqual(["fact"]);
    const revised = await composePrompt(index, question, { ...options, shortPromptPolicy: true });
    expect(revised.result.injected.map((e) => e.type)).toEqual(["fact", "pointer"]);
    expect(revised.result.packet).not.toContain(others[0]!.body);
    expect(revised.result.packet).toContain("MEX knowledge (pointer");
    const seen = await composePrompt(index, question, { ...options, shortPromptPolicy: true, shown: new Set(["pointer:b", "pointer:c"]) });
    expect(seen.result.injected.map((e) => e.id)).toEqual(["main"]);
  });

  it("avoids semantic work when a long prompt has no lexical match", async () => {
    let calls = 0;
    const result = await composePrompt(indexOf([entity("main")]), Array(50).fill("zzzzzz").join(" "), {
      ...options, embedder: { modelId: "test", embed: async () => { calls++; return new Float32Array([1]); } },
    });
    expect(calls).toBe(0);
    expect(result.result.abstention).toBe("no-match");
  });

  it("names a windowed cosine veto explicitly", async () => {
    const result = await composePrompt(indexOf([entity("main")]), `${question} ${Array(45).fill("background").join(" ")}`, {
      ...options, embedder: { modelId: "veto", embed: async (text) => Float32Array.from(text.startsWith("Invoice rounding.") ? [1, 0] : [0, 1]) },
    });
    expect(result.result.abstention).toBe("low-cosine-veto");
  });
});
