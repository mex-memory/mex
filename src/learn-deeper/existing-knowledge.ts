import { KnowledgeError, parseEntry } from "../knowledge/entry.js";
import { getTextContent, parseMarkdown } from "../markdown.js";
import type { PinnedTree } from "./git.js";

const MAX_FILES = 128;
const MAX_BYTES = 512 << 10;
const MAX_PASSAGES = 4096;
const MAX_WORDS = 130;
const STOP = new Set(("a an and are as at be been before being both but by can cannot could did do does each either else even every "
  + "for from had has have here how if in include including into is it its keep may more must no nor not of on once only or other "
  + "our out over rather re same should so some such than that the their them then there therefore these they this those through "
  + "to together under until up use used using via was we were what when where whether which while who will with without would you your").split(" "));
const NEGATION = new Set(["cannot", "never", "not", "without"]);
const ENDINGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:ies|ied)$/u, "y"], [/ations?$/u, "at"], [/(?:ing|ed|es|s)$/u, ""],
];

function stem(word: string): string {
  for (const [ending, suffix] of ENDINGS) {
    const shortened = word.replace(ending, suffix);
    if (shortened.length >= 3 && shortened !== word) return shortened.replace(/(\w)\1$/u, "$1");
  }
  return word;
}

function orderedWords(text: string): string[] {
  return text.normalize("NFKC")
    .replace(/(?<=[\p{Ll}\d])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/gu, " ")
    .toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function normalized(text: string): string {
  return text.normalize("NFKC").replace(/`/gu, "").replace(/\s+/gu, " ").trim().toLowerCase().replace(/[.!?]$/u, "");
}

interface Phrases {
  words: Set<string>;
  pairs: Set<string>;
  neighbors: Set<string>;
  negated: Set<string>;
}

function phrases(text: string): Phrases {
  const words: string[] = [];
  const negative: number[] = [];
  for (const word of orderedWords(text)) {
    if (NEGATION.has(word)) negative.push(words.length);
    else if (word.length > 1 && !STOP.has(word)) words.push(stem(word));
  }
  const pairs = new Set<string>(), neighbors = new Set<string>(), negated = new Set<string>();
  const pair = (i: number) => words[i] + " " + words[i + 1];
  for (let i = 0; i + 1 < words.length; i++) {
    pairs.add(pair(i));
    for (const next of words.slice(i + 1, i + 3)) neighbors.add([words[i], next].sort().join(" "));
  }
  for (const i of negative) if (i + 1 < words.length) negated.add(pair(i));
  return { words: new Set(words), pairs, neighbors, negated };
}

function numbers(text: string): string[] {
  return (text.toLowerCase().match(/\bv?\d+\.\d+(?:\.(?:\d+|x))?|\b\d+\s*(?:%|(?:ms|seconds?|days?|mib|gib)\b)/gu) ?? [])
    .map(value => value.replace(/^v|\s+/gu, ""));
}

function intersection(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const term of left) if (right.has(term)) count++;
  return count;
}

function contradicts(left: Phrases, right: Phrases): boolean {
  for (const pair of left.negated) if (right.pairs.has(pair) && !right.negated.has(pair)) return true;
  return false;
}

/** Compare neighboring prose/list items under one heading, not a whole topic or file. */
function* passages(raw: string): Iterable<string> {
  const sections: { heading: string; blocks: string[] }[] = [{ heading: "", blocks: [] }];
  let section = sections[0];
  for (const node of parseMarkdown(raw).children) {
    if (node.type === "heading") {
      section = { heading: getTextContent(node), blocks: [] };
      sections.push(section);
    } else if (node.type === "list") {
      section.blocks.push(...node.children.map(item => item.children.map(getTextContent).join(" ")));
    } else if (node.type === "paragraph" || node.type === "blockquote") {
      section.blocks.push(getTextContent(node));
    }
  }
  for (const { heading, blocks } of sections) {
    for (let start = 0; start < blocks.length; start++) {
      for (let end = start + 1; end <= Math.min(start + 4, blocks.length); end++) {
        const text = blocks.slice(start, end).join(" ");
        if (orderedWords(text).length > MAX_WORDS * 2) break;
        yield text;
        if (heading) yield heading + " " + text;
      }
    }
  }
}

/** Local lexical deduplication. Existing knowledge never enters a model prompt or receipt. */
export function duplicateMatcher(documents: readonly string[]): (text: string, oneLine: string) => boolean {
  const corpus: { terms: Phrases; numeric: string[] }[] = [];
  const exact = new Set<string>();
  const frequency = new Map<string, number>();
  for (const document of documents) {
    for (const passage of passages(document)) {
      const key = normalized(passage);
      if (!key || exact.has(key)) continue;
      const terms = phrases(passage);
      if (terms.words.size > MAX_WORDS) continue;
      exact.add(key);
      corpus.push({ terms, numeric: numbers(passage) });
      for (const word of terms.words) frequency.set(word, (frequency.get(word) ?? 0) + 1);
      if (corpus.length >= MAX_PASSAGES) break;
    }
    if (corpus.length >= MAX_PASSAGES) break;
  }
  // Smooth document frequency so a small wiki does not overvalue one-off words.
  const weight = (word: string) => 1 + Math.log1p(corpus.length / (10 + (frequency.get(word) ?? 0)));
  const total = (words: Set<string>) => [...words].reduce((sum, word) => sum + weight(word), 0);
  const weighted = corpus.map(item => ({ ...item, size: total(item.terms.words) }));

  return (text, oneLine) => {
    if (exact.has(normalized(text))) return true;
    const claim = phrases(text), headline = phrases(oneLine);
    if (claim.words.size < 5 || !headline.words.size) return false;
    const claimSize = total(claim.words), headlineSize = total(headline.words);
    const anchors = new Set([...claim.pairs, ...headline.pairs]);
    const nearby = new Set([...claim.neighbors, ...headline.neighbors]);
    const numeric = numbers(text + " " + oneLine);
    for (const { terms, size, numeric: knownNumbers } of weighted) {
      const overlap = [...claim.words].filter(word => terms.words.has(word));
      if (overlap.length < 5 || numeric.some(value => !knownNumbers.includes(value))) continue;
      const ordered = intersection(anchors, terms.pairs);
      if (!ordered || contradicts(headline, terms) || contradicts(terms, headline)) continue;
      const shared = total(new Set(overlap));
      const coverage = 0.55 * shared / claimSize
        + 0.45 * total(new Set([...headline.words].filter(word => terms.words.has(word)))) / headlineSize;
      const density = 2 * shared / (claimSize + size);
      // Reward nearby terms and exact phrases as well as shared rare words.
      // This keeps incidental topic overlap from suppressing a new claim.
      const score = coverage * (0.7 + 0.3 * density) + Math.min(0.075, 0.02 * ordered)
        + Math.min(0.045, 0.009 * intersection(nearby, terms.neighbors));
      if (score >= 0.33) return true;
    }
    return false;
  };
}

export async function existingKnowledge(tree: PinnedTree): Promise<ReturnType<typeof duplicateMatcher>> {
  const paths = tree.knowledgePaths().slice(0, MAX_FILES);
  const documents: string[] = [];
  let bytes = 0;
  for (let start = 0; start < paths.length && bytes < MAX_BYTES; start += 8) {
    const raws = await Promise.all(paths.slice(start, start + 8).map(async path => {
      const raw = await tree.readKnowledge(path);
      if (raw === undefined || !path.startsWith("learned/")) return raw;
      try {
        const entry = parseEntry(raw);
        return entry.mex.status === "active" && entry.mex.kind !== "hint" ? entry.text : undefined;
      } catch (error) {
        if (!(error instanceof KnowledgeError)) throw error;
        return undefined;
      }
    }));
    for (const raw of raws) {
      if (raw === undefined || bytes + Buffer.byteLength(raw) > MAX_BYTES) continue;
      documents.push(raw);
      bytes += Buffer.byteLength(raw);
    }
  }
  return duplicateMatcher(documents);
}
