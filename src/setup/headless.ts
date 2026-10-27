import { populationWarning, fillPopulationPlaceholders, populationPlaceholderFiles, unpopulatedScaffoldFiles } from "./population-audit.js";
import { withSetupLock } from "./setup-lock.js";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { isCliAvailable } from "../cli-tools.js";
import { cleanupStaleSetupPrompts } from "../agent-prompt.js";
import {
  ensureScaffoldIdentity,
  loadConfiguredAiTools,
  loadConfiguredSetupMode,
  readScaffoldId,
  saveAiTools,
} from "../config.js";
import { AI_TOOLS, type AiTool } from "../types.js";
import { AGENT_SKILL_TARGETS, OFFICIAL_MEX_SKILLS } from "../agent-skills/types.js";
import { SetupError, classifySetupFileSystemError } from "./errors.js";
import { classifySetupAgentAssetsError } from "./agent-errors.js";
import type { GraphMaintenanceProgress } from "../team/contracts/graph.js";
import { describeGroundingDrift } from "../graph/grounding-failures.js";
import { BACKGROUND_AGENT_CLIS, COMMAND_CAPABLE_AGENTS, isBackgroundAgentTool, type BackgroundAgentTool } from "../agent-command.js";
import {
  HeadlessPopulationError,
  describeSetupAgentChoice,
  findAvailableSetupAgent,
  launchHeadlessSetupPopulation,
  type HeadlessPopulationActivity,
  type HeadlessPopulationLaunchResult,
  type HeadlessPopulationOptions,
  type HeadlessPopulationTranscript,
  type SetupAgentChoice,
} from "./headless-population.js";
import type { SetupBatchApplier } from "./subsystem-apply.js";
import { populateDuringGraph } from "./concurrent-graph.js";
import { createPlanState, hasUnfinishedPlanState, isUnstartedSetupPlan, loadPlanState, readSetupPlanSnapshot, savePlanState, type SetupPlanState } from "./subsystem-state.js";
import { SETUP_HANDOFF_PROMPT, describeUnfinishedSetup, syncSetupNotice } from "./unfinished.js";
import {
  SubsystemPhaseStoppedError,
  perSubsystemSwitch,
  runSubsystemPopulation,
  shouldRunPerSubsystem,
  type SetupCoverageProgress,
} from "./subsystem-runs.js";
import type { SubsystemPlan } from "./subsystems.js";
import {
  detectProjectState,
  ensureToolAnchors,
  finalizeCodeRepoSetup,
  installSetupAgentAssets,
  isScaffoldPopulated,
  setupCommitCheckpointCommands,
  setupTemplatesDirectory,
  type ProjectState,
  type SetupMode,
} from "./index.js";
import {
  buildSetupGraph,
  buildSetupPopulationPrompt,
  createSetupScaffold,
  requireSetupGitRepository,
  resolveSetupMode,
  scanSetupCodebase,
  throwIfSetupAborted,
} from "./phases.js";
import { stampPlacedTemplates } from "./wiki-stamp.js";

export const SETUP_PROGRESS_STEPS = [
  "detect",
  "scaffold",
  "tools",
  "skills",
  "identity",
  "scan",
  "graph",
  "population",
  "finalize",
] as const;

export type SetupProgressStep = (typeof SETUP_PROGRESS_STEPS)[number];

export type SetupStage =
  | "needs_git"
  | "needs_setup"
  | "needs_population"
  | "needs_finalize"
  | "ready";

export interface SetupToolStatus {
  readonly id: AiTool;
  readonly name: string;
  readonly selected: boolean;
  readonly cliAvailable: boolean;
}

export interface SetupStatus {
  readonly mode: SetupMode;
  readonly projectRoot: string;
  readonly projectName: string;
  readonly hasGit: boolean;
  readonly hasScaffold: boolean;
  readonly populated: boolean;
  readonly graphReady: boolean;
  readonly wikiReady: boolean;
  readonly state: ProjectState;
  readonly stage: SetupStage;
  readonly configuredTools: AiTool[];
  readonly tools: readonly SetupToolStatus[];
  readonly ready: boolean;
}

export interface HeadlessSetupOptions {
  readonly projectRoot: string;
  readonly mode?: SetupMode | string;
  readonly tools?: readonly AiTool[];
  readonly confirmPopulation?: boolean;
  /**
   * Stop after the scaffold, identity, scan and graph steps and return what
   * population needs (`preparation`), without populating or finalizing. Used by
   * `mex setup next`, which hands population to the user's agent unit by unit.
   */
  readonly stopBeforePopulation?: boolean;
  /** One-paste preparation delegates graph maintenance to its durable worker. */
  readonly deferPreparationGraph?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (update: HeadlessSetupProgress) => void;
  readonly onPopulationActivity?: (activity: HeadlessPopulationActivity) => void;
  readonly onPopulationTranscript?: (entry: HeadlessPopulationTranscript) => void;
  readonly onPopulationPrompt?: (prompt: string) => void;
  readonly onAnchorNotes?: (notes: readonly string[]) => void;
  /** Presentation-owned population (the terminal temporarily yields to a native agent). */
  readonly populate?: (input: {
    selectedTools: readonly AiTool[];
    prompt: string;
    projectRoot: string;
    signal?: AbortSignal;
  }) => Promise<HeadlessPopulationLaunchResult>;
  readonly onMessage?: (message: string) => void;
  /** Live maintenance updates, separate from the ordered setup phase transitions. */
  readonly onGraphProgress?: (progress: GraphMaintenanceProgress) => void;
  /** Per-subsystem population progress (larger repositories): subsystems done, skipped, running. */
  readonly onPopulationCoverage?: (coverage: SetupCoverageProgress) => void;
  /**
   * Per-subsystem population knobs. `parallelRuns` caps concurrent sessions
   * (default 3, or MEX_SETUP_PARALLEL_RUNS); the rest are test seams.
   */
  readonly perSubsystem?: {
    readonly parallelRuns?: number;
    readonly env?: NodeJS.ProcessEnv;
    readonly launch?: (input: HeadlessPopulationOptions) => Promise<HeadlessPopulationLaunchResult>;
    /** Test seam: the agent MEX finds on PATH for background sessions. */
    readonly findAgent?: (selectedTools: readonly AiTool[], requireCommands: boolean) => Promise<SetupAgentChoice | null>;
    readonly applier?: SetupBatchApplier;
    readonly freeMemory?: () => number;
    readonly trackSource?: boolean;
  };
}

export interface HeadlessSetupProgress {
  readonly step: SetupProgressStep;
  readonly label: string;
  readonly detail?: string;
}

export interface HeadlessSetupResult {
  readonly mode: SetupMode;
  readonly stage: SetupStage;
  readonly populated: boolean;
  readonly ready: boolean;
  readonly selectedTools: AiTool[];
  readonly prompt: string | null;
  readonly populationTool: BackgroundAgentTool | null;
  readonly populationCompleted: boolean;
  readonly commitCommands: string[];
  readonly anchorNotes: string[];
  readonly message: string;
  /** What finalization changed or left for review (dropped references, drifted facts); already part of `message`. */
  readonly groundingNotice?: string;
  /** Per-subsystem population summary (covered, skipped, facts); already part of `message`. */
  readonly coverageNotice?: string;
  /** With `stopBeforePopulation`: the detected project state and the scanner brief. */
  readonly preparation?: { readonly state: ProjectState; readonly scannerBrief: string | null };
}

const STEP_LABELS: Record<SetupProgressStep, string> = {
  detect: "Detect project state",
  scaffold: "Create .mex/ scaffold",
  tools: "Link AI tool instructions",
  skills: "Install official MEX agent skills",
  identity: "Assign project identity",
  scan: "Pre-analyze codebase",
  graph: "Build code graph",
  population: "Populate the scaffold",
  finalize: "Capture grounding and Wiki",
};

const EMPTY_REVISION_REASON = "Setup has not finished in this checkout.";

export function inspectSetupStatus(projectRoot: string): SetupStatus {
  const root = resolve(projectRoot);
  const mexDir = resolve(root, ".mex");
  const mode = loadConfiguredSetupMode(mexDir);
  const hasGit = existsSync(resolve(root, ".git"));
  const hasScaffold = existsSync(resolve(mexDir, "ROUTER.md"));
  const populated = isScaffoldPopulated(mexDir);
  const graphReady = existsSync(resolve(mexDir, "graph.db"));
  const wikiReady = existsSync(resolve(mexDir, "wiki.db"));
  const configuredTools = hasScaffold || existsSync(resolve(mexDir, "config.json"))
    ? loadConfiguredAiTools(mexDir)
    : [];
  const state = detectProjectState(root, mexDir);
  // A stored plan that has not finalized keeps setup unfinished, even once the
  // shared files are filled and a provisional Wiki index exists.
  const unfinished = hasScaffold && describeUnfinishedSetup(root) !== null;
  const stage = resolveSetupStage({ mode, hasGit, hasScaffold, populated: populated && !unfinished, graphReady, wikiReady });
  return {
    mode,
    projectRoot: root,
    projectName: basename(root),
    hasGit,
    hasScaffold,
    populated,
    graphReady,
    wikiReady,
    state,
    stage,
    configuredTools,
    tools: (Object.keys(AI_TOOLS) as AiTool[]).map((id) => ({
      id,
      name: AI_TOOLS[id].name,
      selected: configuredTools.includes(id),
      cliAvailable: isBackgroundAgentTool(id) && isCliAvailable(BACKGROUND_AGENT_CLIS[id]),
    })),
    ready: stage === "ready",
  };
}

export function setupUnavailableReason(): string {
  return EMPTY_REVISION_REASON;
}

/**
 * Run the shared ordered setup path, with presentation and input owned by callers.
 *
 * The Hub defaults to a headless Claude/Codex session; the terminal supplies a
 * native handoff callback. Scripts use confirmPopulation to inspect without an
 * agent. Finalize only runs after checking the populated files, regardless of
 * the population adapter's result.
 */
export async function runHeadlessSetup(
  options: HeadlessSetupOptions,
): Promise<HeadlessSetupResult> {
  const projectRoot = resolve(options.projectRoot);
  const mexDir = resolve(projectRoot, ".mex");
  throwIfSetupAborted(options.signal);
  if (resolveSetupMode(mexDir, options.mode) === "code-repo" && !existsSync(resolve(projectRoot, ".git"))) {
    throw new SetupError("No Git repository found. Run `git init` first, then rerun setup.");
  }
  // One setup per checkout at a time (#310), taken before anything changes.
  return withSetupLock(mexDir, async () => {
    cleanupStaleSetupPrompts(projectRoot);
    return runLockedSetup(options);
  });
}

async function runLockedSetup(
  options: HeadlessSetupOptions,
): Promise<HeadlessSetupResult> {
  const projectRoot = resolve(options.projectRoot);
  const mexDir = resolve(projectRoot, ".mex");
  const mode = resolveSetupMode(mexDir, options.mode);
  const templatesDir = setupTemplatesDirectory();
  const report = (step: SetupProgressStep, detail?: string) => {
    options.onProgress?.({
      step,
      label: STEP_LABELS[step],
      ...(detail === undefined ? {} : { detail }),
    });
  };

  throwIfSetupAborted(options.signal);

  requireSetupGitRepository(projectRoot, mode);

  const storedSingle = readSetupPlanSnapshot(projectRoot);
  const singlePaused = (storedSingle?.queue?.mode === "single"
    && !storedSingle.queue.finalized && storedSingle.finalizedAt === undefined && storedSingle.shared.state !== "done" ? storedSingle : null);
  // An interrupted single session may already have authored all seven files.
  // Finalize it with the content audit rather than repeat the whole session.
  const scaffoldPopulatedAtStart = isScaffoldPopulated(mexDir);
  const resumeSingle = singlePaused !== null && !scaffoldPopulatedAtStart;
  const unusedLegacyPlan = scaffoldPopulatedAtStart && storedSingle !== null
    && populationPlaceholderFiles(mexDir).length > 0 && isUnstartedSetupPlan(projectRoot, storedSingle);
  const state = detectProjectState(projectRoot, mexDir);
  report("detect", describeDetectedState(mode, state));

  report("scaffold");
  createSetupScaffold({ projectRoot, mode, signal: options.signal });
  if (mode === "code-repo") {
    await stampPlacedTemplates(projectRoot, mexDir, templatesDir, (message) => options.onMessage?.(message));
    throwIfSetupAborted(options.signal);
  }

  report("tools");
  const requestedTools = uniqueTools(options.tools ?? loadConfiguredAiTools(mexDir));
  const selectedTools = requestedTools;
  let anchorNotes: string[];
  try {
    anchorNotes = ensureToolAnchors(projectRoot, templatesDir, selectedTools, false, options.onMessage);
  } catch (error) {
    throw classifySetupFileSystemError(error, "Could not link the selected AI tool instruction files.") ?? error;
  }
  options.onAnchorNotes?.(anchorNotes);
  try {
    saveAiTools(mexDir, selectedTools);
  } catch (error) {
    throw classifySetupFileSystemError(error, "Could not save the AI tool selection in .mex/config.json.") ?? error;
  }

  const selectedAgentClients = selectedTools.filter((tool) => tool === "claude" || tool === "codex");
  if (selectedAgentClients.length > 0) {
    report("skills");
    let agentAssets: ReturnType<typeof installSetupAgentAssets>;
    try {
      agentAssets = installSetupAgentAssets({
        projectRoot,
        selectedTools,
        dryRun: false,
        checkIgnored: mode === "code-repo",
      });
    } catch (error) {
      throw classifySetupAgentAssetsError(error) ?? error;
    }
    if (agentAssets?.conflicted) {
      // Only known install destinations can enter the browser explanation.
      const destinations = new Set(Object.values(AGENT_SKILL_TARGETS).flatMap((target) => [
        target.instructionsPath,
        ...OFFICIAL_MEX_SKILLS.map((skill) => `${target.skillsDirectory}/${skill}`),
      ]));
      const conflicts = [...new Set(agentAssets.actions
        .filter((action) => action.action === "conflict" && destinations.has(action.path))
        .map((action) => action.path))].slice(0, 2);
      const detail = conflicts.length ? ` Check ${conflicts.join(" and ")}.` : "";
      throw new SetupError(`Official MEX agent assets have conflicts.${detail} Review them with mex skills sync --dry-run, resolve the conflicts, then retry setup.`);
    }
  }

  report("identity");
  const identity = ensureScaffoldIdentity(mexDir, projectRoot);
  if (readScaffoldId(mexDir) !== identity.scaffold_id) {
    throw new SetupError("Could not persist .mex/config.json. Fix its permissions or contents and rerun setup.");
  }

  let scannerBrief: string | null = null;
  if (mode !== "agent-memory" && state !== "fresh") {
    report("scan");
    scannerBrief = await scanSetupCodebase(projectRoot, mexDir);
  }

  if (mode === "code-repo" && options.stopBeforePopulation === true && !options.deferPreparationGraph) {
    report("graph");
    await buildSetupGraph(projectRoot, {
      background: true,
      signal: options.signal,
      onProgress: options.onGraphProgress,
    });
  }

  if (options.stopBeforePopulation === true) {
    const populated = isScaffoldPopulated(mexDir);
    return {
      mode,
      stage: populated ? (mode === "code-repo" ? "needs_finalize" : "ready") : "needs_population",
      populated,
      ready: false,
      selectedTools,
      prompt: null,
      populationTool: null,
      populationCompleted: false,
      commitCommands: mode === "code-repo" ? setupCommitCheckpointCommands(selectedTools) : [],
      anchorNotes,
      message: "Setup is prepared for population.",
      preparation: { state, scannerBrief },
    };
  }

  // The agent background sessions run: the user's first selected agent whose
  // CLI is installed, else any installed one (announced in one line).
  const findAgent = options.perSubsystem?.findAgent
    ?? ((tools: readonly AiTool[], requireCommands: boolean) => findAvailableSetupAgent(tools, { projectRoot, signal: options.signal, requireCommands }));
  const announced = new Set<string>();
  const announce = (choice: SetupAgentChoice | null) => {
    const notice = choice === null ? null : describeSetupAgentChoice(choice, selectedTools);
    if (notice !== null && !announced.has(notice)) {
      announced.add(notice);
      options.onMessage?.(notice);
    }
  };

  // Larger code repositories populate with one session per subsystem from a
  // stored plan; a rerun continues an unfinished plan even over filled files.
  // An agent limited to file tools always takes this path: the single session
  // applies its own batches with `mex` commands, which it cannot run.
  let perSubsystemState: SetupPlanState | null = null;
  let perSubsystemTool: BackgroundAgentTool | undefined;
  let plan: SubsystemPlan | null | undefined;
  if (!resumeSingle && mode === "code-repo" && state !== "fresh" && options.confirmPopulation !== true) {
    const env = options.perSubsystem?.env ?? process.env;
    const resuming = !unusedLegacyPlan && perSubsystemSwitch(env) !== "off" && hasUnfinishedPlanState(projectRoot);
    if (!scaffoldPopulatedAtStart || resuming) {
      if (!resuming) plan = (await import("./subsystems.js")).computeSubsystemPlan(projectRoot, { useGraph: false });
      const injected = options.perSubsystem?.launch !== undefined;
      const choice = injected && options.perSubsystem?.findAgent === undefined ? null : await findAgent(selectedTools, false);
      const fileOnly = choice !== null && !COMMAND_CAPABLE_AGENTS.has(choice.tool);
      const planned = (plan ?? null) !== null && (plan?.candidates.length ?? 0) > 0;
      if ((shouldRunPerSubsystem({ plan: plan ?? null, resuming, env }) || (fileOnly && planned && perSubsystemSwitch(env) !== "off"))
        && (injected || choice !== null)) {
        if (choice !== null) {
          perSubsystemTool = choice.tool;
          announce(choice);
        }
        const loaded = loadPlanState(projectRoot);
        if (loaded.notice) options.onMessage?.(`Warning: ${loaded.notice}`);
        // An unreadable stored plan is replaced by a fresh one; replay recognizes batches already applied.
        if (loaded.state === null && plan === undefined) plan = (await import("./subsystems.js")).computeSubsystemPlan(projectRoot, { useGraph: false });
        // The one-paste flow's single-unit form has no subsystem plan to continue.
        const stored = loaded.state?.queue?.mode === "single" ? null : loaded.state;
        if (stored === null && loaded.state !== null && plan === undefined) plan = (await import("./subsystems.js")).computeSubsystemPlan(projectRoot, { useGraph: false });
        perSubsystemState = stored ?? (plan ? createPlanState(plan) : null);
      }
    }
  }

  if (mode === "code-repo" && perSubsystemState === null) {
    report("graph");
    await buildSetupGraph(projectRoot, { background: true, signal: options.signal, onProgress: options.onGraphProgress });
  }
  const fullPrompt = await buildSetupPopulationPrompt(mode, state, scannerBrief, projectRoot, perSubsystemState?.plan ?? plan);
  const prompt = resumeSingle
    ? `Continue the recorded setup; do not restart population. Only these required files still lack authored knowledge: ${unpopulatedScaffoldFiles(mexDir).map(file => `.mex/${file}`).join(", ")}. Preserve completed files and facts. Fill the missing knowledge and check patterns, facts and refines links using the guidance below.\n\n${fullPrompt}`
    : fullPrompt;
  options.onPopulationPrompt?.(prompt);
  if (perSubsystemState === null) report("population");

  // A `mex setup next` plan part-way through its subsystems must not be finalized
  // early just because its shared files are filled: without an agent to run the
  // rest here, setup pauses and says how to continue.
  if (perSubsystemState === null && mode === "code-repo") {
    const unfinished = describeUnfinishedSetup(projectRoot);
    if (!unusedLegacyPlan && unfinished !== null && loadPlanState(projectRoot).state?.queue?.mode !== "single") {
      syncSetupNotice(projectRoot, { done: unfinished.done, total: unfinished.total });
      return {
        mode, stage: "needs_population", populated: isScaffoldPopulated(mexDir), ready: false, selectedTools,
        prompt: SETUP_HANDOFF_PROMPT, populationTool: null, populationCompleted: false,
        commitCommands: setupCommitCheckpointCommands(selectedTools), anchorNotes,
        message: `${unfinished.line} No agent CLI could run here, so paste the prompt into your agent; it runs \`mex setup next\` until setup is complete.`,
      };
    }
  }

  let populationFinished = scaffoldPopulatedAtStart;
  let populationTool: BackgroundAgentTool | null = null;
  let populationCompleted = false;
  let coverageNotice: string | undefined;

  try {
  if (perSubsystemState !== null) {
    throwIfSetupAborted(options.signal);
    const populationState = perSubsystemState;
    let currentCoverage: SetupCoverageProgress | undefined;
    let graphDetail = "Graph building";
    const outcome = await populateDuringGraph({
      signal: options.signal,
      build: async (signal) => {
        const started = Date.now();
        populationState.graph = { startedAt: new Date(started).toISOString(), outcome: "running" };
        savePlanState(projectRoot, populationState);
        report("graph", "Building graph while agent sessions populate knowledge");
        try {
          await buildSetupGraph(projectRoot, { background: true, signal, onProgress: (progress) => {
            options.onGraphProgress?.(progress);
            graphDetail = `Graph: ${progress.phase}${progress.total === undefined ? "" : ` ${progress.completed ?? 0}/${progress.total}`}`;
            report("graph", `${graphDetail} · ${currentCoverage ? describeCoverage(currentCoverage) : "Starting agent sessions"}`);
          } });
          populationState.graph.outcome = "completed";
        } catch (error) {
          populationState.graph.outcome = "failed";
          throw error;
        } finally {
          populationState.graph.finishedAt = new Date().toISOString();
          populationState.graph.durationMs = Date.now() - started;
          savePlanState(projectRoot, populationState);
        }
      },
      populate: (graphReady, signal) => runSubsystemPopulation({
      projectRoot,
      state: populationState,
      selectedTools,
      ...(perSubsystemTool === undefined ? {} : { tool: perSubsystemTool }),
      scannerBrief,
      signal,
      graphReady,
      ...(options.perSubsystem?.parallelRuns === undefined ? {} : { parallelRuns: options.perSubsystem.parallelRuns }),
      ...(options.perSubsystem?.launch ? { launch: options.perSubsystem.launch } : {}),
      ...(options.perSubsystem?.applier ? { applier: options.perSubsystem.applier } : {}),
      ...(options.perSubsystem?.freeMemory ? { freeMemory: options.perSubsystem.freeMemory } : {}),
      ...(options.perSubsystem?.trackSource === undefined ? {} : { trackSource: options.perSubsystem.trackSource }),
      onMessage: options.onMessage,
      onActivity: options.onPopulationActivity,
      onTranscript: options.onPopulationTranscript,
      onCoverage: (coverage) => {
        currentCoverage = coverage;
        options.onPopulationCoverage?.(coverage);
        const graph = populationState.graph;
        report(graph?.outcome === "completed" ? "population" : "graph", `${graph?.outcome === "running" ? `${graphDetail} · ` : graph?.outcome === "failed" ? "Graph stopped; batches saved · " : ""}${describeCoverage(coverage)}`);
      },
      }),
    }).catch(async (error: unknown) => {
      // Stopped part-way (cancel, sign-in, usage limit): leave a readable Wiki, never `migration_required`.
      if (populationState.graph?.outcome === "completed") {
        const { ensureWikiIndexUsable } = await import("./next.js");
        await ensureWikiIndexUsable(projectRoot);
      }
      throw error;
    });
    throwIfSetupAborted(options.signal);
    populationTool = outcome.tool;
    populationCompleted = outcome.sharedDone;
    coverageNotice = outcome.summary;
    options.onMessage?.(outcome.summary);
    populationFinished = isScaffoldPopulated(mexDir);
  } else if (!populationFinished && options.confirmPopulation !== true) {
    throwIfSetupAborted(options.signal);
    // The single session applies its own batches with `mex` commands: Claude Code or Codex only.
    let tool: BackgroundAgentTool | undefined;
    if (options.populate === undefined) {
      const choice = await findAgent(selectedTools, true);
      announce(choice);
      tool = choice?.tool;
    }
    const recorded = singlePaused ?? createPlanState({ source: "tree", ranking: "size", sourceFiles: 0, target: { min: 0, max: 0 }, candidates: [] });
    if (options.populate !== undefined || tool !== undefined) {
      recorded.queue ??= { mode: "single" };
      recorded.shared.state = "running";
      recorded.shared.reason = "population_incomplete";
      savePlanState(projectRoot, recorded);
    }
    const launched = await (options.populate ?? launchHeadlessSetupPopulation)({
      selectedTools,
      ...(tool === undefined ? {} : { tool }),
      requireCommands: true,
      prompt,
      projectRoot,
      signal: options.signal,
      allowNonGit: mode === "agent-memory",
      onActivity: options.onPopulationActivity,
      onTranscript: options.onPopulationTranscript,
    });
    populationTool = launched.tool;
    populationCompleted = launched.completed;
    throwIfSetupAborted(options.signal);
    if (launched.completed) {
      recorded.shared.state = isScaffoldPopulated(mexDir) ? "done" : "pending";
      delete recorded.shared.reason;
      recorded.final.state = "done";
      savePlanState(projectRoot, recorded);
      populationFinished = isScaffoldPopulated(mexDir);
    }
  }

  } catch (error) {
    if ((error instanceof HeadlessPopulationError || error instanceof SubsystemPhaseStoppedError) && error.category === "usage_limit") {
      if (perSubsystemState === null) {
        const paused = singlePaused ?? createPlanState({ source: "graph", ranking: "activity", sourceFiles: 0, target: { min: 0, max: 0 }, candidates: [] });
        paused.queue = { mode: "single" };
        delete paused.finalizedAt;
        paused.shared.state = "pending";
        paused.shared.reason = "usage_limit";
        savePlanState(projectRoot, paused);
      }
      return { mode, stage: "needs_population", populated: false, ready: false, selectedTools, prompt,
        populationTool: error instanceof HeadlessPopulationError ? error.tool ?? null : perSubsystemTool ?? null,
        populationCompleted: false, commitCommands: [], anchorNotes, message: error.message };
    }
    throw error;
  }

  if (!populationFinished && options.confirmPopulation === true) {
    populationFinished = isScaffoldPopulated(mexDir);
  }

  if (!populationFinished || !isScaffoldPopulated(mexDir)) {
    // No agent ran (none could be launched, or none was asked for): hand the
    // user one short prompt that drives `mex setup next`, and record the plan
    // so status lines and the managed block can say how far setup got.
    let handoff: { line: string } | null = null;
    if (populationTool === null && coverageNotice === undefined) {
      try {
        const { prepareSetupQueue } = await import("./next.js");
        const unfinished = await prepareSetupQueue(projectRoot, { mode, projectState: state, scannerBrief, ...(options.perSubsystem?.env === undefined ? {} : { env: options.perSubsystem.env }) });
        handoff = { line: unfinished.line };
      } catch (error) {
        options.onMessage?.(`Warning: Could not record the setup plan for \`mex setup next\` (${error instanceof Error ? error.message : String(error)}). It is created on its first run.`);
      }
    }
    return {
      mode,
      stage: "needs_population",
      populated: false,
      ready: false,
      selectedTools,
      prompt: handoff !== null ? SETUP_HANDOFF_PROMPT : prompt,
      populationTool,
      populationCompleted,
      commitCommands: mode === "code-repo" ? setupCommitCheckpointCommands(selectedTools) : [],
      anchorNotes,
      ...(coverageNotice ? { coverageNotice } : {}),
      message: handoff !== null
        ? `${options.confirmPopulation === true ? "Required scaffold placeholders remain. " : ""}${handoff.line} No agent CLI could run here, so paste the prompt into your agent; it runs \`mex setup next\` until setup is complete.`
        : coverageNotice !== undefined
        ? `The shared scaffold files still have required placeholders, so setup did not finalize. ${coverageNotice} Rerun \`mex setup\` to continue.`
        : populationCompleted
        ? "The agent exited successfully, but required scaffold placeholders remain."
        : options.confirmPopulation === true
          ? "Required scaffold placeholders remain. Finish the manual population prompt, then check again."
          : "Setup is waiting for population. Complete the prompt in your AI tool, then continue setup.",
    };
  }

  const placeholderNotices = fillPopulationPlaceholders(projectRoot, mexDir, options.onMessage);
  let finalized: import("./finalize-repair.js").SetupFinalizeOutcome = { dropped: [], drift: null };
  if (mode === "code-repo") {
    report("finalize");
    throwIfSetupAborted(options.signal);
    finalized = await finalizeCodeRepoSetup(projectRoot, mexDir, {
      selectedTools: options.confirmPopulation ? [] : selectedTools,
      populate: options.populate,
      onActivity: options.onPopulationActivity,
      onTranscript: options.onPopulationTranscript,
      signal: options.signal,
      onMessage: options.onMessage,
    });
    throwIfSetupAborted(options.signal);
  }

  const auditNotice = await populationWarning(projectRoot, mexDir, mode);
  if (auditNotice !== null) options.onMessage?.(auditNotice);
  const groundingNotice = [
    ...placeholderNotices,
    auditNotice ?? "",
    finalized.dropped.length
      ? `Dropped references: ${finalized.dropped.slice(0, 3).map(f => `${f.file} → ${f.node}`).join("; ")}${finalized.dropped.length > 3 ? `; and ${finalized.dropped.length - 3} more` : ""}.`
      : "",
    describeGroundingDrift(finalized.drift),
  ].filter(Boolean).join(" ");
  // Setup finished: a `mex setup next` plan is complete too, and the managed block goes.
  markSetupQueueFinished(projectRoot);
  const status = inspectSetupStatus(projectRoot);
  return {
    mode,
    stage: status.stage,
    populated: true,
    ready: status.ready,
    selectedTools,
    prompt: null,
    populationTool,
    populationCompleted: populationFinished,
    commitCommands: mode === "code-repo" ? setupCommitCheckpointCommands(selectedTools) : [],
    anchorNotes,
    ...(groundingNotice ? { groundingNotice } : {}),
    ...(coverageNotice ? { coverageNotice } : {}),
    message: mode === "code-repo"
      ? "Graph and Wiki are ready. Review and commit the canonical MEX setup."
        + (coverageNotice ? ` ${coverageNotice}` : "") + (groundingNotice ? ` ${groundingNotice}` : "")
      : `Setup complete.${groundingNotice ? ` ${groundingNotice}` : ""}`,
  };
}

function resolveSetupStage(input: {
  mode: SetupMode;
  hasGit: boolean;
  hasScaffold: boolean;
  populated: boolean;
  graphReady: boolean;
  wikiReady: boolean;
}): SetupStage {
  if (input.mode === "code-repo" && !input.hasGit) return "needs_git";
  if (!input.hasScaffold) return "needs_setup";
  if (!input.populated) return "needs_population";
  if (input.mode === "agent-memory") return "ready";
  return input.graphReady && input.wikiReady ? "ready" : "needs_finalize";
}

/** One line for the progress view: subsystems done, skipped and in progress. */
export function describeCoverage(coverage: SetupCoverageProgress): string {
  if (coverage.phase === "complete" && coverage.finalState === "skipped") return `${coverage.done}/${coverage.total} subsystems done; patterns and links were not written. Rerun \`mex setup\` to write them.`;
  if (coverage.phase === "shared") return `Filling the shared files before ${coverage.total} subsystem sessions`;
  if (coverage.phase === "final") {
    return `${coverage.done}/${coverage.total} subsystems done${coverage.skipped > 0 ? `, ${coverage.skipped} skipped` : ""}; writing patterns, routing rows and edges`;
  }
  const running = coverage.subsystems.filter((entry) => entry.state === "running").map((entry) => `${entry.path}/`);
  return `${coverage.done}/${coverage.total} subsystems done`
    + (coverage.shared === undefined ? "" : ` · shared files ${coverage.shared}`)
    + (coverage.waitingForGraph ? ` · ${coverage.waitingForGraph} batches waiting for graph` : "")
    + (coverage.skipped > 0 ? `, ${coverage.skipped} skipped` : "")
    + (running.length > 0 ? ` · working on ${running.slice(0, 3).join(", ")}` : "");
}

function describeDetectedState(mode: SetupMode, state: ProjectState): string {
  if (mode === "agent-memory") return "Detected: agent-memory workspace";
  if (state === "existing") return "Detected: existing codebase with source files";
  if (state === "fresh") return "Detected: fresh project (no source files yet)";
  return "Detected: existing codebase with a populated scaffold";
}

function uniqueTools(tools: readonly AiTool[]): AiTool[] {
  return [...new Set(tools)];
}

/** Mark a stored `mex setup next` plan finished and remove the managed block (setup completed by any path). */
export function markSetupQueueFinished(projectRoot: string): void {
  try {
    const loaded = loadPlanState(projectRoot);
    if (loaded.state !== null && loaded.state.finalizedAt === undefined && loaded.state.queue?.finalized !== true) {
      loaded.state.finalizedAt = new Date().toISOString();
      if (loaded.state.queue !== undefined) {
        loaded.state.queue.finalized = true;
        delete loaded.state.queue.awaiting;
        if (loaded.state.queue.mode === "single") {
          loaded.state.shared.state = "done";
          delete loaded.state.shared.reason;
          loaded.state.final.state = "done";
        }
      }
      savePlanState(projectRoot, loaded.state);
    }
  } catch { /* the record is advisory; the managed block still goes */ }
  try { syncSetupNotice(projectRoot, null); } catch { /* a read-only file keeps its block */ }
}
