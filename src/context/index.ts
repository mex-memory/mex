/**
 * Context composer: the read-only core that hooks and `mex context` share.
 *
 * Deliberately not re-exported from the package root (`src/index.ts`); the
 * public API stays limited to its intentional exports.
 */

export * from "./types.js";
export * from "./frozen.js";
export * from "./root.js";
export * from "./compose.js";
export * from "./index-store.js";
export * from "./session.js";
export * from "./packet.js";
export { buildContextIndex } from "./build-index.js";
export { type Embedder } from "./dense.js";
export { semanticStatus, loadEmbedder } from "./semantic.js";
