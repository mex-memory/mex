import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "dist", "cli.js");

export default function setup(): void {
  execSync("npm run build", { cwd: repoRoot, stdio: "pipe" });
  if (!existsSync(cli)) {
    throw new Error(`CLI build failed: ${cli} not found before running tests`);
  }
}
