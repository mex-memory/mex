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
