// ============================================================================
// mex code-graph — core value types  (FROZEN — Phase 0, spec §3)
// ============================================================================
//
// The shared vocabulary the graph module speaks: node kinds, edge kinds,
// languages, and the two persisted row shapes (`GraphNode`, `GraphEdge`).
// Ported/adapted from `.demo/engine/cg/src/types.ts` and kept in sync with the
// column set in `src/graph/schema.sql`. Types only — no runtime logic beyond
// the runtime-iterable `as const` tables (which back both the TS types and any
// later runtime validation, e.g. a `mex graph query` parser).
//
// These are frozen contracts: Track A (engine) produces them, Track B
// (fingerprint/reconcile/grounding) consumes them. Do not reshape under the
// parallel tracks.

// ----------------------------------------------------------------------------
// Enumerations
// ----------------------------------------------------------------------------

/**
 * Kinds of nodes in the graph. Declared as a runtime-iterable `as const` array
 * so the same source of truth backs both the TS union and runtime validation.
 * 0.7.0 extracts TS/JS only, but the full kind vocabulary is frozen up front so
 * contributor extractors (0.7.x) emit into a stable set.
 */
export const NODE_KINDS = [
  "file",
  "module",
  "class",
  "struct",
  "interface",
  "trait",
  "protocol",
  "function",
  "method",
  "property",
  "field",
  "variable",
  "constant",
  "enum",
  "enum_member",
  "type_alias",
  "namespace",
  "parameter",
  "import",
  "export",
  "route",
  "component",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * Kinds of edges (relationships) between nodes. `calls` is the one traversed by
 * `getCallers` / `getCallees`; the rest give structure and resolution context.
 */
export type EdgeKind =
  | "contains" //     Parent contains child (file→class, class→method)
  | "calls" //        Function/method calls another
  | "imports" //      File imports from another
  | "exports" //      File exports a symbol
  | "extends" //      Class/interface extends another
  | "implements" //   Class implements interface
  | "references" //   Generic reference to another symbol
  | "type_of" //      Variable/parameter has type
  | "returns" //      Function returns type
  | "instantiates" // Creates instance of class
  | "overrides" //    Method overrides parent method
  | "decorates"; //   Decorator applied to symbol

/**
 * Kinds an unresolved reference can carry during extraction. `function_ref` is
 * extraction-internal — a function name used as a VALUE (callback registration);
 * resolution maps it to a `references` edge. It never persists as an edge kind.
 */
export type ReferenceKind = EdgeKind | "function_ref";

/**
 * Languages the graph can represent. 0.7.0 ships extraction for TS/JS/TSX/JSX
 * only (see `EXTRACTORS` wiring in Track A); the rest are reserved so
 * contributor extractors slot in without widening this union (0.7.x program).
 * Runtime-iterable for the same reason as {@link NODE_KINDS}.
 */
export const LANGUAGES = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "csharp",
  "php",
  "ruby",
  "swift",
  "kotlin",
  "dart",
  "svelte",
  "vue",
  "astro",
  "scala",
  "lua",
  "objc",
  "unknown",
] as const;

export type Language = (typeof LANGUAGES)[number];

// ----------------------------------------------------------------------------
// Persisted row shapes (decoded from `src/graph/schema.sql`)
// ----------------------------------------------------------------------------

/**
 * A persisted node — one `nodes` row decoded to camelCase. Produced by the
 * engine during build; read back by `GraphEngine` reader methods, the grounding
 * checker, and `mex impact` / `mex graph query`.
 *
 * `id` is the line-independent Tier-1 identity
 * (`${kind}:sha256(filePath:kind:name)[:32]`). `bodyHash` is the drift trigger
 * (sha256 of the node's normalized body), populated after extraction; nullable
 * for non-body kinds (imports, parameters).
 */
export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: Language;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  docstring?: string;
  signature?: string;
  visibility?: "public" | "private" | "protected" | "internal";
  isExported?: boolean;
  isAsync?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  decorators?: string[];
  typeParameters?: string[];
  /** Normalized return/result type name for a function/method, when captured. */
  returnType?: string;
  /** sha256 of the normalized node body; the drift trigger. Undefined for non-body kinds. */
  bodyHash?: string;
  /** Epoch millis of the last extraction that touched this node. */
  updatedAt: number;
}

/**
 * A persisted edge — one `edges` row decoded. Both `source` and `target` are
 * resolved node ids (cross-file references are resolved into edges after the
 * full index pass; anything still unresolved lives in `unresolved_refs`, not
 * here).
 */
export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  metadata?: Record<string, unknown>;
  line?: number;
  column?: number;
  provenance?: "tree-sitter" | "heuristic";
}
