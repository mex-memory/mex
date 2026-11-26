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

const RESTRICTION = /\b(?:not|no|never|don['’]t|doesn['’]t|can['’]t|cannot|won['’]t|shouldn['’]t|mustn['’]t|avoid|without|only|unless|except(?:ion)?|otherwise|until|if|when|before|after|rather|instead)\b/iu;
const WORD = /[\p{L}\p{N}_$]/u;
const LIST = /^[ \t]*(?:[-+*]|\d+[.)]|#\.)[ \t]+/u;
const HEADING = /^ {0,3}(?:#{1,6}|={1,6})[ \t]+/u;
const UNDERLINE = /^[ \t]*(?:-{3,}|={3,}|~{3,}|\^{3,}|_{3,})[ \t]*$/u;
const FOLLOW_ON = /^(?:but\s+only|only\s+(?:if|when|in|on|for|with|after|before)|unless|except|otherwise|(?:(?:one|the(?:\s+only)?)\s+)?exception)\b/iu;
const SENTENCES = new Intl.Segmenter("en", { granularity: "sentence" });
const INLINE_CODE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu;

interface Span { start: number; end: number }

/** Keep wrapped prose and explicit continuations together, and start fresh at unrelated list items. */
function quoteBlocks(source: string): Span[] {
  const lines = source.split("\n");
  const blocks: Span[] = [];
  let offset = 0, blank = false;
  let block: Span | undefined;
  for (const [index, line] of lines.entries()) {
    const start = offset;
    offset += line.length + 1;
    const text = line.trimEnd();
    if (!text) { blank = true; continue; }
    const end = start + text.length;
    const item = LIST.exec(text);
    if (HEADING.test(text) || UNDERLINE.test(text) || !item && UNDERLINE.test(lines[index + 1] ?? "")) {
      blocks.push({ start, end });
      block = undefined;
      blank = false;
      continue;
    }
    const continuation = FOLLOW_ON.test(text.slice(item?.[0].length ?? 0).trimStart().replace(/^[*_]+/u, ""));
    if (!block || (item || blank) && !continuation) {
      block = { start, end };
      blocks.push(block);
    } else block.end = end;
    blank = false;
  }
  return blocks;
}

function sentenceSpans(source: string, block: Span): Span[] {
  // Preserve source offsets while hiding punctuation in code, list numbers and soft line breaks.
  const text = source.slice(block.start, block.end)
    .replace(INLINE_CODE, code => code.replace(/[.!?]/gu, "x"))
    .replace(/^[ \t]*(?:\d+[.)]|#\.)[ \t]+/gmu, marker => marker.replace(".", " "))
    .replace(/\s/gu, " ");
  return [...SENTENCES.segment(text)].map(({ index, segment }) =>
    ({ start: block.start + index, end: block.start + index + segment.trimEnd().length }));
}

function qualifies(next: string, quote: string): boolean {
  const text = squash(next.replace(LIST, "")).replace(/^[*_]+/u, "");
  if (FOLLOW_ON.test(text)) return true;
  // Look for references and shared words in the leading clause of the next sentence.
  const lead = text.split(/[;:](?=\s|$)|\b(?:because|so that|such as)\b/iu, 1)[0]!;
  if (!RESTRICTION.test(lead)) return false;
  if (lead.search(RESTRICTION) === 0 || /^(?:and|but|however|this|that|it|the rule)\b/iu.test(lead)) return true;
  const words = (value: string) => value.toLowerCase().match(/[\p{L}\p{N}_$]{4,}/gu) ?? [];
  const cited = new Set(words(quote));
  return words(lead).some(word => cited.has(word));
}

function* quoteContexts(quote: string, source: string, exact: boolean) {
  if (!quote.trim()) return;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = exact ? escape(quote) : quote.trim().split(/\s+/u).map(escape).join("\\s+");
  const matches = source.matchAll(new RegExp(`(?=(${pattern}))`, "gu"));
  let layout: ReturnType<typeof quoteBlocks> | undefined;
  for (const match of matches) {
    const at = match.index, found = match[1]!, end = at + found.length;
    if (WORD.test(found[0]!) && WORD.test(source[at - 1] ?? "") ||
        WORD.test(found.at(-1)!) && WORD.test(source[end] ?? "")) continue;
    const blocks = layout ??= quoteBlocks(source);
    const first = blocks.find(block => block.end > at);
    const last = blocks.find(block => block.end >= end);
    if (!first || !last) continue;
    const starts = sentenceSpans(source, first);
    const ends = first === last ? starts : sentenceSpans(source, last);
    const head = starts.find(sentence => sentence.end > at);
    const tail = ends.findIndex(sentence => sentence.end >= end);
    if (!head || tail < 0) continue;
    const lastSentence = ends[tail]!;
    const suffix = source.slice(end, lastSentence.end);
    const next = ends[tail + 1];
    const clipped = RESTRICTION.test(source.slice(head.start, at)) || RESTRICTION.test(suffix)
      || next !== undefined && qualifies(source.slice(next.start, next.end), found);
    yield { clipped };
  }
}

/** A quote cannot clip a negation or condition off the statement it cites. */
export function unclippedQuote(quote: string, source: string, exact = false): boolean {
  for (const { clipped } of quoteContexts(quote, source, exact)) if (!clipped) return true;
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
