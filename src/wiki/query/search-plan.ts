/**
 * How a free-text Wiki query becomes FTS5 queries (#235).
 *
 * Both read sessions — the CLI's `WikiQuerySession` and the Hub's contract
 * session — plan through here, so one question gets one answer on every
 * surface.
 *
 * ## Why this exists
 *
 * The first version quoted every token and ANDed them. Quoting is right: it
 * stops user text from becoming FTS5 syntax. ANDing *every* token is not. A
 * question carries words no entity contains — "Why does Hono avoid runtime
 * dependencies?" requires `why`, `does` and `avoid` — so natural-language
 * questions matched nothing, measured at 0 of 25 across two scaffolds, while
 * the keyword form of each question found its answer. An agent reads that
 * silent empty list as "there is no knowledge about this".
 *
 * ## The two tiers
 *
 * 1. **Every term.** Stop words and question words are dropped, and the
 *    remaining terms are quoted and ANDed, exactly as before. An answer here
 *    contains every word that carries meaning, so it is reported as such and
 *    keeps the categorical field order.
 * 2. **Some terms**, filling whatever room tier 1 leaves on the page. Each
 *    term is matched on its own, through a conservative inflection-stripped
 *    prefix, and an entity is kept when it matches at least two distinctive
 *    terms (one, for a one-term query). Tier 1 can be non-empty and still miss
 *    the answer: a term in most of the wiki, such as the project's own name,
 *    makes it return the entities that mention the name. Every tier-2 hit is
 *    labelled as the broader match it is, with
 *    the terms each hit matched and the terms nothing matched, so a caller can
 *    see that "ORM" appears nowhere rather than reading a database-migration
 *    note as an answer about ORMs.
 *
 * Tier 2's order is a sum over matched terms of the term's inverse document
 * frequency — the same IDF bm25 uses — weighted by the best field it matched
 * in. Every input is a fact about the indexed wiki, so two indexes holding the
 * same rows return the same list, and the order can be explained term by term.
 */

import type { SqliteDatabase } from "../../graph/db/sqlite.js";
import { MATCH_FIELD_RANK, type MatchField } from "./rank.js";

/**
 * Function words and question boilerplate: words a question needs and an entity
 * about the answer usually does not contain.
 *
 * Deliberately short of content verbs. `avoid`, `fix` or `add` can be the very
 * word an entity is titled by, so they stay terms and tier 2 absorbs them when
 * they match nothing.
 */
export const WIKI_QUERY_STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "about", "after", "again", "all", "also", "am", "an", "and", "any", "are",
  "aren", "as", "at", "be", "been", "before", "being", "both", "but", "by", "can",
  "could", "did", "didn", "do", "does", "doesn", "doing", "don", "each", "every",
  "for", "from", "get", "gets", "give", "had", "has", "have", "having", "he",
  "her", "here", "his", "how", "i", "if", "in", "into", "is", "isn", "it", "its",
  "just", "may", "me", "might", "more", "most", "must", "my", "need", "needs",
  "no", "nor", "not", "of", "on", "once", "only", "or", "other", "our", "out",
  "over", "same", "shall", "she", "should", "show", "so", "some", "such", "tell",
  "than", "that", "the", "their", "them", "then", "there", "these", "they",
  "this", "those", "through", "to", "too", "under", "until", "up", "us", "use",
  "used", "uses", "using", "very", "via", "want", "was", "wasn", "we", "were",
  "what", "when", "where", "which", "while", "who", "whom", "whose", "why",
  "will", "with", "won", "would", "you", "your",
]);

/** A long paste is still a bounded number of FTS queries. */
export const MAX_QUERY_TERMS = 16;

/** Shorter prefixes match too much to call the match the same word. */
const MIN_PREFIX_LENGTH = 4;

export interface WikiSearchPlan {
  /**
   * The terms searched, lower-cased and de-duplicated in query order.
   *
   * When every token is a stop word they are all kept, so a query such as
   * "how to" still searches for what was typed rather than for nothing.
   */
  terms: string[];
  /** Stop words dropped from the query, in query order. */
  ignoredTerms: string[];
  /** Tier 1: every term, quoted and ANDed. Null when the query has no terms. */
  allTermsExpression: string | null;
}

export function planWikiSearch(text: string): WikiSearchPlan {
  const tokens = text
    .normalize("NFC")
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
  const unique = [...new Set(tokens)];
  const kept = unique.filter((token) => !isStopWord(token));
  const terms = (kept.length > 0 ? kept : unique).slice(0, MAX_QUERY_TERMS);
  const ignoredTerms = kept.length > 0 ? unique.filter(isStopWord) : [];
  return {
    terms,
    ignoredTerms,
    allTermsExpression: terms.length === 0 ? null : terms.map(quote).join(" AND "),
  };
}

/** A single letter is a stop word too: `doesn't` splits into `doesn` and `t`. */
function isStopWord(token: string): boolean {
  return WIKI_QUERY_STOP_WORDS.has(token) || /^\p{L}$/u.test(token);
}

/** Quote one term for MATCH; a doubled quote is FTS5's escape. */
function quote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * The prefix tier 2 matches a term by: the term with one inflectional or
 * common derivational suffix removed, so `dependencies` and `dependency` meet
 * at `dependenc`, and `migration` finds `migrate` through `migr`.
 *
 * Conservative on purpose — this widens a query that already found nothing,
 * and a stem that matched unrelated words would make that wider answer noise.
 * Identifier-shaped terms (digits, underscores) are matched exactly, and no
 * prefix is shorter than {@link MIN_PREFIX_LENGTH}.
 */
export function termStem(term: string): string {
  if (/[\p{N}_]/u.test(term)) return term;
  const stem = stripSuffix(term);
  return stem.length >= MIN_PREFIX_LENGTH ? stem : term;
}

/** Suffixes, longest first, each with the shortest word it may be removed from. */
const SUFFIXES: readonly (readonly [RegExp, number])[] = [
  [/ations?$/u, 8],
  [/ments?$/u, 8],
  [/ies$/u, 6],
  [/(?<=ss|x|z|ch|sh)es$/u, 6],
  [/ings?$/u, 6],
  [/ed$/u, 6],
  [/(?<!s)s$/u, 5],
  [/y$/u, 6],
  [/e$/u, 5],
];

function stripSuffix(term: string): string {
  for (const [suffix, minimumLength] of SUFFIXES) {
    if (term.length < minimumLength || !suffix.test(term)) continue;
    const stem = term.replace(suffix, "");
    // `stopped` → `stopp` would miss `stop`. Root-final doubles (`call`,
    // `pass`, `buzz`, `stuff`) stay, so `called` is still `call`.
    if (/(?:ings?|ed)$/u.test(term) && /([^aeioulszf])\1$/u.test(stem)) return stem.slice(0, -1);
    return stem;
  }
  return term;
}

/**
 * Tier 2's expression for one term: its stem as a prefix when a suffix came
 * off, so `dependencies` finds `dependency`; otherwise the exact term. A bare
 * term is not widened to a prefix — `check` would match `checkout` too, and a
 * term that matches half the wiki stops telling entities apart.
 */
export function someTermsExpression(term: string): string {
  const stem = termStem(term);
  return stem === term ? quote(term) : `${quote(stem)} *`;
}

/** One entity tier 2 kept, and why. */
export interface SomeTermsMatch {
  entityKey: string;
  /** Sum of matched terms' IDF, each weighted by the best field it matched in. Rounded, so ties are exact. */
  score: number;
  /** The best field any matched term was found in. */
  field: MatchField;
  /** Matched terms, in query order. */
  matchedTerms: string[];
  /**
   * FTS5 `bm25()` of the matched terms over every field, rounded; lower is
   * more relevant. Breaks ties between equal scores by how strongly, not just
   * whether, the entity's text is about the terms — instead of by title.
   */
  relevance: number;
}

export interface SomeTermsResult {
  /** Best first: score, then field. Callers break remaining ties by their own entity order. */
  matches: SomeTermsMatch[];
  /** Terms no entity in scope matched at all, even by stem. */
  unmatchedTerms: string[];
  /** True when a per-term bound cut a term's match set short. */
  truncated: boolean;
}

/** An entity filter over `wiki_entities e`, as each session already writes it. */
export interface EntityScope {
  sql: string;
  params: readonly unknown[];
}

const FIELD_GROUPS: readonly (readonly [string, MatchField])[] = [
  ["title", "title"],
  ["summary", "summary"],
  ["body aliases meta", "body"],
];

const FIELD_WEIGHT: Record<MatchField, number> = { id: 3, title: 3, summary: 2, body: 1 };

/**
 * Tier 2: entities matching some of the terms.
 *
 * `perTermLimit` bounds every statement. A term matching more entities than
 * that is reported through `truncated`, and its document frequency is then an
 * undercount, which can only make it look more distinctive than it is.
 */
/** Rows per `IN (...)` lookup, under SQLite's default bound-parameter limit. */
const RELEVANCE_CHUNK = 500;

/**
 * bm25 of any of `terms` for each entity in `entityKeys`, title weighted as
 * tier 2 weights it. Missing entries mean no full-text row (relevance 0).
 */
function relevanceOf(db: SqliteDatabase, terms: readonly string[], entityKeys: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (terms.length === 0 || entityKeys.length === 0) return out;
  const expression = terms.map((term) => `(${someTermsExpression(term)})`).join(" OR ");
  for (let start = 0; start < entityKeys.length; start += RELEVANCE_CHUNK) {
    const chunk = entityKeys.slice(start, start + RELEVANCE_CHUNK);
    const rows = db
      .prepare(
        `SELECT entity_key, round(bm25(wiki_fts, 0, ${FIELD_WEIGHT.title}, ${FIELD_WEIGHT.summary}, ${FIELD_WEIGHT.body}, ${FIELD_WEIGHT.body}, ${FIELD_WEIGHT.body}), 6) AS relevance
           FROM wiki_fts WHERE wiki_fts MATCH ? AND entity_key IN (${chunk.map(() => "?").join(", ")}) LIMIT ?`,
      )
      .all(`{title summary body aliases meta} : (${expression})`, ...chunk, chunk.length) as { entity_key: string; relevance: number }[];
    for (const row of rows) out.set(row.entity_key, Number(row.relevance));
  }
  return out;
}

export function findSomeTermsMatches(
  db: SqliteDatabase,
  terms: readonly string[],
  scope: EntityScope,
  perTermLimit: number,
): SomeTermsResult {
  const population = Number(
    (db.prepare(`SELECT count(*) AS n FROM wiki_entities e WHERE ${scope.sql} LIMIT 1`)
      .get(...scope.params) as { n: number }).n,
  );
  let truncated = false;

  // term → entity key → best field the term matched in.
  const perTerm = new Map<string, Map<string, MatchField>>();
  for (const term of terms) {
    const best = new Map<string, MatchField>();
    const expression = someTermsExpression(term);
    for (const [columns, field] of FIELD_GROUPS) {
      const rows = db
        .prepare(
          `SELECT f.entity_key AS entity_key FROM wiki_fts f JOIN wiki_entities e ON e.entity_key = f.entity_key
            WHERE wiki_fts MATCH ? AND ${scope.sql} ORDER BY f.entity_key LIMIT ?`,
        )
        .all(`{${columns}} : (${expression})`, ...scope.params, perTermLimit + 1) as { entity_key: string }[];
      if (rows.length > perTermLimit) truncated = true;
      for (const row of rows.slice(0, perTermLimit)) {
        if (!best.has(row.entity_key)) best.set(row.entity_key, field);
      }
    }
    perTerm.set(term, best);
  }

  const unmatchedTerms = terms.filter((term) => perTerm.get(term)!.size === 0);
  const weight = new Map<string, number>();
  // A term in most of the wiki — usually the project's own name — says little
  // about which entity is meant. It still adds its (small) weight to the score,
  // but cannot be one of the distinctive matches an entity needs to qualify.
  const distinctive = new Set<string>();
  for (const term of terms) {
    const frequency = perTerm.get(term)!.size;
    if (frequency === 0) continue;
    weight.set(term, Math.log(1 + (population - frequency + 0.5) / (frequency + 0.5)));
    if (population < 4 || frequency * 2 <= population) distinctive.add(term);
  }

  const required = terms.length === 1 ? 1 : 2;
  const byEntity = new Map<string, SomeTermsMatch>();
  for (const term of terms) {
    for (const [entityKey, field] of perTerm.get(term)!) {
      const match = byEntity.get(entityKey) ?? { entityKey, score: 0, field, matchedTerms: [], relevance: 0 };
      match.score += weight.get(term)! * FIELD_WEIGHT[field];
      if (MATCH_FIELD_RANK[field] < MATCH_FIELD_RANK[match.field]) match.field = field;
      match.matchedTerms.push(term);
      byEntity.set(entityKey, match);
    }
  }

  const qualified = [...byEntity.values()]
    .filter((match) => match.matchedTerms.filter((term) => distinctive.has(term)).length >= required);
  const relevance = relevanceOf(db, terms.filter((term) => perTerm.get(term)!.size > 0), qualified.map((match) => match.entityKey));
  const matches = qualified
    .map((match) => ({
      ...match,
      score: Math.round(match.score * 1e6) / 1e6,
      relevance: relevance.get(match.entityKey) ?? 0,
    }))
    .sort((left, right) => right.score - left.score
      || left.relevance - right.relevance
      || MATCH_FIELD_RANK[left.field] - MATCH_FIELD_RANK[right.field]);
  return { matches, unmatchedTerms, truncated };
}
