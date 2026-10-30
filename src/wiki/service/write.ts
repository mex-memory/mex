/**
 * The write half of the service surface, and the one command that builds an index.
 *
 * §16's rule is that **mutation returns a plan before it applies**, unless the
 * caller has explicit apply authority. That is not `--dry-run`; `--dry-run` is
 * something a user opts into. This is the other way round: `wikiApplyOperation`
 * plans and stops unless it is *told* to write, so the safe behaviour is what
 * happens when a caller says nothing. An agent that forgets a flag gets a plan.
 *
 * Everything that writes Markdown goes through P5's `planOperation` /
 * `applyOperation`, which is where `wiki.readOnly`, write-scope enforcement,
 * path containment, the audit log and `verifyPlan` live (D9, finding 41). There
 * is no second writer here and there must not be one.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { parseWikiMarkdown } from "../markdown/codec.js";
import { diagnostic, hasBlockingDiagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import type { EntityTypeRegistry } from "../model/entity.js";
import type { GroundingGraph } from "../grounding/adapter.js";
import { resolveGrounding } from "../grounding/resolve.js";
import { normalizeReferencePath } from "../grounding/code-reference.js";
import type { GroundingResolver } from "../index/write.js";
import { createHash } from "node:crypto";
import { prepareWikiRebuild, rebuildWikiIndex, type RebuildOptions, type RebuildResult } from "../index/rebuild.js";
import { refreshWikiIndex } from "../index/refresh.js";
import { readContainedSource } from "../index/source-read.js";
import { payloadHashOf, planOperation, type PlanOptions, type WikiPatchPlan } from "../operations/plan.js";
import { applyPlannedOperationBatch, planOperationBatchReport } from "../operations/batch.js";
import { acquireWikiMaintenanceLease } from "../index/dbfile.js";
import type { EntityId } from "../model/ids.js";
import { readAuditLog, recordFor } from "../operations/audit.js";
import { validateOperation } from "../model/operation.js";
import { rootContext } from "../model/validate.js";
import { isEntityId } from "../model/ids.js";
import { previewPlan, renderPreview, type WikiPreview } from "../operations/preview.js";
import { applyGeneratedViews, applyOperation, applyPlannedOperation, type ApplyOptions, type GeneratedViewCandidate } from "../operations/apply.js";
import { inventoryScaffold } from "../migration/inventory.js";
import { planGeneratedView } from "../migration/generated.js";
import type { WikiEntityType } from "../model/entity.js";
import { createParseCache } from "../operations/locate.js";
import {
  migrateScaffold,
  planMigration,
  renderMigrationReport,
  reportIsBlocked,
  type MigrationReport,
} from "../migration/migrate.js";
import { indexPathFor, type ServiceResult, type WikiServiceOptions } from "./read.js";
import type { WikiMaintenanceContext } from "../index/maintenance.js";

/**
 * Prove a link's source in the graph's own path form (`./src/a.ts` and `src\a.ts` name
 * `src/a.ts`). A path that cannot name a repository file is left to the planner's diagnostic.
 */
function verifyLinkedSource(graph: { verifySource?: (path: string) => void }, file: string): void {
  const path = normalizeReferencePath(file);
  if (path !== null) graph.verifySource?.(path);
}

/** Everything a write needs beyond where the scaffold is. */
export interface WikiWriteOptions extends WikiServiceOptions {
  exclude?: readonly string[];
  /** `wiki.readOnly` globs. Enforced in `plan.ts`, which is the whole surface (finding 41). */
  readOnly?: readonly string[];
  registry?: EntityTypeRegistry;
  /** The live code graph, required to mint or verify a grounding. */
  graph?: GroundingGraph | null;
  maintenance?: WikiMaintenanceContext;
}

/**
 * Grounding health for the index a write publishes, from the graph that write
 * was given (#232).
 *
 * The graph was already threaded through to mint and verify groundings, but
 * the index writes beside it never saw it, so every row they wrote stored
 * NULL health — "nothing looked" — even when something had. A rebuild, a
 * refresh and a post-write refresh all take the same resolver or none, as
 * `RebuildOptions.resolveGrounding` requires.
 */
function groundingResolverFor(options: WikiWriteOptions): { resolveGrounding?: GroundingResolver } {
  const graph = options.graph ?? null;
  return graph === null ? {} : {
    resolveGrounding: Object.assign(
      (grounding: Parameters<GroundingResolver>[0], context?: Parameters<GroundingResolver>[1]) => resolveGrounding(grounding, graph, context),
      graph.revision === undefined ? {} : { graphRevision: graph.revision },
    ),
  };
}

function applyOptionsFrom(options: WikiWriteOptions): ApplyOptions {
  return { ...planOptionsFrom(options), ...groundingResolverFor(options) };
}

function planOptionsFrom(options: WikiWriteOptions): PlanOptions {
  return {
    scaffoldRoot: resolve(options.scaffoldRoot),
    captureCreationProvenance: true,
    // Authored entries take their place in the structure as they are written:
    // a `refines` to what encloses them, and a file-level entity when the file
    // has none. See `createWithStructure` in `operations.ts`.
    deriveStructure: true,
    ...(options.indexPath === undefined ? {} : { indexPath: options.indexPath }),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.graph === undefined || options.graph === null ? {} : { graph: options.graph }),
  };
}

export interface PlanData {
  planned: boolean;
  opId: string | null;
  /** The unified diff a reviewer reads, and the hash that pins it. */
  preview: WikiPreview | null;
  diff: string | null;
  /** Files the plan would touch. Empty on a refusal. */
  files: string[];
  /**
   * The exact bytes each touched file would contain, keyed by path.
   *
   * §21.3 requires that "dry-run returns the exact intended diff", and the
   * rendered hunks cannot carry that: they are a *display* diff, line-based
   * and deliberately lossy about trailing newlines, so a reviewer tool that
   * reconstructed a file from them would not get the file back. The preview
   * hash binds the proposal but cannot be compared against anything a caller
   * can see. This is what makes the clause checkable from outside: plan, hold
   * these bytes, apply, and compare.
   */
  proposedText: Record<string, string>;
  /** Validated executable value. Consumers treat this as opaque. */
  plan: WikiPatchPlan | null;
}

/** §16 `wiki_plan_operation` — plan and diff, never write. */
export function wikiPlanOperation(
  envelope: unknown,
  options: WikiWriteOptions,
): ServiceResult<PlanData> {
  const planned = planOperation(envelope, planOptionsFrom(options));
  if (!planned.ok) {
    return {
      data: { planned: false, opId: null, preview: null, diff: null, files: [], proposedText: {}, plan: null },
      diagnostics: planned.diagnostics,
    };
  }
  const preview = previewPlan(planned.plan);
  return {
    data: {
      planned: true,
      opId: planned.plan.opId,
      preview,
      diff: renderPreview(preview),
      files: planned.plan.files.map((file) => file.path),
      proposedText: Object.fromEntries(planned.plan.files.map((file) => [file.path, file.proposedText])),
      plan: planned.plan,
    },
    diagnostics: planned.diagnostics,
  };
}

export interface ApplyData extends PlanData {
  /** True only when bytes were written. False for every plan-only outcome. */
  applied: boolean;
  /** True when the audit log already held a completion for this `opId`. */
  replayed: boolean;
  changedFiles: string[];
  createdIds: string[];
}

/**
 * §16 `wiki_apply_operation` — plan, and write **only** with explicit authority.
 *
 * `apply: true` is the authority, and its absence is a plan rather than an
 * error, because §5.4's posture is that agents propose and MEX applies. The
 * negative worth asserting is not that the return value is a plan — a tool that
 * returned a plan *and* wrote would satisfy that — but that nothing on disk
 * moved and no audit line was appended.
 */
export function wikiApplyOperation(
  envelope: unknown,
  options: WikiWriteOptions & {
    apply?: boolean;
    plan?: WikiPatchPlan;
    expectedPreviewRevision?: string;
    /** Explicit maintenance such as reground keeps a full refresh. */
    targetedGroundings?: boolean;
  },
): ServiceResult<ApplyData> {
  // A file-level create cannot be freshly planned after its one metadata map
  // exists. Plain CLI retries may instead read exact terminal audit proof.
  // Executable-plan callers retain their existing preview validation path.
  if (options.apply === true && options.plan === undefined && options.expectedPreviewRevision === undefined) {
    const replay = completedCreateReplay(envelope, options.scaffoldRoot);
    if (replay !== null) return replay;
  }
  if (options.graph?.verifySource) {
    // Prove new links before the planner translates expected edit failures
    // into diagnostics. A stale source must retain the graph refusal path.
    const validated = validateOperation(envelope, rootContext());
    if (validated.ok && (validated.value.type === "create-entry" || validated.value.type === "set-grounding")) {
      for (const grounding of validated.value.payload.groundsTo ?? []) {
        if (grounding.file) verifyLinkedSource(options.graph, grounding.file);
        if ("node" in grounding) options.graph.getNode(grounding.node);
      }
    }
  }
  const planned = wikiPlanOperation(envelope, options);
  if (planned.data.plan && options.graph?.verifySource) {
    // Include removed links and other entities sharing a changed file.
    // The plan owns these contained, revision-bound source bytes.
    for (const file of planned.data.plan.files) {
      for (const text of [file.baseText, file.proposedText]) {
        for (const { entity } of parseWikiMarkdown({ path: file.path, text,
          ...(options.registry === undefined ? {} : { registry: options.registry }),
        }).entities) {
          for (const grounding of entity.groundsTo) {
            if (grounding.file) verifyLinkedSource(options.graph, grounding.file);
            options.graph.getNode(grounding.node);
          }
        }
      }
    }
  }
  if (options.apply !== true || !planned.data.planned) {
    return {
      data: { ...planned.data, applied: false, replayed: false, changedFiles: [], createdIds: [] },
      diagnostics: planned.diagnostics,
    };
  }

  const applyOptions: ApplyOptions = { ...applyOptionsFrom(options), targetedGroundings: options.targetedGroundings !== false };
  const result = options.plan !== undefined && options.expectedPreviewRevision !== undefined
    ? applyPlannedOperation(options.plan, {
        ...applyOptions,
        expectedPreviewHash: options.expectedPreviewRevision,
      })
    : applyOperation(envelope, applyOptions);
  return {
    data: {
      ...planned.data,
      applied: result.ok && !result.replayed,
      replayed: result.replayed,
      changedFiles: [...result.changedFiles],
      createdIds: [...result.createdIds],
    },
    diagnostics: suppressIndexRefresh(result.diagnostics, options),
  };
}

function completedCreateReplay(envelope: unknown, scaffoldRoot: string): ServiceResult<ApplyData> | null {
  const validated = validateOperation(envelope, rootContext());
  if (!validated.ok || validated.value.type !== "create-entry") return null;
  const operation = validated.value;
  const log = readAuditLog(scaffoldRoot);
  const complete = recordFor(log, operation.opId).complete;
  if (complete === null) return null;
  const exact = !hasBlockingDiagnostic(log.diagnostics)
    && complete.type === operation.type
    && complete.payloadHash === payloadHashOf(operation.type, operation.payload)
    && complete.actor?.kind === operation.actor.kind
    && complete.actor?.id === operation.actor.id
    && complete.sessionId === operation.actor.sessionId
    && complete.timestamp === operation.timestamp
    && complete.reason === operation.reason
    && Array.isArray(complete.files) && complete.files.length === 1 && complete.files[0] === operation.payload.file
    // Two ids when the create also stamped its file's file-level entity.
    && complete.createdIds.length >= 1 && complete.createdIds.length <= 2 && complete.createdIds.every(isEntityId)
    && complete.entityIds.length === 0;
  return {
    data: {
      planned: false, opId: operation.opId, preview: null, diff: null, files: [], proposedText: {}, plan: null,
      applied: false, replayed: exact, changedFiles: [], createdIds: exact ? [...complete.createdIds] : [],
    },
    diagnostics: exact ? log.diagnostics : [...log.diagnostics, diagnostic(
      "INVALID_OPERATION_ENVELOPE",
      "This create operation ID already has a completion with different content or authority, or its audit proof is invalid.",
    )],
  };
}

/**
 * Drop `INDEX_REFRESH_REQUIRED` when the scaffold has no index at all.
 *
 * Handoff §54.8: nothing in production has ever built an index, so *every*
 * apply in the wild returns that warning today. It is correct — the cache the
 * write invalidated does not exist — and telling a user to refresh a thing they
 * have never had teaches them to ignore a diagnostic code, which is the more
 * expensive habit. It stays when there *is* an index, because then it means
 * what it says: the index is now behind the files.
 */
function suppressIndexRefresh(
  diagnostics: readonly WikiDiagnostic[],
  options: WikiServiceOptions,
): WikiDiagnostic[] {
  if (existsSync(indexPathFor(options))) return [...diagnostics];
  return diagnostics.filter((entry) => entry.code !== "INDEX_REFRESH_REQUIRED");
}

// -- batches -------------------------------------------------------------------

/** The most operations one `wiki apply` batch may hold. */
export const WIKI_APPLY_BATCH_MAX = 200;

/** What happened to one operation of a batch. */
export interface BatchOperationOutcome {
  /** Position in the array the caller supplied. */
  index: number;
  opId: string | null;
  type: string | null;
  /**
   * `planned`: would be written (plan only). `applied`: written by this call.
   * `replayed`: already recorded with this exact payload; nothing to do.
   * `resumed`: an earlier interrupted write of this operation, finished now.
   * `refused`: has a problem; see the diagnostics under this index.
   * `blocked`: fine itself, but not written because another operation was refused.
   */
  status: "planned" | "applied" | "replayed" | "resumed" | "refused" | "blocked";
  createdIds: string[];
  files: string[];
}

export interface ApplyBatchData {
  batch: true;
  /** True when every pending operation planned; nothing is written otherwise. */
  planned: boolean;
  /** True only when this call wrote bytes. */
  applied: boolean;
  /** True when every operation was already recorded, so there was nothing to do. */
  replayed: boolean;
  operations: BatchOperationOutcome[];
  /** The unified diff of every pending operation, in order. */
  diff: string | null;
  /** Files the pending operations touch. */
  files: string[];
  changedFiles: string[];
  createdIds: string[];
}

/** Mark a diagnostic as belonging to one operation of a batch. */
function forOperation(index: number, opId: string | null, entry: WikiDiagnostic): WikiDiagnostic {
  return {
    ...entry,
    message: `Operation ${index}${opId === null ? "" : ` (${opId})`}: ${entry.message}`,
    path: entry.path === undefined ? `[${index}]` : `[${index}].${entry.path}`,
  };
}

/** Hand back recorded ids in order: the ids an interrupted create already minted. */
function recordedIds(ids: readonly string[]): () => EntityId {
  let next = 0;
  return () => {
    const id = ids[next];
    next += 1;
    if (id === undefined) throw new Error("an interrupted operation minted more ids than its intent recorded");
    return id as EntityId;
  };
}

/**
 * `wiki apply` with an array of envelopes: every operation or none of them.
 *
 * The whole batch is checked before anything is planned, and planned before
 * anything is written, and every problem found on the way is reported under
 * its index — an agent fixes the file once, not once per mistake. Then the
 * pending operations are written in order as one transaction, under one Wiki
 * lease and against one graph snapshot (the caller's): one audit record per
 * operation, one index refresh, and an ordinary failure rolls every byte back.
 *
 * Replay is per operation, by `opId`, exactly as for a single envelope: an
 * operation already recorded with the same payload is skipped, one recorded
 * with a different payload is refused. So a batch can be re-run after a crash,
 * or grown and re-run, and only what is new is written. An operation whose
 * write was interrupted (an intent with no completion) is finished first,
 * reusing the ids it recorded, before the rest are planned.
 */
export function wikiApplyOperationBatch(
  envelopes: unknown,
  options: WikiWriteOptions & { apply?: boolean; targetedGroundings?: boolean },
): ServiceResult<ApplyBatchData> {
  const data: ApplyBatchData = {
    batch: true, planned: false, applied: false, replayed: false, operations: [],
    diff: null, files: [], changedFiles: [], createdIds: [],
  };
  if (!Array.isArray(envelopes) || envelopes.length === 0) {
    return { data, diagnostics: [diagnostic("INVALID_OPERATION_ENVELOPE", "An operation batch is a JSON array of one or more operation envelopes.")] };
  }
  if (envelopes.length > WIKI_APPLY_BATCH_MAX) {
    return { data, diagnostics: [diagnostic(
      "INVALID_OPERATION_ENVELOPE",
      `An operation batch holds at most ${WIKI_APPLY_BATCH_MAX} operations; this one has ${envelopes.length}. Split it into several files and apply each.`,
    )] };
  }

  const scaffoldRoot = resolve(options.scaffoldRoot);
  const outcomes: BatchOperationOutcome[] = envelopes.map((envelope, index) => {
    const raw = envelope !== null && typeof envelope === "object" ? envelope as Record<string, unknown> : {};
    return {
      index,
      opId: typeof raw["opId"] === "string" ? raw["opId"] : null,
      type: typeof raw["type"] === "string" ? raw["type"] : null,
      status: "planned",
      createdIds: [],
      files: [],
    };
  });
  data.operations = outcomes;
  const diagnostics: WikiDiagnostic[] = [];
  const refuse = (index: number, entries: readonly WikiDiagnostic[]): void => {
    outcomes[index]!.status = "refused";
    diagnostics.push(...entries.map((entry) => forOperation(index, outcomes[index]!.opId, entry)));
  };
  const finish = (): ServiceResult<ApplyBatchData> => {
    if (diagnostics.some((entry) => entry.severity === "error")) {
      for (const outcome of outcomes) if (outcome.status === "planned") outcome.status = "blocked";
    }
    // A resumed operation is written even when the rest of the batch is refused.
    data.applied = outcomes.some((outcome) => outcome.status === "applied" || outcome.status === "resumed");
    data.changedFiles = [...new Set(data.changedFiles)].sort();
    data.createdIds = outcomes.flatMap((outcome) => outcome.createdIds);
    return { data, diagnostics: suppressIndexRefresh(diagnostics, options) };
  };

  // -- 1. every envelope, on its own --------------------------------------
  const operations = envelopes.map((envelope, index) => {
    const validated = validateOperation(envelope, rootContext());
    if (!validated.ok) {
      refuse(index, validated.diagnostics);
      return null;
    }
    return validated.value;
  });
  const firstIndex = new Map<string, number>();
  operations.forEach((operation, index) => {
    if (operation === null) return;
    const earlier = firstIndex.get(operation.opId);
    if (earlier === undefined) firstIndex.set(operation.opId, index);
    else refuse(index, [diagnostic("INVALID_OPERATION_ENVELOPE", `opId ${operation.opId} is already used by operation ${earlier}; every operation in a batch needs its own opId.`)]);
  });

  // -- 2. against the operation log ---------------------------------------
  const log = readAuditLog(scaffoldRoot);
  if (hasBlockingDiagnostic(log.diagnostics)) {
    diagnostics.push(...log.diagnostics);
    return finish();
  }
  const pending: number[] = [];
  let interrupted: { index: number; createdIds: readonly string[] } | null = null;
  operations.forEach((operation, index) => {
    if (operation === null || outcomes[index]!.status === "refused") return;
    const record = recordFor(log, operation.opId);
    const recorded = record.complete ?? record.intent;
    const payloadHash = payloadHashOf(operation.type, operation.payload);
    if (recorded !== null && (recorded.type !== operation.type || recorded.payloadHash !== payloadHash)) {
      refuse(index, [diagnostic(
        "INVALID_OPERATION_ENVELOPE",
        `opId ${operation.opId} is already recorded for a different change. Reusing an opId for different content is refused; give a new change a new opId.`,
      )]);
      return;
    }
    if (record.complete !== null) {
      Object.assign(outcomes[index]!, { status: "replayed", createdIds: [...record.complete.createdIds], files: [...record.complete.files] });
      return;
    }
    if (record.intent !== null) {
      if (interrupted !== null) {
        refuse(index, [diagnostic(
          "CONTENT_HASH_CONFLICT",
          `More than one operation of this batch has an interrupted write (operations ${interrupted.index} and ${index}); the operation log is not one this batch produced.`,
        )]);
        return;
      }
      interrupted = { index, createdIds: record.intent.createdIds };
    }
    pending.push(index);
  });
  // An envelope already refused does not stop the rest from being planned:
  // their problems are reported in the same pass, and nothing is written.
  const refusedEarly = diagnostics.some((entry) => entry.severity === "error");
  if (pending.length === 0) {
    if (!refusedEarly) data.replayed = true;
    diagnostics.push(...log.diagnostics);
    return finish();
  }

  // -- 3. plan, and apply under one lease ---------------------------------
  const write = options.apply === true && !refusedEarly;
  const applyOptions: ApplyOptions = { ...applyOptionsFrom(options), targetedGroundings: options.targetedGroundings !== false };
  // New links must keep the same stale-graph refusal as single apply, before
  // planning translates an expected edit failure into a diagnostic.
  if (options.graph?.verifySource) {
    for (const index of pending) {
      const operation = operations[index];
      if (operation?.type === "create-entry" || operation?.type === "set-grounding") {
        for (const grounding of operation.payload.groundsTo ?? []) {
          if (grounding.file) verifyLinkedSource(options.graph, grounding.file);
          if ("node" in grounding) options.graph.getNode(grounding.node);
        }
      }
    }
  }
  const verifyText = (path: string, text: string | null): void => {
    if (!options.graph?.verifySource || text === null) return;
    for (const { entity } of parseWikiMarkdown({ path, text,
      ...(options.registry === undefined ? {} : { registry: options.registry }),
    }).entities) {
      for (const grounding of entity.groundsTo) {
        if (grounding.file) verifyLinkedSource(options.graph, grounding.file);
        options.graph.getNode(grounding.node);
      }
    }
  };
  const lease = write ? acquireWikiMaintenanceLease(indexPathFor(options), "operation", scaffoldRoot) : null;
  try {
    const resume = interrupted as { index: number; createdIds: readonly string[] } | null;
    let toPlan = pending;
    if (resume !== null && write) {
      // Recovery may publish an already-written file without a new plan.
      // Prove its siblings before resuming and refreshing that file's rows.
      if (options.graph?.verifySource) {
        for (const file of recordFor(log, operations[resume.index]!.opId).intent!.files) {
          const path = resolve(scaffoldRoot, file);
          if (existsSync(path)) verifyText(file, readContainedSource(scaffoldRoot, path));
        }
      }
      // Finished through the single-operation path, which reuses the recorded
      // ids and recognises a write that landed before the process died.
      const resumed = applyOperation(envelopes[resume.index], { ...applyOptions, maintenanceLease: lease! });
      if (!resumed.ok) {
        refuse(resume.index, resumed.diagnostics);
        return finish();
      }
      Object.assign(outcomes[resume.index]!, { status: "resumed", createdIds: [...resumed.createdIds], files: [...resumed.changedFiles] });
      data.changedFiles.push(...resumed.changedFiles);
      diagnostics.push(...resumed.diagnostics.map((entry) => forOperation(resume.index, outcomes[resume.index]!.opId, entry)));
      toPlan = pending.filter((index) => index !== resume.index);
    }
    if (toPlan.length > 0) {
      const planned = planOperationBatchReport(
        toPlan.map((index) => operations[index]),
        { ...planOptionsFrom(options), parseCache: createParseCache() },
        {
          reportAll: true,
          optionsFor: (position) => resume !== null && toPlan[position] === resume.index
            ? { generateId: recordedIds(resume.createdIds) }
            : undefined,
        },
      );
      if (!planned.ok) {
        for (const refusal of planned.refusals) refuse(toPlan[refusal.index]!, refusal.diagnostics);
        return finish();
      }
      if (refusedEarly) return finish();
      const plans = planned.plan.operations;
      for (const plan of plans) {
        for (const file of plan.files) {
          verifyText(file.path, file.baseText);
          verifyText(file.path, file.proposedText);
        }
      }
      plans.forEach((plan, position) => {
        const index = toPlan[position]!;
        outcomes[index]!.files = plan.files.map((file) => file.path);
        diagnostics.push(...plan.diagnostics.map((entry) => forOperation(index, plan.opId, entry)));
      });
      data.files = [...new Set(plans.flatMap((plan) => plan.files.map((file) => file.path)))].sort();
      data.diff = plans.map((plan) => renderPreview(previewPlan(plan))).join("\n");
      data.planned = true;
      if (!write) return finish();

      const applied = applyPlannedOperationBatch(planned.plan, {
        ...applyOptions,
        expectedPreviewRevision: planned.plan.previewRevision,
        maintenanceLease: lease!,
      });
      const fromPlans = new Set(plans.flatMap((plan) => plan.diagnostics));
      diagnostics.push(...applied.diagnostics.filter((entry) => !fromPlans.has(entry)));
      if (!applied.ok) {
        for (const index of toPlan) outcomes[index]!.status = "blocked";
        return finish();
      }
      plans.forEach((plan, position) => {
        Object.assign(outcomes[toPlan[position]!]!, { status: "applied", createdIds: [...plan.createdIds] });
      });
      data.changedFiles.push(...applied.changedFiles);
    }
    data.planned = true;
    return finish();
  } finally {
    lease?.release();
  }
}

export interface RebuildData {
  indexPath: string;
  fileCount: number;
  entityCount: number;
  /** Temp databases a crashed earlier build left behind, removed before this one. */
  sweptTempFiles: string[];
}

/**
 * `wiki rebuild-index` — the only command that builds one.
 *
 * Every other path in this engine reads, and P3's layering lint enforces that
 * `src/wiki/query/` cannot even import this module. §15.2 permits a read to
 * auto-rebuild "only when explicitly configured", and this is the explicit
 * configuration: a command the user runs.
 */
export function wikiRebuildIndex(options: WikiWriteOptions): ServiceResult<RebuildData> {
  return rebuildServiceResult(rebuildWikiIndex(rebuildOptionsFrom(options)));
}

/**
 * `wiki rebuild-index` in two phases, for a caller holding a graph snapshot
 * that must prove itself fresh before the index is published (#232).
 *
 * The candidate is built and preflighted while the snapshot is open; `commit`
 * publishes it and `discard` drops it. The same shape the repository adapter
 * hands the graph's two-phase publication, so a CLI rebuild and a Hub rebuild
 * cannot publish health from a graph that changed under them.
 */
export function wikiPrepareRebuildIndex(options: WikiWriteOptions): {
  preflight(): void;
  commit(): ServiceResult<RebuildData>;
  discard(): void;
} {
  const prepared = prepareWikiRebuild(rebuildOptionsFrom(options));
  return {
    preflight: () => prepared.preflight(),
    commit: () => rebuildServiceResult(prepared.commit()),
    discard: () => prepared.discard(),
  };
}

function rebuildOptionsFrom(options: WikiWriteOptions): RebuildOptions {
  return {
    scaffoldRoot: resolve(options.scaffoldRoot),
    ...(options.indexPath === undefined ? {} : { indexPath: options.indexPath }),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.maintenance === undefined ? {} : { maintenance: options.maintenance }),
    ...groundingResolverFor(options),
  };
}

function rebuildServiceResult(result: RebuildResult): ServiceResult<RebuildData> {
  return {
    data: {
      indexPath: result.indexPath,
      fileCount: result.fileCount,
      entityCount: result.entityCount,
      sweptTempFiles: result.sweptTempFiles,
    },
    diagnostics: result.diagnostics,
  };
}

export interface RefreshData {
  indexPath: string;
  /** Files re-read and re-projected. */
  reparsed: string[];
  /** Files whose rows were dropped — gone from disk, or newly excluded. */
  removed: string[];
  /** Present and byte-identical to what the index already held. */
  unchanged: string[];
}

/**
 * §7.2's `refreshFiles(paths)` — reparse a changed set, re-resolve everything.
 *
 * A service function rather than something the facade reaches into `index/`
 * for, because the rule that makes §20.7's parity checkable is that nothing
 * above this layer imports the layers below it.
 *
 * The name is honest about the asymmetry P3 built in: **incremental means
 * incremental *parsing*.** Every derived fact — shadowing, target resolution,
 * every set-level diagnostic — is recomputed globally from the rows on both
 * build paths, because "anything that pointed at the changed files" is not
 * knowable from the changed set alone: a file that *arrives* can resolve a
 * reference that has been dangling for weeks. Parsing is the expensive part and
 * parsing is the only thing this skips.
 *
 * A missing or unreadable index is a typed diagnostic, never a rebuild.
 */
export function wikiRefreshIndex(
  options: WikiWriteOptions & { changed: readonly string[] },
): ServiceResult<RefreshData> {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const indexPath = indexPathFor(options);
  const result = refreshWikiIndex({
    scaffoldRoot,
    indexPath,
    changed: options.changed,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.maintenance === undefined ? {} : { maintenance: options.maintenance }),
    ...groundingResolverFor(options),
  });
  if (!result.ok) {
    return {
      data: { indexPath, reparsed: [], removed: [], unchanged: [] },
      diagnostics: [result.diagnostic],
    };
  }
  return {
    data: { indexPath, reparsed: result.reparsed, removed: result.removed, unchanged: result.unchanged },
    diagnostics: result.diagnostics,
  };
}

/**
 * A digest of what a migration report proposes to do.
 *
 * §7.2 splits migration into `planMigration()` and `applyMigration(plan)`, and
 * a two-phase signature whose second half ignores its argument is decoration.
 * mex's `migrateScaffold` re-plans rather than replaying a stored plan — which
 * is right, and is the same reasoning that keeps `applyOperation` from carrying
 * offsets across the revalidation boundary — so the plan cannot be *executed*.
 * It can be *checked*, and that is what this is for: the facade re-plans, and
 * refuses when the tree has moved under the plan the caller is holding.
 *
 * Only the decided work is in the digest. Diffs and diagnostics are excluded
 * deliberately: a diagnostic can change because a file the migration does not
 * touch became unreadable, and refusing then would be refusing for a reason
 * that is not about the plan. What is in it is what P6 made deterministic — the
 * planned entities and where each goes, the counts, and the abstentions — so an
 * ordinary re-run digests identically and a real change does not.
 */
export function migrationPlanDigest(report: MigrationReport): string {
  const shape = {
    planned: report.planned.map((entry) => [entry.file, entry.type, entry.title, entry.location, entry.rule]),
    filesSkipped: report.filesSkipped.map((entry) => [entry.file, entry.reason]),
    abstentions: report.abstentions.map((entry) => Object.entries(entry).sort()),
    entitiesByType: Object.entries(report.entitiesByType).sort(),
    edgesConverted: report.edgesConverted,
    edgesAmbiguous: report.edgesAmbiguous,
    groundingsPreserved: report.groundingsPreserved,
    groundingsMoved: report.groundingsMoved,
    groundingsAmbiguous: report.groundingsAmbiguous,
  };
  return createHash("sha256").update(JSON.stringify(shape), "utf8").digest("hex");
}

export interface MigrateData {
  report: MigrationReport;
  /** The §13.6 report as text, for a human. */
  rendered: string;
  dryRun: boolean;
  /** True when the report holds something that must be resolved before applying. */
  blocked: boolean;
}

/**
 * `wiki migrate` — P6's run, behind a command.
 *
 * A dry run writes nothing and mints no id, which P6's own tests prove of the
 * library; this adds no policy of its own beyond choosing which of the two
 * functions to call. **Abstentions are not diagnostics** (finding 65.4): an
 * abstention is a decision not to decide and belongs in the report, and a
 * surface that collapsed the two would make migration look like it had failed
 * on a scaffold it handled correctly.
 */
export function wikiMigrate(
  options: WikiWriteOptions & { dryRun?: boolean; now?: () => string; projectRoot?: string },
): ServiceResult<MigrateData> {
  const migrateOptions = {
    scaffoldRoot: resolve(options.scaffoldRoot),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.graph === undefined ? {} : { graph: options.graph }),
    ...(options.indexPath === undefined ? {} : { indexPath: options.indexPath }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
  };
  const dryRun = options.dryRun === true;
  const report = dryRun ? planMigration(migrateOptions) : migrateScaffold(migrateOptions);
  return {
    data: {
      report,
      rendered: renderMigrationReport(report),
      dryRun,
      blocked: reportIsBlocked(report),
    },
    diagnostics: suppressIndexRefresh(report.diagnostics, options),
  };
}

/** A parse cache scoped to one batch of operations. Exposed so a caller can share one. */
export { createParseCache };

/** The typed refusal for an operation file that is not an operation. */
export function malformedOperationDiagnostic(path: string, reason: string): WikiDiagnostic {
  return diagnostic("INVALID_OPERATION_ENVELOPE", `${path} is not a readable operation envelope: ${reason}`, {
    file: path,
  });
}


/**
 * Which entity type a file's generated section lists, read off the path.
 *
 * The same convention the classifier keys on, and the same one `wiki validate`
 * uses to decide what to check. A file with a generated region and no rule is
 * left alone: the section may be generated by something else entirely, and
 * rewriting it would be MEX taking ownership of a block it does not understand.
 */
function generatedViewTypeFor(path: string): WikiEntityType | null {
  if (/(^|\/)patterns\/(INDEX|README)\.md$/.test(path)) return "pattern";
  if (/(^|\/)decisions?\.md$/.test(path)) return "decision";
  return null;
}

export interface RegenerateData {
  /** Every generated section found, whether or not it had drifted. */
  examined: string[];
  /** The ones that had drifted and were rewritten. */
  changedFiles: string[];
  /** True when nothing was written because the caller only asked what would be. */
  dryRun: boolean;
}

/**
 * Regenerate every generated section that has drifted — P6's stated seam, closed.
 *
 * The reasoning for why this is not an operation lives on `applyGeneratedViews`
 * in `operations/apply.ts`, beside the writer it uses. Here it is only a matter
 * of finding the sections and measuring them, which is a read.
 */
export function wikiRegenerateViews(
  options: WikiWriteOptions & { dryRun?: boolean },
): ServiceResult<RegenerateData> {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const inventory = inventoryScaffold({
    scaffoldRoot,
    parseCache: createParseCache(),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });

  const examined: string[] = [];
  const views: GeneratedViewCandidate[] = [];
  const diagnostics: WikiDiagnostic[] = [...inventory.diagnostics];

  for (const file of inventory.files) {
    const type = generatedViewTypeFor(file.path);
    if (type === null) continue;
    const plan = planGeneratedView(file, inventory, type);
    if (plan === null) continue;
    examined.push(file.path);
    diagnostics.push(...plan.diagnostics);
    views.push({
      file: file.path,
      baseText: file.text,
      region: { start: plan.region.start, end: plan.region.end },
      rendered: plan.rendered,
      stale: plan.stale,
    });
  }

  if (options.dryRun === true) {
    return {
      data: { examined, changedFiles: views.filter((view) => view.stale).map((view) => view.file), dryRun: true },
      diagnostics,
    };
  }

  const applied = applyGeneratedViews({ ...applyOptionsFrom(options), views });
  return {
    data: { examined, changedFiles: applied.changedFiles, dryRun: false },
    diagnostics: [...diagnostics, ...suppressIndexRefresh(applied.diagnostics, options)],
  };
}
