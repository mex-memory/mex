/**
 * Checks before entries leave the machine in a commit. A shared entry may end
 * up in a public repository, so anything that only makes sense on one
 * person's machine, or names a person or a private host, stops it.
 */
import { hasSecret, stripHidden } from "./gates.js";
import { isLearnedEntry, type KnowledgeEntry } from "./entry.js";

export interface ShareProblem { id: string; reason: string; }

const PRIVATE: Array<[RegExp, string]> = [
  [/(?:^|[\s"'`(=])(?:[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s"'`)]+|\/(?:Users|home)\/[^\s/"'`)]+)/u, "names a folder on someone's machine"],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u, "contains an email address"],
  [/\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/u, "names a private network address"],
  [/\b[\w-]+(?:\.[\w-]+)*\.(?:internal|corp|lan|intranet|local)\b/iu, "names a private host"],
];

/** Every text field of an entry, for scanning. */
function texts(entry: KnowledgeEntry): string[] {
  const { mex } = entry;
  const out = [entry.text, mex.one_line, mex.source.ref, isLearnedEntry(mex) ? "" : mex.source.quote ?? ""];
  if (mex.fix) out.push(mex.fix.snippet, mex.fix.path);
  for (const check of mex.checks) {
    out.push(JSON.stringify(check.target), JSON.stringify(check.saw));
    if (check.kind === "fixture") {
      for (const pair of check.target.pairs) out.push(pair.before.text, pair.after.text);
    }
  }
  return out;
}

export function shareProblems(entry: KnowledgeEntry): ShareProblem[] {
  const id = entry.mex.id;
  const all = texts(entry);
  const problems: ShareProblem[] = [];
  if (isLearnedEntry(entry.mex) && entry.mex.source.type === "person") {
    problems.push({ id, reason: "needs its personal source quote" });
  }
  if (all.some(hasSecret)) problems.push({ id, reason: "contains a possible secret" });
  if (all.some(t => stripHidden(t) !== t)) problems.push({ id, reason: "contains hidden characters" });
  for (const [pattern, reason] of PRIVATE) if (all.some(t => pattern.test(t))) problems.push({ id, reason });
  return problems;
}
