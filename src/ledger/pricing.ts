import prices from "../shared/delivery-prices.json" with { type: "json" };

export interface TokenClasses {
  input: number;
  write5m: number;
  write1h: number;
  read: number;
  output: number;
}

// The CLI bundles the same reference data that the checkout-only replay reads.
export const LEDGER_PRICE_PROFILE = prices.profile;
export const INPUT_MILLITOKENS = 1000;

function inputRates(rates: TokenClasses): Readonly<TokenClasses> {
  const reference = prices.referenceInputUSDPerMillion;
  return { input: rates.input / reference, write5m: rates.write5m / reference, write1h: rates.write1h / reference,
    read: rates.read / reference, output: rates.output / reference };
}

const modelRates = new Map(Object.entries(prices.models).map(([model, rates]) => [model, inputRates(rates)]));
const fallbackRates = inputRates(prices.unknown);

export function ledgerRates(model?: unknown): Readonly<TokenClasses> {
  const key = typeof model === "string" ? model.toLowerCase().replace(/\[1m\]$/u, "").replace(/-\d{8}$/u, "") : "";
  return modelRates.get(key) ?? fallbackRates;
}

export function inputTokens(tokens: Readonly<TokenClasses>): number {
  return tokens.input + tokens.write5m + tokens.write1h + tokens.read;
}

export function pricedInput(tokens: Readonly<TokenClasses>, rates: Readonly<TokenClasses>): number {
  return tokens.input * rates.input + tokens.write5m * rates.write5m + tokens.write1h * rates.write1h + tokens.read * rates.read;
}

export function pricedUsage(tokens: Readonly<TokenClasses>, rates: Readonly<TokenClasses>): number {
  return pricedInput(tokens, rates) + tokens.output * rates.output;
}
