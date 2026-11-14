import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { applyOrphanRecovery } from "./recovery.js";
import { runNodeHook } from "../hooks/shim/node-hook.js";

async function main(): Promise<void> {
  if (process.argv.includes("--mex-managed")) process.exit(0);
  if (process.env.MEX_BACKGROUND === "1") {
    if (!process.argv.includes("--cleanup") && process.argv.at(-1) !== "PreCompact") process.stdout.write("{}\n");
    process.exit(0);
  }
  const home = dirname(dirname(resolve(process.argv[1]!)));
  let missing = false;
  try {
    const launcher = JSON.parse(readFileSync(join(home, "bin", "launcher.json"), "utf8"));
    if (launcher.version === 1 && typeof launcher.entry === "string") {
      try { statSync(launcher.entry); }
      catch (error) { missing = (error as NodeJS.ErrnoException).code === "ENOENT"; }
    }
  } catch { /* Missing/unreadable metadata is always fail-open. */ }
  if (missing) applyOrphanRecovery(home);
  if (!process.argv.includes("--cleanup")) {
    if (process.argv.at(-1) !== "PreCompact") {
      await runNodeHook({ stdin: process.stdin, write: text => process.stdout.write(text), env: process.env });
    }
  }
  process.exit(0);
}
void main().catch(() => process.exit(0));
