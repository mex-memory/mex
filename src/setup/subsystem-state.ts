/**
 * The stored per-subsystem setup plan and the progress of every run.
 *
 * Setup computes the subsystem plan once and keeps it, with the state of each
 * unit of work, in `.mex/local/setup-plan.json` (ignored by Git). A rerun reuses
 * the stored plan and continues: done units are kept, skipped and unstarted ones
 * run again. A file that cannot be read, or that another version wrote, is set
 * aside and replaced with a clear notice; it never stops setup.
 *
 * Paths an agent writes to are always derived from a validated slug, never read
 * back from the file, so an edited state file cannot redirect a write.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PopulationAgentUsage } from "./population-activity.js";
import { isBackgroundAgentTool, type BackgroundAgentTool } from "../agent-command.js";
import type { SubsystemPlan, PlannedSubsystem } from "./subsystems.js";
import { SETUP_OPS_DIRECTORY } from "./prompts.js";

export const SETUP_PLAN_STATE_FILE = ".mex/local/setup-plan.json";
export const SETUP_PLAN_STATE_KIND = "mex-setup-subsystem-plan";
export const SETUP_PLAN_STATE_VERSION = 1;

/** Inspect resume metadata without moving corrupt files or following local links. */
export function readSetupPlanSnapshot(projectRoot: string): SetupPlanState | null {
  try {
    for (const directory of [resolve(projectRoot, ".mex"), resolve(projectRoot, ".mex/local")]) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    }
    const path = resolve(projectRoot, SETUP_PLAN_STATE_FILE);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return null;
    return parsePlanState(readFileSync(path, "utf8")).state;
  } catch { return null; }
}

/** Earlier setup versions queued all work for an authored scaffold with one
 * leftover token. Only an undispatched plan with no run or batch evidence may
 * be bypassed; real interrupted work must continue from its recorded units. */
export function isUnstartedSetupPlan(projectRoot: string, state: SetupPlanState): boolean {
  return state.graph === undefined && !state.queue?.awaiting?.length
    && [state.shared, ...state.subsystems, state.final].every(unit => unit.state === "pending"
      && unit.runs.length === 0 && unit.reason === undefined && !unit.applied && unit.facts === undefined)
    && [SHARED_UNIT_SLUG, ...state.subsystems.map(unit => unit.slug)].every(slug =>
      !existsSync(resolve(projectRoot, unitBatchFile(slug))));
}
/** The unit that fills the shared scaffold files writes its facts here. */
export const SHARED_UNIT_SLUG = "shared";

/** The shared scaffold's context file names and the shared batch name; a subsystem file never takes one. */
const RESERVED_SLUGS = new Set([SHARED_UNIT_SLUG, "architecture", "stack", "conventions", "decisions", "setup"]);
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MAX_RUN_RECORDS = 16;
const MAX_REASON_CHARS = 400;

export type UnitState = "pending" | "running" | "done" | "skipped";

/** One agent run or in-process apply, kept for later measurement. */
export interface UnitRunRecord {
  readonly kind: "write" | "fix" | "apply";
  readonly startedAt: string;
  readonly durationMs: number;
  readonly outcome: "completed" | "failed" | "stopped" | "applied" | "refused";
  readonly tool?: BackgroundAgentTool | null;
  /** A HeadlessPopulationError category, or a short MEX reason. */
  readonly failure?: string;
  readonly usage?: PopulationAgentUsage;
}

interface UnitProgress {
  state: UnitState;
  /** Why a unit was skipped; cleared when it is done. */
  reason?: string;
  /** Facts the applied batch holds (applied now or earlier). */
  facts?: number;
  /** The unit's batch file was applied (all of it). */
  applied?: boolean;
  runs: UnitRunRecord[];
}

export interface SubsystemUnit extends UnitProgress {
  readonly path: string;
  readonly remainder?: true;
  readonly files: number;
  readonly budget: { readonly min: number; readonly max: number };
  readonly slug: string;
}

export type SharedUnit = UnitProgress;
export type FinalUnit = UnitProgress;

export interface SetupPlanState {
  /** Bounded source folders excluded by corpus policy; computed once per plan. */
  skippedSourceFolders?: string[];
  /** Shared/subsystem sessions author navigation data rather than a final agent. */
  navigationVersion?: 1;
  graph?: { startedAt: string; finishedAt?: string; durationMs?: number; outcome: "running" | "completed" | "failed" };
  readonly kind: typeof SETUP_PLAN_STATE_KIND;
  readonly version: typeof SETUP_PLAN_STATE_VERSION;
  readonly createdAt: string;
  updatedAt: string;
  readonly plan: SubsystemPlan;
  readonly shared: SharedUnit;
  readonly subsystems: SubsystemUnit[];
  readonly final: FinalUnit;
  /** Present when `mex setup next` drives the work (the one-paste flow); absent for background sessions. */
  queue?: SetupQueueState;
  /** When setup finalized with this plan (by any path); a later rerun may still retry skipped units. */
  finalizedAt?: string;
}

/** A unit `mex setup next` hands out: the shared files, one subsystem, the final pass, the whole population, or finalize. */
export type QueueUnitId = "shared" | "final" | "single" | "finalize" | `subsystem:${string}`;

/**
 * The one-paste flow's own progress. In `single` mode (small or fresh
 * repositories, agent memory) the whole population is one unit, tracked in
 * `shared`; the plan then may have no candidates.
 */
export interface SetupQueueState {
  readonly mode: "single" | "units";
  /** Units whose instructions were printed last, in plan order. Legacy objects load as a one-item list. */
  awaiting?: {
    readonly unit: QueueUnitId;
    readonly kind: "write" | "fix";
    /** Exact receipt required before this dispatch can be settled. */
    completionToken?: string;
    /** The batch file's hash when fix instructions were printed (an unchanged file is not a second attempt). */
    readonly batchHash?: string;
    /** The canonical scaffold's hash when the instructions were printed (the final pass writes no batch). */
    readonly scaffoldHash?: string;
    /** Times the same instructions were printed again with nothing new to settle. */
    repeats: number;
  }[];
  /** Finalize ran and setup is complete. */
  finalized?: boolean;
}

/** The repository-relative Wiki file a subsystem's facts go into (relative to `.mex/`). */
export function subsystemWikiFile(slug: string): string {
  return `context/${slug}.md`;
}

/** The batch file of a unit, relative to the project root. */
export function unitBatchFile(slug: string): string {
  return `${SETUP_OPS_DIRECTORY}/${slug}.json`;
}

function slugPart(segment: string): string {
  return segment.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}

/**
 * One distinct, readable file name per subsystem: the folder's own name where
 * that is unique (`src/router` -> `router`), more of its path where it is not
 * (`lib/router` -> `lib-router`), `-core` for a folder's own files, and never a
 * scaffold file's name.
 */
export function subsystemSlugs(candidates: readonly Pick<PlannedSubsystem, "path" | "remainder">[]): string[] {
  const segments = candidates.map((candidate) => candidate.path.split("/").map(slugPart).filter(Boolean));
  const depth = candidates.map(() => 1);
  const build = (index: number): string => {
    const parts = segments[index]!;
    const base = parts.slice(Math.max(0, parts.length - depth[index]!)).join("-") || "root";
    const slug = (candidates[index]!.remainder ? `${base}-core` : base).slice(0, 60).replace(/-+$/u, "");
    return slug || "root";
  };
  for (let round = 0; round < 12; round += 1) {
    const slugs = candidates.map((_, index) => build(index));
    const clashes = new Set(slugs.filter((slug, index) => RESERVED_SLUGS.has(slug) || slugs.indexOf(slug) !== index));
    if (clashes.size === 0) return slugs;
    let grew = false;
    slugs.forEach((slug, index) => {
      if (clashes.has(slug) && depth[index]! < segments[index]!.length) {
        depth[index] = depth[index]! + 1;
        grew = true;
      }
    });
    if (!grew) break;
  }
  // Still clashing at full depth (or a reserved full path): number them.
  const taken = new Set<string>();
  return candidates.map((_, index) => {
    const base = build(index);
    let slug = RESERVED_SLUGS.has(base) ? `${base}-code` : base;
    for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
    taken.add(slug);
    return slug;
  });
}

/** A new state for a freshly computed plan; nothing has run yet. */
export function createPlanState(plan: SubsystemPlan, now: Date = new Date()): SetupPlanState {
  const slugs = subsystemSlugs(plan.candidates);
  return {
    kind: SETUP_PLAN_STATE_KIND,
    version: SETUP_PLAN_STATE_VERSION,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    plan,
    shared: { state: "pending", runs: [] },
    subsystems: plan.candidates.map((candidate, index) => ({
      path: candidate.path,
      ...(candidate.remainder ? { remainder: true as const } : {}),
      files: candidate.files,
      budget: { min: candidate.budget.min, max: candidate.budget.max },
      slug: slugs[index]!,
      state: "pending",
      runs: [],
    })),
    final: { state: "pending", runs: [] },
  };
}

export type LoadedPlanState =
  | { readonly state: SetupPlanState; readonly notice?: undefined }
  | { readonly state: null; readonly notice?: string };

const UNIT_STATES: ReadonlySet<string> = new Set(["pending", "running", "done", "skipped"]);
const RUN_KINDS: ReadonlySet<string> = new Set(["write", "fix", "apply"]);
const RUN_OUTCOMES: ReadonlySet<string> = new Set(["completed", "failed", "stopped", "applied", "refused"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown, max = 1_000_000): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

function readRuns(value: unknown): UnitRunRecord[] | null {
  if (!Array.isArray(value)) return null;
  const runs: UnitRunRecord[] = [];
  for (const run of value.slice(-MAX_RUN_RECORDS)) {
    if (!isRecord(run) || !RUN_KINDS.has(run.kind as string) || !RUN_OUTCOMES.has(run.outcome as string)
      || typeof run.startedAt !== "string" || !isCount(run.durationMs, 1e10)) return null;
    const usage = isRecord(run.usage) ? Object.fromEntries(Object.entries(run.usage)
      .filter(([key, count]) => typeof count === "number" && Number.isFinite(count) && count >= 0
        && ["inputTokens", "outputTokens", "cachedInputTokens", "cacheCreationInputTokens", "costUsd", "turns"].includes(key))) : undefined;
    runs.push({
      kind: run.kind as UnitRunRecord["kind"],
      startedAt: run.startedAt.slice(0, 40),
      durationMs: run.durationMs,
      outcome: run.outcome as UnitRunRecord["outcome"],
      ...((typeof run.tool === "string" && isBackgroundAgentTool(run.tool)) || run.tool === null ? { tool: run.tool as BackgroundAgentTool | null } : {}),
      ...(typeof run.failure === "string" ? { failure: run.failure.slice(0, MAX_REASON_CHARS) } : {}),
      ...(usage && Object.keys(usage).length > 0 ? { usage: usage as PopulationAgentUsage } : {}),
    });
  }
  return runs;
}

function readProgress(value: unknown): UnitProgress | null {
  if (!isRecord(value) || !UNIT_STATES.has(value.state as string)) return null;
  const runs = readRuns(value.runs ?? []);
  if (runs === null) return null;
  return {
    state: value.state as UnitState,
    ...(typeof value.reason === "string" ? { reason: value.reason.slice(0, MAX_REASON_CHARS) } : {}),
    ...(isCount(value.facts) ? { facts: value.facts } : {}),
    ...(value.applied === true ? { applied: true } : {}),
    runs,
  };
}

const QUEUE_UNIT_PATTERN = /^(?:shared|final|single|finalize|subsystem:[a-z0-9][a-z0-9-]{0,63})$/u;

function readQueue(value: unknown): SetupQueueState | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || (value.mode !== "single" && value.mode !== "units")) return null;
  let awaiting: SetupQueueState["awaiting"];
  if (value.awaiting !== undefined) {
    const entries = Array.isArray(value.awaiting) ? value.awaiting : [value.awaiting];
    if (entries.length > 67) return null;
    awaiting = [];
    for (const raw of entries) {
      if (!isRecord(raw) || typeof raw.unit !== "string" || !QUEUE_UNIT_PATTERN.test(raw.unit)
        || (raw.kind !== "write" && raw.kind !== "fix")) return null;
      if (awaiting.some((entry) => entry.unit === raw.unit)) return null;
      awaiting.push({
        unit: raw.unit as QueueUnitId,
        kind: raw.kind,
        ...(typeof raw.completionToken === "string" && /^[a-f0-9-]{36}$/u.test(raw.completionToken) ? { completionToken: raw.completionToken } : {}),
        ...(typeof raw.batchHash === "string" ? { batchHash: raw.batchHash.slice(0, 128) } : {}),
        ...(typeof raw.scaffoldHash === "string" ? { scaffoldHash: raw.scaffoldHash.slice(0, 128) } : {}),
        repeats: isCount(raw.repeats, 1_000) ? raw.repeats : 0,
      });
    }
  }
  return { mode: value.mode, ...(awaiting ? { awaiting } : {}), ...(value.finalized === true ? { finalized: true } : {}) };
}

function readPlan(value: unknown, allowEmpty = false): SubsystemPlan | null {
  if (!isRecord(value) || !Array.isArray(value.candidates) || !isRecord(value.target)) return null;
  if (!isCount(value.sourceFiles) || !isCount(value.target.min, 64) || !isCount(value.target.max, 64)) return null;
  const candidates: PlannedSubsystem[] = [];
  for (const entry of value.candidates) {
    if (!isRecord(entry) || typeof entry.path !== "string" || entry.path.length === 0 || entry.path.length > 512
      || !isCount(entry.files) || !isRecord(entry.budget) || !isCount(entry.budget.min, 100) || !isCount(entry.budget.max, 100)) return null;
    candidates.push({
      path: entry.path,
      files: entry.files,
      commits: isCount(entry.commits) ? entry.commits : null,
      ...(entry.remainder === true ? { remainder: true as const } : {}),
      budget: { min: entry.budget.min, max: entry.budget.max },
    });
  }
  if ((candidates.length === 0 && !allowEmpty) || candidates.length > 64) return null;
  return {
    source: value.source === "graph" ? "graph" : "tree",
    ranking: value.ranking === "activity" ? "activity" : "size",
    sourceFiles: value.sourceFiles,
    target: { min: value.target.min, max: value.target.max },
    candidates,
  };
}

/** Parse and validate a stored state; `null` with a reason when it is not usable. */
export function parsePlanState(text: string): { state: SetupPlanState } | { state: null; reason: string } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { state: null, reason: "it is not valid JSON" }; }
  if (!isRecord(raw) || raw.kind !== SETUP_PLAN_STATE_KIND) return { state: null, reason: "it is not a MEX setup plan" };
  if (raw.version !== SETUP_PLAN_STATE_VERSION) {
    return { state: null, reason: `it was written by another MEX version (format ${String(raw.version)}, expected ${SETUP_PLAN_STATE_VERSION})` };
  }
  const queue = readQueue(raw.queue);
  if (queue === null) return { state: null, reason: "its contents are incomplete or malformed" };
  const plan = readPlan(raw.plan, queue?.mode === "single");
  const shared = readProgress(raw.shared);
  const final = readProgress(raw.final);
  if (plan === null || shared === null || final === null || !Array.isArray(raw.subsystems)
    || raw.subsystems.length !== plan.candidates.length) return { state: null, reason: "its contents are incomplete or malformed" };
  const subsystems: SubsystemUnit[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.subsystems.entries()) {
    const progress = readProgress(entry);
    const candidate = plan.candidates[index]!;
    if (progress === null || !isRecord(entry) || typeof entry.slug !== "string" || !SLUG_PATTERN.test(entry.slug)
      || RESERVED_SLUGS.has(entry.slug) || seen.has(entry.slug) || entry.path !== candidate.path) {
      return { state: null, reason: "its contents are incomplete or malformed" };
    }
    seen.add(entry.slug);
    subsystems.push({
      path: candidate.path,
      ...(candidate.remainder ? { remainder: true as const } : {}),
      files: candidate.files,
      budget: candidate.budget,
      slug: entry.slug,
      ...progress,
    });
  }
  return {
    state: {
      ...(Array.isArray(raw.skippedSourceFolders) ? { skippedSourceFolders: raw.skippedSourceFolders.slice(0, 10)
        .filter((folder): folder is string => typeof folder === "string" && /^[\w./-]{1,200}\/$/u.test(folder) && !folder.split("/").includes("..")) } : {}),
      kind: SETUP_PLAN_STATE_KIND,
      version: SETUP_PLAN_STATE_VERSION,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt.slice(0, 40) : new Date(0).toISOString(),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt.slice(0, 40) : new Date(0).toISOString(),
      plan,
      shared,
      subsystems,
      final,
      ...(raw.navigationVersion === 1 ? { navigationVersion: 1 as const } : {}),
      ...(isRecord(raw.graph) && typeof raw.graph.startedAt === "string"
        && ["running", "completed", "failed"].includes(String(raw.graph.outcome)) ? { graph: {
          startedAt: raw.graph.startedAt.slice(0, 40),
          outcome: raw.graph.outcome as "running" | "completed" | "failed",
          ...(typeof raw.graph.finishedAt === "string" ? { finishedAt: raw.graph.finishedAt.slice(0, 40) } : {}),
          ...(isCount(raw.graph.durationMs, 1e10) ? { durationMs: raw.graph.durationMs } : {}),
        } } : {}),
      ...(queue === undefined ? {} : { queue }),
      ...(typeof raw.finalizedAt === "string" ? { finalizedAt: raw.finalizedAt.slice(0, 40) } : {}),
    },
  };
}

/**
 * Read the stored state. A missing file is `null` with no notice. A file that
 * cannot be used is moved aside (never deleted) and reported, so the caller
 * computes a new plan; batch files already applied are recognized again by replay.
 */
export function loadPlanState(projectRoot: string): LoadedPlanState {
  const path = resolve(projectRoot, SETUP_PLAN_STATE_FILE);
  if (!existsSync(path)) return { state: null };
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch { return { state: null, notice: setAside(path, "it could not be read") }; }
  const parsed = parsePlanState(text);
  if (parsed.state !== null) {
    // A run that was going when setup stopped did not finish; it runs again.
    for (const unit of [parsed.state.shared, ...parsed.state.subsystems, parsed.state.final]) {
      if (unit.state === "running") unit.state = "pending";
    }
    return { state: parsed.state };
  }
  return { state: null, notice: setAside(path, parsed.reason) };
}

function setAside(path: string, reason: string): string {
  const aside = `${path}.unreadable-${Date.now()}`;
  try { renameSync(path, aside); }
  catch { try { rmSync(path, { force: true }); } catch { /* the next save replaces it */ } }
  return `The stored setup plan (${SETUP_PLAN_STATE_FILE}) could not be used because ${reason}. `
    + "MEX computed the plan again and kept the old file beside it; batches that were already applied are recognized and not repeated.";
}

/** Write the state atomically (temporary file, then rename). */
export function savePlanState(projectRoot: string, state: SetupPlanState, now: Date = new Date()): void {
  const path = resolve(projectRoot, SETUP_PLAN_STATE_FILE);
  state.updatedAt = now.toISOString();
  for (const unit of [state.shared, ...state.subsystems, state.final]) {
    if (unit.runs.length > MAX_RUN_RECORDS) unit.runs.splice(0, unit.runs.length - MAX_RUN_RECORDS);
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Whether every unit of the stored plan is done. */
export function isPlanStateComplete(state: SetupPlanState): boolean {
  return state.shared.state === "done" && state.final.state === "done" && state.subsystems.every((unit) => unit.state === "done");
}

/**
 * Whether a rerun must continue a stored plan: it is unfinished, or it cannot be
 * read (then loading sets it aside and a new plan replays the batches already on
 * disk, so finished work is recognized, not redone).
 */
export function hasUnfinishedPlanState(projectRoot: string): boolean {
  const path = resolve(projectRoot, SETUP_PLAN_STATE_FILE);
  if (!existsSync(path)) return false;
  try {
    const parsed = parsePlanState(readFileSync(path, "utf8"));
    if (parsed.state === null) return true;
    // A finished one-paste setup, or its single-unit form, has no subsystem plan for background sessions to continue.
    if (parsed.state.queue?.finalized === true || parsed.state.queue?.mode === "single") return false;
    return !isPlanStateComplete(parsed.state);
  } catch {
    return true;
  }
}
