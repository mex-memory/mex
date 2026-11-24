export const squash = (text: string) => text.replace(/\s+/gu, " ").trim();

const NEGATION = /\b(?:never|do not|don't|does not|doesn't|should not|must not|no longer|cannot|avoid)\b/giu;

function direction(text: string) {
  const lowered = text.toLowerCase().replace(/\u2019/gu, "'").replace(/`/gu, "");
  const words = (value: string) => value.replace(/\b(?:always|please|must|should|we|you|a|an|the)\b/gu, "")
    .match(/[\p{L}\p{N}_$.]+/gu)?.join(" ").replace(/\.$/u, "") ?? "";
  const negative = [...lowered.matchAll(NEGATION)].map(match => words(lowered.slice(0, match.index)));
  const statement = lowered.replace(NEGATION, " ").replace(/\binstead[.!?]?$/u, "");
  return { negative, instruction: words(statement.replace(/\b(?:invoke|call)\b/gu, "use")),
    alternatives: statement.replace(/^\s*(?:always\s+)?(?:prefer|use|call|invoke)\s+/u, "")
      .split(/\s+(?:instead of|rather than|over)\s+|,\s*not\s+/u).map(words) };
}

/** Reject explicit reversals of the same wording before using a meaning judgment. */
export function polarityMismatch(clause: string, quote: string): boolean {
  const a = direction(clause), b = direction(quote);
  if (a.instruction && a.instruction === b.instruction && JSON.stringify(a.negative) !== JSON.stringify(b.negative)) return true;
  const [useA, avoidA] = a.alternatives, [useB, avoidB] = b.alternatives;
  return a.alternatives.length === 2 && b.alternatives.length === 2 && useA === avoidB && avoidA === useB;
}

/** A quote cannot clip a negation or condition off the statement it cites. */
export function unclippedQuote(quote: string, source: string): boolean {
  const word = /[\p{L}\p{N}_$]/u;
  const restriction = /\b(?:not|no|never|don't|doesn't|cannot|avoid|without|only|unless|except|until|if|when|before|after|rather|instead of)\b/iu;
  for (let start = 0; start < source.length;) {
    const at = source.indexOf(quote, start);
    if (at < 0) break;
    const end = at + quote.length;
    start = at + 1;
    if (word.test(quote[0]!) && word.test(source[at - 1] ?? "") ||
        word.test(quote.at(-1)!) && word.test(source[end] ?? "")) continue;
    const prefix = source.slice(0, at).split(/[.!?;:]\s+/u).at(-1)!;
    if (restriction.test(prefix)) continue;
    const rest = source.slice(end);
    const suffix = rest.split(/[.!?;:](?=\s|$)/u, 1)[0]!.split(/\b(?:because|so that|such as)\b/iu, 1)[0]!;
    if (!restriction.test(suffix)) return true;

    // A complete sentence doesn't inherit an unrelated restriction from the next one.
    // Keep explicit follow-on qualifiers, pronoun references, and shared subjects in context.
    if (!/[.!?]$/u.test(quote) || !/^\s/u.test(rest)) continue;
    const next = suffix.trimStart();
    if (next.search(restriction) === 0 || /^(?:and|but|however|otherwise|this|that|it|the rule)\b/iu.test(next)) continue;
    const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}_$]{4,}/gu) ?? [];
    const cited = new Set(words(quote));
    if (!words(next).some(word => cited.has(word))) return true;
  }
  return false;
}

// An entry is an instruction an agent can follow. A claim that only describes a trap ("X does not cover
// Y") or is a review comment pasted in ("Hmm, this can blow up…") gives an agent nothing to do. OSS-92:
// 8 of 12 imprecise Hono and pip rules were one or the other.
const IMPERATIVE = new RegExp("^(?:always|never|do not|don't|avoid|prefer|use|keep|put|add|remove|mark|run|check|call|pass|return|set|"
  + "make|write|name|place|import|export|test|document|wait|ask|open|create|follow|treat|leave|limit|split|validate|guard|compare|"
  + "represent|model|reject|require|skip|handle|store|disable|enable|copy|publish|report|include|exclude|move|stop|start|ensure|give|"
  + "read|load|throw|raise|log|declare|default|match|select|parse|escape|lock|pin|bump|update|upgrade|rename|delete|drop|prioritize|"
  + "preserve|consider|implement|target|submit|wrap|catch|send|reuse|share|cache|fetch|retry|close|free|release|clean|sort|format|"
  + "convert|encode|decode|trim|normalize|resolve|append|route|register|mock|stub|assert|bind|attach|emit|apply|configure|honor|"
  + "respect|support|reserve|verify|confirm|review|discuss|coordinate|file|link|label|tag|squash|rebase|merge|commit|push|branch|"
  + "save|inspect|let|allow|accept|declare|define|depend|derive|expose|hide|initialize|install|isolate|measure|prefix|pick|choose|"
  + "when|for|in|if|to|before|after|only|once|unless)\\b", "iu");
const MODAL = /\b(?:should|must|shall|needs? to|has to|have to|instead|rather than|never|always|avoid|prefer|please)\b/iu;
const CONVENTION = /^we (?:don't|do not|never|always|only|use|keep|prefer|avoid|require|want|add|support|chose|decided)\b/iu;
// Conversational openers in any case; pronouns and conjunctions only in a sentence's lowercase fragment.
const CONVERSATIONAL = /^(?:hmm+|but|so|also|maybe|actually|well|yeah|ok(?:ay)?|nit|i think|i'd|imo|i'm)\b/iu;
const FRAGMENT = /^(?:we|it|this|that|and|or|no)\b/u;

// Openings of a description rather than an instruction: an article, a pronoun or a gerund.
const DESCRIBING = /^(?:the|a|an|this|that|these|those|it|its|there|[a-z]+ing)\b/iu;

/**
 * A pitfall must say what to do: every imprecise pitfall in OSS-92 only described its trap. Other
 * kinds read as instructions unless they open like a description, since an imperative list is never complete.
 */
export function statesAction(claim: string, kind?: string): boolean {
  const text = squash(claim);
  if (IMPERATIVE.test(text) || MODAL.test(text) || CONVENTION.test(text)) return true;
  return kind !== "pitfall" && !DESCRIBING.test(text);
}

/** A claim that opens like a comment, in lowercase or with a conversational word, was pasted from one. */
export function readsAsComment(claim: string): boolean {
  const text = squash(claim);
  return CONVERSATIONAL.test(text) || FRAGMENT.test(text);
}
