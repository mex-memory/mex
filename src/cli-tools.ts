import { execSync } from "node:child_process";

/** Public help and completion order. Bare mex is described above the command list. */
export const PUBLIC_COMMAND_ORDER = [
  "install", "uninstall", "doctor", "off", "on", "capture", "compact", "setup",
  "note", "recall", "expand", "edit", "wrong", "forget", "check", "review",
  "share", "rules", "handoff", "upgrade", "what", "brief", "learn", "jobs",
  "config", "telemetry", "feedback", "sync", "hints", "report", "alias", "ask", "entries", "decisions", "hub", "out", "run",
] as const;

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
