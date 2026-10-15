/**
 * `mex-hook`: the light entry point agent hosts call on every event.
 *
 * It imports the context composer and a few helpers, never the CLI, so a hook
 * starts in about the time Node itself does. Whatever happens, the process
 * exits 0: a hook that fails would fail the agent's turn.
 */

import { readFileSync } from "node:fs";
import { runHook } from "./run.js";

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
  if (process.argv[2] === "settle") {
    await settle(process.argv.slice(3));
    process.exitCode = 0;
    return;
  }
  const { stdout } = await runHook(readStdin(), {
    projectDir: process.env["CLAUDE_PROJECT_DIR"],
    cwd: process.cwd(),
    lexical: process.env["MEX_HOOK_LEXICAL"] === "1",
  });
  if (stdout !== "") process.stdout.write(stdout);
  process.exitCode = 0;
}

main().catch(() => {
  process.exitCode = 0;
});
