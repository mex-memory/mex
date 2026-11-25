import type { RecordReader } from "../record/index.js";
import { mexSpendTotals, type Tokens } from "../record/usage.js";
import { DEFAULT_CAP_BASIS_POINTS, weightedTokens } from "./budget-policy.js";
import { modelWeights } from "./budget-prices.js";
import { modelBudgetSnapshot } from "./budget-queue.js";

const DAY_MS = 86_400_000;

/** The same seven UTC calendar days and estimated share used by `mex status`. */
export function readModelUse(reader: Pick<RecordReader, "all" | "setting"> | undefined, now: number) {
  const capPercent = DEFAULT_CAP_BASIS_POINTS / 100;
  if (!reader) return { runs: 0, percent: null, capPercent, estimated: true as const };

  const budget = modelBudgetSnapshot(reader, now);
  const start = new Date(now - 6 * DAY_MS).toISOString();
  const spend = mexSpendTotals(reader, start, new Date(now).toISOString());
  const from = start.slice(0, 10);
  const through = new Date(now + DAY_MS).toISOString().slice(0, 10);
  const used = reader.all<Tokens & { model: string }>(`SELECT model,sum(input) input,sum(cache_write) cache_write,
    sum(cache_read) cache_read,sum(output) output FROM model_calls
    WHERE kind='headless' AND ts>=? AND ts<? GROUP BY model`, from, through)
    .reduce((sum, row) => sum + weightedTokens(row, modelWeights(row.model, row)), 0);
  return {
    runs: spend.spend.reduce((sum, row) => sum + row.calls, 0),
    percent: budget.ownUsageReadable && budget.lastSevenUnits > 0 ? 100 * used / budget.lastSevenUnits : null,
    capPercent,
    estimated: true as const,
  };
}
