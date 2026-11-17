import { describe, expect, it } from "vitest";
import { whatLine, type SessionSummary } from "../what.js";

describe("session receipt explanation", () => {
  it("shows counts and titles without entry text or clock times", () => {
    const s: SessionSummary = { session: "s", gave: 2, withheld: 1, replaced: 0, estimatedFalse: 0, closedDeliveries: 0, partial: false, items: [
      { id: "mx_ruleaa", kind: "rule", level: "team", title: "Use the pool", action: "given", detail: "" },
      { id: "mx_recipe", kind: "recipe", level: "team", title: "Run unit tests", action: "given", detail: "" },
    ] };
    expect(whatLine(s)).toBe("MEX · this session: gave 2 items (1 recipe, 1 team rule) · withheld 1 out of date · replaced 0 long outputs · details: mex status");
  });
});
