import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { privateEntrypoint } from "./detect-process.js";

const HOOK_MARKER = "# mex-drift-alert";
const HOOK_END_MARKER = "# mex-drift-alert-end";
const HOOK_BLOCK = new RegExp(`^${HOOK_MARKER}\\r?$[\\s\\S]*?^${HOOK_END_MARKER}\\r?$\\r?\\n?`, "m");

function git(projectRoot: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
  } catch { return null; }
}

/** Null outside Git, and when a hook manager owns the directory through core.hooksPath. */
function postCommitPath(projectRoot: string): string | null {
  if (git(projectRoot, ["config", "core.hooksPath"])) return null;
  const hooks = git(projectRoot, ["rev-parse", "--git-path", "hooks"]);
  return hooks === null ? null : resolve(projectRoot, hooks, "post-commit");
}

function shellQuote(value: string): string {
  return `'${value.replace(/\\/g, "/").replace(/'/g, `'\\''`)}'`;
}

function hookBlock(entry: string): string {
  return `${HOOK_MARKER}
# Added by the Hub's drift alert setting. Checks for drift in the background after a commit.
if [ -f ${shellQuote(entry)} ]; then
  (unset GIT_DIR GIT_INDEX_FILE; MEX_TELEMETRY=0 DO_NOT_TRACK=1 nohup ${shellQuote(process.execPath)} ${shellQuote(entry)} "$(pwd -W 2>/dev/null || pwd)" --after-commit >/dev/null 2>&1 &)
fi
${HOOK_END_MARKER}
`;
}

/** Add only this block, keeping whatever the hook already does. False when it can't be added. */
export function installDriftAlertHook(projectRoot: string, entry = privateEntrypoint("drift-alert")): boolean {
  const path = postCommitPath(projectRoot);
  if (path === null) return false;
  try {
    if (!existsSync(path)) {
      writeFileSync(path, `#!/bin/sh\n${hookBlock(entry)}`);
    } else {
      if (lstatSync(path).isSymbolicLink()) return false;
      const existing = readFileSync(path, "utf8");
      writeFileSync(path, HOOK_BLOCK.test(existing)
        ? existing.replace(HOOK_BLOCK, () => hookBlock(entry))
        : `${existing.trimEnd()}\n\n${hookBlock(entry)}`);
    }
    chmodSync(path, 0o755);
    return true;
  } catch { return false; }
}

/** Remove only this block, and the file only when nothing else was in it. */
export function removeDriftAlertHook(projectRoot: string): void {
  const path = postCommitPath(projectRoot);
  if (path === null) return;
  try {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return;
    const existing = readFileSync(path, "utf8");
    if (!HOOK_BLOCK.test(existing)) return;
    const remaining = existing.replace(HOOK_BLOCK, "");
    if (remaining.replace(/^#!.*$/m, "").trim() === "") unlinkSync(path);
    else writeFileSync(path, `${remaining.trimEnd()}\n`);
  } catch { /* The block stays, and it does nothing once alerts are off. */ }
}
