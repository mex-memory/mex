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
  const applied = wikiApplyOperation(operation, { ...options, graph, ...(options.apply === true ? { apply: true } : {}) });
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

/** One entity's outcome inside a batch: the single-id result plus whether it succeeded and why not. */
export interface RegroundBatchEntity extends RegroundData {
  /** True when the entity was re-recorded (or, without `--apply`, planned without a refusal). */
  ok: boolean;
  /** This entity's own diagnostics; the batch result carries them all, once, as well. */
  diagnostics: WikiDiagnostic[];
}

export interface RegroundBatchData {
  /** One result per requested id, in request order, duplicates removed. */
  entities: RegroundBatchEntity[];
  /** Entities whose links were written. */
  applied: number;
  /** Entities that were planned and not written (no `--apply`). */
  planned: number;
  /** Entities refused or failed; the others are unaffected. */
  failed: number;
}

const BLOCKING: ReadonlySet<string> = new Set(["error"]);

/**
 * Re-record several entities against one graph snapshot.
 *
 * Each id goes through {@link wikiRegroundEntity} unchanged, so every safety
 * check the single-id command has (a link that is missing, ambiguous or
 * unverifiable refuses that entity; an edit made since it was read is refused,
 * not overwritten) holds per id. What the batch adds is the shared snapshot the
 * caller opened (opening one costs seconds), per-id results and partial-failure
 * reporting: one refused entity never stops or rolls back the others.
 */
export function wikiRegroundEntities(
  entityIds: readonly string[],
  options: WikiWriteOptions & { apply?: boolean; reason?: string; now?: () => Date },
): ServiceResult<RegroundBatchData> {
  const ids = [...new Set(entityIds)];
  const entities: RegroundBatchEntity[] = [];
  const diagnostics: WikiDiagnostic[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    let result: ServiceResult<RegroundData>;
    try {
      result = wikiRegroundEntity(id, options);
    } catch (error) {
      // An unexpected failure on one entity is that entity's failure, not the batch's.
      result = {
        data: { entityId: id, links: [], apply: null },
        diagnostics: [diagnostic("INVALID_OPERATION_PAYLOAD",
          `${id} could not be re-recorded: ${error instanceof Error ? error.message : String(error)}`, { entityId: id })],
      };
    }
    const own = [...result.diagnostics];
    const failed = result.data.apply === null || own.some((entry) => BLOCKING.has(entry.severity));
    entities.push({ ...result.data, ok: !failed, diagnostics: own });
    for (const entry of own) {
      const key = `${entry.code}\u0000${entry.entityId ?? ""}\u0000${entry.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push(entry);
    }
  }
  return {
    data: {
      entities,
      applied: entities.filter((e) => e.ok && e.apply?.applied === true).length,
      planned: entities.filter((e) => e.ok && e.apply?.applied !== true && e.apply?.planned === true).length,
      failed: entities.filter((e) => !e.ok).length,
    },
    diagnostics,
  };
}
