import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composePrompt } from "../compose.js";
import { ensureContextIndex } from "../index-store.js";
import {
  buildGraph,
  cleanupProjects,
  createProject,
  fakeEmbedder,
  graphSymbol,
  STANDARD_FACTS,
  writeEntities,
  type Fixture,
} from "./fixture.js";

const INVOICE_PROMPT =
  "The invoice total is one cent off after a discount is recalculated: does the tax round per line item before summing the lines?";

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

describe("lexical recipe (R2w)", () => {
  it("injects the fact that clearly fits, with a reason for every candidate", async () => {
    const { result } = await compose(INVOICE_PROMPT);
    expect(result.recipe).toBe("R2w");
    expect(result.channel).toBe("lexical");
    expect(result.abstention).toBeNull();
    expect(result.injected.map((entry) => entry.id)).toEqual([ids[0]]);
    expect(result.packet).toContain("Invoice totals round tax per line before summing");
    expect(result.packet).toContain(`more: mex wiki show ${ids[0]}`);
    expect(result.candidates[0]).toMatchObject({ id: ids[0], decision: "selected" });
    for (const candidate of result.candidates) expect(candidate.decision).toBeTruthy();
  });

  it("abstains, with a reason, on an off-topic prompt", async () => {
    const { result } = await compose("What is the weather going to be like in Paris tomorrow afternoon?");
    expect(result.injected).toEqual([]);
    expect(result.packet).toBe("");
    expect(result.abstention).not.toBeNull();
    expect(["no-match", "below-floor", "uncorroborated", "weak-margin"]).toContain(result.abstention);
  });

  it("abstains rather than guess on a prompt that shares only one or two words", async () => {
    const { result } = await compose("Please explain how the webhook works");
    expect(result.injected).toEqual([]);
    expect(result.abstention).toBeTruthy();
  });

  it("names the reason for an empty prompt and for a background-task notification", async () => {
    expect((await compose("   ")).result.abstention).toBe("empty-prompt");
    expect((await compose("<task-notification>done</task-notification>")).result.abstention).toBe("task-notification");
  });

  it("reports no-index when the scaffold has nothing to rank", async () => {
    const empty = createProject();
    const { index } = await ensureContextIndex(empty.context);
    const { result } = await composePrompt(index, INVOICE_PROMPT, { scaffoldRoot: empty.context.scaffoldRoot });
    expect(result.abstention).toBe("no-index");
  });
});

describe("exact identifiers", () => {
  it("injects the fact linked to a symbol the prompt names in backticks", async () => {
    fx.writeSource(
      "src/billing.ts",
      "export function calculateOrderTotal(items: number[]): number {\n  const subtotal = items.reduce((sum, item) => sum + item, 0);\n  return subtotal * 1.18;\n}\n",
    );
    await buildGraph(fx);
    const symbol = graphSymbol(fx, "calculateOrderTotal");
    const [grounded] = writeEntities(fx, "context/billing.md", [
      {
        title: "Order totals include a flat eighteen percent levy",
        body: "Every order total multiplies the subtotal by one point one eight; there is no per-region variation and no rounding step.",
        groundings: [{ node: symbol.id, file: symbol.file, bodyHash: symbol.bodyHash }],
      },
    ]);
    // The single backticked name is the only overlap with the fact's own words.
    const { result } = await compose("Where is `calculateOrderTotal` defined and what does it do?");
    expect(result.injected.map((entry) => entry.id)).toEqual([grounded]);
    expect(result.candidates[0]!.exact).toBeGreaterThan(0);
    expect(result.packet).toContain("code: src/billing.ts:1-4 #calculateOrderTotal");
    expect(result.packet).toContain("(fresh");
  });

  it("labels a fact whose linked code changed as changed", async () => {
    fx.writeSource("src/billing.ts", "export function calculateOrderTotal(items: number[]): number {\n  return items.length;\n}\n");
    await buildGraph(fx);
    const symbol = graphSymbol(fx, "calculateOrderTotal");
    writeEntities(fx, "context/billing.md", [
      {
        title: "Order totals count the items",
        body: "The order total is the number of items in the basket and nothing else at all.",
        groundings: [{ node: symbol.id, file: symbol.file, bodyHash: "ab".repeat(32) }],
      },
    ]);
    const { result } = await compose("What does `calculateOrderTotal` return?");
    expect(result.injected[0]?.health).toBe("changed");
    expect(result.packet).toContain("changed");
  });
});

describe("session de-duplication", () => {
  it("does not repeat an entry the session already saw", async () => {
    const first = await compose(INVOICE_PROMPT);
    const shown = new Set(first.result.injected.map((entry) => entry.id));
    expect(shown.size).toBe(1);

    const second = await compose(INVOICE_PROMPT, { shown });
    expect(second.result.injected).toEqual([]);
    expect(second.result.abstention).toBe("already-shown");
    expect(second.result.alreadyShown).toEqual([...shown]);
    expect(second.result.candidates[0]!.decision).toBe("already-shown");
  });
});

describe("semantic channel", () => {
  it("selects the hybrid recipe when an embedder is available and caches the fact vectors", async () => {
    const calls: string[] = [];
    const embedder = fakeEmbedder(calls);
    const { index } = await ensureContextIndex(fx.context);
    const first = await composePrompt(index, INVOICE_PROMPT, { scaffoldRoot: fx.context.scaffoldRoot, embedder });
    expect(first.result.recipe).toBe("R3");
    expect(first.result.channel).toBe("hybrid");
    expect(first.vectorsComputed).toBe(STANDARD_FACTS.length);
    expect(Object.keys(index.vectors[embedder.modelId]!)).toHaveLength(STANDARD_FACTS.length);
    expect(first.result.injected.map((entry) => entry.id)).toEqual([ids[0]]);
    expect(first.result.candidates[0]!.cos).toBeGreaterThanOrEqual(0.6);

    const documentEmbeds = calls.length;
    const second = await composePrompt(index, INVOICE_PROMPT, { scaffoldRoot: fx.context.scaffoldRoot, embedder });
    expect(second.vectorsComputed).toBe(0);
    // Only the query is embedded the second time: the fact vectors came from the cache.
    expect(calls.length - documentEmbeds).toBe(1);
  });

  it("recomputes only the vector of a fact whose text changed", async () => {
    const embedder = fakeEmbedder();
    const { index } = await ensureContextIndex(fx.context);
    await composePrompt(index, INVOICE_PROMPT, { scaffoldRoot: fx.context.scaffoldRoot, embedder });
    index.entities.find((e) => e.id === ids[1])!.body += " It also logs every refresh.";
    const again = await composePrompt(index, INVOICE_PROMPT, { scaffoldRoot: fx.context.scaffoldRoot, embedder });
    expect(again.vectorsComputed).toBe(1);
  });

  it("falls back to the lexical recipe, with a warning, when the model fails", async () => {
    const broken = {
      modelId: "broken:test",
      async embed(): Promise<Float32Array> {
        throw new Error("model exploded");
      },
    };
    const { result, diagnostics } = await compose(INVOICE_PROMPT, { embedder: broken });
    expect(result.recipe).toBe("R2w");
    expect(result.injected.map((entry) => entry.id)).toEqual([ids[0]]);
    expect(diagnostics.map((d) => d.code)).toContain("CONTEXT_SEMANTIC_FAILED");
  });

  it("uses the lexical recipe without any diagnostic when there is no embedder", async () => {
    const { result, diagnostics } = await compose(INVOICE_PROMPT, { embedder: null });
    expect(result.recipe).toBe("R2w");
    expect(diagnostics).toEqual([]);
  });
});
