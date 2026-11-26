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
/** Learned repo-wide entries load every session, so only the best-supported few fit; the rest stay in recall. */
export const MAX_LEARNED_ALWAYS_ON_TOKENS = 300;

/** A folder or the whole repo, not a file pattern. */
export function isBroad(scope: string): boolean {
  return scope === "**" || (/^[^*?[\]{}]+\/\*\*$/u.test(scope));
}

export function isLearned({ mex }: KnowledgeEntry): boolean {
  return mex.source.producer === "learn-deeper" || mex.id.startsWith("mx_deep");
}

function learnedRepoWide(entry: KnowledgeEntry): boolean {
  return isLearned(entry) && entry.mex.scope.every(scope => scope === "**");
}

const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();

/** The producer stores the claim first and appends reasons to the body. */
export function nativeRuleText(entry: KnowledgeEntry): string {
  const text = oneLine(entry.text);
  if (!learnedRepoWide(entry)) return text;
  const claim = oneLine(entry.mex.one_line);
  return /[.!?]$/u.test(claim) && text.startsWith(claim + " ") ? claim : text;
}

export function nativeItem(entry: KnowledgeEntry): string {
  return `- ${nativeRuleText(entry)} <!-- mex:${entry.mex.id} -->`;
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
    else if ((learnedRepoWide(c.entry) ? nativeRuleText(c.entry).length : c.entry.text.length) > MAX_NATIVE_TEXT) skip(c, "too long for a rule file");
    else selected.push(c);
  }
  const kept = withinLearnedBudget(selected, skip);
  kept.sort((a, b) => a.entry.mex.id.localeCompare(b.entry.mex.id));
  return { selected: kept, skipped };
}

/** The distinct pull requests a learned entry's source checks and source cite. Docs lessons have none. */
export function learnedSupport({ mex }: KnowledgeEntry): number {
  if (mex.source.type === "docs") return 0;
  const pull = (url: string) => /^https:\/\/github\.com\/[^/?#]+\/[^/?#]+\/pull\/\d+/u.exec(url)?.[0]?.toLowerCase();
  const links = [mex.source.ref, ...mex.checks.flatMap(check => check.kind === "source" && "url" in check.target ? [check.target.url] : [])];
  return new Set(links.map(pull).filter(Boolean)).size;
}

const KIND_ORDER = ["rule", "decision", "pitfall", "procedure"];
const kindRank = (kind: string) => { const at = KIND_ORDER.indexOf(kind); return at < 0 ? KIND_ORDER.length : at; };
const textTokens = (text: string) => Math.ceil(text.length / 4);

/** Keep the best-supported learned repo-wide entries within one budget across levels; stop at the first that doesn't fit. */
function withinLearnedBudget(selected: Candidate[], skip: (c: Candidate, reason: string) => void): Candidate[] {
  const repoWide = (c: Candidate) => learnedRepoWide(c.entry);
  const ranked = selected.filter(repoWide).map(c => ({ c, support: learnedSupport(c.entry),
    proven: c.entry.mex.checks.some(check => check.kind === "fixture") ? 0 : 1, kind: kindRank(c.entry.mex.kind) }))
    .sort((a, b) => b.support - a.support || a.proven - b.proven || a.kind - b.kind
      || a.c.entry.mex.id.localeCompare(b.c.entry.mex.id));
  const out = new Set<Candidate>();
  let tokens = 0, full = false;
  for (const { c } of ranked) {
    const cost = textTokens(c.entry.text);
    if (!full && tokens + cost <= MAX_LEARNED_ALWAYS_ON_TOKENS) { tokens += cost; out.add(c); }
    else { full = true; skip(c, "over the always-on budget for learned rules; available through recall"); }
  }
  return selected.filter(c => !repoWide(c) || out.has(c));
}

/** The folder an area covers: "" for the whole repo. */
export function areaOf(scope: string): string {
  const normalized = scope.replace(/\\/g, "/");
  return normalized === "**" ? "" : normalized.slice(0, -"/**".length);
}
