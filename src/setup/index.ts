import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { globSync } from "glob";
import chalk from "chalk";
import {
  saveAiTools,
  ensureScaffoldIdentity,
  findConfig,
  loadConfiguredAiTools,
  hasConfiguredAiTools,
  readScaffoldId,
} from "../config.js";
import {
  captureGroundingBaselines,
  type GroundingBaselineCaptureResult,
} from "../graph/runtime.js";
import { VERSION } from "../version.js";
import {
  renderInstructionChangePreview,
  syncAgentAssets,
  type AgentAssetsReport,
  type AgentSkillClient,
} from "../agent-skills/index.js";
import { AI_TOOLS, type AiTool } from "../types.js";
import { launchSetupPopulation } from "./population.js";
import {
  buildSetupPopulationPrompt,
  buildSetupGraph,
  createSetupScaffold,
  resolveSetupMode,
  scanSetupCodebase,
  setupTemplatesDirectory,
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
        ok(`(dry run) Would copy ${config.dest}`);
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

    const note = reportAnchor(config.dest, result, dryRun);
    if (note) notes.push(note);
  }

  return notes;
}

/** Print an anchor outcome; return a note for the ones the user must act on. */
function reportAnchor(dest: string, result: AnchorWriteResult, dry: boolean): string | null {
  const prefix = dry ? "(dry run) Would " : "";
  switch (result.outcome) {
    case "created":
      ok(`${prefix}${dry ? "copy" : "Copied"} ${dest}`);
      return null;
    case "appended":
      ok(`${prefix}${dry ? "add" : "Added"} a MEX pointer to your existing ${dest}`);
      return null;
    case "updated":
      ok(`${prefix}${dry ? "refresh" : "Refreshed"} the MEX pointer in ${dest}`);
      return null;
    case "already-linked":
      info(`${dest} already points at .mex/ — left unchanged`);
      return null;
    case "conflict": {
      const note =
        `${dest} was left untouched because ${result.reason}. `
        + "Add this line to it by hand so the scaffold is loaded: "
        + "`At the start of every session, read .mex/AGENTS.md and .mex/ROUTER.md.`";
      warn(note);
      return note;
    }
  }
}

// ── Helpers ──

const ok = (msg: string) => console.log(`${chalk.green("✓")} ${msg}`);
const info = (msg: string) => console.log(`${chalk.blue("→")} ${msg}`);
const warn = (msg: string) => console.log(`${chalk.yellow("!")} ${msg}`);
const header = (msg: string) => console.log(`\n${chalk.bold(msg)}`);

export function findSetupProjectRoot(startDir: string = process.cwd()): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(resolve(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

function findProjectRoot(): string {
  return findSetupProjectRoot();
}

function banner() {
  const GRN = "\x1b[38;2;91;140;90m";
  const DGR = "\x1b[38;2;74;122;73m";
  const ORN = "\x1b[38;2;232;132;92m";
  const DRK = "\x1b[38;2;61;61;61m";
  const ROYAL = "\x1b[38;2;25;68;241m";
  const NC = "\x1b[0m";
  const BOLD = "\x1b[1m";

  console.log();
  console.log(`${GRN}     ████      ${ROYAL}███╗   ███╗███████╗██╗  ██╗${NC}`);
  console.log(`${GRN}    █${DGR}█${GRN}██${DGR}█${GRN}█     ${ROYAL}████╗ ████║██╔════╝╚██╗██╔╝${NC}`);
  console.log(`${ORN}  ██████████   ${ROYAL}██╔████╔██║█████╗   ╚███╔╝${NC}`);
  console.log(`${ORN}█ ██${DRK}██${ORN}██${DRK}██${ORN}██ █ ${ROYAL}██║╚██╔╝██║██╔══╝   ██╔██╗${NC}`);
  console.log(`${ORN}█ ██████████ █ ${ROYAL}██║ ╚═╝ ██║███████╗██╔╝ ██╗${NC}`);
  console.log(`${ORN}   █ █  █ █    ${ROYAL}╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝${NC}`);
  console.log();
  console.log(`               ${BOLD}universal ai context scaffold${NC}`);
}

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

export async function runSetup(opts: { dryRun?: boolean; mode?: string } = {}): Promise<void> {
  const { dryRun = false } = opts;

  banner();
  console.log();

  if (dryRun) {
    warn("DRY RUN — no files will be created or modified");
    console.log();
  }

  const templatesDir = setupTemplatesDirectory();
  const projectRoot = findProjectRoot();
  const mexDir = resolve(projectRoot, ".mex");
  const mode = resolveSetupMode(mexDir, opts.mode);

  if (mode === "code-repo" && !existsSync(resolve(projectRoot, ".git"))) {
    throw new Error("No Git repository found. Run `git init` first, then rerun mex setup --cli.");
  }

  // ── Step 1: Detect project state ──

  const scaffoldPopulatedAtStart = isScaffoldPopulated(mexDir);
  const state = detectProjectState(projectRoot, mexDir);

  if (mode === "agent-memory") {
    info("Detected: agent-memory workspace");
    info("Mode: persistent-agent operational memory");
  } else {
    switch (state) {
      case "existing":
        info("Detected: existing codebase with source files");
        info("Mode: populate scaffold from code");
        break;
      case "fresh":
        info("Detected: fresh project (no source files yet)");
        info("Mode: populate scaffold from intent");
        break;
      case "partial":
        info("Detected: existing codebase with a populated scaffold");
        info("Mode: preserve authored files and finish setup readiness");
        break;
    }
  }
  console.log();

  // ── Step 2: Create .mex/ scaffold ──

  header("Creating .mex/ scaffold...");
  console.log();

  createSetupScaffold({
    projectRoot,
    mode,
    dryRun,
    onIgnore: (message, changed) => changed ? ok(message) : info(message),
    onFile: (file, action) => {
      if (action === "skip") info(`Skipped .mex/${file} (already exists)`);
      else ok(`${dryRun ? "(dry run) Would copy" : "Copied"} .mex/${file}`);
    },
  });
  console.log();

  // ── Step 3: Tool config selection ──

  let selectedTools: AiTool[] = [];
  let anchorNotes: string[] = [];

  // A persisted selection belongs to the scaffold even when population was
  // interrupted or the templates gained new required slots. Reuse it instead
  // of making a resumed setup ask the user the same question again.
  const configuredTools = loadConfiguredAiTools(mexDir);
  if (hasConfiguredAiTools(mexDir)) {
    selectedTools = configuredTools;
    // A scaffold orphaned by the old skip lands here, not in the menu
    // branch: it is populated and its aiTools are saved. Link on this path
    // too, or rerunning setup could never repair the installs that need it.
    anchorNotes = ensureToolAnchors(projectRoot, templatesDir, selectedTools, dryRun);
    info(`Using configured AI tools: ${selectedTools.map((tool) => AI_TOOLS[tool].name).join(", ") || "none"}`);
  } else {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const selection = await selectToolConfig(rl, projectRoot, templatesDir, dryRun);
      selectedTools = selection.tools;
      anchorNotes = selection.anchorNotes;
    } finally {
      rl.close();
    }
  }
  console.log();

  const selectedAgentClients = selectedTools.filter(
    (tool): tool is AgentSkillClient => tool === "claude" || tool === "codex",
  );
  if (selectedAgentClients.length > 0) {
    header("Installing official MEX agent skills...");
    console.log();
    const agentAssets = installSetupAgentAssets({
      projectRoot,
      selectedTools,
      dryRun,
      checkIgnored: mode === "code-repo",
    })!;
    renderAgentAssetsReport(agentAssets);
    console.log();
    const sessionSummary = `a new ${formatAgentClientList(agentAssets.clients)} session `
      + "to guarantee the new skills and project instructions are loaded.";
    if (agentAssets.conflicted) {
      throw new Error("Official MEX agent assets have conflicts. Resolve the warnings above and rerun setup or mex skills sync.");
    } else if (dryRun) {
      info(`After applying this setup, start ${sessionSummary}`);
    } else {
      info(`Start ${sessionSummary}`);
    }
    console.log();
  }

  // Mint a stable scaffold identity. Independent of tool selection so a setup
  // that picks no AI tool still gets a scaffold_id written to config.json.
  if (!dryRun) {
    const identity = ensureScaffoldIdentity(mexDir, projectRoot);
    if (readScaffoldId(mexDir) !== identity.scaffold_id) {
      throw new Error("Could not persist .mex/config.json. Fix its permissions or contents and rerun setup.");
    }
  }

  // ── Step 4: Run scanner (if not fresh) ──

  let scannerBrief: string | null = null;

  if (mode === "code-repo" && state !== "fresh") {
    info("Scanning codebase...");
    scannerBrief = await scanSetupCodebase(projectRoot, mexDir);
    if (scannerBrief) ok("Pre-analysis complete — AI will reason from brief instead of exploring");
    else warn("Scanner failed — AI will explore the filesystem directly");
  }

  if (mode === "code-repo" && !dryRun) {
    info("Building code graph...");
    await buildSetupGraph(projectRoot);
    ok("Code graph ready");
  }

  const prompt = await buildSetupPopulationPrompt(mode, state, scannerBrief);

  // ── Step 6: Run or print ──

  if (dryRun) {
    header("Would run population prompt (dry run — skipping)");
    console.log();
    ok("Done (dry run).");
    return;
  }

  let populationFinished = scaffoldPopulatedAtStart;
  if (populationFinished) {
    header("Finishing setup from the existing populated scaffold...");
    console.log();
  } else {
    header("Launching an agent to populate the scaffold...");
    console.log();
    info("The first selected available Claude Code or Codex CLI will run in the project root.");
    console.log();
    const launched = launchSetupPopulation(selectedTools, prompt, projectRoot);
    if (launched.completed) {
      ok(`${AI_TOOLS[launched.tool!].name} finished the population session`);
      populationFinished = isScaffoldPopulated(mexDir);
      if (!populationFinished) {
        warn("The agent exited successfully, but required scaffold placeholders remain.");
      }
    } else if (launched.tool !== null) {
      warn(`${AI_TOOLS[launched.tool].name} did not complete population.`);
    }
  }

  if (!populationFinished) {
    header("Almost done. One more step — populate the scaffold.");
    console.log();
    info("Paste the prompt below into your AI tool.");
    info("The agent will read your codebase and fill every scaffold file.");
    printPromptForManualPaste(prompt);
    populationFinished = await confirmPopulationFinished(mexDir);
  }

  if (!populationFinished || !isScaffoldPopulated(mexDir)) {
    console.log();
    info("Setup paused at population. After the agent finishes, rerun `mex setup --cli` to finalize Graph and Wiki readiness.");
    // The anchors were written before population, so an unlinked one is just
    // as true on this path -- and this is the last output the user sees.
    printAnchorNotes(anchorNotes);
    return;
  }

  if (mode === "code-repo") {
    await finalizeCodeRepoSetup(projectRoot, mexDir);
    console.log();
    ok("Graph and Wiki are ready. Setup is ready to commit.");
    printCommitCheckpoint(selectedTools);
  } else {
    console.log();
    ok("Setup complete.");
  }

  printAnchorNotes(anchorNotes);
  await promptGlobalInstall();
  if (process.exitCode === 130 || process.exitCode === 143) return;
  await promptSetupContact();
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

async function selectToolConfig(
  rl: ReturnType<typeof createInterface>,
  projectRoot: string,
  templatesDir: string,
  dryRun: boolean,
): Promise<{ tools: AiTool[]; anchorNotes: string[] }> {
  header("Which AI tool do you use?");
  console.log();
  console.log("  1) Claude Code");
  console.log("  2) Cursor");
  console.log("  3) Windsurf");
  console.log("  4) GitHub Copilot");
  console.log("  5) OpenCode");
  console.log("  6) Codex (OpenAI)");
  console.log("  7) Multiple (select next)");
  console.log("  8) None / skip");
  console.log();

  const choice = (await rl.question("Choice [1-8] (default: 1): ")).trim() || "1";

  const selectedTools: AiTool[] = [];

  const copyConfig = (key: string) => {
    const tool = TOOL_CHOICE_MAP[key];
    if (!tool) return;
    selectedTools.push(tool);
  };

  switch (choice) {
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
    case "6":
      copyConfig(choice);
      break;
    case "7": {
      const multi = (await rl.question("Enter tool numbers separated by spaces (e.g. 1 2 5): ")).trim();
      for (const c of multi.split(/\s+/)) {
        copyConfig(c);
      }
      break;
    }
    case "8":
      info("Skipped tool config — AGENTS.md in .mex/ works with any tool that can read files");
      break;
    default:
      warn("Unknown choice, skipping tool config");
      break;
  }

  const anchorNotes = ensureToolAnchors(projectRoot, templatesDir, selectedTools, dryRun);

  // Persist tool selection
  if (!dryRun) {
    const mexDir = resolve(projectRoot, ".mex");
    saveAiTools(mexDir, selectedTools);
  }

  return { tools: [...new Set(selectedTools)], anchorNotes };
}

function renderAgentAssetsReport(report: AgentAssetsReport): void {
  for (const action of report.actions) {
    if (action.action === "conflict") continue;
    if (action.action === "noop") info(action.message);
    else ok(action.message);
    if (report.dryRun) {
      const preview = renderInstructionChangePreview(action);
      if (preview !== null) console.log(preview);
    }
  }
  for (const warning of report.warnings) {
    warn(warning.message);
    if (warning.resolution) info(warning.resolution);
  }
}

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

function formatAgentClientList(clients: readonly AgentSkillClient[]): string {
  const labels = [...new Set(clients)].map((client) => (
    client === "claude" ? "Claude Code" : "Codex"
  ));
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

function printPromptForManualPaste(prompt: string): void {
  console.log();
  console.log("─────────────────── COPY BELOW THIS LINE ───────────────────");
  console.log();
  console.log(prompt);
  console.log();
  console.log("─────────────────── COPY ABOVE THIS LINE ───────────────────");
  console.log();
  ok("Paste the prompt above into your agent to populate the scaffold.");
}

async function confirmPopulationFinished(mexDir: string): Promise<boolean> {
  if (!stdin.isTTY) return false;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log();
    info("After the agent finishes populating, return here to finish setup.");
    const answer = (await rl.question("  Has population finished? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") return false;
    if (!isScaffoldPopulated(mexDir)) {
      warn("Required placeholders remain in the .mex scaffold files.");
      return false;
    }
    return true;
  } finally {
    rl.close();
  }
}

/**
 * A finalization failure whose message is composed here from MEX-authored text,
 * relative scaffold paths, and scaffold-authored node ids — never from arbitrary
 * exceptions — so the Hub may show it instead of a generic failure.
 */
export class SetupFinalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupFinalizationError";
  }
}

// Keeps the composed message inside the Hub's 512-character run error.
const FINALIZATION_DETAIL_LIMIT = 2;
const FINALIZATION_DETAIL_CHARS = 140;

export async function finalizeCodeRepoSetup(projectRoot: string, mexDir: string): Promise<void> {
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
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Grounding finalization failed: ${message}. Rerun mex setup after fixing it.`);
  }
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
  const wiki = await finalizeSetupWiki({
    projectRoot,
    scaffoldRoot: mexDir,
    exclude: config.wiki?.exclude,
    readOnly: config.wiki?.readOnly,
    onProgress: info,
    onWarning: warn,
  });
  if (!wiki.ready) {
    const codes = [...new Set(wiki.diagnostics.map((entry) => entry.code))].join(", ");
    const suffix = codes.length === 0 ? "" : ` (${codes})`;
    throw new SetupFinalizationError(`${wiki.reason ?? "Wiki setup did not finish."}${suffix} Fix the issue and rerun mex setup --cli.`);
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

/**
 * Repeat anchors that could not be linked automatically.
 *
 * The warning at the moment of the decision scrolls past behind population
 * output and the readiness report, and the whole failure mode of #106 is that
 * the user never learns the scaffold is not being loaded. Saying it again at
 * the end is the last point where it is still in front of them.
 */
function printAnchorNotes(notes: readonly string[]): void {
  if (notes.length === 0) return;
  console.log();
  header("Action needed: these files do not point at the scaffold yet");
  console.log();
  for (const note of notes) warn(note);
  console.log();
  info("Until one always-loaded file names `.mex/`, your agent will not read the scaffold.");
  info("Run `mex check` after fixing them to confirm.");
}

function printCommitCheckpoint(selectedTools: readonly AiTool[]): void {
  header("Commit the canonical MEX setup before opening Hub");
  console.log();
  info("Review the scoped files, then commit them. MEX will not stage or commit automatically.");
  for (const command of setupCommitCheckpointCommands(selectedTools)) {
    console.log(`    ${command}`);
  }
  console.log();
  info("After that commit, start Hub with `mex hub` (or `npx mex-agent hub`).");
}

async function promptGlobalInstall(): Promise<void> {
  if (!stdin.isTTY) {
    printNextSteps(false);
    return;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    header("One more thing");
    console.log();
    info("Install mex globally so `mex check` works anywhere?");
    console.log();

    const answer = (await rl.question("  Install mex globally? [y/N] ")).trim().toLowerCase();

    if (answer === "y" || answer === "yes") {
      console.log();
      info("Installing mex-agent globally...");
      try {
        const { SetupGlobalInstaller } = await import("./global-install.js");
        const installer = new SetupGlobalInstaller();
        const interrupt = () => { process.exitCode = 130; void installer.shutdown(); };
        const terminate = () => { process.exitCode = 143; void installer.shutdown(); };
        process.once("SIGINT", interrupt);
        process.once("SIGTERM", terminate);
        let result;
        try { installer.start(); result = await installer.wait(); }
        finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); }
        if (result.state !== "succeeded") throw new Error(result.message);
        console.log();
        ok(result.message);
        printNextSteps(true);
      } catch {
        console.log();
        warn("Global install failed. You can retry manually:");
        console.log(`    npm install -g mex-agent@${VERSION}`);
        console.log();
        printNextSteps(false);
      }
    } else {
      console.log();
      info("No problem. You can always install later:");
      console.log(`    npm install -g mex-agent@${VERSION}`);
      console.log();
      printNextSteps(false);
    }
  } finally {
    rl.close();
  }
}

async function promptSetupContact(): Promise<void> {
  if (!stdin.isTTY) return;
  const { readContactPreference, rememberContactPreference, submitSetupContact } = await import("./contact.js");
  if (readContactPreference().status !== "unasked") return;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    header("Help shape MEX (optional)");
    info("Leave your email if we may follow up about your experience with MEX. Your details are sent through Web3Forms, separately from usage telemetry.");
    const answer = (await rl.question("  May we contact you? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      await rememberContactPreference({ status: "skipped" });
      return;
    }
    const email = (await rl.question("  Email (leave empty to skip): ")).trim();
    if (!email) { await rememberContactPreference({ status: "skipped" }); return; }
    const name = (await rl.question("  Name (optional): ")).trim();
    const { SetupContactRequestSchema } = await import("@mex/hub-contracts/setup");
    const parsed = SetupContactRequestSchema.safeParse({ email, name });
    if (!parsed.success) { warn("The contact details were not valid, so nothing was sent. Setup is complete."); return; }
    const result = await submitSetupContact(parsed.data);
    if (result.ok) ok(result.message); else warn(result.message);
  } catch {
    warn("The optional contact step could not finish. Setup is complete; you can continue using MEX.");
  } finally { rl.close(); }
}

function printNextSteps(globalInstalled: boolean) {
  header("What's next");
  console.log();
  info("Verify — start a fresh session and ask:");
  console.log('    "Read .mex/ROUTER.md and tell me what you know about this project."');
  console.log();

  if (globalInstalled) {
    info("Ongoing commands:");
    console.log("    mex check              Drift score — are scaffold files still accurate?");
    console.log("    mex check --quiet      One-liner drift score");
    console.log("    mex sync               Fix drift — AI updates only what's broken");
    console.log("    mex watch              Auto-check drift after every commit");
  } else {
    info("Ongoing commands (via npx):");
    console.log(`    npx mex-agent@${VERSION} check                Drift score — are scaffold files still accurate?`);
    console.log(`    npx mex-agent@${VERSION} check --quiet        One-liner drift score`);
    console.log(`    npx mex-agent@${VERSION} sync                 Fix drift — AI updates only what's broken`);
    console.log(`    npx mex-agent@${VERSION} watch                Auto-check drift after every commit`);
    console.log();
    info("Or install globally to use the shorter `mex` command:");
    console.log(`    npm install -g mex-agent@${VERSION}`);
  }
  console.log();
}
