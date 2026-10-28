/** Export these in the host environment and rerun hooks install to update matchers. */
export function hookSwitches(env: NodeJS.ProcessEnv = process.env) {
  const search = env.MEX_HOOK_SEARCH !== "0";
  return {
    prompt: env.MEX_HOOK_PROMPT !== "0",
    stop: env.MEX_HOOK_STOP !== "0",
    read: env.MEX_HOOK_READ === "1",
    edit: env.MEX_HOOK_EDIT === "1",
    search,
    grep: search && env.MEX_HOOK_GREP !== "0",
    bash: env.MEX_HOOK_BASH !== "0",
  };
}

/** Values whose non-default settings must survive a host dropping its environment. */
export const SWITCH_DEFAULTS = {
  prompt: "1", stop: "1", read: "0", edit: "0", search: "1", grep: "1", bash: "1",
  graph: "1", graph_impact: "0", stop_review: "0",
} as const;

export function installedSwitchArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const args: string[] = [];
  if (env.MEX_HOOK_LEXICAL === "1") args.push("--lexical");
  for (const [name, fallback] of Object.entries(SWITCH_DEFAULTS)) {
    const value = env[`MEX_HOOK_${name.toUpperCase()}`];
    if ((value === "0" || value === "1") && value !== fallback) args.push("--switch", `${name}=${value}`);
  }
  return args;
}

/** Apply installed defaults before preflight, including graph/Stop modules. The environment wins. */
export function applyInstalledSwitches(args: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  if (args.includes("--lexical") && env.MEX_HOOK_LEXICAL === undefined) env.MEX_HOOK_LEXICAL = "1";
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--switch") continue;
    const match = /^([a-z_]+)=([01])$/.exec(args[++i] ?? "");
    if (!match || !Object.hasOwn(SWITCH_DEFAULTS, match[1]!)) continue;
    const key = `MEX_HOOK_${match[1]!.toUpperCase()}`;
    if (env[key] === undefined) env[key] = match[2];
  }
}

export function effectiveSwitches(env: NodeJS.ProcessEnv = process.env) {
  return { ...hookSwitches(env), graph: env.MEX_HOOK_GRAPH !== "0", graph_impact: env.MEX_HOOK_GRAPH_IMPACT === "1", stop_review: env.MEX_HOOK_STOP_REVIEW === "1" };
}
