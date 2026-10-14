import type { GroundingGraph, SynthesisGraph } from "../grounding/adapter.js";
import type { ServiceResult } from "../service/read.js";
import type { WikiCliPreparedPublication } from "./grounding.js";
import { graphDiagnostics, graphUnavailableReason } from "./grounding.js";

export interface WikiCliSynthesisSnapshot {
  codeGraph: SynthesisGraph;
  graph: GroundingGraph;
}

/** Strict fresh evidence: synthesis cannot reason over an incomplete corpus. */
export interface WikiCliSynthesisBridge {
  withFreshSynthesisSnapshot<T>(callback: (snapshot: WikiCliSynthesisSnapshot) => T | Promise<T>): Promise<T>;
  withFreshSynthesisPublication<T>(prepare: (snapshot: WikiCliSynthesisSnapshot) => WikiCliPreparedPublication<T> | Promise<WikiCliPreparedPublication<T>>): Promise<T>;
}

class WorkFailure { constructor(readonly cause: unknown) {} }

/** Buffer the complete result; discard it if the graph changes under the read. */
export async function readSynthesis<T>(
  bridge: WikiCliSynthesisBridge,
  work: (snapshot: WikiCliSynthesisSnapshot | null) => ServiceResult<T>,
): Promise<ServiceResult<T>> {
  try {
    return await bridge.withFreshSynthesisSnapshot(snapshot => {
      try { return work(snapshot); } catch (error) { throw new WorkFailure(error); }
    });
  } catch (error) {
    if (error instanceof WorkFailure) throw error.cause;
    const reason = graphUnavailableReason(error);
    if (reason === null) throw error;
    const fallback = work(null);
    return { data: fallback.data, diagnostics: [...fallback.diagnostics,
      ...graphDiagnostics(reason).map(notice => ({ ...notice, severity: "error" as const }))] };
  }
}

/** A refused proof cannot publish: fallback computes a read-only preview. */
export async function publishSynthesis<T>(
  bridge: WikiCliSynthesisBridge,
  prepare: (snapshot: WikiCliSynthesisSnapshot) => WikiCliPreparedPublication<ServiceResult<T>>,
  fallback: () => ServiceResult<T>,
): Promise<ServiceResult<T>> {
  try {
    return await bridge.withFreshSynthesisPublication(snapshot => {
      try { return prepare(snapshot); } catch (error) { throw new WorkFailure(error); }
    });
  } catch (error) {
    if (error instanceof WorkFailure) throw error.cause;
    const reason = graphUnavailableReason(error);
    if (reason === null) throw error;
    const result = fallback();
    return { data: result.data, diagnostics: [...result.diagnostics,
      ...graphDiagnostics(reason).map(notice => ({ ...notice, severity: "error" as const }))] };
  }
}
