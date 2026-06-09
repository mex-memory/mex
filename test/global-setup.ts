import { execSync, spawnSync } from "node:child_process";
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

  const probe = spawnSync(process.execPath, [cli, "--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, MEX_TELEMETRY: "0", NO_COLOR: "1" },
  });
  if (probe.status !== 0) {
    const detail = [probe.stdout, probe.stderr].filter(Boolean).join("\n");
    throw new Error(
      `CLI probe failed (run npm install if dependencies are missing): ${detail}`,
    );
  }
}
