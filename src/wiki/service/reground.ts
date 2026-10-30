/**
 * `mex wiki reground <entity-id>` — re-record an entity's code links after a
 * reviewer has confirmed its text still holds.
 *
 * This is the "still true" half of reviewing a flagged entity (`mex sync`).
 * Nothing here is typed by hand: every link is resolved with the shared verdict
 * (`resolveGrounding`), a moved symbol is followed to where it went, and the
 * node id, fingerprint and body hash are re-derived from the live graph by the
 * ordinary `set-grounding` operation. A link that is missing or ambiguous has
 * no code to re-record against, so the whole request is refused and the entity
 * keeps its flag: rewrite the text, or relink it, instead.
 */

import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import type { WikiGrounding } from "../model/grounding.js";
import type { GroundingGraph } from "../grounding/adapter.js";
import { resolveGrounding } from "../grounding/resolve.js";
import { groundingVerdict, type GroundingVerdict } from "../grounding/verdict.js";
import { inventoryScaffold } from "../migration/inventory.js";
import { createParseCache } from "../operations/locate.js";
import type { ServiceResult } from "./read.js";
import { wikiApplyOperation, type ApplyData, type WikiWriteOptions } from "./write.js";

export interface RegroundLink {
  node: string;
  verdict: GroundingVerdict;
  /** The node the link is re-recorded to; differs from `node` after a move. */
  recordedNode?: string;
}

export interface RegroundData {
  entityId: string;
  links: RegroundLink[];
  /** The `set-grounding` plan or write; null when the request was refused. */
  apply: ApplyData | null;
}

/** A reviewer can record a known identity even when a legacy body baseline is absent. */
const RERECORDABLE: ReadonlySet<GroundingVerdict> = new Set(["fresh", "changed-nearby", "moved", "changed", "unverified"]);

export function wikiRegroundEntity(
  entityId: string,
  options: WikiWriteOptions & { apply?: boolean; reason?: string; now?: () => Date },
): ServiceResult<RegroundData> {
  const refused = (diagnostics: WikiDiagnostic[], links: RegroundLink[] = []): ServiceResult<RegroundData> =>
    ({ data: { entityId, links, apply: null }, diagnostics });
  const graph: GroundingGraph | null = options.graph ?? null;
  if (graph === null) {
    return refused([diagnostic("CODE_GRAPH_UNAVAILABLE",
      "Re-recording a code link needs a fresh code graph. Run `mex graph`, then try again.", { entityId })]);
  }

  const inventory = inventoryScaffold({
    scaffoldRoot: options.scaffoldRoot,
    parseCache: createParseCache(),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });
  const entity = inventory.files.flatMap((file) => file.parsed.entities).find((entry) => entry.entity.id === entityId)?.entity;
  if (entity === undefined) {
    return refused([diagnostic("ENTITY_NOT_FOUND", `No Wiki entity ${entityId} in this scaffold.`, { entityId })]);
  }
  if (entity.groundsTo.length === 0) {
    return refused([diagnostic("INVALID_OPERATION_PAYLOAD", `${entityId} has no code links to re-record.`, { entityId })]);
  }

  const fact = `${entity.title}\n\n${entity.body}`;
  const links: RegroundLink[] = [];
  const groundsTo: WikiGrounding[] = [];
  const blocked: WikiDiagnostic[] = [];
  for (const grounding of entity.groundsTo) {
    const named = groundingVerdict(resolveGrounding(grounding, graph, { fact }));
    const recordedNode = named.resolvedNode;
    if (!RERECORDABLE.has(named.verdict) || recordedNode === undefined) {
      links.push({ node: grounding.node, verdict: named.verdict });
      blocked.push(diagnostic("GROUNDING_MISSING",
        `${grounding.node} is ${named.verdict}, so there is no code to re-record it against. ` +
          "Update the fact and relink it, or leave the flag for a person to decide.",
        { entityId }));
      continue;
    }
    if (named.verdict === "unverified" && !graph.getNode(recordedNode)?.bodyHash) {
      links.push({ node: grounding.node, verdict: named.verdict });
      blocked.push(diagnostic("GROUNDING_UNRESOLVED",
        `${recordedNode} has no current body hash. Re-recording requires current change evidence; link the fact to a body-bearing support symbol before review.`, { entityId }));
      continue;
    }
    const fingerprint = graph.getFingerprint(recordedNode);
    if (fingerprint === null) {
      links.push({ node: grounding.node, verdict: named.verdict });
      blocked.push(diagnostic("GROUNDING_UNRESOLVED", `${recordedNode} has no fingerprint in this graph.`, { entityId }));
      continue;
    }
    links.push({ node: grounding.node, verdict: named.verdict, recordedNode });
    groundsTo.push({
      node: recordedNode,
      fingerprint,
      ...(grounding.reason === undefined ? {} : { reason: grounding.reason }),
    });
  }
  if (blocked.length > 0) return refused(blocked, links);

  const timestamp = (options.now?.() ?? new Date()).toISOString();
  const operation = {
    opId: `reground_${entityId}_${timestamp.replace(/[^0-9]/g, "")}`,
    type: "set-grounding",
    entityId,
    // Bound to the entity as read above: an edit made since then is refused, not overwritten.
    baseRevision: entity.revision,
    baseContentHash: entity.location.entityContentHash,
    actor: { kind: "agent", id: "mex-reground" },
    timestamp,
    reason: options.reason ?? "Explicitly re-recorded the entity's current code links",
    payload: { groundsTo },
  };
  const applied = wikiApplyOperation(operation, { ...options, graph, targetedGroundings: false, ...(options.apply === true ? { apply: true } : {}) });
  // Cache current bodies only after this explicitly requested write succeeds.
  // Ordinary resolution and dry-run planning never populate local state.
  if (applied.data.applied) {
    for (const grounding of groundsTo) {
      try {
        const bodyHash = graph.getNode(grounding.node)?.bodyHash;
        if (bodyHash) graph.rememberBody?.(grounding.node, bodyHash);
      } catch { /* An optional cache failure cannot undo a successful canonical write. */ }
    }
  }
  return { data: { entityId, links, apply: applied.data }, diagnostics: applied.diagnostics };
}
