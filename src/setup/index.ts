import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { execSync } from "node:child_process";
import crossSpawn from "cross-spawn";
import { stdin, stdout } from "node:process";
import { globSync } from "glob";
import chalk from "chalk";
import {
  buildFreshPrompt,
  buildExistingWithBriefPrompt,
  buildExistingNoBriefPrompt,
} from "./prompts.js";
import { saveAiTools, ensureScaffoldIdentity } from "../config.js";
import { isCliAvailable } from "../cli-tools.js";
import type { AiTool } from "../types.js";

// ── Constants ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = resolve(__dirname, "../templates");

const SOURCE_EXTENSIONS = [
  "*.py", "*.js", "*.ts", "*.tsx", "*.jsx", "*.go", "*.rs", "*.java",
  "*.kt", "*.swift", "*.rb", "*.php", "*.c", "*.cpp", "*.cs", "*.ex",
  "*.exs", "*.zig", "*.lua", "*.dart", "*.scala", "*.clj", "*.erl",
  "*.hs", "*.ml", "*.vue", "*.svelte",
];

const SCAFFOLD_FILES = [
  "ROUTER.md",
  "AGENTS.md",
  "SETUP.md",
  "SYNC.md",
  "context/architecture.md",
  "context/stack.md",
  "context/conventions.md",
  "context/decisions.md",
  "context/setup.md",
  "patterns/README.md",
  "patterns/INDEX.md",
];

const AGENT_MEMORY_FILES = [
  ...SCAFFOLD_FILES,
  "HEARTBEAT.md",
];

const TOOL_CONFIGS: Record<string, { src: string; dest: string }> = {
  "1": { src: ".tool-configs/CLAUDE.md", dest: "CLAUDE.md" },
  "2": { src: ".tool-configs/.cursorrules", dest: ".cursorrules" },
  "3": { src: ".tool-configs/.windsurfrules", dest: ".windsurfrules" },
  "4": { src: ".tool-configs/copilot-instructions.md", dest: ".github/copilot-instructions.md" },
  "5": { src: ".tool-configs/opencode.json", dest: ".opencode/opencode.json" },
  "6": { src: ".tool-configs/CLAUDE.md", dest: "AGENTS.md" },  // Codex reads AGENTS.md at root
};

// ── Helpers ──

const ok = (msg: string) => console.log(`${chalk.green("✓")} ${msg}`);
const info = (msg: string) => console.log(`${chalk.blue("→")} ${msg}`);
const warn = (msg: string) => console.log(`${chalk.yellow("!")} ${msg}`);
const header = (msg: string) => console.log(`\n${chalk.bold(msg)}`);

function findProjectRoot(): string {
  let current = resolve(process.cwd());
  while (true) {
    if (existsSync(resolve(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

function isTemplateContent(content: string): boolean {
  return content.includes("[Project Name]") || content.includes("[YYYY-MM-DD]");
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

type ProjectState = "existing" | "fresh" | "partial";

type SetupMode = "code-repo" | "agent-memory";

export async function runSetup(opts: { dryRun?: boolean; mode?: string } = {}): Promise<void> {
  const { dryRun = false } = opts;
  const mode = normalizeMode(opts.mode);

  banner();
  console.log();

  if (dryRun) {
    warn("DRY RUN — no files will be created or modified");
    console.log();
  }

  // Verify templates directory exists (sanity check for npm package integrity)
  if (!existsSync(TEMPLATES_DIR)) {
    throw new Error(
      `Templates directory not found at ${TEMPLATES_DIR}. The mex-agent package may be corrupted — try reinstalling.`
    );
  }

  const projectRoot = findProjectRoot();
  const mexDir = resolve(projectRoot, ".mex");

  // Guard: don't run inside the mex repo itself
  if (existsSync(resolve(projectRoot, "src", "setup", "index.ts"))) {
    const pkg = resolve(projectRoot, "package.json");
    if (existsSync(pkg)) {
      const pkgContent = readFileSync(pkg, "utf-8");
      if (pkgContent.includes('"promexeus"') || pkgContent.includes('"mex"')) {
        throw new Error(
          "You're inside the mex repository itself. Run this from your project root instead."
        );
      }
    }
  }

  // ── Step 1: Detect project state ──

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
        info("Detected: existing codebase with partially populated scaffold");
        info("Mode: will populate empty slots, skip what's already filled");
        break;
    }
  }
  console.log();

  // ── Step 2: Create .mex/ scaffold ──

  header("Creating .mex/ scaffold...");
  console.log();

  const scaffoldFiles = mode === "agent-memory" ? AGENT_MEMORY_FILES : SCAFFOLD_FILES;
  for (const file of scaffoldFiles) {
    const agentMemorySrc = resolve(TEMPLATES_DIR, "agent-memory", file);
    const src = mode === "agent-memory" && existsSync(agentMemorySrc)
      ? agentMemorySrc
      : resolve(TEMPLATES_DIR, file);
    const dest = resolve(mexDir, file);

    if (existsSync(dest)) {
      const existingContent = readFileSync(dest, "utf-8");
      const templateContent = readFileSync(src, "utf-8");

      // Skip if file has been populated (no longer matches template markers)
      if (!isTemplateContent(existingContent) && existingContent !== templateContent) {
        info(`Skipped .mex/${file} (already populated)`);
        continue;
      }
    }

    if (dryRun) {
      ok(`(dry run) Would copy .mex/${file}`);
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      ok(`Copied .mex/${file}`);
    }
  }
  console.log();

  // ── Step 3: Tool config selection ──

  let selectedClaude = false;

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    selectedClaude = await selectToolConfig(rl, projectRoot, dryRun);
  } finally {
    rl.close();
  }
  console.log();

  // Mint a stable scaffold identity. Independent of tool selection so a setup
  // that picks no AI tool still gets a scaffold_id written to config.json.
  if (!dryRun) {
    ensureScaffoldIdentity(mexDir, projectRoot);
  }

  // ── Step 4: Run scanner (if not fresh) ──

  let scannerBrief: string | null = null;

  if (mode !== "agent-memory" && state !== "fresh") {
    try {
      info("Scanning codebase...");
      const { runScan } = await import("../scanner/index.js");
      const config = { projectRoot, scaffoldRoot: mexDir, aiTools: [] as AiTool[] };
      const result = await runScan(config, { jsonOnly: true });
      scannerBrief = JSON.stringify(result, null, 2);
      ok("Pre-analysis complete — AI will reason from brief instead of exploring");
    } catch {
      warn("Scanner failed — AI will explore the filesystem directly");
    }
  }

  // Fresh installs get the additive code graph by default. A missing runtime,
  // grammar, or SQLite capability must never make scaffold setup unusable.
  if (mode === "code-repo" && !dryRun) {
    try {
      info("Building code graph...");
      const { createGraphEngine } = await import("../graph/index.js");
      const graph = createGraphEngine({ rootDir: projectRoot });
      try {
        await graph.build();
        ok("Code graph ready");
      } finally {
        graph.close();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`Code graph unavailable — setup will continue: ${message}`);
    }
  }

  // ── Step 5: Build population prompt ──

  let prompt: string;
  if (mode === "agent-memory") {
    const { buildAgentMemoryPrompt } = await import("./prompts.js");
    prompt = buildAgentMemoryPrompt();
  } else if (state === "fresh") {
    prompt = buildFreshPrompt();
  } else if (scannerBrief) {
    prompt = buildExistingWithBriefPrompt(scannerBrief);
  } else {
    prompt = buildExistingNoBriefPrompt();
  }

  // ── Step 6: Run or print ──

  if (dryRun) {
    header("Would run population prompt (dry run — skipping)");
    console.log();
    ok("Done (dry run).");
    return;
  }

  const hasClaude = hasClaudeCli();

  if (selectedClaude && hasClaude) {
    header("Launching Claude Code to populate the scaffold...");
    console.log();
    info("An interactive Claude Code session will open with the population prompt.");
    info("You'll see the agent working in real-time.");
    console.log();

    try {
      await launchClaude(prompt);
      console.log();
      ok("Setup complete.");
    } catch (err) {
      // A launch/exit failure must not crash setup with an unhandled
      // rejection — report it and fall back to the manual-paste prompt.
      console.log();
      warn(`Couldn't run Claude Code automatically: ${(err as Error).message}`);
      info("Paste the prompt below into your AI tool to populate the scaffold instead.");
      printPromptForManualPaste(prompt);
    }
    await promptGlobalInstall();
    return;
  } else {
    header("Almost done. One more step — populate the scaffold.");
    console.log();

    if (hasClaude) {
      info("You can run this directly with Claude Code:");
      console.log();
      console.log("  claude -p '<the prompt below>'");
      console.log();
      info("Or paste the prompt below into your AI tool.");
    } else {
      info("Paste the prompt below into your AI tool.");
      info("The agent will read your codebase and fill every scaffold file.");
    }

    printPromptForManualPaste(prompt);
  }

  await promptGlobalInstall();
}

function normalizeMode(raw: string | undefined): SetupMode {
  const mode = raw ?? "code-repo";
  if (mode === "code-repo" || mode === "agent-memory") return mode;
  throw new Error(`Unknown setup mode "${mode}". Use code-repo or agent-memory.`);
}

// ── Step functions ──

function detectProjectState(projectRoot: string, mexDir: string): ProjectState {
  // Check if scaffold is already partially populated
  const agentsMd = resolve(mexDir, "AGENTS.md");
  let scaffoldPopulated = false;
  if (existsSync(agentsMd)) {
    const content = readFileSync(agentsMd, "utf-8");
    if (!content.includes("[Project Name]")) {
      scaffoldPopulated = true;
    }
  }

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
  } else if (sourceFiles.length > 3) {
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
  dryRun: boolean,
): Promise<boolean> {
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

  let selectedClaude = false;
  const selectedTools: AiTool[] = [];

  const copyConfig = (key: string) => {
    const config = TOOL_CONFIGS[key];
    if (!config) return;

    if (key === "1") selectedClaude = true;
    const tool = TOOL_CHOICE_MAP[key];
    if (tool) selectedTools.push(tool);

    const src = resolve(TEMPLATES_DIR, config.src);
    const dest = resolve(projectRoot, config.dest);

    if (dryRun) {
      if (existsSync(dest)) {
        warn(`(dry run) Would overwrite ${config.dest}`);
      } else {
        ok(`(dry run) Would copy ${config.dest}`);
      }
      return;
    }

    if (existsSync(dest)) {
      // Can't ask interactively here since we already have rl,
      // so just warn and skip
      warn(`${config.dest} already exists — skipped (delete it first to replace)`);
      return;
    }

    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    ok(`Copied ${config.dest}`);
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

  // Persist tool selection
  if (selectedTools.length > 0 && !dryRun) {
    const mexDir = resolve(projectRoot, ".mex");
    saveAiTools(mexDir, selectedTools);
  }

  return selectedClaude;
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

function hasClaudeCli(): boolean {
  return isCliAvailable("claude");
}

function launchClaude(prompt: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // cross-spawn resolves the Windows `claude.cmd` wrapper and escapes the
    // prompt correctly. Plain spawn threw ENOENT on Windows (issue #85).
    const child = crossSpawn("claude", [prompt], {
      stdio: "inherit",
    });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Claude exited with code ${code}`));
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to launch Claude: ${err.message}`));
    });
  });
}

async function promptGlobalInstall(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    header("One more thing");
    console.log();
    info("Install mex globally so `mex check` works anywhere?");
    console.log();

    const answer = (await rl.question("  Install mex globally? [Y/n] ")).trim().toLowerCase();

    if (answer === "" || answer === "y" || answer === "yes") {
      console.log();
      info("Installing mex-agent globally...");
      try {
        execSync("npm install -g mex-agent", { stdio: "inherit" });
        console.log();
        ok("Installed globally. `mex check` and `mex sync` work from anywhere now.");
        printNextSteps(true);
      } catch {
        console.log();
        warn("Global install failed. You can retry manually:");
        console.log("    npm install -g mex-agent");
        console.log();
        printNextSteps(false);
      }
    } else {
      console.log();
      info("No problem. You can always install later:");
      console.log("    npm install -g mex-agent");
      console.log();
      printNextSteps(false);
    }
  } finally {
    rl.close();
  }
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
    console.log("    npx mex-agent check                Drift score — are scaffold files still accurate?");
    console.log("    npx mex-agent check --quiet        One-liner drift score");
    console.log("    npx mex-agent sync                 Fix drift — AI updates only what's broken");
    console.log("    npx mex-agent watch                Auto-check drift after every commit");
    console.log();
    info("Or install globally to use the shorter `mex` command:");
    console.log("    npm install -g mex-agent");
  }
  console.log();
}
