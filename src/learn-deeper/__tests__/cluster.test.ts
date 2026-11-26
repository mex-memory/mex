import { expect, it } from "vitest";
import { parseDocs, parseNorms, packObservations, normPrompt } from "../norm-writer.js";
import { candidate, observation, fixtureNorm, fixturePath } from "./fixtures/observations.js";

const norm = { text: fixtureNorm, kind: "api-design", scope: [fixturePath], patternable: false };
const parse = (items: ReturnType<typeof observation>[], support = items.map(item => item.id), extra = {}, paths = [fixturePath]) =>
  parseNorms(JSON.stringify({ policies: [], norms: [{ ...norm, support, ...extra }] }), items, [], new Map(), paths);

it("combines repeated decisions across distinct PRs and counts each PR only once", () => {
  const first = observation(1, { form: "decision", why: "Queue ordering.", stated_as_rule: false });
  const second = observation(2, { form: "decision", why: "Ordering must not change.", stated_as_rule: false });
  const samePull = observation(3, { pull: 2, stated_as_rule: false });
  const { drafts } = parse([first, second, samePull], [first.id, second.id, second.id, samePull.id]);
  expect(drafts).toHaveLength(1);
  expect(drafts[0]!.support).toMatchObject({ support: 2, pulls: [1, 2] });
  expect(drafts[0]!.entry.clauses[0]!.quotes).toHaveLength(3);
});

it("accepts an undisputed general rule and rejects a single PR with a one-off decision", () => {
  expect(parse([observation(1)]).drafts).toHaveLength(1);
  expect(parse([observation(1, { stated_as_rule: false })]).drops).toEqual({ support: 1 });
  expect(parse([observation(1, { response: "disputed" })]).drops).toEqual({ support: 1 });
});

it("refuses unsupported ids, generic wording, unknown scope and later disputed evidence", () => {
  const one = observation(1);
  expect(parse([one], [one.id, "made-up"]).drops).toEqual({ "unknown-support": 1 });
  expect(parse([one], [one.id], { text: "Keep code clear and validate input." }).drops).toEqual({ unnamed: 1 });
  expect(parse([one], [one.id], { scope: ["other/**"] }).drops).toEqual({ "invalid-claim-or-scope": 1 });
  const later = observation(2, { at: "2026-11-16T00:00:00.000Z", response: "disputed" });
  expect(parse([later, one]).drops).toEqual({ support: 1 });
});

it.each([
  [["src/**/*.?s"], ["src/**/*.?s"]],
  [["src"], ["src/**"]],
  [["src/", "src/**", "src"], ["src/**"]],
  [["repo"], ["**"]],
  [["**/**", "src"], ["src/**"]],
])("resolves %j against the pinned files as %j", (scope, expected) => {
  const { drafts, drops } = parse([observation(1)], undefined, { scope });
  expect(drops).toEqual({});
  expect(drafts[0]?.entry.scope).toEqual(expected);
});

it("keeps both the tracked directory and exact file of a mixed scope", () => {
  const file = "tokio-util/tests/task_join_map.rs";
  const { drafts } = parse([observation(1)], undefined,
    { scope: ["tokio/tests", file, "tokio/missing", "tokio/**/*.md"] }, ["tokio/tests/rt.rs", file]);
  expect(drafts[0]?.entry.scope).toEqual(["tokio/tests/**", file]);
});

it.each(["src/**/*.md", "sr", "src/queue.ts/"])("drops a scope with no tracked match for %s", scope => {
  expect(parse([observation(1)], undefined, { scope: [scope] }).drops).toEqual({ "invalid-claim-or-scope": 1 });
});

const secret = "AKIA" + "A".repeat(16);
it.each([
  "/src/**", "C:/src/**", "src\\**", "./src/**", "src//**", "src/../**",
  ".git/**", ".MEX/**", "{src,.g}{,it}/**", "{src,..}/**",
  "src/que\u200bue*", `src/${secret}*`,
])("drops unsafe scope %s even when the matcher has a file", scope => {
  const paths = [fixturePath, ".git/config", ".MEX/settings.yml", "src/que\u200bue.ts", `src/${secret}.ts`];
  expect(parse([observation(1)], undefined, { scope: [scope] }, paths).drops).toEqual({ "invalid-claim-or-scope": 1 });
});

it("does not use a hidden filename as the only evidence of a match", () => {
  const { drops } = parse([observation(1)], undefined, { scope: ["src/**"] }, ["src/que\u200bue.ts"]);
  expect(drops).toEqual({ "invalid-claim-or-scope": 1 });
});

it("accepts a matching brace glob from a doc rule", () => {
  const source = "CONTRIBUTING.md", scope = ["src/**/*.{ts,js}"];
  const doc = candidate(1, fixtureNorm, { kind: "doc", path: source });
  const reply = JSON.stringify({ rules: [{ text: fixtureNorm, quote: fixtureNorm, kind: "conventions", scope, source }] });
  expect(parseDocs(reply, [doc], [source, fixturePath]).drafts[0]?.entry.scope).toEqual(scope);
});

it("retains a named AI policy reference the docs reply omitted, with its condition and source", () => {
  const source = "docs/contributing/pull-requests.mdx", path = "docs/AI_Contribution_Policy.mdx";
  const quote = "Please read our [AI Contribution Policy](../AI_Contribution_Policy.mdx) if you use AI on a pull request.";
  const doc = candidate(1, quote, { kind: "doc", path: source });
  const { drafts, drops } = parseDocs('{"rules":[]}', [doc], [source, path, fixturePath]);
  expect(drops).toEqual({});
  expect(drafts).toMatchObject([{
    entry: { kind: "rule", route: "process-rule", scope: ["**"], when: [],
      claim: "Read `" + path + "` if you use AI on a pull request.",
      clauses: [{ quotes: [{ id: doc.id, quote }] }] },
    support: { source: "docs", members: [{ candidate: doc }] },
    patternable: false,
  }]);
});

it("does not add a second draft when the docs reply preserves the quoted policy reference", () => {
  const source = "CONTRIBUTING.md", path = "AI_POLICY.md";
  const quote = "If you use AI tools for a contribution, please follow the\n[AI policy](AI_POLICY.md) before opening a PR.";
  const doc = candidate(1, quote, { kind: "doc", path: source });
  const text = "Follow `AI_POLICY.md` before opening a PR with AI-assisted changes.";
  const reply = JSON.stringify({ rules: [{ text, quote, source, scope: "repo", kind: "process" }] });
  expect(parseDocs(reply, [doc], [source, path]).drafts.map(draft => draft.entry.claim)).toEqual([text]);
});

it.each([
  "Do not read [AI policy](AI_POLICY.md) when submitting a PR.",
  "Please read [AI policy](https://example.invalid/AI_POLICY.md) if you use AI in a PR.",
  "Please read [AI policy](https://example.invalid/../../AI_POLICY.md) if you use AI in a PR.",
  "Please read [AI policy](../AI_POLICY.md) if you use AI in a PR.",
  "Please read [AI policy](untracked/AI_POLICY.md) if you use AI in a PR.",
  "Please read [AI policy](AI_POLICY.md).",
  "```md\nRead [AI policy](AI_POLICY.md) if you use AI in a PR.\n```",
])("leaves unsupported policy references to the docs writer in %s", text => {
  const source = "CONTRIBUTING.md";
  const doc = candidate(1, text, { kind: "doc", path: source });
  expect(parseDocs('{"rules":[]}', [doc], [source, "AI_POLICY.md"]).drafts).toEqual([]);
});

it("lets a verified non-global scope locate an otherwise unnamed norm", () => {
  const text = "Keep retry tests deterministic.";
  const one = observation(1, { norm: text, quote: text });
  const paths = [fixturePath, "README.md"];
  expect(parse([one], undefined, { text, scope: ["src"] }, paths).drafts[0]?.entry.scope).toEqual(["src/**"]);
  for (const scope of [["repo"], ["**/*"], ["src", "README.md"], ["missing/**"]]) {
    expect(parse([one], undefined, { text, scope }, paths).drops).toEqual({ unnamed: 1 });
  }
});

it("sorts the writer's observations and splits a large input by related kinds", () => {
  const recent = observation(1, { at: "2026-11-17T00:00:00.000Z" });
  const past = observation(2, { at: "2026-11-16T00:00:00.000Z" });
  const prompt = normPrompt([recent, past], [{ id: "existing", claim: fixtureNorm }]);
  expect(prompt.indexOf(past.id)).toBeLessThan(prompt.indexOf(recent.id));
  expect(prompt).toContain("Work in two steps");
  expect(prompt).toContain('"id":"existing"');
  const group = Array.from({ length: 150 }, (_, i) => observation(i + 1, {
    why: "x".repeat(400), kind: i % 2 ? "api-design" : "tests",
  }));
  const batches = packObservations(group, []);
  expect(batches.length).toBeGreaterThanOrEqual(2);
  expect(batches.flat()).toHaveLength(group.length);
  expect(batches.every(batch => new Set(batch.map(item => item.kind)).size === 1)).toBe(true);
});
