import { describe, expect, it } from "vitest";
import { applyDocQuota, clusterLessons, identifiersOf, lessonWords, writerMembers, type Triaged } from "../cluster.js";
import type { Candidate } from "../harvest/types.js";
import type { TriageCategory } from "../triage.js";

let serial = 0;
function item(over: { pull?: number; path?: string; anchor?: string; lesson: string; category?: TriageCategory; strong?: boolean;
  kind?: Candidate["kind"]; id?: string; reviewers?: string[]; at?: string; keep?: boolean }): Triaged {
  const id = over.id ?? `gh:thread:${++serial}`;
  const candidate: Candidate = {
    id, kind: over.kind ?? "review-thread", link: `https://github.com/acme/app/pull/${over.pull ?? 1}`, hash: `sha256:${"0".repeat(64)}`,
    nodeIds: [], at: over.at ?? `2026-0${(serial % 9) + 1}-01T00:00:00Z`, ...(over.pull ? { pull: over.pull } : {}),
    ...(over.path ? { path: over.path } : {}), text: over.lesson,
    ...(over.anchor ? { code: { anchor: over.anchor } } : {}),
    reviewers: over.reviewers ?? ["r1"],
    weights: { actedOn: true, familiar: false, guidelineLink: false, generalising: false, smallPr: true, hotUnknown: false },
    signal: over.strong ? "strong" : "weak",
  };
  return { candidate, triage: { id, keep: over.keep ?? true, category: over.category ?? "api-use", lesson: over.lesson } };
}

describe("clustering lessons across the whole window", () => {
  it("joins the same lesson from PR 3 and PR 40 into one cluster with support 2", () => {
    const clusters = clusterLessons([
      item({ pull: 3, path: "packages/api/src/users.ts", anchor: "console.log(user)", lesson: "Log through `apiLogger`, not console.log, in the API." }),
      item({ pull: 40, path: "packages/api/src/orders.ts", anchor: "console.log(order.id)", lesson: "Use `apiLogger` for logs in packages/api." }),
      item({ pull: 17, path: "packages/web/src/page.tsx", anchor: "fetch(url)", lesson: "Pages read data through `useQuery` hooks.", category: "placement" }),
    ]);
    const logging = clusters.find(cluster => cluster.identifiers.includes("apilogger"))!;
    expect(logging.pulls).toEqual([3, 40]);
    expect(logging.support).toBe(2);
    expect(logging.decision).toBe("write");
    expect(clusters).toHaveLength(2);
  });

  it("keeps one strong comment unticked and drops one weak comment (D1)", () => {
    const clusters = clusterLessons([
      item({ pull: 5, path: "src/db/pool.ts", anchor: "new Pool()", lesson: "Create pools through `makePool` so limits apply (see CONTRIBUTING).", strong: true }),
      item({ pull: 9, path: "src/ui/button.tsx", anchor: "color: red", lesson: "Button colours come from the theme tokens file.", category: "placement" }),
    ]);
    expect(clusters.find(c => c.pulls[0] === 5)!.decision).toBe("propose");
    expect(clusters.find(c => c.pulls[0] === 9)!.decision).toBe("drop");
  });

  it("doesn't link items through an identifier most of the run mentions", () => {
    const shared = "Hono";
    const lessons = [
      `Middleware on \`${shared}.use\` must call next() once.`, `Route params in \`${shared}.get\` are strings; parse numbers.`,
      `Errors in \`${shared}.onError\` keep the status code.`, `Validators on \`${shared}.post\` run before the handler.`,
      `Context vars on \`${shared}.set\` need a typed Variables map.`, `Streaming via \`${shared}.stream\` needs an abort check.`,
    ];
    const clusters = clusterLessons(lessons.map((lesson, i) => item({ pull: 10 + i, path: `src/area${i}/x.ts`, lesson,
      category: (["api-use", "correctness", "tests", "placement", "security", "performance"] as const)[i] })));
    expect(clusters).toHaveLength(6);
  });

  it("links word-alike lessons only within one category", () => {
    const words = "Integration tests must reset the shared database fixture before each suite runs";
    const clusters = clusterLessons([
      item({ pull: 1, path: "a/x.ts", lesson: words, category: "tests" }),
      item({ pull: 2, path: "b/y.ts", lesson: "Integration tests reset the shared database fixture before every suite", category: "tests" }),
      item({ pull: 3, path: "c/z.ts", lesson: "Integration tests reset the shared database fixture before every suite", category: "security" }),
    ]);
    expect(clusters.find(c => c.pulls.includes(1))!.pulls).toEqual([1, 2]);
    expect(clusters.find(c => c.pulls.includes(3))!.pulls).toEqual([3]);
  });

  it("doesn't chain A to C through B when A and C share nothing", () => {
    const clusters = clusterLessons([
      item({ pull: 1, path: "packages/core/a.ts", anchor: "readConfig()", lesson: "Read settings with `readConfig`, never process.env.", strong: true }),
      item({ pull: 2, path: "packages/core/b.ts", anchor: "readConfig(); cacheStore.set()", lesson: "`readConfig` then `cacheStore`: warm the cache once." }),
      item({ pull: 3, path: "packages/core/c.ts", anchor: "cacheStore.clear()", lesson: "Never clear `cacheStore` inside a request." }),
    ]);
    const leader = clusters.find(c => c.pulls.includes(1))!;
    expect(leader.pulls).toEqual([1, 2]);
    expect(clusters.find(c => c.pulls.includes(3))!.pulls).toEqual([3]);
  });

  it("matches an earlier learned entry so the lesson adds support instead of a duplicate", () => {
    const [cluster] = clusterLessons([item({ pull: 8, path: "packages/api/src/a.ts", anchor: "console.log(x)", lesson: "Use `apiLogger` in the API, not console.log." })],
      { earlier: [{ id: "mx_deep" + "c".repeat(32), text: "Log with apiLogger in packages/api.", scope: ["packages/api/**"], patterns: ["console.log("] }] });
    expect(cluster!.earlier).toBe("mx_deep" + "c".repeat(32));
  });

  it("counts history items by commit and treats a doc plus a review as corroborated", () => {
    const clusters = clusterLessons([
      item({ kind: "cause-commit", id: "git:cause:" + "a".repeat(40), path: "src/cache/lru.ts", anchor: "evictAll()", lesson: "`evictAll` in a hot path caused the outage; evict by key.", category: "correctness" }),
      item({ kind: "doc", id: "doc:CONTRIBUTING.md#tests", path: "CONTRIBUTING.md", lesson: "Run `pnpm test:unit` before pushing changes to core packages.", category: "process" }),
      item({ pull: 4, path: "CONTRIBUTING.md", lesson: "Run `pnpm test:unit` before pushing changes to core packages", category: "process" }),
    ]);
    const history = clusters.find(c => c.source === "history")!;
    expect(history.support).toBe(1);
    expect(history.commits).toHaveLength(1);
    const process = clusters.find(c => c.category === "process")!;
    expect(process.decision).toBe("write");
  });
});

describe("cluster helpers", () => {
  it("reads code identifiers from the anchor and code-shaped lesson words", () => {
    const ids = identifiersOf(item({ anchor: "const user = await db.users.findOne(id)", lesson: "Use `findUserById` from @acme/data, not db.users.findOne." }));
    expect(ids).toContain("findone");
    expect(ids).toContain("finduserbyid");
    expect(ids).toContain("@acme/data");
    expect(ids).not.toContain("const");
  });

  it("stems lesson words lightly and drops stop words", () => {
    expect([...lessonWords("Always validate the inputs before using them")].sort()).toEqual(["before", "input", "them", "validate"]);
  });

  it("sends the writer one member per PR first", () => {
    const [cluster] = clusterLessons([1, 1, 2, 3, 4, 5].map(pull => item({ pull, path: "packages/api/x.ts", anchor: "legacyAuth()", lesson: "Never call `legacyAuth` in new handlers." })));
    const pulls = writerMembers(cluster!).map(member => member.candidate.pull);
    expect(pulls).toHaveLength(4);
    expect(new Set(pulls).size).toBe(4);
  });

  it("caps docs at a quarter of written entries when reviews exist", () => {
    const topics = ["Commit messages follow the conventional prefix list", "Release notes are drafted in the changelog folder",
      "Branches are named after their ticket area", "Benchmarks run on the dedicated runner only"];
    const docs = topics.map((lesson, i) => item({ kind: "doc", id: `doc:d${i}.md`, path: `docs/d${i}.md`, lesson, category: "process" }));
    const reviews = [0, 1, 2].map(i => item({ pull: 100 + i, path: `src/r${i}.ts`, anchor: `call${i}Helper()`, lesson: `Review lesson ${i}: use \`call${i}Helper\`.`, strong: true }));
    const quota = applyDocQuota(clusterLessons([...docs, ...reviews]));
    expect(quota.filter(c => c.source === "docs" && c.decision !== "drop")).toHaveLength(1);
    expect(applyDocQuota(clusterLessons(docs)).filter(c => c.decision !== "drop")).toHaveLength(4);
  });
});
