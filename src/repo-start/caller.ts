/** Who ran this command: a person at a terminal, an agent, or a script (CI included). */
export type Caller = "person" | "agent" | "script";

/** Variables the agents MEX supports set in the shells they start. */
const AGENT_VARIABLES = ["CLAUDECODE", "CODEX_THREAD_ID"] as const;

export interface CallerInput {
  env?: NodeJS.ProcessEnv;
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
}

export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "GITLAB_CI", "TF_BUILD", "BUILDKITE", "CIRCLECI"].some((key) => {
    const value = env[key]?.trim().toLowerCase();
    return value !== undefined && value !== "" && !["0", "false", "no"].includes(value);
  }) || !!env.JENKINS_URL;
}

export function isAgentCaller(env: NodeJS.ProcessEnv = process.env): boolean {
  return AGENT_VARIABLES.some((key) => {
    const value = env[key]?.trim();
    return value !== undefined && value !== "" && value !== "0";
  });
}

/**
 * One check for every command that must behave differently for agents and scripts.
 * An agent wins over a script: agents run commands without a terminal too.
 */
export function detectCaller(input: CallerInput = {}): Caller {
  const env = input.env ?? process.env;
  if (isAgentCaller(env)) return "agent";
  const stdinTTY = input.stdinTTY ?? process.stdin.isTTY === true;
  const stdoutTTY = input.stdoutTTY ?? process.stdout.isTTY === true;
  if (!stdinTTY || !stdoutTTY || isCI(env) || env.TERM === "dumb") return "script";
  return "person";
}
