import { dirname, resolve } from "node:path";
import { applyOrphanRecovery, cliMissing } from "./recovery.js";
import { runNodeHook } from "../hooks/shim/node-hook.js";

async function main(): Promise<void> {
  if (process.argv.includes("--mex-managed")) process.exit(0);
  if (process.env.MEX_BACKGROUND === "1") {
    if (!process.argv.includes("--cleanup") && process.argv.at(-1) !== "PreCompact") process.stdout.write("{}\n");
    process.exit(0);
  }
  const home = dirname(dirname(resolve(process.argv[1]!)));
  if (cliMissing(home)) await applyOrphanRecovery(home);
  if (!process.argv.includes("--cleanup")) {
    if (process.argv.at(-1) !== "PreCompact") {
      await runNodeHook({ stdin: process.stdin, write: text => process.stdout.write(text), env: process.env });
    }
  }
  process.exit(0);
}
void main().catch(() => process.exit(0));
