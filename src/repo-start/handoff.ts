/**
 * `mex setup next`: the hand-off to an agent. It does what bare `mex` does
 * without asking anything, then prints the question for the agent to put to
 * the person and the exact command to run on yes. Nothing paid starts here.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runRepoStart, type RepoStartOptions } from "./command.js";
import { FOLDER_COMMAND, FOLDER_QUESTION } from "./folder.js";

/** A 0.8 one-step setup already under way here keeps going with plain `mex setup next`. */
export function legacySetupNextInProgress(projectRoot: string): boolean {
  return existsSync(join(projectRoot, ".mex", "local", "setup-next", "brief.json"));
}

export async function runSetupHandoff(options: RepoStartOptions = {}): Promise<number> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const lines: string[] = [];
  const result = await runRepoStart({ ...options, interactive: false, write: line => lines.push(line) });
  for (const line of lines) write(line);
  if (result.exitCode !== 0) return result.exitCode;
  write("");
  if (result.folderQuestion) {
    write(`Ask the person: "${FOLDER_QUESTION.join(" ").replace(/ \[y\/n\]$/u, "")}"`);
    write(`On yes, run: ${FOLDER_COMMAND}`);
  } else if (result.offer) {
    write(`Ask the person: "${result.offer.question}" (${result.offer.estimate})`);
    write(`On yes, run: ${result.offer.command}`);
  } else if (result.turnedOn) write("Nothing to ask; MEX is on here.");
  else write("Nothing to ask; MEX is off here, and `mex on` turns it back on.");
  return 0;
}
