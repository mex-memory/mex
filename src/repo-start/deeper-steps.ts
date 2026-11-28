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
import { MARGIN, type Rich, wrapText } from "./rich.js";
import { select, TerminalBlock } from "./select.js";
import { DETACH_HINT, renderAnalysisActivity, WATCH_HINT } from "./analysis-screen.js";
import { readActivity, type DeepActivity } from "../learn-deeper/activity.js";
import type { ScreenMode } from "./screen.js";
import { renderFindings, renderNotes, wrap } from "./screen.js";
import { readSetupSteps, stepFromRow, type SetupStep } from "./steps.js";
import type { JobRow } from "../record/jobs.js";
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
export async function learnDeeperStep(projectId: string, location?: RecordLocation, jobId?: string): Promise<SetupStep | undefined> {
  const { openRecordReadOnly } = await import("../record/index.js");
  const reader = openRecordReadOnly(location && { home: location.home });
  try {
    if (!reader) return undefined;
    if (!jobId) return readSetupSteps(reader, projectId).find(step => step.kind === "learn-deeper");
    const row = reader.get<JobRow>("SELECT * FROM jobs WHERE id=? AND project_id=? AND kind='learn-deeper'", jobId, projectId);
    return row && stepFromRow(reader, row);
  }
  catch { return undefined; }
  finally { reader?.close(); }
}

const ACTIVE = new Set(["queued", "running", "waiting"]);
export const isAnalysisActive = (step: SetupStep): boolean => ACTIVE.has(step.state);

/**
 * Offer learn deeper once, after the free results. With no GitHub or GitLab remote there is
 * no review history: say so, $0, no job. A run already queued or running is shown, not
 * offered again.
 */
export async function offerLearnDeeper(context: DeeperContext, confirm?: Confirm): Promise<SetupStep | undefined> {
  const { origin, command, revision, PinnedTree } = await import("../learn-deeper/git.js");
  const quiet = context.rich ? (line: string) => {
    if (line.startsWith("Deep analysis not started")) {
      for (const out of context.rich!.text([context.rich!.commands(line)])) context.write(out);
      return;
    }
    const state = /^Deep analysis:? (?:started|queued|is already)/u.test(line) ? "ok" : /^Deep analysis later/u.test(line) ? "attention" : "background";
    for (const out of context.rich!.rows([{ state, text: line }])) context.write(out);
  } : context.write;
  if (!await origin(context.root).catch(() => undefined)) {
    const { docKind, documentPathKind } = await import("../learn-deeper/harvest/documents.js");
    const head = await revision(context.root);
    const [count, revertCount, tree] = head ? await Promise.all([
      command(context.root, "git", ["rev-list", "--count", head]),
      command(context.root, "git", ["rev-list", "--count", "--regexp-ignore-case", "--grep=^Revert \"", "--grep=This reverts commit ", head]),
      PinnedTree.open(context.root, head),
    ]) : [await command(context.root, "git", ["rev-list", "--count", "--all"]), undefined, undefined] as const;
    const commits = count === undefined ? undefined : Number(count.trim());
    const reverts = revertCount === undefined ? commits === 0 ? 0 : undefined : Number(revertCount.trim());
    let docs: number | undefined = commits === 0 ? 0 : undefined;
    if (tree) {
      docs = 0;
      // Ambiguous Markdown needs a heading check. Keep the free setup read bounded.
      let remaining = 32;
      for (const path of tree.paths()) {
        const kind = documentPathKind(path);
        if (kind === "doc" || kind === "adr") { docs++; continue; }
        if (kind !== "heading") continue;
        if (!remaining--) { if (!docs) docs = undefined; break; }
        if (docKind(path, await tree.read(path))) docs++;
      }
    }
    const empty = reverts === 0 && docs === 0;
    const details = [
      "no GitHub or GitLab remote, so no pull requests or reviews",
      ...(reverts === 0 ? [commits === 1 ? "1 commit, so no reverted fixes" : commits === 0 ? "no commits, so no reverted fixes"
        : commits === undefined ? "no reverted fixes found" : `${commits.toLocaleString("en-US")} commits, with no reverted fixes`] : []),
      ...(docs === 0 ? ["no contributor docs (CONTRIBUTING.md, docs/, decision records)"] : []),
    ];
    const intro = "Deep analysis learns your team's rules from pull-request reviews and discussions, PR descriptions, reverted fixes and contributor docs.";
    const next = "Once it's on GitHub or GitLab with some history, run `mex learn`. Nothing was spent.";
    const rich = context.rich;
    quiet(`Deep analysis: ${empty ? "nothing to analyse in this repo yet" : "needs a GitHub or GitLab remote"}`);
    if (rich) {
      const indent = `${MARGIN}${" ".repeat(17)}`;
      const width = Math.max(30, Math.min(100, context.mode.width ?? 100) - indent.length - 1);
      for (const line of wrapText(`${intro}${empty ? " This repo has none of them:" : ""}`, width)) context.write(indent + rich.dim(line));
      for (const line of details) context.write(`${indent}${rich.paint("bad", "✗")} ${rich.dim(line)}`);
      for (const line of wrapText(rich.commands(next), width)) context.write(indent + line);
    } else {
      const width = context.mode.width;
      for (const line of wrap(`${intro}${empty ? " This repo has none of them:" : ""}`, width, 2)) context.write(line);
      for (const detail of details) context.write(`  - ${detail}`);
      for (const line of wrap(next, width, 2)) context.write(line);
    }
    return undefined;
  }
  const before = await learnDeeperStep(context.projectId, context.location);
  if (before && isAnalysisActive(before)) {
    quiet(`Deep analysis: ${stepLine(before)} · run \`mex\` in this repo to watch it`);
    return before;
  }
  const { offerLearning } = await import("../learn-deeper/offer.js");
  await offerLearning({
    root: context.root, projectId: context.projectId, write: quiet, interactive: context.interactive,
    screenWrite: context.write, rich: context.rich, confirm: context.interactive ? confirm : undefined,
  });
  const after = await learnDeeperStep(context.projectId, context.location);
  return after && (after.jobId !== before?.jobId || isAnalysisActive(after)) ? after : undefined;
}

/** The terminal asker for setup questions: one key per question. */
export function terminalAsker(context: Pick<DeeperContext, "write" | "rich" | "mode">): AskQuestion {
  return async (gap, index, total) => {
    const rich = context.rich;
    const choices = gap.choices.map(choice => ({
      value: choice.key, label: rich?.codeTint(choice.label) ?? choice.label,
      ...(choice.key === gap.suggested ? { note: "suggested" } : {}),
    }));
    const body = [...gap.details, ...(gap.title && gap.type !== "rule-conflict" ? [gap.question] : [])];
    const indent = `${MARGIN}      `;
    const text = rich
      ? body.flatMap(line => wrapText(rich.codeTint(line), Math.max(20, (context.mode.width ?? 100) - indent.length - 1)).map(part => indent + part))
      : body.map(line => `  ${line}`);
    return await select([
      ...choices,
      { value: "skip", label: "Skip this question" },
      ...(index + 1 < total ? [{ value: "skip-all", label: "Skip the rest" }] : []),
    ], {
      rich: rich ?? null, focus: gap.suggested ? choices.findIndex(c => c.value === gap.suggested) : choices.length,
      title: [questionTitle(gap, index, total, rich), ...text, ""],
    }) ?? "skip";
  };
}

function questionTitle(gap: Gap, index: number, total: number, rich?: Rich): string {
  const count = `${index + 1} of ${total}`;
  const title = gap.title ?? gap.question;
  return rich ? `${MARGIN}${rich.cmd(count)}  ${rich.bold(rich.codeTint(title))}` : `${count}  ${title}`;
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
export interface QuestionsStepResult { asked: number; saved: number; waiting: number; resolvedConflicts?: string[]; }

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
  if (rich) for (const line of rich.section(title, input.learning ? "deep analysis keeps running meanwhile" : undefined)) write(line);
  else write(`${gaps.length === 1 ? "1 quick question" : `${gaps.length} quick questions`}${input.learning ? " (deep analysis keeps running meanwhile)" : ""}`);
  const ask = input.ask ?? terminalAsker(input);
  let skippedRestAt: number | undefined;
  const show = (outcome: QuestionOutcome, index: number) => {
    if (skippedRestAt !== undefined && index > skippedRestAt) return;
    const text = outcome.status === "skipped" ? skippedRestAt === index ? "skipped the rest" : "skipped · asked again only if the files change" : outcome.line;
    const state = outcome.status === "saved" || outcome.status === "noted" ? "ok" : outcome.status === "skipped" ? "skipped" : "attention";
    if (rich) {
      write(questionTitle(outcome.gap, index, gaps.length, rich));
      write(`      ${rich.answered(state, rich.codeTint(text))}`);
    }
    else for (const line of renderFindings([{ state: state === "skipped" ? "background" : state, text }], input.mode)) write(line);
    write("");
  };
  const result = await runSetupQuestions({
    ...input,
    ask: async (gap, index, total) => {
      const answer = await ask(gap, index, total);
      if (answer === "skip-all") skippedRestAt = index;
      return answer;
    },
    onOutcome: show,
  });
  const resolvedConflicts = result.outcomes.flatMap(outcome => outcome.gap.type === "rule-conflict" && outcome.status === "saved" ? [outcome.gap.subject] : []);
  return { asked: result.asked, saved: result.outcomes.filter(outcome => outcome.status === "saved").length, waiting: 0, ...(resolvedConflicts.length ? { resolvedConflicts } : {}) };
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
export async function watchLearnDeeper(context: DeeperContext, jobId: string, options: {
  pollMs?: number; capMs?: number;
  activity?: (location: RecordLocation, id: string) => DeepActivity | null;
} = {}): Promise<SetupStep | undefined> {
  const { rich, write } = context;
  if (!context.interactive || !process.stdin.isTTY) return undefined;
  await import("../record/job-kinds.js");
  const read = options.activity ?? readActivity;
  const live = rich ? new TerminalBlock() : undefined;
  let left = false;
  let previous: string | undefined;
  const stop = new AbortController();
  const leave = readKey(process.stdin, stop.signal).then(() => { left = true; });
  const started = Date.now();
  let step: SetupStep | undefined;
  try {
    for (;;) {
      step = await learnDeeperStep(context.projectId, context.location, jobId);
      if (!step || !isAnalysisActive(step)) break;
      const line = stepLine(step);
      const activity = step.state === "queued" ? null : read(context.location, jobId);
      const status = step.state === "waiting" ? line : undefined;
      const stage = activity ? `${activity.stage}:${status ?? ""}` : `${step.state}:${step.progress?.message.replace(/\d[\d,]*/gu, "") ?? ""}`;
      const lines = activity ? [...(rich ? [""] : []), ...renderAnalysisActivity(context.root, activity, { rich, status })]
        : rich ? [...rich.section("DEEP ANALYSIS"), ...rich.text([line, rich.commands(WATCH_HINT)])] : [`Deep analysis · ${line}`];
      if (live) live.draw(lines);
      else if (previous !== stage) {
        for (const line of lines.flatMap(line => wrap(line, context.mode.width, 2))) write(line);
        if (previous === undefined) write(WATCH_HINT);
        previous = stage;
      }
      await Promise.race([new Promise(resolve => setTimeout(resolve, options.pollMs ?? 500)), leave]);
      if (left || Date.now() - started > (options.capMs ?? 60 * 60_000)) break;
    }
  } finally { stop.abort(); live?.clear(); await leave; }
  if (rich) write("");
  if (!step || isAnalysisActive(step)) {
    const status = "Deep analysis keeps running in the background";
    if (rich) {
      for (const line of rich.rows([{ state: "background", text: status }])) write(line);
      write(`${MARGIN}${" ".repeat(17)}${rich.commands(DETACH_HINT)}`);
    } else { write(status); write(DETACH_HINT); }
  } else {
    const ok = step.state === "done" || step.state === "done with gaps";
    const finding = { state: ok ? "ok" as const : "attention" as const, text: `Deep analysis: ${ok && step.summary ? step.summary : step.error ?? step.state}` };
    for (const line of rich ? rich.rows([finding]) : renderFindings([finding], context.mode)) write(line);
  }
  return step;
}

/** One quiet note for agents and scripts when questions wait for a person. */
export function waitingNote(waiting: number, mode: ScreenMode): string[] {
  if (!waiting) return [];
  return renderNotes([`${waiting === 1 ? "1 setup question waits" : `${waiting} setup questions wait`} for you: run \`mex\` in a terminal to answer.`], mode);
}
