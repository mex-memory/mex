import { describe, expect, it } from "vitest";
import { budgetLimit, decideAdmission, subtractHeadless, weightedTokens, type BudgetSnapshot } from "../budget-policy.js";

const base: BudgetSnapshot = {
  lastSevenUnits: 0, lastFourWeeksUnits: 0, ownUsageReadable: true,
  spentUnits: 0, reservedUnits: 0, admittedAttempts: 0,
};
const parameters = { referenceBatchUnits: 100 };
const now = Date.parse("2026-11-14T12:00:00Z");

describe("model budget policy, without storage or model calls", () => {
  it("uses the larger weekly base and a fixed seven-batch floor", () => {
    expect(budgetLimit(base, parameters)).toBe(700);
    expect(budgetLimit({ ...base, lastSevenUnits: 100_000, lastFourWeeksUnits: 200_000 }, parameters)).toBe(3_000);
    expect(budgetLimit({ ...base, lastSevenUnits: 100_000, lastFourWeeksUnits: 800_000 }, parameters)).toBe(6_000);
    // The two overlapping windows are never added.
    expect(budgetLimit({ ...base, lastSevenUnits: 100_000, lastFourWeeksUnits: 400_000 }, parameters)).toBe(3_000);
  });
  it("reserves the proposed batch before allowing it, including the equality boundary", () => {
    expect(decideAdmission({ ...base, spentUnits: 500, reservedUnits: 100 }, 100, parameters).allowed).toBe(true);
    expect(decideAdmission({ ...base, spentUnits: 500, reservedUnits: 100 }, 101, parameters)).toMatchObject({ allowed: false, reason: "cap", remainingUnits: 100 });
    // A larger request cannot grow the policy's floor.
    expect(decideAdmission(base, 701, parameters)).toMatchObject({ allowed: false, reason: "cap", limitUnits: 700 });
  });
  it("uses exactly seven admitted attempts when the usage base is unreadable", () => {
    const unreadable = { ...base, ownUsageReadable: false, spentUnits: 10_000, admittedAttempts: 6 };
    expect(decideAdmission(unreadable, 1000, parameters)).toMatchObject({ allowed: true, remainingAttempts: 1 });
    expect(decideAdmission({ ...unreadable, admittedAttempts: 7 }, 1, parameters)).toMatchObject({ allowed: false, reason: "fallback" });
    // Old cached totals do not turn an unreadable source back into a readable one.
    expect(decideAdmission({ ...unreadable, admittedAttempts: 7, lastSevenUnits: 1_000_000 }, 1, parameters).allowed).toBe(false);
  });
  it("holds at 75 percent until the visible window resets", () => {
    const window = { usedPercent: 75, status: "allowed" as const, resetsAt: "2026-11-14T13:00:00Z" };
    expect(decideAdmission(base, 1, parameters, [window], now)).toMatchObject({ allowed: false, reason: "usage-window", nextReset: "2026-11-14T13:00:00.000Z" });
    expect(decideAdmission(base, 1, parameters, [{ ...window, usedPercent: 74.99 }], now).allowed).toBe(true);
    expect(decideAdmission(base, 1, parameters, [window], Date.parse(window.resetsAt)).allowed).toBe(true);
    expect(decideAdmission(base, 1, parameters, [{ ...window, usedPercent: null, status: "rejected" }], now).allowed).toBe(false);
  });
  it("keeps a rejected window without a reset held and treats missing room as unknown", () => {
    expect(decideAdmission(base, 1, parameters, [{ usedPercent: null, status: "rejected", resetsAt: null }], now).allowed).toBe(false);
    expect(decideAdmission(base, 1, parameters, [{ usedPercent: null, status: null, resetsAt: null }], now)).toMatchObject({ allowed: true });
    expect(decideAdmission(base, 1, parameters, [], now).nextReset).toBeUndefined();
  });
  it("keeps the nearest future reset as a scheduling hint without inventing one", () => {
    const windows = [
      { usedPercent: 20, status: null, resetsAt: "2026-11-14T16:00:00Z" },
      { usedPercent: 40, status: null, resetsAt: "2026-11-14T13:00:00Z" },
      { usedPercent: 90, status: null, resetsAt: "2026-11-14T11:00:00Z" },
    ];
    expect(decideAdmission(base, 1, parameters, windows, now)).toMatchObject({ allowed: true, nextReset: "2026-11-14T13:00:00.000Z" });
  });
  it("weights token classes without floating-point rounding or changing raw counts", () => {
    const counts = Object.freeze({ input: 10, cache_write: 20, cache_read: 30, output: 40 });
    expect(weightedTokens(counts, { input: 100, cache_write: 125, cache_read: 10, output: 500 })).toBe(23_800);
    expect(counts).toEqual({ input: 10, cache_write: 20, cache_read: 30, output: 40 });
    expect(subtractHeadless(counts, { input: 20, cache_write: 5, cache_read: 10, output: 40 })).toEqual({ input: 0, cache_write: 15, cache_read: 20, output: 0 });
  });
  it("rejects invalid or overflowing quantities instead of admitting a zero/NaN budget", () => {
    for (const value of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => decideAdmission(base, value, parameters)).toThrow();
      expect(() => budgetLimit({ ...base, lastSevenUnits: value }, parameters)).toThrow();
    }
    expect(() => decideAdmission(base, 0, parameters)).toThrow();
    expect(() => budgetLimit(base, { referenceBatchUnits: 0 })).toThrow();
    expect(() => weightedTokens({ input: Number.MAX_SAFE_INTEGER, cache_write: 0, cache_read: 0, output: 0 }, { input: 2, cache_write: 1, cache_read: 1, output: 1 })).toThrow();
    expect(() => budgetLimit(base, { ...parameters, capBasisPoints: 10_001 })).toThrow();
  });
});
