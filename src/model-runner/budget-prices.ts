import type { Tokens } from "../record/usage.js";
import { weightedTokens, type TokenWeights } from "./budget-policy.js";

/** Reference list-price weights, checked 2026-11-14. Units: nanodollars/token.
 * These value tokens for admission; they are not subscription bills. Claude
 * writes use the longer cache duration conservatively because totals omit TTL.
 * Sources and the estimated own-usage reference are documented with the policy.
 */
export const PRICE_PROFILE = "reference-2026-11-14";
interface Price { weights: TokenWeights; longAbove?: number; longWeights?: TokenWeights; }
const opus: Price = { weights: { input: 4000, cache_write: 8000, cache_read: 200, output: 20000 } };
const haiku: Price = {
  weights: { input: 100, cache_write: 200, cache_read: 10, output: 500 }, longAbove: 100_000,
  longWeights: { input: 500, cache_write: 1000, cache_read: 50, output: 2500 },
};
const sol: Price = {
  weights: { input: 2000, cache_write: 5000, cache_read: 100, output: 10000 }, longAbove: 272_000,
  longWeights: { input: 4000, cache_write: 10000, cache_read: 200, output: 15000 },
};
const luna: Price = {
  weights: { input: 100, cache_write: 250, cache_read: 10, output: 500 }, longAbove: 272_000,
  longWeights: { input: 200, cache_write: 500, cache_read: 20, output: 750 },
};
const PRICES: Readonly<Record<string, Price>> = {
  opus, haiku, "claude-opus-5-5": opus, "claude-haiku-5-5": haiku,
  "gpt-6.1-sol": sol, "gpt-6.2-sol": sol, "gpt-6-luna": luna,
};
/** Own-usage logs lack model labels and cache durations: fixed, estimated reference valuation. */
export const OWN_REFERENCE: Readonly<Record<string, TokenWeights>> = {
  claude: { input: 4000, cache_write: 5000, cache_read: 200, output: 20000 },
  codex: { input: 2000, cache_write: 2500, cache_read: 100, output: 10000 },
};
export const MAX_REFERENCE: TokenWeights = opus.weights;
export const REFERENCE_BATCH: Readonly<Tokens> = { input: 4000, cache_write: 0, cache_read: 0, output: 1000 };
export const REFERENCE_BATCH_UNITS = Math.max(...Object.values(OWN_REFERENCE).map(weights => weightedTokens(REFERENCE_BATCH, weights)));

export function knownPrice(model: string): boolean { return Object.hasOwn(PRICES, model); }
export function modelWeights(model: string, tokens: Readonly<Tokens>): TokenWeights {
  const price = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
  if (!price) return MAX_REFERENCE;
  const input = tokens.input + tokens.cache_read + tokens.cache_write;
  return price.longAbove !== undefined && input > price.longAbove ? price.longWeights! : price.weights;
}
