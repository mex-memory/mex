import { lstatSync, mkdirSync, mkdtempSync, opendirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

/** Refuse oversized context; never silently truncate evidence before review. */
export const MAX_AGENT_PROMPT_BYTES = 1024 * 1024;

export class AgentPromptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentPromptError";
  }
}

/** An explicit agent launch owns the complete private prompt until the child closes. */
export function createAgentPromptSession(
  prompt: string,
  projectRoot: string,
  purpose: "setup-population" | "agent-review" = "agent-review",
): { root: string; instruction: string; cleanup: () => void } {
  if (Buffer.byteLength(prompt, "utf8") > MAX_AGENT_PROMPT_BYTES) {
    throw new AgentPromptError("The agent prompt exceeds the 1 MiB limit. Split the review into smaller batches.");
  }
  const root = resolve(projectRoot);
  const mexDirectory = resolve(root, ".mex");
  requireDirectory(mexDirectory, ".mex");
  const localDirectory = resolve(mexDirectory, "local");
  try { mkdirSync(localDirectory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new AgentPromptError(`Could not create the private agent prompt directory at ${localDirectory}.`, { cause: error });
    }
  }
  requireDirectory(localDirectory, ".mex/local");
  const directory = mkdtempSync(resolve(localDirectory, `${purpose}-`));
  try {
    const path = resolve(directory, "prompt.md");
    writeFileSync(path, prompt, { encoding: "utf8", flag: "wx", mode: 0o600 });
    writeFileSync(resolve(directory, "owner.json"), JSON.stringify({ pid: process.pid }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    const pointer = relative(root, path).replaceAll("\\", "/");
    const label = purpose === "setup-population" ? "setup population" : "agent review";
    return {
      root,
      instruction: `Read the full ${label} prompt from \`${pointer}\`, then follow it exactly.`,
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Best-effort housekeeping; live owners and recent legacy folders are retained. */
export function cleanupStaleSetupPrompts(projectRoot: string, now = Date.now()): void {
  const local = resolve(projectRoot, ".mex/local");
  try {
    requireDirectory(resolve(projectRoot, ".mex"), ".mex");
    requireDirectory(local, ".mex/local");
    const entries = opendirSync(local);
    try {
      for (let scanned = 0; scanned < 1024; scanned += 1) {
        const entry = entries.readSync();
        if (entry === null) break;
        if (!entry.name.startsWith("setup-population-") || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        const directory = resolve(local, entry.name);
        try {
          const stats = lstatSync(directory);
          if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
          try {
            const ownerPath = resolve(directory, "owner.json");
            const ownerStats = lstatSync(ownerPath);
            if (!ownerStats.isFile() || ownerStats.size > 1024) continue;
            const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid?: unknown };
            if (typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
              try { process.kill(owner.pid, 0); continue; }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
              }
            }
          } catch { /* Unknown ownership uses the conservative one-hour fallback. */ }
          // A dead parent may have left a live child: use the age fallback then too.
          if (now - stats.mtimeMs > 60 * 60_000) rmSync(directory, { recursive: true, force: true });
        } catch { /* A disappearing or inaccessible folder must not block setup. */ }
      }
    } finally { entries.closeSync(); }
  } catch { /* Setup may not have created .mex/local yet. */ }
}

function requireDirectory(path: string, label: string): void {
  let stats;
  try { stats = lstatSync(path); }
  catch (error) { throw new AgentPromptError(`Could not inspect private prompt path ${label}.`, { cause: error }); }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new AgentPromptError(`Cannot store the private agent prompt: ${label} at ${path} is not a regular directory.`);
  }
}
