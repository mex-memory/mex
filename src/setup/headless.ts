import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { isCliAvailable } from "../cli-tools.js";
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
import { launchHeadlessSetupPopulation, type HeadlessPopulationActivity, type HeadlessPopulationTranscript } from "./headless-population.js";
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
  resolveSetupMode,
  scanSetupCodebase,
  throwIfSetupAborted,
} from "./phases.js";

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
  }) => Promise<{ tool: "claude" | "codex" | null; completed: boolean }>;
  readonly onMessage?: (message: string) => void;
  /** Live maintenance updates, separate from the ordered setup phase transitions. */
  readonly onGraphProgress?: (progress: GraphMaintenanceProgress) => void;
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
  readonly populationTool: "claude" | "codex" | null;
  readonly populationCompleted: boolean;
  readonly commitCommands: string[];
  readonly anchorNotes: string[];
  readonly message: string;
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
  const stage = resolveSetupStage({ mode, hasGit, hasScaffold, populated, graphReady, wikiReady });
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
      cliAvailable: AI_TOOLS[id].cli !== null && isCliAvailable(AI_TOOLS[id].cli),
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

  if (mode === "code-repo" && !existsSync(resolve(projectRoot, ".git"))) {
    throw new SetupError("No Git repository found. Run `git init` first, then rerun setup.");
  }

  const scaffoldPopulatedAtStart = isScaffoldPopulated(mexDir);
  const state = detectProjectState(projectRoot, mexDir);
  report("detect", describeDetectedState(mode, state));

  report("scaffold");
  createSetupScaffold({ projectRoot, mode, signal: options.signal });

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

  if (mode === "code-repo") {
    report("graph");
    await buildSetupGraph(projectRoot, {
      background: true,
      signal: options.signal,
      onProgress: options.onGraphProgress,
    });
  }

  const prompt = await buildSetupPopulationPrompt(mode, state, scannerBrief);
  options.onPopulationPrompt?.(prompt);
  report("population");

  let populationFinished = scaffoldPopulatedAtStart;
  let populationTool: "claude" | "codex" | null = null;
  let populationCompleted = false;

  if (!populationFinished && options.confirmPopulation !== true) {
    throwIfSetupAborted(options.signal);
    const launched = await (options.populate ?? launchHeadlessSetupPopulation)({
      selectedTools,
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
      populationFinished = isScaffoldPopulated(mexDir);
    }
  }

  if (!populationFinished && options.confirmPopulation === true) {
    populationFinished = isScaffoldPopulated(mexDir);
  }

  if (!populationFinished || !isScaffoldPopulated(mexDir)) {
    return {
      mode,
      stage: "needs_population",
      populated: false,
      ready: false,
      selectedTools,
      prompt,
      populationTool,
      populationCompleted,
      commitCommands: mode === "code-repo" ? setupCommitCheckpointCommands(selectedTools) : [],
      anchorNotes,
      message: populationCompleted
        ? "The agent exited successfully, but required scaffold placeholders remain."
        : options.confirmPopulation === true
          ? "Required scaffold placeholders remain. Finish the manual population prompt, then check again."
          : "Setup is waiting for population. Complete the prompt in your AI tool, then continue setup.",
    };
  }

  if (mode === "code-repo") {
    report("finalize");
    throwIfSetupAborted(options.signal);
    await finalizeCodeRepoSetup(projectRoot, mexDir, {
      signal: options.signal,
      onMessage: options.onMessage,
    });
    throwIfSetupAborted(options.signal);
  }

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
    message: mode === "code-repo"
      ? "Graph and Wiki are ready. Review and commit the canonical MEX setup."
      : "Setup complete.",
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

function describeDetectedState(mode: SetupMode, state: ProjectState): string {
  if (mode === "agent-memory") return "Detected: agent-memory workspace";
  if (state === "existing") return "Detected: existing codebase with source files";
  if (state === "fresh") return "Detected: fresh project (no source files yet)";
  return "Detected: existing codebase with a populated scaffold";
}

function uniqueTools(tools: readonly AiTool[]): AiTool[] {
  return [...new Set(tools)];
}
