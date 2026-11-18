import { describe, expect, it } from "vitest";
import { parseStatusLog, rollingPrecision, type StatusChange } from "../measure.js";

const h = (n: number) => n.toString(16).padStart(40, "0");
const change = (n: number, files: string[], deleted: string[] = []): StatusChange => ({ hash: h(n), files: [...files, ...deleted], deleted });

describe("rolling held-out measure", () => {
  it("reads name-status logs, keeping deletions", () => {
    const text = `\x1e${h(2)}\n\nM\tsrc/a.ts\nD\tsrc/old.ts\nA\tsrc/new.ts\n\x1e${h(1)}\n\nM\tREADME.md\n`;
    expect(parseStatusLog(text)).toEqual([
      { hash: h(2), files: ["src/a.ts", "src/old.ts", "src/new.ts"], deleted: ["src/old.ts"] },
      { hash: h(1), files: ["README.md"], deleted: [] },
    ]);
  });

  it("scores each test change with pairs learned only before it, per kind", () => {
    const history = [
      ...Array.from({ length: 4 }, (_, i) => change(i + 1, ["src/cookie.ts", "src/cookie.test.ts"])),
      ...Array.from({ length: 4 }, (_, i) => change(i + 5, ["api/route.ts", "web/client.ts"])),
      change(9, ["src/cookie.ts", "src/cookie.test.ts"]),
      change(10, ["api/route.ts"]),
    ];
    const result = rollingPrecision(history, [8, 9], { resamples: 200 });
    expect(result.tests).toBe(2);
    expect(result.kinds.test).toMatchObject({ firings: 2, hits: 2, precision: 1 });
    expect(result.kinds.related).toMatchObject({ firings: 1, hits: 0, precision: 0 });
    expect(result.kinds.all).toMatchObject({ firings: 3, hits: 2, precision: 0.667 });
    expect(result.coverage).toBe(1);
  });

  it("re-mines on the given cadence and never fires at a file deleted by then", () => {
    const pair = (n: number) => change(n, ["a.ts", "b.ts"]);
    const history = [pair(1), pair(2), pair(3), pair(4), change(5, ["c.ts"], ["b.ts"]), change(6, ["a.ts"]), change(7, ["a.ts"])];
    expect(rollingPrecision(history, [5, 6], { refreshEvery: 1, resamples: 50 }).kinds.all.firings).toBe(0);
    // Mined once before the deletion, the stale pairs keep firing: deleting b.ts fires b.ts>a.ts, then a.ts>b.ts twice.
    expect(rollingPrecision(history, [4, 5, 6], { refreshEvery: 400, resamples: 50 }).kinds.all).toMatchObject({ firings: 3, hits: 0 });
  });
});
