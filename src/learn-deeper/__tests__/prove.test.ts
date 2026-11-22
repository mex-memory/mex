import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PatternCandidate, PatternVerdict } from "../../knowledge/pattern-check.js";
import { clusterLessons, type Cluster, type Triaged } from "../cluster.js";
import type { PinnedTree } from "../git.js";
import type { Candidate, Region } from "../harvest/types.js";
import { addedOccurrences, proveEntry, processConfirmed, type ProofContext } from "../prove.js";
import { routeEntry } from "../route.js";
import { parseTriage } from "../triage.js";
import { packClusters, parseWriter, type WriterEntry } from "../write.js";

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const region = (path: string, start: number, text: string, commit = "b".repeat(40)): Region =>
  ({ path, commit, start, end: start + text.split("\n").length - 1, text, hash: sha(text) });

/** Mirrors the native self-check's literal rules closely enough to test the proof's decisions. */
function fakePatterns(common = new Set<string>()) {
  return (candidates: readonly PatternCandidate[]): PatternVerdict[] => candidates.map(c => {
    const has = (code: string) => code.includes(c.pattern);
    const no = (reason: string): PatternVerdict => ({ keep: false, reason, files: 10, matched: 0 });
    if (c.type === "required") {
      if (!has(c.fixed)) return no("it doesn't match the fixed code");
      if (has(c.objected)) return no("the objected code already had it");
      return { keep: true, reason: "matches the fix only", files: 0, matched: 0 };
    }
    if (!has(c.objected)) return no("it doesn't match the code the reviewer objected to");
    if (c.fixed && has(c.fixed)) return no("it still matches the fixed code");
    if (common.has(c.pattern)) return { keep: false, reason: "already in 6 of 10 the area's files", files: 10, matched: 6 };
    return { keep: true, reason: "matches the objected code only, and is rare in the area", files: 10, matched: 0 };
  });
}

function tree(files: Record<string, string>): PinnedTree {
  return { root: ".", head: "c".repeat(40), paths: () => Object.keys(files), has: (p: string) => p in files,
    read: async (p: string) => files[p] } as unknown as PinnedTree;
}

const HEAD = {
  "packages/api/src/users.ts": "import { apiLogger } from \"../log\";\nexport function list() { apiLogger.info(\"list\"); }\n",
  "packages/api/src/orders.ts": "import { apiLogger } from \"../log\";\nexport function make() { apiLogger.info(\"make\"); }\n",
  "packages/api/src/log.ts": "export const apiLogger = { info() {} };\n",
  "CONTRIBUTING.md": "# Contributing\n\n## Commits\n\nCommit messages start with a conventional prefix like fix: or feat:.\n",
};

function thread(pull: number, file: string, over: Partial<Candidate> = {}): Candidate {
  const before = region(file, 10, "export function list() {\n  console.log(\"list\");\n}");
  const after = region(file, 10, "export function list() {\n  apiLogger.info(\"list\");\n}");
  return {
    id: `gh:thread:${pull}`, kind: "review-thread", link: `https://github.com/acme/app/pull/${pull}#discussion_r${pull}`,
    hash: sha(`thread ${pull}`), nodeIds: [`N${pull}`], at: `2026-0${pull % 9 + 1}-02T00:00:00Z`, pull, path: file,
    text: "Please don't use console.log in the API: it skips our structured logs. Use apiLogger instead.",
    code: { before, after, anchor: "  console.log(\"list\");" }, reviewers: ["r1"],
    weights: { actedOn: true, familiar: true, guidelineLink: false, generalising: true, smallPr: true, hotUnknown: false },
    signal: "strong", ...over,
  };
}

function clusterOf(candidates: Candidate[], lesson = "Log through `apiLogger`, not console.log, in packages/api."): Cluster {
  const items: Triaged[] = candidates.map(candidate => ({ candidate, triage: { id: candidate.id, keep: true, category: candidate.kind === "doc" ? "process" : "api-use", lesson } }));
  const [cluster] = clusterLessons(items);
  return cluster!;
}

function draft(cluster: Cluster, over: Partial<WriterEntry> = {}): WriterEntry {
  const id = cluster.members[0]!.candidate.id;
  return {
    cluster: cluster.key, route: "code-rule", kind: "rule", claim: "Log through apiLogger in packages/api, not console.log.",
    why: "console.log skips the structured logs.",
    clauses: [
      { text: "Log through apiLogger in packages/api, not console.log.", quotes: [{ id, quote: "Use apiLogger instead." }] },
      { text: "console.log skips the structured logs.", quotes: [{ id, quote: "it skips our structured logs" }] },
    ],
    scope: ["packages/api/**"], when: [{ type: "anti", match: "literal", pattern: "console.log(" }],
    fix: { pair: 0, start: 11, end: 11 }, examples: { flag: "console.log(user)", ok: "apiLogger.info(user)" }, aliases: [], ...over,
  };
}

const context = (over: Partial<ProofContext> = {}): ProofContext => ({
  tree: tree(HEAD), check: { projectPath: "." }, patterns: fakePatterns(), history: async () => "", ...over,
});

describe("proving a learned rule", () => {
  it("keeps a pattern that matches the reviewed code and not the fix, with fixture and fix target, complete", async () => {
    const cluster = clusterOf([thread(3, "packages/api/src/users.ts"), thread(40, "packages/api/src/orders.ts")]);
    const proof = await proveEntry(draft(cluster), cluster, context());
    expect(proof.dropped).toBeUndefined();
    expect(proof.when.map(item => item.pattern)).toEqual(["console.log("]);
    expect(proof.fix).toMatchObject({ snippet: "  apiLogger.info(\"list\");", commit: "b".repeat(40), lines: "11-11" });
    expect(proof.fixLiteral).toBe("apiLogger.info(");
    const routed = routeEntry(proof, { host: "github.com", slug: "acme/app" }, { id: "best", version: "test" });
    if ("dropped" in routed) throw new Error(routed.dropped);
    const kinds = routed.proposal.checks!.map(check => `${check.kind}:${check.role}`);
    expect(kinds).toEqual(expect.arrayContaining(["fixture:complete", "pattern:complete", "pattern:supporting", "scope:complete", "source:supporting"]));
    expect(routed.status).toBe("active");
    expect(routed.proposal.fix?.snippet).toContain("apiLogger.info");
    expect(routed.proposal.label).toBe("Learned from 2 PRs, 1 maintainer");
    expect(routed.proposal.source.quote!.split(/\s+/u).length).toBeLessThanOrEqual(25);
  });

  it("drops a pattern that also matches a fixed version, and says why for the repair turn", async () => {
    const leaky = thread(7, "packages/api/src/orders.ts", { code: {
      before: region("packages/api/src/orders.ts", 4, "export function make() { console.log(\"a\"); }"),
      after: region("packages/api/src/orders.ts", 4, "export function make() { console.log(\"kept on purpose\"); apiLogger.info(\"a\"); }"),
      anchor: "export function make() { console.log(\"a\"); }" } });
    const cluster = clusterOf([thread(3, "packages/api/src/users.ts"), leaky]);
    const proof = await proveEntry(draft(cluster), cluster, context());
    expect(proof.when).toEqual([]);
    expect(proof.failures.join(" ")).toMatch(/matches the fixed code of pair/u);
  });

  it("catches a counter-example the contrast check skips: a pair whose reviewed code lacks the pattern but whose fix has it", async () => {
    const other = thread(9, "packages/api/src/orders.ts", { code: {
      before: region("packages/api/src/orders.ts", 4, "make()"),
      after: region("packages/api/src/orders.ts", 4, "make(); console.log(\"debug\")"), anchor: "make()" } });
    const cluster = clusterOf([thread(3, "packages/api/src/users.ts"), other]);
    const proof = await proveEntry(draft(cluster), cluster, context());
    expect(proof.when).toEqual([]);
  });

  it("rejects a pattern that matches its own ok example", async () => {
    const cluster = clusterOf([thread(3, "packages/api/src/users.ts")]);
    const proof = await proveEntry(draft(cluster, { examples: { flag: "console.log(x)", ok: "console.log(x) // allowed in tests" } }), cluster, context());
    expect(proof.when).toEqual([]);
    expect(proof.failures.join(" ")).toMatch(/ok" example/u);
  });

  it("narrows or drops a pattern common at HEAD for one PR, and keeps it as a migration for two", async () => {
    const one = clusterOf([thread(3, "packages/api/src/users.ts")]);
    const single = await proveEntry(draft(one), one, context({ patterns: fakePatterns(new Set(["console.log("])) }));
    expect(single.when).toEqual([]);
    expect(single.failures.join(" ")).toMatch(/narrow the scope/u);
    const two = clusterOf([thread(3, "packages/api/src/users.ts"), thread(40, "packages/api/src/orders.ts")]);
    const double = await proveEntry(draft(two), two, context({ patterns: fakePatterns(new Set(["console.log("])) }));
    expect(double.when[0]!.migration).toBe(true);
  });

  it("removes an unsupported clause and drops an entry whose claim is invented", async () => {
    const cluster = clusterOf([thread(3, "packages/api/src/users.ts")]);
    const invented = draft(cluster, { clauses: [
      { text: "Log through apiLogger in packages/api, not console.log.", quotes: [{ id: cluster.members[0]!.candidate.id, quote: "Use apiLogger instead." }] },
      { text: "Logs are shipped to the billing team nightly.", quotes: [{ id: cluster.members[0]!.candidate.id, quote: "shipped to billing nightly" }] },
    ] });
    const proof = await proveEntry(invented, cluster, context());
    expect(proof.reasons).toEqual([]);
    const noClaim = draft(cluster, { clauses: [{ text: "Log through apiLogger.", quotes: [{ id: cluster.members[0]!.candidate.id, quote: "we always use apiLogger" }] }] });
    expect((await proveEntry(noClaim, cluster, context())).dropped).toMatch(/claim/u);
  });

  it("lets history decide: a one-PR lesson the team kept breaking loses its pattern; a two-PR one starts unticked", async () => {
    const log = ["\u0000commit 1", "+  console.log(a)", "\u0000commit 2", "+  console.log(b)", "\u0000commit 3", "+console.log(c)"].join("\n");
    const one = clusterOf([thread(3, "packages/api/src/users.ts")]);
    expect((await proveEntry(draft(one), one, context({ history: async () => log }))).when).toEqual([]);
    const two = clusterOf([thread(3, "packages/api/src/users.ts"), thread(40, "packages/api/src/orders.ts")]);
    const proof = await proveEntry(draft(two), two, context({ history: async () => log }));
    expect(proof.notAlwaysFollowed).toBe(true);
    const routed = routeEntry(proof, { host: "github.com", slug: "acme/app" }, { id: "best", version: "test" });
    expect("dropped" in routed ? "" : routed.status).toBe("proposed");
  });

  it("drops a ruled-out lesson without a maintainer's contrastive reason", async () => {
    const closed = thread(12, "packages/api/src/users.ts", { kind: "closed-pr", text: "Closing this one." });
    const cluster = clusterOf([closed], "Don't add a second logger package.");
    const proof = await proveEntry(draft(cluster, { route: "ruled-out", kind: "decision", when: [],
      clauses: [{ text: "Don't add a second logger.", quotes: [{ id: closed.id, quote: "Closing this one." }] }] }), cluster, context());
    expect(proof.dropped).toMatch(/contrastive/u);
  });

  it("makes a confirmed process rule repo-wide and routes an unconfirmed one as scoped prose", async () => {
    const cluster = clusterOf([thread(3, "packages/api/src/users.ts")]);
    const process = await proveEntry(draft(cluster, { route: "process-rule", when: [], fix: undefined, claim: "Commit messages start with a conventional prefix.",
      clauses: [{ text: "Commit messages start with a conventional prefix.", quotes: [{ id: cluster.members[0]!.candidate.id, quote: "Use apiLogger instead." }] }] }), cluster, context());
    expect(process.scope).toEqual(["**"]);
    expect(processConfirmed({ claim: "Name handlers after their route.", why: "" })).toBe(false);
  });

  it("anchors a doc lesson to its quoted passage, complete when the doc is the only evidence", async () => {
    const text = "Commit messages start with a conventional prefix like fix: or feat:.";
    const doc: Candidate = { id: "doc:CONTRIBUTING.md#commits", kind: "doc", link: "CONTRIBUTING.md", hash: sha(text), nodeIds: [], at: "2026-05-01T00:00:00Z",
      path: "CONTRIBUTING.md", text, document: { headings: ["Contributing", "Commits"], consumerUsage: false }, reviewers: [],
      weights: { actedOn: false, familiar: false, guidelineLink: false, generalising: false, smallPr: false, hotUnknown: false }, signal: "weak" };
    const cluster = clusterOf([doc], "Commit messages use conventional prefixes.");
    const proof = await proveEntry(draft(cluster, { route: "process-rule", when: [], fix: undefined, scope: [], claim: "Commit messages start with a conventional prefix.",
      clauses: [{ text: "Commit messages start with a conventional prefix.", quotes: [{ id: doc.id, quote: "Commit messages start with a conventional prefix" }] }] }), cluster, context());
    const routed = routeEntry(proof, { host: "github.com", slug: "acme/app" }, { id: "best", version: "test" });
    if ("dropped" in routed) throw new Error(routed.dropped);
    expect(routed.proposal.checks!.find(check => check.kind === "quote")).toMatchObject({ role: "complete", target: { file: "CONTRIBUTING.md", heading: "Commits" } });
    expect(routed.proposal.source.type).toBe("docs");
  });

  it("counts later commits that added a literal", () => {
    expect(addedOccurrences("\u0000commit a\n+x foo(\n+foo(\n\u0000commit b\n-foo(\n\u0000commit c\n+++ b/foo(\n+bar foo(", "foo(")).toBe(2);
  });
});

describe("writer and triage replies", () => {
  const cluster = clusterOf([thread(3, "packages/api/src/users.ts")]);
  it("keeps one entry per known cluster with a kind its route allows", () => {
    const good = draft(cluster);
    const outcome = parseWriter(JSON.stringify({ entries: [good, good, { ...good, cluster: "nope" }, { ...good, kind: "decision" }] }), [cluster]);
    expect(outcome.entries).toHaveLength(1);
    expect(outcome.rejected.map(item => item.reason)).toEqual(["duplicate-cluster", "unknown-cluster", "duplicate-cluster"]);
    expect(parseWriter(JSON.stringify({ entries: [{ ...good, kind: "decision" }] }), [cluster]).rejected[0]!.reason).toBe("kind-route");
    expect(parseWriter("not json", [cluster]).response).toBe("invalid-json");
  });

  it("packs at most six clusters into one writer call", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ ...cluster, key: `k${i}` }));
    expect(packClusters(many, { linters: [] }).map(batch => batch.length)).toEqual([6, 6, 1]);
  });

  it("drops a triage keep in a category that is never kept, and reports what the reply left out", () => {
    const candidates = [thread(1, "a.ts"), thread(2, "b.ts")];
    const outcome = parseTriage(JSON.stringify({ results: [{ id: candidates[0]!.id, keep: true, category: "readability", lesson: "Name it better." }] }), candidates);
    expect(outcome.results[0]!.keep).toBe(false);
    expect(outcome.missing).toEqual([candidates[1]!.id]);
  });
});
