/**
 * Shared error type for the code-graph contract stubs.
 *
 * Phase 0 ships the frozen interfaces with throwing implementations so the whole
 * module typechecks and downstream code can import + inject the seams before the
 * real engine (Track A) and fingerprint/reconcile/grounding layer (Track B)
 * land. Every stub throws this; nothing here contains real logic.
 */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`NotImplemented: ${what} — code-graph contract stub (Phase 0). Implemented in Phase 1.`);
    this.name = "NotImplementedError";
  }
}
