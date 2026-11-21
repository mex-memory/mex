/**
 * Setup after the free step (system-0.9 section 5.3 and 5.4): the learn-deeper offer, then
 * the setup questions while learn deeper runs, then (rich, for a person) the live view of
 * learn deeper until it ends or a key leaves it running in the background. The plain screen
 * runs the same steps with the same engine, so both write the same entries.
 *
 * Learn deeper's engine and quote are learning-03's (learn-deeper/offer.ts); this file only
 * presents them. Nothing here starts paid work for an agent, a script or CI.
 */
import type { RecordLocation } from "../record/location.js";
import type { RuleScan } from "../knowledge/rule-files.js";
import type { RecipesFile } from "./recipes/index.js";
import type { CodeFactsFile } from "./history/job.js";
import { readKey } from "./keys.js";
import type { Rich } from "./rich.js";
import type { ScreenMode } from "./screen.js";
import { renderFindings, renderNotes } from "./screen.js";
import { readSetupSteps, type SetupStep } from "./steps.js";
import type { AskQuestion, QuestionOutcome } from "./questions/index.js";
import type { Gap } from "./questions/gaps.js";

type Print = (line: string) => void;
type Confirm = (lines: readonly string[], details: readonly string[]) => Promise<boolean>;

export interface DeeperContext {
  root: string;
  projectId: string;
  location: RecordLocation;
  write: Print;
  rich?: Rich;
  mode: ScreenMode;
  /** A person at a terminal; never true for an agent, a script or CI. */
  interactive: boolean;
  env: NodeJS.ProcessEnv;
}

/** The learn-deeper step's row now, if this project has one. */
export async function learnDeeperStep(projectId: string): Promise<SetupStep | undefined> {
  const { openRecordReadOnly } = await import("../record/index.js");
  const reader = openRecordReadOnly();
  try { return reader ? readSetupSteps(reader, projectId).find(step => step.kind === "learn-deeper") : undefined; }
  catch { return undefined; }
  finally { reader?.close(); }
}

const ACTIVE = new Set(["queued", "running", "waiting"]);

/** The offer in the screen's style: the estimate first, Enter starts it, s skips it. */
function richConfirm(rich: Rich, write: Print): Confirm {
  return async (lines, details) => {
    const [question, ...rest] = lines;
    for (const line of rich.section("LEARN DEEPER", "on by default · runs in the background through your agent")) write(line);
    for (const line of rich.text([question ?? ""])) write(line);
    for (const line of rich.text(rest, true)) write(line);
    for (;;) {
      write(rich.keys([["Enter", "start"], ["s", "skip"], ...(details.length ? [["d", "details"] as const] : [])]));
      const key = await readKey();
      if (key === "enter") return true;
      if (key === "d" && details.length) { for (const line of rich.text(details, true)) write(line); continue; }
      return false;
    }
  };
}

/**
 * Offer learn deeper once, after the free results. With no GitHub or GitLab remote there is
 * no review history: say so, $0, no job. A run already queued or running is shown, not
 * offered again.
 */
export async function offerLearnDeeper(context: DeeperContext, confirm?: Confirm): Promise<SetupStep | undefined> {
  const { origin } = await import("../learn-deeper/git.js");
  // Rich: each of the offer's lines is a "Learn deeper" row, like every other step.
  const quiet = context.rich ? (line: string) => {
    const state = /^Learn deeper (?:queued|is already)/u.test(line) ? "ok" : /^Learn deeper later/u.test(line) ? "attention" : "background";
    for (const out of context.rich!.rows([{ state, text: line }])) context.write(out);
  } : context.write;
  if (!await origin(context.root).catch(() => undefined)) {
    // Only a person reads it; agents and scripts see nothing about a paid step.
    if (context.interactive) quiet("Learn deeper: no reviews to learn from (no GitHub or GitLab remote) · $0, nothing started");
    return undefined;
  }
  const before = await learnDeeperStep(context.projectId);
  const { offerLearning } = await import("../learn-deeper/offer.js");
  await offerLearning({
    root: context.root, projectId: context.projectId, write: quiet, interactive: context.interactive,
    confirm: confirm ?? (context.rich && context.interactive ? richConfirm(context.rich, context.write) : undefined),
  });
  const after = await learnDeeperStep(context.projectId);
  return after && ACTIVE.has(after.state) && (after.jobId !== before?.jobId || ACTIVE.has(before.state)) ? after : undefined;
}

/** The terminal asker for setup questions: one key per question. */
export function terminalAsker(context: Pick<DeeperContext, "write" | "rich" | "mode">): AskQuestion {
  return async (gap, index, total) => {
    if (context.rich) for (const line of context.rich.question({ index, total, text: gap.question, choices: gap.choices, suggested: gap.suggested })) context.write(line);
    else {
      context.write(`Question ${index + 1} of ${total}: ${gap.question}`);
      context.write(`  ${gap.choices.map(choice => `${choice.key} = ${choice.label}`).join(", ")}; Enter = ${gap.suggested ?? "skip"}, s = skip, S = skip all`);
    }
    const key = await readKey();
    if (key === "quit" || key === "S") return "skip-all";
    if (key === "enter") return gap.suggested ?? "skip";
    if (gap.choices.some(choice => choice.key === key)) return key;
    return "skip";
  };
}

export interface QuestionsStepInput extends DeeperContext {
  scan?: RuleScan;
  recipes?: RecipesFile;
  facts?: CodeFactsFile;
  /** Tests: answer without a terminal. */
  ask?: AskQuestion;
  observeChecks?: import("../knowledge/gate.js").GateContext["observeChecks"];
  /** Learn deeper is running, so the section says the questions are asked meanwhile. */
  learning: boolean;
}
export interface QuestionsStepResult { asked: number; saved: number; waiting: number; }

/**
 * The setup questions: asked only of a person, only for real gaps, at most five. For anyone
 * else the count is said once, so a person can answer them at the next `mex` in a terminal.
 */
export async function questionsStep(input: QuestionsStepInput): Promise<QuestionsStepResult> {
  const { pendingGaps, runSetupQuestions } = await import("./questions/index.js");
  let gaps: Gap[];
  try { gaps = pendingGaps(input); } catch { return { asked: 0, saved: 0, waiting: 0 }; }
  if (!gaps.length) return { asked: 0, saved: 0, waiting: 0 };
  if (!input.interactive && !input.ask) return { asked: 0, saved: 0, waiting: gaps.length };
  const { write, rich } = input;
  const title = `${gaps.length === 1 ? "1 QUICK QUESTION" : `${gaps.length} QUICK QUESTIONS`}`;
  if (rich) for (const line of rich.section(title, input.learning ? "asked while learn deeper runs · only you can answer these" : "only you can answer these")) write(line);
  else write(`${gaps.length === 1 ? "1 question" : `${gaps.length} questions`} only you can answer${input.learning ? " (learn deeper runs meanwhile)" : ""}:`);
  const show = (outcome: QuestionOutcome) => {
    const text = outcome.status === "skipped" ? "Skipped" : outcome.line;
    const state = outcome.status === "saved" || outcome.status === "noted" ? "ok" : outcome.status === "skipped" ? "skipped" : "attention";
    if (rich) write(rich.answered(state, text));
    else for (const line of renderFindings([{ state: state === "skipped" ? "background" : state, text }], input.mode)) write(line);
  };
  const result = await runSetupQuestions({
    ...input, ask: input.ask ?? terminalAsker(input), onOutcome: show,
  });
  return { asked: result.asked, saved: result.outcomes.filter(outcome => outcome.status === "saved").length, waiting: 0 };
}

/** What the live view shows for a step: its progress, or why it waits. */
export function stepLine(step: SetupStep): string {
  if (step.state === "waiting") return step.error ?? "waiting";
  if (step.state === "queued") return "queued; starts after the code map and other setup work";
  return step.progress?.message ?? "running";
}

/**
 * The live view of learn deeper, for a person at a rich terminal: progress until it ends, or
 * until any key leaves it running in the background (closing the terminal does the same).
 */
export async function watchLearnDeeper(context: DeeperContext, jobId: string, options: { pollMs?: number; capMs?: number } = {}): Promise<SetupStep | undefined> {
  const { rich, write } = context;
  if (!rich || !context.interactive || !process.stdin.isTTY) return undefined;
  const { LiveLine } = await import("./screen.js");
  const live = new LiveLine(context.mode);
  let left = false;
  const stop = new AbortController();
  const leave = readKey(process.stdin, stop.signal).then(() => { left = true; });
  const started = Date.now();
  let step: SetupStep | undefined;
  live.start("Learn deeper");
  try {
    for (;;) {
      step = (await learnDeeperStep(context.projectId));
      if (!step || step.jobId !== jobId || !ACTIVE.has(step.state)) break;
      const done = step.progress?.done, total = step.progress?.total;
      live.update(`${stepLine(step)} · any key leaves it running`, done !== undefined && total ? done / total : undefined);
      await Promise.race([new Promise(resolve => setTimeout(resolve, options.pollMs ?? 500)), leave]);
      if (left || Date.now() - started > (options.capMs ?? 60 * 60_000)) break;
    }
  } finally { stop.abort(); live.stop(); }
  if (!step || ACTIVE.has(step.state)) {
    for (const line of rich.text(["Learn deeper keeps running in the background. `mex jobs` shows it; `mex` here shows it live again."], true)) write(line);
  } else {
    const ok = step.state === "done" || step.state === "done with gaps";
    for (const line of rich.rows([{ state: ok && step.state === "done" ? "ok" : "attention", text: `Learn deeper ${step.state}${step.summary ? `: ${step.summary}` : step.error ? `: ${step.error}` : ""}` }])) write(line);
  }
  return step;
}

/** One quiet note for agents and scripts when questions wait for a person. */
export function waitingNote(waiting: number, mode: ScreenMode): string[] {
  if (!waiting) return [];
  return renderNotes([`${waiting === 1 ? "1 setup question waits" : `${waiting} setup questions wait`} for you: run \`mex\` in a terminal to answer.`], mode);
}
