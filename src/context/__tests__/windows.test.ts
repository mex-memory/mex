import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composePrompt, candidatePool } from "../compose.js";
import { RECIPES, WINDOWING } from "../frozen.js";
import { ensureContextIndex } from "../index-store.js";
import { buildRankIndex, fuseDense, rankQuery, type RankableEntity } from "../rank.js";
import { promptWindows } from "../windows.js";
import { cleanupProjects, createProject, fakeEmbedder, STANDARD_FACTS, writeEntities, type Fixture } from "./fixture.js";

const words = (text: string): number => text.trim().split(/\s+/).length;

const FILLER_CONTEXT =
  "We are moving our storefront over to a new hosting provider this quarter and the team has been going through the old services one at a time. "
  + "Most of them behaved exactly as documented, but a couple of them surprised us in staging last week. "
  + "I also tried restarting the worker and clearing the local build folder, neither of which changed anything. ";
const FILLER_CLOSING = "Keep the answer short and point me to the code. Answer concisely, citing files.";
const INVOICE_ASK =
  "The invoice total is one cent off after a discount is recalculated: does the tax round per line item before summing the lines?";

describe("promptWindows", () => {
  it("returns a short prompt untouched, as one window", () => {
    expect(promptWindows(INVOICE_ASK)).toEqual([INVOICE_ASK]);
    const atLimit = Array.from({ length: WINDOWING.singleMaxWords }, (_, k) => `w${k}`).join(" ");
    expect(promptWindows(atLimit)).toEqual([atLimit]);
  });

  it("cuts a long prompt into windows no longer than the cap, covering every sentence", () => {
    const prompt = `${FILLER_CONTEXT}${INVOICE_ASK} ${FILLER_CLOSING}`;
    expect(words(prompt)).toBeGreaterThan(WINDOWING.singleMaxWords);
    const windows = promptWindows(prompt);
    expect(windows.length).toBeGreaterThan(1);
    for (const window of windows) expect(words(window)).toBeLessThanOrEqual(WINDOWING.capWords);
    expect(windows.some((w) => w.includes("does the tax round per line item"))).toBe(true);
    expect(windows.some((w) => w.includes("Keep the answer short"))).toBe(true);
    // Every word of the prompt lies in some window.
    const covered = new Set(windows.flatMap((w) => w.split(/\s+/)));
    for (const word of prompt.split(/\s+/)) expect(covered.has(word)).toBe(true);
  });

  it("merges a very short sentence into its neighbour", () => {
    const prompt = `${FILLER_CONTEXT}Why? ${INVOICE_ASK}`;
    const windows = promptWindows(prompt);
    expect(windows.some((w) => /^Why\?$/.test(w))).toBe(false);
    expect(windows.some((w) => w.includes("Why?"))).toBe(true);
  });

  it("cuts a single over-long sentence and caps the number of windows", () => {
    const sentence = Array.from({ length: 200 }, (_, k) => `term${k}`).join(" ");
    const windows = promptWindows(sentence, { ...WINDOWING, singleMaxWords: 50, capWords: 30 });
    expect(windows.length).toBe(Math.ceil(200 / 30));
    expect(promptWindows(sentence, { ...WINDOWING, singleMaxWords: 50, capWords: 30, maxWindows: 3 }).length).toBeLessThanOrEqual(3);
  });
});

function rankableFacts(): RankableEntity[] {
  return STANDARD_FACTS.map((fact, k) => ({
    id: `mx_${k}`,
    title: fact.title,
    body: fact.body,
    aliases: [],
    code: [],
    symbolNames: [],
    symbolFiles: [],
  }));
}

describe("one-window identity", () => {
  it("ranks a prompt that fits in one window exactly as the whole-prompt scorer does", () => {
    const index = buildRankIndex(rankableFacts());
    const never = { ...WINDOWING, singleMaxWords: 1_000_000 };
    for (const prompt of [INVOICE_ASK, "Please explain how the webhook works", `${FILLER_CONTEXT}${INVOICE_ASK}`.slice(0, 200)]) {
      expect(words(prompt)).toBeLessThanOrEqual(WINDOWING.singleMaxWords);
      const windowed = rankQuery(index, prompt);
      const whole = rankQuery(index, prompt, never);
      expect(windowed.windows).toEqual([prompt]);
      expect(windowed.list.map((r) => [r.doc.entity.id, r.score, r.norm, r.groups, r.exact])).toEqual(
        whole.list.map((r) => [r.doc.entity.id, r.score, r.norm, r.groups, r.exact]),
      );
      expect(windowed.idfSum).toBe(whole.idfSum);
    }
  });

  it("takes the best cosine over the windows and the plain cosine for one vector", () => {
    const index = buildRankIndex(rankableFacts());
    const lexical = rankQuery(index, INVOICE_ASK);
    const vectors = new Map(index.docs.map((doc, k) => [doc.entity.id, Float32Array.from([k === 0 ? 1 : 0, k === 1 ? 1 : 0])]));
    const q0 = Float32Array.from([1, 0]);
    const q1 = Float32Array.from([0, 1]);
    const one = fuseDense(index, lexical, q0, vectors);
    expect(one.list.find((r) => r.doc.entity.id === "mx_0")!.cos).toBe(1);
    expect(one.list.find((r) => r.doc.entity.id === "mx_1")!.cos).toBe(0);
    const both = fuseDense(index, lexical, [q0, q1], vectors);
    expect(both.list.find((r) => r.doc.entity.id === "mx_0")!.cos).toBe(1);
    expect(both.list.find((r) => r.doc.entity.id === "mx_1")!.cos).toBe(1);
    expect(fuseDense(index, lexical, [q0], vectors).list.map((r) => r.cos)).toEqual(one.list.map((r) => r.cos));
  });
});

describe("long prompts", () => {
  let fx: Fixture;
  let ids: string[];
  beforeEach(() => {
    fx = createProject();
    ids = writeEntities(fx, "context/notes.md", STANDARD_FACTS);
  });
  afterEach(cleanupProjects);

  async function compose(prompt: string, extra: Partial<Parameters<typeof composePrompt>[2]> = {}) {
    const { index } = await ensureContextIndex(fx.context);
    return composePrompt(index, prompt, { scaffoldRoot: fx.context.scaffoldRoot, ...extra });
  }

  it("fires on the one sentence that fits even when the rest of the prompt is generic", async () => {
    const prompt = `${FILLER_CONTEXT}${INVOICE_ASK} ${FILLER_CLOSING}`;
    expect(words(prompt)).toBeGreaterThan(WINDOWING.singleMaxWords);
    const { result } = await compose(prompt);
    expect(result.recipe).toBe("R2w");
    expect(result.injected.map((entry) => entry.id)).toEqual([ids[0]]);
  });

  it("stays silent on a long prompt whose only specific content is generic instructions", async () => {
    const prompt = `${FILLER_CONTEXT}${FILLER_CLOSING} Explain step by step, keep it brief and cite the files you looked at. Please answer concisely.`;
    expect(words(prompt)).toBeGreaterThan(WINDOWING.singleMaxWords);
    const { result } = await compose(prompt);
    expect(result.injected).toEqual([]);
  });

  it("embeds every window in the hybrid recipe and selects through the best one", async () => {
    const calls: string[] = [];
    const embedder = fakeEmbedder(calls);
    const { index } = await ensureContextIndex(fx.context);
    const first = await composePrompt(index, `${FILLER_CONTEXT}${INVOICE_ASK} ${FILLER_CLOSING}`, { scaffoldRoot: fx.context.scaffoldRoot, embedder });
    expect(first.result.recipe).toBe("R3");
    expect(first.result.injected.map((entry) => entry.id)).toEqual([ids[0]]);
    const documentEmbeds = calls.length;
    await composePrompt(index, `${FILLER_CONTEXT}${INVOICE_ASK} ${FILLER_CLOSING}`, { scaffoldRoot: fx.context.scaffoldRoot, embedder });
    expect(calls.length - documentEmbeds).toBe(promptWindows(`${FILLER_CONTEXT}${INVOICE_ASK} ${FILLER_CLOSING}`.trim()).length);
  });
});

describe("R3 candidates", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = createProject();
  });
  afterEach(cleanupProjects);

  it("ranks the same typed sections as the lexical recipe, not facts alone", async () => {
    writeEntities(fx, "context/notes.md", [
      ...STANDARD_FACTS.slice(0, 2),
      {
        type: "convention",
        title: "Errors are thrown as typed exceptions",
        body: "Every handler signals a failure by throwing a typed exception that carries the response; the shared error handler turns it into the reply, so handlers never build error replies by hand.",
      },
      { type: "decision", title: "Short", body: "tiny" },
    ]);
    const { index } = await ensureContextIndex(fx.context);
    const r3 = candidatePool(index, RECIPES.R3).map((e) => e.title);
    expect(r3).toContain("Errors are thrown as typed exceptions");
    expect(r3).toContain(STANDARD_FACTS[0]!.title);
    expect(r3).not.toContain("Short");
    expect(candidatePool(index, RECIPES.R2w).map((e) => e.title)).toContain("Errors are thrown as typed exceptions");
  });

  it("can inject a convention in the hybrid recipe", async () => {
    const [, , convention] = writeEntities(fx, "context/notes.md", [
      ...STANDARD_FACTS.slice(0, 2),
      {
        type: "convention",
        title: "Errors are thrown as typed exceptions",
        body: "Every handler signals a failure by throwing a typed exception that carries the response; the shared error handler turns it into the reply, so handlers never build error replies by hand.",
      },
    ]);
    const { index } = await ensureContextIndex(fx.context);
    const embedder = fakeEmbedder();
    const prompt = "When a handler fails, should it throw a typed exception that carries the response, or build the error reply by hand in the handler?";
    const { result } = await composePrompt(index, prompt, { scaffoldRoot: fx.context.scaffoldRoot, embedder });
    expect(result.recipe).toBe("R3");
    expect(result.injected.map((entry) => entry.id)).toEqual([convention]);
    expect(result.injected[0]!.type).toBe("convention");
  });
});
