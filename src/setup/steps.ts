// ============================================================================
// Headless setup steps
// ============================================================================
//
// `runSetup` in ./index.ts is the interactive CLI wizard: readline prompts,
// chalk output, spawning an agent CLI. None of that is reusable from a server.
//
// This module holds the parts of setup that actually touch disk — template
// resolution, project-state detection, scaffold copying, tool-config copying,
// population-prompt selection — as plain functions that return results instead
// of printing them. Both the CLI wizard and the web UI drive these, so setup
// logic lives in exactly one place.

import { existsSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "glob";
import {
  buildFreshPrompt,
  buildExistingWithBriefPrompt,
  buildExistingNoBriefPrompt,
  buildAgentMemoryPrompt,
} from "./prompts.js";
import type { AiTool } from "../types.js";

/** Directory holding this module at runtime (`src/setup/` or `dist/`). */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the shipped `templates/` directory.
 *
 * tsup inlines this module into `dist/cli.js`, so at runtime HERE is either
 * `dist/` (packaged — templates sit one level up at the package root) or
 * `src/setup/` (source/tests — templates sit two levels up at the repo root).
 * Probing both makes the same lookup resolve in either layout.
 */
export function templatesDir(): string {
  const candidates = [
    resolve(HERE, "../templates"), // dist/../templates  (packaged)
    resolve(HERE, "../../templates"), // src/setup/../../templates  (source)
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Templates directory not found. Looked in:\n` +
      candidates.map((c) => `  - ${c}`).join("\n") +
      `\nThe mex-agent package may be corrupted — try reinstalling.`,
  );
}

export type ProjectState = "existing" | "fresh" | "partial";

export type SetupMode = "code-repo" | "agent-memory";

const SOURCE_EXTENSIONS = [
  "*.py", "*.js", "*.ts", "*.tsx", "*.jsx", "*.go", "*.rs", "*.java",
  "*.kt", "*.swift", "*.rb", "*.php", "*.c", "*.cpp", "*.cs", "*.ex",
  "*.exs", "*.zig", "*.lua", "*.dart", "*.scala", "*.clj", "*.erl",
  "*.hs", "*.ml", "*.vue", "*.svelte",
];

export const SCAFFOLD_FILES = [
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

export const AGENT_MEMORY_FILES = [
  ...SCAFFOLD_FILES,
  "HEARTBEAT.md",
];

export function scaffoldFilesForMode(mode: SetupMode): string[] {
  return mode === "agent-memory" ? AGENT_MEMORY_FILES : SCAFFOLD_FILES;
}

/** Template source → destination (relative to the project root) per AI tool. */
export const TOOL_CONFIGS: Record<AiTool, { src: string; dest: string }> = {
  claude: { src: ".tool-configs/CLAUDE.md", dest: "CLAUDE.md" },
  cursor: { src: ".tool-configs/.cursorrules", dest: ".cursorrules" },
  windsurf: { src: ".tool-configs/.windsurfrules", dest: ".windsurfrules" },
  copilot: { src: ".tool-configs/copilot-instructions.md", dest: ".github/copilot-instructions.md" },
  opencode: { src: ".tool-configs/opencode.json", dest: ".opencode/opencode.json" },
  // Codex reads AGENTS.md at the project root.
  codex: { src: ".tool-configs/CLAUDE.md", dest: "AGENTS.md" },
};

export function normalizeMode(raw: string | undefined): SetupMode {
  const mode = raw ?? "code-repo";
  if (mode === "code-repo" || mode === "agent-memory") return mode;
  throw new Error(`Unknown setup mode "${mode}". Use code-repo or agent-memory.`);
}

/** Walk up from `startDir` looking for `.git`, falling back to `startDir`. */
export function findProjectRoot(startDir: string = process.cwd()): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(resolve(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

function isTemplateContent(content: string): boolean {
  return content.includes("[Project Name]") || content.includes("[YYYY-MM-DD]");
}

/**
 * Throw when `projectRoot` is a checkout of mex itself. Scaffolding mex with
 * mex would overwrite the very templates setup reads from.
 */
export function assertNotMexRepo(projectRoot: string): void {
  if (!existsSync(resolve(projectRoot, "src", "setup", "index.ts"))) return;
  const pkg = resolve(projectRoot, "package.json");
  if (!existsSync(pkg)) return;
  const pkgContent = readFileSync(pkg, "utf-8");
  if (pkgContent.includes('"promexeus"') || pkgContent.includes('"mex"')) {
    throw new Error(
      "You're inside the mex repository itself. Run this from your project root instead.",
    );
  }
}

/**
 * Classify a project so setup knows whether the agent should populate the
 * scaffold from existing code, from stated intent, or fill only empty slots.
 */
export function detectProjectState(projectRoot: string, mexDir: string): ProjectState {
  const agentsMd = resolve(mexDir, "AGENTS.md");
  let scaffoldPopulated = false;
  if (existsSync(agentsMd)) {
    const content = readFileSync(agentsMd, "utf-8");
    if (!content.includes("[Project Name]")) {
      scaffoldPopulated = true;
    }
  }

  const sourceFiles = globSync(
    SOURCE_EXTENSIONS.map((ext) => `**/${ext}`),
    {
      cwd: projectRoot,
      ignore: ["**/node_modules/**", "**/.mex/**", "**/vendor/**", "**/.git/**"],
      maxDepth: 4,
      nodir: true,
    },
  );

  if (scaffoldPopulated && sourceFiles.length > 0) return "partial";
  if (sourceFiles.length > 3) return "existing";
  return "fresh";
}

export interface ScaffoldFileResult {
  /** Scaffold-relative path, e.g. `context/stack.md`. */
  file: string;
  /** `copied` wrote the template; `skipped` left a populated file alone. */
  action: "copied" | "skipped" | "would-copy";
}

export interface WriteScaffoldOptions {
  projectRoot: string;
  mode: SetupMode;
  dryRun?: boolean;
}

/**
 * Copy the template scaffold into `<projectRoot>/.mex/`, leaving any file that
 * has already been populated untouched. Idempotent: re-running setup never
 * clobbers real content.
 */
export function writeScaffold(options: WriteScaffoldOptions): ScaffoldFileResult[] {
  const { projectRoot, mode, dryRun = false } = options;
  const templates = templatesDir();
  const mexDir = resolve(projectRoot, ".mex");
  const results: ScaffoldFileResult[] = [];

  for (const file of scaffoldFilesForMode(mode)) {
    const agentMemorySrc = resolve(templates, "agent-memory", file);
    const src = mode === "agent-memory" && existsSync(agentMemorySrc)
      ? agentMemorySrc
      : resolve(templates, file);
    const dest = resolve(mexDir, file);

    if (existsSync(dest)) {
      const existingContent = readFileSync(dest, "utf-8");
      const templateContent = readFileSync(src, "utf-8");
      if (!isTemplateContent(existingContent) && existingContent !== templateContent) {
        results.push({ file, action: "skipped" });
        continue;
      }
    }

    if (dryRun) {
      results.push({ file, action: "would-copy" });
      continue;
    }

    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    results.push({ file, action: "copied" });
  }

  return results;
}

export interface ToolConfigResult {
  tool: AiTool;
  /** Project-relative destination, e.g. `CLAUDE.md`. */
  dest: string;
  /** `exists` means a file was already there and was left alone. */
  action: "copied" | "exists" | "would-copy" | "would-overwrite";
}

export interface WriteToolConfigsOptions {
  projectRoot: string;
  tools: readonly AiTool[];
  dryRun?: boolean;
}

/**
 * Copy the per-tool instruction files (CLAUDE.md, .cursorrules, …) into the
 * project root. Never overwrites an existing file — a hand-written CLAUDE.md is
 * more valuable than the template.
 */
export function writeToolConfigs(options: WriteToolConfigsOptions): ToolConfigResult[] {
  const { projectRoot, tools, dryRun = false } = options;
  if (tools.length === 0) return [];
  const templates = templatesDir();
  const results: ToolConfigResult[] = [];

  for (const tool of [...new Set(tools)]) {
    const config = TOOL_CONFIGS[tool];
    if (!config) continue;
    const src = resolve(templates, config.src);
    const dest = resolve(projectRoot, config.dest);

    if (dryRun) {
      results.push({
        tool,
        dest: config.dest,
        action: existsSync(dest) ? "would-overwrite" : "would-copy",
      });
      continue;
    }

    if (existsSync(dest)) {
      results.push({ tool, dest: config.dest, action: "exists" });
      continue;
    }

    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    results.push({ tool, dest: config.dest, action: "copied" });
  }

  return results;
}

export interface PopulationPromptInput {
  mode: SetupMode;
  state: ProjectState;
  /** Serialized scanner brief, when pre-analysis succeeded. */
  scannerBrief?: string | null;
}

/**
 * Pick the population prompt that matches how much the agent already knows:
 * a scanner brief beats filesystem exploration, and a fresh project has no
 * code to read at all.
 */
export function buildPopulationPrompt(input: PopulationPromptInput): string {
  if (input.mode === "agent-memory") return buildAgentMemoryPrompt();
  if (input.state === "fresh") return buildFreshPrompt();
  if (input.scannerBrief) return buildExistingWithBriefPrompt(input.scannerBrief);
  return buildExistingNoBriefPrompt();
}
