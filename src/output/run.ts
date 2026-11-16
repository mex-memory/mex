import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mexHomeDir } from "../global-config.js";
import { binaryFileName, findNativeBinary } from "../hooks/shim/binary.js";

/**
 * `mex run --shell <shell> -- <command>`: the Codex wrapper, for a person to run
 * by hand. The hook rewrites commands to the native binary directly (no Node
 * start); this forwards to the same binary. Without one, the command still runs,
 * untrimmed, so nothing is ever lost.
 */
export function runWrapped(shell: string, command: string): number {
  const installed = join(mexHomeDir(), "bin", binaryFileName());
  const binary = existsSync(installed) ? installed : findNativeBinary();
  if (binary) {
    const res = spawnSync(binary, ["run", "--shell", shell, "--", command], { stdio: "inherit", windowsHide: true });
    if (!res.error) return res.status ?? 1;
  }
  const isPowerShell = shell === "powershell" || shell === "pwsh";
  const program = isPowerShell ? (shell === "pwsh" ? "pwsh" : "powershell.exe") : shell;
  const args = isPowerShell ? ["-NoProfile", "-Command", command] : ["-c", command];
  console.log(`$ ${command}`);
  const res = spawnSync(program, args, { stdio: "inherit", windowsHide: true });
  if (res.error) { console.error(`mex run: ${res.error.message}`); return 127; }
  return res.status ?? 1;
}
