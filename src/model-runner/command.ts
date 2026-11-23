import type { AgentCommand } from "../agent-command.js";
import { selectModel, type ModelAgent, type ModelSelection } from "./models.js";

export const MODEL_SYSTEM_PROMPT = "Perform the supplied MEX task only. Keep the result concise, use the supplied evidence, and do not start unrelated work.";
export interface ModelCommandOptions extends ModelSelection {
  /** text: no tools (the default for MEX's own work); read: look, never change; workspace: edits allowed. */
  access?: "text" | "read" | "workspace";
  allowNonGit?: boolean;
  allowedTools?: readonly string[];
  /** Read access only: the most agent turns one call may take. */
  maxTurns?: number;
}

/** The only tools a read-only call gets: it can look through the checkout and change nothing. */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;
export const READ_ONLY_TURNS = 8;
export function readOnlyLimit(maxTurns = READ_ONLY_TURNS): number {
  return Math.max(1, Math.min(Number.isFinite(maxTurns) ? Math.trunc(maxTurns) : READ_ONLY_TURNS, 20));
}

/** Per-run flags only: never edits user config or replaces subscription credentials. */
export function buildModelCommand(agent: ModelAgent, instruction: string, options: ModelCommandOptions = {}): AgentCommand {
  const model = selectModel(agent, options);
  const workspace = options.access === "workspace";
  if (agent === "claude") return {
    command: agent,
    args: ["-p", ...(instruction ? [instruction] : []), "--safe-mode", "--no-session-persistence", "--model", model,
      "--system-prompt", MODEL_SYSTEM_PROMPT,
      ...(workspace ? ["--permission-mode", "acceptEdits", "--allowedTools", (options.allowedTools ?? []).join(",")]
        : options.access === "read" ? ["--tools", READ_ONLY_TOOLS.join(","), "--allowedTools", READ_ONLY_TOOLS.join(","),
          "--max-turns", String(readOnlyLimit(options.maxTurns))]
          : ["--tools", ""]),
      "--output-format", "stream-json", "--verbose", "--include-partial-messages"],
    env: { MEX_BACKGROUND: "1" },
  };
  return {
    command: agent,
    args: ["exec", "--json", "--ephemeral", "--disable", "hooks",
      "-c", "project_doc_max_bytes=0",
      "-c", "memories.generate_memories=false", "-c", "memories.use_memories=false",
      "--sandbox", workspace ? "workspace-write" : "read-only", "--model", model,
      ...(options.access === "read" ? ["--ignore-user-config", "-c", 'approval_policy="never"', "-c", 'web_search="disabled"', "-c", "mcp_servers={}"] : []),
      ...(options.allowNonGit ? ["--skip-git-repo-check"] : []), instruction],
    env: { MEX_BACKGROUND: "1" },
  };
}
