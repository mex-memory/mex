/**
 * One code link's verdict, named once for every surface that reports it.
 *
 * {@link resolveGrounding} is the only function that decides whether linked
 * code changed. `mex check`, the Wiki index (and so `wiki query`, `wiki
 * for-code` and the Hub) all call it; this file only names its result, so the
 * two can never disagree about a link.
 *
 * | verdict | meaning |
 * |---|---|
 * | `fresh` | the code is the code the fact was recorded against, or differs only in comments or layout |
 * | `changed-nearby` | the code changed, but only in lines away from everything the fact names |
 * | `moved` | the symbol was found again under another id; its code still matches |
 * | `changed` | the code changed in a way that may falsify the fact |
 * | `missing` | the symbol is gone and nothing matches it |
 * | `ambiguous` | the symbol may have moved, but the match is uncertain |
 * | `unverified` | nothing to compare against: no graph, or an undecodable reference |
 */

import type { GroundingDriftNote, GroundingResolution } from "../model/grounding.js";

export const GROUNDING_VERDICTS = [
  "fresh",
  "changed-nearby",
  "moved",
  "changed",
  "missing",
  "ambiguous",
  "unverified",
] as const;

export type GroundingVerdict = (typeof GROUNDING_VERDICTS)[number];

export interface NamedVerdict {
  verdict: GroundingVerdict;
  /** The node the link resolved to, when it resolved. */
  resolvedNode?: string;
  /** Why a changed body still counts as fresh: comment-only or layout-only. */
  note?: GroundingDriftNote["kind"];
}

/** Name a resolution. Pure; the decision was made by `resolveGrounding`. */
export function groundingVerdict(resolution: GroundingResolution): NamedVerdict {
  switch (resolution.state) {
    case "fresh": {
      const drift = resolution.drift?.kind;
      if (resolution.rebound) {
        return { verdict: "moved", resolvedNode: resolution.resolvedNode, ...(drift === undefined ? {} : { note: drift }) };
      }
      if (drift === "changed-nearby") return { verdict: "changed-nearby", resolvedNode: resolution.resolvedNode };
      return { verdict: "fresh", resolvedNode: resolution.resolvedNode, ...(drift === undefined ? {} : { note: drift }) };
    }
    case "stale":
      return { verdict: "changed", resolvedNode: resolution.resolvedNode };
    case "missing":
      return { verdict: "missing" };
    case "unresolved":
      return { verdict: resolution.health === "ambiguous" ? "ambiguous" : "unverified" };
    default:
      return { verdict: "unverified" };
  }
}
