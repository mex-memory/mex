import { populationWarning, fillPopulationPlaceholders, populationPlaceholderFiles, unpopulatedScaffoldFiles } from "./population-audit.js";
import { withSetupLock } from "./setup-lock.js";
import { describeUnfinishedSetup } from "./unfinished.js";
/**
 * `mex setup next`: the one-paste setup for agents MEX cannot launch itself.
 *
 * The user pastes one short prompt into their agent: run `mex setup next --start` first and
 * do what it prints, until it says setup is complete. Each call:
 *
 * 1. settles the ready units the previous call handed out: MEX applies the batch file
 *    each unit wrote, in-process, through the same path as background setup
 *    (`wiki apply --apply`, one atomic batch, replay per opId), or hands back
 *    that unit's fix task with the refusal diagnostics and candidates;
 * 2. records the progress in the stored setup plan;
 * 3. hands out pending units as task files (the shared files, one subsystem,
 *    or for small repositories the whole population), with the
 *    exact next command; after the last unit it finalizes Graph and Wiki and
 *    prints the completion summary.
 *
 * Every call is safe to repeat: the unit handed out last is recorded, batches
 * replay by opId, an unchanged refused batch is not counted as a second try,
 * and a crashed or abandoned chat continues where the stored plan says.
 */
import { createHash, randomUUID } from "node:crypto";
import { cleanupStaleSetupPrompts } from "../agent-prompt.js";
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfiguredAiTools } from "../config.js";
import { describeGroundingDrift } from "../graph/grounding-failures.js";
import { SetupError } from "./errors.js";
import { runHeadlessSetup } from "./headless.js";
import { isScaffoldPopulated, setupCommitCheckpointCommands, SetupFinalizationError, type ProjectState, type SetupMode } from "./index.js";
import { buildSetupPopulationPrompt, buildSetupGraph, resolveSetupMode } from "./phases.js";
import {
  POPULATION_FINISH,
  SHARED_CONTEXT_FILES,
  buildBatchFixPrompt,
} from "./prompts.js";
import { createSetupBatchApplier, type BatchApplyOutcome, type BatchProblem, type BatchScope, type SetupBatchApplier } from "./subsystem-apply.js";
import { buildSetupUnitPrompt, resolveParallelRuns, renderPlanProgress, SETUP_PLAN_VIEW_FILE, shouldRunPerSubsystem } from "./subsystem-runs.js";
import {
  SHARED_UNIT_SLUG,
  createPlanState,
  loadPlanState,
  isUnstartedSetupPlan,
  savePlanState,
  subsystemWikiFile,
  unitBatchFile,
  type QueueUnitId,
  type SetupPlanState,
  type SubsystemUnit,
} from "./subsystem-state.js";
import { readSetupBatch, reconcileSetupNavigation, setupOperationsFile } from "./subsystem-links.js";
import { computeSubsystemPlan, type SubsystemPlan } from "./subsystems.js";
import { SETUP_NEXT_COMMAND, countSetupUnits, syncSetupNotice, unfinishedSetupLine } from "./unfinished.js";
import { ensureNextGraph } from "./next-graph.js";

/** Task files `mex setup next` hands out, ignored by Git with the rest of `.mex/local/`. */
export const SETUP_NEXT_DIRECTORY = ".mex/local/setup-next";
const LOCK_FILE = ".mex/local/setup-next.lock";
const BRIEF_FILE = ".mex/local/setup-next/brief.json";
/** A lock older than this is from a call that can no longer be running. */
const LOCK_STALE_MS = 6 * 60 * 60_000;
/** The same instructions are printed again this many times before a unit without a batch is skipped. */
const MISSING_BATCH_LIMIT = 3;

export interface SetupNextOptions {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  /** Re-dispatch an abandoned task, using its printed task id. */
  readonly retry?: string;
  /** A new chat owns the queue; no task from the previous chat is still running. */
  readonly start?: boolean;
  /** Progress lines while MEX works (preparing, applying, finalizing); the result carries the instructions. */
  readonly onProgress?: (line: string) => void;
  /** Optional phase measurements; observation never changes setup output. */
  readonly onTiming?: (phase: string, durationMs: number) => void;
  /** Test seams. */
  readonly applier?: () => SetupBatchApplier;
  readonly refreshGraph?: () => Promise<void>;
  readonly now?: () => number;
}

export interface SetupNextResult {
  /** `task`: a unit was handed out; `complete`: setup finished; `blocked`: nothing can proceed until the printed problem is fixed. */
  readonly status: "task" | "complete" | "blocked";
  /** What to print, ending with the exact next command. */
  readonly output: string;
  readonly exitCode: number;
  readonly progress: { readonly done: number; readonly total: number } | null;
  /** The task file handed out, relative to the project root. */
  readonly taskFile?: string;
  readonly taskFiles?: readonly string[];
}

type AwaitingTask = NonNullable<NonNullable<SetupPlanState["queue"]>["awaiting"]>[number];

interface Unit {
  readonly id: QueueUnitId;
  readonly kind: "shared" | "subsystem" | "single";
  readonly label: string;
  readonly progress: { state: string; reason?: string; facts?: number; applied?: boolean; runs: unknown[] };
  readonly batchFile?: string;
  readonly scope?: BatchScope;
  readonly subsystem?: SubsystemUnit;
}

function opIdPrefix(slug: string): string {
  return `setup_${slug.replace(/-/gu, "_")}_`;
}

function folder(path: string, remainder?: boolean): string {
  return `${path}/${remainder ? " (own files)" : ""}`;
}

/** Run one step of the one-paste setup. Never throws for an expected problem: the output says what to do. */
export async function runSetupNext(options: SetupNextOptions): Promise<SetupNextResult> {
  const root = resolve(options.projectRoot);
  const mexDir = resolve(root, ".mex");
  const progress = (line: string) => { try { options.onProgress?.(line); } catch { /* observation only */ } };
  let mode: SetupMode;
  try { mode = resolveSetupMode(mexDir); }
  catch (error) { return blocked(error instanceof SetupError ? error.userMessage : String(error)); }
  if (mode === "code-repo" && !existsSync(resolve(root, ".git"))) {
    return blocked("No Git repository found. Run `git init` first, then run `mex setup next` again.");
  }
  // A completed older scaffold needs no queue or setup writes (#284).
  if (existsSync(resolve(mexDir, "ROUTER.md")) && describeUnfinishedSetup(root) === null && !options.retry) {
    const { assessSetupHealth, describeSetupHealth } = await import("./health.js");
    const health = await assessSetupHealth(root);
    if (health.healthy) return { status: "complete", exitCode: 0, progress: null, output: describeSetupHealth(health) };
  }
  try {
    return await withSetupLock(mexDir, () => runSetupNextLocked(options, root, mexDir, mode, progress));
  } catch (error) {
    return blocked(error instanceof SetupError ? error.userMessage : error instanceof Error ? error.message : String(error));
  }
}

async function runSetupNextLocked(
  options: SetupNextOptions, root: string, mexDir: string, mode: SetupMode, progress: (line: string) => void,
): Promise<SetupNextResult> {
  cleanupStaleSetupPrompts(root);
  mkdirSync(resolve(root, ".mex", "local"), { recursive: true });
  const release = acquireLock(root, options.now ?? Date.now);
  if (release === null) {
    return blocked(`Another \`${SETUP_NEXT_COMMAND}\` is running in this project. Wait for it to finish, then run \`${SETUP_NEXT_COMMAND}\` again.`);
  }
  try {
    return await step(root, mexDir, mode, options, progress);
  } catch (error) {
    const message = error instanceof SetupError ? error.userMessage : error instanceof Error ? error.message : String(error);
    return blocked(`${message} Fix the problem, then run \`${SETUP_NEXT_COMMAND}\` again; finished work is kept.`);
  } finally {
    release();
  }
}

async function step(
  root: string, mexDir: string, savedMode: SetupMode, options: SetupNextOptions, progress: (line: string) => void,
): Promise<SetupNextResult> {
  const notes: string[] = [];
  const loaded = loadPlanState(root);
  if (loaded.notice) notes.push(`Warning: ${loaded.notice}`);
  let state = loaded.state;
  let mode = savedMode;
  if (state?.queue?.finalized === true && isScaffoldPopulated(mexDir) && populationPlaceholderFiles(mexDir).length === 0) {
    const warning = await populationWarning(root, mexDir, mode);
    syncSetupNotice(root, null);
    return {
      status: "complete", exitCode: 0, progress: countSetupUnits(state),
      output: "MEX setup is already complete. There is nothing left to do." + (warning ? `\n${warning}` : ""),
    };
  }
  // Older authored scaffolds need finalization only. Do not invent another
  // population plan (or replace a completed one) for harmless leftover tokens.
  if (loaded.notice === undefined && isScaffoldPopulated(mexDir)
    && (state === null || state.finalizedAt !== undefined || state.queue?.finalized === true
      || (state.queue?.mode === "single" && isUnstartedSetupPlan(root, state))
      || (populationPlaceholderFiles(mexDir).length > 0 && isUnstartedSetupPlan(root, state)))) {
    const result = await runHeadlessSetup({
      projectRoot: root, mode, tools: loadConfiguredAiTools(mexDir),
      confirmPopulation: true, signal: options.signal, onMessage: progress,
    });
    return {
      status: result.ready ? "complete" : "blocked", exitCode: result.ready ? 0 : 1,
      progress: state === null ? null : countSetupUnits(state), output: result.message,
    };
  }
  if (state !== null && state.queue === undefined) {
    // Background sessions stopped part-way: this flow continues the same plan.
    state.queue = { mode: "units" };
  }
  if (state === null) {
    // A stored plan that could not be used was set aside: plan again, even over filled shared files.
    const started = await startQueue(root, mexDir, options, progress, loaded.notice !== undefined);
    state = started.state;
    mode = started.mode;
  }
  const queue = state.queue!;
  const save = () => {
    savePlanState(root, state!, new Date((options.now ?? Date.now)()));
    try {
      mkdirSync(dirname(resolve(root, SETUP_PLAN_VIEW_FILE)), { recursive: true });
      writeFileSync(resolve(root, SETUP_PLAN_VIEW_FILE), renderPlanProgress(state!), "utf8");
    } catch { /* the JSON state is the record */ }
  };
  if (queue.finalized === true) {
    syncSetupNotice(root, null);
    return { status: "complete", exitCode: 0, progress: countSetupUnits(state), output: "MEX setup is already complete. There is nothing left to do." };
  }

  const graph = mode === "code-repo" ? await ensureNextGraph(root, options.start === true) : null;
  if (graph?.status === "failed") {
    return blocked(`${graph.message ?? "The background code graph build failed."}\n${graph.diagnostic ?? ""}\nRun \`mex setup next --start\` to retry the graph build; finished tasks are kept.`, countSetupUnits(state));
  }
  const graphReady = graph === null || graph.status === "ready";
  if (graph?.status === "running" && graph.message) notes.push(graph.message);
  if (!graphReady) notes.push(`The code graph is still building (${graph.total > 0 ? `${graph.completed} of ${graph.total} files` : "discovering files"}). Finished tasks wait for it; run \`${SETUP_NEXT_COMMAND}\` again to continue.`);

  if (queue.mode === "units") {
    // Old queues may already have handed out the former final agent task.
    queue.awaiting = queue.awaiting?.filter((entry) => entry.unit !== "final");
    removeTaskFile(root, "final");
    const sharedBatch = resolve(root, unitBatchFile(SHARED_UNIT_SLUG));
    let legacyPatterns = false;
    if (state.navigationVersion !== 1 && state.shared.state === "done" && state.final.state !== "done" && existsSync(sharedBatch)) {
      try { legacyPatterns = !readSetupBatch(sharedBatch).extended; }
      catch { /* reconciliation reports malformed data without replaying applied facts */ }
    }
    if (legacyPatterns) {
      // Keep applied facts, and ask only for the missing pattern metadata.
      const prompt = buildSetupUnitPrompt(root, state, readBrief(root).brief, undefined, true);
      renameSync(sharedBatch, sharedBatch.replace(/\.json$/u, `.applied-${(options.now ?? Date.now)()}.json`));
      state.shared.state = "pending";
      state.shared.applied = false;
      queue.awaiting = [{ unit: "shared", kind: "write", repeats: 0 }];
      const dispatched = dispatchPrompt(root, queue.awaiting[0]!, prompt);
      save();
      return handOut(root, state, listUnits(state)[0]!, "write", dispatched, notes);
    }
    if (state.shared.state !== "done" && !state.shared.applied) state.navigationVersion = 1;
  }

  const units = listUnits(state);
  let applier: SetupBatchApplier | null = null;
  const apply = async (unit: Unit): Promise<BatchApplyOutcome> => {
    applier ??= (options.applier ?? (() => createSetupBatchApplier(root)))();
    progress(`Applying the batch for ${unit.label}…`);
    let outcome = await applyOnce(root, applier, unit, options);
    if (outcome.kind === "refused" && outcome.problems.some(isGraphProblem)) {
      // The code changed since the graph was built (hours can pass between calls): refresh it once and retry.
      progress("The code graph is out of date; refreshing it…");
      await (options.refreshGraph ?? (() => buildSetupGraph(root, { signal: options.signal })))();
      await applier.close().catch(() => undefined);
      applier = (options.applier ?? (() => createSetupBatchApplier(root)))();
      outcome = await applyOnce(root, applier, unit, options);
    }
    return outcome;
  };

  try {
    // Apply ready batches in plan order, irrespective of completion order.
    const previous = queue.awaiting ?? [];
    queue.awaiting = previous.filter((entry) => units.some((unit) => unit.id === entry.unit
      && unit.progress.state !== "done" && unit.progress.state !== "skipped"));
    const tasks: { unit: Unit; kind: "write" | "fix"; prompt: string; note?: string }[] = [];
    const limit = queue.mode === "single" ? 1 : resolveParallelRuns(undefined, options.env);
    if (options.retry !== undefined && !queue.awaiting.some((entry) => entry.unit === options.retry)) {
      return blocked(`Task ${options.retry} is not running. Run \`${SETUP_NEXT_COMMAND}\` to see the current tasks.`, countSetupUnits(state));
    }
    for (const unit of units) {
      if (unit.progress.state === "done" || unit.progress.state === "skipped") continue;
      const handed = previous.find((entry) => entry.unit === unit.id);
      const leftover = !handed && unit.batchFile !== undefined && existsSync(resolve(root, unit.batchFile));
      if (handed || leftover) {
        const entry: AwaitingTask = handed ?? { unit: unit.id, kind: "write", repeats: 0 };
        const ready = leftover || options.start === true
          || (entry.completionToken !== undefined && readReceipt(root, unit.id) === entry.completionToken);
        const retry = options.retry === unit.id && !ready;
        if (!ready && !retry) continue;
        if (!graphReady && ready && (unit.kind === "single" ? isScaffoldPopulated(mexDir)
          : unit.batchFile !== undefined && existsSync(resolve(root, unit.batchFile)))) {
          // --start accepts earlier completed batches without receipts. Retain that
          // decision across calls while the graph finishes, without re-dispatching.
          entry.completionToken ??= randomUUID();
          writeText(resolve(root, receiptFile(unit.id)), entry.completionToken);
          if (!queue.awaiting.some((candidate) => candidate.unit === unit.id)) queue.awaiting.push(entry);
          continue;
        }
        let settled: Settled;
        if (retry) {
          entry.repeats += 1;
          if (entry.repeats >= MISSING_BATCH_LIMIT) {
            unit.progress.state = "skipped";
            unit.progress.reason = `no completion signal after ${MISSING_BATCH_LIMIT} retries`;
            removeTaskFile(root, unit.id);
            notes.push(`Warning: Skipped ${unit.label}: ${unit.progress.reason}. The rest continues.`);
            settled = null;
          } else {
            settled = { kind: entry.kind, prompt: readTaskFile(root, unit.id) ?? "", note: `Retrying ${unit.id}. Stop its previous subagent before starting this task again.` };
          }
        } else {
          settled = await settle(root, mexDir, state, unit, entry, apply, notes, options.start === true);
          if ((leftover || options.start) && unit.progress.state === "done"
            && unit.batchFile !== undefined && existsSync(resolve(root, unit.batchFile))) {
            const facts = unit.progress.facts ?? 0;
            notes[notes.length - 1] = `Applied the batch an earlier run left for ${unit.label}: ${facts} fact${facts === 1 ? "" : "s"}.`;
          }
        }
        queue.awaiting = queue.awaiting.filter((candidate) => candidate.unit !== unit.id);
        if (settled !== null) {
          queue.awaiting.push(entry);
          // Persist a fix before the next apply can fail or the process can stop.
          if (settled.prompt !== "") settled.prompt = dispatchPrompt(root, entry, settled.prompt);
          tasks.push({ unit, ...settled });
        }
        save();
      }
    }
    // Outstanding fixes/repeats keep their slots; fill the rest with new work.
    for (const unit of units) {
      const occupied = queue.awaiting.filter((entry) => entry.completionToken === undefined
        || readReceipt(root, entry.unit) !== entry.completionToken).length;
      if (occupied >= limit) break;
      if (unit.progress.state === "done" || unit.progress.state === "skipped"
        || queue.awaiting.some((entry) => entry.unit === unit.id)) continue;
      queue.awaiting.push({ unit: unit.id, kind: "write", repeats: 0 });
      unit.progress.state = "running";
      tasks.push({ unit, kind: "write", prompt: await writePrompt(root, state, unit, mode, options) });
    }
    queue.awaiting.sort((a, b) => units.findIndex((unit) => unit.id === a.unit) - units.findIndex((unit) => unit.id === b.unit));
    if (tasks.length > 0) {
      for (const task of tasks) {
        if (task.prompt === "" && task.kind !== "fix") task.prompt = await writePrompt(root, state, task.unit, mode, options);
        const entry = queue.awaiting.find((entry) => entry.unit === task.unit.id)!;
        if (entry.completionToken === undefined || readTaskFile(root, task.unit.id) !== task.prompt) {
          task.prompt = dispatchPrompt(root, entry, task.prompt);
        }
      }
      save();
      if (tasks.length === 1) {
        const task = tasks[0]!;
        return handOut(root, state, task.unit, task.kind, task.prompt, notes, task.note);
      }
      const counts = countSetupUnits(state);
      const files = tasks.map((task) => taskFile(task.unit.id));
      return {
        status: "task", exitCode: 0, progress: counts, taskFile: files[0], taskFiles: files,
        output: [
          `MEX setup ${counts.done}/${counts.total}: ${tasks.length} tasks`, ...notes,
          ...tasks.flatMap((task, index) => [
            ...(task.note ? [task.note] : []),
            `- ${task.kind === "fix" ? "Fix" : "Read and follow"} ${files[index]}`,
          ]),
          "Start each task in its own subagent, in a fresh context.",
          `As soon as any one finishes, run \`${SETUP_NEXT_COMMAND}\` again without waiting for the others. Repeat until setup is complete.`,
          `Without subagents, finish these tasks one by one, then run \`${SETUP_NEXT_COMMAND}\`.`,
        ].join("\n"),
      };
    }

    if (queue.awaiting.length > 0) {
      save();
      const waiting = !graphReady ? queue.awaiting.filter((entry) => entry.completionToken !== undefined
        && readReceipt(root, entry.unit) === entry.completionToken) : [];
      const running = queue.awaiting.filter((entry) => !waiting.includes(entry));
      return {
        status: "task", exitCode: 0, progress: countSetupUnits(state),
        output: [...notes,
          ...(running.length ? ["Running tasks:", ...running.map((entry) => `- ${entry.unit}`),
            `Wait for one to finish, then run \`${SETUP_NEXT_COMMAND}\` again.`] : []),
          ...(waiting.length ? ["Finished tasks waiting for the code graph:", ...waiting.map((entry) => `- ${entry.unit}`),
            `Wait for the code graph, then run \`${SETUP_NEXT_COMMAND}\` again.`] : []),
          `In a new chat, run \`${SETUP_NEXT_COMMAND} --start\` to recover earlier work.`,
          `If a subagent stopped without finishing, stop it and run \`${SETUP_NEXT_COMMAND} --retry <task>\` with a task id above.`].join("\n"),
      };
    }

    if (!graphReady) {
      save();
      return { status: "task", exitCode: 0, progress: countSetupUnits(state), output: notes.join("\n") };
    }

    if (queue.mode === "units" && state.final.state !== "done") {
      if (!isScaffoldPopulated(mexDir)) {
        state.final.state = "skipped";
        state.final.reason = "the shared files are not filled yet";
      } else {
        const navigationStarted = performance.now();
        try { reconcileSetupNavigation(root, state); }
        catch (error) {
          state.final.state = "pending";
          save();
          return blocked(`MEX could not finish setup links and indexes (${error instanceof Error ? error.message : String(error)}). Check .mex/local/setup-ops/*.json and the .mex/ scaffold; fix the reported batch data or scaffold file and rerun \`${SETUP_NEXT_COMMAND}\`; completed work is kept.`, countSetupUnits(state));
        }
        timing(options, "navigation", navigationStarted);
        state.final.state = "done";
        delete state.final.reason;
        notes.push("Wrote setup patterns, routing rows and edges.");
      }
    }

    // 3. Everything is settled: finalize.
    save();
    const finalizeStarted = performance.now();
    try { return await finish(root, mexDir, mode, state, queue, notes, progress, save, options); }
    finally { timing(options, "finalize", finalizeStarted); }
  } finally {
    if (applier !== null) await (applier as SetupBatchApplier).close().catch(() => undefined);
    if (state.queue?.finalized !== true) {
      syncSetupNotice(root, countSetupUnits(state));
      // A half-finished setup leaves a valid, readable Wiki (never `migration_required`); agent memory has none.
      const wikiStarted = performance.now();
      const warning = mode === "code-repo" ? await ensureWikiIndexUsable(root) : null;
      timing(options, "wiki index", wikiStarted);
      if (warning !== null) progress(`Warning: ${warning}`);
    }
  }
}

/** Prepare the scaffold, identity and scan once, then store this flow's plan. */
async function startQueue(
  root: string, mexDir: string, options: SetupNextOptions, progress: (line: string) => void, replacing: boolean,
): Promise<{ state: SetupPlanState; mode: SetupMode }> {
  progress("Preparing setup (scaffold and project scan); the code graph will build in the background…");
  const prepared = await runHeadlessSetup({
    projectRoot: root,
    tools: existsSync(resolve(mexDir, "config.json")) ? loadConfiguredAiTools(mexDir) : [],
    confirmPopulation: true,
    stopBeforePopulation: true,
    deferPreparationGraph: true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onProgress: (update) => {
      progress(`${update.label}${update.detail ? ` — ${update.detail}` : ""}`);
    },
    onMessage: progress,
  });
  const state = createQueueState(root, {
    mode: prepared.mode,
    projectState: prepared.preparation?.state ?? "existing",
    scannerBrief: prepared.preparation?.scannerBrief ?? null,
    ...(options.env === undefined ? {} : { env: options.env }),
    replacing,
  });
  return { state, mode: prepared.mode };
}

interface QueueStart {
  readonly mode: SetupMode;
  readonly projectState: ProjectState;
  readonly scannerBrief: string | null;
  readonly env?: NodeJS.ProcessEnv;
  /** An earlier plan was set aside: batches on disk replay, so plan subsystems even over filled shared files. */
  readonly replacing?: boolean;
}

/** Store a new plan for this flow: per-subsystem units for larger code repositories, else one unit. */
function createQueueState(root: string, start: QueueStart): SetupPlanState {
  const mexDir = resolve(root, ".mex");
  writeText(resolve(root, BRIEF_FILE), JSON.stringify({ state: start.projectState, brief: start.scannerBrief }));
  const populated = isScaffoldPopulated(mexDir);
  let state: SetupPlanState | null = null;
  if (start.mode === "code-repo" && start.projectState !== "fresh" && (!populated || start.replacing === true)) {
    const plan = computePlan(root);
    if (plan !== null && shouldRunPerSubsystem({ plan, resuming: false, ...(start.env === undefined ? {} : { env: start.env }) })) {
      state = createPlanState(plan);
      state.queue = { mode: "units" };
    }
  }
  if (state === null) {
    // Small or fresh repositories and agent memory: the whole population is one unit.
    state = createPlanState(EMPTY_PLAN);
    state.queue = { mode: "single" };
    state.final.state = "done";
    if (populated) state.shared.state = "done";
  }
  savePlanState(root, state);
  return state;
}

/**
 * When `mex setup` pauses with no agent to run, record the plan for `mex setup
 * next` (unless one is stored already) and put the managed block in place.
 * Returns the status line.
 */
export async function prepareSetupQueue(projectRoot: string, start: QueueStart): Promise<{ line: string; done: number; total: number }> {
  const root = resolve(projectRoot);
  let state = loadPlanState(root).state;
  if (state !== null && state.queue === undefined) {
    // Background sessions stopped part-way: `mex setup next` continues the same plan.
    state.queue = { mode: "units" };
    savePlanState(root, state);
  }
  if (state === null || state.queue?.finalized === true) state = createQueueState(root, start);
  const counts = countSetupUnits(state);
  syncSetupNotice(root, counts);
  if (start.mode === "code-repo") await ensureWikiIndexUsable(root);
  return { ...counts, line: unfinishedSetupLine(counts.done, counts.total, "queue") };
}

/** A plan with no subsystems, for the single-unit form (the real plan is computed when the prompt is written). */
const EMPTY_PLAN: SubsystemPlan = { source: "tree", ranking: "size", sourceFiles: 0, target: { min: 0, max: 0 }, candidates: [] };

function listUnits(state: SetupPlanState): Unit[] {
  if (state.queue?.mode === "single") {
    return [{ id: "single", kind: "single", label: "the scaffold population", progress: state.shared }];
  }
  return [
    {
      id: "shared", kind: "shared", label: "the shared files", progress: state.shared,
      batchFile: unitBatchFile(SHARED_UNIT_SLUG), scope: { opIdPrefix: opIdPrefix(SHARED_UNIT_SLUG), files: [...SHARED_CONTEXT_FILES] },
    },
    ...state.subsystems.map((unit): Unit => ({
      id: `subsystem:${unit.slug}`, kind: "subsystem", label: `subsystem ${folder(unit.path, unit.remainder)}`, progress: unit, subsystem: unit,
      batchFile: unitBatchFile(unit.slug), scope: { opIdPrefix: opIdPrefix(unit.slug), files: [subsystemWikiFile(unit.slug)] },
    })),
  ];
}

async function applyOnce(root: string, applier: SetupBatchApplier, unit: Unit, options: SetupNextOptions): Promise<BatchApplyOutcome> {
  try {
    const split = performance.now();
    const file = setupOperationsFile(root, unit.batchFile!);
    timing(options, "batch split", split);
    const started = performance.now();
    try { return await applier.apply(file, unit.scope!); }
    finally { timing(options, "apply", started); }
  } catch (error) {
    return { kind: "refused", problems: [{ code: "SETUP_APPLY_FAILED", message: error instanceof Error ? error.message : String(error) }] };
  }
}

/** Refusals that come from the code graph, not from the batch. */
function isGraphProblem(problem: BatchProblem): boolean {
  return /^(?:GRAPH_|CODE_GRAPH_)/u.test(problem.code) || problem.code === "GROUNDING_STALE"
    || (problem.code === "SETUP_APPLY_FAILED" && /\bgraph\b/iu.test(problem.message));
}

type Settled = { kind: "write" | "fix"; prompt: string; note?: string } | null;

/**
 * Settle the unit handed out last. Returns the instructions to hand out again
 * (a fix task, or the same task when nothing arrived), or `null` when the unit
 * is settled (done or skipped) and the next one can go out.
 */
async function settle(
  root: string, mexDir: string, state: SetupPlanState, unit: Unit,
  awaiting: NonNullable<NonNullable<SetupPlanState["queue"]>["awaiting"]>[number],
  apply: (unit: Unit) => Promise<BatchApplyOutcome>, notes: string[], startingChat = false,
): Promise<Settled> {
  const done = (facts?: number, note?: string) => {
    unit.progress.state = "done";
    delete unit.progress.reason;
    if (facts !== undefined) unit.progress.facts = unit.kind === "shared" ? Math.max(unit.progress.facts ?? 0, facts) : facts;
    if (unit.kind === "shared") state.navigationVersion = 1;
    if (unit.kind !== "single" && state.final.state === "done") state.final.state = "pending";
    if (unit.batchFile !== undefined) unit.progress.applied = true;
    removeTaskFile(root, unit.id);
    if (note) notes.push(note);
  };
  const skip = (reason: string) => {
    unit.progress.state = "skipped";
    unit.progress.reason = reason;
    removeTaskFile(root, unit.id);
    notes.push(`Warning: Skipped ${unit.label}: ${reason}. The rest continues.`);
  };
  const again = (note: string): Settled => {
    awaiting.repeats += 1;
    return { kind: awaiting.kind, prompt: readTaskFile(root, unit.id) ?? "", note };
  };

  if (unit.kind === "single") {
    if (isScaffoldPopulated(mexDir)) {
      done(undefined, "The scaffold is populated.");
      return null;
    }
    return again(`Required project knowledge is missing in ${placeholderFiles(mexDir).join(", ") || "the scaffold"}. Complete only those files; preserve completed knowledge. The task is not finished yet.`);
  }

  const batchPath = resolve(root, unit.batchFile!);
  const outcome = await apply(unit);
  if (outcome.kind === "applied") {
    if (unit.kind === "shared" && !isScaffoldPopulated(mexDir)) {
      unit.progress.applied = true;
      return again(`The shared facts are applied, but required placeholders remain in ${placeholderFiles(mexDir).join(", ")}. Fill them as the task describes.`);
    }
    done(outcome.facts, `Applied ${unit.label}: ${outcome.facts} fact${outcome.facts === 1 ? "" : "s"}${outcome.replayed ? " (already applied earlier)" : ""}.`);
    return null;
  }
  if (outcome.kind === "missing") {
    if (unit.kind === "shared" && !startingChat && isScaffoldPopulated(mexDir)) {
      done(0, "The shared files are filled (no facts batch was written).");
      return null;
    }
    if (awaiting.repeats + 1 >= MISSING_BATCH_LIMIT) {
      skip(`no batch file was written at ${unit.batchFile} after ${MISSING_BATCH_LIMIT} tries`);
      return null;
    }
    return again(`MEX found no batch file at ${unit.batchFile}. The task is not finished yet.`);
  }
  // Refused: one fix task with the refusal and candidates; a second refusal skips the unit.
  const hash = fileHash(batchPath);
  if (awaiting.kind === "fix") {
    if (hash === awaiting.batchHash && awaiting.repeats < 1) {
      return again("The batch file has not changed since the fix task was handed out. Do the fix task below.");
    }
    const first = outcome.problems[0];
    skip(`its batch was refused twice (${first?.code ?? "refused"}: ${(first?.message ?? "").slice(0, 200)})`);
    return null;
  }
  const prompt = batchFixPrompt(unit, outcome.problems);
  Object.assign(awaiting, { kind: "fix", repeats: 0, ...(hash === null ? {} : { batchHash: hash }) });
  return { kind: "fix", prompt, note: `MEX could not apply the batch for ${unit.label}; nothing from it was written. Fix it as the task below says.` };
}

function batchFixPrompt(unit: Unit, diagnostics: readonly BatchProblem[]): string {
  return buildBatchFixPrompt({
    label: unit.label, batchFile: unit.batchFile!, wikiFiles: unit.scope!.files,
    opIdPrefix: unit.scope!.opIdPrefix, diagnostics,
  });
}

async function writePrompt(root: string, state: SetupPlanState, unit: Unit, mode: SetupMode, options: SetupNextOptions): Promise<string> {
  const started = performance.now();
  try {
    const brief = readBrief(root);
    switch (unit.kind) {
      case "single": {
        const prompt = await buildSetupPopulationPrompt(mode, brief.state, brief.brief, root);
        // The agent was not launched by setup: `mex setup next` checks and finalizes, not `mex setup`.
        return `Continue only the missing project knowledge in ${placeholderFiles(resolve(root, ".mex")).join(", ")}. Preserve completed files and facts; do not restart population.\n\n`
          + prompt.replace(POPULATION_FINISH, QUEUE_POPULATION_FINISH);
      }
      case "shared":
        return buildSetupUnitPrompt(root, state, brief.brief);
      case "subsystem":
        return buildSetupUnitPrompt(root, state, brief.brief, unit.subsystem!);
    }
  } finally { timing(options, "prompt build", started); }
}

/** The single population prompt's closing paragraph in this flow. */
export const QUEUE_POPULATION_FINISH = `Finish: Do not commit .mex/ until setup has finalized Graph and Wiki.
When you are done, stop. \`mex setup next\` then checks the result and finalizes Graph and Wiki.`;

/** Write the task file and the short instructions that point at it. */
function handOut(
  root: string, state: SetupPlanState, unit: Unit, kind: "write" | "fix", prompt: string, notes: string[], note?: string,
): SetupNextResult {
  const relative = taskFile(unit.id);
  if (prompt !== "" && readTaskFile(root, unit.id) !== prompt) writeText(resolve(root, relative), prompt);
  const counts = countSetupUnits(state);
  const lines = [
    `MEX setup ${counts.done}/${counts.total}: ${kind === "fix" ? `fix the batch for ${unit.label}` : unit.label}`,
    ...notes,
    ...(note ? [note] : []),
    "",
    `Next task: its instructions are in ${relative}.`,
    `- Start this task in its own subagent, in a fresh context: "Read ${relative} and follow it exactly."`,
    "- Otherwise, read that file and follow it yourself, here.",
    `As soon as any task finishes, run \`${SETUP_NEXT_COMMAND}\` again without waiting for the others. Repeat until setup is complete.`,
  ];
  return { status: "task", exitCode: 0, progress: counts, taskFile: relative, output: lines.join("\n") };
}

async function finish(
  root: string, mexDir: string, mode: SetupMode, state: SetupPlanState, queue: NonNullable<SetupPlanState["queue"]>,
  notes: string[], progress: (line: string) => void, save: () => void, options: SetupNextOptions,
): Promise<SetupNextResult> {
  const counts = countSetupUnits(state);
  if (!isScaffoldPopulated(mexDir)) {
    // Only reachable when the shared unit was skipped: hand it out again rather than finalize a template scaffold.
    state.shared.state = "pending";
    delete state.shared.reason;
    save();
    return blocked([...notes, "The shared scaffold files still have required placeholders, so setup cannot finalize yet. "
      + `Run \`${SETUP_NEXT_COMMAND}\` to get that task again.`].join("\n"), counts);
  }
  notes.push(...fillPopulationPlaceholders(root, mexDir, progress));
  let groundingNotice = "";
  if (mode === "code-repo") {
    progress("Finalizing: capturing grounding baselines and indexing the Wiki…");
    const { finalizeCodeRepoSetup } = await import("./index.js");
    const messages: string[] = [];
    try {
      const outcome = await finalizeCodeRepoSetup(root, mexDir, {
        selectedTools: [],
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onMessage: (message) => { messages.push(message); progress(message); },
      });
      groundingNotice = [
        outcome.dropped.length > 0
          ? `Dropped ${outcome.dropped.length} unverifiable reference${outcome.dropped.length === 1 ? "" : "s"}.`
          : "",
        describeGroundingDrift(outcome.drift),
      ].filter(Boolean).join(" ");
    } catch (error) {
      if (!(error instanceof SetupFinalizationError)) throw error;
      const { buildSetupRepairPrompt } = await import("./finalize-repair.js");
      const prompt = buildSetupRepairPrompt(error.groundingFailures ?? [], error.wikiDiagnostics ?? []);
      writeText(resolve(root, taskFile("finalize")), prompt);
      queue.awaiting = [{ unit: "finalize", kind: "fix", repeats: 0 }];
      save();
      return {
        status: "task", exitCode: 0, progress: counts, taskFile: taskFile("finalize"),
        output: [
          `MEX setup ${counts.done}/${counts.total}: finalize found problems`,
          ...notes,
          error.userMessage,
          "",
          `Next task: its instructions are in ${taskFile("finalize")}.`,
          "- Read that file and follow it yourself, here (it names `mex` commands to run).",
          `When the task is done, run \`${SETUP_NEXT_COMMAND}\` to finalize again.`,
        ].join("\n"),
      };
    }
  }
  const auditNotice = await populationWarning(root, mexDir, mode);
  if (auditNotice !== null) notes.push(auditNotice);
  queue.finalized = true;
  state.finalizedAt = new Date((options.now ?? Date.now)()).toISOString();
  delete queue.awaiting;
  removeTaskFile(root, "finalize");
  save();
  syncSetupNotice(root, null);
  const skipped = state.subsystems.filter((unit) => unit.state === "skipped");
  const covered = state.subsystems.filter((unit) => unit.state === "done");
  const facts = (state.shared.facts ?? 0) + covered.reduce((sum, unit) => sum + (unit.facts ?? 0), 0);
  const coverage = queue.mode === "units"
    ? `Subsystems covered: ${covered.length} of ${state.subsystems.length}, ${facts} facts written.`
      + (skipped.length === 0 ? "" : ` Skipped: ${skipped.map((unit) => `${unit.path}/ (${unit.reason ?? "skipped"})`).join("; ")}.`)
    : "";
  const tools = existsSync(resolve(mexDir, "config.json")) ? loadConfiguredAiTools(mexDir) : [];
  const commit = mode === "code-repo" ? setupCommitCheckpointCommands(tools) : [];
  return {
    status: "complete",
    exitCode: 0,
    progress: countSetupUnits(state),
    output: [
      ...notes,
      `MEX setup is complete.${coverage ? ` ${coverage}` : ""}${groundingNotice ? ` ${groundingNotice}` : ""}`,
      ...(mode === "code-repo"
        ? ["Graph and Wiki are ready. Ask the user to review and commit the MEX files:", ...commit.map((command) => `  ${command}`)]
        : ["Agent memory is ready."]),
      "There is nothing left to run; you can stop here.",
    ].join("\n"),
  };
}

function blocked(message: string, progress: { done: number; total: number } | null = null): SetupNextResult {
  return { status: "blocked", exitCode: 1, progress, output: message };
}

// ── Files ──

function taskFile(id: QueueUnitId): string {
  return `${SETUP_NEXT_DIRECTORY}/${id.replace(":", "-")}.md`;
}

function readTaskFile(root: string, id: QueueUnitId): string | null {
  try { return readFileSync(resolve(root, taskFile(id)), "utf8"); } catch { return null; }
}

function removeTaskFile(root: string, id: QueueUnitId): void {
  rmSync(resolve(root, taskFile(id)), { force: true });
  rmSync(resolve(root, receiptFile(id)), { force: true });
}

function receiptFile(id: QueueUnitId): string {
  return taskFile(id).replace(/\.md$/u, ".done");
}

function readReceipt(root: string, id: QueueUnitId): string | null {
  try {
    const path = resolve(root, receiptFile(id));
    if (statSync(path).size > 128) return null;
    return readFileSync(path, "utf8").trim();
  } catch { return null; }
}

/** A fresh token prevents an old or partially written receipt completing a retry. */
function dispatchPrompt(root: string, entry: AwaitingTask, prompt: string): string {
  entry.completionToken = randomUUID();
  rmSync(resolve(root, receiptFile(entry.unit)), { force: true });
  const body = prompt.split("\n<!-- setup-next-completion -->")[0]!;
  const result = `${body}\n<!-- setup-next-completion -->\nAs your very last step, after closing the completed batch and finishing all task edits, write exactly ${entry.completionToken} to ${receiptFile(entry.unit)}. Do not write this completion signal early. Then stop.\n`;
  writeText(resolve(root, taskFile(entry.unit)), result);
  return result;
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function readBrief(root: string): { state: ProjectState; brief: string | null } {
  try {
    const parsed = JSON.parse(readFileSync(resolve(root, BRIEF_FILE), "utf8")) as { state?: unknown; brief?: unknown };
    const state = parsed.state === "fresh" || parsed.state === "partial" ? parsed.state : "existing";
    return { state, brief: typeof parsed.brief === "string" ? parsed.brief : null };
  } catch {
    return { state: "existing", brief: null };
  }
}

function fileHash(path: string): string | null {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return null; }
}

/** The required scaffold files that still hold a template placeholder. */
function placeholderFiles(mexDir: string): string[] {
  return unpopulatedScaffoldFiles(mexDir).map(file => `.mex/${file}`);
}

/** One `mex setup next` at a time per project; a lock from a dead or very old call is taken over. */
function acquireLock(root: string, now: () => number): (() => void) | null {
  const path = resolve(root, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, at: now() }), { encoding: "utf8", flag: "wx" });
      return () => { rmSync(path, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = true;
      try {
        const held = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; at?: unknown };
        const age = typeof held.at === "number" ? now() - held.at : Number.POSITIVE_INFINITY;
        stale = age > LOCK_STALE_MS || typeof held.pid !== "number" || !isAlive(held.pid);
      } catch {
        stale = (() => { try { return now() - statSync(path).mtimeMs > 60_000; } catch { return true; } })();
      }
      if (!stale) return null;
      rmSync(path, { force: true });
    }
  }
  return null;
}

function isAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function computePlan(root: string): SubsystemPlan | null {
  // Background setup plans before Graph is ready; preserve its ordering and pattern cap choices.
  try { return computeSubsystemPlan(root, { useGraph: false }); } catch { return null; }
}

/**
 * Keep the Wiki usable while setup is unfinished. Without an index, a scaffold
 * whose files are not yet migrated reads as `migration_required` (#268), which
 * blocks Wiki reads and the Hub. Rebuilding the disposable index over the
 * current files makes it valid and fresh. Templates already have their Wiki
 * identities, and fact batches stamp new subsystem files; finalization adopts
 * only remaining legacy knowledge and repairs missing section links. Returns a
 * warning when the index could not be rebuilt.
 */
export async function ensureWikiIndexUsable(projectRoot: string): Promise<string | null> {
  const root = resolve(projectRoot);
  try {
    const { findConfig } = await import("../config.js");
    const { createWikiEngine } = await import("../wiki/service.js");
    const config = findConfig(root);
    const engine = createWikiEngine({
      scaffoldRoot: config.scaffoldRoot,
      ...(config.wiki?.exclude === undefined ? {} : { exclude: config.wiki.exclude }),
      ...(config.wiki?.readOnly === undefined ? {} : { readOnly: config.wiki.readOnly }),
    });
    const rebuilt = await engine.rebuildIndex();
    const error = rebuilt.diagnostics.find((entry) => entry.severity === "error");
    return error === undefined ? null : `The Wiki index could not be rebuilt (${error.code}); finalize rebuilds it.`;
  } catch (error) {
    return `The Wiki index could not be rebuilt (${error instanceof Error ? error.message : String(error)}); finalize rebuilds it.`;
  }
}

function timing(options: SetupNextOptions, phase: string, started: number): void {
  try { options.onTiming?.(phase, performance.now() - started); } catch { /* observation only */ }
}
