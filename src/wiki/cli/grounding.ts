/**
 * The code graph, as the Wiki CLI may consult it (#232).
 *
 * The Wiki CLI used to build its service options with no graph at all, so
 * `wiki validate` never resolved a grounding, `wiki rebuild-index` stored no
 * health, and `wiki migrate` never backfilled a `bodyHash` — each degrading
 * silently in a checkout with a fresh `graph.db`.
 *
 * The graph is reached here exactly as the Project Hub reaches it: through the
 * repository graph port's fresh, revocable snapshot, which re-proves database
 * and source freshness before anything derived from it escapes. A Wiki command
 * never opens `graph.db` itself, never sees a stale snapshot, and never
 * triggers graph maintenance.
 */

import type { GroundingGraph } from "../grounding/adapter.js";
import {
  codeGraphUnavailableDiagnostic,
  type CodeGraphUnavailableReason,
} from "../grounding/availability.js";
import type { WikiDiagnostic } from "../model/diagnostic.js";
import { MexPortError } from "../../team/contracts/shared.js";

/** A two-phase publication prepared while the snapshot is open. */
export interface WikiCliPreparedPublication<T> {
  preflight(): void | Promise<void>;
  commit(): T | Promise<T>;
  discard(): void | Promise<void>;
}

/**
 * The structural slice of `RepositoryGraphPort` the Wiki CLI uses.
 *
 * Structural, so `src/wiki/` does not import `src/graph/`; the CLI entry point
 * composes the real port in.
 */
export interface WikiCliGroundingBridge {
  withFreshGroundingSnapshot<T>(callback: (snapshot: GroundingGraph) => T | Promise<T>): Promise<T>;
  withFreshGroundingPublication<T>(
    prepare: (snapshot: GroundingGraph) => WikiCliPreparedPublication<T> | Promise<WikiCliPreparedPublication<T>>,
  ): Promise<T>;
}

/**
 * Why a pass had no graph: the graph's own refusal, or `not_supplied` when
 * the caller gave this command no bridge — which says nothing about whether
 * the checkout has a graph, and must not be reported as if it did.
 */
export type WikiCliGraphAbsence = CodeGraphUnavailableReason | "not_supplied";

/** What a command learned about the graph, beside its own result. */
export interface WithGraphResult<T> {
  value: T;
  /** Null when a fresh graph was used; otherwise why the pass had none. */
  unavailable: WikiCliGraphAbsence | null;
}

const REASONS: Partial<Record<string, CodeGraphUnavailableReason>> = {
  INDEX_MISSING: "missing",
  INDEX_STALE: "stale",
  MIGRATION_REQUIRED: "rebuild_required",
  INDEX_CORRUPT: "corrupt",
  OPERATION_INTERRUPTED: "changed",
  REVISION_CONFLICT: "changed",
};

/** The reason a graph refusal names, or null for an error that is not a refusal. */
function unavailableReason(error: unknown): CodeGraphUnavailableReason | null {
  if (!(error instanceof MexPortError)) return null;
  return REASONS[error.problem.code] ?? null;
}

class WorkFailure {
  constructor(readonly cause: unknown) {}
}

/**
 * Run a read against one fresh graph snapshot, or without a graph when the
 * graph refuses one.
 *
 * A read whose snapshot fails its final freshness proof is run again without a
 * graph, so no verdict from a graph that moved under it is ever reported. A
 * failure of the read itself is rethrown, never retried.
 */
export async function readWithGraph<T>(
  bridge: WikiCliGroundingBridge | null | undefined,
  work: (graph: GroundingGraph | null) => T,
): Promise<WithGraphResult<T>> {
  if (bridge === null || bridge === undefined) return { value: work(null), unavailable: "not_supplied" };
  try {
    const value = await bridge.withFreshGroundingSnapshot((graph) => {
      try {
        return work(graph);
      } catch (error) {
        throw new WorkFailure(error);
      }
    });
    return { value, unavailable: null };
  } catch (error) {
    if (error instanceof WorkFailure) throw error.cause;
    const reason = unavailableReason(error);
    if (reason === null) throw error;
    return { value: work(null), unavailable: reason };
  }
}

/**
 * Run a write against one fresh graph snapshot, or without a graph when the
 * graph refuses one.
 *
 * Unlike a read, a write that has already run is never run again: its files
 * are on disk. If the snapshot fails its final proof only after the write
 * completed, the write's result stands and the pass is reported as `changed`,
 * because the graph it consulted no longer describes the source.
 */
export async function writeWithGraph<T>(
  bridge: WikiCliGroundingBridge | null | undefined,
  work: (graph: GroundingGraph | null) => T,
): Promise<WithGraphResult<T>> {
  if (bridge === null || bridge === undefined) return { value: work(null), unavailable: "not_supplied" };
  let completed: { value: T } | null = null;
  try {
    const value = await bridge.withFreshGroundingSnapshot((graph) => {
      try {
        completed = { value: work(graph) };
        return completed.value;
      } catch (error) {
        throw new WorkFailure(error);
      }
    });
    return { value, unavailable: null };
  } catch (error) {
    if (error instanceof WorkFailure) throw error.cause;
    const reason = unavailableReason(error);
    if (reason === null) throw error;
    const done = completed as { value: T } | null;
    if (done !== null) return { value: done.value, unavailable: "changed" };
    return { value: work(null), unavailable: reason };
  }
}

/**
 * Prepare a publication against a fresh snapshot and publish it only after the
 * graph's final freshness proof; otherwise publish the no-graph candidate.
 *
 * The same contract the repository Wiki adapter gives a Hub rebuild, so a CLI
 * rebuild cannot publish health from a graph that changed while it was built.
 */
export async function publishWithGraph<T>(
  bridge: WikiCliGroundingBridge | null | undefined,
  prepare: (graph: GroundingGraph | null) => WikiCliPreparedPublication<T>,
): Promise<WithGraphResult<T>> {
  const withoutGraph = async (reason: WikiCliGraphAbsence): Promise<WithGraphResult<T>> => {
    const prepared = prepare(null);
    try {
      await prepared.preflight();
    } catch (error) {
      await prepared.discard();
      throw error;
    }
    return { value: await prepared.commit(), unavailable: reason };
  };
  if (bridge === null || bridge === undefined) return withoutGraph("not_supplied");
  try {
    const value = await bridge.withFreshGroundingPublication((graph) => {
      try {
        return prepare(graph);
      } catch (error) {
        throw new WorkFailure(error);
      }
    });
    return { value, unavailable: null };
  } catch (error) {
    if (error instanceof WorkFailure) throw error.cause;
    const reason = unavailableReason(error);
    if (reason === null) throw error;
    return withoutGraph(reason);
  }
}

/** The notice a fallback adds to a command's diagnostics, if any. */
export function graphDiagnostics(unavailable: WikiCliGraphAbsence | null): WikiDiagnostic[] {
  if (unavailable === null || unavailable === "not_supplied") return [];
  const notice = codeGraphUnavailableDiagnostic(unavailable);
  return notice === null ? [] : [notice];
}
