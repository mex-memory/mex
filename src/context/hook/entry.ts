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

async function main(): Promise<void> {
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
