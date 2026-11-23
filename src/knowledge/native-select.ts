/**
 * Layer A: the few broad, strong, stable entries every session in an area
 * needs. Only these go into the agents' own rule files.
 */
import type { KnowledgeEntry } from "./entry.js";

export type Verdict = "held" | "changed" | "broken" | "unknown";
export interface Candidate { level: "team" | "personal"; entry: KnowledgeEntry; }

/** Kinds a session needs up front. Code facts are checked at edits; hints are never broad. */
const KINDS = new Set(["rule", "decision", "pitfall", "procedure", "recipe"]);
/** Evidence strong enough to load into every session. */
const STRONG = new Set(["person", "docs", "ci", "review"]);
/** Longer entries belong in a moment, not in every session. */
export const MAX_NATIVE_TEXT = 600;

/** A folder or the whole repo, not a file pattern. */
export function isBroad(scope: string): boolean {
  return scope === "**" || (/^[^*?[\]{}]+\/\*\*$/u.test(scope));
}

export function isLearned({ mex }: KnowledgeEntry): boolean {
  return mex.source.producer === "learn-deeper" || mex.id.startsWith("mx_deep");
}

export interface Selection { selected: Candidate[]; skipped: Array<{ id: string; reason: string }>; }

export function selectNative(candidates: Candidate[], verdicts: ReadonlyMap<string, Verdict> = new Map()): Selection {
  const selected: Candidate[] = [], skipped: Selection["skipped"] = [];
  const skip = (c: Candidate, reason: string) => skipped.push({ id: c.entry.mex.id, reason });
  for (const c of candidates) {
    const m = c.entry.mex;
    const verdict = verdicts.get(`${c.level}/${m.id}`);
    if (m.status === "proposed") skip(c, "not yet accepted");
    else if (m.status !== "active") skip(c, "retired");
    else if (m.source.type === "rule-file") skip(c, "already in a rule file");
    else if (!KINDS.has(m.kind)) skip(c, `a ${m.kind} isn't loaded every session`);
    else if (!STRONG.has(m.evidence)) skip(c, "evidence too weak");
    else if (isLearned(c.entry) && m.when?.length) skip(c, "delivered at the matching edit");
    else if (isLearned(c.entry) && m.scope.includes("**") && !m.scope.every(scope => scope === "**")) skip(c, "mixed repo and folder scopes");
    else if (!m.scope.every(isBroad)) skip(c, "scoped to files, not an area");
    else if (verdict === "broken" || verdict === "changed") skip(c, `verdict is ${verdict}`);
    else if ((isLearned(c.entry) || m.checks.length) && verdict !== "held") skip(c, "current checks have not held");
    else if (c.entry.text.length > MAX_NATIVE_TEXT) skip(c, "too long for a rule file");
    else selected.push(c);
  }
  selected.sort((a, b) => a.entry.mex.id.localeCompare(b.entry.mex.id));
  return { selected, skipped };
}

/** The folder an area covers: "" for the whole repo. */
export function areaOf(scope: string): string {
  const normalized = scope.replace(/\\/g, "/");
  return normalized === "**" ? "" : normalized.slice(0, -"/**".length);
}
