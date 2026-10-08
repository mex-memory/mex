/**
 * The CG↔KG weld: making an entity's declared reference to code resolve, and
 * keeping it honest as the code changes.
 *
 * `adapter.ts` is the only module under `src/wiki/` that imports the code
 * graph's engine, reconciler or fingerprint store — a lint rule enforces it.
 * Everything else here works against the interface it declares.
 */

export {
  createGroundingGraph,
  deriveGrounding,
  type GroundedNode,
  type GroundingGraph,
} from "./adapter.js";
export { entitySubject, WikiBaselineStore } from "./baseline.js";
export {
  checkGroundingProvenance,
  deriveVerifiedGroundings,
  isGraphDerivedGrounding,
} from "./provenance.js";
export { resolveEntityGroundings, resolveGrounding, type EntityResolution, type GroundingContext } from "./resolve.js";
