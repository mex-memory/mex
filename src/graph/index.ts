// ============================================================================
// mex code-graph — public contract surface  (Phase 0)
// ============================================================================
//
// One import site for everything the Phase-1 tracks and 0.7.x contributors code
// against. Phase 0 is CONTRACTS ONLY: frozen interfaces, types, the schema
// pointer, config placeholders, and throwing stubs. No engine logic, no
// extraction, no fingerprinting, no reconciliation, no checker bodies — those
// arrive in Phase 1 (Track A / Track B) against these frozen seams.

// --- Core value types (node/edge kinds, languages, persisted rows) ----------
export {
  NODE_KINDS,
  LANGUAGES,
} from "./types.js";
export type {
  NodeKind,
  EdgeKind,
  ReferenceKind,
  Language,
  GraphNode,
  GraphEdge,
} from "./types.js";

// --- Frozen contributor seam #1: LanguageExtractor (spec §8.1) ---------------
export type {
  LanguageExtractor,
  ExtractedNode,
  ExtractedEdge,
  TSTree,
  TSNode,
  TSPoint,
} from "./extraction/types.js";

// --- Frozen contributor seam #2: FrameworkResolver (spec §8.1 / §9) ----------
export type {
  FrameworkResolver,
  ResolutionContext,
  UnresolvedRef,
  ResolvedRef,
  FrameworkExtractionResult,
} from "./resolution/types.js";

// --- Reader/builder surface: GraphEngine ------------------------------------
export type {
  GraphEngine,
  BuildResult,
  NodeSearchOptions,
} from "./engine.js";
export { notImplementedGraphEngine } from "./engine.js";

// --- Identity core: Reconciler + Resolution + Fingerprint (spec §4) ----------
export type {
  Reconciler,
  Resolution,
  Fingerprint,
} from "./reconcile.js";
export { notImplementedReconciler, FINGERPRINT_PREFIX } from "./reconcile.js";

// --- Grounding checker contract (spec §5 / §6) ------------------------------
export type {
  GroundingChecker,
  GroundedSource,
} from "./grounding.js";
export { createGroundingChecker } from "./grounding.js";
// `Grounding` itself lives in `src/types.ts` (it is referenced by
// `ScaffoldFrontmatter`); re-exported here so the graph contract is one import.
export type { Grounding } from "../types.js";

// --- Reconciler tuning params (spec §4 / §12 — placeholders) -----------------
export {
  HI,
  LO,
  W_BODY,
  W_NBR,
  MIN_TOKENS,
  K,
  BANDS,
  ROWS,
  RECONCILER_PARAMS,
} from "./config.js";
export type { ReconcilerParams } from "./config.js";

// --- Shared stub error -------------------------------------------------------
export { NotImplementedError } from "./errors.js";
