import { describe, expect, it } from "vitest";
import {
  identifierComponents, isDistinctiveIdentifier, planGraphQuery, stemVariants,
} from "../retrieval/query.js";

describe("graph query planning", () => {
  it("splits compound identifiers without losing the full symbol", () => {
    expect(identifierComponents("BudgetLedger")).toEqual(["budgetledger", "budget", "ledger"]);
  });

  it("drops question boilerplate while retaining literal repository terms", () => {
    const plan = planGraphQuery("How are ranked nodes selected?");
    const terms = new Set(plan.terms.map((entry) => entry.term));
    expect(terms).not.toContain("how");
    expect(terms.has("ranked")).toBe(true);
    expect(terms.has("selected")).toBe(true);
  });

  it("does not invent budget/limit synonyms for an allowance query", () => {
    const terms = new Set(planGraphQuery("prevent context allowance overflow").terms.map((entry) => entry.term));
    expect([...terms]).toEqual(expect.arrayContaining(["prevent", "context", "allowance", "overflow"]));
    expect(terms.has("budget")).toBe(false);
    expect(terms.has("limit")).toBe(false);
  });

  it("keeps terse payload vocabulary literal instead of using a synonym table", () => {
    const terms = new Set(planGraphQuery("cap graph payload size").terms.map((entry) => entry.term));
    expect([...terms]).toEqual(expect.arrayContaining(["cap", "payload", "size"]));
    expect(terms.has("budget")).toBe(false);
    expect(terms.has("limit")).toBe(false);
  });

  it("pins distinctive named symbols but never promotes stopwords as identifiers", () => {
    const plan = planGraphQuery("How does BudgetLedger enforce max_output_tokens?");
    expect(plan.explicitIdentifiers).toEqual(["BudgetLedger", "max_output_tokens"]);
    expect(plan.explicitIdentifiers).not.toContain("How");
  });

  it("preserves a private symbol for exact lookup while splitting its identifier", () => {
    const plan = planGraphQuery("How does #newResponse call createResponseInstance?");
    expect(plan.explicitIdentifiers).toEqual(expect.arrayContaining(["#newResponse", "createResponseInstance"]));
    expect(plan.terms.map((entry) => entry.term)).toEqual(expect.arrayContaining(["newresponse", "new", "response"]));
  });

  it("keeps path segments separate instead of concatenating punctuation", () => {
    expect(identifierComponents("src/http/context-cache.ts")).toEqual([
      "src", "http", "context", "cache", "ts",
    ]);
    const terms = planGraphQuery("look in src/http/context-cache.ts").terms.map((entry) => entry.term);
    expect(terms).toEqual(expect.arrayContaining(["src", "http", "context", "cache"]));
    expect(terms).not.toContain("srchttpcontextcachets");
  });

  it("keeps ordinary hyphenated prose out of the exact-symbol channel", () => {
    const plan = planGraphQuery("command-line watch-mode source-file behavior");
    expect(plan.explicitIdentifiers).toEqual([]);
    expect(plan.terms.find((entry) => entry.term === "command")).toMatchObject({
      identifierLike: false,
      weight: 1,
    });
    expect(plan.terms.find((entry) => entry.term === "watch")).toMatchObject({
      identifierLike: false,
      weight: 1,
    });
    expect(plan.terms.find((entry) => entry.term === "source")).toMatchObject({
      identifierLike: false,
      weight: 0.35,
    });
  });

  it("still pins paths, extensions, private and qualified names, and code-shaped ids", () => {
    const plan = planGraphQuery(
      "src/http/context-cache.ts config.json #newResponse Router.create snake_case camelCase Handler2",
    );
    expect(plan.explicitIdentifiers).toEqual(expect.arrayContaining([
      "src/http/context-cache.ts",
      "config.json",
      "#newResponse",
      "Router.create",
      "snake_case",
      "camelCase",
      "Handler2",
    ]));
    expect(isDistinctiveIdentifier("watch-mode")).toBe(false);
    expect(isDistinctiveIdentifier("context-cache.ts")).toBe(true);
  });

  it("adds low-weight derivational prefixes for long tion and sion nouns", () => {
    const plan = planGraphQuery("configuration compilation resolution");
    const terms = new Map(plan.terms.map((entry) => [entry.term, entry]));
    expect(terms.get("confi")).toMatchObject({ stem: true, weight: 0.2 });
    expect(terms.get("compi")).toMatchObject({ stem: true, weight: 0.2 });
    expect(terms.get("resol")).toMatchObject({ stem: true, weight: 0.2 });
    expect(stemVariants("configuration")).toContain("confi");
    expect(stemVariants("compilation")).toContain("compi");
    expect(stemVariants("resolution")).toContain("resol");
    expect(stemVariants("configuration")).not.toContain("configurat");
  });

  it("does not create truncated three-letter stems for ordinary s-plurals", () => {
    expect(stemVariants("files")).toContain("file");
    expect(stemVariants("files")).not.toContain("fil");
    expect(stemVariants("lines")).toContain("line");
    expect(stemVariants("lines")).not.toContain("lin");
    expect(stemVariants("suffixes")).toContain("suffix");
  });
});
