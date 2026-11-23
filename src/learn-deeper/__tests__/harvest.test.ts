import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ForgeClient } from "../forge.js";
import { PinnedTree } from "../git.js";
import { Familiarity } from "../harvest/familiarity.js";
import { DEFAULT_HARVEST_BUDGET, estimateHarvest, forecastCounts, harvestBatch, planHarvest,
  type Candidate, type HarvestBatch, type HarvestCursor, type HarvestOptions } from "../harvest/index.js";
import { productionPath } from "../harvest/local.js";
import { addHarvestEvidence, emptyHarvestEvidence, projectHarvestSpend } from "../harvest/estimate.js";
import { reviewedFiles } from "../harvest/forge.js";
import { Gaps } from "../harvest/evidence.js";
import { align, hunkSpan, RegionReader, reviewRegions } from "../harvest/regions.js";
import { sourceDigest } from "../source.js";

const source = { host: "github.com", slug: "fiction/transports" } as const;
const window = { since: "2026-11-01T00:00:00.000Z", until: "2026-11-20T00:00:00.000Z" };
const reviewWindow = { since: "2026-11-12T00:00:00Z", until: "2026-11-15T00:00:00Z" };
const raw = readFileSync(new URL("fixtures/harvest/changes.json", import.meta.url), "utf8");
const fixture = JSON.parse(raw);
const forkFixture = JSON.parse(readFileSync(new URL("fixtures/harvest/reviewed-contents.json", import.meta.url), "utf8"));
// Git subprocesses on Windows can queue behind parallel workers. These timeouts guard hangs.
const GIT_FIXTURE_TIMEOUT = 45_000;
let checkout: string, head: string, original: string, merge: string, attempt: string, revert: string, reland: string,
  cause: string, discussionRevert: string, squash: string, bodyRevert: string, branchOnly: string;
let pinned: PinnedTree;

const normalized = (value: string) => new Date(value).toISOString();
function git(args: string[], input?: string): string {
  return execFileSync("git", args, { cwd: checkout, input, encoding: "utf8", windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(checkout, "empty-gitconfig"), GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

function gitData(text: string): string {
  return `data ${Buffer.byteLength(text)}\n${text}\n`;
}

function fixtureCommit(day: number, subject: string, files: Record<string, string | undefined> = {}, opts: {
  body?: string; parent?: string; branch?: string; mark?: number;
} = {}): string {
  const { body, parent, branch = "main", mark = day } = opts;
  const when = Date.UTC(2026, 10, day, 10) / 1000;
  const changes = Object.entries(files).map(([path, content]) => content === undefined
    ? `D ${path}\n` : `M 100644 inline ${path}\n${gitData(content + "\n")}`).join("");
  return `commit refs/heads/${branch}\nmark :${mark}\ncommitter Fixture Writer <fixture@example.invalid> ${when} +0000\n`
    + gitData(subject + (body ? "\n\n" + body : "") + "\n") + (parent ? `from ${parent}\n` : "") + changes + "\n";
}

const variant = (topic: string, call: string) => [
  `export function ${topic}Entry() {`, `  const label = ${topic}Name();`, `  return ${call}(label);`,
  `  ${topic}Audit(label);`, `  ${topic}Cleanup();`, "}",
].join("\n");

beforeAll(async () => {
  checkout = mkdtempSync(join(tmpdir(), "mex-harvest-"));
  git(["init", "--bare", "--initial-branch=main", "--template="]);
  const reviewed = fixture.originalLines.join("\n");
  const merged = reviewed.replace("fallback(label)", "stable(label)");
  // Import once per phase to avoid a separate staging, commit and ref lookup
  // for each fixture change. The revert body needs the first phase's real OID.
  git(["fast-import", "--quiet"], [
    fixtureCommit(1, "Write the deployment guide", {
      "docs/deployment-guide.md": "# Development\n\n## Rollout\n\n"
        + "Document each deployment step and record the verification from the running service. ".repeat(300),
    }),
    fixtureCommit(2, "Establish transports", {
      "aaa/generated/client.ts": "export const version = 1;",
      "aaa/transport.generated.ts": "export const version = 1;",
      "aaa/transport.test.ts": "expect(transport()).toBe(1);",
      "docs/html/topics/configuration.md": "# Configuration\n\nSet the port.\n\n## Development\n\nSee the repository.",
      "docs/html/development/architecture/overview.rst": "Overview\n========\n\nThe transport queues requests before dispatch.",
      "docs/working-on-transport.md": "# Maintaining the transport\n\nRun the smoke tests before changing the queue.",
      "package-lock.json": "{}",
      "CODEOWNERS": "/src/changed.ts @fern-owner\n/src/new-name.ts @fiction/transport",
      "packages/transport/package.json": '{"name":"transport"}',
      "packages/transport/README.md": "# Transport\n\n## Usage\n\nCall the API.\n\n## Development\n\nBuild the test harness.",
      "docs/adr/001-transport.md": "# Transport\n\n## Considered options\n\nA second transport adds a deployment boundary.\n\n## Decision\n\nKeep the in-process transport.",
      "docs/AGENTS.md": "# Development\n\nDo not learn this rule file.",
      "docs/nested/.github/instructions/test.instructions.md": "# Development\n\nDo not learn this nested rule file.",
      ".cursor/rules/x.mdc": "# Development\n\nDo not learn this cursor rule file.",
      "docs/contributing.md": "# Contributing\n\n## Patches\n\nUse the smoke tests.",
      "src/retry.ts": "export const retried = 1;",
      "src/secondary.ts": "export const secondary = 1;",
      "src/state.ts": "export const state = 'pending';",
      "src/changed.ts": reviewed,
      "src/unchanged.ts": variant("unchanged", "stable"),
      "src/outdated.ts": variant("outdated", "stable"),
      "src/secret.ts": variant("secret", "fallback"),
      "src/old-name.ts": variant("renamed", "fallback"),
    }),
    fixtureCommit(4, "Tune retries (#14)", { "src/retry.ts": "export const retried = 2;", "src/secondary.ts": "export const secondary = 2;" }),
    fixtureCommit(5, "Try a queued transport", { "src/queue.ts": "export const enabled = false;" },
      { parent: ":4", branch: "proposal" }),
    "done\n",
  ].join(""));
  attempt = git(["rev-parse", "HEAD"]);
  branchOnly = git(["rev-parse", "refs/heads/proposal"]);
  git(["fast-import", "--quiet", "--export-marks=fixture-marks"], [
    fixtureCommit(6, 'Revert "Tune retries (#14)" (#15)', {
      "aaa/generated/client.ts": "export const version = 2;",
      "aaa/transport.generated.ts": "export const version = 2;",
      "aaa/transport.test.ts": "expect(transport()).toBe(2);",
      "docs/html/topics/configuration.md": "# Configuration\n\nSet the port and hostname.",
      "package-lock.json": '{"lockfileVersion":3}',
      "src/retry.ts": "export const retried = 1;",
    },
      { parent: attempt, body: `This reverts commit ${attempt}.\n\nThe extra retry can repeat delivery.` }),
    fixtureCommit(6, "Expand transport metadata (#23)", { "src/metadata.ts": "export const version = 1;" },
      { mark: 23, body: `* Revert "Try a queued transport"\n\nThis reverts commit ${branchOnly}.` }),
    fixtureCommit(7, "Enable the buffered queue (#21)", { "src/queue.ts": "export const enabled = true;" }),
    fixtureCommit(8, "Re-land: Tune retries (#16)", { "src/retry.ts": "export const retried = conditionalRetry();" }),
    fixtureCommit(9, "Stop repeated writes caused by a stale state flag", { "src/state.ts": "export const state = 'recorded';" }),
    fixtureCommit(10, "Test the regression from a stale state", { "test/transport.test.ts": "expect(run()).toBe('recorded');" }),
    fixtureCommit(10, "Restore the secondary retry limit", { "src/secondary.ts": "export const secondary = 1;" },
      { mark: 24, body: `This reverts commit ${attempt}.\n\nThe secondary limit must stay at one.` }),
    fixtureCommit(11, 'Revert "Enable the buffered queue (#21)" (#22)', { "src/queue.ts": "export const enabled = false;" }),
    fixtureCommit(11, "Prepare a reviewed transport branch", {}, { parent: ":11", branch: "reviewed", mark: 12 }),
    fixtureCommit(13, "Wire the adapters (#31)", {
      "src/changed.ts": merged, "src/outdated.ts": variant("outdated", "newStable"),
      "src/old-name.ts": undefined, "src/new-name.ts": variant("renamed", "stable"),
    }),
    fixtureCommit(14, "Use consistent spacing", {
      "src/unchanged.ts": variant("unchanged", "stable").replace("return stable", "return   stable"),
      "src/changed.ts": "// Current transport\n" + merged,
    }),
    "done\n",
  ].join(""));
  const marks = Object.fromEntries(readFileSync(join(checkout, "fixture-marks"), "utf8").trimEnd().split(/\r?\n/u)
    .map(line => line.split(" ")));
  [revert, reland, cause, discussionRevert, original, merge, head, squash, bodyRevert] =
    [6, 8, 9, 11, 12, 13, 14, 23, 24].map(mark => marks[`:${mark}`]!);
  pinned = (await PinnedTree.open(checkout, head))!;
}, GIT_FIXTURE_TIMEOUT);

afterAll(() => {
  // This private fixture contains only the files above and Git's own metadata.
  if (checkout) rmSync(checkout, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function forge({ paging = false, weekly = false, issue = false, reverts = false, textOnly = false, fork = false, mergedCount = 1 } = {}) {
  const captures: string[] = [];
  const data = JSON.parse(raw.replaceAll("OID_ORIGINAL", original).replaceAll("OID_MERGE", merge));
  if (fork) {
    data.merged.headRepository = forkFixture.headRepository;
    const rows = data.merged.reviewThreads.nodes;
    for (const review of forkFixture.reviews) {
      const row = rows.find((item: { id: string }) => item.id === review.id);
      Object.assign(row.comments.nodes[0], { originalCommit: { oid: forkFixture.commit }, diffHunk: review.shortHunk });
    }
    const repeated = structuredClone(rows[0]);
    repeated.id = "PRRT_fork_repeat";
    repeated.comments.nodes[0].id = "PRRC_fork_repeat";
    rows.push(repeated);
    data.merged.reviewThreads.totalCount = rows.length;
  }
  if (textOnly) {
    data.merged.reviewThreads.nodes = data.merged.reviewThreads.nodes.slice(0, 4);
    for (const thread of data.merged.reviewThreads.nodes) thread.comments.nodes[0].diffHunk = "";
  }
  const merged = Array.from({ length: mergedCount }, (_, i) => {
    if (!i) return data.merged;
    const row = structuredClone(data.merged);
    row.number += i;
    for (const thread of row.reviewThreads.nodes) {
      thread.id += `_${i}`;
      for (const comment of thread.comments.nodes) comment.id += `_${i}`;
    }
    return row;
  });
  if (weekly) for (const [number, day] of [[51, 21], [52, 27]]) merged.push({ ...data.merged, number,
    mergedAt: `2026-11-${day}T10:00:00Z`, reviewThreads: { nodes: [] } });
  const issues = issue ? [{ id: "I_fixture61", number: 61, title: "Do not support the older protocol",
    body: "Clients still need the handshake.", stateReason: "NOT_PLANNED", closedAt: "2026-11-19T10:00:00Z",
    comments: { nodes: [{ ...data.closed[0].comments.nodes[0], id: "IC_fixture61", body: "The older protocol has no version handshake." }] } }] : [];
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = new URL(String(url));
    const path = requestUrl.pathname;
    if (fork && path.startsWith("/repos/fern-fork/transports/contents/")) {
      const file = path.slice("/repos/fern-fork/transports/contents/".length);
      expect(requestUrl.searchParams.get("ref")).toBe(forkFixture.commit);
      captures.push("contents:" + file);
      const review = forkFixture.reviews.find((item: { contents: { path: string } }) => item.contents.path === file);
      return review ? Response.json(review.contents) : new Response(null, { status: 404 });
    }
    if (path.endsWith("/collaborators/fern-owner/permission")) {
      captures.push("permission");
      return Response.json({ permission: "write" });
    }
    expect(path).toBe("/graphql");
    const { query, variables }: { query: string; variables: Record<string, string> } = JSON.parse(String(init?.body));
    captures.push(query.split("(")[0]!);
    if (query.includes("HarvestSearch(")) {
      const aliases = Object.entries(variables).filter(([key]) => key.startsWith("q"));
      return Response.json({ data: Object.fromEntries(aliases.map(([key, term]) => {
        const range = /(?:merged|closed):([^ ]+)\.\.([^ ]+)$/u.exec(term)!;
        const items = term.includes("is:issue") ? issues : term.includes("is:unmerged") ? data.closed : merged;
        const rows = items.filter((row: { closedAt: string; mergedAt?: string }) => {
          const date = normalized(row.mergedAt ?? row.closedAt);
          return date >= normalized(range[1]!) && date <= normalized(range[2]!);
        });
        return [`s${key.slice(1)}`, { issueCount: rows.length, ...(query.includes("first:1,") ? {} : { nodes: rows }),
          pageInfo: { hasNextPage: false, endCursor: null } }];
      })) });
    }
    if (query.includes("HarvestThreadPages(")) {
      expect(variables.a0).toBe("fixture-page");
      return Response.json({ data: { repository: { p0: { reviewThreads: { nodes: data.merged.reviewThreads.nodes.slice(4),
        totalCount: 13, pageInfo: { hasNextPage: false } } } } } });
    }
    if (query.includes("HarvestRevertDiscussion(")) {
      if (!reverts) return Response.json({ data: { repository: {} } });
      const repository = Object.fromEntries([...query.matchAll(/p(\d+):pullRequest\(number:\d+\)/gu)].map(([, pull]) =>
        [`p${pull}`, { reviews: { nodes: [{ ...data.closed[0].reviews.nodes[0], id: "PRR_revertReason",
          createdAt: "2026-11-11T11:00:00Z", body: "The queue started before the handshake completed." }] } }]));
      return Response.json({ data: { repository } });
    }
    if (query.includes("reviewThreads")) {
      expect(query).toContain("pullRequestReview{authorCanPushToRepository author{login}}");
      expect(query).toContain("id path isResolved isOutdated line originalLine startLine originalStartLine diffSide");
    }
    if (query.includes("pullRequest(number:")) expect(query).toContain("mergeCommit{oid} headRefOid");
    const repository = Object.fromEntries([...query.matchAll(/p(\d+):(?:pullRequest|issue)\(number:(\d+)\)/gu)].map(([, index, value]) => {
      const row = [...merged, ...data.closed, ...issues].find(row => row.number === Number(value));
      if (paging && row?.number === 31) {
        const nodes = row.reviewThreads.nodes.slice(0, 4);
        for (let i = 0; i < 8; i++) nodes.push({ ...nodes[0], id: `PRRT_decoy${i}`,
          comments: { nodes: [{ ...nodes[0].comments.nodes[0], isCopilotCodeReview: true }] } });
        return [`p${index}`, { ...row, reviewThreads: { nodes, totalCount: 13, pageInfo: { hasNextPage: true, endCursor: "fixture-page" } } }];
      }
      return [`p${index}`, row ?? null];
    }));
    return Response.json({ data: { repository } });
  });
  return { client: new ForgeClient(source, "fixture-token", request, 0), captures };
}

function options(overrides: Partial<HarvestOptions> = {}): HarvestOptions {
  return { ...window, checkout, head, defaultHead: head, source, agent: "claude", ...overrides };
}

async function drain(opts: HarvestOptions, deps: ReturnType<typeof forge>, cursor?: HarvestCursor) {
  const tree = opts.head === head ? pinned : await PinnedTree.open(opts.checkout, opts.head);
  const reads = { ...deps, tree };
  const plan = await planHarvest(opts, reads, cursor);
  const batches: HarvestBatch[] = [];
  for (let i = 0; i < 30; i++) {
    const batch = await harvestBatch(plan, cursor, reads);
    batches.push(batch);
    // This exercises the serialized checkpoint used by the next worker.
    cursor = JSON.parse(JSON.stringify(batch.cursor));
    if (batch.done) return { plan, batches, cursor: batch.cursor, candidates: batches.flatMap(item => item.candidates),
      gaps: batches.flatMap(item => item.gaps), spent: batches.reduce((sum, item) => sum + item.spentEstimate, 0) };
  }
  throw new Error("Fixture harvest did not finish.");
}

const thread = (candidates: Candidate[], number: number) => candidates.find(candidate => candidate.id === `gh:thread:PRRT_fixture${number}`)!;

describe("harvest", () => {
  it("recovers after regions for the known acted-on fork threads", async () => {
    const deps = forge({ fork: true });
    const { candidates, cursor } = await drain(options({ ...reviewWindow, requestBudget: 6 }), deps);
    const cohort = [...forkFixture.reviews.map((review: { id: string }) => "gh:thread:" + review.id), "gh:thread:PRRT_fork_repeat"];
    const threads = candidates.filter(candidate => cohort.includes(candidate.id));
    expect(threads).toHaveLength(4);
    const after = threads.filter(candidate => candidate.code?.after);
    console.log(`Acted-on fork threads with an after region: ${after.length}/${cohort.length}`);
    expect(after).toHaveLength(4);
    for (const thread of threads) {
      expect(thread).toMatchObject({ weights: { actedOn: true }, code: { before: { commit: forkFixture.commit, start: 1, end: 18 } } });
      expect(thread.code?.before?.text).toContain("// reviewed tail 12");
    }
    expect(deps.captures.filter(call => call.startsWith("contents:"))).toEqual([
      "contents:src/changed.ts", "contents:src/outdated.ts", "contents:src/old-name.ts",
    ]);
    expect(cursor.run?.requests).toBe(6);
    expect(cursor.run?.requests).toBe(deps.captures.length);
  }, GIT_FIXTURE_TIMEOUT);

  it("anchors the reviewed side against a squash merge, follows a rename, and drops a secret hunk", async () => {
    const deps = forge({ paging: true });
    const { candidates, gaps } = await drain(options(reviewWindow), deps);
    expect(deps.captures).toContain("query HarvestThreadPages");
    expect(git(["merge-base", "--is-ancestor", merge, head])).toBe("");
    const changed = thread(candidates, 1);
    expect(changed).toMatchObject({ signal: "strong", nodeIds: ["PRRC_fixture1"], path: "src/changed.ts",
      code: { before: { commit: original }, after: { commit: merge }, head: { commit: head }, anchor: "  return fallback(label);" },
      weights: { actedOn: true, familiar: true, guidelineLink: true, generalising: true, smallPr: true, hotUnknown: true } });
    expect(changed.code!.after!.text).toContain("return stable(label);");
    expect(changed.text).toContain("[reviewer]");
    expect(changed.text).not.toContain("Fern Example");
    expect(changed.commentHashes?.PRRC_fixture1).toBe(sourceDigest(fixture.merged.reviewThreads.nodes[0].comments.nodes[0].body));
    expect(changed.reviewers).toEqual([expect.stringMatching(/^sha256:[a-f\d]{64}$/u)]);
    expect(thread(candidates, 2)).toMatchObject({ weights: { actedOn: false }, signal: "weak" });
    expect(thread(candidates, 3)).toMatchObject({ code: { anchor: "  return stable(label);" }, weights: { actedOn: true } });
    expect(thread(candidates, 4)).toMatchObject({ code: { before: { path: "src/old-name.ts" }, after: { path: "src/new-name.ts" } }, weights: { actedOn: true } });
    expect(thread(candidates, 5)).toBeUndefined();
    expect(gaps).toContain("Privacy checks withheld 1 code regions or hunks.");
    expect(gaps.some(gap => gap.includes("threads unread"))).toBe(false);
  }, GIT_FIXTURE_TIMEOUT);

  it("keeps a maintainer closure, excludes both bot closures, and makes issues opt-in and last", async () => {
    const deps = forge({ issue: true });
    const bounds = { since: "2026-11-15T00:00:00Z" };
    const trial = await drain(options({ ...bounds, issues: true }), deps);
    const closures = trial.candidates.filter(candidate => candidate.kind === "closed-pr");
    expect(closures.map(candidate => candidate.id)).toEqual(["gh:closed:41"]);
    expect(closures[0]!.text).toMatch(/^We don't want two transport versions/u);
    expect(closures[0]!.text).toContain("This proposal uses a different transport.");
    expect(trial.candidates.at(-1)?.id).toBe("gh:issue:61");
    const standard = await planHarvest(options(bounds), { ...deps, tree: pinned });
    expect(standard.inventory.bands.some(band => band.source === "issue")).toBe(false);
  }, GIT_FIXTURE_TIMEOUT);

  it("joins a local revert to its PR and re-land, and compares regions on their common path", async () => {
    const { candidates, plan } = await drain(options({ since: "2026-11-03T00:00:00Z", until: "2026-11-09T00:00:00Z" }), forge());
    expect(git(["cat-file", "-t", branchOnly])).toBe("commit");
    expect(plan.inventory.local.revert.map(point => point.id)).toEqual([revert]);
    expect(candidates.some(candidate => candidate.id === `git:revert:${squash}`)).toBe(false);
    expect(candidates.find(candidate => candidate.id === `git:revert:${revert}`)).toMatchObject({
      id: `git:revert:${revert}`, path: "src/retry.ts", text: "The extra retry can repeat delivery.",
      code: { before: { commit: attempt, text: "export const retried = 2;" },
        after: { commit: revert, text: "export const retried = 1;" }, anchor: "export const retried = 2;" },
      related: { pulls: [15, 14, 16], commits: [attempt, reland],
        reland: { before: { commit: attempt, text: "export const retried = 2;" },
          after: { commit: reland, text: "export const retried = conditionalRetry();" } } },
    });
  }, GIT_FIXTURE_TIMEOUT);

  it("accepts a body-only revert of an ancestor outside the inventory window", async () => {
    const { candidates, plan } = await drain(options({ since: "2026-11-10T00:00:00Z", until: "2026-11-11T00:00:00Z" }), forge());
    expect(plan.inventory.revertLinks[bodyRevert]?.original).toBe(attempt);
    expect(candidates.find(candidate => candidate.kind === "revert")).toMatchObject({
      id: `git:revert:${bodyRevert}`, path: "src/secondary.ts", text: "The secondary limit must stay at one.",
      code: { before: { commit: git(["rev-parse", bodyRevert + "^"]), text: "export const secondary = 2;" },
        after: { commit: bodyRevert, text: "export const secondary = 1;" }, anchor: "export const secondary = 2;" },
      related: { commits: [attempt] },
    });
  }, GIT_FIXTURE_TIMEOUT);

  it("fetches related PR discussion once when a subject-only local revert lacks a reason", async () => {
    const deps = forge({ reverts: true });
    const { candidates } = await drain(options({ since: "2026-11-11T00:00:00Z", until: "2026-11-12T00:00:00Z" }), deps);
    expect(candidates.find(candidate => candidate.id === `git:revert:${discussionRevert}`)).toMatchObject({
      text: "The queue started before the handshake completed.", nodeIds: ["PRR_revertReason"], related: { pulls: [22, 21] },
      code: { before: { text: "export const enabled = true;" }, after: { text: "export const enabled = false;" },
        anchor: "export const enabled = true;" },
    });
    expect(deps.captures.filter(query => query === "query HarvestRevertDiscussion")).toHaveLength(1);
  }, GIT_FIXTURE_TIMEOUT);

  it("finds cause-phrase commits with production changes and skips tests-only changes", async () => {
    const { candidates, plan } = await drain(options({ since: "2026-11-09T00:00:00Z", until: "2026-11-11T00:00:00Z" }), forge());
    expect(plan.inventory.local.cause).toHaveLength(1);
    expect(candidates.find(candidate => candidate.kind === "cause-commit")).toMatchObject({
      id: `git:cause:${cause}`, path: "src/state.ts", code: { before: { text: "export const state = 'pending';" },
        after: { text: "export const state = 'recorded';" } },
    });
  }, GIT_FIXTURE_TIMEOUT);

  it("splits contributor headings, tags package usage and excludes nested rule files", async () => {
    const { candidates, plan } = await drain(options({ since: "2026-11-02T00:00:00Z", until: "2026-11-03T00:00:00Z" }), forge());
    expect(candidates.find(candidate => candidate.id.endsWith("#considered-options"))).toMatchObject({
      kind: "adr", document: { headings: ["Transport", "Considered options"], consumerUsage: false },
    });
    expect(candidates.find(candidate => candidate.id.endsWith("README.md#usage"))).toMatchObject({
      kind: "doc", document: { headings: ["Transport", "Usage"], consumerUsage: true },
    });
    expect(candidates.some(candidate => /AGENTS|instructions\.md|\.cursor/u.test(candidate.id))).toBe(false);
    const paths = plan.inventory.local.doc.map(point => point.id);
    expect(paths).not.toContain("docs/html/topics/configuration.md");
    expect(paths).toEqual(expect.arrayContaining(["docs/html/development/architecture/overview.rst", "docs/working-on-transport.md"]));
    expect(candidates.find(candidate => candidate.path === "docs/html/development/architecture/overview.rst")?.text)
      .toBe("The transport queues requests before dispatch.");
  }, GIT_FIXTURE_TIMEOUT);

  it("stops at the run allowance, resumes without duplicate IDs, and reads weekly points strictly newer", async () => {
    const deps = forge({ textOnly: true });
    const budget = 26_470;
    const bounds = { since: "2026-11-12T00:00:00Z" };
    const first = await drain(options({ ...bounds, budget }), deps);
    expect(first.candidates).toHaveLength(3);
    expect(first.spent).toBeLessThanOrEqual(budget);
    expect(first.spent).toBe(projectHarvestSpend(first.cursor.run!.evidence, "claude"));
    expect(first.gaps).toContain("Learning reached its estimated token budget.");
    const second = await drain(options(bounds), deps, first.cursor);
    const joined = [...first.candidates, ...second.candidates].map(candidate => candidate.id);
    expect(new Set(joined).size).toBe(joined.length);
    expect(joined.sort()).toEqual(["gh:closed:41", "gh:pr:31", ...[1, 2, 3, 4].map(number => `gh:thread:PRRT_fixture${number}`)]);
    const weekly = await drain(options({ ...bounds, mode: "weekly", until: "2026-11-30T00:00:00Z" }), forge({ weekly: true }), second.cursor);
    expect(weekly.candidates.map(candidate => candidate.id).sort()).toEqual(["gh:pr:51", "gh:pr:52"]);
    expect(weekly.cursor.sources.merged?.newest.at).toBe("2026-11-27T10:00:00.000Z");
  }, GIT_FIXTURE_TIMEOUT);

  it("stops earlier on long doc passages than on short comments at the same token budget", async () => {
    const budget = 29_500;
    const docs = await drain(options({ budget, until: "2026-11-02T00:00:00Z" }), forge());
    const reviews = await drain(options({ ...reviewWindow, budget }), forge({ textOnly: true }));
    expect(docs.candidates).toHaveLength(1);
    expect(docs.candidates[0]?.kind).toBe("doc");
    expect(Buffer.byteLength(docs.candidates[0]!.text)).toBeGreaterThan(4_000);
    expect(docs.gaps).toContain("Learning reached its estimated token budget.");
    expect(docs.spent).toBeGreaterThan(budget / 4);
    expect(docs.spent).toBeLessThanOrEqual(budget);
    expect(reviews.candidates.filter(candidate => candidate.kind === "review-thread")).toHaveLength(4);
    expect(reviews.candidates).toHaveLength(5);
    expect(reviews.gaps).not.toContain("Learning reached its estimated token budget.");
    expect(reviews.spent).toBeLessThan(docs.spent);
  }, GIT_FIXTURE_TIMEOUT);

  it("caps document and ADR evidence across batches and keeps reading review threads", async () => {
    const budget = 128_000;
    const { candidates, batches } = await drain(options({ budget }), forge({ textOnly: true, mergedCount: 9 }));
    const docs = candidates.filter(candidate => candidate.kind === "doc" || candidate.kind === "adr");
    expect(docs.some(candidate => candidate.kind === "doc")).toBe(true);
    expect(docs.some(candidate => candidate.kind === "adr")).toBe(true);
    const size = docs.reduce(addHarvestEvidence, emptyHarvestEvidence);
    expect(projectHarvestSpend(size, "claude")).toBeLessThanOrEqual(budget / 4);
    const capped = batches.findIndex(batch => batch.gaps.includes("Contributor documents reached their share of the estimated token budget."));
    expect(capped).toBeGreaterThanOrEqual(0);
    expect(batches.slice(capped + 1).flatMap(batch => batch.candidates).some(candidate => candidate.kind === "review-thread")).toBe(true);
    expect(candidates.filter(candidate => candidate.kind === "review-thread")).toHaveLength(36);
  }, GIT_FIXTURE_TIMEOUT);

  it("reserves budget for closed PRs even without merged PRs", async () => {
    const { candidates, gaps } = await drain(options({ budget: 80_000 }), forge({ mergedCount: 0 }));
    expect(candidates.some(candidate => candidate.kind === "doc" || candidate.kind === "adr")).toBe(false);
    expect(candidates.some(candidate => candidate.kind === "closed-pr")).toBe(true);
    expect(gaps).toContain("Contributor documents reached their share of the estimated token budget.");
  }, GIT_FIXTURE_TIMEOUT);

  it("keeps queued changes for a later run when the forge budget ends after search", async () => {
    const deps = forge({ textOnly: true });
    const blocked = await drain(options({ ...reviewWindow, requestBudget: 2 }), deps);
    expect(blocked.candidates).toEqual([]);
    expect(blocked.cursor.run?.requests).toBe(2);
    expect(blocked.gaps).toContain("Learning reached its forge request budget.");
    expect(deps.captures).toEqual(["query HarvestSearch", "query HarvestSearch"]);
    const resumed = await drain(options(reviewWindow), deps, blocked.cursor);
    expect(resumed.candidates).toHaveLength(5);
  }, GIT_FIXTURE_TIMEOUT);

  it("recognizes verified CODEOWNERS teams and two distinct earlier PRs in the same package", async () => {
    const history = {};
    const familiarity = await Familiarity.open(source.slug, pinned, history, new Map([["plant-dev", ["fiction/transport"]]]));
    expect(familiarity.knows("plant-dev", "src/new-name.ts", 3, "2026-11-04")).toBe(true);
    expect(familiarity.knows("another-dev", "src/new-name.ts", 3, "2026-11-04")).toBe(false);
    familiarity.observe("plant-dev", "packages/transport/src/a.ts", 1, "2026-11-02");
    familiarity.observe("plant-dev", "packages/transport/src/a.ts", 2, "2026-11-03");
    expect(familiarity.knows("plant-dev", "packages/transport/src/b.ts", 3, "2026-11-04")).toBe(true);
    expect(familiarity.knows("plant-dev", "packages/transport/src/b.ts", 2, "2026-11-03")).toBe(false);
    expect(JSON.stringify(history)).not.toContain("plant-dev");
  }, GIT_FIXTURE_TIMEOUT);
});

it.each([["src/server.go", true], ["src/server_test.go", false], ["src/config.ts", false],
  ["src/server.test.ts", false], ["docs/example.js", false], [".github/scripts/setup.sh", false],
  ["src/transport.py", true], ["packages/transport/package.json", false]])("classifies production path %s", (path, expected) => {
  expect(productionPath(path)).toBe(expected);
});

it("uses matched context, never treats hunk age or ambiguous repetitions as a change", () => {
  const span = hunkSpan("@@ -1,4 +1,4 @@\n prepare();\n-old();\n+bad();\n audit();\n cleanup();", "RIGHT", 2, 2)!;
  const merged = ["// new header", "prepare();", "good();", "audit();", "cleanup();"];
  expect(align(span, merged)).toMatchObject({ first: 2, last: 3 });
  expect(align(span, [...merged, ...merged])).toBeUndefined();
  expect(align(span, ["prepare();", "audit();", "cleanup();"])).toMatchObject({ first: 1, last: 1 });
});

it("recovers context when the reviewed object is missing and GitHub ends the hunk at the anchor", async () => {
  const [first, next, anchor] = fixture.originalLines;
  const location = await reviewRegions({ path: "src/changed.ts", side: "RIGHT", first: 3, last: 3,
    hunk: `@@ -1,3 +1,3 @@\n ${first}\n ${next}\n ${anchor}`, original: "a".repeat(40),
    merge, head, changedPaths: [] }, new RegionReader(checkout), new Gaps());
  expect(location).toMatchObject({ actedOn: true, code: { before: { end: 3 }, after: { commit: merge }, anchor } });
}, GIT_FIXTURE_TIMEOUT);

it("projects UTF-8 prose and charges PR excerpts and code toward writing", () => {
  const bare = addHarvestEvidence(emptyHarvestEvidence, { text: "設定" });
  const region = { path: "src/example.ts", commit: "a".repeat(40), start: 1, end: 1, text: "const answer = 42;", hash: "" };
  const full = addHarvestEvidence(emptyHarvestEvidence, { text: "設定", prText: "See the rollout.",
    code: { before: region, after: region, head: region, anchor: "const" },
    related: { reland: { before: region, after: region } } });
  expect(full.triageTokens).toBe(2);
  expect(full.writerTokens).toBe(Math.ceil(Buffer.byteLength("設定See the rollout.const" + region.text.repeat(5)) / 3));
  expect(projectHarvestSpend(full, "claude")).toBeGreaterThan(projectHarvestSpend(bare, "claude"));
});

it("caps reviewed-file requests per batch and caches missing files", async () => {
  const gaps = new Gaps();
  const get = vi.fn(async (_path: string) => undefined);
  const read = reviewedFiles({ repo: source, anonymous: false, get, graphql: vi.fn() }, () => true, gaps);
  const commit = "b".repeat(40);
  await read(commit, "src/first.ts");
  await read(commit, "src/first.ts");
  for (let i = 0; i < 8; i++) await read(commit, `src/example-${i}.ts`);
  expect(get).toHaveBeenCalledTimes(8);
  expect(get.mock.calls.filter(([path]) => path.includes("first.ts"))).toHaveLength(1);
  expect(gaps.list()).toContain("Some reviewed files exceeded the forge request budget.");
});

it("quotes both calibration shapes using packed calls, prose-only triage and an allowance for one repair in five", () => {
  const hono = estimateHarvest(forecastCounts({ merged: 48, doc: 17 }), "claude");
  const novu = estimateHarvest(forecastCounts({ merged: 45, doc: 36 }), "codex");
  expect([hono.total, novu.total]).toEqual([156_582, 300_084]);
  expect(hono.total).toBeLessThan(392_384);
  expect(novu.total).toBeLessThan(480_000);
  expect(novu.total).toBeLessThan(DEFAULT_HARVEST_BUDGET);
});

describe("PR descriptions", () => {
  it("reads a Decisions section first, so a long description's excerpt keeps it", async () => {
    const { decisionsFirst } = await import("../harvest/forge.js");
    const body = "Adds the export.\n\n## Testing\nRan the suite.\n\n## Decisions\n- Chose streaming over buffering: large exports ran out of memory.\n\n## Notes\nNone.";
    expect(decisionsFirst(body).startsWith("## Decisions\n- Chose streaming over buffering")).toBe(true);
    expect(decisionsFirst(body)).toContain("## Testing\nRan the suite.");
    expect(decisionsFirst("No sections here.")).toBe("No sections here.");
    expect(decisionsFirst("**Decisions**\nKeep the cache.\n")).toBe("**Decisions**\nKeep the cache.\n");
  });
});
