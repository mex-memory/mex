import { existsSync, readFileSync, mkdirSync, copyFileSync, lstatSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfiguredSetupMode, saveConfiguredSetupMode } from "../config.js";
import { ensureSetupIgnoreProtection, renderSetupIgnoreProtection, verifySetupIgnoreProtection } from "./ignore.js";
import { SetupError, classifySetupFileSystemError } from "./errors.js";
import { classifySetupMaintenanceError } from "./maintenance-errors.js";
import type { GraphMaintenanceProgress } from "../team/contracts/graph.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

export type ScaffoldFileAction = "copy" | "skip";

export function ensureScaffoldFile(src: string, dest: string, dryRun = false): ScaffoldFileAction {
  if (existsSync(dest)) return "skip";
  if (!dryRun) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
  return "copy";
}

/** Refuse to replace malformed or redirected canonical config during setup. */
export function verifyExistingSetupConfig(mexDir: string): void {
  const path = resolve(mexDir, "config.json");
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw classifySetupFileSystemError(error, "Could not inspect .mex/config.json.") ?? new SetupError(
      "Could not inspect existing .mex/config.json. Fix its permissions before rerunning setup.",
      { cause: error },
    );
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new SetupError("Existing .mex/config.json must be a regular file. Fix it before rerunning setup.");
  }
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    throw classifySetupFileSystemError(error, "Could not read .mex/config.json.") ?? error;
  }
  try {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
  } catch {
    throw new SetupError("Existing .mex/config.json is not a valid JSON object. Fix it before rerunning setup.");
  }
}

export type ProjectState = "existing" | "fresh" | "partial";

export type SetupMode = "code-repo" | "agent-memory";

/** Packaged templates directory used by both CLI setup and the Hub wizard. */
export function setupTemplatesDirectory(): string {
  const candidates = [
    resolve(__dirname, "../templates"),
    resolve(__dirname, "../../templates"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new SetupError(
    `Templates directory not found. Looked in:\n${candidates.map((path) => `  - ${path}`).join("\n")}\nThe mex-agent package may be corrupted — try reinstalling.`,
    { userMessage: "MEX setup templates are missing. Reinstall mex-agent, restart the Hub, then retry setup." },
  );
}

export function normalizeSetupMode(raw: string | undefined): SetupMode {
  const mode = raw ?? "code-repo";
  if (mode === "code-repo" || mode === "agent-memory") return mode;
  throw new SetupError(`Unknown setup mode "${mode}". Use code-repo or agent-memory.`, {
    userMessage: "The setup mode is not supported. Choose code-repo or agent-memory, then retry setup.",
  });
}

/** Explicit choices override persisted intent; a resume uses the original mode. */
export function resolveSetupMode(mexDir: string, requested?: string): SetupMode {
  return normalizeSetupMode(requested ?? loadConfiguredSetupMode(mexDir));
}

/** Shared scaffold phase; CLI and browser use identical preservation rules. */
export function createSetupScaffold(options: {
  projectRoot: string;
  mode: SetupMode;
  dryRun?: boolean;
  signal?: AbortSignal;
  onIgnore?: (message: string, changed: boolean) => void;
  onFile?: (file: string, action: ScaffoldFileAction) => void;
}): void {
  const { projectRoot, mode, dryRun = false } = options;
  const mexDir = resolve(projectRoot, ".mex");
  const templatesDir = setupTemplatesDirectory();
  throwIfSetupAborted(options.signal);
  const protection = ensureSetupIgnoreProtection({ projectRoot, dryRun });
  options.onIgnore?.(renderSetupIgnoreProtection(protection), protection.changed);
  if (mode === "code-repo" && !dryRun) verifySetupIgnoreProtection(projectRoot);
  verifyExistingSetupConfig(mexDir);
  for (const file of mode === "agent-memory" ? AGENT_MEMORY_FILES : SCAFFOLD_FILES) {
    throwIfSetupAborted(options.signal);
    const memorySource = resolve(templatesDir, "agent-memory", file);
    const source = mode === "agent-memory" && existsSync(memorySource)
      ? memorySource : resolve(templatesDir, file);
    let action: ScaffoldFileAction;
    try {
      action = ensureScaffoldFile(source, resolve(mexDir, file), dryRun);
    } catch (error) {
      throw classifySetupFileSystemError(error, `Could not create .mex/${file}.`) ?? error;
    }
    options.onFile?.(file, action);
  }
  if (!dryRun) {
    try {
      saveConfiguredSetupMode(mexDir, mode);
    } catch (error) {
      throw classifySetupFileSystemError(error, "Could not save the setup mode in .mex/config.json.") ?? error;
    }
  }
}

/** Scanner failure is optional: both transports fall back to filesystem discovery. */
export async function scanSetupCodebase(projectRoot: string, mexDir: string): Promise<string | null> {
  try {
    const { runScan } = await import("../scanner/index.js");
    const result = await runScan({ projectRoot, scaffoldRoot: mexDir, aiTools: [] }, { jsonOnly: true });
    return JSON.stringify(result, null, 2);
  } catch {
    return null;
  }
}

/** Browser builds use the existing isolated candidate path; publication stays guarded. */
export async function buildSetupGraph(projectRoot: string, options: {
  signal?: AbortSignal;
  background?: boolean;
  onProgress?: (progress: GraphMaintenanceProgress) => void;
} = {}): Promise<void> {
  throwIfSetupAborted(options.signal);
  try {
    const { rebuildGraph } = await import("../graph/maintenance.js");
    await rebuildGraph(projectRoot, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.background ? { candidateExecution: "process" as const } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
  } catch (error) {
    throwIfSetupAborted(options.signal);
    const expected = classifySetupMaintenanceError(error, "graph");
    if (expected) throw expected;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Code graph setup failed: ${message}. Fix the problem and rerun mex setup.`);
  }
}

export async function buildSetupPopulationPrompt(
  mode: SetupMode,
  state: ProjectState,
  scannerBrief: string | null,
): Promise<string> {
  const { buildAgentMemoryPrompt, buildFreshPrompt, buildExistingWithBriefPrompt, buildExistingNoBriefPrompt }
    = await import("./prompts.js");
  if (mode === "agent-memory") return buildAgentMemoryPrompt();
  if (state === "fresh") return buildFreshPrompt();
  return scannerBrief ? buildExistingWithBriefPrompt(scannerBrief) : buildExistingNoBriefPrompt();
}

export function throwIfSetupAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Setup was cancelled.");
}
