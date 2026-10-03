/**
 * Natural-language questions against `wiki query` (#235).
 *
 * Every term used to be ANDed, stop words included, so a question returned
 * nothing and read as "there is no knowledge about this". The fixture is shaped
 * like the scaffold that measured it: the project's own name appears in most
 * entities, and the entity that answers a question does not contain the
 * question's verbs.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { rebuildWikiIndex } from "../../index/rebuild.js";
import { openWikiQuery, type SearchPage, type SearchOptions } from "../session.js";
import { openWikiContractReadSession } from "../contract-session.js";
import { planWikiSearch, someTermsExpression, termStem, MAX_QUERY_TERMS } from "../search-plan.js";
import { wikiSearch } from "../../service/read.js";
import { envelopeFor, exitCodeFor, WIKI_EXIT } from "../../cli/envelope.js";
import { createScaffold, steppingClock, type Scaffold } from "../../index/__tests__/harness.js";

const IDS = {
  zeroDeps: "mx_01KRMEXM00JAAVJPQVVRX8N56V",
  smartRouter: "mx_01KS6FPN00RT04JXY9QEG0JN19",
  components: "mx_01KSRGFP00P5TVKWJ2P5Z9DFJV",
  middleware: "mx_01KTAH8Q004DSGTECA5MBCRZ88",
  external: "mx_01KTWJ1R00FFGFA48FZBYSZ90D",
  archived: "mx_01KVEJTS0033N8ZWSQZXJNG34H",
} as const;

function block(id: string, title: string, body: string, status = "promoted"): string {
  return `<!-- mex:entity\nid: ${id}\ntype: decision\nstatus: ${status}\nrevision: 1\n-->\n## ${title}\n\n${body}\n\n`;
}

let scaffold: Scaffold;
let indexPath: string;

beforeAll(() => {
  scaffold = createScaffold();
  indexPath = join(scaffold.root, "wiki.db");
  scaffold.write(
    "context/decisions.md",
    block(IDS.zeroDeps, "Zero runtime dependencies, Web Standards only", "Hono ships with no runtime dependencies.") +
      // The answer to "why is SmartRouter the default?" never says "Hono".
      block(IDS.smartRouter, "Default router is SmartRouter", "SmartRouter picks the fastest router at startup.") +
      block(IDS.archived, "Old router notes", "SmartRouter replaced TrieRouter as the default router in Hono.", "archived"),
  );
  scaffold.write(
    "context/architecture.md",
    block(IDS.components, "Key Components", "Hono's default router is SmartRouter, and Hono composes middleware.") +
      block(IDS.external, "External Dependencies", "Hono depends on the Web platform. Database schema work is out of scope."),
  );
  scaffold.write("patterns/add-middleware.md", block(IDS.middleware, "add-middleware", "Add a Hono middleware and export it."));
  rebuildWikiIndex({ scaffoldRoot: scaffold.root, indexPath, now: steppingClock() });
});

afterAll(() => {
  scaffold.dispose();
});

function search(text: string, options: SearchOptions = {}): SearchPage {
  const opened = openWikiQuery(indexPath);
  if (!opened.ok) throw new Error(opened.diagnostic.message);
  try {
    return opened.value.search(text, options);
  } finally {
    opened.value.close();
  }
}

describe("planning a query", () => {
  it("drops stop words and question words, keeping what carries meaning", () => {
    const plan = planWikiSearch("Why does Hono avoid runtime dependencies?");
    expect(plan.terms).toEqual(["hono", "avoid", "runtime", "dependencies"]);
    expect(plan.ignoredTerms).toEqual(["why", "does"]);
    expect(plan.allTermsExpression).toBe('"hono" AND "avoid" AND "runtime" AND "dependencies"');
  });

  it("treats a contraction's stray letter as a stop word", () => {
    expect(planWikiSearch("Why doesn't setup run?").terms).toEqual(["setup", "run"]);
  });

  it("keeps every word of a query made only of stop words, rather than searching for nothing", () => {
    expect(planWikiSearch("how to").terms).toEqual(["how", "to"]);
    expect(planWikiSearch("how to").ignoredTerms).toEqual([]);
    expect(planWikiSearch("  ?! ").allTermsExpression).toBeNull();
  });

  it("de-duplicates case-insensitively and bounds a long paste", () => {
    expect(planWikiSearch("Router router ROUTER").terms).toEqual(["router"]);
    const long = Array.from({ length: 40 }, (_, index) => `term${index}`).join(" ");
    expect(planWikiSearch(long).terms).toHaveLength(MAX_QUERY_TERMS);
  });

  it("keeps user text out of FTS5 syntax", () => {
    expect(planWikiSearch('NEAR("rotate tokens" OR key*').allTermsExpression).toBe('"near" AND "rotate" AND "tokens" AND "key"');
    expect(() => search('NEAR("rotate')).not.toThrow();
  });
});

describe("stems for the broader tier", () => {
  it.each([
    ["dependencies", "dependenc"],
    ["dependency", "dependenc"],
    ["registration", "registr"],
    ["deployment", "deploy"],
    ["matching", "match"],
    ["stopped", "stop"],
    ["called", "call"],
    ["classes", "class"],
    ["routes", "route"],
    ["route", "rout"],
  ])("%s → %s", (term, stem) => {
    expect(termStem(term)).toBe(stem);
  });

  it("matches identifier-shaped and short words exactly", () => {
    for (const term of ["next_id", "v2", "hono", "npm", "running"]) expect(termStem(term)).toBe(term);
    expect(someTermsExpression("npm")).toBe('"npm"');
    expect(someTermsExpression("dependencies")).toBe('"dependenc" *');
  });
});

describe("natural-language search (#235)", () => {
  it("answers the issue's question with the entity that answers it", () => {
    const page = search("Why does Hono avoid runtime dependencies?");
    expect(page.items[0]).toMatchObject({
      entity: { id: IDS.zeroDeps },
      field: "title",
      match: "some_terms",
      matchedTerms: ["hono", "runtime", "dependencies"],
    });
    expect(page.match).toBe("some_terms");
    expect(page.unmatchedTerms).toEqual(["avoid"]);
    expect(page.ignoredTerms).toEqual(["why", "does"]);
  });

  it("lists every all-terms hit first, then fills the page with labelled broader hits", () => {
    // `Key Components` contains every term. The decision that answers the
    // question does not say "Hono", which used to hide it behind that hit.
    const page = search("Why is SmartRouter the default router in Hono?");
    expect(page.match).toBe("all_terms");
    expect(page.items[0]).toMatchObject({ entity: { id: IDS.components }, match: "all_terms" });
    expect(page.items[0]).not.toHaveProperty("matchedTerms");
    expect(page.items[1]).toMatchObject({
      entity: { id: IDS.smartRouter },
      match: "some_terms",
      matchedTerms: ["smartrouter", "default", "router"],
    });
    expect(page.items.map((hit) => hit.entity.id)).not.toContain(IDS.archived);
    expect(search("Why is SmartRouter the default router in Hono?", { includeArchived: true }).items.map((hit) => hit.entity.id))
      .toContain(IDS.archived);
  });

  it("keeps the keyword form exactly as it was", () => {
    const page = search("runtime dependencies");
    expect(page.items[0]).toMatchObject({ entity: { id: IDS.zeroDeps }, field: "title", match: "all_terms" });
    expect(page.items.every((hit) => hit.match === "all_terms")).toBe(true);
  });

  it("finds an inflected form of a one-word query", () => {
    const page = search("dependency");
    expect(page.match).toBe("some_terms");
    expect(page.items.map((hit) => hit.entity.id)).toEqual(expect.arrayContaining([IDS.zeroDeps, IDS.external]));
  });

  it("does not let a term in most of the wiki carry a match on its own", () => {
    // "hono" is in four of five visible entities; "avoid" is in none.
    const page = search("Hono avoid");
    expect(page.items).toEqual([]);
    expect(page.match).toBe("none");
    expect(page.unmatchedTerms).toEqual(["avoid"]);
  });

  it("still returns nothing for a query about something the wiki does not cover", () => {
    // "schema" alone matches; one distinctive term of three is not an answer.
    const page = search("GraphQL schema federation");
    expect(page.items).toEqual([]);
    expect(page.unmatchedTerms).toEqual(["graphql", "federation"]);
  });

  it("ranks by how much of the question an entity covers, deterministically", () => {
    const question = "Which router does SmartRouter pick at startup by default?";
    const first = search(question).items.map((hit) => hit.entity.id);
    expect(first[0]).toBe(IDS.smartRouter);
    expect(search(question).items.map((hit) => hit.entity.id)).toEqual(first);
  });

  it("gives the Hub's contract session the same answer, in the same order", () => {
    const session = openWikiContractReadSession({ scaffoldRoot: scaffold.root, indexPath });
    try {
      for (const question of ["Why does Hono avoid runtime dependencies?", "Why is SmartRouter the default router in Hono?"]) {
        const hub = session.search({ query: question, limit: 20 });
        expect(hub.items.map((hit) => hit.entity.id)).toEqual(search(question).items.map((hit) => hit.entity.id));
        for (const hit of hub.items) {
          expect(hit.score === undefined).toBe(hit.match === "all_terms");
        }
      }
      expect(session.search({ query: "Hono avoid" }).items).toEqual([]);
    } finally {
      session.close();
    }
  });
});

describe("what `wiki query` tells its caller", () => {
  it("labels a broader answer with a notice, which leaves the exit code alone", () => {
    const result = wikiSearch({ scaffoldRoot: scaffold.root, indexPath, text: "Why does Hono avoid runtime dependencies?" });
    expect(result.data).toMatchObject({ match: "some_terms", unmatchedTerms: ["avoid"] });
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["WIKI_QUERY_PARTIAL_MATCH"]);
    expect(result.diagnostics[0]!.message).toContain("Nothing in the wiki mentions: avoid.");
    expect(exitCodeFor(envelopeFor(result.data, result.diagnostics))).toBe(WIKI_EXIT.ok);
  });

  it("says when nothing matched, and where to look instead", () => {
    const result = wikiSearch({ scaffoldRoot: scaffold.root, indexPath, text: "Kubernetes deployment manifests" });
    expect(result.data.hits).toEqual([]);
    expect(result.data.match).toBe("none");
    const [notice] = result.diagnostics;
    expect(notice).toMatchObject({ code: "WIKI_QUERY_NO_MATCH", severity: "info" });
    expect(notice!.remediation).toContain("ROUTER.md");
    expect(notice!.remediation).toContain("mex graph scope");
    expect(exitCodeFor(envelopeFor(result.data, result.diagnostics))).toBe(WIKI_EXIT.ok);
  });

  it("adds nothing to an answer that contains every term", () => {
    expect(wikiSearch({ scaffoldRoot: scaffold.root, indexPath, text: "runtime dependencies" }).diagnostics).toEqual([]);
  });
});
