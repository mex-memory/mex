/**
 * Prompt ranking: the frozen lexical scorer, the dense fusion and the gate.
 *
 * Pure functions over plain data. Nothing here reads a file, loads a model or
 * writes state, so a hook can call it in-process and a test can drive it with
 * hand-built entities. Ported from the reference ablation harness; the numbers
 * and the order of every stage are frozen (see `frozen.ts`).
 */

import { DENSE_TOP_N, GATE_WINDOW, RRF_K, type Recipe, type RecipeThresholds } from "./frozen.js";
import { extractIdentifiers, queryWords, tokens, wholeIdentifier, type QueryIdentifier } from "./tokenize.js";

/** What the scorer needs to know about one candidate. */
export interface RankableEntity {
  id: string;
  title: string;
  body: string;
  aliases: readonly string[];
  /** Files the entity's groundings point at. */
  code: readonly string[];
  /** Names of the graph symbols the groundings resolve to. */
  symbolNames: readonly string[];
  symbolFiles: readonly string[];
}

export interface RankDoc {
  entity: RankableEntity;
  /** Position in the candidate list; the final tie-break. */
  order: number;
  tf: Map<string, number>;
  len: number;
  symNames: string[];
  symFiles: string[];
}

export interface RankIndex {
  docs: RankDoc[];
  avgLen: number;
  df: Map<string, number>;
  projectWords: ReadonlySet<string>;
}

/** A scored candidate. Lexical fields are zero for a dense-only entry. */
export interface RankedCandidate {
  doc: RankDoc;
  score: number;
  norm: number;
  groups: number;
  /** 0, 2 or 3: how strongly a prompt identifier matched a linked symbol or file. */
  exact: number;
  cos?: number;
  denseRank?: number;
  rrf?: number;
  /** Fused score scaled so a rank-one hit in both channels is 1. */
  fn?: number;
}

export interface RankOutput {
  words: string[];
  identifiers: QueryIdentifier[];
  idfSum: number;
  list: RankedCandidate[];
}

export function buildRankIndex(entities: readonly RankableEntity[], projectWords: ReadonlySet<string> = new Set()): RankIndex {
  const tok = (text: string): string[] => tokens(text, projectWords);
  const docs: RankDoc[] = entities.map((entity, order) => {
    const aliasTokens = tok(entity.aliases.join(" . "));
    const terms = [
      ...tok(entity.title),
      ...tok(entity.title),
      ...tok(entity.title),
      ...tok(entity.body),
      ...entity.code.flatMap((file) => tok(file)),
    ];
    if (entity.aliases.length > 0) terms.push(...aliasTokens, ...aliasTokens, ...aliasTokens);
    const tf = new Map<string, number>();
    for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
    return {
      entity,
      order,
      tf,
      len: terms.length,
      symNames: entity.symbolNames.map(wholeIdentifier),
      symFiles: [...new Set(entity.symbolFiles)],
    };
  });
  const df = new Map<string, number>();
  for (const doc of docs) for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const avgLen = docs.reduce((sum, doc) => sum + doc.len, 0) / Math.max(docs.length, 1);
  return { docs, avgLen, df, projectWords };
}

const idfOf = (index: RankIndex, term: string): number => {
  const n = index.df.get(term) ?? 0;
  return Math.log(1 + (index.docs.length - n + 0.5) / (n + 0.5));
};

export function rankQuery(index: RankIndex, prompt: string): RankOutput {
  const words = queryWords(prompt, index.projectWords);
  const identifiers = extractIdentifiers(prompt);
  const idf = new Map(words.map((term) => [term, idfOf(index, term)]));
  const idfSum = words.reduce((sum, term) => sum + idf.get(term)!, 0) || 1;

  const list: RankedCandidate[] = [];
  for (const doc of index.docs) {
    let score = 0;
    for (const term of words) {
      const tf = doc.tf.get(term);
      if (!tf) continue;
      score += (idf.get(term)! * (tf * 2.2)) / (tf + 1.2 * (0.25 + (0.75 * doc.len) / index.avgLen));
    }
    if (score <= 0) continue;
    list.push({ doc, score, norm: 0, groups: 0, exact: 0 });
  }

  // Exact identifier boost.
  if (identifiers.length > 0) {
    for (const r of list) {
      let m = 0;
      for (const id of identifiers) {
        const l = id.raw.toLowerCase().replace(/^#/, "");
        if (r.doc.symNames.includes(l)) m = Math.max(m, 3);
        else if (id.kind === "path" && r.doc.symFiles.some((f) => f.toLowerCase().endsWith(l.replace(/^\.?\/?/, "")))) m = Math.max(m, 2);
        else if (l.length >= 5 && r.doc.symNames.some((n) => n.includes(l))) m = Math.max(m, 2);
      }
      r.exact = m;
      if (m) r.score *= m;
    }
  }

  // Corroboration: how many distinct query words the candidate contains.
  for (const r of list) {
    r.groups = words.filter((w) => r.doc.tf.has(w)).length;
    if (r.groups < 2 && !r.exact) r.score *= 0.6;
  }
  for (const r of list) r.norm = r.score / idfSum;
  list.sort((a, b) => b.score - a.score || a.doc.order - b.doc.order);
  return { words, identifiers, idfSum, list };
}

/** Reciprocal-rank fusion of the lexical ranking with the dense ranking. */
export function fuseDense(
  index: RankIndex,
  lexical: RankOutput,
  queryVector: Float32Array,
  docVectors: ReadonlyMap<string, Float32Array>,
): RankOutput {
  const scored = index.docs.map((doc) => {
    const v = docVectors.get(doc.entity.id);
    let cos = -1;
    if (v !== undefined) {
      cos = 0;
      for (let k = 0; k < v.length; k += 1) cos += v[k]! * queryVector[k]!;
    }
    return { doc, cos };
  });
  const byCos = scored.slice().sort((a, b) => b.cos - a.cos);
  const denseRank = new Map(byCos.map((x, k) => [x.doc, k]));
  const cosOf = new Map(scored.map((x) => [x.doc, x.cos]));
  const lexRank = new Map(lexical.list.map((r, k) => [r.doc, k]));

  const pool = new Map<RankDoc, RankedCandidate>();
  for (const r of lexical.list) pool.set(r.doc, r);
  for (const x of byCos.slice(0, DENSE_TOP_N)) {
    if (!pool.has(x.doc)) pool.set(x.doc, { doc: x.doc, score: 0, norm: 0, groups: 0, exact: 0 });
  }
  const list = [...pool.values()];
  for (const r of list) {
    r.cos = cosOf.get(r.doc)!;
    r.denseRank = denseRank.get(r.doc)!;
    const lr = lexRank.get(r.doc);
    r.rrf = (lr === undefined ? 0 : 1 / (RRF_K + lr + 1)) + (r.denseRank < DENSE_TOP_N ? 1 / (RRF_K + r.denseRank + 1) : 0);
    r.fn = r.rrf / (2 / (RRF_K + 1));
  }
  list.sort((a, b) => b.rrf! - a.rrf! || a.doc.order - b.doc.order);
  return { words: lexical.words, identifiers: lexical.identifiers, idfSum: lexical.idfSum, list };
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export type CandidateDecision =
  | "selected"
  | "below-floor"
  | "uncorroborated"
  | "low-cosine"
  | "low-fused-score"
  | "dense-only"
  | "weak-margin"
  | "below-ratio"
  | "over-limit"
  | "not-reached";

export interface GatedCandidate {
  rank: number;
  candidate: RankedCandidate;
  decision: CandidateDecision;
}

export interface GateResult {
  /** The candidates that cleared the gate, best first. */
  selected: RankedCandidate[];
  /** Every candidate that reached the gate, with the reason it passed or not. */
  window: GatedCandidate[];
}

/**
 * The frozen gate: the first candidate in rank order that passes every check
 * injects; a second only when it reaches `ratio` of the first one's score.
 */
export function gateCandidates(list: readonly RankedCandidate[], recipe: Recipe): GateResult {
  const p: RecipeThresholds = recipe.thresholds;
  const dense = recipe.dense;
  const window = list.slice(0, GATE_WINDOW);
  const selected: RankedCandidate[] = [];
  const decisions: GatedCandidate[] = window.map((candidate, rank) => ({ rank: rank + 1, candidate, decision: "not-reached" }));
  let first = 0;

  for (let i = 0; i < window.length; i += 1) {
    const r = window[i]!;
    const entry = decisions[i]!;
    let fail: CandidateDecision | null = null;
    if (r.norm > 0) {
      if (!(r.norm >= p.floor)) fail = "below-floor";
      else if (!(r.exact || r.groups >= p.G)) fail = "uncorroborated";
      else if (dense && !((r.cos ?? -1) >= (p.tauD ?? -Infinity))) fail = "low-cosine";
      else if (dense && !((r.fn ?? 0) >= (p.fnMin ?? 0))) fail = "low-fused-score";
    } else {
      fail = "dense-only";
    }
    if (fail !== null) {
      entry.decision = fail;
      continue;
    }
    const sc = dense ? r.fn! : r.norm;
    if (selected.length === 0) {
      if (p.margin) {
        const ref = window[3];
        const refScore = ref ? (dense ? ref.fn! : ref.norm) : 0;
        if (sc - refScore < p.margin * sc) {
          entry.decision = "weak-margin";
          continue;
        }
      }
      selected.push(r);
      first = sc;
      entry.decision = "selected";
    } else if (sc >= p.ratio * first && selected.length < p.max) {
      selected.push(r);
      entry.decision = "selected";
    } else {
      entry.decision = sc >= p.ratio * first ? "over-limit" : "below-ratio";
    }
    if (selected.length >= p.max) {
      for (let j = i + 1; j < window.length; j += 1) decisions[j]!.decision = "not-reached";
      break;
    }
  }
  return { selected, window: decisions };
}
