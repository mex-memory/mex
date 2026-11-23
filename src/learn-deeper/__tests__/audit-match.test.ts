import { expect, it } from "vitest";
import { planClusters, type Triaged } from "../cluster.js";
import type { PinnedTree } from "../git.js";
import { meaningPrompt, meaningVerdicts, type MeaningQuestion, type MeaningVerdict } from "../meaning.js";
import { recordedMeaning } from "./fixtures/meaning.js";
import { proveEntry, quoteChecks } from "../prove.js";
import type { WriterEntry } from "../write.js";
import audit from "./fixtures/lesson-match-audit.json";
import calibration from "./fixtures/lesson-match-calibration.json";
import clauses from "./fixtures/clause-quotes.json";

function item(lesson: string, n: number, category = "api-use", text = lesson): Triaged {
  const id = "gh:thread:" + n;
  return {
    candidate: {
      id, text, kind: "review-thread", at: "2026-01-01", pull: n, path: "src/task.ts",
      link: "https://github.com/example/project/pull/" + n, reviewers: ["r" + n], signal: "strong",
      hash: "sha256:" + "a".repeat(64), nodeIds: [],
      weights: { actedOn: true, familiar: true, generalising: true, guidelineLink: false, smallPr: true, hotUnknown: false },
    },
    triage: { id, lesson, keep: true, category: category as Triaged["triage"]["category"] },
  };
}

function recordedVerdicts(questions: readonly MeaningQuestion[], verdict: MeaningVerdict) {
  return meaningVerdicts(JSON.stringify(recordedMeaning(meaningPrompt(questions), () => verdict)), questions);
}

for (const [name, pairs] of [["audit", audit], ["calibration", calibration]] as const) {
  it(`sends each non-obvious ${name} pair and applies the recorded verdict`, () => {
    let judged = 0;
    for (const [label, a, b, ac, bc] of pairs) {
      const first = item(a!, 1, ac), second = item(b!, 2, bc);
      const obvious = first.triage.category !== second.triage.category;
      const filler = Array.from({ length: 4 }, (_, i) => item("Quorum epoch filler " + i, i + 3, "security"));
      for (const items of [[first, second], [first, second, ...filler]]) {
        const plan = planClusters(items);
        const matches = plan.questions.map((question, i) => ({ question, i })).filter(({ question }) => "lesson" in question &&
          question.lesson.left.lesson === a && question.lesson.right.lesson === b);
        expect(matches).toHaveLength(obvious ? 0 : 1);
        const verdicts = plan.questions.map((_, i) => matches.some(match => match.i === i) ? label : "different");
        const answer = meaningVerdicts(JSON.stringify({ results: verdicts.map((verdict, i) => [i, verdict]) }), plan.questions);
        expect(answer).toHaveLength(plan.questions.length);
        expect(plan.resolve(answer).some(cluster => cluster.pulls.includes(1) && cluster.pulls.includes(2))).toBe(!obvious && label === "same");
      }
      if (!obvious) judged++;
      // Existing and refused entries have no triage category. Even identical claim text requires a judgment.
      const prior = { id: "prior", text: "Full note body; do not send it.", claim: b!, scope: ["src/task.ts"], patterns: [], refused: true };
      const plan = planClusters([first], { earlier: [prior] });
      expect(plan.questions).toEqual([{ lesson: { left: { lesson: a }, right: { lesson: b } } }]);
      expect(plan.resolve(recordedVerdicts(plan.questions, label === "same" ? "same" : "different"))[0]!.earlier)
        .toBe(label === "same" ? "prior" : undefined);
    }
    if (name === "audit") expect([pairs.length, judged]).toEqual([40, 39]);
  });
}

it("requires one allowed verdict for every index", () => {
  const questions = [{ clause: "Keep the lease.", quote: "Hold the lease." }, { clause: "Close later.", quote: "Close first." }];
  const answer = (results: unknown) => meaningVerdicts(JSON.stringify({ results }), questions);
  expect(answer([[1, "contradicts"], [0, "supports"]])).toEqual(["supports", "contradicts"]);
  for (const results of [[[0, "supports"]], [[0, "supports"], [0, "unrelated"]], [[0, "supports"], [2, "unrelated"]],
    [[0, "same"], [1, "unrelated"]]]) expect(answer(results)).toBeUndefined();
});

const tree = {
  root: ".", head: "b".repeat(40), paths: () => ["src/task.ts"], has: () => true, read: async () => "",
} as unknown as PinnedTree;

async function proveQuote(claim: string, quote: string, verdict: MeaningVerdict, source = quote) {
  const first = item(claim, 1, "api-use", source);
  const [cluster] = planClusters([first]).resolve();
  const entry: WriterEntry = {
    claim, cluster: cluster!.key, route: "code-rule", kind: "rule", why: "", clauses: [{ text: claim, quotes: [{ id: first.candidate.id, quote }] }],
    scope: ["src/task.ts"], when: [], aliases: [],
  };
  const citations = quoteChecks(entry, cluster!)[0]!.citations;
  const supportingQuotes = new Set(citations.flatMap(({ citation, question }) =>
    question && recordedVerdicts([question], verdict)?.[0] === "supports" ? [citation] : []));
  const proof = await proveEntry(entry, cluster!, { tree, check: { projectPath: "." } }, { supportingQuotes, sameEarlier: false });
  return { proof, eligible: !!citations[0]?.question };
}

it("uses the recorded quote verdicts for paraphrases, reversals, and invented qualifiers", async () => {
  for (const [expected, claim, quote] of clauses) {
    const result = await proveQuote(String(claim), String(quote), expected ? "supports" : "unrelated");
    expect(!result.proof.dropped, String(claim)).toBe(expected);
    if (expected) expect(result.eligible).toBe(true);
  }
  expect((await proveQuote("Use the package root.", "The package root owns this file.", "contradicts")).proof.dropped).toMatch(/claim/u);
});

it("keeps missing, clipped, and explicitly reversed quotes out of the model batch", async () => {
  const claim = "Use stableAdapter for messages.";
  for (const [quote, source] of [
    ["Use stableAdapter for messages", "Use a different adapter."],
    ["use stableAdapter for messages", "Never use stableAdapter for messages."],
    ["Use stableAdapter for messages", "Use stableAdapter for messages only when retrying."],
    ["Never use stableAdapter for messages.", "Never use stableAdapter for messages."],
  ]) {
    const result = await proveQuote(claim, quote!, "supports", source);
    expect(result.eligible).toBe(false);
    expect(result.proof.dropped).toMatch(/claim/u);
  }
  const reversed = await proveQuote("Use the scoped key instead of the global key.", "Use the global key instead of the scoped key.", "supports");
  expect(reversed.eligible).toBe(false);
});
