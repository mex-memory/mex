/**
 * `mex-hook`: the light entry point agent hosts call on every event.
 *
 * It rejects irrelevant payloads before importing the runner or composers.
 * Whatever happens, the process
 * exits 0: a hook that fails would fail the agent's turn.
 */

import { applyInstalledSwitches } from "../../hooks/switches.js";
import { readFileSync } from "node:fs";
import { hookSwitches, preflightHook } from "../../hooks/preflight.js";

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    // A closed or terminal stdin is "no payload".
    return "";
  }
}

/** `mex-hook settle --project <dir> [--session <id>]`: the detached worker the Stop hook starts. */
async function settle(args: readonly string[]): Promise<void> {
  const value = (flag: string): string | null => {
    const at = args.indexOf(flag);
    return at >= 0 && args[at + 1] !== undefined ? args[at + 1]! : null;
  };
  const { runSettleWorker } = await import("./settle.js");
  await runSettleWorker(value("--project") ?? process.cwd(), { sessionId: value("--session") });
}

async function main(): Promise<void> {
  applyInstalledSwitches(process.argv.slice(2));
  const hostAt = process.argv.indexOf("--host");
  const host = process.argv[hostAt + 1] === "codex" && hostAt >= 0 ? "codex" : undefined;
  if (host) process.env.MEX_HOOK_HOST = host;
  if (process.argv[2] === "settle") {
    await settle(process.argv.slice(3));
    process.exitCode = 0;
    return;
  }
  const raw = readStdin();
  if (!await preflightHook(raw, process.cwd(), process.env["CLAUDE_PROJECT_DIR"])) return;
  const { runHook } = await import("./run.js");
  const { stdout } = await runHook(raw, {
    projectDir: process.env["CLAUDE_PROJECT_DIR"],
    cwd: process.cwd(),
    host,
    lexical: process.env["MEX_HOOK_LEXICAL"] === "1",
    tools: hookSwitches(),
  });
  if (stdout !== "") process.stdout.write(stdout);
  process.exitCode = 0;
}

main().catch(() => {
  process.exitCode = 0;
});
