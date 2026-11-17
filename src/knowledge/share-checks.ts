/**
 * Checks before entries leave the machine in a commit. A shared entry may end
 * up in a public repository, so anything that only makes sense on one
 * person's machine, or names a person or a private host, stops it.
 */
import { hasSecret, stripHidden } from "./gates.js";
import type { KnowledgeEntry } from "./entry.js";

export interface ShareProblem { id: string; reason: string; }

const PRIVATE: Array<[RegExp, string]> = [
  [/(?:^|[\s"'`(=])(?:[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s"'`)]+|\/(?:Users|home)\/[^\s/"'`)]+)/u, "names a folder on someone's machine"],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u, "contains an email address"],
  [/\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/u, "names a private network address"],
  [/\b[\w-]+(?:\.[\w-]+)*\.(?:internal|corp|lan|intranet|local)\b/iu, "names a private host"],
];

/** Every text field of an entry, for scanning. */
function texts(entry: KnowledgeEntry): string[] {
  const out = [entry.text, entry.mex.one_line, entry.mex.source.ref, entry.mex.source.quote ?? ""];
  for (const check of entry.mex.checks) out.push(JSON.stringify(check.target), JSON.stringify(check.saw));
  return out;
}

export function shareProblems(entry: KnowledgeEntry): ShareProblem[] {
  const id = entry.mex.id;
  const all = texts(entry);
  const problems: ShareProblem[] = [];
  if (all.some(hasSecret)) problems.push({ id, reason: "contains a possible secret" });
  if (all.some(t => stripHidden(t) !== t)) problems.push({ id, reason: "contains hidden characters" });
  for (const [pattern, reason] of PRIVATE) if (all.some(t => pattern.test(t))) problems.push({ id, reason });
  return problems;
}
