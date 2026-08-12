import { describe, expect, it } from "vitest";
import { extractQueryTerms, identifierComponents, nameMatchQuality } from "../query-terms.js";

describe("graph query terms", () => {
  it("expands camelCase and snake_case identifiers without losing their full name", () => {
    expect(identifierComponents("BudgetLedger")).toEqual(["budgetledger", "budget", "ledger"]);
    expect(identifierComponents("mark_failed!")).toEqual(["mark_failed", "mark", "failed"]);
  });

  it("drops natural-language function words but keeps code-oriented terms", () => {
    const terms = extractQueryTerms("find every call site that invokes mark_failed! on a model");
    expect(terms).toContain("find");
    expect(terms).toContain("call");
    expect(terms).toContain("mark_failed");
    expect(terms).not.toContain("on");
    expect(terms).not.toContain("that");
  });

  it("falls back when the query contains only stop words", () => {
    expect(extractQueryTerms("how does it work")).toEqual(["how", "does", "it", "work"]);
  });

  it("distinguishes exact and component name matches", () => {
    expect(nameMatchQuality("BudgetLedger", "BudgetLedger")).toBe("exact");
    expect(nameMatchQuality("BudgetLedger", "ledger")).toBe("component");
    expect(nameMatchQuality("planSource", "ledger")).toBe("none");
  });
});
