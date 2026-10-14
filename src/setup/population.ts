import { AgentPromptError, createAgentPromptSession } from "../agent-prompt.js";
import { isCliAvailable } from "../cli-tools.js";
import { runToolInteractive } from "../sync/index.js";
import { AI_TOOLS, type AiTool } from "../types.js";

export type SetupAgentTool = Extract<AiTool, "claude" | "codex">;

export interface SetupPopulationLaunchResult {
  tool: SetupAgentTool | null;
  /**
   * Selected agents whose CLI was probed and not found, in selection order. Agents after the
   * chosen one are never probed, so they are absent here; an empty list with `tool: null` means
   * no selected tool can run setup automatically.
   */
  unavailable: SetupAgentTool[];
  completed: boolean;
}

interface SetupPopulationDependencies {
  isAvailable?: (command: string) => boolean;
  run?: typeof runToolInteractive;
}

export class SetupPopulationError extends AgentPromptError {
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
  return pickSetupAgent(selectedTools, isAvailable).tool;
}

/**
 * Shared selection policy for both launchers: probe the selected agents in the user's order,
 * stop at the first available CLI, and keep the ones that were checked and missing.
 */
function pickSetupAgent(
  selectedTools: readonly AiTool[],
  isAvailable: (command: string) => boolean,
): { tool: SetupAgentTool | null; unavailable: SetupAgentTool[] } {
  const unavailable: SetupAgentTool[] = [];
  for (const { tool, command } of setupAgentCandidates(selectedTools)) {
    if (isAvailable(command)) return { tool, unavailable };
    unavailable.push(tool);
  }
  return { tool: null, unavailable };
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
  const { tool, unavailable } = pickSetupAgent(
    selectedTools,
    dependencies.isAvailable ?? isCliAvailable,
  );
  if (tool === null) return { tool: null, unavailable, completed: false };

  const session = createPopulationSession(prompt, projectRoot);
  try {
    const completed = (dependencies.run ?? runToolInteractive)(
      tool, session.instruction, session.root, { timeoutMs: null },
    );
    return { tool, unavailable, completed };
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
  const unavailable: SetupAgentTool[] = [];
  for (const candidate of setupAgentCandidates(selectedTools)) {
    if (await dependencies.isAvailable(candidate.command)) {
      tool = candidate.tool;
      break;
    }
    unavailable.push(candidate.tool);
  }
  if (tool === null) return { tool: null, unavailable, completed: false };
  const session = createPopulationSession(prompt, projectRoot);
  try {
    return {
      tool,
      unavailable,
      completed: await dependencies.run(tool, session.instruction, session.root),
    };
  } finally {
    session.cleanup();
  }
}

export function createPopulationSession(prompt: string, projectRoot: string): {
  root: string;
  instruction: string;
  cleanup: () => void;
} {
  try {
    return createAgentPromptSession(prompt, projectRoot, "setup-population");
  } catch (error) {
    throw new SetupPopulationError(error instanceof Error ? error.message : "Could not prepare the private setup population prompt.", { cause: error });
  }
}
