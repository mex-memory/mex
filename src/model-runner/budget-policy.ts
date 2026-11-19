import type { Tokens } from "../record/usage.js";

const CLASSES = ["input", "cache_write", "cache_read", "output"] as const;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
export const DEFAULT_CAP_BASIS_POINTS = 300;
export const DEFAULT_FLOOR_BATCHES = 7;
export const DEFAULT_PAUSE_PERCENT = 75;

/** Integer reference-price units per token; the caller names the pricing profile. */
export type TokenWeights = Readonly<Tokens>;
export interface BudgetParameters {
  /** Fixed policy reference batch, independent of an individual caller's estimate. */
  referenceBatchUnits: number;
  capBasisPoints?: number;
  floorBatches?: number;
  pausePercent?: number;
}
export interface BudgetSnapshot {
  lastSevenUnits: number;
  lastFourWeeksUnits: number;
  ownUsageReadable: boolean;
  spentUnits: number;
  reservedUnits: number;
  /** Started attempts, including interrupted/failed attempts, in the seven-day window. */
  admittedAttempts: number;
}
export interface PlanWindow {
  usedPercent: number | null;
  status: "allowed" | "allowed_warning" | "rejected" | null;
  resetsAt: string | null;
}
export interface AdmissionDecision {
  allowed: boolean;
  reason?: "cap" | "fallback" | "usage-window";
  limitUnits: number;
  remainingUnits: number;
  remainingAttempts: number;
  /** A scheduling hint only; absent information never implies unused room. */
  nextReset?: string;
}

export function planWindow(windows: readonly PlanWindow[], now: number, pause = DEFAULT_PAUSE_PERCENT): { blocked: boolean; nextReset?: string } {
  if (!Number.isFinite(pause) || pause < 0 || pause > 100) throw new Error("Invalid usage-window threshold.");
  let blocked = false, nearest: number | undefined;
  for (const window of windows) {
    const reset = window.resetsAt === null ? NaN : Date.parse(window.resetsAt);
    if (Number.isFinite(reset) && reset <= now) continue;
    if (Number.isFinite(reset) && (nearest === undefined || reset < nearest)) nearest = reset;
    const visible = window.usedPercent !== null && Number.isFinite(window.usedPercent)
      && window.usedPercent >= 0 && window.usedPercent <= 100;
    if (window.status === "rejected" || (visible && window.usedPercent! >= pause)) blocked = true;
  }
  return { blocked, ...(nearest === undefined ? {} : { nextReset: new Date(nearest).toISOString() }) };
}

function integer(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid budget quantity.");
  return BigInt(value);
}
function safe(value: bigint): number {
  if (value < 0n || value > MAX) throw new Error("Budget quantity exceeds its limit.");
  return Number(value);
}
function max(a: bigint, b: bigint): bigint { return a > b ? a : b; }

/** Exact integer arithmetic, rounded only when a fractional policy allowance is produced. */
export function weightedTokens(tokens: Readonly<Tokens>, weights: TokenWeights): number {
  let sum = 0n;
  for (const key of CLASSES) sum += integer(tokens[key]) * integer(weights[key]);
  return safe(sum);
}

/** A conservative lower bound when saved transcripts may also include MEX runs. */
export function subtractHeadless(own: Readonly<Tokens>, mex: Readonly<Tokens>): Tokens {
  const result = { input: 0, cache_write: 0, cache_read: 0, output: 0 };
  for (const key of CLASSES) result[key] = safe(max(0n, integer(own[key]) - integer(mex[key])));
  return result;
}

export function budgetLimit(snapshot: BudgetSnapshot, parameters: BudgetParameters): number {
  const basisPoints = integer(parameters.capBasisPoints ?? DEFAULT_CAP_BASIS_POINTS);
  if (basisPoints > 10_000n) throw new Error("Invalid budget share.");
  const floor = integer(parameters.floorBatches ?? DEFAULT_FLOOR_BATCHES) * integer(parameters.referenceBatchUnits);
  if (parameters.referenceBatchUnits === 0) throw new Error("A reference batch must be positive.");
  // Keep the quarter exact through the percentage multiplication.
  const baseTimesFour = max(integer(snapshot.lastSevenUnits) * 4n, integer(snapshot.lastFourWeeksUnits));
  return safe(max(floor, baseTimesFour * basisPoints / 40_000n));
}

/** Read-only policy. Persistence/ownership must make an allowed decision atomic with reservation. */
export function decideAdmission(
  snapshot: BudgetSnapshot,
  estimateUnits: number,
  parameters: BudgetParameters,
  windows: readonly PlanWindow[] = [],
  now = Date.now(),
): AdmissionDecision {
  if (!Number.isFinite(now)) throw new Error("Invalid budget clock.");
  const limitUnits = budgetLimit(snapshot, parameters);
  const spent = integer(snapshot.spentUnits), reserved = integer(snapshot.reservedUnits);
  const estimate = integer(estimateUnits), attempts = integer(snapshot.admittedAttempts);
  if (estimate === 0n) throw new Error("A model batch estimate must be positive.");
  const floor = integer(parameters.floorBatches ?? DEFAULT_FLOOR_BATCHES);
  const { blocked, nextReset } = planWindow(windows, now, parameters.pausePercent);
  const result: AdmissionDecision = {
    allowed: true, limitUnits,
    remainingUnits: safe(max(0n, BigInt(limitUnits) - spent - reserved)),
    remainingAttempts: safe(max(0n, floor - attempts)),
    ...(nextReset === undefined ? {} : { nextReset }),
  };
  if (blocked) return { ...result, allowed: false, reason: "usage-window" };
  if (!snapshot.ownUsageReadable) {
    if (attempts >= floor) return { ...result, allowed: false, reason: "fallback" };
  } else if (spent + reserved + estimate > BigInt(limitUnits)) return { ...result, allowed: false, reason: "cap" };
  return result;
}
