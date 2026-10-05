import { writeFileSync, readFileSync, existsSync, chmodSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import type { MexConfig } from "./types.js";
import { runHeartbeat } from "./heartbeat.js";

const HOOK_MARKER = "# mex-drift-check";
const HOOK_END_MARKER = "# mex-drift-check-end";
const HOOK_BLOCK = new RegExp(`^${HOOK_MARKER}$[\\s\\S]*?^${HOOK_END_MARKER}$\\n?`, "m");

// TeX Live also ships a `mex`, so verify the binary is ours.
const PATH_MEX_RESOLUTION = `mex_is_agent() {
  _out=$("$1" --help </dev/null 2>/dev/null) || return 1
  [ "$(printf '%s\\n' "$_out" | grep -Ec '^  (check|sync)( |$)')" -eq 2 ]
}
MEX_BIN=$(command -v mex 2>/dev/null) || MEX_BIN=""
if [ -n "$MEX_BIN" ] && mex_is_agent "$MEX_BIN"; then
  SCORE=$("$MEX_BIN" check --quiet 2>&1) || true
else
  SCORE=$(npx mex-agent check --quiet 2>&1) || true
fi`;

function buildHookContent(config: MexConfig): string {
  const cliPath = resolve(config.scaffoldRoot, "dist", "cli.js");
  // Use local CLI if built, otherwise fall back to npx
  const run = existsSync(cliPath)
    ? `SCORE=$(node "${cliPath}" check --quiet 2>&1) || true`
    : PATH_MEX_RESOLUTION;

  return `#!/bin/sh
${HOOK_MARKER}
# Auto-installed by mex watch — runs drift check after each commit
${run}
# Only show output if there are issues (not a perfect score)
case "$SCORE" in
  *"100/100"*) ;;
  *) echo "$SCORE" ;;
esac
${HOOK_END_MARKER}
`;
}

export async function manageHook(
  config: MexConfig,
  opts: { uninstall?: boolean; intervalMinutes?: number }
): Promise<void> {
  if (opts.intervalMinutes) {
    await runWatchInterval(config, opts.intervalMinutes);
    return;
  }

  const hookPath = resolve(config.projectRoot, ".git", "hooks", "post-commit");

  if (opts.uninstall) {
    uninstallHook(hookPath);
    return;
  }

  installHook(hookPath, config);
}

export async function runWatchInterval(config: MexConfig, intervalMinutes: number): Promise<void> {
  console.log(chalk.green(`mex heartbeat running every ${intervalMinutes} minute${intervalMinutes === 1 ? "" : "s"}. Press Ctrl+C to stop.`));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = async () => {
    try {
      await runHeartbeat(config);
    } catch (err) {
      console.error((err as Error).message);
    }
  };

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    console.log(chalk.dim("mex heartbeat stopped."));
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await run();
      scheduleNext();
    }, intervalMinutes * 60_000);
  };

  await run();
  scheduleNext();
}

function installHook(hookPath: string, config: MexConfig): void {
  const hookContent = buildHookContent(config);

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    if (existing.includes(HOOK_MARKER)) {
      console.log(chalk.yellow("mex post-commit hook is already installed."));
      return;
    }

    // Append to existing hook
    const updated = existing.trimEnd() + "\n\n" + hookContent;
    writeFileSync(hookPath, updated);
    chmodSync(hookPath, 0o755);
    console.log(
      chalk.green("Added mex drift check to existing post-commit hook.")
    );
    return;
  }

  writeFileSync(hookPath, hookContent);
  chmodSync(hookPath, 0o755);
  console.log(chalk.green("Installed mex post-commit hook."));
}

function uninstallHook(hookPath: string): void {
  if (!existsSync(hookPath)) {
    console.log(chalk.yellow("No post-commit hook found."));
    return;
  }

  const content = readFileSync(hookPath, "utf-8");
  if (!content.includes(HOOK_MARKER)) {
    console.log(
      chalk.yellow("post-commit hook exists but was not installed by mex.")
    );
    return;
  }

  // Remove mex section (everything between marker and next non-mex line)
  const lines = content.replace(HOOK_BLOCK, "").split("\n");
  const filtered: string[] = [];
  let inMexBlock = false;

  for (const line of lines) {
    if (line.includes(HOOK_MARKER)) {
      inMexBlock = true;
      continue;
    }
    if (inMexBlock) {
      // Skip lines that are part of the mex hook block
      if (line.startsWith("#") || line.startsWith("SCORE=") ||
          line.startsWith("case") || line.startsWith("  *") ||
          line.startsWith("esac") || line.startsWith("npx mex") ||
          line.startsWith("node ") || line.trim() === "") {
        continue;
      }
      // Non-mex line found — stop skipping
      inMexBlock = false;
    }
    filtered.push(line);
  }

  const remaining = filtered.join("\n").trim();
  if (remaining === "#!/bin/sh" || remaining === "") {
    // Only shebang left — remove the file
    unlinkSync(hookPath);
    console.log(chalk.green("Removed mex post-commit hook."));
  } else {
    writeFileSync(hookPath, remaining + "\n");
    chmodSync(hookPath, 0o755);
    console.log(
      chalk.green("Removed mex section from post-commit hook.")
    );
  }
}
