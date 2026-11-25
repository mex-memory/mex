/**
 * Setup questions (knowledge-09): asked only for planted gaps, none without one; answers go
 * through the producer gate as "you said" entries with checks; skips are kept so nothing is
 * asked twice; an answer that needs no entry still steers code facts and setup recipes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EntryCheck } from "../../../knowledge/entry.js";
import type { ObserveChecks } from "../../../knowledge/gate.js";
import { knowledgeProject } from "../../../knowledge/context.js";
import { expand } from "../../../knowledge/store.js";
import type { RuleScan } from "../../../knowledge/rule-files.js";
import { recordLocation, type RecordLocation } from "../../../record/location.js";
import type { CodeFactsFile } from "../../history/job.js";
import type { RecipesFile } from "../../recipes/index.js";
import { answeredHandEdits, answeredTestCommands, readAnswers } from "../answers.js";
import { findGaps, MAX_QUESTIONS, type Gap } from "../gaps.js";
import { applySetupAnswers, pendingGaps, runSetupQuestions, type AskQuestion } from "../index.js";

let base: string, root: string, home: string, location: RecordLocation, projectId: string;
const write = (path: string, text: string) => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
/** The evaluator's stand-in: every check passes today with a fixed observation. */
const observeChecks: ObserveChecks = checks => checks.map(request => ({ check: {
  ...request, files: {},
  saw: request.kind === "command" ? { exists: true } : request.kind === "key" ? { value: "@acme/db" } : request.kind === "section" ? { hash: `sha256:${"a".repeat(64)}` } : { hash: `sha256:${"b".repeat(64)}` },
} as EntryCheck }));

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mex-setup-questions-"));
  root = join(base, "repo"); home = join(base, "home");
  mkdirSync(root); git("init", "-q");
  write("README.md", "# demo\n"); git("add", "."); git("commit", "-qm", "init");
  location = recordLocation({ home });
  projectId = knowledgeProject({ projectPath: root, home }).projectId;
});
afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }));

function section(path: string, heading: string, text: string) {
  return { path, agents: [], entry: { text, mex: { id: "mx_rulefile", kind: "rule", scope: ["**"], one_line: `${heading}: ${text}`, source: { type: "rule-file", ref: path },
    evidence: "docs", status: "active", created: "2026-11-21",
    checks: [{ kind: "section", role: "complete", target: { file: path, heading }, saw: { hash: "a".repeat(64) }, files: {} }] } } } as unknown as RuleScan["entries"][number];
}
function conflictScan(a: string, b: string): RuleScan {
  return { files: [], entries: [section("CLAUDE.md", "Testing", a), section("AGENTS.md", "Testing", b)],
    review: [{ kind: "conflict", paths: ["AGENTS.md", "CLAUDE.md"], heading: "Testing", message: "" }] };
}
function recipe(command: string, file: string, source: "config" | "ci" = "config") {
  return { package: "", purpose: "test", command, local: "yes", origin: [{ file, pointer: "/scripts/test" }], entry: { mex: { source: { type: source } } } };
}
const recipes = (items: unknown[], packages: unknown[] = []) => ({ version: 1, packages, recipes: items, build_order: [], review: [], partial: false, checks: "recorded" }) as unknown as RecipesFile;
const facts = (fields: Partial<CodeFactsFile>): CodeFactsFile => ({ version: 1, built_at: "", head: null, commits_read: 100, skipped: null, change_together: [], layer_rules: [], generated: [], ...fields });
const layerFacts = facts({ layer_exceptions: [{ from: "packages/ui", to: "packages/db", imports: 14, back: 2, files: ["packages/ui/a.ts", "packages/ui/b.ts"] }] });
const layerRecipes = recipes([], [{ path: "packages/db", kind: "node", name: "@acme/db" }, { path: "packages/ui", kind: "node", name: "@acme/ui" }]);
const always = (reply: string): AskQuestion => async () => reply;

describe("finding gaps", () => {
  it("asks nothing when setup found no gap", () => {
    expect(findGaps({ root })).toEqual([]);
    expect(findGaps({ root, scan: { files: [], entries: [], review: [] }, recipes: recipes([recipe("npm test", "package.json")]), facts: facts({}) })).toEqual([]);
  });

  it("asks about rule files that name different commands, not one that only says more", () => {
    const gaps = findGaps({ root, scan: conflictScan("Run `pnpm test` before a push.", "Run `npm test` before a push.") });
    expect(gaps.map(gap => gap.type)).toEqual(["rule-conflict"]);
    expect(gaps[0]!.question).toBe('`AGENTS.md` says `npm test`, `CLAUDE.md` says `pnpm test` (under "Testing"). Which is right?');
    expect(findGaps({ root, scan: conflictScan("Run `pnpm test`. Also `pnpm lint`.", "Run `pnpm test`.") })).toEqual([]);
    expect(findGaps({ root, scan: conflictScan("Run the tests first.", "Always run tests.") })).toEqual([]);
  });

  it("asks which test command is real only when config defines two, and suggests the one CI runs", () => {
    const two = findGaps({ root, recipes: recipes([recipe("npm run test", "package.json"), { ...recipe("tox -e py3", "tox.ini"), origin: [{ file: "tox.ini", pointer: "/testenv" }, { file: ".github/workflows/ci.yml", pointer: "/jobs/a" }] }]) });
    expect(two.map(gap => [gap.type, gap.suggested])).toEqual([["test-command", "2"]]);
    // A command known only from CI isn't a second candidate.
    expect(findGaps({ root, recipes: recipes([recipe("npm test", "package.json"), recipe("pnpm run test:bun", ".github/workflows/ci.yml", "ci")]) })).toEqual([]);
  });

  it("asks about a layer rule broken in a few places and a generated file edited by hand", () => {
    const gaps = findGaps({ root, recipes: layerRecipes, facts: { ...layerFacts, generated: [{ path: "src/gen.ts", signal: "marker" }], hand_edited: [{ path: "src/gen.ts", commits: 3 }] } });
    expect(gaps.map(gap => gap.type)).toEqual(["layer-exception", "hand-edited"]);
    expect(gaps[0]!.question).toContain("`packages/ui` imports `@acme/db` in 2 places");
    // History alone isn't a header: no question.
    expect(findGaps({ root, facts: facts({ generated: [{ path: "x.ts", signal: "history" }], hand_edited: [{ path: "x.ts", commits: 3 }] }) })).toEqual([]);
  });

  it("asks at most five, rule lines first", () => {
    const many = facts({ generated: Array.from({ length: 8 }, (_, i) => ({ path: `g${i}.ts`, signal: "marker" as const })), hand_edited: Array.from({ length: 8 }, (_, i) => ({ path: `g${i}.ts`, commits: 2 })) });
    const gaps = findGaps({ root, facts: many, scan: conflictScan("`pnpm test`", "`npm test`") });
    expect(gaps).toHaveLength(MAX_QUESTIONS);
    expect(gaps[0]!.type).toBe("rule-conflict");
  });
});

describe("answers", () => {
  /** The one entry an answer saved, read back from the store. */
  const saved = (outcomes: Awaited<ReturnType<typeof runSetupQuestions>>["outcomes"]) => {
    expect(outcomes.map(outcome => outcome.status === "saved" ? "saved" : `${outcome.status}: ${"line" in outcome ? outcome.line : ""}`)).toEqual(["saved"]);
    const outcome = outcomes[0]!;
    if (outcome.status !== "saved") throw new Error("not saved");
    return expand(outcome.entries[0]!, { projectPath: root, home }).entry;
  };
  const input = (extra: Partial<Parameters<typeof runSetupQuestions>[0]> = {}) => ({ root, projectId, location, observeChecks, ask: always("enter"), ...extra });

  it("saves a layer answer as a \"you said\" rule with checks, through the gate", async () => {
    const result = await runSetupQuestions(input({ recipes: layerRecipes, facts: layerFacts, ask: always("1") }));
    const entry = saved(result.outcomes);
    expect(entry.text).toContain("must not import `@acme/db`");
    expect(entry.mex.source).toMatchObject({ type: "person", label: "you said, at setup" });
    expect(entry.mex.evidence).toBe("person");
    expect(entry.mex.checks.map(check => [check.kind, check.role])).toEqual([["key", "complete"]]);
    expect(entry.mex.when?.map(trigger => trigger.type)).toEqual(["anti", "anti", "anti", "anti"]);
    // Asked once: the next run finds nothing to ask.
    expect(pendingGaps({ root, projectId, location, recipes: layerRecipes, facts: layerFacts })).toEqual([]);
  });

  it("keeps a yes that needs no entry, and skips everything with S", async () => {
    const both = { recipes: layerRecipes, facts: { ...layerFacts, generated: [{ path: "src/gen.ts", signal: "marker" as const }], hand_edited: [{ path: "src/gen.ts", commits: 3 }] } };
    const asked: Gap[] = [];
    const skipped = await runSetupQuestions(input({ ...both, ask: async gap => { asked.push(gap); return "skip-all"; } }));
    expect(asked).toHaveLength(1);
    expect(skipped.outcomes.map(outcome => outcome.status)).toEqual(["skipped", "skipped"]);
    expect(Object.values(readAnswers(location, projectId).answers).map(answer => answer.choice)).toEqual(["skip", "skip"]);
    expect(pendingGaps({ root, projectId, location, ...both })).toEqual([]);
  });

  it("lets code facts and setup recipes step aside for an answer", async () => {
    const generated = facts({ generated: [{ path: "src/gen.ts", signal: "marker" }], hand_edited: [{ path: "src/gen.ts", commits: 3 }] });
    const noted = await runSetupQuestions(input({ facts: generated, ask: always("2") }));
    expect(noted.outcomes.map(outcome => outcome.status)).toEqual(["noted"]);
    expect([...answeredHandEdits(location, projectId)]).toEqual(["src/gen.ts"]);

    write("package.json", JSON.stringify({ scripts: { test: "vitest" } }));
    write("tox.ini", "[testenv]\ncommands = pytest\n");
    const two = recipes([recipe("npm run test", "package.json"), recipe("tox -e py3", "tox.ini")]);
    const chosen = await runSetupQuestions(input({ recipes: two, ask: always("1") }));
    expect(saved(chosen.outcomes).mex.checks.map(check => check.kind)).toEqual(["command"]);
    expect([...answeredTestCommands(location, projectId)]).toEqual([""]);
  });

  it("applies just the selected gap and leaves the terminal's next prompt and skip behavior intact", async () => {
    const options = input({ scan: conflictScan("`npm test`", "`make test`"), recipes: layerRecipes, facts: layerFacts });
    const [first, other] = pendingGaps(options);
    expect((await applySetupAnswers(options, [{ gap: first!, reply: "skip" }]))?.map(outcome => outcome.status)).toEqual(["skipped"]);
    expect(pendingGaps(options).map(gap => gap.id)).toEqual([other!.id]);
    const seen: Array<[string, number, number]> = [];
    const result = await runSetupQuestions({ ...options, ask: async (gap, index, total) => {
      seen.push([gap.id, index, total]);
      return "skip-all";
    } });
    expect(seen).toEqual([[other!.id, 0, 1]]);
    expect(result).toMatchObject({ asked: 1, outcomes: [{ status: "skipped" }] });
    expect(pendingGaps(options)).toEqual([]);
  });

  it("saves a rule-file answer as a decision that fires on the out-of-date command", async () => {
    const result = await runSetupQuestions(input({ scan: conflictScan("Run `pnpm test` before a push.", "Run `npm test` before a push."), ask: always("1") }));
    // Sorted paths: AGENTS.md is choice 1 and names `npm test`; CLAUDE.md's `pnpm test` is out of date.
    const entry = saved(result.outcomes);
    expect(entry.mex.kind).toBe("decision");
    expect(entry.mex.when).toEqual([{ type: "rejected", match: "literal", pattern: "pnpm test" }]);
    expect(entry.text).toContain('Under "Testing", follow AGENTS.md');
    expect(entry.mex.checks.map(check => [check.kind, check.role])).toEqual([["section", "complete"], ["section", "complete"]]);
  });
});
