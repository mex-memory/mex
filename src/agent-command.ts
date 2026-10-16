import { AI_TOOLS, type AiTool } from "./types.js";

export interface AgentCommand {
  readonly command: string;
  readonly args: string[];
}

/**
 * Headless Claude has no one to answer approval prompts, so every shell command
 * the population prompt relies on must be pre-approved or it is denied. The
 * read-only graph commands and the event log are allowed, plus the two Wiki
 * writes the prompt tells the agent to run itself: `mex wiki apply` (one
 * create-entry operation per code-linked claim) and `mex wiki link-sections`
 * (structural links). Without them the agent can stage operation files but
 * nothing applies them. Maintenance and Team commands still require a person.
 * Claude already auto-approves read-only Git history commands such as `git log`.
 */
export const HEADLESS_CLAUDE_MEX_COMMANDS = [
  "mex graph scope",
  "mex graph get",
  "mex graph query",
  "mex graph status",
  "mex wiki query",
  "mex wiki apply",
  "mex wiki link-sections",
  "mex impact",
  "mex logging",
  "mex log",
  "mex timeline",
  "mex capabilities",
] as const;

/** Whether a `mex ...` command line starts with a pre-approved headless command. */
export function isHeadlessClaudeMexCommandAllowed(commandLine: string): boolean {
  const words = commandLine.trim().split(/\s+/);
  return HEADLESS_CLAUDE_MEX_COMMANDS.some((command) =>
    command.split(" ").every((word, index) => words[index] === word));
}

/** Windows sessions may run commands through PowerShell rather than Bash. */
export const HEADLESS_CLAUDE_ALLOWED_TOOLS = HEADLESS_CLAUDE_MEX_COMMANDS.flatMap((command) => [
  `Bash(${command}:*)`,
  `PowerShell(${command}:*)`,
]);

/** Terminal and browser adapters share tool support and argument construction. */
export function buildAgentCommand(
  tool: AiTool,
  instruction: string,
  mode: "interactive" | "headless",
  options: { allowNonGit?: boolean } = {},
): AgentCommand | null {
  const meta = AI_TOOLS[tool];
  if (meta.cli === null) return null;
  if (mode === "headless" && tool === "claude") {
    return {
      command: meta.cli,
      args: [
        "-p", instruction, "--permission-mode", "acceptEdits",
        "--allowedTools", HEADLESS_CLAUDE_ALLOWED_TOOLS.join(","),
        "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      ],
    };
  }
  if (mode === "headless" && tool === "codex") {
    // `exec` is non-interactive and defaults to never asking for approval.
    // Keep workspace confinement without the removed `--full-auto` shorthand.
    return {
      command: meta.cli,
      args: ["exec", "--json", "--sandbox", "workspace-write", ...(options.allowNonGit ? ["--skip-git-repo-check"] : []), instruction],
    };
  }
  return { command: meta.cli, args: [...meta.promptFlag, instruction] };
}
