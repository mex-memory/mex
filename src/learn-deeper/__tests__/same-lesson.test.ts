import { describe, expect, it } from "vitest";
import { clusterLessons, lessonMatch, type Triaged } from "../cluster.js";
import type { Candidate } from "../harvest/types.js";

let next = 0;
function said(lesson: string, path = "src/app.ts", category: Triaged["triage"]["category"] = "api-use", anchor = ""): Triaged {
  const id = `gh:thread:T${++next}`;
  const region = { path, commit: "b".repeat(40), start: 1, end: 1, text: anchor || lesson, hash: "sha256:" + "a".repeat(64) };
  return { candidate: { id, kind: "review-thread", link: `https://github.com/acme/app/pull/${next}#discussion_r${next}`, hash: region.hash, nodeIds: [`N${next}`],
    at: "2026-05-01T00:00:00Z", pull: next, path, text: lesson, code: { before: region, after: region, ...(anchor ? { anchor } : {}) }, reviewers: [`r${next}`],
    weights: { actedOn: true, familiar: true, guidelineLink: false, generalising: true, smallPr: true, hotUnknown: false }, signal: "strong" } as Candidate,
  triage: { id, keep: true, category, lesson } };
}

// Labelled before the matching was written.
const same: Array<[string, string]> = [
  ["Give every `createMiddleware` call a name, so traces are readable.", "Name each `createMiddleware` so it shows up in traces."],
  ["Throw errors instead of returning null from the loaders.", "Loaders should throw errors rather than returning null."],
  ["Log through `apiLogger`, not console.log.", "Don't use console.log in the API; use `apiLogger`."],
  ["Use `formatDate` from utils instead of calling toISOString directly.", "Call the shared `formatDate` helper rather than toISOString."],
  ["Close the database connection with defer in every handler.", "Handlers must defer closing the database connection."],
  ["Don't commit `it.only` in tests.", "Remove `it.only` before merging tests."],
  ["Prefer `Array.from` over spreading iterators in hot paths.", "In hot paths use `Array.from`, not spread, for iterators."],
  ["Add a changeset for every public API change.", "Public API changes need a changeset."],
  ["Validate request bodies with `zValidator`.", "Use `zValidator` to validate request bodies instead of parsing by hand."],
];
const different: Array<[string, string]> = [
  ["Give every `createMiddleware` call a name, so traces are readable.", "Return early from `createMiddleware` handlers instead of nesting the next call."],
  ["Give every `createMiddleware` call a name, so traces are readable.", "Don't re-export `createMiddleware` from the client bundle; it pulls in node types."],
  ["Use `fetchWithRetry` for internal calls.", "Don't use `fetchWithRetry` for internal calls; it hides outages."],
  ["Cache `getUser` results per request.", "Never cache `getUser` results across requests."],
  ["Throw `HTTPException` for client errors.", "Pass a cause when creating `HTTPException`."],
  ["Document new `RequestHandler` options in the README.", "Keep `RequestHandler` options optional."],
  ["Use double quotes in snapshot names.", "Sort imports by package first."],
  ["Write tests for `parseHeader` with malformed input.", "`parseHeader` should return undefined for malformed input."],
  ["Use `ctx.header` to set response headers.", "Use `ctx.header` to read request headers."],
  ["Avoid default exports in packages/ui.", "Avoid default parameters in packages/ui."],
  ["Use `useMemo` for expensive lists.", "Don't use `useMemo` for cheap values."],
  ["Use `isolate` instead of `vm`.", "Use `vm` instead of `isolate`."],
  ["Use `readFile` with utf8 encoding.", "Use `writeFile` with utf8 encoding."],
];
// Pairs it still gets wrong, kept here so a change shows up.
const known: Array<[string, string, "same" | "different"]> = [
  // Word order carries the meaning, and the matching reads words, not order.
  ["Run migrations before deploying workers.", "Run workers before deploying migrations.", "different"],
];

describe("the same lesson, not only the same API", () => {
  it.each(same)("same: %s | %s", (a, b) => {
    expect(lessonMatch(said(a), said(b))).toBe("same");
    expect(clusterLessons([said(a), said(b)])).toHaveLength(1);
  });
  it.each(different)("different: %s | %s", (a, b) => {
    expect(lessonMatch(said(a), said(b))).not.toBe("same");
    expect(clusterLessons([said(a), said(b)]).map(cluster => cluster.support)).toEqual([1, 1]);
  });
  it("gives the same answer whichever lesson comes first", () => {
    for (const [a, b] of [...same, ...different]) expect(lessonMatch(said(b), said(a))).toBe(lessonMatch(said(a), said(b)));
  });
  it("reports what it still gets wrong", () => {
    for (const [a, b, label] of known) expect(lessonMatch(said(a), said(b)) === "same" ? "same" : "different").not.toBe(label);
  });
  it("doesn't merge two lessons because their comments sit on the same API call", () => {
    const line = "app.use(createMiddleware(async (c, next) => { await next() }))";
    expect(clusterLessons([said("Give every middleware a name, so traces are readable.", "src/a.ts", "api-use", line),
      said("Return early from handlers instead of nesting the next call.", "src/a.ts", "api-use", line)])).toHaveLength(2);
  });
  it("needs a closer match across categories", () => {
    expect(lessonMatch(said("Name each `createMiddleware` so it shows up in traces."),
      said("Give every `createMiddleware` call a name, so traces are readable.", "src/app.ts", "tests"))).not.toBe("same");
  });
  it("calls a shared subject related, so a dropped rule can make a lesson wait but not vanish", () => {
    expect(lessonMatch(said("Give every `createMiddleware` call a name, so traces are readable."),
      said("Return early from `createMiddleware` handlers instead of nesting the next call."))).toBe("related");
    expect(lessonMatch(said("Use double quotes in snapshot names."), said("Sort imports by package first."))).toBe("none");
  });
});
