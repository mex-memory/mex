/** Function words that add noise to code-symbol lookup. */
const STOP_WORDS = new Set([
  "a",
  "all",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "by",
  "did",
  "do",
  "does",
  "every",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "in",
  "is",
  "it",
  "its",
  "me",
  "of",
  "on",
  "or",
  "please",
  "show",
  "some",
  "tell",
  "that",
  "the",
  "these",
  "this",
  "those",
  "to",
  "us",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "why",
  "with",
  "without",
  "work",
  "would",
]);

/** Lower-case an identifier while retaining characters meaningful in code names. */
export function normalizeIdentifier(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_$]+/g, "");
}

/**
 * Return the complete identifier and its snake/kebab/camel-case components.
 * `BudgetLedger` therefore matches both `budget` and `ledger`, while
 * `mark_failed!` retains the useful full term `mark_failed` too.
 */
export function identifierComponents(raw: string): string[] {
  const expanded = raw
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const full = normalizeIdentifier(raw);
  const parts = expanded
    .split(/[^A-Za-z0-9$]+|_/)
    .map(normalizeIdentifier)
    .filter((part) => part.length >= 2);
  return [...new Set([full, ...parts].filter((part) => part.length >= 2))];
}

export function isStopWord(raw: string): boolean {
  return STOP_WORDS.has(normalizeIdentifier(raw));
}

/** Extract stable code-oriented terms from a natural-language query. */
export function extractQueryTerms(query: string): string[] {
  const all = query
    .split(/\s+/)
    .flatMap(identifierComponents)
    .filter((term) => term.length >= 2);
  const meaningful = all.filter((term) => !STOP_WORDS.has(term));
  // Never turn a query composed entirely of common words into an empty query.
  return [...new Set(meaningful.length > 0 ? meaningful : all)];
}

export type NameMatchQuality = "exact" | "component" | "none";

/** Classify whether a query term names a symbol exactly or via a component. */
export function nameMatchQuality(name: string, term: string): NameMatchQuality {
  const normalizedTerm = normalizeIdentifier(term);
  if (!normalizedTerm) return "none";
  if (normalizeIdentifier(name) === normalizedTerm) return "exact";
  return identifierComponents(name).includes(normalizedTerm) ? "component" : "none";
}
