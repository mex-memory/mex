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
