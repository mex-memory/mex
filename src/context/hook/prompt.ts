/**
 * The UserPromptSubmit handler: M1's ranking, run in the hook process.
 *
 * Kept apart from the runner so the tool events never load the Markdown
 * parser, the ranker or the optional embedder; the runner imports this module
 * only for a prompt.
 */

import { candidatePool, composePrompt } from "../compose.js";
import { RECIPES } from "../frozen.js";
import { openGraphReader } from "../graph-reader.js";
import { saveContextIndex } from "../index-file.js";
import { ensureContextIndex } from "../index-store.js";
import { liveStateFrom } from "../packet.js";
import type { ContextRoot } from "../root.js";
import { loadEmbedder, semanticStatus } from "../semantic.js";
import { loadShown, loadStats } from "../session.js";
import type { ContextIndex } from "../types.js";
import { ensureBase } from "./base.js";
import { fileSignature, readHead } from "./diff.js";
import type { Handled } from "./run.js";

export interface PromptOptions {
  /** Force the lexical recipe even when the semantic extra is installed. */
  lexical: boolean;
}

export async function handlePrompt(root: ContextRoot, prompt: string, sessionId: string | null, options: PromptOptions): Promise<Handled> {
  const silence = (note: string): Handled => ({ text: "", remember: [], ids: [], note });
  // A background-task completion arrives as a prompt; it is not a new task.
  if (/^\s*<task-notification>/.test(prompt)) return silence("task-notification");
  if (prompt.trim() === "") return silence("empty-prompt");

  const ensured = await ensureContextIndex(root, "if-stale");
  const index = ensured.index;
  // The first event of a session pins where linked code stood at HEAD, for the edit events after it.
  recordBase(root, index);

  let embedder = null;
  if (!options.lexical && candidatePool(index, RECIPES.R3).length > 0 && semanticStatus(undefined, { measure: false }).state === "installed") {
    embedder = (await loadEmbedder()).embedder;
  }
  const shown = sessionId === null ? new Set<string>() : loadShown(root.localDir, sessionId);
  let outcome;
  try {
    outcome = await composePrompt(index, prompt, { scaffoldRoot: root.scaffoldRoot, shown, embedder });
  } finally {
    await embedder?.dispose?.();
  }
  if (outcome.vectorsComputed > 0) {
    try {
      saveContextIndex(root.localDir, index);
    } catch {
      // The vectors stay in memory for this prompt.
    }
  }
  const result = outcome.result;
  // Seed the source-file signatures once per session: the baseline a Bash call's changes are measured from.
  let stats: Record<string, string> | undefined;
  if (sessionId !== null && Object.keys(loadStats(root.localDir, sessionId)).length === 0) {
    const files = new Set(index.entities.filter((e) => e.type === "fact").flatMap((e) => e.code));
    stats = Object.fromEntries([...files].map((file) => [file, fileSignature(root.projectRoot, file)]));
  }
  return {
    ...(stats === undefined ? {} : { stats }),
    text: result.packet,
    remember: result.injected.map((i) => i.id),
    ids: result.injected.map((i) => i.id),
    pointers: result.injected.map((i) => ({ id: i.id, title: i.title, health: i.health })),
    note: result.abstention ?? `${result.recipe}/${result.channel}`,
  };
}

function recordBase(root: ContextRoot, index: ContextIndex): void {
  const withCode = index.entities.filter((e) => e.type === "fact" && e.groundings.length > 0);
  if (withCode.length === 0) return;
  const { reader } = openGraphReader(root.scaffoldRoot);
  try {
    ensureBase(root.localDir, readHead(root.projectRoot), withCode, liveStateFrom(reader, withCode));
  } finally {
    reader?.close();
  }
}
