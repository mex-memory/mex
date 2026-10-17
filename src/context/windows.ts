/**
 * Cutting a prompt into scoring windows.
 *
 * The frozen lexical score is normalised by the weight of every query term, so
 * a long task description (context, what was tried, several sub-questions, a
 * closing instruction) drives the normalised score down however well one of its
 * sentences matches an entry. Scoring sentence-sized windows, each against its
 * own weight, keeps the score comparable with the short questions the gate was
 * calibrated on. A prompt short enough to be one window is returned untouched,
 * so its ranking is exactly what it was before windows existed.
 */

import { WINDOWING, type WindowParams } from "./frozen.js";

const wordCount = (text: string): number => (text.trim() === "" ? 0 : text.trim().split(/\s+/).length);

/** Sentences and lines, in order. A full stop inside a name or number does not end a sentence. */
function segments(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    for (const part of line.split(/(?<=[.?!:])\s+(?=[A-Z"'`(\[])/)) {
      const trimmed = part.trim();
      if (trimmed !== "") out.push(trimmed);
    }
  }
  return out;
}

/** Merge segments shorter than `minWords` into a neighbour, and cut any longer than `capWords`. */
function shaped(parts: readonly string[], params: WindowParams): string[] {
  const merged: string[] = [];
  let carry = "";
  for (const part of parts) {
    const joined = carry === "" ? part : `${carry} ${part}`;
    if (wordCount(joined) < params.minWords) {
      carry = joined;
    } else {
      merged.push(joined);
      carry = "";
    }
  }
  if (carry !== "") {
    if (merged.length > 0) merged[merged.length - 1] = `${merged[merged.length - 1]} ${carry}`;
    else merged.push(carry);
  }
  const cut: string[] = [];
  for (const part of merged) {
    const words = part.split(/\s+/);
    if (words.length <= params.capWords) {
      cut.push(part);
      continue;
    }
    for (let at = 0; at < words.length; at += params.capWords) cut.push(words.slice(at, at + params.capWords).join(" "));
  }
  return cut;
}

/**
 * The texts to score. One element (the prompt itself) when the prompt is at most
 * `singleMaxWords` words; otherwise overlapping runs of consecutive sentences of
 * at most `capWords` words, each starting at a different sentence, with a run
 * that a longer run already contains left out.
 */
export function promptWindows(prompt: string, params: WindowParams = WINDOWING): string[] {
  if (wordCount(prompt) <= params.singleMaxWords) return [prompt];
  const parts = shaped(segments(prompt), params);
  if (parts.length <= 1) return [prompt];
  const sizes = parts.map(wordCount);

  const sliding: string[] = [];
  let lastEnd = -1;
  for (let start = 0; start < parts.length; start += 1) {
    let end = start;
    let words = 0;
    while (end < parts.length && (end === start || words + sizes[end]! <= params.capWords)) {
      words += sizes[end]!;
      end += 1;
    }
    if (end === lastEnd) continue;
    lastEnd = end;
    sliding.push(parts.slice(start, end).join(" "));
  }
  if (sliding.length <= params.maxWindows) return sliding;

  // Too many overlapping runs: pack the sentences once, without overlap.
  const packed: string[] = [];
  let current: string[] = [];
  let currentWords = 0;
  parts.forEach((part, k) => {
    if (current.length > 0 && currentWords + sizes[k]! > params.capWords) {
      packed.push(current.join(" "));
      current = [];
      currentWords = 0;
    }
    current.push(part);
    currentWords += sizes[k]!;
  });
  if (current.length > 0) packed.push(current.join(" "));
  return packed.slice(0, params.maxWindows);
}
