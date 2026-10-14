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
  return tokenHash(filePath, source, startLine, endLine, false);
}

/**
 * {@link codeHash} with layout set aside as well: statement semicolons,
 * trailing commas before a closing bracket and the choice of quote character
 * are dropped, so a formatter pass (a Prettier upgrade adding trailing commas,
 * a switch from double to single quotes) is not drift. Every identifier,
 * literal value, operator and bracket still counts. Null when uncertain, like
 * `codeHash`.
 */
export function layoutHash(filePath: string, source: string, startLine: number, endLine: number): string | null {
  return tokenHash(filePath, source, startLine, endLine, true);
}

/** Leaves a formatter adds or removes without changing what the code does. */
const CLOSING = new Set([")", "]", "}", ">"]);
const QUOTES = new Set(['"', "'"]);

function tokenHash(filePath: string, source: string, startLine: number, endLine: number, layout: boolean): string | null {
  const tree = parse(source, detectLanguage(filePath));
  if (tree === null) return null;
  try {
    const tokens: string[] = [];
    const layoutTokens: LayoutToken[] = [];
    let uncertain = false;
    const visit = (node: TSNode, ancestry = ""): void => {
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
        if (first >= startLine && last <= endLine) {
          tokens.push(node.text);
          if (layout) {
            const parent = node.parent;
            layoutTokens.push({ text: node.text, role: ancestry,
              optionalSemicolon: parent !== null && (OPTIONAL_SEMICOLON.has(parent.type)
                || parent.type === "class_body"
                || (parent.type === "empty_statement" && parent.parent?.type === "class_body")) });
          }
        }
        return;
      }
      // A fixed-size digest of the grammar path avoids retaining an unbounded
      // ancestry string per token in deeply nested source.
      const childAncestry = layout ? createHash("sha256").update(ancestry).update("\0").update(node.type).digest("hex") : "";
      for (const child of node.children) visit(child, childAncestry);
    };
    visit(tree.rootNode);
    if (uncertain || tokens.length === 0) return null;
    const hashed = layout ? withoutLayout(layoutTokens) : tokens;
    return createHash("sha256").update(JSON.stringify(hashed)).digest("hex");
  } finally {
    disposeTree(tree);
  }
}

interface LayoutToken { text: string; role: string; optionalSemicolon: boolean }

// Never discard the empty statement in `if (enabled); run()`, nor the
// separators of `for (;;)`; both are behavior, despite being semicolons.
const OPTIONAL_SEMICOLON = new Set(["expression_statement", "return_statement", "throw_statement",
  "break_statement", "continue_statement", "lexical_declaration", "variable_declaration",
  "type_alias_declaration", "import_statement", "export_statement", "public_field_definition"]);

function withoutLayout(tokens: readonly LayoutToken[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.text === ";" && token.optionalSemicolon) continue;
    if (token.text === "," && CLOSING.has(tokens[index + 1]?.text ?? "")) continue;
    // Grammar ancestry keeps ASI and control-flow changes visible even when
    // the leaf token spellings are unchanged. Only this ephemeral layout hash
    // changes; committed code hashes retain their existing representation.
    out.push(`${token.role}:${QUOTES.has(token.text) ? "'" : token.text}`);
  }
  return out;
}

/** {@link codeHash} of a node's body on its own, for a baseline only its old body text survives for. */
export function codeHashOfBody(filePath: string, body: string): string | null {
  return codeHash(filePath, body, 1, body.split("\n").length);
}

/**
 * Hash a node body read on its own, as {@link codeHash} or {@link layoutHash}.
 *
 * A method or a nested function does not parse as a file of its own, so when
 * the plain slice is uncertain it is parsed again inside a class body, and
 * only its own lines are hashed. Callers compare two bodies hashed by this
 * same function, so both sides go through the same wrapping; a body that only
 * parses one way on one side compares unequal, which keeps the warning.
 */
export function bodyTokenHash(filePath: string, body: string, layout: boolean): string | null {
  const lines = body.split("\n").length;
  const plain = tokenHash(filePath, body, 1, lines, layout);
  if (plain !== null) return plain;
  const language = detectLanguage(filePath);
  if (language === "python") {
    return tokenHash(filePath, `class __mex_body__:\n${body}`, 2, lines + 1, layout);
  }
  if (language === "unknown") return null;
  return tokenHash(filePath, `class __mex_body__ {\n${body}\n}`, 2, lines + 1, layout);
}

/**
 * A body's layout hash with only its outer declaration's name set aside.
 *
 * This proves a declaration-only rename, never a renamed local, parameter,
 * recursive reference, or literal change. It requires a grammar-recognized name
 * on the body's first line; unfamiliar declarations conservatively return null.
 */
export function declarationRenameHash(filePath: string, body: string): string | null {
  const language = detectLanguage(filePath);
  const attempts = [{ source: body, first: 0 }];
  if (language === "python") attempts.push({ source: `class __mex_body__:\n${body}`, first: 1 });
  else if (language !== "unknown") attempts.push({ source: `class __mex_body__ {\n${body}\n}`, first: 1 });
  const declarations = ["function_declaration", "generator_function_declaration", "method_definition",
    "class_declaration", "function_definition", "class_definition", "function_item", "method_declaration"];
  for (const { source, first } of attempts) {
    const tree = parse(source, language);
    if (tree === null) continue;
    try {
      if (tree.rootNode.hasError === true) continue;
      const candidates = tree.rootNode.descendantsOfType(declarations)
        .filter((node) => node.startPosition.row === first);
      // A nested declaration on the same line must not be mistaken for the node.
      if (candidates.length !== 1) continue;
      const name = candidates[0]!.childForFieldName("name");
      if (name === null || !/^#?[A-Za-z_$][\w$]*$/.test(name.text)) continue;
      // Constructor/dunder names participate in language dispatch; changing
      // one is not merely moving an otherwise unchanged named declaration.
      if ((candidates[0]!.type === "method_definition" && name.text === "constructor")
        || (language === "python" && /^__.*__$/.test(name.text))) continue;
      // Do not assume byte offsets and JS character offsets agree.
      if (source.slice(name.startIndex, name.endIndex) !== name.text) continue;
      const prefix = name.text.startsWith("#") ? "#" : language === "python" && name.text.startsWith("__") ? "__" : "";
      const renamed = source.slice(0, name.startIndex) + `${prefix}mex_declaration` + source.slice(name.endIndex);
      const lines = body.split("\n").length;
      const hash = tokenHash(filePath, renamed, first + 1, first + lines, true);
      if (hash !== null) return hash;
    } finally {
      disposeTree(tree);
    }
  }
  return null;
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
