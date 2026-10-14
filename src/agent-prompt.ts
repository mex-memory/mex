import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function requireDirectory(path: string, label: string): void {
  let stats;
  try { stats = lstatSync(path); }
  catch (error) { throw new AgentPromptError(`Could not inspect private prompt path ${label}.`, { cause: error }); }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new AgentPromptError(`Cannot store the private agent prompt: ${label} at ${path} is not a regular directory.`);
  }
}
