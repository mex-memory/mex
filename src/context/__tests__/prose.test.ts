import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composePrompt } from "../compose.js";
import { RECIPES, WINDOWING, type Recipe } from "../frozen.js";
import { ensureContextIndex } from "../index-store.js";
import { gateCandidates, buildRankIndex, rankQuery, type RankableEntity, type RankedCandidate } from "../rank.js";
import { promptWindows, proseOf } from "../windows.js";
import { cleanupProjects, createProject, STANDARD_FACTS, writeEntities, type Fixture } from "./fixture.js";

const words = (text: string): number => text.trim().split(/\s+/).length;
const FENCE = "```";
const TRACE = [
  "TypeError: Cannot read properties of undefined (reading 'length')",
  "    at renderToString (src/render.ts:32:18)",
  "    at handler (src/handler.ts:55:14)",
  "    at run (src/run.ts:39:28)",
].join("\n");
const CODE = [
  "const total = items.reduce((sum, item) => sum + item, 0);",
  "export function price(x: number) {",
  "  return x * 2;",
  "}",
].join("\n");
const INVOICE_ASK =
  "The invoice total is one cent off after a discount is recalculated: does the tax round per line item before summing the lines?";
const CONTEXT =
  "We are moving our storefront over to a new hosting provider this quarter and the team has been going through the old services one at a time. "
  + "Most of them behaved exactly as documented, but a couple of them surprised us in staging last week. "
  + "I also tried restarting the worker and clearing the local build folder, neither of which changed anything.";

describe("proseOf", () => {
  it("removes fenced blocks, stack frames and runs of code lines, and keeps the prose", () => {
    const prompt = ["I keep seeing this failure.", FENCE, TRACE, FENCE, "Why does the invoice round per line?", CODE, "Thanks."].join("\n");
    const prose = proseOf(prompt);
    expect(prose).toContain("I keep seeing this failure.");
    expect(prose).toContain("Why does the invoice round per line?");
    expect(prose).toContain("Thanks.");
    expect(prose).not.toContain("renderToString");
    expect(prose).not.toContain("reduce");
  });

  it("keeps prose that starts with a keyword-like word", () => {
    const prose = proseOf("If the invoice is recalculated the total changes.\nFor example the tax moves by one cent.\nWhat decides that?");
    expect(prose).toContain("If the invoice is recalculated");
    expect(prose).toContain("For example the tax moves");
    expect(prose).toContain("What decides that?");
  });

  it("leaves a prompt without pastes as it was", () => {
    expect(proseOf(INVOICE_ASK)).toBe(INVOICE_ASK);
  });
});

describe("pasted blocks in a long prompt", () => {
  it("are not scored", () => {
    const code = Array.from({ length: 40 }, (_, k) => `const value${k} = compute${k}(input) * ${k};`).join("\n");
    const prompt = ["Can you take a look at this?", FENCE + "ts", code, FENCE, CONTEXT].join("\n");
    expect(words(prompt)).toBeGreaterThan(WINDOWING.singleMaxWords);
    expect(promptWindows(prompt).join(" ")).not.toContain("compute3");
  });

  it("score the whole text when there is almost no prose around them", () => {
    const prompt = [FENCE, TRACE, FENCE, CODE, CODE, CODE].join("\n");
    const windows = promptWindows(prompt, { ...WINDOWING, singleMaxWords: 10 });
    expect(windows.join(" ")).toContain("renderToString");
  });
});

function facts(): RankableEntity[] {
  return STANDARD_FACTS.map((fact, k) => ({ id: `mx_${k}`, title: fact.title, body: fact.body, aliases: [], code: [], symbolNames: [], symbolFiles: [] }));
}

describe("the windowed gate", () => {
  it("applies only to a prompt scored in more than one window", () => {
    const index = buildRankIndex(facts());
    const one = rankQuery(index, INVOICE_ASK);
    const many = rankQuery(index, `${CONTEXT} ${INVOICE_ASK}`);
    expect(one.windows).toHaveLength(1);
    expect(many.windows.length).toBeGreaterThan(1);
    // The floor and corroboration of the two gates differ: the windowed one is lower.
    expect(RECIPES.R2w.windowed.thresholds.floor).toBeLessThan(RECIPES.R2w.thresholds.floor);
    expect(gateCandidates(many.list, RECIPES.R2w, true).selected.map((r) => r.doc.entity.id)).toEqual(["mx_0"]);
  });

  it("lets the dense recipe's cosine veto a lexical match", () => {
    const index = buildRankIndex(facts());
    const out = rankQuery(index, `${CONTEXT} ${INVOICE_ASK}`);
    for (const r of out.list) r.cos = 0.1;
    expect(gateCandidates(out.list, RECIPES.R3, true).selected).toEqual([]);
    for (const r of out.list) r.cos = 0.9;
    expect(gateCandidates(out.list, RECIPES.R3, true).selected.map((r) => r.doc.entity.id)).toEqual(["mx_0"]);
  });

  it("needs four query words in one window, or an identifier hit, for the lexical recipe", () => {
    // A clear leader over the fourth candidate, so only corroboration decides.
    const ranked = (groups: number, exact: number): RankedCandidate[] =>
      [0.6, 0.2, 0.15, 0.1].map((norm, order) => ({
        doc: { entity: facts()[order]!, order, tf: new Map(), len: 10, symNames: [], symFiles: [] },
        score: norm,
        norm,
        groups: order === 0 ? groups : 1,
        exact: order === 0 ? exact : 0,
        cos: 0.9,
      }));
    const picked = (list: RankedCandidate[], recipe: Recipe): string[] =>
      gateCandidates(list, recipe, true).selected.map((r) => r.doc.entity.id);
    expect(gateCandidates(ranked(3, 0), RECIPES.R2w, true).window[0]!.decision).toBe("uncorroborated");
    expect(picked(ranked(4, 0), RECIPES.R2w)).toEqual(["mx_0"]);
    expect(picked(ranked(3, 2), RECIPES.R2w)).toEqual(["mx_0"]);
    // The dense recipe keeps three: its cosine veto already rejects coincidences.
    expect(picked(ranked(3, 0), RECIPES.R3)).toEqual(["mx_0"]);
  });
});

describe("a long prompt around pasted noise", () => {
  let fx: Fixture;
  let ids: string[];
  beforeEach(() => {
    fx = createProject();
    ids = writeEntities(fx, "context/notes.md", STANDARD_FACTS);
  });
  afterEach(cleanupProjects);

  it("injects the fact the question names and ignores what was pasted", async () => {
    const webhook = "const retries = 6;\nconst backoff = 30;\nexport function retryWebhookDelivery() {\n  return deadLetterQueue.park(delivery);\n}";
    const prompt = [TRACE, FENCE, webhook, FENCE, CONTEXT, INVOICE_ASK].join("\n");
    const { index } = await ensureContextIndex(fx.context);
    const { result } = await composePrompt(index, prompt, { scaffoldRoot: fx.context.scaffoldRoot });
    expect(result.injected.map((entry) => entry.id)).toEqual([ids[0]]);
  });
});
