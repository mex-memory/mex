/**
 * Fact-aware drift: did a change to a grounded body touch what the fact says?
 *
 * A body hash says *that* a grounded symbol changed, never *whether* the
 * sentence grounded to it is still true. Most edits to a function leave most
 * statements about it alone, and reporting every one of them as `changed`
 * buries the edits that matter. A fact names concrete things — identifiers
 * such as `parseBody` or `#dispatch`, literals such as `302` or `'HS256'` — and
 * those are the lines it depends on.
 *
 * ## The rule
 *
 * Given the entity's text, the body it was grounded to and the body now:
 *
 * 1. Collect the fact's anchors: code-like tokens from its text that also
 *    occur in the old body below its declaration line (the symbol's own name
 *    locates the grounding, not the fact). Fewer than {@link MIN_ANCHORS},
 *    no verdict.
 * 2. Diff the two bodies line by line and widen every changed line to the
 *    whole list, call or object literal it sits in (an array gaining an
 *    element touches only the new line, yet changes the array), plus
 *    {@link CONTEXT_LINES} unchanged lines on each side.
 * 3. If any widened region, old side or new side, contains an anchor, the
 *    fact's own lines were touched: `touched`.
 * 4. If any anchor occurs fewer times in the new body than in the old one,
 *    something the fact names went away: `touched`.
 * 5. Otherwise the change was elsewhere in the symbol: `nearby`.
 *
 * ## Failing safe
 *
 * `nearby` downgrades a warning, so every uncertain case says `touched`:
 * no anchors, a body too large to diff, or an anchor the diff cannot place.
 * The anchors err towards over-inclusion for the same reason — an extra anchor
 * can only turn `nearby` into `touched`.
 */

/** Unchanged lines on each side of a change that still count as part of it. */
export const CONTEXT_LINES = 2;

/**
 * Distinct anchors a fact needs inside the body before a change can be called
 * nearby. One token says little about where a fact lives — "index.ts exports
 * only RegExpRouter", grounded to the class, anchors only on the class name.
 */
export const MIN_ANCHORS = 2;

/** Bodies above this many lines are not diffed; the verdict stays `touched`. */
const MAX_DIFF_LINES = 2_000;

export type FactDrift =
  | { kind: "nearby"; anchors: string[] }
  | { kind: "touched"; anchors: string[]; reason: string };

/**
 * Words that read as code in prose but are too common in any body to anchor
 * a fact to one line.
 */
const WEAK_ANCHORS: ReadonlySet<string> = new Set([
  "if", "else", "return", "const", "let", "var", "new", "this", "true", "false", "null", "undefined",
  "function", "async", "await", "class", "export", "import", "type", "interface", "of", "in", "for",
]);

/**
 * The code-like tokens a fact names.
 *
 * - every identifier inside backticks or quotes, and the quoted text itself;
 * - identifiers that cannot be ordinary prose: the member of a dotted chain
 *   (`redirect` in `c.redirect`), calls (`next()`), private names (`#req`),
 *   and words with an inner capital, a digit, `_` or `$` (`parseBody`,
 *   `HS256`, `RETAINED_304_HEADERS`); file paths are ignored;
 * - all-capital words of two or more letters (`GET`, `METHODS`);
 * - numbers with two or more digits (`302`, `34560000`).
 */
export function factAnchors(input: string): string[] {
  // File paths name where code lives, not what it does: `src/hono.ts` would
  // otherwise anchor on `hono` and `ts`.
  const text = input.replace(/(?:[\w@.-]+\/)+[\w@.-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|cs|rb)\b/g, " ");
  const anchors = new Set<string>();
  const addIdentifiers = (fragment: string): void => {
    for (const match of fragment.matchAll(/#?[A-Za-z_$][\w$]*/g)) {
      const word = match[0];
      if (word.replace(/^#/, "").length >= 2 && !WEAK_ANCHORS.has(word)) anchors.add(word);
    }
  };

  for (const match of text.matchAll(/`([^`\n]+)`/g)) addIdentifiers(match[1]!);
  for (const match of text.matchAll(/(?<![\w])(['"])([^'"\n]{1,60})\1/g)) {
    const literal = match[2]!;
    if (literal.trim().length > 0) anchors.add(literal);
    addIdentifiers(literal);
  }

  for (const match of text.matchAll(/#?[A-Za-z_$][\w$]*(?:\.#?[A-Za-z_$][\w$]*)*(\(\))?/g)) {
    const token = match[1] === undefined ? match[0] : match[0].slice(0, -2);
    const parts = token.split(".");
    const call = match[1] !== undefined;
    for (const [index, part] of parts.entries()) {
      const bare = part.replace(/^#/, "");
      if (bare.length < 2 || WEAK_ANCHORS.has(part)) continue;
      // In `app.route()` or `c.req.parseBody()` the member is the code; the
      // receivers are conventional variable names, anchors only on their own merit.
      const member = parts.length > 1 && index === parts.length - 1;
      const codeLike = member
        || (call && index === parts.length - 1)
        || part.startsWith("#")
        || /[a-z][A-Z]/.test(bare)
        || /\d/.test(bare)
        || /[_$]/.test(bare)
        || /^[A-Z]{2,}$/.test(bare);
      if (codeLike) anchors.add(part);
    }
  }

  for (const match of text.matchAll(/(?<![\w.])\d{2,}(?![\w])/g)) anchors.add(match[0]);
  return [...anchors];
}

/** Occurrences of `anchor` in `text`, as a whole token. */
function occurrences(text: string, anchor: string): number {
  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A token boundary that treats `#`, `$` and `_` as part of a name.
  const startsWithWord = /^[\w$#]/.test(anchor);
  const endsWithWord = /[\w$]$/.test(anchor);
  const pattern = new RegExp(
    `${startsWithWord ? "(?<![\\w$#])" : ""}${escaped}${endsWithWord ? "(?![\\w$])" : ""}`,
    "g",
  );
  return text.match(pattern)?.length ?? 0;
}

/** Line equality that ignores indentation and whitespace runs. */
function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/**
 * Indices of the lines that differ between two bodies, per side, from a
 * longest-common-subsequence alignment.
 */
function changedLines(oldLines: readonly string[], newLines: readonly string[]): { removed: number[]; added: number[] } {
  const a = oldLines.map(normalizeLine);
  const b = newLines.map(normalizeLine);
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const removed: number[] = [];
  const added: number[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      removed.push(i++);
    } else {
      added.push(j++);
    }
  }
  while (i < n) removed.push(i++);
  while (j < m) added.push(j++);
  return { removed, added };
}

/**
 * For each line, the span of the outermost *expression* bracket around it —
 * an array, an argument or parameter list, an object literal — or null.
 *
 * A change inside a list belongs to the whole list: `METHODS = [ … ]` gaining
 * an element changes what "METHODS lists six methods" means even though the
 * new line names nothing. Statement blocks (`{` opening a function, `if` or
 * loop body) are not expression brackets, or every change in a function would
 * belong to its first line. Strings and line comments are skipped; anything
 * unbalanced simply widens less, and the line context still applies.
 */
function expressionSpans(lines: readonly string[]): ([number, number] | null)[] {
  const spans: ([number, number] | null)[] = lines.map(() => null);
  const stack: { char: string; line: number; expression: boolean }[] = [];
  let previous = "";
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const char = line[i]!;
      if (quote !== null) {
        if (char === "\\") i++;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        previous = char;
        continue;
      }
      if (char === "/" && line[i + 1] === "/") break;
      if (char === "(" || char === "[") {
        stack.push({ char, line: lineIndex, expression: true });
      } else if (char === "{") {
        stack.push({ char, line: lineIndex, expression: /[=(,:[?]$|return$/.test(previous) });
      } else if (char === ")" || char === "]" || char === "}") {
        const open = stack.pop();
        if (open !== undefined && open.expression && !stack.some((entry) => entry.expression)) {
          for (let k = open.line; k <= lineIndex; k++) spans[k] = [open.line, lineIndex];
        }
      }
      if (!/\s/.test(char)) previous = /[A-Za-z_$]/.test(char) ? (previous.match(/[A-Za-z_$]+$/)?.[0] ?? "") + char : char;
    }
  }
  return spans;
}

/** The changed lines of one side, each widened by its expression and {@link CONTEXT_LINES}. */
function widened(lines: readonly string[], changed: readonly number[]): string {
  const keep = new Set<number>();
  const spans = expressionSpans(lines);
  for (const index of changed) {
    const span = spans[index];
    const from = Math.min(index, span?.[0] ?? index) - CONTEXT_LINES;
    const to = Math.max(index, span?.[1] ?? index) + CONTEXT_LINES;
    for (let k = from; k <= to; k++) {
      if (k >= 0 && k < lines.length) keep.add(k);
    }
  }
  return [...keep].sort((x, y) => x - y).map((k) => lines[k]).join("\n");
}

/**
 * Whether the change from `oldBody` to `newBody` touched what `fact` names.
 * See the module note for the rule and why every doubt says `touched`.
 */
export function factDrift(fact: string, oldBody: string, newBody: string): FactDrift {
  // The declaration line names the symbol, which locates the grounding, not
  // the fact: "parse() returns the last value" anchored only to `parse` would
  // call any change to parse's body nearby. Only anchors inside the body count.
  const inside = oldBody.split("\n").slice(1).join("\n");
  const anchors = factAnchors(fact).filter((anchor) => occurrences(inside, anchor) > 0);
  if (anchors.length < MIN_ANCHORS) {
    return {
      kind: "touched",
      anchors,
      reason: anchors.length === 0
        ? "The fact names nothing that occurs in the grounded code."
        : "The fact names too little of the grounded code to tell where it lives.",
    };
  }
  for (const anchor of anchors) {
    if (occurrences(newBody, anchor) < occurrences(oldBody, anchor)) {
      return { kind: "touched", anchors, reason: `\`${anchor}\` occurs less often than when the fact was grounded.` };
    }
  }
  const oldLines = oldBody.split("\n");
  const newLines = newBody.split("\n");
  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return { kind: "touched", anchors, reason: "The grounded code is too large to compare line by line." };
  }
  const { removed, added } = changedLines(oldLines, newLines);
  const region = `${widened(oldLines, removed)}\n${widened(newLines, added)}`;
  const hit = anchors.find((anchor) => occurrences(region, anchor) > 0);
  if (hit !== undefined) {
    return { kind: "touched", anchors, reason: `The change touches a line naming \`${hit}\`.` };
  }
  return { kind: "nearby", anchors };
}
