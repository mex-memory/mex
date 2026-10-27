import { AI_TOOLS, type AiTool } from "./types.js";

export interface AgentCommand {
  readonly command: string;
  readonly args: string[];
  /** Extra environment for the child, on top of the parent's. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The agents MEX can run as a background (non-interactive) setup session, with
 * the CLI each vendor ships. Windsurf has no such CLI.
 *
 * Vendor documentation each adapter follows (flags not stated there are never used):
 * - Cursor CLI: https://cursor.com/docs/cli/headless, https://cursor.com/docs/cli/reference/parameters,
 *   https://cursor.com/docs/cli/reference/output-format, https://cursor.com/docs/cli/reference/permissions
 * - GitHub Copilot CLI: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference,
 *   https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools
 * - OpenCode: https://opencode.ai/docs/cli/, https://opencode.ai/docs/agents/, https://opencode.ai/docs/permissions/,
 *   https://opencode.ai/docs/config/
 */
export const BACKGROUND_AGENT_CLIS = {
  claude: "claude",
  codex: "codex",
  // The Cursor CLI's documented command is `agent`.
  cursor: "agent",
  copilot: "copilot",
  opencode: "opencode",
} as const satisfies Partial<Record<AiTool, string>>;

export type BackgroundAgentTool = keyof typeof BACKGROUND_AGENT_CLIS;

export function isBackgroundAgentTool(tool: string): tool is BackgroundAgentTool {
  return Object.hasOwn(BACKGROUND_AGENT_CLIS, tool);
}

/**
 * Agents whose background session may run the pre-approved `mex` commands
 * below (the single population session and the finalize repair turn need
 * them). The others can be restricted only to file tools with no shell at all,
 * so MEX gives them only the units that run no command: the shared files, one
 * subsystem, a batch fix and the final pass.
 */
export const COMMAND_CAPABLE_AGENTS: ReadonlySet<BackgroundAgentTool> = new Set(["claude", "codex"]);

/**
 * Cursor reads permissions only from a config file: the project's
 * `.cursor/cli.json` (or the user's global one, which MEX never touches).
 * MEX writes this exact file for the session when the project has none and
 * removes it afterwards. Deny rules win over allow rules, so the session can
 * write only under `.mex/` and runs no shell command, web fetch or MCP tool.
 * `--force` is never passed: it allows everything not denied, outside the
 * project too.
 */
export const CURSOR_PERMISSIONS_FILE = ".cursor/cli.json";
export const CURSOR_SESSION_PERMISSIONS = {
  permissions: {
    allow: ["Write(.mex/**)"],
    deny: ["Shell(*)", "WebFetch(*)", "Mcp(*:*)"],
  },
} as const;

/** The exact bytes MEX writes, so it can recognize (and remove) only its own file. */
export function cursorSessionPermissionsText(): string {
  return `${JSON.stringify(CURSOR_SESSION_PERMISSIONS, null, 2)}\n`;
}

/** The agent MEX defines for an OpenCode setup session, through OpenCode's inline config. */
export const OPENCODE_SETUP_AGENT = "mex-setup";

/**
 * OpenCode permissions for the setup agent: deny everything first, then allow
 * reading, searching and editing (the last matching rule wins). Agent rules
 * take precedence over the user's global ones; `external_directory` stays
 * denied, so edits stay inside the project. No shell, web or subagents.
 */
export const OPENCODE_SETUP_PERMISSIONS = {
  "*": "deny",
  read: "allow",
  glob: "allow",
  grep: "allow",
  edit: "allow",
  todowrite: "allow",
} as const;

/**
 * The inline config that defines the setup agent. A user's own inline config
 * (OPENCODE_CONFIG_CONTENT) is kept and the agent added to it; `null` when that
 * value is not a JSON object MEX can extend safely.
 */
export function opencodeSessionConfig(existing: string | undefined = process.env.OPENCODE_CONFIG_CONTENT): string | null {
  let base: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
      base = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const agents = base.agent;
  if (agents !== undefined && (typeof agents !== "object" || agents === null || Array.isArray(agents))) return null;
  return JSON.stringify({
    ...base,
    agent: {
      ...(agents as Record<string, unknown> | undefined),
      [OPENCODE_SETUP_AGENT]: {
        description: "MEX setup session: reads the project and writes MEX knowledge files only.",
        mode: "primary",
        permission: OPENCODE_SETUP_PERMISSIONS,
      },
    },
  });
}

/**
 * Headless Claude has no one to answer approval prompts, so every shell command
 * the population prompt relies on must be pre-approved or it is denied. The
 * read-only graph helpers and the event log are allowed, plus the Wiki commands
 * the prompt tells the agent to run itself: `mex wiki apply` (a batch of
 * create-entry operations, which also covers `mex wiki apply --help`) and the
 * `mex wiki validate` self-check, with the `--help` forms for discovery.
 * Without them the agent can stage operation files but nothing applies them.
 * `mex setup next` is allowed so the one-paste setup loop works in a headless
 * session too; bare `mex setup` and its other forms are not.
 * Maintenance and Team commands still require a person. The host matches these
 * as prefixes of a single command, so the prompt tells the agent to run one
 * `mex` command per shell call.
 * Claude already auto-approves read-only Git history commands such as `git log`.
 */
export const HEADLESS_CLAUDE_MEX_COMMANDS = [
  "mex graph scope",
  "mex graph get",
  "mex graph query",
  "mex graph status",
  "mex wiki query",
  "mex wiki apply",
  "mex wiki validate",
  "mex wiki --help",
  "mex --help",
  "mex impact",
  "mex logging",
  "mex log",
  "mex timeline",
  "mex capabilities",
  // The one-paste setup loop: applies the last step and prints the next task.
  "mex setup next",
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
  options: { allowNonGit?: boolean; opencodeConfig?: string | null } = {},
): AgentCommand | null {
  // Background CLIs are listed separately: AI_TOOLS.cli is the interactive command.
  if (mode === "headless") return isBackgroundAgentTool(tool) ? buildBackgroundCommand(tool, instruction, options) : null;
  const meta = AI_TOOLS[tool];
  if (meta.cli === null) return null;
  return { command: meta.cli, args: [...meta.promptFlag, instruction] };
}

function buildBackgroundCommand(
  tool: BackgroundAgentTool,
  instruction: string,
  options: { allowNonGit?: boolean; opencodeConfig?: string | null },
): AgentCommand | null {
  if (tool === "claude") {
    return {
      command: BACKGROUND_AGENT_CLIS.claude,
      args: [
        "-p", instruction, "--permission-mode", "acceptEdits",
        "--allowedTools", HEADLESS_CLAUDE_ALLOWED_TOOLS.join(","),
        "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      ],
    };
  }
  if (tool === "cursor") {
    // Print mode, documented NDJSON events, and workspace trust without a
    // prompt (headless only). Permissions come from the session's project file.
    return {
      command: BACKGROUND_AGENT_CLIS.cursor,
      args: ["-p", "--output-format", "stream-json", "--trust", instruction],
    };
  }
  if (tool === "copilot") {
    // Deny rules win over allow rules, so no shell, URL or memory tool runs;
    // writes stay inside the allowed paths (the working directory).
    return {
      command: BACKGROUND_AGENT_CLIS.copilot,
      args: ["-p", instruction, "--allow-tool=write", "--deny-tool=shell,url,memory", "--no-ask-user", "--output-format=json"],
    };
  }
  if (tool === "opencode") {
    const config = options.opencodeConfig !== undefined ? options.opencodeConfig : opencodeSessionConfig();
    if (config === null) return null;
    return {
      command: BACKGROUND_AGENT_CLIS.opencode,
      args: ["run", "--format", "json", "--agent", OPENCODE_SETUP_AGENT, instruction],
      env: { OPENCODE_CONFIG_CONTENT: config },
    };
  }
  // `exec` is non-interactive and defaults to never asking for approval.
  // Keep workspace confinement without the removed `--full-auto` shorthand.
  return {
    command: BACKGROUND_AGENT_CLIS.codex,
    args: ["exec", "--json", "--sandbox", "workspace-write", ...(options.allowNonGit ? ["--skip-git-repo-check"] : []), instruction],
  };
}
