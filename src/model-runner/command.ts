import type { AgentCommand } from "../agent-command.js";
import { selectModel, type ModelAgent, type ModelSelection } from "./models.js";

export const MODEL_SYSTEM_PROMPT = "Perform the supplied MEX task only. Keep the result concise, use the supplied evidence, and do not start unrelated work.";
export interface ModelCommandOptions extends ModelSelection {
  access?: "text" | "workspace";
  allowNonGit?: boolean;
  allowedTools?: readonly string[];
  jsonSchema?: Record<string, unknown>;
}

/** Per-run flags only: never edits user config or replaces subscription credentials. */
export function buildModelCommand(agent: ModelAgent, instruction: string, options: ModelCommandOptions = {}): AgentCommand {
  const model = selectModel(agent, options);
  const workspace = options.access === "workspace";
  if (agent === "claude") return {
    command: agent,
    args: ["-p", ...(instruction ? [instruction] : []), "--safe-mode", "--no-session-persistence", "--model", model,
      "--system-prompt", MODEL_SYSTEM_PROMPT,
      ...(options.jsonSchema ? ["--json-schema", JSON.stringify(options.jsonSchema)] : []),
      ...(workspace ? ["--permission-mode", "acceptEdits", "--allowedTools", (options.allowedTools ?? []).join(",")] : ["--tools", ""]),
      "--output-format", options.jsonSchema ? "json" : "stream-json",
      ...(!options.jsonSchema ? ["--verbose", "--include-partial-messages"] : [])],
    env: { MEX_BACKGROUND: "1" },
  };
  return {
    command: agent,
    args: ["exec", "--json", "--ephemeral", "--disable", "hooks",
      "-c", "project_doc_max_bytes=0",
      "-c", "memories.generate_memories=false", "-c", "memories.use_memories=false",
      "--sandbox", workspace ? "workspace-write" : "read-only", "--model", model,
      ...(options.allowNonGit ? ["--skip-git-repo-check"] : []), instruction],
    env: { MEX_BACKGROUND: "1" },
  };
}
