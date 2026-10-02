/**
 * What a grounded node's code is, with its comments set aside (#236).
 *
 * `bodyHash` is the change signal grounding drift compares, and it hashes the
 * node's source text with whitespace runs collapsed — so a re-indent is not
 * drift, but a comment added inside a function is. Comment and doc passes are
 * common, and each one used to raise `GROUNDING_DRIFT`, a warning that only an
 * explicit review clears. `codeHash` is the second, coarser signal that lets
 * the checker say "only comments changed" instead.
 *
 * ## What is hashed
 *
 * The exact text of every token the file's own parser places inside the
 * node's line span, in order, except comments. Identifiers, literals and
 * string contents are all code: an edited constant or a changed string still
 * moves the hash. A Python docstring is a string expression, not a comment, so
 * editing one is still drift.
 *
 * The whole file is parsed, not the node's slice, so a method is read in its
 * class and a nested function in its parent; a slice parsed alone would be
 * full of recovery errors.
 *
 * ## Failing safe
 *
 * The verdict this feeds — "only comments changed" — is the one that must
 * never be wrong, because it downgrades a warning. So anything uncertain
 * returns null and the caller keeps the full warning: no grammar for the
 * language, a parse error or missing token inside the span, or a span with no
 * code at all. Two bodies are called comment-only different only when both
 * hashes exist and are equal.
 */

import { createHash } from "node:crypto";
import { detectLanguage, disposeTree, loadGrammars, parse, supportedLanguages } from "./extraction/grammars.js";
import type { TSNode } from "./extraction/types.js";

/** The comment node types of every grammar the graph ships (Rust splits line and block). */
const COMMENT_TYPES: ReadonlySet<string> = new Set(["comment", "line_comment", "block_comment"]);

/** Load every grammar `codeHash` may need. Cheap (tens of milliseconds) and idempotent. */
export async function prepareCodeHashing(): Promise<void> {
  await loadGrammars(supportedLanguages());
}

/**
 * Hash of the non-comment tokens inside lines `startLine..endLine` (1-based,
 * inclusive) of `source`, parsed as the language `filePath` names. Null when
 * that cannot be said with certainty; see the module note.
 */
export function codeHash(filePath: string, source: string, startLine: number, endLine: number): string | null {
  const tree = parse(source, detectLanguage(filePath));
  if (tree === null) return null;
  try {
    const tokens: string[] = [];
    let uncertain = false;
    const visit = (node: TSNode): void => {
      if (uncertain) return;
      const first = node.startPosition.row + 1;
      const last = node.endPosition.row + 1;
      if (last < startLine || first > endLine) return;
      if (COMMENT_TYPES.has(node.type)) return;
      if (node.isError === true || node.isMissing === true) {
        uncertain = true;
        return;
      }
      if (node.childCount === 0) {
        // The same span rule the fingerprint's token stream uses: a token
        // counts only when it lies wholly inside the node's lines.
        if (first >= startLine && last <= endLine) tokens.push(node.text);
        return;
      }
      for (const child of node.children) visit(child);
    };
    visit(tree.rootNode);
    if (uncertain || tokens.length === 0) return null;
    return createHash("sha256").update(JSON.stringify(tokens)).digest("hex");
  } finally {
    disposeTree(tree);
  }
}

/** {@link codeHash} of a node's body on its own, for a baseline only its old body text survives for. */
export function codeHashOfBody(filePath: string, body: string): string | null {
  return codeHash(filePath, body, 1, body.split("\n").length);
}

/**
 * How `codeHash` is committed: `ch1:<first 12 hex of bodyHash>:<code hash>`.
 *
 * **Bound to the `bodyHash` it was captured with.** The two must describe one
 * moment, and nothing else in the Markdown says whether they do: a version
 * that predates `codeHash` renews `bodyHash` on an accepted review and leaves
 * the old `codeHash` beside it, and a hand edit can do the same. An unbound
 * code hash would then be compared against the wrong baseline and could call
 * a real change comment-only. The prefix makes that pair detectably stale, and
 * a stale one is read as absent — the full warning, never a guess.
 */
const COMMITTED_CODE_HASH = /^ch1:([0-9a-f]{12}):([0-9a-f]{64})$/;
const BODY_BINDING_LENGTH = 12;

/** The committed form of `code` (a {@link codeHash}), bound to `bodyHash`. */
export function formatCommittedCodeHash(code: string, bodyHash: string): string {
  return `ch1:${bodyHash.slice(0, BODY_BINDING_LENGTH)}:${code}`;
}

/** The code hash a committed value carries, or null unless it is well formed and bound to `bodyHash`. */
export function committedCodeHash(value: string | undefined, bodyHash: string | undefined): string | null {
  if (value === undefined || bodyHash === undefined) return null;
  const match = COMMITTED_CODE_HASH.exec(value);
  if (match === null || !bodyHash.startsWith(match[1]!)) return null;
  return match[2]!;
}
