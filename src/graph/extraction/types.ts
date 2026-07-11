// ============================================================================
// mex code-graph — LanguageExtractor interface  (FROZEN in 0.7.0 — spec §8.1)
// ============================================================================
//
//   >>> THIS IS THE SEAM EVERY CONTRIBUTOR LANGUAGE CODES AGAINST. <<<
//
// It is FROZEN in 0.7.0 and cannot move under contributors in the 0.7.x
// language-matrix program. The TS/JS extractor (Track A, `src/graph/extraction/
// languages/typescript.ts`) is the REFERENCE IMPLEMENTATION contributors copy —
// its quality sets the ceiling on every contributed extractor, so keep this
// interface small, total, and exemplary.
//
// A `LanguageExtractor` is a pure, deterministic function of a parsed
// tree-sitter tree: no I/O, no LLM, no cross-file resolution. It emits the nodes
// it finds and the (possibly-unresolved) edges/references leaving them. The
// engine handles parsing, grammar loading, cross-file resolution, persistence,
// and body-hash/fingerprint computation — an extractor never touches those.

import type {
  Language,
  NodeKind,
  ReferenceKind,
} from "../types.js";
import type { GraphNode } from "../types.js";

// ----------------------------------------------------------------------------
// Tree-sitter surface (structural placeholder — see note)
// ----------------------------------------------------------------------------
//
// Phase 0 must typecheck WITHOUT the (heavy) `web-tree-sitter` dependency, which
// is added by Track A when lazy grammar loading lands (spec §10 A5). So `TSTree`
// / `TSNode` / `TSPoint` are declared here as the STRUCTURAL SUBSET of
// web-tree-sitter's `Tree` / `Node` / `Point` that extractors actually walk
// (drawn from `.demo/engine/cg/src/web-tree-sitter.d.ts`).
//
// web-tree-sitter's real classes are structurally assignable to these, so when
// Track A adds the dependency it may either keep these aliases or point them at
// `import type { Tree, Node, Point } from "web-tree-sitter"` — both are
// source-compatible for extractor authors. Extractors should program against
// the members below and treat the tree as read-only.

/** A position in a source file. Mirrors web-tree-sitter `Point`. */
export interface TSPoint {
  readonly row: number; //    0-indexed line
  readonly column: number; // 0-indexed column
}

/**
 * A tree-sitter syntax node — the read-only subset extractors use. Mirrors the
 * web-tree-sitter `Node` API (child access, field access, sibling walking,
 * byte/point ranges). Extractors must not mutate it.
 */
export interface TSNode {
  /** Grammar node type, e.g. `"function_declaration"`, `"call_expression"`. */
  readonly type: string;
  /** Full source text spanned by this node. */
  readonly text: string;
  /** Byte offsets into the source string. */
  readonly startIndex: number;
  readonly endIndex: number;
  /** 0-indexed position (tree-sitter convention); add 1 for the 1-indexed `nodes.start_line`. */
  readonly startPosition: TSPoint;
  readonly endPosition: TSPoint;
  readonly parent: TSNode | null;
  readonly childCount: number;
  readonly namedChildCount: number;
  readonly children: TSNode[];
  readonly namedChildren: TSNode[];
  readonly previousNamedSibling: TSNode | null;
  readonly nextNamedSibling: TSNode | null;
  child(index: number): TSNode | null;
  namedChild(index: number): TSNode | null;
  childForFieldName(fieldName: string): TSNode | null;
  descendantsOfType(types: string | string[]): TSNode[];
}

/** A parsed tree-sitter tree. Mirrors web-tree-sitter `Tree`. */
export interface TSTree {
  readonly rootNode: TSNode;
}

// ----------------------------------------------------------------------------
// Extractor output shapes
// ----------------------------------------------------------------------------

/**
 * A node as produced by an extractor — the symbol facts, before the engine
 * assigns `bodyHash`/`updatedAt` and persists it. It is exactly a {@link
 * GraphNode} minus those engine-owned fields, so what an extractor emits maps
 * 1:1 onto a persisted row.
 *
 * The extractor MUST set `id` using the shared line-independent scheme
 * (`generateNodeId(filePath, kind, name)` — ported in Track A A2); getting the
 * id right is what keeps grounding stable across edits.
 */
export type ExtractedNode = Omit<GraphNode, "bodyHash" | "updatedAt">;

/**
 * An edge/reference as produced by an extractor. Unifies the demo's `Edge`
 * (fully-resolved, intra-file) and `UnresolvedReference` (cross-file, resolved
 * later): the extractor sets `target` when it can bind the reference within the
 * same file, otherwise it leaves `target` undefined and provides `targetName`
 * (+ optional `candidates`) for the engine's resolution pass.
 */
export interface ExtractedEdge {
  /** Id of the node the edge originates from (an id the extractor also emitted). */
  source: string;
  /** Resolved target node id, when the extractor could bind it in-file. */
  target?: string;
  /** Symbolic name of the reference, when `target` is unresolved (cross-file). */
  targetName?: string;
  /** Relationship kind (or `function_ref` for a name used as a value). */
  kind: ReferenceKind;
  /** Possible qualified names the engine's resolver should consider. */
  candidates?: string[];
  /** 0-indexed line/column of the reference site, when known. */
  line?: number;
  column?: number;
  metadata?: Record<string, unknown>;
}

// ----------------------------------------------------------------------------
// The frozen interface (spec §8.1 — verbatim shape)
// ----------------------------------------------------------------------------

/**
 * A per-language extractor. Contributors implement ONE of these per language and
 * register it (0.7.x). The interface is FROZEN: do not add required members.
 *
 * Contract:
 *  - Pure and deterministic: same `(tree, filePath, source)` → same output.
 *  - No I/O, no network, no LLM, no cross-file lookups. One file in isolation.
 *  - `extract` returns every symbol node in the file and every edge/reference
 *    leaving those nodes. Cross-file targets stay unresolved (`targetName`);
 *    the engine resolves them after the full index pass.
 *
 * @example
 * export const pythonExtractor: LanguageExtractor = {
 *   language: "python",
 *   fileExtensions: [".py"],
 *   grammarWasm: "tree-sitter-python",
 *   extract(tree, filePath, source) {
 *     // walk tree.rootNode, emit nodes + edges
 *     return { nodes: [], edges: [] };
 *   },
 * };
 */
export interface LanguageExtractor {
  /** Canonical language id, e.g. `"python"`, `"go"`. Must be a {@link Language}. */
  language: Language;
  /** File extensions this extractor claims, e.g. `[".py"]`, `[".go"]`. */
  fileExtensions: string[];
  /**
   * Lazy-loaded grammar id. The engine loads the matching tree-sitter WASM
   * grammar on demand (spec §7, Track A A5). 0.7.0 ships TS/JS/TSX grammars
   * only; a contributor's grammar is installed alongside their extractor.
   */
  grammarWasm: string;
  /**
   * Extract nodes and edges from one parsed file.
   *
   * @param tree     The parsed tree-sitter tree for `source`.
   * @param filePath Path relative to the project root (used for node ids).
   * @param source   The full file text (byte offsets on `TSNode` index into it).
   */
  extract(
    tree: TSTree,
    filePath: string,
    source: string,
  ): {
    nodes: ExtractedNode[];
    edges: ExtractedEdge[];
  };
}

// Re-exported so contributor extractors can pull every type they need from one
// import (`from "../types.js"` inside `languages/`).
export type { Language, NodeKind, ReferenceKind, GraphNode };
