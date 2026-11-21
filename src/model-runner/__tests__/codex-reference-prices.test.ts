import { describe, expect, it } from "vitest";
import prices from "../../shared/delivery-prices.json" with { type: "json" };
import { modelWeights } from "../budget-prices.js";

// The offline replay prices Codex sessions from delivery-prices.json; the
// budget prices MEX's own runs. Both must use the same reference rates.
describe("Codex reference prices", () => {
  const usage = (input: number) => ({ input, cache_write: 0, cache_read: 0, output: 0 });
  for (const [model, rates] of Object.entries(prices.codex.models)) {
    it(`${model} matches the budget weights`, () => {
      const perMillion = (weights: ReturnType<typeof modelWeights>) => ({
        input: weights.input / 1000, write: weights.cache_write / 1000, read: weights.cache_read / 1000, output: weights.output / 1000,
      });
      expect(perMillion(modelWeights(model, usage(prices.codex.longAbove)))).toEqual(rates.short);
      expect(perMillion(modelWeights(model, usage(prices.codex.longAbove + 1)))).toEqual(rates.long);
    });
  }
});
