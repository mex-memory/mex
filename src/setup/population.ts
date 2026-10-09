import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { isCliAvailable } from "../cli-tools.js";
import { runToolInteractive } from "../sync/index.js";
import { AI_TOOLS, type AiTool } from "../types.js";

export type SetupAgentTool = Extract<AiTool, "claude" | "codex">;

export interface SetupPopulationLaunchResult {
  tool: SetupAgentTool | null;
  completed: boolean;
}

interface SetupPopulationDependencies {
  isAvailable?: (command: string) => boolean;
  run?: typeof runToolInteractive;
}

export class SetupPopulationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SetupPopulationError";
  }
}

/** Use the user's selected order and never launch an unselected agent. */
export function selectSetupAgent(
  selectedTools: readonly AiTool[],
  isAvailable: (command: string) => boolean = isCliAvailable,
): SetupAgentTool | null {
  for (const { tool, command } of setupAgentCandidates(selectedTools)) {
    if (isAvailable(command)) return tool;
  }
  return null;
}

function* setupAgentCandidates(selectedTools: readonly AiTool[]): Generator<{ tool: SetupAgentTool; command: string }> {
  for (const tool of selectedTools) {
    if (tool !== "claude" && tool !== "codex") continue;
    const command = AI_TOOLS[tool].cli;
    if (command !== null) yield { tool, command };
  }
}

/** Launch first-time population with no sync timeout, from the project root. */
export function launchSetupPopulation(
  selectedTools: readonly AiTool[],
  prompt: string,
  projectRoot: string,
  dependencies: SetupPopulationDependencies = {},
): SetupPopulationLaunchResult {
  const tool = selectSetupAgent(selectedTools, dependencies.isAvailable);
  if (tool === null) return { tool: null, completed: false };

  const session = createPopulationSession(prompt, projectRoot);
  try {
    const completed = (dependencies.run ?? runToolInteractive)(
      tool, session.instruction, session.root, { timeoutMs: null },
    );
    return { tool, completed };
  } finally {
    session.cleanup();
  }
}

/** Keep the same private prompt alive until the background agent has closed. */
export async function launchSetupPopulationAsync(
  selectedTools: readonly AiTool[],
  prompt: string,
  projectRoot: string,
  dependencies: {
    isAvailable: (command: string) => Promise<boolean>;
    run: (tool: SetupAgentTool, instruction: string, cwd: string) => Promise<boolean>;
  },
): Promise<SetupPopulationLaunchResult> {
  // Resolve availability asynchronously, but retain the exact CLI selection policy.
  let tool: SetupAgentTool | null = null;
  for (const candidate of setupAgentCandidates(selectedTools)) {
    if (await dependencies.isAvailable(candidate.command)) {
      tool = candidate.tool;
      break;
    }
  }
  if (tool === null) return { tool: null, completed: false };
  const session = createPopulationSession(prompt, projectRoot);
  try {
    return { tool, completed: await dependencies.run(tool, session.instruction, session.root) };
  } finally {
    session.cleanup();
  }
}

export function createPopulationSession(prompt: string, projectRoot: string): {
  root: string;
  instruction: string;
  cleanup: () => void;
} {
  const root = resolve(projectRoot);
  const localDirectory = ensureLocalPopulationDirectory(root);
  let sessionDirectory: string;
  try {
    sessionDirectory = mkdtempSync(resolve(localDirectory, "setup-population-"));
  } catch (error) {
    throw new SetupPopulationError(
      `Could not create a private setup population prompt under ${localDirectory}.`,
      { cause: error },
    );
  }

  try {
    const promptPath = resolve(sessionDirectory, "prompt.md");
    writeFileSync(promptPath, prompt, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const pointer = relative(root, promptPath).replaceAll("\\", "/");
    const instruction = `Read the full setup population prompt from \`${pointer}\`, then follow it exactly.`;
    return { root, instruction, cleanup: () => rmSync(sessionDirectory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(sessionDirectory, { recursive: true, force: true });
    throw error;
  }
}

function ensureLocalPopulationDirectory(projectRoot: string): string {
  const mexDirectory = resolve(projectRoot, ".mex");
  requireRegularDirectory(mexDirectory, ".mex");

  const localDirectory = resolve(mexDirectory, "local");
  const localStats = lstatIfExists(localDirectory);
  if (localStats === null) {
    try {
      mkdirSync(localDirectory, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw new SetupPopulationError(
          `Could not create the setup population directory at ${localDirectory}.`,
          { cause: error },
        );
      }
    }
  }
  requireRegularDirectory(localDirectory, ".mex/local");
  return localDirectory;
}

function requireRegularDirectory(path: string, label: string): void {
  const stats = lstatIfExists(path);
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SetupPopulationError(
      `Cannot store the setup population prompt: ${label} at ${path} is not a regular directory.`,
    );
  }
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new SetupPopulationError(`Could not inspect setup population path ${path}.`, {
      cause: error,
    });
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "EEXIST";
}
