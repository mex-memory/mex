import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PatternCandidate, PatternVerdict } from "../../knowledge/pattern-check.js";
import { realPath } from "../../record/project.js";
import { clusterLessons, type Cluster, type Triaged } from "../cluster.js";
import type { PinnedTree } from "../git.js";
import type { Candidate, Region } from "../harvest/types.js";
import { PIPELINE_LIMITS } from "../pipeline.js";
import { addedOccurrences, proveEntry, processConfirmed, type ProofContext } from "../prove.js";
import { keptQuote, routeEntry } from "../route.js";
import { parseTriage } from "../triage.js";
import { packClusters, parseWriter, type WriterEntry } from "../write.js";

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const region = (path: string, start: number, text: string, commit = "b".repeat(40)): Region =>
  ({ path, commit, start, end: start + text.split("\n").length - 1, text, hash: sha(text) });

/** Mirrors the native self-check's literal rules closely enough to test the proof's decisions. */
function fakePatterns(common = new Set<string>()) {
  return (candidates: readonly PatternCandidate[]): PatternVerdict[] => candidates.map(c => {
    const has = (code: string) => code.includes(c.pattern);
    const no = (reason: string): PatternVerdict => ({ keep: false, reason, common: false, files: 0, matched: 0, occurrences: 0 });
    if (c.type === "required") {
      if (!has(c.fixed)) return no("it doesn't match the fixed code");
      if (has(c.objected)) return no("the objected code already had it");
      return { ...no("matches the fix only"), keep: true };
    }
    if (!has(c.objected)) return no("it doesn't match the code the reviewer objected to");
    if (c.fixed && has(c.fixed)) return no("it still matches the fixed code");
    if (common.has(c.pattern)) return { ...no("widespread at HEAD (6 occurrences in 6 of 10 scoped files)"), common: true, files: 10, matched: 6, occurrences: 6 };
    return { ...no("matches the objected code only, and is rare in the area"), keep: true, files: 10 };
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
  const everyone = cluster.members.filter(member => member.candidate.text.includes("Use apiLogger instead.")).slice(0, 4)
    .map(member => ({ id: member.candidate.id, quote: "Use apiLogger instead." }));
  return {
    cluster: cluster.key, route: "code-rule", kind: "rule", claim: "Log through apiLogger in packages/api, not console.log.",
    why: "console.log skips the structured logs.",
    clauses: [
      { text: "Log through apiLogger in packages/api, not console.log.", quotes: everyone.length ? everyone : [{ id, quote: "Use apiLogger instead." }] },
      { text: "console.log skips the structured logs.", quotes: [{ id, quote: "it skips our structured logs" }] },
    ],
    scope: ["packages/api/**"], when: [{ type: "anti", match: "literal", pattern: "console.log(" }],
    fix: { pair: 0, start: 11, end: 11 }, examples: { flag: "console.log(user)", ok: "apiLogger.info(user)" }, aliases: [], ...over,
  };
}

const context = (over: Partial<ProofContext> = {}): ProofContext => ({
  tree: tree(HEAD), check: { projectPath: "." }, patterns: fakePatterns(), history: async () => "", ...over,
});

it("keeps a quote that runs over a line break, as the gate will look for it", () => {
  const proof = (text: string, quote: string) => ({ cluster: { members: [{ candidate: { id: "doc:CONTRIBUTING.md#style", text } }] },
    quotes: [{ id: "doc:CONTRIBUTING.md#style", quote }] }) as unknown as Parameters<typeof keptQuote>[0];
  for (const quote of ["Handlers use the api\nlogger, never console.", "Handlers use the api logger,  never console."]) {
    const kept = keptQuote(proof("# Style\n\nHandlers use the api\n  logger, never console.\n", quote))!;
    expect(kept.quote).toBe("Handlers use the api logger, never console.");
    expect(kept.text).toContain(kept.quote);
  }
  expect(keptQuote(proof("Handlers use the api logger.", "Handlers use console."))).toBeUndefined();
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


  it("keeps a pattern proven on one pair when another member shows the lesson in another shape, and stores only that pair", async () => {
    const path = "packages/api/src/orders.ts";
    const other = thread(9, path, { code: {
      before: region(path, 4, "make()"),
      after: region(path, 4, "apiLogger.info(result)"),
    } });
    const cluster = clusterOf([thread(3, "packages/api/src/users.ts"), other]);
    const proof = await proveEntry(draft(cluster), cluster, context());
    expect(proof.when).toHaveLength(1);
    const routed = routeEntry(proof, { host: "github.com", slug: "acme/app" }, { id: "best", version: "test" });
    if ("dropped" in routed) throw new Error(routed.dropped);
    const fixtures = routed.proposal.checks!.filter(check => check.kind === "fixture") as unknown as Array<{ target: { pairs: Array<{ path: string }>; proves: number[] } }>;
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]!.target.proves).toEqual([0]);
    expect(fixtures[0]!.target.pairs.map(pair => pair.path)).toEqual(["packages/api/src/users.ts"]);
  });

  it("keeps the pattern of a fix that only removes code, and drops it when the code a fix introduced is gone today", async () => {
    const path = "packages/api/src/users.ts";
    const removal = thread(5, path, { code: {
      before: region(path, 10, "export function list() {\n  console.log(\"list\");\n  return rows;\n}"),
      after: region(path, 10, "export function list() {\n  return rows;\n}"),
      anchor: "  console.log(\"list\");",
    } });
    const cleanup = clusterOf([removal]);
    const kept = await proveEntry(draft(cleanup, { fix: { pair: 0, start: 10, end: 11 }, examples: { flag: "console.log(user)", ok: "return rows" } }),
      cleanup, context());
    expect(kept.when.map(item => item.pattern)).toEqual(["console.log("]);
    expect(kept.fixLiteral).toBeUndefined();
    // The fix called apiLogger.info, and nothing in scope calls it today: the team moved on.
    const moved = clusterOf([thread(3, path)]);
    const gone = await proveEntry(draft(moved), moved, context({ tree: tree({ ...HEAD,
      [path]: "export function list() { logger.write(\"list\"); }\n", "packages/api/src/orders.ts": "export function make() {}\n" }) }));
    expect(gone.when).toEqual([]);
    expect(gone.failures.join(" ")).toMatch(/the code the fix introduced isn't in scope today/u);
  });

  it("requires the flag example to demonstrate the pattern", async () => {
    const cluster = clusterOf([thread(3, "packages/api/src/users.ts")]);
    const proof = await proveEntry(draft(cluster, { examples: { flag: "doWork()", ok: "apiLogger.info(user)" } }), cluster, context());
    expect(proof.when).toEqual([]);
    expect(proof.failures.join(" ")).toContain("does not separate its flag and ok examples");
  });

  it("drops a corroborated review claim when there is no supported scope", async () => {
    const first = thread(3, "packages/api/src/users.ts", { path: undefined, code: undefined });
    const second = thread(40, "packages/api/src/orders.ts", { path: undefined, code: undefined });
    const cluster = clusterOf([first, second]);
    const result = await proveEntry(draft(cluster, { scope: ["**"], when: [], fix: undefined }), cluster, context());
    expect(result.dropped).toBe("nothing today for it to govern");
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
    expect(single.failures.join(" ")).toContain("6 occurrences in 6 of 10 scoped files). Narrow the scope");
    const two = clusterOf([thread(3, "packages/api/src/users.ts"), thread(40, "packages/api/src/orders.ts")]);
    const double = await proveEntry(draft(two), two, context({ patterns: fakePatterns(new Set(["console.log("])) }));
    expect(double.when[0]!.migration).toBe(true);
    const routed = routeEntry(double, { host: "github.com", slug: "acme/app" }, { id: "best", version: "test" });
    if ("dropped" in routed) throw new Error(routed.dropped);
    expect(routed.proposal.label).toBe("Learned from 2 PRs, 1 maintainer · migration in progress");
    expect(routed.proposal.text).toContain("Older code here still does this; don't add more.");
  });

  it("cannot establish rarity from a partially staged scope", async () => {
    const cluster = clusterOf([thread(3, "packages/api/src/users.ts")]);
    const proof = await proveEntry(draft(cluster), cluster, context({
      check: { projectPath: ".", checkTree: ".", checkIndex: { projectId: "fixture", recordDirectory: "." } },
      patterns: candidates => fakePatterns()(candidates).map(verdict => ({ ...verdict, files: 2 })),
    }));
    expect(proof.when).toEqual([]);
    expect(proof.failures).toEqual([expect.stringContaining("could not be checked in all 3 scoped files at HEAD")]);
  });

  it("reports the files missing after the 2,000-file staging cap without checking the sample", async () => {
    const cluster = clusterOf([thread(3, "packages/api/src/users.ts")]);
    const readable = new Set([
      "packages/api/src/users.ts",
      ...Array.from({ length: PIPELINE_LIMITS.stagedFiles - 1 }, (_, i) => `packages/api/src/file-${i}.ts`),
    ]);
    const missing = "packages/api/src/unstaged.ts";
    const pinned = tree(HEAD);
    pinned.paths = () => [...readable, missing];
    const patterns = vi.fn(fakePatterns());
    const proof = await proveEntry(draft(cluster), cluster, context({
      tree: pinned, patterns,
      check: { projectPath: ".", checkTree: ".", checkIndex: { projectId: "fixture", recordDirectory: "." } },
      patternStage: { readable, binary: new Set() },
    }));
    expect(readable.size).toBe(2000);
    expect(patterns).not.toHaveBeenCalled();
    expect(proof.when).toEqual([]);
    expect(proof.failures).toEqual([expect.stringContaining(`Could not read 1 scoped file ("${missing}"). Narrow the scope`)]);
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

  it("doesn't pre-tick an unproven lesson that only one reviewer kept asking for", async () => {
    const prose = (cluster: Cluster) => draft(cluster, { when: [], fix: undefined });
    const plan = { host: "github.com", slug: "acme/app" }, model = { id: "best", version: "test" };
    const solo = clusterOf([thread(3, "packages/api/src/users.ts"), thread(40, "packages/api/src/orders.ts")]);
    expect(solo.decision).toBe("write");
    const alone = routeEntry(await proveEntry(prose(solo), solo, context()), plan, model);
    if ("dropped" in alone) throw new Error(alone.dropped);
    expect([alone.status, alone.proposal.label]).toEqual(["proposed", "Learned from 2 PRs, 1 maintainer"]);
    const team = clusterOf([thread(3, "packages/api/src/users.ts"), thread(40, "packages/api/src/orders.ts", { reviewers: ["r2"] })]);
    const agreed = routeEntry(await proveEntry(prose(team), team, context()), plan, model);
    expect("dropped" in agreed ? agreed.dropped : agreed.status).toBe("active");
    // Proven against the code, one reviewer is enough.
    const proven = routeEntry(await proveEntry(draft(solo), solo, context()), plan, model);
    expect("dropped" in proven ? proven.dropped : [proven.status, proven.proven]).toEqual(["active", true]);
  });

  it("counts only the members whose quotes back the claim, and hands back the rest", async () => {
    const other = thread(40, "packages/api/src/orders.ts", { reviewers: ["r2"], text: "Please sort these imports. Use apiLogger instead." });
    const cluster = clusterOf([thread(3, "packages/api/src/users.ts"), other]);
    expect([cluster.support, cluster.reviewers, cluster.decision]).toEqual([2, 2, "write"]);
    // The writer rests the claim on one of the two: the other was grouped with it, but says something else.
    const only = cluster.members.find(member => member.candidate.pull === 3)!.candidate.id;
    const entry = draft(cluster, { when: [], fix: undefined, clauses: [{ text: "Log through apiLogger in packages/api, not console.log.", quotes: [{ id: only, quote: "Use apiLogger instead." }] }] });
    const proof = await proveEntry(entry, cluster, context());
    expect([proof.cluster.key, proof.cluster.support, proof.cluster.reviewers]).toEqual([cluster.key, 1, 1]);
    expect(proof.unbacked.map(member => member.candidate.pull)).toEqual([40]);
    const routed = routeEntry(proof, { host: "github.com", slug: "acme/app" }, { id: "best", version: "test" });
    if ("dropped" in routed) throw new Error(routed.dropped);
    expect([routed.status, routed.proposal.label]).toEqual(["proposed", "Learned from 1 PR, 1 maintainer"]);
    expect(routed.sources.map(source => source.pull)).toEqual([3]);
    // A weak single source is dropped, however many were grouped with it.
    const weak = clusterOf([thread(3, "packages/api/src/users.ts", { signal: "weak" }), thread(40, "packages/api/src/orders.ts", { signal: "weak" })]);
    const one = weak.members[0]!.candidate.id;
    expect((await proveEntry(draft(weak, { clauses: [{ text: "Log through apiLogger in packages/api, not console.log.", quotes: [{ id: one, quote: "Use apiLogger instead." }] }] }), weak, context())).dropped)
      .toMatch(/without a strong signal/u);
  });

  it("drops a ruled-out lesson without a maintainer's contrastive reason", async () => {
    const closed = thread(12, "packages/api/src/users.ts", { kind: "closed-pr", text: "Closing this one." });
    const cluster = clusterOf([closed], "Don't add a second logger package.");
    const proof = await proveEntry(draft(cluster, { route: "ruled-out", kind: "decision", when: [], claim: "Don't add a second logger.",
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

  it("sends text the gate would rewrite back for repair", async () => {
    const root = realPath(mkdtempSync(join(tmpdir(), "mex-prove-plain-")));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { lint: "node -e \"process.exit(0)\"" } }));
    const plain = "the text has a link, or a command this repository doesn't have; say it in plain words";
    const prove = (claim: string, text: string) => {
      const member = thread(3, "packages/api/src/users.ts", { text });
      const cluster = clusterOf([member]);
      return proveEntry(draft(cluster, {
        when: [], fix: undefined, claim,
        clauses: [{ text: claim, quotes: [{ id: member.id, quote: claim }] }],
      }), cluster, context({ tree: { ...tree(HEAD), root } as PinnedTree, check: { projectPath: root } }));
    };
    try {
      const unknown = await prove("Read https://evil.example/private before logging.", "Read https://evil.example/private before logging.");
      expect(unknown.dropped).toBeUndefined();
      expect(unknown.failures).toContain(plain);

      const script = await prove("Run npm run lint before pushing.", "Run npm run lint before pushing.");
      expect(script.dropped).toBeUndefined();
      expect(script.failures).not.toContain(plain);

      const link = "https://github.com/acme/app/pull/3#discussion_r3";
      const own = await prove(`The review is at ${link}.`, `The review is at ${link}.`);
      expect(own.dropped).toBeUndefined();
      expect(own.failures).not.toContain(plain);

      const fenced = "Log through apiLogger.\n```\napiLogger.info(\"list\");\n```";
      const block = await prove(fenced, fenced);
      expect(block.dropped).toBeUndefined();
      expect(block.failures).toContain(plain);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe("trials", () => {
  const plan = { host: "github.com", slug: "acme/app" }, model = { id: "best", version: "test" };

  it("maps a lesson to an existing linter rule as enable-rule-X, withheld once the config names it", async () => {
    const cluster = clusterOf([thread(3, "packages/api/src/users.ts")]);
    const files = { ...HEAD, ".eslintrc.json": "{ \"rules\": { \"eqeqeq\": \"error\" } }\n" };
    const entry = draft(cluster, { when: [], fix: undefined, lint: { config: ".eslintrc.json", rule: "no-console" } });
    const proof = await proveEntry(entry, cluster, context({ tree: tree(files) }));
    expect(proof.lint).toEqual({ config: ".eslintrc.json", rule: "no-console" });
    const routed = routeEntry(proof, plan, model);
    if ("dropped" in routed) throw new Error(routed.dropped);
    expect(routed.proposal.text).toContain("enable `no-console` in `.eslintrc.json`");
    expect(routed.proposal.checks).toContainEqual(expect.objectContaining({ kind: "pattern", role: "complete",
      target: { scope: ".eslintrc.json", pattern: "no-console", match: "literal", expect: "exact" }, saw: { count: 0 } }));
    const enabled = { ...files, ".eslintrc.json": "{ \"rules\": { \"no-console\": \"error\" } }\n" };
    expect((await proveEntry(entry, cluster, context({ tree: tree(enabled) }))).dropped).toMatch(/already names no-console/u);
  });

  it("turns a decision's rejected alternative into a rejected pattern only while nobody uses it", async () => {
    const reason = thread(5, "packages/api/src/users.ts", { kind: "closed-pr", text: "We decided against moment: it is too large. We use date-fns instead." });
    const cluster = clusterOf([reason], "Dates use date-fns, not moment.");
    const decision = draft(cluster, { route: "decision", kind: "decision", when: [], fix: undefined, claim: "Dates use date-fns, not moment.",
      clauses: [{ text: "Dates use date-fns, not moment.", quotes: [{ id: reason.id, quote: "We use date-fns instead." }] }],
      alternatives: [{ option: "moment", reason: "too large", rejected: { match: "literal", pattern: "from 'moment'" } }] });
    const proof = await proveEntry(decision, cluster, context());
    expect(proof.when).toEqual([{ type: "rejected", match: "literal", pattern: "from 'moment'", pairs: [], migration: false }]);
    const routed = routeEntry(proof, plan, model);
    if ("dropped" in routed) throw new Error(routed.dropped);
    expect(routed.proposal.text).toContain("Considered and ruled out: moment (too large).");
    expect(routed.proven).toBe(false);
    const inUse = { ...HEAD, "packages/api/src/dates.ts": "import day from 'moment';\nimport x from 'moment'\n" };
    const reversed = await proveEntry(decision, cluster, context({ tree: tree({ ...inUse, "packages/api/src/old.ts": "import m from 'moment'" }) }));
    expect(reversed.when).toEqual([]);
    expect(reversed.failures.join(" ")).toMatch(/in use today/u);
  });
});
