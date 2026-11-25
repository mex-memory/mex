import type { MachineSetupQuestion } from "@mex/hub-contracts/machine";
import { createHash } from "node:crypto";
import { posix, join } from "node:path";
import { containedDirectory, readBoundedTextFile } from "../../knowledge/files.js";
import { hasSecret, stripHidden } from "../../knowledge/gates.js";
import { RULE_CACHE, type RuleCache } from "../../knowledge/rule-cache.js";
import { fileHash } from "../../knowledge/sections.js";
import type { CodeFactsFile } from "../../repo-start/history/job.js";
import { readFactFile } from "../../repo-start/facts.js";
import { pendingGaps } from "../../repo-start/questions/index.js";
import type { RecipesFile } from "../../repo-start/recipes/index.js";
import type { RecordLocation } from "../../record/location.js";

function fileRevision(root: string, path: string): string | null {
  if (/[\\:\u0000]/u.test(path) || path.split("/").some(part => !part || [".", "..", ".git", ".mex"].includes(part.toLowerCase()))) return null;
  try {
    const parent = posix.dirname(path);
    const directory = parent === "." ? root : containedDirectory(root, parent.split("/"));
    const body = directory && readBoundedTextFile(join(directory, posix.basename(path)), 256 << 10);
    return body === undefined ? null : fileHash(body);
  } catch { return null; }
}

export function readSetupQuestions(
  location: RecordLocation, projectId: string, root: string, runRevision: string, facts?: CodeFactsFile,
) {
  const input = { location, projectId, root, ruleHistory: false };
  if (!containedDirectory(location.home, ["projects", projectId])) return { input, questions: [] };

  const recipes = readFactFile<RecipesFile>(location, projectId, "recipes.json");
  const cache = readFactFile<RuleCache>(location, projectId, RULE_CACHE);
  const revisions = new Map<string, string | null>();
  const revisionOf = (path: string) => {
    if (!revisions.has(path)) revisions.set(path, fileRevision(root, path));
    return revisions.get(path);
  };
  const rules = cache?.root === root && Array.isArray(cache.files) && Array.isArray(cache.entries) && Array.isArray(cache.review) ? cache : undefined;
  const hashes = new Map(rules?.files.map(({ path, hash }) => [path, hash]));
  const scan = rules && { ...rules, review: rules.review.filter(item => item.kind === "conflict" && item.paths.length === 2
    && item.paths.every(path => hashes.has(path) && revisionOf(path) === hashes.get(path))) };
  const current = { ...input, recipes: recipes?.root === root ? recipes : undefined, scan, facts };

  const questions = pendingGaps(current).flatMap(gap => {
    const { id, type, question, details, choices, suggested } = gap;
    const view: MachineSetupQuestion = {
      id, type, question: stripHidden(question), details: details.map(stripHidden),
      choices: choices.map(({ key, label }) => ({ key, label: stripHidden(label) })), suggested,
    };
    const visible = JSON.stringify(view);
    if (hasSecret(visible) || /<\/?private>/iu.test(visible)) return [];
    const evidence = gap.evidencePaths.map(path => [path, revisionOf(path)]);
    const proposals = choices.map(({ key }) => gap.resolve(key, "2000-01-01"));
    const revision = createHash("sha256").update(JSON.stringify([runRevision, view, evidence, proposals])).digest("hex");
    return [{ gap, view: { ...view, revision } }];
  });
  return { input: current, questions };
}
