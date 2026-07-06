import { execSync } from "node:child_process";

/**
 * Whether a CLI command is installed and on PATH — cross-platform.
 *
 * Windows has no `which`; the equivalent is the built-in `where`. Using `which`
 * everywhere made detection always throw on Windows, so `mex sync`/`mex setup`
 * concluded no AI CLI was installed and silently dropped to copy-paste prompts
 * even when Claude/Codex were present (see issue #85). Only the bare command
 * name is passed here, so there are no quoting concerns.
 */
export function isCliAvailable(cmd: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    execSync(`${probe} ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
