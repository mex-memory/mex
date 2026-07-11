// ============================================================================
// mex code-graph — FrameworkResolver interface  (FROZEN in 0.7.0 — spec §8.1)
// ============================================================================
//
// The second contributor seam (alongside `LanguageExtractor`). A framework
// resolver teaches the graph framework-specific edges a plain AST walk misses —
// e.g. an Express route string → its handler function, a NestJS controller →
// its provider. 0.7.0 freezes this interface and (per spec §9) ships ONE trivial
// reference resolver (Express) as the copy-template; the resolver MATRIX is
// community work (0.7.x). Do not add required members under contributors.
//
// Kept deliberately MINIMAL versus the demo's `ResolutionContext` (which grew
// ~15 optional accessors for every language it shipped). We freeze the core that
// every resolver needs; a contributor whose framework needs more can propose an
// additive optional accessor in their PR (optional = backward-compatible).
//
// Distilled from `.demo/engine/cg/src/resolution/types.ts` and the
// `frameworks/*.ts` resolvers.

import type { GraphNode, Language, ReferenceKind } from "../types.js";

/**
 * An unresolved reference handed to resolvers: a name referenced from some node
 * that extraction could not bind within its own file. Mirrors an
 * `unresolved_refs` row.
 */
export interface UnresolvedRef {
  /** Id of the source node containing the reference. */
  fromNodeId: string;
  /** The name being referenced (e.g. a called function, an imported symbol). */
  referenceName: string;
  /** What kind of reference this is (call, import, type, `function_ref`, ...). */
  referenceKind: ReferenceKind;
  /** File path where the reference occurs (relative to project root). */
  filePath: string;
  /** Language of the referencing file. */
  language: Language;
  /** 0-indexed reference site, when known. */
  line?: number;
  column?: number;
  /** Possible qualified names it might resolve to. */
  candidates?: string[];
}

/**
 * A successfully resolved reference: the original ref bound to a target node id.
 * The engine turns this into a persisted edge.
 */
export interface ResolvedRef {
  /** The reference that was resolved. */
  original: UnresolvedRef;
  /** Id of the target node it resolved to. */
  targetNodeId: string;
  /** Confidence in the resolution, 0–1. */
  confidence: number;
  /** How it was resolved — `"framework"` for a `FrameworkResolver` hit. */
  resolvedBy: "framework" | "import" | "exact-match" | "qualified-name" | "fuzzy";
}

/**
 * Read-only view of the graph a resolver may query. The MINIMAL frozen core —
 * enough to look symbols up by file, name, qualified name, and kind, and to read
 * project files. Additional accessors are added as OPTIONAL members (never
 * required) so old resolvers keep compiling.
 */
export interface ResolutionContext {
  /** All nodes defined in a given file. */
  getNodesInFile(filePath: string): GraphNode[];
  /** All nodes with a given simple name. */
  getNodesByName(name: string): GraphNode[];
  /** All nodes with a given fully-qualified name. */
  getNodesByQualifiedName(qualifiedName: string): GraphNode[];
  /** All nodes of a given kind. */
  getNodesByKind(kind: GraphNode["kind"]): GraphNode[];
  /** Look up a single node by id (e.g. to read the FROM-node's enclosing scope). */
  getNodeById(id: string): GraphNode | null;
  /** Does this project file exist? */
  fileExists(filePath: string): boolean;
  /** Read a project file's text, or null if absent. */
  readFile(filePath: string): string | null;
  /** Absolute path of the project root. */
  getProjectRoot(): string;
  /** Every tracked file path (relative to project root). */
  getAllFiles(): string[];
}

/**
 * Result of a framework's own per-file extraction pass: framework-specific nodes
 * (e.g. route nodes) plus the references linking them to handlers.
 */
export interface FrameworkExtractionResult {
  nodes: GraphNode[];
  references: UnresolvedRef[];
}

/**
 * A framework-specific resolver. Contributors implement ONE per framework
 * (0.7.x). Only `name`, `detect`, and `resolve` are required; the rest are
 * optional passes used by frameworks that synthesize their own nodes or need a
 * cross-file finalization step.
 *
 * @example
 * export const expressResolver: FrameworkResolver = {
 *   name: "express",
 *   languages: ["typescript", "javascript"],
 *   detect: (ctx) => ctx.fileExists("package.json") && ... ,
 *   resolve: (ref, ctx) => { ... return null; },
 * };
 */
export interface FrameworkResolver {
  /** Unique framework name, e.g. `"express"`. */
  name: string;
  /** Languages this framework applies to. Omit to apply to all languages. */
  languages?: Language[];
  /** Project-level detection, called once at startup. */
  detect(context: ResolutionContext): boolean;
  /** Resolve one reference using framework-specific patterns; null if it can't. */
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null;
  /**
   * Let a reference NAME through the name-exists pre-filter even when no node is
   * declared with that name (dynamic dispatch: route strings, effect callbacks).
   */
  claimsReference?(name: string): boolean;
  /** Extract framework-specific nodes + references from one file. */
  extract?(filePath: string, content: string): FrameworkExtractionResult;
  /**
   * Cross-file finalization, run once after all per-file extraction (and on each
   * incremental sync). For frameworks whose final node shape depends on a file
   * the per-file `extract` never saw. Implementations MUST preserve node `id`.
   */
  postExtract?(context: ResolutionContext): GraphNode[];
}
