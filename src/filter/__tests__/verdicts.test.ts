import { expect, it } from "vitest";
import type { FilterInput, Message } from "../input.js";
import { parseStageOne, stageOnePrompt, verbatimNote } from "../verdicts.js";

function message(text: string, row = 1, extra: Partial<Message> = {}): Message {
  return { id: "m" + row, row, session: "fixture", at: "2026-11-25T12:00:00Z", text, marks: "", previous_reply: null, delivered: [], ...extra };
}
const input = (...messages: Message[]): FilterInput => ({ messages, notes: [], files: [], delivered_notes: [] });
const candidate = (quote: string, fields: Record<string, unknown> = {}) => ({
  id: "m1", verdict: "candidate", kind: "instruction", lasts: "repo", marker: null, quote, reason: null, ...fields,
});
const reply = (...verdicts: unknown[]) => JSON.stringify({ verdicts });

it.each([
  { text: "Tests run serially because fixtures share state.", quote: "Tests run serially", kind: "fact", reason: "because fixtures share state", lifetime: "repo" },
  { text: "We chose the smaller binary. It fits our download budget.", quote: "We chose the smaller binary", kind: "decision", reason: "It fits our download budget", lifetime: "repo" },
  { text: "Tests run serially because fixtures share state.", kind: "fact", reason: "fixtures share state", lifetime: "repo" },
  { text: "Tests run serially.", kind: "fact" },
  { text: "We chose the smaller binary.", kind: "decision", reason: "because downloads are faster" },
  { text: "We chose the smaller binary.", kind: "decision", reason: "the smaller binary" },
  { text: "Always use the project formatter.", marker: "Always", lifetime: "repo" },
  { text: "Never edit generated files.", marker: "Never", lifetime: "repo" },
  { text: "From now on, use signed fixtures.", kind: "correction", marker: "From now on", lifetime: "repo" },
  { text: "In this repo use the smaller runner.", marker: "In this repo", lifetime: "repo" },
  { text: "We use tabs in shell fixtures.", marker: "We use", lifetime: "repo" },
  { text: "Skip slow tests." },
  { text: "Please skip slow tests.", marker: "Please" },
  { text: "For now, skip slow tests.", marker: "For now", lifetime: "branch" },
  { text: "For this release, keep uploads local.", marker: "For this release,", lifetime: "release" },
  { text: "Keep uploads local until this branch merges.", marker: "until this branch merges", lifetime: "branch" },
  { text: "Skip this path until we ship beta.2.", marker: "until we ship beta.2", lifetime: "release" },
  { text: "Turn this on later, not in 0.9.", marker: "not in 0.9", lifetime: "release" },
  { text: "Across all my projects, use drafts for experiments.", marker: "Across all my projects", lifetime: "all" },
  { text: "Use tool falways.", marker: "always" },
  { text: "Yes, option 2.", kind: "approval" },
])("applies the lasting rule to $text", ({ text, quote = text, kind, marker = null, reason = null, lifetime }) => {
  const fields = { ...(kind ? { kind } : {}), marker, reason };
  const result = parseStageOne(reply(candidate(quote, fields)), input(message(text)));
  expect(result.missing).toEqual([]);
  expect(result.verdicts[0]).toMatchObject({ verdict: "candidate", outcome: lifetime ? "personal" : "unsure",
    quote: { start: text.indexOf(quote), end: text.indexOf(quote) + quote.length, text: quote } });
  expect(verbatimNote(result.verdicts[0]!)).toEqual(lifetime ? { lasts: lifetime, text: '[you said, 2026-11-25] "' + quote + '"' } : undefined);
});

it("keeps the actual typed scope and withholds authorless or repeated evidence", () => {
  const text = "For this release, keep uploads local.";
  const scoped = candidate(text, { lasts: "all", marker: "For this release" });
  const typed = input(message(text));
  expect(parseStageOne(reply(scoped), typed).verdicts[0]).toMatchObject({ lasts: "release", outcome: "personal" });
  expect(parseStageOne(reply({ ...scoped, lasts: "task" }), typed).verdicts[0]).toMatchObject({ lasts: "task", outcome: "unsure" });
  expect(parseStageOne(reply(scoped), { ...typed, delivered_notes: [{ id: "mx_delivered", text }] }).verdicts[0]).toMatchObject({ outcome: "unsure" });
  const fabricated = candidate(text, { marker: "Always" });
  expect(parseStageOne(reply(fabricated), input(message(text, 1, { previous_reply: "Always do that." }))).verdicts[0]).toMatchObject({ marker: null, outcome: "unsure" });
  expect(stageOnePrompt(input(message(text, 1, { marks: "scripted" })))).not.toContain(text + '"');
});

it("keeps valid siblings and identifies IDs lacking a unique valid verdict", () => {
  const given = input(message("Run tests now."), message("A correction.", 2), message("Continue this next time.", 3),
    message("Another task.", 4), message("Pasted text.", 5, { marks: "pasted" }), message("Nothing to save.", 6));
  const result = parseStageOne(reply({ id: "m1", verdict: "task" },
    { id: "m2", verdict: "none" }, { id: "m2", verdict: "task" }, { id: "m3", verdict: "next-session", quote: "Invented words" },
    { id: "m5", verdict: "none" }, { id: "m6", verdict: "none" }, { id: "m999", verdict: "none" }), given);
  expect(result.verdicts).toEqual([{ id: "m1", verdict: "task" }, { id: "m6", verdict: "none" }]);
  expect(result.missing).toEqual([2, 3, 4]);
  expect(result.coverage).toEqual({ missing: 3, duplicate: 1, unknown: 2, invalid: 1 });
  expect(parseStageOne("invalid JSON", given).coverage).toMatchObject({ missing: 5, invalid: 1 });
});

it("keeps only approvals consistent with the visible option and the person's pick", () => {
  const text = "Yes, option 2";
  const options = [{ row: 900, option: 1, text: "1. Use a shared cache" }, { row: 900, option: 2, text: "2. Keep the cache local" }];
  const given = input(message(text, 1, { previous_reply: options.map(option => option.text).join("\n"), previous_options: options }));
  const approval = (row: number, option: number) => candidate(text, { kind: "approval", approval: { row, option }, marker: null });
  expect(parseStageOne(reply(approval(900, 2)), given).verdicts[0]).toMatchObject({ outcome: "unsure", approval: { row: 900, option: 2 } });
  for (const item of [approval(900, 1), approval(901, 2)])
    expect(parseStageOne(reply(item), given).verdicts[0]).toMatchObject({ outcome: "unsure", approval: null });
  expect(parseStageOne(reply(approval(900, 2)), input(message(text))).verdicts[0]).toMatchObject({ outcome: "unsure", approval: null });
  const ambiguous = input(message("yes", 1, { previous_reply: given.messages[0]!.previous_reply, previous_options: options }));
  expect(parseStageOne(reply(candidate("yes", { kind: "approval", approval: { row: 900, option: 2 } })), ambiguous).verdicts[0]).toMatchObject({ approval: null });
});
