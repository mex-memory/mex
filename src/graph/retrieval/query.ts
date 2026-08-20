/** Query planning shared by graph search and scope assembly. */

export interface PlannedTerm {
  /** Lowercase search token. */
  term: string;
  /** Token exactly as the user typed it. */
  raw: string;
  /** Distinctive identifiers are safe to treat as explicit symbol names. */
  identifierLike: boolean;
  /** Stems broaden recall but carry less evidence than literal query terms. */
  stem: boolean;
  /** Relative contribution to coverage and lexical scoring. */
  weight: number;
}

export interface GraphQueryPlan {
  raw: string;
  terms: PlannedTerm[];
  explicitIdentifiers: string[];
  asksForTests: boolean;
}

/** English and code-question boilerplate that carries no repository signal. */
export const GRAPH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by",
  "can", "could", "did", "do", "does", "each", "every", "for", "from",
  "give", "had", "has", "have", "how", "i", "if", "in", "into", "is",
  "it", "its", "just", "may", "me", "might", "more", "my", "need", "no",
  "not", "of", "on", "only", "or", "our", "out", "should", "show", "so",
  "some", "such", "tell", "than", "that", "the", "their", "them", "then",
  "there", "these", "they", "this", "those", "to", "up", "us", "used",
  "using", "want", "was", "we", "what", "when", "where", "which", "who",
  "why", "will", "with", "work", "works", "would", "you", "your",
]);

/** Generic code vocabulary is useful, but much less discriminative than domain words. */
const LOW_SIGNAL_WORDS = new Set([
  "agent", "called", "class", "code", "declaration", "declarations", "file",
  "files", "function", "graph", "method", "node", "nodes", "object", "search",
  "source", "symbol", "symbols", "task",
]);

/** Whether a token looks deliberately identifier-shaped as the user typed it. */
export function isDistinctiveIdentifier(token: string): boolean {
  // A hyphen by itself is ordinary English punctuation as often as it is code:
  // `command-line`, `watch-mode`, and `source-file` must remain NL concepts.
  // Paths, extensions, private names, and qualified names are unambiguous
  // enough to pin. A hyphenated token carrying one of the other code-shape
  // signals below (snake/camel case, digits, qualification) still qualifies.
  if (/[/\\]/.test(token)) return true;
  if (/^#[A-Za-z_$]/.test(token)) return true;
  if (/[A-Za-z0-9_$](?:\.|::|#)[A-Za-z0-9_$]/.test(token)) return true;
  if (/[_$0-9]/.test(token)) return true;
  if (/^[A-Z][A-Za-z0-9]*$/.test(token)) return true;
  return /[A-Z]/.test(token.slice(1));
}

/**
 * Preserve a compound identifier and expose its camelCase/snake_case components.
 * `BudgetLedger` becomes `budgetledger`, `budget`, `ledger`.
 */
export function identifierComponents(raw: string): string[] {
  const fragments = raw.split(/[/\\.:#-]+/).filter(Boolean);
  if (fragments.length > 1 || /[/\\.:#-]/.test(raw)) {
    return [...new Set(fragments.flatMap(identifierFragmentComponents))];
  }
  return identifierFragmentComponents(raw);
}

function identifierFragmentComponents(raw: string): string[] {
  const cleaned = raw.replace(/[^A-Za-z0-9_$]/g, "").replace(/^[$_]+|[$_]+$/g, "");
  if (!cleaned) return [];
  const whole = cleaned.toLowerCase();
  const split = cleaned
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_$]+/g, " ")
    .split(/\s+/)
    .map((entry) => entry.toLowerCase())
    .filter((entry) => entry.length >= 2);
  return [...new Set([whole, ...split])];
}

/** Conservative suffix stemming for identifier-oriented prefix search. */
export function stemVariants(term: string): string[] {
  const out = new Set<string>();
  const add = (value: string): void => {
    if (value.length >= 3 && value !== term) out.add(value);
  };
  if (term.endsWith("ing") && term.length > 5) {
    const base = term.slice(0, -3);
    add(base);
    add(`${base}e`);
    if (base.at(-1) === base.at(-2)) add(base.slice(0, -1));
  }
  if ((term.endsWith("tion") || term.endsWith("sion")) && term.length >= 9) {
    // Derivational nouns often describe code whose identifier uses a related
    // stem: configuration -> config, compilation -> compiler, resolution ->
    // resolver. A five-character prefix is deliberately conservative: it is
    // long enough for identifier prefix matching, while avoiding a synonym
    // table or aggressive linguistic guessing. The planner weights it below
    // ordinary inflectional stems.
    add(term.slice(0, 5));
  }
  if (term.endsWith("ment") && term.length > 6) add(term.slice(0, -4));
  if (term.endsWith("ies") && term.length > 4) add(`${term.slice(0, -3)}y`);
  else if (/(?:sses|xes|zes|ches|shes|oes)$/.test(term) && term.length > 4) add(term.slice(0, -2));
  else if (term.endsWith("s") && !term.endsWith("ss") && term.length > 4) add(term.slice(0, -1));
  if (term.endsWith("ed") && term.length > 4) {
    add(term.slice(0, -1));
    add(term.slice(0, -2));
  }
  return [...out];
}

/** Turn a natural-language task into bounded, weighted index terms. */
export function planGraphQuery(raw: string): GraphQueryPlan {
  const sourceTokens = raw.match(/[#A-Za-z_$][#A-Za-z0-9_$.:/\\-]*/g) ?? [];
  const terms = new Map<string, PlannedTerm>();
  const explicitIdentifiers: string[] = [];

  const add = (entry: PlannedTerm): void => {
    if (entry.term.length < 2 || GRAPH_STOP_WORDS.has(entry.term)) return;
    const current = terms.get(entry.term);
    if (!current || entry.weight > current.weight) terms.set(entry.term, entry);
  };

  for (const rawToken of sourceTokens.slice(0, 40)) {
    const distinctive = isDistinctiveIdentifier(rawToken);
    const stronglyCodeShaped = /[/\\.:#_$0-9]/.test(rawToken)
      || (!/^[A-Z]+$/.test(rawToken) && /[A-Z]/.test(rawToken.slice(1)));
    const components = identifierComponents(rawToken);
    if (components.length === 0) continue;
    if (distinctive && components.some((component) => !GRAPH_STOP_WORDS.has(component))) {
      explicitIdentifiers.push(rawToken);
    }
    for (const [index, term] of components.entries()) {
      const lowSignal = LOW_SIGNAL_WORDS.has(term);
      add({
        term,
        raw: rawToken,
        identifierLike: distinctive && index === 0,
        stem: false,
        weight: distinctive && index === 0 ? (stronglyCodeShaped ? 2 : 1.15) : lowSignal ? 0.35 : 1,
      });
      if (index > 0 || components.length === 1) {
        for (const stem of stemVariants(term)) {
          const derivationalPrefix = /(?:tion|sion)$/.test(term)
            && term.length >= 9 && stem === term.slice(0, 5);
          add({
            term: stem,
            raw: rawToken,
            identifierLike: false,
            stem: true,
            weight: derivationalPrefix ? (lowSignal ? 0.08 : 0.2) : lowSignal ? 0.15 : 0.55,
          });
        }
      }
    }
  }

  // A stopword-only query should produce a legitimate empty result, not match everything.
  return {
    raw,
    terms: [...terms.values()].slice(0, 32),
    explicitIdentifiers: [...new Set(explicitIdentifiers)].slice(0, 16),
    asksForTests: /\b(test|tests|testing|spec|specs|verify|verification)\b/i.test(raw),
  };
}

/** Test, fixture, example, benchmark, generated, and other non-production paths. */
export function isLowValueGraphPath(filePath: string): boolean {
  const path = filePath.toLowerCase();
  return (
    /(^|\/)(__tests?__|tests?|specs?|fixtures?|examples?|samples?|benchmarks?|demos?|mocks?|testdata|integration)(\/|$)/.test(path)
    || /\.(test|spec)\.[^/]+$/.test(path)
    || /(^|\/)test_[^/]+\.[^/]+$/.test(path)
    || /_test\.[^/]+$/.test(path)
    || /(^|\/)evaluate\//.test(path)
    || /(^|\/)(generated|vendor)\//.test(path)
    || /(?:^|\/).*(?:\.generated|\.gen|\.pb)\.[^/]+$/.test(path)
  );
}
