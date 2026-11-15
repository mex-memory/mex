/**
 * Aliases and asks: the words a person would type when an entry matters,
 * written onto the entry so that the hook stays a lookup. Each candidate passes
 * a deterministic filter before it is kept. It is ranked by the delivery
 * ranker (`mex-hook --recall`) against the project's entries, with all of the
 * entry's candidates added to it, and kept only when it ranks its own entry
 * first by a clear margin. A candidate that would pull in another entry is
 * dropped with the reason. Aliases and asks are retrieval aids only: never
 * delivered text and never evidence.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { KNOWLEDGE_LIMITS, KnowledgeError, type KnowledgeEntry } from "./entry.js";
import { rankBinary } from "./native-rank.js";

export type AidKind = "alias" | "ask";
export type AidSource = "hand" | "enrich" | "setup" | "import" | "filter";
export interface AidCandidate { kind: AidKind; text: string; }
export interface AidVerdict {
  entry: string; kind: AidKind; text: string; kept: boolean; reason: string;
  /** The candidate's score for its own entry, when it matched. */
  score?: number;
  /** (own score - best other score) / own score, when its own entry ranked first. */
  margin?: number;
  /** The entry the candidate ranked first, when that wasn't its own. */
  top?: string;
  /** Kept by two entries: Review decides, nothing is silently kept for both. */
  review?: boolean;
}
export interface AidFilterResult { aliases: string[]; asks: string[]; verdicts: AidVerdict[]; }

/** The own entry must lead the next one by this share of its score. */
export const AID_MARGIN = 0.25;
const LIMITS = {
  alias: { count: KNOWLEDGE_LIMITS.aliases, characters: KNOWLEDGE_LIMITS.aliasCharacters },
  ask: { count: KNOWLEDGE_LIMITS.asks, characters: KNOWLEDGE_LIMITS.askCharacters },
} as const;

export function normalizeAid(text: string): string {
  return text.normalize("NFKC").replace(/[\x00-\x1f\x7f]+/gu, " ").replace(/\s+/gu, " ").trim();
}
const key = (text: string) => normalizeAid(text).toLowerCase();

/** A stable digest of what the filter ranks against, so a rerun is needed only when it changes. */
export function corpusDigest(entries: readonly KnowledgeEntry[]): string {
  const h = createHash("sha256");
  for (const e of [...entries].sort((a, b) => a.mex.id.localeCompare(b.mex.id))) {
    h.update(JSON.stringify([e.mex.id, e.mex.one_line, e.text, e.mex.scope, e.mex.aliases ?? [], e.mex.asks ?? [], e.mex.checks.map(c => c.target), e.mex.when ?? []]));
  }
  return `sha256:${h.digest("hex")}`;
}

/** sent: the shipped prompt gate would deliver this entry for the query. */
interface Ranked { id: string; score: number; sent?: boolean; }
export type AidRanker = (entries: KnowledgeEntry[], queries: Array<{ id: string; text: string }>) => Map<string, Ranked[]>;

/** One `mex-hook --recall` call ranks every candidate; written aids are indexed as their own fields. */
export const nativeAidRanker: AidRanker = (entries, queries) => {
  const binary = rankBinary();
  if (!binary) throw new KnowledgeError("RANKER_UNAVAILABLE", "The native ranker is not installed; aliases and asks can't be checked.");
  const result = spawnSync(binary, ["--recall"], {
    input: JSON.stringify({ entries: entries.map(e => ({ ...e.mex, text: e.text })), queries, gates: [{ learned: true }], aids: true }),
    encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, MEX_BACKGROUND: "1" },
  });
  let output: { ok?: boolean; results?: Array<{ id: string; ranked?: Ranked[]; selected?: Array<Array<{ id: string }>> }> } | undefined;
  try { output = result.status === 0 ? JSON.parse(result.stdout) : undefined; } catch { output = undefined; }
  if (!output?.ok || !Array.isArray(output.results)) throw new KnowledgeError("RANKER_UNAVAILABLE", "The native ranker failed; aliases and asks were not changed.");
  return new Map(output.results.map(row => {
    const sent = new Set((row.selected?.[0] ?? []).map(r => String(r.id)));
    return [row.id, (row.ranked ?? []).map(r => ({ id: String(r.id), score: Number(r.score), sent: sent.has(String(r.id)) }))];
  }));
};

/**
 * Filter candidates for one entry. The corpus is every current entry of the
 * project; the target's own current aids are rechecked with the new ones.
 * Deterministic: the same corpus and candidates give the same verdicts.
 */
export interface AidRules { prior: "first" | "sent" | "off"; margin: number; }
export function filterAids(target: KnowledgeEntry, candidates: readonly AidCandidate[], corpus: readonly KnowledgeEntry[], rank: AidRanker = nativeAidRanker, rules: AidRules = { prior: (process.env.MEX_AID_PRIOR as AidRules["prior"]) || "first", margin: Number(process.env.MEX_AID_MARGIN ?? AID_MARGIN) }): AidFilterResult {
  const verdicts: AidVerdict[] = [];
  const pending: AidCandidate[] = [];
  const seen = new Set<string>();
  const title = key(target.mex.one_line);
  for (const raw of candidates) {
    const text = normalizeAid(raw.text);
    const drop = (reason: string) => verdicts.push({ entry: target.mex.id, kind: raw.kind, text: text.slice(0, LIMITS[raw.kind].characters), kept: false, reason });
    if (!text) { drop("empty"); continue; }
    if (text.length > LIMITS[raw.kind].characters) { drop(`longer than ${LIMITS[raw.kind].characters} characters`); continue; }
    if (seen.has(`${raw.kind}:${key(text)}`)) { drop("duplicate"); continue; }
    if (key(text) === title) { drop("repeats the entry's one line"); continue; }
    seen.add(`${raw.kind}:${key(text)}`);
    pending.push({ kind: raw.kind, text });
  }
  const self: KnowledgeEntry = {
    ...target,
    mex: { ...target.mex, aliases: pending.filter(c => c.kind === "alias").map(c => c.text), asks: pending.filter(c => c.kind === "ask").map(c => c.text) },
  };
  const others = corpus.filter(e => e.mex.id !== target.mex.id);
  // Two passes. Without the candidates, words that already find another entry
  // belong to that entry: an alias made of them would pull this one in for
  // prompts about the other. With them, this entry must then lead by a margin.
  const queries = pending.map((c, i) => ({ id: String(i), text: c.text }));
  const before = pending.length ? rank([target, ...others], queries.map(q => ({ ...q, id: `b${q.id}` }))) : new Map<string, Ranked[]>();
  // The index validates each entry as a whole; the bounds are applied after ranking.
  const indexed = [{ ...self, mex: { ...self.mex, aliases: self.mex.aliases!.slice(0, 64), asks: self.mex.asks!.slice(0, 64) } }, ...others];
  const ranked = pending.length ? rank(indexed, queries) : new Map<string, Ranked[]>();
  const kept = { alias: [] as string[], ask: [] as string[] };
  pending.forEach((c, i) => {
    const list = ranked.get(String(i)) ?? [];
    const own = list.find(r => r.id === target.mex.id);
    const priorList = before.get(`b${i}`) ?? [];
    const prior = rules.prior === "off" ? undefined : rules.prior === "sent" ? priorList.find(r => r.sent && r.id !== target.mex.id) : priorList[0];
    const verdict: AidVerdict = { entry: target.mex.id, kind: c.kind, text: c.text, kept: false, reason: "" };
    if (prior && prior.id !== target.mex.id) Object.assign(verdict, { reason: `already finds ${prior.id} first`, top: prior.id });
    else if (!own) verdict.reason = "matches no words of its entry";
    else if (list[0].id !== target.mex.id) Object.assign(verdict, { reason: `ranks ${list[0].id} above its own entry`, top: list[0].id, score: own.score });
    else {
      const second = list.find(r => r.id !== target.mex.id)?.score ?? 0;
      const margin = (own.score - second) / Math.max(own.score, 1e-9);
      Object.assign(verdict, { score: own.score, margin: Math.round(margin * 1000) / 1000 });
      if (margin < rules.margin) verdict.reason = `leads ${list.find(r => r.id !== target.mex.id)!.id} by less than ${rules.margin * 100}%`;
      else if (kept[c.kind].length >= LIMITS[c.kind].count) verdict.reason = `over the limit of ${LIMITS[c.kind].count}`;
      else { verdict.kept = true; verdict.reason = "ranks its own entry first"; kept[c.kind].push(c.text); }
    }
    verdicts.push(verdict);
  });
  // An alias another entry already keeps goes to Review instead of being kept for both.
  for (const v of verdicts) {
    if (!v.kept) continue;
    const holder = others.find(e => (v.kind === "alias" ? e.mex.aliases : e.mex.asks)?.some(a => key(a) === key(v.text)));
    if (holder) {
      Object.assign(v, { kept: false, review: true, top: holder.mex.id, reason: `${holder.mex.id} already keeps it; sent to Review` });
      kept[v.kind] = kept[v.kind].filter(t => key(t) !== key(v.text));
    }
  }
  return { aliases: kept.alias, asks: kept.ask, verdicts };
}

/** Rerun the filter over every entry with aids. Returns the entries whose kept aids changed. */
export function refilterCorpus(corpus: readonly KnowledgeEntry[], rank: AidRanker = nativeAidRanker): Array<{ entry: KnowledgeEntry; result: AidFilterResult; changed: boolean }> {
  return corpus.filter(e => e.mex.aliases?.length || e.mex.asks?.length).map(entry => {
    const candidates = [...(entry.mex.aliases ?? []).map(text => ({ kind: "alias" as const, text })), ...(entry.mex.asks ?? []).map(text => ({ kind: "ask" as const, text }))];
    const base = { ...entry, mex: { ...entry.mex, aliases: undefined, asks: undefined } };
    const result = filterAids(base, candidates, corpus.map(e => e.mex.id === entry.mex.id ? base : e), rank);
    const changed = JSON.stringify(result.aliases) !== JSON.stringify(entry.mex.aliases ?? []) || JSON.stringify(result.asks) !== JSON.stringify(entry.mex.asks ?? []);
    return { entry, result, changed };
  });
}

/** The entry with exactly the kept aids; empty lists are removed so old readers see the same file. */
export function withAids(entry: KnowledgeEntry, aliases: readonly string[], asks: readonly string[]): KnowledgeEntry {
  const mex = { ...entry.mex };
  delete mex.aliases; delete mex.asks;
  if (aliases.length) mex.aliases = [...aliases];
  if (asks.length) mex.asks = [...asks];
  return { ...entry, mex };
}

/**
 * The seam for AI writers (setup population, rule-file import, the backfill,
 * and later the session filter): they return candidates beside each entry, and
 * this keeps only the ones that pass. The writer's prompt rule is in
 * AID_WRITER_RULE.
 */
export function applyCandidateAids(entry: KnowledgeEntry, candidates: { aliases?: unknown; asks?: unknown } | undefined, corpus: readonly KnowledgeEntry[], rank: AidRanker = nativeAidRanker): { entry: KnowledgeEntry; verdicts: AidVerdict[] } {
  const list = (v: unknown) => Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").slice(0, 20) : [];
  const offered = [...list(candidates?.aliases).map(text => ({ kind: "alias" as const, text })), ...list(candidates?.asks).map(text => ({ kind: "ask" as const, text }))];
  if (!offered.length) return { entry, verdicts: [] };
  const existing = [...(entry.mex.aliases ?? []).map(text => ({ kind: "alias" as const, text })), ...(entry.mex.asks ?? []).map(text => ({ kind: "ask" as const, text }))];
  const result = filterAids(withAids(entry, [], []), [...existing, ...offered], corpus, rank);
  return { entry: withAids(entry, result.aliases, result.asks), verdicts: result.verdicts };
}

/** The instruction every AI writer of aliases and asks follows. */
export const AID_WRITER_RULE = [
  "For each entry also write up to 8 aliases (at most 40 characters each) and up to 5 asks (example requests, at most 120 characters each).",
  "Write the words a person would use who doesn't know the entry exists: symptoms, error text, the task they are doing, the names they call things.",
  "Don't paraphrase the entry's title, and don't repeat words that are already in it.",
].join(" ");
