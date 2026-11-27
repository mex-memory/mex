/**
 * Layer A: the few broad, strong, stable entries every session in an area
 * needs. Only these go into the agents' own rule files.
 */
import type { KnowledgeEntry } from "./entry.js";
import { BROAD_LEARNED_REASON, coversMostCode } from "./learned-scope.js";
export { LEARNED_ALWAYS_ON_SETTING } from "./learned-scope.js";

export type Verdict = "held" | "changed" | "broken" | "unknown";
export interface Candidate { level: "team" | "personal"; entry: KnowledgeEntry; repoWide?: true }

/** Kinds a session needs up front, in tie-break order. */
const KIND_ORDER = ["rule", "decision", "pitfall", "procedure", "recipe"];
/** Evidence strong enough to load into every session. */
const STRONG = new Set(["person", "docs", "ci", "review"]);
/** Longer entries belong in a moment, not in every session. */
export const MAX_NATIVE_TEXT = 600;
/** About one MEX default rules pack of additional prose per session. */
export const MAX_LEARNED_ALWAYS_ON_TOKENS = 450;
/** A folder or the whole repo, not a file pattern. */
export function isBroad(scope: string): boolean {
  return scope === "**" || (/^[^*?[\]{}]+\/\*\*$/u.test(scope));
}

export function isLearned({ mex }: KnowledgeEntry): boolean {
  return mex.source.producer === "learn-deeper" || mex.id.startsWith("mx_deep");
}

const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();

/** The producer stores the claim first and appends reasons to the body. */
export function nativeRuleText(entry: KnowledgeEntry, repoWide = isLearned(entry) && entry.mex.scope.every(scope => scope === "**")): string {
  const text = oneLine(entry.text);
  if (!repoWide) return text;
  const claim = oneLine(entry.mex.one_line);
  return /[.!?]$/u.test(claim) && text.startsWith(claim + " ") ? claim : text;
}

export function nativeItem(entry: KnowledgeEntry, repoWide?: true): string {
  return `- ${nativeRuleText(entry, repoWide)} <!-- mex:${entry.mex.id} -->`;
}

export interface Selection { selected: Candidate[]; skipped: Array<{ id: string; reason: string }>; }
export interface SelectOptions {
  /** The person turned on learning.alwaysOn. Without it, repo-wide learned rules stay in recall. */
  learnedAlwaysOn?: boolean;
  broadScope?: (scopes: readonly string[]) => boolean;
}

export function selectNative(candidates: Candidate[], verdicts: ReadonlyMap<string, Verdict> = new Map(),
  options: SelectOptions = {}): Selection {
  const selected: Candidate[] = [], skipped: Selection["skipped"] = [];
  const skip = (c: Candidate, reason: string) => skipped.push({ id: c.entry.mex.id, reason });
  const broadScope = options.broadScope ?? (scopes => coversMostCode(scopes, () => []));
  for (const c of candidates) {
    const m = c.entry.mex;
    const verdict = verdicts.get(`${c.level}/${m.id}`);
    if (m.status === "proposed") skip(c, "not yet accepted");
    else if (m.status !== "active") skip(c, "retired");
    else if (m.source.type === "rule-file") skip(c, "already in a rule file");
    else if (!KIND_ORDER.includes(m.kind)) skip(c, `a ${m.kind} isn't loaded every session`);
    else if (!STRONG.has(m.evidence)) skip(c, "evidence too weak");
    else if (isLearned(c.entry) && m.when?.length) skip(c, "delivered at the matching edit");
    else {
      const repoWide = isLearned(c.entry) && broadScope(m.scope);
      if (repoWide && !options.learnedAlwaysOn) skip(c, BROAD_LEARNED_REASON);
      else if (!repoWide && !m.scope.every(isBroad)) skip(c, "scoped to files, not an area");
      else if (verdict === "broken" || verdict === "changed") skip(c, `verdict is ${verdict}`);
      else if ((isLearned(c.entry) || m.checks.length) && verdict !== "held") skip(c, "current checks have not held");
      else if ((repoWide ? nativeRuleText(c.entry, true).length : c.entry.text.length) > MAX_NATIVE_TEXT) skip(c, "too long for a rule file");
      else selected.push(repoWide ? { ...c, repoWide: true } : c);
    }
  }
  const kept = withinLearnedBudget(selected, skip);
  kept.sort((a, b) => a.entry.mex.id.localeCompare(b.entry.mex.id));
  return { selected: kept, skipped };
}

/** The distinct pull requests a learned entry's source checks and source cite. */
export function learnedSupport({ mex }: KnowledgeEntry): number {
  const pull = (url: string) => /^https:\/\/github\.com\/[^/?#]+\/[^/?#]+\/pull\/\d+(?=[/?#]|$)/iu.exec(url)?.[0]?.toLowerCase();
  const links = [mex.source.ref, ...mex.checks.flatMap(check => check.kind === "source" && "url" in check.target ? [check.target.url] : [])];
  return new Set(links.map(pull).filter(Boolean)).size;
}

/** Explicit policy, recurrence, a reproducible pattern, then a single review. */
function evidenceRank({ mex }: KnowledgeEntry, support: number): number {
  if (mex.checks.some(check => check.kind === "quote" && check.role === "complete")) return 4;
  if (support >= 2) return 3;
  if (mex.checks.some(check => check.kind === "fixture" && check.role === "complete")) return 2;
  return support;
}

/** Keep whole learned rules within the same estimated token budget across levels. */
function withinLearnedBudget(selected: Candidate[], skip: (c: Candidate, reason: string) => void): Candidate[] {
  const repoWide = (c: Candidate) => c.repoWide;
  const ranked = selected.filter(repoWide).map(c => {
    const support = learnedSupport(c.entry);
    return { c, support, evidence: evidenceRank(c.entry, support), kind: KIND_ORDER.indexOf(c.entry.mex.kind) };
  }).sort((a, b) => b.evidence - a.evidence || b.support - a.support || a.kind - b.kind
    || a.c.entry.mex.id.localeCompare(b.c.entry.mex.id) || Number(b.c.level === "team") - Number(a.c.level === "team"));
  const out = new Set<Candidate>();
  let tokens = 0;
  for (const { c } of ranked) {
    const cost = Math.ceil((Buffer.byteLength(nativeItem(c.entry, c.repoWide)) + 1) / 4);
    if (tokens + cost > MAX_LEARNED_ALWAYS_ON_TOKENS) {
      skip(c, "over the always-on budget for learned rules; available through recall");
      continue;
    }
    tokens += cost;
    out.add(c);
  }
  return selected.filter(c => !repoWide(c) || out.has(c));
}

/** The folder an area covers: "" for the whole repo. */
export function areaOf(scope: string): string {
  const normalized = scope.replace(/\\/g, "/");
  return normalized === "**" ? "" : normalized.slice(0, -"/**".length);
}
