import { expect, it, vi } from "vitest";
import { tokenCount } from "../../model-runner/consent.js";
import { ForgeClient } from "../forge.js";
import { PinnedTree } from "../git.js";
import { githubReviews } from "../github.js";
import { gitlabInventory, gitlabReviews } from "../gitlab.js";
import { BACKFILL_PULLS_PER_BATCH, orderBackfillPulls, promptEstimate, quoteTokens } from "../plan.js";
import { Reviewers } from "../reviewers.js";
import { BACKFILL_REVIEW_LIMIT, cleanSourceText, documentExcerpt, prioritizeReviews, redactReviews, repositoryFromRemote, reviewRelevance,
  spreadPulls,
  type ReviewSource } from "../source.js";
import { weeklyHead } from "../weekly.js";

const then = "2026-06-10T15:12:30Z";
const window = { since: "2025-01-01T00:00:00Z", until: "2026-07-01T00:00:00Z" };
const sha = "f".repeat(40);
const tree = new PinnedTree("unused", sha, new Map([["src/runtime.ts", sha]]));
const github = { host: "github.com", slug: "fiction/memory" } as const;
const gitlab = { host: "gitlab.com", slug: "fiction/tools/memory" } as const;
const empty = () => Response.json([]);

it("routes only the hosted forges and accepts a GitLab subgroup", () => {
  expect(repositoryFromRemote("git@github.com:fiction/memory.git")).toEqual(github);
  expect(repositoryFromRemote("ssh://git@gitlab.com/fiction/tools/memory.git")).toEqual(gitlab);
  for (const remote of ["https://gitlab.example.com/fiction/memory", "https://github.com.attacker.tld/fiction/memory",
    "https://token:secret@github.com/fiction/memory", "ssh://git@gitlab.com:2222/fiction/memory", "git@github.com:fiction/../memory"]) {
    expect(repositoryFromRemote(remote)).toBeUndefined();
  }
});

it("pins GitLab's hosted default branch using its nested namespace and branch name", async () => {
  const seen: string[] = [];
  const request = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    seen.push(path);
    return path.endsWith("/branches/release%2Fnext") ? Response.json({ commit: { id: sha } }) : Response.json({ default_branch: "release/next" });
  });
  await expect(weeklyHead(new ForgeClient(gitlab, "forge-fixture-token", request))).resolves.toBe(sha);
  expect(seen).toEqual(["/api/v4/projects/fiction%2Ftools%2Fmemory", "/api/v4/projects/fiction%2Ftools%2Fmemory/repository/branches/release%2Fnext"]);
});

it("rejects suggestion-only reviews and short questions", () => {
  expect(reviewRelevance("```suggestion\nconst answer = true\n```\n")).toBeUndefined();
  expect(reviewRelevance("Did the compiler pass?")).toBeUndefined();
  expect(reviewRelevance("LGTM!")).toBeUndefined();
  expect(reviewRelevance("Looks good because the loader resolves imports before discovery.")).toBeDefined();
  expect(reviewRelevance("Generated snapshots need the renderer version because the format depends on it. Did you update it?")).toContain("Generated snapshots");
  expect(spreadPulls([[{ number: 1 }, { number: 2 }], [{ number: 9 }, { number: 8 }], [{ number: 19 }]], 4)
    .map(pull => pull.number)).toEqual([1, 9, 19, 2]);
});

it("groups the sampled PRs by merge date and quotes the wider model batches", () => {
  const older = { number: 12, at: "2026-01-01T00:00:00Z" };
  const recent = { number: 20, at: then };
  expect(orderBackfillPulls([recent, older])).toEqual([older, recent]);
  expect(quoteTokens(8, 6, "codex", "best-only", [], BACKFILL_PULLS_PER_BATCH))
    .toBeLessThan(quoteTokens(8, 6, "codex", "best-only"));
});

it.each([
  { bytes: 12133, rules: 8, input: 5540, output: 399 },
  { bytes: 9797, rules: 7, input: 5083, output: 372 },
  { bytes: 8837, rules: 8, input: 4988, output: 386 },
  { bytes: 5085, rules: 4, input: 3975, output: 189 },
  { bytes: 6132, rules: 5, input: 6725, output: 251 },
])("covers the recorded Codex token classes for a $bytes-byte anchor prompt", ({ bytes, rules, input, output }) => {
  // Measured anchor-only replay, 2026-11-21. Cache reads are separate from
  // the uncached input reported by MEX. Keep the fixture body-free.
  const actual = { input, output, cache_write: 0, cache_read: 12_288 };
  const estimated = promptEstimate("x".repeat(bytes), "codex", rules);
  expect(estimated.cache_read).toBe(actual.cache_read);
  expect(estimated.input).toBeGreaterThanOrEqual(input);
  expect(estimated.output).toBeGreaterThanOrEqual(output);
  expect(estimated.output).toBeGreaterThan(promptEstimate("", "codex", 0).output);
  expect(tokenCount(estimated)).toBeGreaterThanOrEqual(tokenCount(actual));
});

it("preserves verified evidence from a second PR under the review source cap", () => {
  const first: ReviewSource = { kind: "review", id: "first", hash: sha, link: "", text: "Keep stable snapshots.",
    at: then, pull: 1, writer: true, topLevel: true, outdated: false };
  const reviews = Array.from({ length: BACKFILL_REVIEW_LIMIT }, (_, i) => ({ ...first, id: String(i) }));
  const second = { ...first, id: "second", pull: 2, topLevel: false };
  const selected = redactReviews([...reviews, second], new Reviewers(), new Set(), [], true);
  expect(selected).toHaveLength(BACKFILL_REVIEW_LIMIT);
  expect(selected.map(review => review.id)).toContain(second.id);
});

it("ranks a comment that led to a code change ahead of other verified reviews", () => {
  const summary: ReviewSource = { kind: "review", id: "summary", hash: sha, link: "", text: "Keep stable snapshots.",
    at: then, pull: 1, writer: true, topLevel: true, outdated: false };
  const fixed = { ...summary, id: "fixed", topLevel: false, outdated: true, path: "src/runtime.ts" };
  const open = { ...summary, id: "open", topLevel: false, path: "src/runtime.ts" };
  expect(prioritizeReviews([summary, open, fixed], []).map(review => review.id)).toEqual(["fixed", "summary", "open"]);
});

it("redacts known reviewers in prose while preserving technical terms and code spans", () => {
  const reviewers = new Reviewers();
  reviewers.add("testuser", "Test User");
  reviewers.add("go", "Go");
  reviewers.add("mark", "Mark");
  reviewers.add("scope", "Build Maintainers");
  const terms = "Go users can run go test ./... and npm test. Mark @types/node, @Override, @scope/pkg, and @media.";
  const inline = "Try ``go test ./... `Test User` @testuser code@example.invalid``.";
  const fence = "> ~~~ts\n> @testuser\n> // Test User and code@example.invalid\n> ~~~";
  const shell = "```sh\ngo test ./... # @testuser and Test User\n```";
  const mention = "Thanks, tEsT  uSeR and @TESTUSER. Email person@example.invalid or ask @unknown.";
  const boundaries = "Contest User, Test Users, and a user can run the same test.";
  expect(cleanSourceText([terms, mention, boundaries, inline, "", fence, "", shell].join("\n"), reviewers)).toBe([
    terms, "Thanks, [reviewer] and [reviewer]. Email [reviewer] or ask @unknown.", boundaries, inline, "", fence, "", shell,
  ].join("\n"));
  expect(documentExcerpt(`${terms}\n${mention}`, reviewers).excerpt).toEqual({
    text: `${terms}\nThanks, tEsT  uSeR and [reviewer]. Email [reviewer] or ask @unknown.`, coverage: "full",
  });
});

it("reports a UTF-8-safe partial excerpt and trims a flagged document before the finding", () => {
  const reviewers = new Reviewers();
  const prefix = "x".repeat(4095);
  const raw = `${prefix}🙂 remaining text`;
  expect(documentExcerpt(`${prefix}!`, reviewers).excerpt?.coverage).toBe("full");
  expect(documentExcerpt(raw, reviewers).excerpt).toEqual({ text: prefix, coverage: "partial" });
  expect(documentExcerpt(`${raw}\npassword=fixtureSecret123`, reviewers)).toEqual({
    excerpt: { text: prefix, coverage: "partial" }, privacy: { status: "excerpt", reason: "possible-secret" },
  });
  expect(documentExcerpt("password=fixtureSecret123\nOrdinary text follows.", reviewers)).toEqual({
    privacy: { status: "skipped", reason: "possible-secret" },
  });
  expect(documentExcerpt("Public introduction.\n<private>Restricted text.</private>", reviewers)).toEqual({
    privacy: { status: "skipped", reason: "private-marker" },
  });
  expect(documentExcerpt("Safe introduction.\n-----BEGIN PRIVATE KEY-----\nfixture-key-body\n-----END PRIVATE KEY-----", reviewers)).toEqual({
    excerpt: { text: "Safe introduction.", coverage: "partial" }, privacy: { status: "excerpt", reason: "possible-secret" },
  });
});

it("normalizes the public GitHub REST comment shape, withholding deleted files and bot reviews", async () => {
  // Fields projected from GitHub's public /pulls/comments response. IDs, actor and body are fixture values.
  const inline = { id: 101, path: "src/runtime.ts", body: "Keep the stable snapshot identifier. Nice work, @fern-owner.",
    author_association: "COLLABORATOR", created_at: then, updated_at: then, line: null, position: null, original_position: 3,
    user: { login: "fern-owner", type: "User" }, is_copilot_code_review: false };
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/pulls/2")) return Response.json({ number: 2, merged_at: then, changed_files: 2 });
    if (path.endsWith("/pulls/2/files")) return Response.json([{ filename: "src/runtime.ts" }, { filename: "src/deleted.ts" }]);
    if (path.endsWith("/pulls/2/comments")) return Response.json([inline, { ...inline, id: 102, path: "src/deleted.ts" },
      { ...inline, id: 103, user: { login: "ci[bot]", type: "Bot" } }, { ...inline, id: 104, is_copilot_code_review: true }]);
    if (path.endsWith("/issues/2/comments")) return Response.json([{ ...inline, id: 105, path: undefined, position: 1,
      author_association: "MEMBER", body: "Before rendering, load the snapshot metadata because it defines stable IDs." }]);
    if (path.endsWith("/reviews")) return empty();
    throw new Error(`Unexpected URL in fixture: ${path}`);
  });
  const result = await githubReviews(new ForgeClient(github, undefined, request, 0), { ...window, source: github, pulls: [{ number: 2, at: then }], tree, preferred: [] });
  expect(result.gaps).toEqual([]);
  // The outdated inline comment led to a code change, so it ranks first.
  expect(result.reviews.map(item => item.id)).toEqual(["github:discussion_r:101", "github:issuecomment-:105"]);
  expect(result.reviews[0]).toMatchObject({ writer: true, outdated: true, text: "Keep the stable snapshot identifier. Nice work, [reviewer].",
    link: "https://github.com/fiction/memory/pull/2#discussion_r101" });
  const [outdated, topLevel] = result.reviews;
  expect(topLevel.writer).toBe(true);
  expect(topLevel.changedPaths).toEqual(["src/runtime.ts"]);
  expect(prioritizeReviews([{ ...topLevel, writer: false }, { ...outdated, outdated: false, id: "fresh" }, outdated], []).map(item => item.id))
    .toEqual([outdated.id, "fresh", topLevel.id]);
});

it("falls back on GitHub association for 403 or 404 without overriding explicit permission", async () => {
  const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false } });
  const cases = [
    { association: "NONE", push: true },
    { association: "OWNER", push: false },
    { association: "MEMBER", status: 403 },
    { association: "COLLABORATOR", status: 404 },
    { association: "OWNER", status: 403 },
    { association: "MEMBER", status: 200 },
    { association: "CONTRIBUTOR", status: 403 },
    { association: "NONE", status: 404 },
  ];
  const reads: number[][] = [], permissions: number[] = [];
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/graphql") {
      const { query } = JSON.parse(String(init?.body));
      expect(query).toContain("files(first:8){nodes{path}}");
      const pulls = [...String(query).matchAll(/p\d+:pullRequest\(number:(\d+)\)/gu)].map(match => Number(match[1]));
      reads.push(pulls);
      const repository = Object.fromEntries(pulls.map((number, i) => {
        const { association, push } = cases[number - 1]!;
        const comment = { fullDatabaseId: number, createdAt: then, body: "Keep the shared snapshot ID stable between builds.",
          author: { login: `writer-${number}`, __typename: "User" }, authorAssociation: association, authorCanPushToRepository: push };
        return [`p${i}`, { number, mergedAt: then, files: page([{ path: "src/runtime.ts" }, { path: "src/deleted.ts" }]),
          reviews: page(push === undefined ? [] : [comment]),
          comments: page(push === undefined && number !== 4 ? [comment] : []),
          reviewThreads: page(number === 4 ? [{ path: "src/runtime.ts", comments: page([comment]) }] : []) }];
      }));
      return Response.json({ data: { repository } });
    }
    const number = Number(/\/collaborators\/writer-(\d+)\/permission/u.exec(path)?.[1]);
    permissions.push(number);
    const status = cases[number - 1]?.status;
    if (!status) throw Error("Unexpected permission lookup.");
    return status === 200 ? Response.json({ permission: "read" }) : new Response(null, { status });
  });
  const pulls = cases.map((_, index) => ({ number: index + 1, at: then }));
  const result = await githubReviews(new ForgeClient(github, "fixture", request), { ...window, source: github, pulls, tree, preferred: [] });
  expect(reads).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
  expect(permissions).toEqual([3, 4, 5, 6, 7, 8]);
  expect(result.reviews.filter(review => review.writer).map(review => review.pull).sort()).toEqual([1, 3, 4, 5]);
  expect(result.reviews.find(review => review.pull === 1)?.changedPaths).toEqual(["src/runtime.ts"]);
  expect(result.reviews.find(review => review.pull === 2)?.changedPaths).toBeUndefined();
  expect(result.reviews.find(review => review.pull === 4)).toMatchObject({ topLevel: false });
});

it("uses GitLab's upstream and nested project permissions, and omits raw identities and tokens", async () => {
  const fork = { ...gitlab, slug: "fork-user/memory" }, project = encodeURIComponent(gitlab.slug);
  // Project and MR fields match the public GitLab responses; discussion/member fields follow the documented authenticated projection.
  const author = { id: 42, username: "fern-owner", name: "Fern Example", state: "active", bot: false };
  const note = { id: 81, body: "Keep the snapshot IDs stable. Thanks, Fern Example.", system: false, created_at: then, author,
    type: "DiffNote", resolvable: true, position: { new_path: "src/runtime.ts", head_sha: sha, position_type: "text" } };
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://gitlab.com");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
    if (url.pathname.endsWith("/projects/fork-user%2Fmemory")) return Response.json({ path_with_namespace: fork.slug, visibility: "private", forked_from_project: { id: 111 } });
    if (url.pathname.endsWith("/projects/111")) return Response.json({ path_with_namespace: gitlab.slug, visibility: "public" });
    const mr = { id: 928, iid: 5, state: "merged", merged_at: then, created_at: then, author };
    if (url.pathname.endsWith(`/projects/${project}/merge_requests`)) return Response.json([mr]);
    if (url.pathname.endsWith("/merge_requests/5")) return Response.json(mr);
    if (url.pathname.endsWith("/merge_requests/5/diffs")) return Response.json([{ new_path: "src/runtime.ts", diff: "excluded diff text" },
      { new_path: "src/deleted.ts" }]);
    if (url.pathname.endsWith("/merge_requests/5/discussions")) return Response.json([{ id: "c8d3", individual_note: false, notes: [note,
      { ...note, id: 82, body: "This leaked token is glpat-abcdefghijklmnopqrst." }, { ...note, id: 83, system: true },
      { ...note, id: 84, author: { ...author, bot: true } }] }]);
    if (url.pathname.endsWith("/members/all/42")) return Response.json({ id: 42, access_level: 30, state: "active" });
    throw new Error(`Unexpected URL in fixture: ${url.pathname}`);
  });
  const client = new ForgeClient(fork, "fixture-token", request, 0);
  const inventory = await gitlabInventory(client, window, 12);
  expect(inventory).toMatchObject({ source: gitlab, visibility: "private", pulls: [{ number: 5, at: then }] });
  const result = await gitlabReviews(client, { ...window, source: inventory.source, pulls: inventory.pulls, tree, preferred: [] });
  expect(result.reviews).toHaveLength(1);
  expect(result.reviews[0]).toMatchObject({ id: "gitlab:note:81", writer: true,
    changedPaths: ["src/runtime.ts"], text: "Keep the snapshot IDs stable. Thanks, [reviewer]." });
  expect(result.gaps).toEqual(["Some source text was withheld by privacy checks."]);
});

it("reports the anonymous GitLab discussion gap and respects the host's retry-after signal", async () => {
  const request = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/merge_requests/1")) return Response.json({ state: "merged", merged_at: then });
    if (path.endsWith("/discussions")) return new Response(null, { status: 401 });
    return new Response(null, { status: 429, headers: { "retry-after": "30" } });
  });
  const client = new ForgeClient(gitlab, undefined, request, 0);
  await expect(gitlabReviews(client, { ...window, source: gitlab, pulls: [{ number: 1, at: then }], tree, preferred: [] })).resolves.toMatchObject({
    reviews: [], gaps: ["Some GitLab discussions need a login."],
  });
  await expect(client.get("/projects/3")).rejects.toMatchObject({ problem: "rate-limit", retryAt: expect.any(Number) });
});
