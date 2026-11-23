/**
 * Asking the setup questions (system-0.9 section 5.4): only a person at a terminal is asked,
 * at most five questions, each skippable, and all of them at once with S. Each answer goes
 * through the producer gate as a "you said" entry with checks (producer `setup-question`);
 * answers that need no entry are still kept, so nothing is asked twice.
 */
import type { RecordLocation } from "../../record/location.js";
import type { GateResult } from "../../knowledge/gate.js";
import { HAND_EDITS_FINE, readAnswers, saveAnswer, type GapType } from "./answers.js";
import { findGaps, type Gap, type GapInput } from "./gaps.js";

export type QuestionReply = string | "skip" | "skip-all";
/** Ask one question; resolves with a choice key, "skip" or "skip-all". */
export type AskQuestion = (gap: Gap, index: number, total: number) => Promise<QuestionReply>;
export type QuestionOutcome =
  | { gap: Gap; status: "saved"; entries: string[]; line: string }
  | { gap: Gap; status: "noted"; line: string }
  | { gap: Gap; status: "not saved"; line: string }
  | { gap: Gap; status: "skipped" };

export interface QuestionsInput extends GapInput {
  projectId: string;
  location: RecordLocation;
  env?: NodeJS.ProcessEnv;
  ask: AskQuestion;
  /** Called once per answered question, so the screen shows each result as it comes. */
  onOutcome?: (outcome: QuestionOutcome, index: number) => void;
  /** Tests: stand-ins for the native evaluator. */
  observeChecks?: import("../../knowledge/gate.js").GateContext["observeChecks"];
  now?: Date;
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

export async function runSetupQuestions(input: QuestionsInput): Promise<QuestionsResult> {
  const gaps = pendingGaps(input);
  const outcomes: QuestionOutcome[] = [];
  const date = (input.now ?? new Date()).toISOString().slice(0, 10);
  const at = (input.now ?? new Date()).toISOString();
  let skipRest = false;
  for (const [index, gap] of gaps.entries()) {
    const reply = skipRest ? "skip" : await input.ask(gap, index, gaps.length);
    if (reply === "skip-all") skipRest = true;
    let outcome: QuestionOutcome;
    if (reply === "skip" || reply === "skip-all" || !gap.choices.some(choice => choice.key === reply)) {
      saveAnswer(input.location, input.projectId, gap.id, { type: gap.type, choice: "skip", subject: gap.subject, at });
      outcome = { gap, status: "skipped" };
    } else {
      const resolution = gap.resolve(reply, date);
      // Keep the answer first: setup recipes and code facts read it to step aside.
      saveAnswer(input.location, input.projectId, gap.id, { type: gap.type, choice: reply, subject: resolution.subject, at });
      if (gap.type === "test-command") await refreshRecipes(input);
      if (gap.type === "hand-edited" && reply === HAND_EDITS_FINE) await requeueCodeFacts(input);
      if (!resolution.proposals.length) outcome = { gap, status: "noted", line: NOTED[gap.type] };
      else {
        const { propose } = await import("../../knowledge/gate.js");
        let results: GateResult[];
        try {
          results = await propose(resolution.proposals, { projectPath: input.root, home: input.location.home, env: input.env, now: input.now, observeChecks: input.observeChecks });
        } catch { results = [{ status: "dropped", reason: "checks-unavailable" }]; }
        const { saved, why } = line(results);
        if (saved.length) {
          saveAnswer(input.location, input.projectId, gap.id, { type: gap.type, choice: reply, subject: resolution.subject, at, entries: saved });
          outcome = { gap, status: "saved", entries: saved, line: `Saved: your agents get it as "you said"` };
        } else outcome = { gap, status: "not saved", line: `Not saved: ${why ?? "the gate kept it out"}` };
      }
    }
    outcomes.push(outcome);
    input.onOutcome?.(outcome, index);
  }
  return { asked: gaps.length, outcomes };
}

/** A chosen test command replaces the setup recipe that picked one for the package. */
async function refreshRecipes(input: QuestionsInput): Promise<void> {
  if (!input.recipes) return;
  try {
    const { saveSetupRecipes } = await import("../recipe-entries.js");
    saveSetupRecipes(input.recipes, { projectPath: input.root, home: input.location.home, env: input.env });
  } catch { /* the next `mex` or session-start refresh applies it */ }
}

/** Code facts drops its pitfall for a file the person edits by hand; a cheap free job. */
async function requeueCodeFacts(input: QuestionsInput): Promise<void> {
  try {
    const [{ openRecord }, { queueJob }] = await Promise.all([import("../../record/index.js"), import("../../record/background.js")]);
    const writer = openRecord({ home: input.location.home });
    try { queueJob(writer, { kind: "code-facts", projectId: input.projectId, params: { checkout: input.root } }); }
    finally { writer.close(); }
  } catch { /* the weekly re-count applies it */ }
}
