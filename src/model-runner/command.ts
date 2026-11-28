import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import type { AgentCommand } from "../agent-command.js";
import { LEAN_CODEX_FEATURES } from "./codex-features.js";
import { selectModel, type ModelAgent, type ModelSelection } from "./models.js";

export const MODEL_SYSTEM_PROMPT = "Perform the supplied MEX task only. Keep the result concise, use the supplied evidence, and do not start unrelated work.";
export interface ModelCommandOptions extends ModelSelection {
  /** text: no tools (the default for MEX's own work); read: look, never change; workspace: edits allowed. */
  access?: "text" | "read" | "workspace";
  allowNonGit?: boolean;
  /** Use only the supplied evidence for a Codex text judgment. Login credentials still apply. */
  isolatedText?: boolean;
  allowedTools?: readonly string[];
  /** The installed Codex's feature names, when known: text calls then also drop the tools those features add. */
  codexFeatures?: ReadonlySet<string>;
  /** Read access only: the most agent turns one call may take. */
  maxTurns?: number;
}

/**
 * Codex sends its own agent instructions, permission notes and environment context with every call: about
 * 10K tokens before the task. A text judgment needs only MEX's one line, as Claude Code gets.
 */
function codexInstructionsFile(): string {
  const file = join(tmpdir(), `mex-model-instructions-${createHash("sha256").update(MODEL_SYSTEM_PROMPT).digest("hex").slice(0, 12)}.md`);
  if (!existsSync(file)) {
    try { writeFileSync(file, MODEL_SYSTEM_PROMPT, { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  return file.replaceAll(win32.sep, posix.sep);
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
  const isolatedText = options.isolatedText && !workspace && options.access !== "read";
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
  if (agent === "gemini") return {
    command: agent,
    args: ["--prompt", MODEL_SYSTEM_PROMPT, "--output-format", "json", "--approval-mode", "plan", "--model", model],
  };
  if (agent === "copilot") return {
    command: agent,
    args: ["--prompt", instruction, "--output-format=json", "--available-tools=view", "--allow-tool=read",
      "--no-ask-user", "--no-custom-instructions", "--no-auto-update", "--no-bash-env", "--disallow-temp-dir", "--disable-builtin-mcps",
      "--disable-mcp-server=computer-use", ...(model === "default" ? [] : ["--model", model])],
  };
  return {
    command: agent,
    args: ["exec", "--json", "--ephemeral", "--disable", "hooks",
      "-c", "project_doc_max_bytes=0",
      "-c", "memories.generate_memories=false", "-c", "memories.use_memories=false",
      "--sandbox", workspace ? "workspace-write" : "read-only", "--model", model,
      ...(options.access === "read" || isolatedText ? ["--ignore-user-config", "-c", 'approval_policy="never"', "-c", 'web_search="disabled"', "-c", "mcp_servers={}"] : []),
      ...(isolatedText ? ["--ignore-rules", "--disable", "shell_tool", "--disable", "apps", "--disable", "plugins",
        "--disable", "multi_agent", "--disable", "multi_agent_v2", "--disable", "memories",
        "-c", `model_instructions_file=${JSON.stringify(codexInstructionsFile())}`, "-c", "include_permissions_instructions=false",
        "-c", "include_environment_context=false", "-c", "include_apps_instructions=false",
        "-c", "include_collaboration_mode_instructions=false",
        // A Codex that lists its features is recent enough for these keys: no agent team and no skills text.
        ...(options.codexFeatures ? ["-c", "agents.enabled=false", "-c", "skills.include_instructions=false",
          ...LEAN_CODEX_FEATURES.filter(name => options.codexFeatures!.has(name)).flatMap(name => ["--disable", name])] : [])] : []),
      ...(options.allowNonGit ? ["--skip-git-repo-check"] : []), instruction],
    env: { MEX_BACKGROUND: "1" },
  };
}
