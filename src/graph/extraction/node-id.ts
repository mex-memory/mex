// ============================================================================
// mex code-graph — line-independent node id + shared tree-sitter helpers  (A2)
// ============================================================================
//
// Leaf module (no imports from the extractors) so every language extractor can
// depend on it without circular imports. `generateNodeId` is ported VERBATIM
// from `.demo/engine/cg/src/extraction/tree-sitter-helpers.ts:13-39` — it is the
// Tier-1 identity contract (spec §1/§3) and MUST stay byte-for-byte stable, or
// every grounded anchor detaches.

import { createHash } from "node:crypto";
import type { NodeKind } from "../types.js";
import type { TSNode } from "./types.js";

/**
 * Generate a node id — LINE-INDEPENDENT (Tier-1 identity, spec §1).
 *
 * CodeGraph hashed `${filePath}:${kind}:${name}:${line}`. The line is the bug:
 * any edit ABOVE a symbol shifts its start line → new id → every grounded anchor
 * silently detaches. We drop the line, so a body edit or a comment-above no
 * longer changes the id. This is THE custom change that makes grounding survive
 * line-shifts and same-file edits.
 *
 * Coarse on purpose: rename (`name` changes) and move (`filePath` changes) still
 * read as delete+add — that is Tier-2 fingerprint reconciliation's job
 * (`src/graph/reconcile.ts`, Track B), not the id's.
 *
 * Uses a 32-character (128-bit) hash prefix to avoid collisions across files.
 */
export function generateNodeId(
  filePath: string,
  kind: NodeKind,
  name: string,
): string {
  const hash = createHash("sha256")
    .update(`${filePath}:${kind}:${name}`)
    .digest("hex")
    .substring(0, 32);
  return `${kind}:${hash}`;
}

/** Source text spanned by a syntax node (its byte range into `source`). */
export function getNodeText(node: TSNode, source: string): string {
  return source.substring(node.startIndex, node.endIndex);
}

/** Find a child node by tree-sitter field name (e.g. `"name"`, `"body"`). */
export function getChildByField(node: TSNode, fieldName: string): TSNode | null {
  return node.childForFieldName(fieldName);
}

/**
 * Node types that WRAP a declaration, so a leading comment is a sibling of the
 * wrapper rather than of the emitted (inner) declaration node. We emit the inner
 * node, so before looking for its preceding comment we climb out through these.
 * Examples: `export class X {}` (export_statement), `const f = () => {}`
 * (lexical_declaration → variable_declarator). Each wraps exactly one
 * declaration, so climbing can't mis-attribute a comment to a sibling.
 */
const DOCSTRING_WRAPPER_TYPES = new Set([
  "export_statement", //     export class/function/const ...
  "lexical_declaration", //  const/let x = () => {}
  "variable_declaration", // var x = ...
  "variable_declarator", //  the `x = () => {}` inside the declaration
  "ambient_declaration", //  declare ...
]);

/** Strip C-family comment markers so the stored docstring is just the prose. */
function cleanCommentMarkers(comment: string): string {
  let c = comment.trim();
  if (c.startsWith("/*")) c = c.replace(/^\/\*+!?/, "").replace(/\*+\/$/, "");
  return c
    .replace(/^\/\/[/!]?\s?/gm, "") // //, and doc lines /// //!
    .replace(/^\s*\*\s?/gm, "") //     block-comment continuation (* foo)
    .trim();
}

/**
 * The docstring/comment immediately preceding a node, marker-stripped, or
 * undefined when there is none. Climbs out of any wrapper(s) first so a comment
 * preceding the WHOLE construct (export- or const-arrow-wrapped) is reachable as
 * a sibling.
 */
export function getPrecedingDocstring(
  node: TSNode,
  source: string,
): string | undefined {
  let anchor = node;
  while (anchor.parent && DOCSTRING_WRAPPER_TYPES.has(anchor.parent.type)) {
    anchor = anchor.parent;
  }

  let sibling = anchor.previousNamedSibling;
  const comments: string[] = [];
  while (sibling) {
    if (
      sibling.type === "comment" ||
      sibling.type === "line_comment" ||
      sibling.type === "block_comment"
    ) {
      comments.unshift(getNodeText(sibling, source));
      sibling = sibling.previousNamedSibling;
    } else {
      break;
    }
  }

  if (comments.length === 0) return undefined;
  return comments.map(cleanCommentMarkers).join("\n").trim();
}
