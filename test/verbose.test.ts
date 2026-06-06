import { describe, it, expect, vi } from "vitest";
import { buildVerboseLog } from "../src/drift/index.js";
import { reportJSON } from "../src/reporter.js";
import type { Claim, DriftReport } from "../src/types.js";

function makeClaim(kind: Claim["kind"]): Claim {
  return {
    kind,
    value: "test-value",
    file: "test.md",
    line: 1,
    raw: "test raw",
  };
}

function makeReport(opts?: { verboseLog?: string[] }): DriftReport {
  return {
    score: 85,
    issues: [],
    filesChecked: 3,
    timestamp: "2026-04-10T00:00:00.000Z",
    verboseLog: opts?.verboseLog,
  };
}

describe("buildVerboseLog", () => {
  it("returns file count and claim breakdown", () => {
    const claims: Claim[] = [
      makeClaim("path"),
      makeClaim("path"),
      makeClaim("command"),
      makeClaim("dependency"),
    ];
    const checkerCounts: Array<[string, number]> = [
      ["path", 1],
      ["edges", 0],
    ];

    const log = buildVerboseLog(5, claims, checkerCounts);

    expect(log[0]).toBe("Scaffold files scanned: 5");
    expect(log[1]).toContain("Claims extracted: 4");
    expect(log[1]).toContain("path: 2");
    expect(log[1]).toContain("command: 1");
    expect(log[1]).toContain("dependency: 1");
    expect(log[2]).toBe("Checker path: 1 issue");
    expect(log[3]).toBe("Checker edges: 0 issues");
  });

  it("handles empty claims and checkers", () => {
    const log = buildVerboseLog(0, [], []);
    expect(log).toHaveLength(2);
    expect(log[0]).toBe("Scaffold files scanned: 0");
    expect(log[1]).toContain("Claims extracted: 0");
  });
});

describe("reportJSON verbose gating", () => {
  it("excludes verboseLog from JSON when verbose is off", () => {
    const report = makeReport({ verboseLog: ["line1", "line2"] });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    reportJSON(report);

    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output.verboseLog).toBeUndefined();
    spy.mockRestore();
  });

  it("includes verboseLog in JSON when verbose is on", () => {
    const report = makeReport({ verboseLog: ["line1", "line2"] });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    reportJSON(report, { verbose: true });

    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output.verboseLog).toEqual(["line1", "line2"]);
    spy.mockRestore();
  });
});
