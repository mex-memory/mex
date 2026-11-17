/** Repository identity comes from the explicit checkout/remote, not inherited tool context. */
export function backgroundEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" } as NodeJS.ProcessEnv;
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_NAMESPACE", "GIT_PREFIX", "GH_REPO", "GH_HOST"]) delete env[key];
  return env;
}
