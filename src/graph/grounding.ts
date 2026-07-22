// ============================================================================
// mex code-graph — grounding checker contract  (FROZEN — Phase 0, spec §5/§6)
// ============================================================================
//
// Grounding lets scaffold prose assert against specific CODE NODES (not just
// file paths), via the net-new `grounds_to` frontmatter (agent-authored only —
// see `Grounding` in `src/types.ts`). The 12th drift checker resolves each
// grounded target and reports drift. This file freezes:
//   * `GroundedSource` — a decoded `_mex_grounded_source` row (the baseline).
//   * `GroundingChecker` — the checker's call signature, IDENTICAL to the
//     existing checkers (`src/drift/checkers/edges.ts`): five positional args,
//     returns `DriftIssue[]`, synchronous, zero-AI.
//   * `createGroundingChecker(graph, reconciler)` — the factory that injects the
//     graph + reconciler seams and returns a checker with that exact signature.
//
// Track B writes the real checker body at `src/drift/checkers/grounding.ts`
// (spec §10 Track B B5), mirroring `checkEdges`. Phase 2 registers it as checker
// #12 and wires the real engine/reconciler in (spec §10 2.1–2.3). This file does
// NOT touch the drift pipeline or the existing eleven checkers.
//
// Checker outcomes (spec §6), all via `DriftIssue`:
//   Tier-1 hit + body unchanged      -> clean (no issue)
//   Tier-1 hit + body_hash moved     -> WARNING  (GROUNDING_DRIFT)
//   Tier-1 miss -> reconcile:
//        MOVED     -> clean, rebind grounds_to (no issue)
//        AMBIGUOUS -> WARNING  (GROUNDING_AMBIGUOUS) + candidate id
//        GONE      -> ERROR    (GROUNDING_GONE)

import type { DriftIssue, ScaffoldFrontmatter, Grounding } from "../types.js";
import type { GraphEngine } from "./engine.js";
import type { Reconciler } from "./reconcile.js";
import { makeGroundingChecker } from "../drift/checkers/grounding.js";

export type { Grounding };

/**
 * A grounding baseline — one `_mex_grounded_source` row decoded. Captures a
 * grounded node's source, body_hash and fingerprint AS OF the last grounding, so
 * the checker can diff current-vs-baseline and `sync` can show old-vs-new.
 */
export interface GroundedSource {
  /** Scaffold markdown file (relative to project root) that owns this grounding. */
  scaffoldFile: string;
  /** The grounded node's Tier-1 id. */
  nodeId: string;
  /** Node body text as of the last grounding (the "old" side of a drift diff). */
  source: string;
  /** sha256 of `source` at grounding time; compared against the node's current bodyHash. */
  bodyHash: string;
  /** Serialized Tier-2 fingerprint (`mh:<K>:<hex>`) captured at grounding time. */
  fingerprint: string;
}

/**
 * The grounding checker's signature — IDENTICAL to every other drift checker
 * (cf. `checkEdges` in `src/drift/checkers/edges.ts`): same five positional
 * arguments, returns `DriftIssue[]`, synchronous. Keeping this shape means the
 * drift pipeline calls it exactly like the others; the graph + reconciler are
 * supplied ahead of time by {@link createGroundingChecker}, not as call args.
 */
export type GroundingChecker = (
  frontmatter: ScaffoldFrontmatter | null,
  filePath: string,
  source: string,
  projectRoot: string,
  scaffoldRoot: string,
) => DriftIssue[];

/**
 * Build a {@link GroundingChecker} bound to a graph + reconciler.
 *
 * The graph and reconciler are the two seams the checker consults (resolve each
 * `grounds_to` target; reconcile on a Tier-1 miss). Injecting them here — rather
 * than widening the checker signature — is what lets the returned checker match
 * the existing drift-checker shape exactly. In graceful-degradation mode (no
 * graph), the drift pipeline simply does not construct this checker (spec §7);
 * the eleven filesystem/lexical checkers are unaffected.
 *
 * Phase-0 stub: returns a checker that throws. Track B provides the real body.
 */
export function createGroundingChecker(
  graph: GraphEngine,
  reconciler: Reconciler,
): GroundingChecker {
  return makeGroundingChecker(graph, reconciler);
}
