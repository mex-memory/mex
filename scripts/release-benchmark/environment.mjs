import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXED_GIT_NAME = "MEX Release Benchmark";
const FIXED_GIT_EMAIL = "release-benchmark@example.invalid";

/** Build a hermetic child environment from a potentially hostile shell. */
export function createBenchmarkEnvironment(root, inherited = process.env) {
  const environment = { ...inherited };
  const exactOverrides = new Set([
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_ATTR_NOSYSTEM",
    "GIT_AUTHOR_DATE",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_NAME",
    "GIT_CEILING_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_COMMITTER_DATE",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_SYSTEM",
    "GIT_DEFAULT_HASH",
    "GIT_DIR",
    "GIT_EXEC_PATH",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_TEMPLATE_DIR",
    "GIT_WORK_TREE",
    "MEX_BACKGROUND",
    "MEX_HOME",
    "MEX_OFF",
    "MEX_RECORD_HOME",
    "MEX_TELEMETRY",
    "NODE_OPTIONS",
    "NODE_PATH",
  ]);
  for (const name of Object.keys(environment)) {
    const key = process.platform === "win32" ? name.toUpperCase() : name;
    if (exactOverrides.has(key)
      || key.startsWith("GIT_CONFIG_KEY_")
      || key.startsWith("GIT_CONFIG_VALUE_")
      || key.startsWith("GIT_TRACE")) {
      delete environment[name];
    }
  }
  const gitConfig = join(root, "empty-gitconfig");
  writeFileSync(gitConfig, "", "utf8");
  environment.CI = "1";
  environment.DO_NOT_TRACK = "1";
  environment.GIT_AUTHOR_EMAIL = FIXED_GIT_EMAIL;
  environment.GIT_AUTHOR_NAME = FIXED_GIT_NAME;
  environment.GIT_COMMITTER_EMAIL = FIXED_GIT_EMAIL;
  environment.GIT_COMMITTER_NAME = FIXED_GIT_NAME;
  environment.GIT_CONFIG_GLOBAL = gitConfig;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_DEFAULT_HASH = "sha1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.LANG = "C.UTF-8";
  environment.LC_ALL = "C.UTF-8";
  environment.MEX_HOME = join(root, "mex-home");
  environment.MEX_TELEMETRY = "0";
  environment.MEX_BACKGROUND = "0";
  environment.MEX_OFF = "0";
  environment.NO_COLOR = "1";
  environment.TZ = "UTC";
  mkdirSync(environment.MEX_HOME, { recursive: true });
  return environment;
}
