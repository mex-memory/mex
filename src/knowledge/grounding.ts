/**
 * Fields extracted from a source (a commit message or diff, or typed text) are
 * checked against the verbatim source before they are kept. An exact match
 * keeps the writer's confidence; a fuzzy one (same words, different case,
 * spacing or punctuation) scales it by 0.85; one that isn't found scales it by
 * 0.6. Below 0.6 the field is dropped.
 */
export type GroundMatch = "exact" | "fuzzy" | "missing";
export const GROUND_FACTOR: Readonly<Record<GroundMatch, number>> = { exact: 1, fuzzy: 0.85, missing: 0.6 };
export const GROUND_FLOOR = 0.6;
/** What a restatement by an agent or a person starts at, before it is checked. */
export const RESTATED = 0.9;
/** Share of a field's words that must appear in one source for a fuzzy match. */
const FUZZY_WORDS = 0.8;

const normal = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const words = (s: string) => [...new Set(normal(s).split(" ").filter(w => w.length > 2))];

export interface Grounded { match: GroundMatch; confidence: number; kept: boolean; }
export function ground(value: string, sources: readonly string[], base = 1): Grounded {
  let match: GroundMatch = "missing";
  if (sources.some(s => s.includes(value))) match = "exact";
  else {
    const v = normal(value), terms = words(value);
    if (v && sources.some(s => {
      const n = normal(s);
      if (n.includes(v)) return true;
      const have = new Set(n.split(" "));
      return terms.length > 0 && terms.filter(t => have.has(t)).length / terms.length >= FUZZY_WORDS;
    })) match = "fuzzy";
  }
  const confidence = Math.round(base * GROUND_FACTOR[match] * 1000) / 1000;
  return { match, confidence, kept: confidence >= GROUND_FLOOR };
}
