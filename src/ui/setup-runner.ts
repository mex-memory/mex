// ============================================================================
// Headless setup, driven by the web UI
// ============================================================================
//
// The same sequence `mex setup` performs, minus the interactive parts: the tool
// choice arrives from the wizard form instead of readline, and the population
// prompt is returned for the browser to display instead of being printed or
// handed to a spawned agent CLI.
//
// Every disk-touching step comes from `src/setup/steps.ts`, which the CLI
// wizard also uses, so there is exactly one implementation of setup.

import { resolve } from "node:path";
import { ensureScaffoldIdentity, saveAiTools } from "../config.js";
import {
  assertNotMexRepo,
  buildPopulationPrompt,
  detectProjectState,
  findProjectRoot,
  writeScaffold,
  writeToolConfigs,
  type ProjectState,
  type ScaffoldFileResult,
  type SetupMode,
  type ToolConfigResult,
} from "../setup/steps.js";
import type { BuildResult } from "../graph/engine.js";
import type { AiTool, ScaffoldIdentity } from "../types.js";
import type { JobContext, JobStepDeclaration } from "./jobs.js";

export interface RunHeadlessSetupOptions {
  /** Directory to set up. The git root above it is used when there is one. */
  root: string;
  mode: SetupMode;
  /** AI tools whose instruction files should be written to the project root. */
  tools: readonly AiTool[];
  /** Build `.mex/graph.db` as part of setup. Ignored for agent-memory mode. */
  buildGraph: boolean;
}

export interface HeadlessSetupResult {
  projectRoot: string;
  mode: SetupMode;
  state: ProjectState;
  scaffold: ScaffoldFileResult[];
  toolConfigs: ToolConfigResult[];
  identity: ScaffoldIdentity | null;
  /** True when pre-analysis produced a brief for the population prompt. */
  scanned: boolean;
  graph: BuildResult | null;
  /** Set when the graph build was attempted and failed (setup still succeeds). */
  graphError: string | null;
  /** The prompt the user pastes into their agent to populate the scaffold. */
  prompt: string;
}

/** Declared up front so the wizard can render the full checklist immediately. */
export const SETUP_JOB_STEPS: readonly JobStepDeclaration[] = [
  { id: "detect", label: "Inspect project" },
  { id: "scaffold", label: "Create .mex/ scaffold" },
  { id: "tools", label: "Write agent instructions" },
  { id: "identity", label: "Assign project identity" },
  { id: "scan", label: "Pre-analyze codebase" },
  { id: "graph", label: "Build code graph (required before agent)" },
  { id: "prompt", label: "Ready agent population prompt" },
];

/**
 * Run setup, reporting progress through `ctx`. Throws only when setup genuinely
 * cannot proceed (mex's own repo, unwritable scaffold); a failed scan or graph
 * build is reported on its step and the run continues, matching the CLI.
 */
export async function runHeadlessSetup(
  options: RunHeadlessSetupOptions,
  ctx: JobContext,
): Promise<HeadlessSetupResult> {
  const { mode, tools, buildGraph } = options;
  const projectRoot = findProjectRoot(resolve(options.root));
  const mexDir = resolve(projectRoot, ".mex");

  await yieldEventLoop();

  ctx.startStep("detect");
  assertNotMexRepo(projectRoot);
  const state = detectProjectState(projectRoot, mexDir);
  ctx.log("info", `Project root: ${projectRoot}`);
  ctx.finishStep("detect", describeState(mode, state));

  ctx.startStep("scaffold");
  const scaffold = writeScaffold({ projectRoot, mode });
  const copied = scaffold.filter((r) => r.action === "copied").length;
  const skipped = scaffold.filter((r) => r.action === "skipped").length;
  for (const result of scaffold) {
    if (result.action === "skipped") {
      ctx.log("info", `Kept .mex/${result.file} (already populated)`);
    }
  }
  ctx.finishStep(
    "scaffold",
    skipped > 0
      ? `${copied} file${copied === 1 ? "" : "s"} written, ${skipped} already populated`
      : `${copied} file${copied === 1 ? "" : "s"} written`,
  );

  ctx.startStep("tools");
  const toolConfigs = writeToolConfigs({ projectRoot, tools });
  if (tools.length === 0) {
    ctx.skipStep("tools", "No tool selected — .mex/AGENTS.md works with any agent");
  } else {
    const written = toolConfigs.filter((r) => r.action === "copied");
    const existing = toolConfigs.filter((r) => r.action === "exists");
    for (const result of existing) {
      ctx.log("warn", `${result.dest} already exists — left untouched`);
    }
    saveAiTools(mexDir, [...tools]);
    ctx.finishStep(
      "tools",
      written.length > 0
        ? written.map((r) => r.dest).join(", ")
        : "Existing files kept",
    );
  }

  ctx.startStep("identity");
  const identity = safeEnsureIdentity(mexDir, projectRoot, ctx);
  ctx.finishStep("identity", identity ? identity.scaffold_name : "Unavailable");

  ctx.startStep("scan");
  await yieldEventLoop();
  let scannerBrief: string | null = null;
  if (mode === "agent-memory") {
    ctx.skipStep("scan", "Not used in agent-memory mode");
  } else if (state === "fresh") {
    ctx.skipStep("scan", "No source files to analyze yet");
  } else {
    try {
      const { runScan } = await import("../scanner/index.js");
      const brief = await runScan(
        { projectRoot, scaffoldRoot: mexDir, aiTools: [] },
        { jsonOnly: true },
      );
      scannerBrief = JSON.stringify(brief, null, 2);
      ctx.finishStep("scan", "Brief ready — the agent reasons from it instead of exploring");
    } catch (error) {
      ctx.log("warn", `Scanner failed: ${messageOf(error)}`);
      ctx.failStep("scan", "Failed — the agent will explore the filesystem instead");
    }
  }

  ctx.startStep("graph", "Starting code graph build…");
  await yieldEventLoop();
  let graph: BuildResult | null = null;
  let graphError: string | null = null;
  if (mode !== "code-repo") {
    ctx.skipStep("graph", "Not used in agent-memory mode");
  } else if (!buildGraph) {
    ctx.skipStep("graph", "Skipped — run it later from the dashboard");
  } else {
    try {
      graph = await buildProjectGraph(projectRoot, ctx, "graph");
      ctx.finishStep("graph", describeBuild(graph));
    } catch (error) {
      // A missing grammar or SQLite capability must never make setup unusable.
      graphError = messageOf(error);
      ctx.log("warn", `Code graph unavailable: ${graphError}`);
      ctx.failStep("graph", "Unavailable — setup completed without it");
    }
  }

  ctx.startStep("prompt");
  const prompt = buildPopulationPrompt({ mode, state, scannerBrief });
  ctx.finishStep("prompt", "Ready to paste into your agent");

  return {
    projectRoot,
    mode,
    state,
    scaffold,
    toolConfigs,
    identity,
    scanned: scannerBrief !== null,
    graph,
    graphError,
    prompt,
  };
}

export const GRAPH_JOB_STEPS: readonly JobStepDeclaration[] = [
  { id: "build", label: "Index source files" },
];

/** Build (or rebuild) the code graph as a standalone job. */
export async function runGraphBuildJob(root: string, ctx: JobContext): Promise<BuildResult> {
  const projectRoot = findProjectRoot(resolve(root));
  ctx.startStep("build", "Starting code graph build…");
  ctx.log("info", `Indexing ${projectRoot}`);
  const result = await buildProjectGraph(projectRoot, ctx, "build");
  ctx.finishStep("build", describeBuild(result));
  return result;
}

export const GROUNDING_JOB_STEPS: readonly JobStepDeclaration[] = [
  { id: "capture", label: "Fingerprint authored grounding" },
];

export interface GroundingCaptureResult {
  projectRoot: string;
  captured: number;
  skipped: number;
  warnings: string[];
}

/**
 * Record baselines for the grounding an agent just authored — the step
 * `mex setup` runs after its agent session finishes. The web wizard hands the
 * user a prompt and loses control at that point, so this exists as an explicit
 * follow-up action rather than part of the setup job.
 *
 * Nothing here is inferred: it calls the same `captureGroundingBaselines` the
 * CLI, sync, and the pre-0.7 migration all use.
 */
export async function runGroundingCaptureJob(
  root: string,
  ctx: JobContext,
): Promise<GroundingCaptureResult> {
  const { captureGroundingBaselines } = await import("../graph/runtime.js");
  const projectRoot = findProjectRoot(resolve(root));
  const scaffoldRoot = resolve(projectRoot, ".mex");
  const warnings: string[] = [];

  ctx.startStep("capture");
  const result = await captureGroundingBaselines(
    { projectRoot, scaffoldRoot, aiTools: [] },
    {
      warn: (message) => {
        warnings.push(message);
        ctx.log("warn", message);
      },
    },
  );

  ctx.finishStep("capture", describeCapture(result.captured, result.skipped));
  return { projectRoot, captured: result.captured, skipped: result.skipped, warnings };
}

function describeCapture(captured: number, skipped: number): string {
  if (captured === 0 && skipped === 0) {
    return "No grounding found in the scaffold yet";
  }
  const base = `${captured} baseline${captured === 1 ? "" : "s"} captured`;
  return skipped > 0 ? `${base}, ${skipped} skipped` : base;
}

async function buildProjectGraph(
  projectRoot: string,
  ctx?: JobContext,
  stepId = "graph",
): Promise<BuildResult> {
  const { createGraphEngine } = await import("../graph/index.js");
  const started = Date.now();
  let lastEmit = 0;
  let phaseStarted = started;
  let phaseDoneAtStart = 0;

  const engine = createGraphEngine({
    rootDir: projectRoot,
    onProgress: async (event) => {
      if (!ctx) return;
      const now = Date.now();
      // Throttle SSE chatter so a 5k-file extract does not flood the client,
      // but always emit phase transitions and the final tick of a phase.
      const isBoundary =
        event.done === undefined ||
        event.done === 0 ||
        (event.total !== undefined && event.done >= event.total) ||
        now - lastEmit >= 400;
      if (!isBoundary) return;
      lastEmit = now;

      if (event.done === 0 || event.done === undefined) {
        phaseStarted = now;
        phaseDoneAtStart = 0;
      }

      const rate =
        event.done !== undefined && event.done > phaseDoneAtStart
          ? (event.done - phaseDoneAtStart) / Math.max(0.001, (now - phaseStarted) / 1000)
          : null;
      const elapsed = formatElapsed(now - started);
      const rateLabel = rate !== null && rate > 0 ? ` · ${Math.round(rate)}/s` : "";

      ctx.updateStep(
        stepId,
        `${event.message}${rateLabel} · ${elapsed}`,
        event.done !== undefined && event.total !== undefined
          ? { done: event.done, total: event.total }
          : null,
      );
    },
  });
  try {
    return await engine.build();
  } finally {
    engine.close();
  }
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

function safeEnsureIdentity(
  mexDir: string,
  projectRoot: string,
  ctx: JobContext,
): ScaffoldIdentity | null {
  try {
    return ensureScaffoldIdentity(mexDir, projectRoot);
  } catch (error) {
    ctx.log("warn", `Could not write project identity: ${messageOf(error)}`);
    return null;
  }
}

function describeState(mode: SetupMode, state: ProjectState): string {
  if (mode === "agent-memory") return "Agent-memory workspace";
  switch (state) {
    case "existing":
      return "Existing codebase — the scaffold will be populated from your code";
    case "partial":
      return "Partially populated scaffold — empty slots will be filled";
    case "fresh":
      return "Fresh project — the scaffold will be populated from your intent";
  }
}

function describeBuild(result: BuildResult): string {
  return (
    `${result.nodesCreated.toLocaleString()} nodes, ` +
    `${result.edgesCreated.toLocaleString()} edges across ` +
    `${result.filesIndexed.toLocaleString()} files`
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Let pending HTTP/SSE writes flush before a long CPU-bound step. */
function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
