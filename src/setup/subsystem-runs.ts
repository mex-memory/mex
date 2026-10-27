/**
 * Per-subsystem population: one agent session per planned subsystem.
 *
 * On a larger code repository one long population session runs out of context
 * or stalls halfway, and an agent's judgment decides what is finished. Here MEX
 * drives the work from its stored plan instead:
 *
 * 1. one session fills the shared scaffold files, alongside the graph build;
 * 2. one fresh, small session per subsystem (up to three at once, as free memory
 *    allows) reads that subsystem's code with file tools, runs no `mex` command,
 *    writes one batch file and exits; MEX applies each batch in-process, one at a
 *    time, and marks the subsystem done;
 * 3. MEX reconciles patterns, routing rows and edges without another session.
 *
 * A refused batch gets one short fix session; if it is refused again, or a
 * session fails, that subsystem is skipped with a warning and the rest go on.
 * Failures that are not a subsystem's fault (cancel, sign-in, usage limit, a
 * missing or broken agent CLI) stop the phase with a message saying a rerun of
 * `mex setup` continues. Every step is recorded, so a rerun keeps what is done.
 */
import { execFileSync } from "node:child_process";
import { createScopedSourcePredicate } from "../graph/status.js";
import { isSupportedSourceFile } from "../graph/extraction/grammars.js";
import { freemem, totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { graphWorkerHeap } from "../graph/candidate-process.js";
import { existsSync, mkdirSync, opendirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AiTool } from "../types.js";
import type { BackgroundAgentTool } from "../agent-command.js";
import { isScaffoldPopulated } from "./index.js";
import {
  HeadlessPopulationError,
  launchHeadlessSetupPopulation,
  type HeadlessPopulationActivity,
  type HeadlessPopulationOptions,
  type HeadlessPopulationTranscript,
} from "./headless-population.js";
import { SetupPopulationError } from "./population.js";
import type { HeadlessPopulationLaunchResult } from "./headless-population.js";
import type { PopulationAgentUsage } from "./population-activity.js";
import {
  buildBatchFixPrompt,
  buildSharedFilesPrompt,
  buildSharedPatternsPrompt,
  buildSubsystemPrompt,
  SHARED_CONTEXT_FILES,
  type SubsystemPromptEntry,
} from "./prompts.js";
import { createSetupBatchApplier, type BatchApplyOutcome, type BatchProblem, type BatchScope, type SetupBatchApplier } from "./subsystem-apply.js";
import { ScopeGuard } from "./subsystem-scope.js";
import { readSetupBatch, reconcileSetupNavigation, setupOperationsFile } from "./subsystem-links.js";
import {
  SHARED_UNIT_SLUG,
  savePlanState,
  subsystemWikiFile,
  unitBatchFile,
  type SetupPlanState,
  type SubsystemUnit,
  type UnitRunRecord,
  type UnitState,
} from "./subsystem-state.js";
import type { SubsystemPlan } from "./subsystems.js";

/** Below this many indexed source files (the plan's size tier) one session is enough. */
export const PER_SUBSYSTEM_MIN_SOURCE_FILES = 300;
export const DEFAULT_PARALLEL_RUNS = 3;
export const MAX_PARALLEL_RUNS = 8;
/** Estimated memory one agent session uses at its peak (the CLI, its shells and search tools). */
export const AGENT_RUN_FOOTPRINT_BYTES = 1.5 * 1024 ** 3;
/** Never start a second or third session that would leave less free memory than this. */
export const FREE_MEMORY_FLOOR_BYTES = 2 * 1024 ** 3;
/** Every build still runs a separate worker with its own footprint. */
export const SMALL_GRAPH_BUILD_RESERVE_BYTES = 2.5 * 1024 ** 3;
/** Measured peaks grew roughly with indexed files (10.5 GB on a 9.4k-file monorepo with the automatic heap). */
const GRAPH_RESERVE_BYTES_PER_FILE = 1.2 * 1024 ** 2;
/** Native and compiler memory the worker uses outside its V8 heap. */
export const GRAPH_NATIVE_OVERHEAD_BYTES = 1024 ** 3;

/** The heap ceiling the graph worker will get on this machine. */
function graphWorkerHeapBytes(): number {
  return graphWorkerHeap({ totalBytes: totalmem(), freeBytes: freemem(),
    defaultHeapMb: Math.ceil(getHeapStatistics().heap_size_limit / 1024 ** 2),
    nodeOptions: process.env.NODE_OPTIONS, execArgv: process.execArgv }).heapMb * 1024 ** 2;
}

/**
 * Memory to hold back for the graph build before starting concurrent agents: scaled to the
 * repository, and never more than the worker's heap ceiling plus its native memory.
 */
export function graphBuildReserveBytes(sourceFiles: number, heapBytes = graphWorkerHeapBytes()): number {
  return Math.min(heapBytes + GRAPH_NATIVE_OVERHEAD_BYTES, Math.max(SMALL_GRAPH_BUILD_RESERVE_BYTES, sourceFiles * GRAPH_RESERVE_BYTES_PER_FILE));
}
/** A session younger than this may still be growing; its full footprint stays reserved. */
const RAMP_UP_MS = 60_000;
/** This many sessions failing in a row, with no success between, is not the subsystems' fault. */
const CONSECUTIVE_FAILURE_LIMIT = 3;

/** A readable copy of the stored plan's progress (not Markdown, so the Wiki never indexes it). */
export const SETUP_PLAN_VIEW_FILE = ".mex/local/setup-plan.txt";

/** Environment switches: the per-subsystem path, and the session limit. */
export const PER_SUBSYSTEM_ENV = "MEX_SETUP_PER_SUBSYSTEM";
export const PARALLEL_RUNS_ENV = "MEX_SETUP_PARALLEL_RUNS";

/**
 * `force` takes the per-subsystem path even below the size tier (used to test it
 * on a small repository); `off` keeps the single session; `auto` decides by size.
 */
export function perSubsystemSwitch(env: NodeJS.ProcessEnv = process.env): "force" | "off" | "auto" {
  const value = env[PER_SUBSYSTEM_ENV]?.trim().toLowerCase();
  if (value === "1" || value === "force" || value === "on" || value === "true") return "force";
  if (value === "0" || value === "off" || value === "false") return "off";
  return "auto";
}

/** The session limit: the option, else the environment, else 3; always 1 to 8. */
export function resolveParallelRuns(option?: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = option ?? (env[PARALLEL_RUNS_ENV] === undefined ? undefined : Number(env[PARALLEL_RUNS_ENV]));
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_PARALLEL_RUNS;
  return Math.max(1, Math.min(MAX_PARALLEL_RUNS, Math.floor(raw)));
}

/** Whether population takes the per-subsystem path. */
export function shouldRunPerSubsystem(input: {
  readonly plan: SubsystemPlan | null;
  readonly resuming: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): boolean {
  const mode = perSubsystemSwitch(input.env);
  if (mode === "off") return false;
  if (input.resuming) return true;
  if (input.plan === null || input.plan.candidates.length === 0) return false;
  return mode === "force" || input.plan.sourceFiles >= PER_SUBSYSTEM_MIN_SOURCE_FILES;
}

export interface SetupCoverageProgress {
  readonly shared?: UnitState;
  readonly waitingForGraph?: number;
  readonly phase: "shared" | "subsystems" | "final" | "complete";
  readonly finalState?: UnitState;
  readonly total: number;
  readonly done: number;
  readonly skipped: number;
  readonly subsystems: ReadonlyArray<{ readonly path: string; readonly state: UnitState }>;
}

export interface SubsystemPopulationOptions {
  readonly projectRoot: string;
  /** The stored or new plan state; updated and saved as work happens. */
  readonly state: SetupPlanState;
  readonly selectedTools: readonly AiTool[];
  /** The agent every session of this phase runs (MEX chose it once); otherwise each launch chooses. */
  readonly tool?: BackgroundAgentTool;
  readonly scannerBrief: string | null;
  /** Sessions may write immediately, but no apply or fix starts before this resolves. */
  readonly graphReady?: Promise<void>;
  readonly signal?: AbortSignal;
  readonly parallelRuns?: number;
  readonly onMessage?: (message: string) => void;
  readonly onCoverage?: (coverage: SetupCoverageProgress) => void;
  readonly onActivity?: (activity: HeadlessPopulationActivity) => void;
  readonly onTranscript?: (entry: HeadlessPopulationTranscript) => void;
  /** Test seams; production uses the headless agent launcher, `os.freemem` and the in-process applier. */
  readonly launch?: (input: HeadlessPopulationOptions) => Promise<HeadlessPopulationLaunchResult>;
  readonly applier?: SetupBatchApplier;
  readonly freeMemory?: () => number;
  readonly now?: () => number;
  /** Watch tracked source files for out-of-scope edits (default true). */
  readonly trackSource?: boolean;
}

export interface SubsystemPopulationOutcome {
  readonly tool: BackgroundAgentTool | null;
  /** The shared files are filled (no required placeholder remains). */
  readonly sharedDone: boolean;
  readonly covered: number;
  readonly total: number;
  readonly facts: number;
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  /** One sentence or two for the final setup message. */
  readonly summary: string;
}

/** Population stopped for a reason that is not one subsystem's fault; a rerun continues. */
export class SubsystemPhaseStoppedError extends SetupPopulationError {
  constructor(message: string, readonly category: string) {
    super(message);
    this.name = "SubsystemPhaseStoppedError";
  }
}

/** The agent launcher found no agent CLI it can run in the background. */
class MissingAgentError extends Error {}

const STOPPING_CATEGORIES: ReadonlySet<string> = new Set(["cancelled", "authentication", "usage_limit", "launch", "arguments", "prompt"]);

type UnitKind = "shared" | "subsystem";

interface WorkUnit {
  readonly kind: UnitKind;
  readonly label: string;
  readonly progress: { state: UnitState; reason?: string; facts?: number; applied?: boolean; runs: UnitRunRecord[] };
  readonly subsystem?: SubsystemUnit;
  readonly batchFile?: string;
  readonly scope?: BatchScope;
  readonly transcriptTag?: string;
  writePrompt(): string;
  allowed(path: string): boolean;
}

function opIdPrefix(slug: string): string {
  return `setup_${slug.replace(/-/gu, "_")}_`;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return `${stop > max / 2 ? cut.slice(0, stop + 1) : cut.trimEnd()}…`;
}

function folder(path: string, remainder?: boolean): string {
  return `${path}/${remainder ? " (own files)" : ""}`;
}

function shortReason(error: unknown): string {
  if (error instanceof HeadlessPopulationError) return `the session failed (${error.category.replace("_", " ")})`;
  return "the session failed";
}

function failureCategory(error: unknown): string {
  if (error instanceof HeadlessPopulationError) return error.category;
  if (error instanceof MissingAgentError) return "missing_tool";
  return "unexpected";
}

function stopsPhase(error: unknown): boolean {
  if (error instanceof HeadlessPopulationError) return STOPPING_CATEGORIES.has(error.category);
  // A missing CLI, or an error MEX did not expect, is never a subsystem's fault.
  return true;
}

/** A readable view of the stored plan, next to it in `.mex/local/`. */
export function renderPlanProgress(state: SetupPlanState): string {
  const line = (label: string, unit: { state: UnitState; reason?: string; facts?: number }) =>
    `- [${unit.state === "done" ? "x" : " "}] ${label} — ${unit.state}${unit.facts === undefined ? "" : `, ${unit.facts} facts`}${unit.reason ? ` (${unit.reason})` : ""}`;
  return [
    "# MEX setup progress",
    "",
    `Written by MEX from ${".mex/local/setup-plan.json"}; do not edit. ${state.queue === undefined ? "Rerun \`mex setup\`" : "Run \`mex setup next\`"} to continue.`,
    "",
    line("shared files", state.shared),
    ...state.subsystems.map((unit) => line(`${folder(unit.path, unit.remainder)} -> .mex/${subsystemWikiFile(unit.slug)}`, unit)),
    line("patterns, routing rows and edges", state.final),
    "",
  ].join("\n");
}

/** One bounded Git listing per plan, never a filesystem walk of ignored folders. */
export function discoverSkippedSourceFolders(projectRoot: string): string[] {
  try {
    const paths = execFileSync("git", ["ls-files", "-z", "--cached"], {
      cwd: projectRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\0").filter((path) => isSupportedSourceFile(path)
      && !path.split("/").some((part) => part.startsWith(".")));
    const isScopedSource = createScopedSourcePredicate(projectRoot);
    const folders = new Set<string>();
    for (const path of paths.sort()) {
      if (isScopedSource(path)) continue;
      const parts = path.split("/");
      for (let length = 1; length < parts.length; length += 1) {
        const prefix = parts.slice(0, length).join("/");
        if (!isScopedSource(`${prefix}/x.ts`)) {
          // Paths are quoted in the prompt; avoid injecting control characters.
          if (/^[\w./-]{1,200}$/u.test(prefix)) folders.add(`${prefix}/`);
          break;
        }
      }
      if (folders.size >= 10) break;
    }
    return [...folders].sort();
  } catch { return []; }
}

/** Identical bounded prompts for background and one-paste subsystem setup. */
export function buildSetupUnitPrompt(
  projectRoot: string, state: SetupPlanState, scannerBrief: string | null,
  unit?: SubsystemUnit, legacyPatterns = false,
): string {
  state.skippedSourceFolders ??= discoverSkippedSourceFolders(projectRoot);
  const skippedFolders = state.skippedSourceFolders;
  const nestedOf = (unit: SubsystemUnit) => unit.remainder
    ? state.subsystems.filter((other) => other !== unit && other.path.startsWith(`${unit.path}/`)).map((other) => other.path)
    : [];
  const descriptions = new Map(state.subsystems.map((unit) => {
    let names: string[] = [];
    try {
      const directory = opendirSync(resolve(projectRoot, unit.path));
      try {
        for (let count = 0; count < 100; count += 1) {
          const entry = directory.readSync();
          if (!entry) break;
          if (entry.isFile() && !entry.name.startsWith(".")) names.push(entry.name);
        }
      } finally { directory.closeSync(); }
      names = names.sort().slice(0, 5);
    } catch { /* the folder itself still describes the planned responsibility */ }
    return [unit.slug, `${folder(unit.path, unit.remainder)} — ${unit.files} source files${names.length ? `; entry files include ${names.join(", ")}` : "; explore its entry points and responsibilities"}`];
  }));
  const promptEntry = (unit: SubsystemUnit): SubsystemPromptEntry => ({
    description: descriptions.get(unit.slug),
    path: unit.path,
    ...(unit.remainder ? { remainder: true } : {}),
    budget: unit.budget,
    wikiFile: subsystemWikiFile(unit.slug),
    batchFile: unitBatchFile(unit.slug),
    opIdPrefix: opIdPrefix(unit.slug),
  });

  if (unit) return buildSubsystemPrompt({ skippedFolders, sharedDone: state.shared.state === "done", navigationData: true, subsystem: promptEntry(unit), nested: nestedOf(unit), planned: state.subsystems.map(promptEntry) });
  return legacyPatterns ? buildSharedPatternsPrompt(unitBatchFile(SHARED_UNIT_SLUG)) : buildSharedFilesPrompt({
    skippedFolders, navigationData: true, briefJson: scannerBrief, batchFile: unitBatchFile(SHARED_UNIT_SLUG),
    opIdPrefix: opIdPrefix(SHARED_UNIT_SLUG), subsystems: state.subsystems.map(promptEntry),
  });
}

export async function runSubsystemPopulation(options: SubsystemPopulationOptions): Promise<SubsystemPopulationOutcome> {
  const projectRoot = resolve(options.projectRoot);
  const mexDir = resolve(projectRoot, ".mex");
  const { state } = options;
  const now = options.now ?? Date.now;
  const freeMemory = options.freeMemory ?? freemem;
  const launch = options.launch ?? launchHeadlessSetupPopulation;
  const limit = resolveParallelRuns(options.parallelRuns);
  const message = (text: string) => { try { options.onMessage?.(text); } catch { /* observation only */ } };
  const phase = new AbortController();
  const onAbort = () => phase.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) phase.abort();
  const applier = options.applier ?? createSetupBatchApplier(projectRoot);
  let lastTool: BackgroundAgentTool | null = null;
  let stopError: unknown = null;
  let consecutiveFailures = 0;
  let coveragePhase: SetupCoverageProgress["phase"] = "shared";
  const running = new Set<WorkUnit>();
  const sessions = new Set<WorkUnit>();
  let wake: () => void = () => undefined;
  let slotChanged = new Promise<void>((resolve) => { wake = resolve; });
  const notifySlot = () => { wake(); slotChanged = new Promise<void>((resolve) => { wake = resolve; }); };
  phase.signal.addEventListener("abort", notifySlot, { once: true });
  const graphStartFree = freeMemory();
  const graphReserve = graphBuildReserveBytes(state.plan.sourceFiles);
  let graphBuilding = options.graphReady !== undefined;
  void options.graphReady?.then(() => { graphBuilding = false; notifySlot(); }, () => { graphBuilding = false; phase.abort(); notifySlot(); });
  const startedAt = new Map<WorkUnit, number>();
  let finalNeeded = state.final.state !== "done";

  const save = () => {
    try {
      savePlanState(projectRoot, state, new Date(now()));
      const view = resolve(projectRoot, SETUP_PLAN_VIEW_FILE);
      mkdirSync(dirname(view), { recursive: true });
      writeFileSync(view, renderPlanProgress(state), "utf8");
    } catch (error) {
      // Losing the record must not lose the work: the batches on disk are replayed by opId.
      message(`Warning: Could not save setup progress (${error instanceof Error ? error.message : String(error)}). A rerun recognizes applied batches.`);
    }
  };
  const coverage = () => {
    const subsystems = state.subsystems.map((unit) => ({ path: unit.path, state: unit.state }));
    try {
      options.onCoverage?.({
        shared: state.shared.state,
        waitingForGraph: graphBuilding ? [...running].filter((unit) => !sessions.has(unit) && unit.batchFile !== undefined && existsSync(resolve(projectRoot, unit.batchFile))).length : 0,
        phase: coveragePhase,
        finalState: state.final.state,
        total: subsystems.length,
        done: subsystems.filter((unit) => unit.state === "done").length,
        skipped: subsystems.filter((unit) => unit.state === "skipped").length,
        subsystems,
      });
    } catch { /* observation only */ }
  };

  const sharedBatchPath = resolve(projectRoot, unitBatchFile(SHARED_UNIT_SLUG));
  let legacyPatterns = false;
  if (state.navigationVersion !== 1 && state.shared.state === "done" && state.final.state !== "done" && existsSync(sharedBatchPath)) {
    try { legacyPatterns = !readSetupBatch(sharedBatchPath).extended; } catch { /* the usual refusal/fix flow handles a malformed batch */ }
  }
  const sharedFactsBeforeUpgrade = state.shared.facts;
  if (state.shared.state !== "done") state.navigationVersion = 1;

  const sharedUnit: WorkUnit = {
    kind: "shared",
    label: "the shared files",
    progress: state.shared,
    batchFile: unitBatchFile(SHARED_UNIT_SLUG),
    scope: { opIdPrefix: opIdPrefix(SHARED_UNIT_SLUG), files: [...SHARED_CONTEXT_FILES] },
    writePrompt: () => buildSetupUnitPrompt(projectRoot, state, options.scannerBrief, undefined, legacyPatterns),
    allowed: (path) => [".mex/AGENTS.md", ".mex/ROUTER.md", ...SHARED_CONTEXT_FILES.map((file) => `.mex/${file}`)].includes(path),
  };
  const subsystemUnits: WorkUnit[] = state.subsystems.map((unit) => ({
    kind: "subsystem",
    label: `subsystem ${folder(unit.path, unit.remainder)}`,
    progress: unit,
    subsystem: unit,
    batchFile: unitBatchFile(unit.slug),
    scope: { opIdPrefix: opIdPrefix(unit.slug), files: [subsystemWikiFile(unit.slug)] },
    transcriptTag: unit.slug,
    writePrompt: () => buildSetupUnitPrompt(projectRoot, state, options.scannerBrief, unit),
    allowed: () => false,
  }));

  let guard: ScopeGuard | null = null;
  try { guard = new ScopeGuard(projectRoot, { trackSource: options.trackSource !== false }); }
  catch { guard = null; }
  const reportScope = (changed: readonly string[], suspects: readonly WorkUnit[]) => {
    const unexpected = changed.filter((path) => !suspects.some((unit) => unit.allowed(path)));
    if (unexpected.length === 0) return;
    const who = suspects.length === 0
      ? "while no MEX session was running"
      : suspects.length === 1
        ? `by the session for ${suspects[0]!.label}, which may write only ${suspects[0]!.batchFile ?? "its own scaffold files"}${suspects[0]!.kind === "shared" ? " and the shared files" : ""}`
        : `while sessions for ${suspects.map((unit) => unit.label).join(", ")} were running`;
    const shown = unexpected.slice(0, 8).join(", ") + (unexpected.length > 8 ? `, and ${unexpected.length - 8} more` : "");
    message(`Warning: Files changed outside the expected scope ${who}: ${shown}. MEX did not revert anything; review these changes before committing.`);
  };

  let applyChain: Promise<unknown> = Promise.resolve();
  const waitForGraph = async () => {
    if (phase.signal.aborted) throw new HeadlessPopulationError("cancelled");
    if (!options.graphReady) return;
    let abort: () => void = () => undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new HeadlessPopulationError("cancelled"));
      phase.signal.addEventListener("abort", abort, { once: true });
    });
    try { await Promise.race([options.graphReady, stopped]); }
    finally { phase.signal.removeEventListener("abort", abort); }
  };
  const applyUnit = (unit: WorkUnit): Promise<BatchApplyOutcome> => {
    const run = applyChain.then(async () => {
      await waitForGraph();
      if (phase.signal.aborted) throw new HeadlessPopulationError("cancelled");
      if (guard) reportScope(guard.take(), [...running].filter((other) => other !== unit));
      const started = now();
      let outcome: BatchApplyOutcome;
      try {
        outcome = await applier.apply(setupOperationsFile(projectRoot, unit.batchFile!), unit.scope!);
      } catch (error) {
        // An apply that throws (a lock held elsewhere, a disk error) is reported like a refusal.
        outcome = { kind: "refused", problems: [{ code: "SETUP_APPLY_FAILED", message: error instanceof Error ? error.message : String(error) }] };
      } finally {
        // What MEX itself just wrote is never blamed on a session.
        guard?.take();
      }
      if (outcome.kind !== "missing") {
        unit.progress.runs.push({
          kind: "apply", startedAt: new Date(started).toISOString(), durationMs: Math.max(0, now() - started),
          outcome: outcome.kind === "applied" ? "applied" : "refused",
          ...(outcome.kind === "refused" ? { failure: outcome.problems[0]?.code ?? "refused" } : {}),
        });
      }
      return outcome;
    });
    applyChain = run.catch(() => undefined);
    return run;
  };

  const runAgent = async (unit: WorkUnit, prompt: string, kind: "write" | "fix"): Promise<{ ok: true } | { ok: false; error: unknown }> => {
    while (kind === "fix" && options.graphReady !== undefined && !canStartAnother() && !phase.signal.aborted) {
      await Promise.race([slotChanged, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    }
    if (phase.signal.aborted) return { ok: false, error: new HeadlessPopulationError("cancelled") };
    sessions.add(unit);
    const started = now();
    startedAt.set(unit, started);
    let usage: PopulationAgentUsage | undefined;
    let tool: BackgroundAgentTool | null = null;
    const record = (outcome: UnitRunRecord["outcome"], failure?: string) => {
      unit.progress.runs.push({
        kind, startedAt: new Date(started).toISOString(), durationMs: Math.max(0, now() - started), outcome, tool,
        ...(failure === undefined ? {} : { failure }), ...(usage === undefined ? {} : { usage }),
      });
    };
    try {
      const tag = unit.transcriptTag;
      const result = await launch({
        selectedTools: options.selectedTools,
        ...(options.tool === undefined ? {} : { tool: options.tool }),
        prompt,
        projectRoot,
        signal: phase.signal,
        ...(options.onActivity ? { onActivity: options.onActivity } : {}),
        ...(options.onTranscript ? {
          onTranscript: tag === undefined ? options.onTranscript : (entry) => options.onTranscript!({ ...entry, text: `[${tag}] ${entry.text}` }),
        } : {}),
        onUsage: (reported) => { usage = reported; },
      });
      tool = result.tool;
      if (result.tool === null) throw new MissingAgentError();
      if (!result.completed) throw new HeadlessPopulationError("protocol", result.tool);
      lastTool = result.tool;
      record("completed");
      save();
      return { ok: true };
    } catch (error) {
      const cancelled = phase.signal.aborted;
      if (error instanceof HeadlessPopulationError) tool = error.tool ?? tool;
      record(cancelled || (error instanceof HeadlessPopulationError && error.category === "usage_limit") ? "stopped" : "failed", cancelled ? "stopped" : failureCategory(error));
      return { ok: false, error: cancelled && !(error instanceof HeadlessPopulationError && error.category === "cancelled")
        ? new HeadlessPopulationError("cancelled") : error };
    } finally {
      sessions.delete(unit);
      notifySlot();
      coverage();
    }
  };

  const stopWith = (error: unknown) => {
    if (stopError === null) stopError = error;
    phase.abort();
  };

  const done = (unit: WorkUnit, facts: number | undefined, note?: string) => {
    unit.progress.state = "done";
    delete unit.progress.reason;
    if (facts !== undefined) unit.progress.facts = facts;
    if (unit.kind === "shared" && sharedFactsBeforeUpgrade !== undefined) unit.progress.facts = Math.max(sharedFactsBeforeUpgrade, facts ?? 0);
    if (unit.kind === "shared" && legacyPatterns) state.navigationVersion = 1;
    if (unit.batchFile !== undefined) unit.progress.applied = true;
    consecutiveFailures = 0;
    if (unit.kind === "subsystem") finalNeeded = true;
    if (note) message(note);
  };
  const skip = (unit: WorkUnit, reason: string) => {
    unit.progress.state = "skipped";
    unit.progress.reason = reason;
    message(`Warning: Skipped ${unit.label}: ${reason}. Rerun \`mex setup\` to try it again; the rest continues.`);
  };

  /** A session failed: stop the phase, or record the failure and keep whatever valid batch it left. */
  const sessionFailed = async (unit: WorkUnit, error: unknown, after: "write" | "fix"): Promise<void> => {
    if (stopsPhase(error) || phase.signal.aborted) {
      unit.progress.state = "pending";
      stopWith(error);
      return;
    }
    // A session that failed after writing a valid batch still did its job.
    if (unit.batchFile !== undefined && after === "write" && existsSync(resolve(projectRoot, unit.batchFile))) {
      const outcome = await applyUnit(unit);
      if (outcome.kind === "applied") {
        done(unit, outcome.facts, `Warning: The session for ${unit.label} did not finish cleanly (${shortReason(error)}), but the batch it wrote was valid and is applied.`);
        return;
      }
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
      unit.progress.state = "pending";
      stopWith(new SubsystemPhaseStoppedError(
        `${CONSECUTIVE_FAILURE_LIMIT} agent sessions in a row failed (${error instanceof Error ? error.message : String(error)}), so this is not one subsystem's problem.`
          + " Check the agent CLI works on its own (sign-in, version, network).",
        failureCategory(error),
      ));
      return;
    }
    skip(unit, shortReason(error));
  };

  const archiveAppliedBatch = (unit: WorkUnit) => {
    const path = resolve(projectRoot, unit.batchFile!);
    if (!unit.progress.applied || !existsSync(path)) return;
    try { renameSync(path, path.replace(/\.json$/u, `.applied-${now()}.json`)); } catch { /* replay keeps a rewrite safe */ }
    unit.progress.applied = false;
  };

  const runUnit = async (unit: WorkUnit): Promise<void> => {
    running.add(unit);
    unit.progress.state = "running";
    delete unit.progress.reason;
    save();
    coverage();
    try {
      let problems: readonly BatchProblem[] | null = null;
      const batchPath = unit.batchFile === undefined ? null : resolve(projectRoot, unit.batchFile);
      // A batch an earlier run wrote but never applied is applied first; replay by opId makes this safe.
      if (batchPath !== null && !unit.progress.applied && existsSync(batchPath) && !(unit.kind === "shared" && legacyPatterns)) {
        const outcome = await applyUnit(unit);
        if (outcome.kind === "applied" && (unit.kind !== "shared" || isScaffoldPopulated(mexDir))) {
          done(unit, outcome.facts, `Applied the batch an earlier run left for ${unit.label}.`);
          return;
        }
        if (outcome.kind === "applied") unit.progress.applied = true;
        if (outcome.kind === "refused") problems = outcome.problems;
      }
      if (problems === null) {
        if (batchPath !== null) archiveAppliedBatch(unit);
        const written = await runAgent(unit, unit.writePrompt(), "write");
        if (guard) reportScope(guard.take(), running.size === 1 ? [unit] : [...running]);
        if (!written.ok) {
          await sessionFailed(unit, written.error, "write");
          return;
        }
        consecutiveFailures = 0;
        if (unit.batchFile === undefined) {
          done(unit, undefined);
          return;
        }
        const outcome = await applyUnit(unit);
        if (outcome.kind === "applied" || (outcome.kind === "missing" && unit.kind === "shared")) {
          done(unit, outcome.kind === "applied" ? outcome.facts : 0);
          return;
        }
        if (outcome.kind === "missing") {
          skip(unit, `the session wrote no batch file at ${unit.batchFile}`);
          return;
        }
        problems = outcome.problems;
      }
      // One short fix session with only the refusal and the file.
      const fixed = await runAgent(unit, buildBatchFixPrompt({
        label: unit.label,
        batchFile: unit.batchFile!,
        wikiFiles: unit.scope!.files,
        opIdPrefix: unit.scope!.opIdPrefix,
        diagnostics: problems,
      }), "fix");
      if (guard) reportScope(guard.take(), running.size === 1 ? [unit] : [...running]);
      if (!fixed.ok) {
        await sessionFailed(unit, fixed.error, "fix");
        return;
      }
      consecutiveFailures = 0;
      const outcome = await applyUnit(unit);
      if (outcome.kind === "applied") {
        done(unit, outcome.facts, `Fixed and applied the batch for ${unit.label}.`);
        return;
      }
      const first = outcome.kind === "refused" ? outcome.problems[0] : undefined;
      skip(unit, first === undefined
        ? "the fix session removed its batch file"
        : `its batch was refused twice (${first.code}: ${clip(first.message, 200)})`);
    } catch (error) {
      unit.progress.state = "pending";
      stopWith(error);
    } finally {
      running.delete(unit);
      if (unit.kind === "shared" && (unit.progress.state as UnitState) === "done" && !isScaffoldPopulated(mexDir)) {
        skip(unit, "required scaffold placeholders remain in the shared files");
      }
      save();
      coverage();
    }
  };

  const canStartAnother = (): boolean => {
    if (graphBuilding) {
      // Bound both current pressure and the graph's remaining growth. Reserve every
      // active CLI's full peak against the initial free memory, even after ramp-up.
      return sessions.size < limit
        && graphStartFree - graphReserve - AGENT_RUN_FOOTPRINT_BYTES * (sessions.size + 1) >= FREE_MEMORY_FLOOR_BYTES
        && freeMemory() - AGENT_RUN_FOOTPRINT_BYTES * (sessions.size + 1) >= FREE_MEMORY_FLOOR_BYTES;
    }
    const slots = options.graphReady === undefined ? running : sessions;
    if (slots.size === 0) return true;
    if (slots.size >= limit) return false;
    // A running session younger than the ramp-up window may still be growing: keep its full footprint reserved.
    const ramping = [...slots].filter((unit) => now() - (startedAt.get(unit) ?? 0) < RAMP_UP_MS).length;
    return freeMemory() - AGENT_RUN_FOOTPRINT_BYTES * (1 + ramping) >= FREE_MEMORY_FLOOR_BYTES;
  };

  try {
    save();
    // Shared is first in the same queue; independent subsystems may start alongside it.
    const needsShared = legacyPatterns || state.shared.state !== "done" || !isScaffoldPopulated(mexDir);
    if (stopError === null) {
      coveragePhase = "subsystems";
      coverage();
      const queue = [ ...(needsShared ? [sharedUnit] : []), ...subsystemUnits.filter((unit) => unit.progress.state !== "done") ];
      const active = new Map<WorkUnit, Promise<void>>();
      let warnedMemory = false;
      while (stopError === null && !phase.signal.aborted && (queue.length > 0 || active.size > 0)) {
        while (stopError === null && !phase.signal.aborted && queue.length > 0 && (options.graphReady === undefined ? running.size : sessions.size) < limit) {
          if (!canStartAnother()) {
            if (!warnedMemory) {
              warnedMemory = true;
              message(`Free memory is low (${(freeMemory() / 1024 ** 3).toFixed(1)} GB), so MEX runs fewer subsystem sessions at once.`);
            }
            break;
          }
          const unit = queue.shift()!;
          const settled = runUnit(unit).finally(() => { active.delete(unit); });
          active.set(unit, settled);
        }
        if (active.size === 0 && !graphBuilding) break;
        const changed = slotChanged;
        await Promise.race([...active.values(), changed]);
      }
      await Promise.allSettled(active.values());
      if (phase.signal.aborted && stopError === null) stopWith(new HeadlessPopulationError("cancelled"));
    }
    if (stopError === null && finalNeeded) {
      coveragePhase = "final";
      // Patterns and routes need the shared files filled; refused shared facts alone do not stop this.
      if (!isScaffoldPopulated(mexDir)) {
        state.final.state = "skipped";
        state.final.reason = "the shared files are not filled yet";
      } else {
        try { reconcileSetupNavigation(projectRoot, state); }
        catch (error) {
          state.final.state = "pending";
          throw new SubsystemPhaseStoppedError(`MEX could not finish setup links and indexes (${error instanceof Error ? error.message : String(error)}). Fix the named batch or scaffold file and rerun \`mex setup\`; completed sessions are kept.`, "navigation");
        }
        state.final.state = "done";
        delete state.final.reason;
      }
    }
    coveragePhase = stopError === null ? "complete" : coveragePhase;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    let changed = false;
    try { changed = (await applier.close()).changed; } catch { /* nothing held */ }
    if (changed) message("The code graph or Git HEAD changed during population, so MEX proved graph freshness again before the next apply; finalize verifies every reference against a refreshed graph.");
    save();
    coverage();
  }

  const doneUnits = state.subsystems.filter((unit) => unit.state === "done");
  const covered = doneUnits.length;
  const total = state.subsystems.length;
  const facts = (state.shared.facts ?? 0) + doneUnits.reduce((sum, unit) => sum + (unit.facts ?? 0), 0);
  const skipped = state.subsystems.filter((unit) => unit.state === "skipped")
    .map((unit) => ({ path: unit.path, reason: unit.reason ?? "skipped" }));

  if (stopError !== null) {
    // The user's cancel: every session was stopped and the progress is saved.
    if (options.signal?.aborted) throw new HeadlessPopulationError("cancelled");
    const base = stopError instanceof MissingAgentError
      ? "No supported agent CLI is available, so MEX could not start the subsystem sessions. Install or sign in to one, or run `mex setup next` in your agent's chat."
      : stopError instanceof Error ? stopError.message : String(stopError);
    throw new SubsystemPhaseStoppedError(
      `${base} Population stopped with ${covered} of ${total} subsystems done; rerun \`mex setup\` to continue where it stopped (done subsystems are kept).`,
      failureCategory(stopError),
    );
  }

  const skippedText = skipped.length === 0 ? "" : ` Skipped ${skipped.length}: ${skipped.slice(0, 4)
    .map((entry) => `${entry.path}/ (${entry.reason})`).join("; ")}${skipped.length > 4 ? "; …" : ""}. Rerun \`mex setup\` to try ${skipped.length === 1 ? "it" : "them"} again.`;
  return {
    tool: lastTool,
    sharedDone: state.shared.state === "done" && isScaffoldPopulated(mexDir),
    covered,
    total,
    facts,
    skipped,
    summary: `Subsystems covered: ${covered} of ${total}, ${facts} facts written.${skippedText}`
      + (state.final.state !== "done" ? " Patterns and links were not written. Rerunning `mex setup` writes them." : ""),
  };
}
