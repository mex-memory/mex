import type { RecordReader, RecordWriter } from "../record/index.js";
import { TOKEN_CLASSES, type Tokens } from "../record/usage.js";

/** A user-approved job uses the shared queue but spends against its own token ceiling. */
export interface ConsentedModelBatch { estimate: Tokens; ceiling: number; }
export interface TokenReservation { tokens: number; ceiling: number; }
export const CEILING_WAIT = "Waiting: the approved learning ceiling is used up. Run `mex learn --raise-ceiling` to review a new limit.";

export function tokenCount(tokens: Tokens): number {
  const total = TOKEN_CLASSES.reduce((sum, key) => sum + tokens[key], 0);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("Invalid token total.");
  return total;
}

export function tokenReservation(pricing: string): TokenReservation | undefined {
  const value = JSON.parse(pricing)?.tokenReservation as TokenReservation | undefined;
  if (value === undefined) return undefined;
  if (!value || !Number.isSafeInteger(value.tokens) || value.tokens < 1 || !Number.isSafeInteger(value.ceiling) || value.ceiling < 1) {
    throw new Error("Invalid model token reservation.");
  }
  return value;
}

/** An admitted attempt with incomplete accounting still owns its full reservation. */
export function recordedModelSpend(reader: RecordWriter | Pick<RecordReader, "all">, jobId: string, batchId?: number): number {
  const sql = `SELECT b.pricing,b.state,count(c.batch_id) reports,coalesce(max(c.estimated),0) estimated,
    coalesce(sum(c.input+c.cache_write+c.cache_read+c.output),0) tokens
    FROM model_batches b LEFT JOIN model_calls c ON c.batch_id=b.id
    WHERE b.job_id=? AND b.admitted_at IS NOT NULL${batchId === undefined ? "" : " AND b.id=?"} GROUP BY b.id`;
  type Charge = { pricing: string; state: string; reports: number; estimated: number; tokens: number };
  const params = batchId === undefined ? [jobId] : [jobId, batchId];
  const rows = "db" in reader ? reader.db.prepare(sql).all(...params) as unknown as Charge[] : reader.all<Charge>(sql, ...params);
  return rows.reduce((sum, row) => {
    const pricing = JSON.parse(row.pricing);
    const measured = row.state === "done" && row.reports > 0 && row.estimated === 0;
    const budget = tokenReservation(row.pricing)?.tokens ?? pricing.automaticTokens;
    const settled = pricing.settledTokens;
    if (settled === undefined && !measured && (!Number.isSafeInteger(budget) || budget < 1)) throw new Error("Learning has an unreconciled model attempt without a token reservation.");
    const charge = settled === undefined ? (measured ? row.tokens : Math.max(row.tokens, budget)) : settled;
    if (!Number.isSafeInteger(charge) || charge < 0) throw new Error("Invalid learning spend.");
    const total = sum + charge;
    if (!Number.isSafeInteger(total) || total < 0) throw new Error("Invalid learning spend.");
    return total;
  }, 0);
}
