import { describe, it, expect } from "vitest";
import { computeScore } from "../src/drift/scoring.js";
import type { DriftIssue } from "../src/types.js";

function issue(severity: DriftIssue["severity"]): DriftIssue {
  return {
    code: "MISSING_PATH",
    severity,
    file: "test.md",
    line: 1,
    message: "test",
  };
}

describe("computeScore", () => {
  it("returns 100 for no issues", () => {
    expect(computeScore([])).toBe(100);
  });

  it("deducts 10 per error", () => {
    expect(computeScore([issue("error")])).toBe(90);
    expect(computeScore([issue("error"), issue("error")])).toBe(80);
  });

  it("deducts 3 per warning", () => {
    expect(computeScore([issue("warning")])).toBe(97);
  });

  it("deducts 1 per info", () => {
    expect(computeScore([issue("info")])).toBe(99);
  });

  it("combines severities correctly", () => {
    const issues = [issue("error"), issue("warning"), issue("info")];
    expect(computeScore(issues)).toBe(86); // 100 - 10 - 3 - 1
  });

  it("clamps to 0 minimum", () => {
    const many = Array.from({ length: 15 }, () => issue("error"));
    expect(computeScore(many)).toBe(0);
  });
});
