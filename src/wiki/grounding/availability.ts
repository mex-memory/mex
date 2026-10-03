/**
 * Why a pass that resolves groundings ran without a code graph (#232).
 *
 * The Wiki reads the graph only through one fresh, revocable snapshot, and the
 * graph refuses that snapshot in a handful of distinct states. A caller that
 * falls back to "no graph" has to say which one, because the remedy differs:
 * a checkout with no graph may be one that never has one, while a stale or
 * corrupt graph is a problem `mex graph` fixes.
 */

import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";

export type CodeGraphUnavailableReason =
  | "missing"
  | "stale"
  | "rebuild_required"
  | "corrupt"
  | "changed";

const MESSAGES: Record<Exclude<CodeGraphUnavailableReason, "missing">, string> = {
  stale: "The code graph is out of date with the source, so groundings were not resolved against it.",
  rebuild_required: "The code graph was built by an incompatible version of mex, so groundings were not resolved against it.",
  corrupt: "The code graph could not be read safely, so groundings were not resolved against it.",
  changed: "The code graph or the source changed during this pass, so groundings were not resolved against it.",
};

const REMEDIATIONS: Partial<Record<CodeGraphUnavailableReason, string>> = {
  rebuild_required: "Run `mex graph rebuild` to rebuild the code graph, then run this command again.",
  corrupt: "Run `mex graph rebuild` to rebuild the code graph, then run this command again.",
};

/**
 * The notice for a graph that exists but could not be used, or null for one
 * that does not exist. A checkout with no graph is an ordinary configuration —
 * CI before `mex graph`, a memory-only project — and the commands that care
 * already say so in their own output.
 */
export function codeGraphUnavailableDiagnostic(reason: CodeGraphUnavailableReason): WikiDiagnostic | null {
  if (reason === "missing") return null;
  const remediation = REMEDIATIONS[reason];
  return diagnostic("CODE_GRAPH_UNAVAILABLE", MESSAGES[reason], remediation === undefined ? {} : { remediation });
}
