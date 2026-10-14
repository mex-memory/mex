import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { globSync } from "glob";
import chalk from "chalk";
import {
  findConfig,
} from "../config.js";
import {
  captureGroundingBaselines,
  type GroundingBaselineCaptureResult,
} from "../graph/runtime.js";
import { VERSION } from "../version.js";
import {
  syncAgentAssets,
  type AgentAssetsReport,
  type AgentSkillClient,
} from "../agent-skills/index.js";
import { type AiTool } from "../types.js";
import {
  throwIfSetupAborted,
  type ProjectState,
} from "./phases.js";
export {
  AGENT_MEMORY_FILES,
  SCAFFOLD_FILES,
  ensureScaffoldFile,
  normalizeSetupMode,
  setupTemplatesDirectory,
  verifyExistingSetupConfig,
  type ProjectState,
  type ScaffoldFileAction,
  type SetupMode,
} from "./phases.js";
import { finalizeSetupWiki } from "./wiki-finalize.js";
import { SetupError } from "./errors.js";
import { classifySetupMaintenanceError, setupWikiFailureMessage } from "./maintenance-errors.js";
export { findSetupProjectRoot } from "./entry.js";
import {
  ensureMarkdownAnchor,
  ensureOpencodeAnchor,
  planAnchorPointer,
  planOpencodeAnchor,
  type AnchorWriteResult,
} from "./anchor.js";

// ── Constants ──

const SOURCE_EXTENSIONS = [
  "*.py", "*.js", "*.ts", "*.tsx", "*.jsx", "*.go", "*.rs", "*.java",
  "*.kt", "*.swift", "*.rb", "*.php", "*.c", "*.cpp", "*.cs", "*.ex",
  "*.exs", "*.zig", "*.lua", "*.dart", "*.scala", "*.clj", "*.erl",
  "*.hs", "*.ml", "*.vue", "*.svelte",
];

const TOOL_CONFIGS: Record<string, { src: string; dest: string }> = {
  "2": { src: ".tool-configs/.cursorrules", dest: ".cursorrules" },
  "3": { src: ".tool-configs/.windsurfrules", dest: ".windsurfrules" },
  "4": { src: ".tool-configs/copilot-instructions.md", dest: ".github/copilot-instructions.md" },
  "5": { src: ".tool-configs/opencode.json", dest: ".opencode/opencode.json" },
};

/**
 * The anchor each non-agent tool loads, and the template to seed it from.
 *
 * Keyed by tool rather than by menu number because linking has to happen on
 * every setup run, not only the one where the menu was shown. Claude Code and
 * Codex are absent deliberately: the agent-skills installer owns their files
 * and already runs on every setup.
 */
const TOOL_ANCHORS: Partial<Record<AiTool, { src: string; dest: string }>> = {
  cursor: TOOL_CONFIGS["2"],
  windsurf: TOOL_CONFIGS["3"],
  copilot: TOOL_CONFIGS["4"],
  opencode: TOOL_CONFIGS["5"],
};

/**
 * Point every selected tool's anchor at the scaffold.
 *
 * Runs on every setup, including one that reuses a saved tool selection and so
 * never shows the menu. That path is the one that matters: an install
 * orphaned by the old skip already has a populated scaffold and saved
 * `aiTools`, so it takes exactly this branch, and linking only from the menu
 * would have left the people who actually hit the bug unable to fix it by
 * rerunning setup. See https://github.com/mex-memory/mex/issues/106
 *
 * Returns the anchors that could not be linked, for the closing summary.
 */
export function ensureToolAnchors(
  projectRoot: string,
  templatesDir: string,
  tools: readonly AiTool[],
  dryRun: boolean,
  onMessage?: (message: string) => void,
): string[] {
  const notes: string[] = [];

  for (const tool of new Set(tools)) {
    const config = TOOL_ANCHORS[tool];
    if (!config) continue;

    const src = resolve(templatesDir, config.src);
    const dest = resolve(projectRoot, config.dest);
    const isJson = config.dest.endsWith(".json");

    let result: AnchorWriteResult;
    if (dryRun) {
      if (!existsSync(dest)) {
        (onMessage ?? ok)(`(dry run) Would copy ${config.dest}`);
        continue;
      }
      result = isJson
        ? planOpencodeAnchor(readFileSync(dest, "utf-8"))
        : planAnchorPointer(readFileSync(dest));
    } else {
      result = isJson
        ? ensureOpencodeAnchor(projectRoot, config.dest, src)
        : ensureMarkdownAnchor(projectRoot, config.dest, src);
    }

    const note = reportAnchor(config.dest, result, dryRun, onMessage);
    if (note) notes.push(note);
  }

  return notes;
}

/** Print an anchor outcome; return a note for the ones the user must act on. */
function reportAnchor(dest: string, result: AnchorWriteResult, dry: boolean, onMessage?: (message: string) => void): string | null {
  const prefix = dry ? "(dry run) Would " : "";
  switch (result.outcome) {
    case "created":
      (onMessage ?? ok)(`${prefix}${dry ? "copy" : "Copied"} ${dest}`);
      return null;
    case "appended":
      (onMessage ?? ok)(`${prefix}${dry ? "add" : "Added"} a MEX pointer to your existing ${dest}`);
      return null;
    case "updated":
      (onMessage ?? ok)(`${prefix}${dry ? "refresh" : "Refreshed"} the MEX pointer in ${dest}`);
      return null;
    case "already-linked":
      (onMessage ?? info)(`${dest} already points at .mex/ — left unchanged`);
      return null;
    case "conflict": {
      const note =
        `${dest} was left untouched because ${result.reason}. `
        + "Add this line to it by hand so the scaffold is loaded: "
        + "`At the start of every session, read .mex/AGENTS.md and .mex/ROUTER.md.`";
      (onMessage ?? warn)(note);
      return note;
    }
  }
}

// ── Helpers ──

const ok = (msg: string) => console.log(`${chalk.green("✓")} ${msg}`);
const info = (msg: string) => console.log(`${chalk.blue("→")} ${msg}`);
const warn = (msg: string) => console.log(`${chalk.yellow("!")} ${msg}`);

// ── Main ──

/** Exact git commands CLI setup prints after a successful code-repo run. */
export function setupCommitCheckpointCommands(selectedTools: readonly AiTool[]): string[] {
  const commands = ["git status --short", "git add .mex"];
  if (selectedTools.includes("claude")) {
    commands.push("git add CLAUDE.md .claude/skills/mex-inbox .claude/skills/mex-relay");
  }
  if (selectedTools.includes("codex")) {
    commands.push("git add AGENTS.md .agents/skills/mex-inbox .agents/skills/mex-relay");
  }
  if (selectedTools.includes("cursor")) commands.push("git add .cursorrules");
  if (selectedTools.includes("windsurf")) commands.push("git add .windsurfrules");
  if (selectedTools.includes("copilot")) commands.push("git add .github/copilot-instructions.md");
  if (selectedTools.includes("opencode")) commands.push("git add .opencode/opencode.json");
  commands.push('git commit -m "chore: initialize MEX"');
  return commands;
}

export interface SetupRunOptions {
  dryRun?: boolean;
  mode?: string;
  tools?: AiTool[];
  /** Plain, noninteractive setup. Never starts an agent or a browser. */
  yes?: boolean;
  port?: number;
  openBrowser?: boolean;
}

export interface SetupRunResult {
  outcome: "complete" | "paused" | "cancelled" | "failed" | "dry-run";
  message: string;
  /** 2 is a resumable pause; 130/143 indicate cancellation. */
  exitCode: number;
}

export async function runSetup(opts: SetupRunOptions = {}): Promise<SetupRunResult> {
  const { runTerminalSetup } = await import("./terminal.js");
  return runTerminalSetup(opts);
}

/** Parse `--tool` values for a non-interactive setup; unknown names are an error. */
export function parseSetupTools(values: readonly string[]): AiTool[] {
  const known = new Set<string>(Object.values(TOOL_CHOICE_MAP));
  return values.map((value) => {
    const tool = value.trim().toLowerCase();
    if (tool === "none") return null;
    if (!known.has(tool)) throw new Error(`Unknown --tool ${value}. Use one of: ${[...known].join(", ")}, none.`);
    return tool as AiTool;
  }).filter((tool): tool is AiTool => tool !== null);
}

// ── Step functions ──

export function isScaffoldPopulated(mexDir: string): boolean {
  const required = [
    "AGENTS.md",
    "ROUTER.md",
    "context/architecture.md",
    "context/stack.md",
    "context/conventions.md",
    "context/decisions.md",
    "context/setup.md",
  ];
  return required.every((file) => {
    const path = resolve(mexDir, file);
    if (!existsSync(path)) return false;
    const content = readFileSync(path, "utf-8");
    return !content.includes("[Project Name]") && !content.includes("[YYYY-MM-DD]");
  });
}

export function detectProjectState(projectRoot: string, mexDir: string): ProjectState {
  const scaffoldPopulated = isScaffoldPopulated(mexDir);

  // Count source files
  const patterns = SOURCE_EXTENSIONS.map(
    (ext) => `**/${ext}`
  );
  const sourceFiles = globSync(patterns, {
    cwd: projectRoot,
    ignore: ["**/node_modules/**", "**/.mex/**", "**/vendor/**", "**/.git/**"],
    maxDepth: 4,
    nodir: true,
  });

  if (scaffoldPopulated && sourceFiles.length > 0) {
    return "partial";
  } else if (sourceFiles.length > 0) {
    return "existing";
  } else {
    return "fresh";
  }
}

const TOOL_CHOICE_MAP: Record<string, AiTool> = {
  "1": "claude",
  "2": "cursor",
  "3": "windsurf",
  "4": "copilot",
  "5": "opencode",
  "6": "codex",
};

export interface InstallSetupAgentAssetsOptions {
  projectRoot: string;
  selectedTools: readonly AiTool[];
  dryRun?: boolean;
  /** Injectable only for source tests; production resolves the published payload. */
  packagedSkillsRoot?: string;
  /** Injectable only for package-version upgrade tests. */
  packageVersion?: string;
  /** Agent-memory workspaces may intentionally live outside Git. */
  checkIgnored?: boolean;
}

/** The noninteractive installation seam used by the normal setup flow. */
export function installSetupAgentAssets(
  options: InstallSetupAgentAssetsOptions,
): AgentAssetsReport | null {
  const clients = options.selectedTools.filter(
    (tool): tool is AgentSkillClient => tool === "claude" || tool === "codex",
  );
  if (clients.length === 0) return null;
  return syncAgentAssets({
    projectRoot: options.projectRoot,
    packageVersion: options.packageVersion ?? VERSION,
    clients,
    ...(options.checkIgnored === undefined ? {} : { checkIgnored: options.checkIgnored }),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.packagedSkillsRoot === undefined
      ? {}
      : { packagedSkillsRoot: options.packagedSkillsRoot }),
  });
}

/**
 * Expected finalization failure. The Hub uses its authored userMessage;
 * message may retain fuller terminal diagnostics without exposing them there.
 */
export class SetupFinalizationError extends SetupError {
  constructor(message: string, options?: ErrorOptions & { userMessage?: string }) {
    super(message, options);
    this.name = "SetupFinalizationError";
  }
}

// Keeps the composed message inside the Hub's 512-character run error.
const FINALIZATION_DETAIL_LIMIT = 2;
const FINALIZATION_DETAIL_CHARS = 140;

export async function finalizeCodeRepoSetup(projectRoot: string, mexDir: string, options: {
  signal?: AbortSignal;
  onMessage?: (message: string) => void;
} = {}): Promise<void> {
  const info = options.onMessage ?? ((message: string) => console.log(message));
  const warn = info;
  const ok = info;
  throwIfSetupAborted(options.signal);
  info("Capturing grounding baselines...");
  const captureWarnings: string[] = [];
  let result: GroundingBaselineCaptureResult;
  try {
    result = await captureGroundingBaselines(
      { projectRoot, scaffoldRoot: mexDir, aiTools: [] },
      {
        warn: (message) => {
          warn(message);
          if (captureWarnings.length < FINALIZATION_DETAIL_LIMIT) {
            captureWarnings.push(message.slice(0, FINALIZATION_DETAIL_CHARS));
          }
        },
      },
    );
  } catch (error) {
    const expected = classifySetupMaintenanceError(error, "grounding");
    if (expected) throw expected;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Grounding finalization failed: ${message}. Rerun mex setup after fixing it.`);
  }
  throwIfSetupAborted(options.signal);
  try {
    assertGroundingCaptureReady(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = captureWarnings.length === 0 ? "" : ` ${captureWarnings.join(" ")}`;
    throw new SetupFinalizationError(
      `Grounding finalization failed: ${message}${detail} Correct or remove those grounds_to entries or mex:// links, then rerun setup.`,
    );
  }
  if (result.captured > 0) ok(`Captured ${result.captured} grounding baseline(s)`);
  else info("No authored grounding baselines needed capture");

  const config = findConfig(projectRoot);
  let wiki: Awaited<ReturnType<typeof finalizeSetupWiki>>;
  try {
    wiki = await finalizeSetupWiki({
      projectRoot,
      scaffoldRoot: mexDir,
      exclude: config.wiki?.exclude,
      readOnly: config.wiki?.readOnly,
      signal: options.signal,
      onProgress: info,
      onWarning: warn,
    });
  } catch (error) {
    throwIfSetupAborted(options.signal);
    throw classifySetupMaintenanceError(error, "wiki") ?? error;
  }
  throwIfSetupAborted(options.signal);
  if (!wiki.ready) {
    const codes = [...new Set(wiki.diagnostics.map((entry) => entry.code))].join(", ");
    const suffix = codes.length === 0 ? "" : ` (${codes})`;
    const userMessage = setupWikiFailureMessage(wiki.stage, wiki.diagnostics);
    throw new SetupFinalizationError(`${wiki.reason ?? "Wiki setup did not finish."}${suffix} ${userMessage}`, { userMessage });
  }
  ok(`Wiki ready with ${wiki.indexedEntities} indexed entit${wiki.indexedEntities === 1 ? "y" : "ies"}`);
}

export function assertGroundingCaptureReady(result: GroundingBaselineCaptureResult): void {
  if (result.skipped > 0) {
    throw new Error(
      `${result.skipped} authored grounding reference${result.skipped === 1 ? "" : "s"} could not be verified against the code graph.`,
    );
  }
}
