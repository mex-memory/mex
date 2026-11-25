/**
 * Asking the setup questions (system-0.9 section 5.4): only a person at a terminal is asked,
 * at most five questions, each skippable, and all of them at once with S. Each answer goes
 * through the producer gate as a "you said" entry with checks (producer `setup-question`);
 * answers that need no entry are still kept, so nothing is asked twice.
 */
import { dirname } from "node:path";
import { openRecord, type RecordWriter } from "../../record/index.js";
import type { RecordLocation } from "../../record/location.js";
import type { GateResult } from "../../knowledge/gate.js";
import { HAND_EDITS_FINE, readAnswers, saveAnswers, type GapType, type StoredAnswer } from "./answers.js";
import { findGaps, type Gap, type GapInput } from "./gaps.js";

export type QuestionReply = string | "skip" | "skip-all";
/** Ask one question; resolves with a choice key, "skip" or "skip-all". */
export type AskQuestion = (gap: Gap, index: number, total: number) => Promise<QuestionReply>;
export type QuestionOutcome =
  | { gap: Gap; status: "saved"; entries: string[]; line: string }
  | { gap: Gap; status: "noted"; line: string }
  | { gap: Gap; status: "not saved"; line: string }
  | { gap: Gap; status: "skipped" };

interface AnswerInput extends GapInput {
  projectId: string;
  location: RecordLocation;
  env?: NodeJS.ProcessEnv;
  /** Tests: stand-ins for the native evaluator. */
  observeChecks?: import("../../knowledge/gate.js").GateContext["observeChecks"];
  now?: Date;
}
export interface QuestionsInput extends AnswerInput {
  ask: AskQuestion;
  /** Called once per answered question, so the screen shows each result as it comes. */
  onOutcome?: (outcome: QuestionOutcome, index: number) => void;
}
export interface QuestionsResult { asked: number; outcomes: QuestionOutcome[]; }

const NOTED: Record<GapType, string> = {
  "rule-conflict": "Noted",
  "test-command": "Noted",
  "layer-exception": "Noted: those imports are allowed",
  "hand-edited": "Noted: MEX won't warn about editing it by hand",
};
const DROPPED: Partial<Record<string, string>> = {
  "check-fails": "the check didn't pass against today's code",
  "duplicate-entry": "an entry already says this",
  "duplicate-rule-line": "a rule file already says this",
  "checks-unavailable": "the check evaluator isn't available",
  "undefined-command": "it names a command the repo doesn't define",
  "no-anchor": "MEX can't check that command in this repo yet",
};

/** The gaps worth asking about now, for counting without asking (agents and scripts). */
export function pendingGaps(input: GapInput & { projectId: string; location: RecordLocation }): Gap[] {
  let answered = new Set<string>();
  try { answered = new Set(Object.keys(readAnswers(input.location, input.projectId).answers)); } catch { /* ask again */ }
  return findGaps({ ...input, answered });
}

function line(results: readonly GateResult[]): { saved: string[]; why?: string } {
  const saved = results.flatMap(result => result.status === "accepted" ? [result.entryId] : []);
  const dropped = results.find(result => result.status === "dropped");
  const review = results.find(result => result.status === "review");
  return { saved, why: dropped?.status === "dropped" ? DROPPED[dropped.reason] ?? dropped.reason : review ? "it contradicts another entry; see `mex rules`" : undefined };
}

function recordOptions({ location }: AnswerInput) {
  return { home: location.home, ...(location.directory !== location.home ? { cache: dirname(location.directory) } : {}) };
}

/** Apply only the selected gaps. Callers resolve their IDs against current pending questions first. */
export async function applySetupAnswers(
  input: AnswerInput, replies: ReadonlyArray<{ gap: Gap; reply: string }>, useWriter?: RecordWriter,
): Promise<QuestionOutcome[] | undefined> {
  const now = input.now ?? new Date();
  const at = now.toISOString(), date = at.slice(0, 10);
  const prepared = replies.map(({ gap, reply }) => {
    const resolution = gap.choices.some(choice => choice.key === reply) ? gap.resolve(reply, date) : undefined;
    const answer: StoredAnswer = { type: gap.type, choice: resolution ? reply : "skip", subject: resolution?.subject ?? gap.subject, at };
    return { gap, resolution, answer };
  });
  const options = recordOptions(input);
  const writer = useWriter ?? openRecord(options);
  try {
    // Remember before checking. Setup recipes and code facts read this to step aside.
    if (!saveAnswers(writer, input.projectId, prepared.map(({ gap, answer }) => [gap.id, answer]), true)) return;
    const outcomes: QuestionOutcome[] = [];
    for (const { gap, resolution, answer } of prepared) {
      if (!resolution) { outcomes.push({ gap, status: "skipped" }); continue; }
      if (gap.type === "test-command") await refreshRecipes(input);
      if (gap.type === "hand-edited" && answer.choice === HAND_EDITS_FINE) await requeueCodeFacts(input);
      if (!resolution.proposals.length) { outcomes.push({ gap, status: "noted", line: NOTED[gap.type] }); continue; }

      const { propose } = await import("../../knowledge/gate.js");
      let results: GateResult[];
      try {
        results = await propose(resolution.proposals, { ...options, projectPath: input.root, env: input.env, now: input.now, observeChecks: input.observeChecks });
      } catch { results = [{ status: "dropped", reason: "checks-unavailable" }]; }
      const { saved, why } = line(results);
      if (saved.length) {
        saveAnswers(writer, input.projectId, [[gap.id, { ...answer, entries: saved }]], false);
        outcomes.push({ gap, status: "saved", entries: saved, line: 'Saved: your agents get it as "you said"' });
      } else {
        outcomes.push({ gap, status: "not saved", line: `Not saved: ${why ?? "the gate kept it out"}` });
      }
    }
    return outcomes;
  } finally { if (!useWriter) writer.close(); }
}

export async function runSetupQuestions(input: QuestionsInput): Promise<QuestionsResult> {
  const gaps = pendingGaps(input);
  const outcomes: QuestionOutcome[] = [];
  const now = input.now ?? new Date();
  let skipRest = false;
  for (const [index, gap] of gaps.entries()) {
    const reply = skipRest ? "skip" : await input.ask(gap, index, gaps.length);
    if (reply === "skip-all") skipRest = true;
    const [outcome] = await applySetupAnswers({ ...input, now }, [{ gap, reply }]) ?? [];
    if (outcome) {
      outcomes.push(outcome);
      input.onOutcome?.(outcome, index);
    }
  }
  return { asked: gaps.length, outcomes };
}

/** A chosen test command replaces the setup recipe that picked one for the package. */
async function refreshRecipes(input: AnswerInput): Promise<void> {
  if (!input.recipes) return;
  try {
    const { saveSetupRecipes } = await import("../recipe-entries.js");
    saveSetupRecipes(input.recipes, { ...recordOptions(input), projectPath: input.root, env: input.env });
  } catch { /* the next `mex` or session-start refresh applies it */ }
}

/** Code facts drops its pitfall for a file the person edits by hand; a cheap free job. */
async function requeueCodeFacts(input: AnswerInput): Promise<void> {
  try {
    const [{ openRecord }, { queueJob }] = await Promise.all([import("../../record/index.js"), import("../../record/background.js")]);
    const writer = openRecord(recordOptions(input));
    try { queueJob(writer, { kind: "code-facts", projectId: input.projectId, params: { checkout: input.root } }); }
    finally { writer.close(); }
  } catch { /* the weekly re-count applies it */ }
}
