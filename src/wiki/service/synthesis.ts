/**
 * §12 behind the service contract — the three verbs synthesis needs.
 *
 * - `wikiSynthesisBuild` prepares a run and renders the agent playbook.
 * - `wikiSynthesisPrepare` returns the deterministic scope and the prompt for
 *   one stage. This is what the reference's three "get context" and "get
 *   prompts" tools collapse into; mex's agent channel is commands, not tools.
 * - `wikiSynthesisPropose` takes what the agent sends back and turns it into
 *   operation plans, applying only with explicit authority.
 *
 * ## Why three invocations rather than one
 *
 * Stages B and C read entities that *exist*. In the reference, stage A wrote
 * rows as it went, so one agent run did all three. Here stage A only proposes,
 * so there is a human between A and B by construction. Two alternatives were
 * considered and rejected, and the reasoning is in the handoff: letting the
 * agent apply between stages turns the review guarantee into a prompt, and
 * running B and C over *unapplied* proposals is not merely lossy — a proposal
 * has no id and no content hash, so the preconditions P5 requires on every
 * mutating operation cannot be formed at all.
 *
 * Nothing here writes Markdown. Everything that does goes through P5, via the
 * same `applyOperation` every other write in this engine uses.
 */

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { diagnostic, hasBlockingDiagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import { withWikiQuery } from "../query/session.js";
import type { WikiQuerySession } from "../query/session.js";
import { resolveBounds } from "../query/budget.js";
import { locateEntity, createParseCache } from "../operations/locate.js";
import { applyPlannedOperationBatch, planOperationBatch } from "../operations/batch.js";
import { readAuditLog, recordFor } from "../operations/audit.js";
import { payloadHashOf } from "../operations/plan.js";
import { validateOperation } from "../model/operation.js";
import { rootContext } from "../model/validate.js";
import { previewPlan, renderPreview } from "../operations/preview.js";
import { findClusters } from "../synthesis/cluster.js";
import { extractClusterContext } from "../synthesis/context.js";
import { renderPrompt, SYNTHESIS_STAGES, type SynthesisStage } from "../synthesis/prompts.js";
import { extractArray, validateCandidateUnits } from "../synthesis/candidates.js";
import { proposeUnits } from "../synthesis/propose.js";
import { renderPlaybook } from "../synthesis/playbook.js";
import {
  findCandidateGroups,
  planGlobalPass,
  validateGlobalPassActions,
  type CandidateGroup,
  type WikiUnit,
} from "../synthesis/global-pass.js";
import {
  findRelationshipCandidates,
  planRelationships,
  validateRelationshipJudgments,
  type RelationshipCandidate,
} from "../synthesis/relationships.js";
import type { SynthesisGraph } from "../grounding/adapter.js";
import type { ServiceResult } from "./read.js";
import { indexPathFor } from "./read.js";
import type { WikiWriteOptions } from "./write.js";

/** The stages `wiki prepare` and `wiki propose` understand. */
export const SYNTHESIS_PREPARE_STAGES = [...SYNTHESIS_STAGES, "global", "relationships"] as const;
export type PrepareStage = (typeof SYNTHESIS_PREPARE_STAGES)[number];

export function isPrepareStage(value: unknown): value is PrepareStage {
  return typeof value === "string" && (SYNTHESIS_PREPARE_STAGES as readonly string[]).includes(value);
}

/** Everything a synthesis call needs beyond where the scaffold is. */
export interface SynthesisOptions extends WikiWriteOptions {
  /** The repository the code graph was built from, for reading source. */
  repoRoot: string;
  /** Enumeration over the code graph. Absent means there is nothing to cluster. */
  codeGraph?: SynthesisGraph | null;
  /** §12 scope knobs, already normalized by `loadWikiConfig`. */
  scope?: SynthesisScope;
  /** Optional root-product policy applied before any proposal is planned or written. */
  operationGuard?: (envelope: unknown) => readonly WikiDiagnostic[];
  /** @internal Capture an exact batch for publication after Graph revalidation. */
  deferApply?: (commit: () => SynthesisBatchWrite) => void;
}

interface SynthesisBatchWrite {
  applied: boolean;
  changedFiles: string[];
  createdIds: string[];
  diagnostics: readonly WikiDiagnostic[];
}

export interface SynthesisScope {
  minFiles: number;
  maxTokens: number;
  primaryContextLines: number;
  maxFileLines: number;
  supportingMaxLines: number;
  maxCandidates: number;
  maxPerUnit: number;
  maxGroups: number;
  maxNodes: number;
}

const DEFAULT_SCOPE: SynthesisScope = {
  minFiles: 1,
  maxTokens: 4000,
  primaryContextLines: 3,
  maxFileLines: 400,
  supportingMaxLines: 120,
  maxCandidates: 60,
  maxPerUnit: 6,
  maxGroups: 40,
  maxNodes: 60,
};

function scopeOf(options: SynthesisOptions): SynthesisScope {
  return options.scope ?? DEFAULT_SCOPE;
}

const NO_GRAPH = diagnostic(
  "WIKI_INDEX_MISSING",
  "No code graph in this checkout, so there is no code to synthesize knowledge about.",
  { remediation: "Run `mex graph` to build the code graph, then re-run this command." },
);

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

export interface BuildData {
  clusters: Array<{ name: string; files: number; symbols: number }>;
  /** The rendered agent playbook. */
  playbook: string;
}

/**
 * `wiki build` — discover clusters and render the playbook.
 *
 * Writes nothing, anywhere. The reference wrote its playbook to a file beside
 * the database; `mex sync` does not, and following `mex sync` is right here:
 * the playbook is a prompt, not an artefact, and a file under `.mex/` would be
 * a write into the scaffold that no operation accounts for.
 */
export function wikiSynthesisBuild(options: SynthesisOptions & { cluster?: string }): ServiceResult<BuildData> {
  if (options.codeGraph === undefined || options.codeGraph === null) {
    return { data: { clusters: [], playbook: "" }, diagnostics: [NO_GRAPH] };
  }
  const scope = scopeOf(options);
  const clusters = findClusters(options.codeGraph, { minFiles: scope.minFiles });
  return {
    data: {
      clusters: clusters.map((cluster) => ({
        name: cluster.name,
        files: cluster.files.length,
        symbols: cluster.nodeIds.length,
      })),
      playbook: renderPlaybook({
        repoRoot: options.repoRoot,
        scaffoldRoot: resolve(options.scaffoldRoot),
        clusters: clusters.map((cluster) => cluster.name),
        ...(options.cluster === undefined ? {} : { cluster: options.cluster }),
      }),
    },
    diagnostics: [],
  };
}

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

export interface PrepareData {
  stage: PrepareStage;
  cluster: string | null;
  /** The two strings the agent sends to its own model. */
  prompt: { system: string; user: string } | null;
  /** Stage A only: the cluster context, so an agent can inspect what it was given. */
  context: unknown;
  /** Stage B only. */
  groups: CandidateGroup[];
  /** Stage C only. */
  candidates: RelationshipCandidate[];
  /** True when a bound cut the context, the groups or the candidates. */
  truncated: boolean;
}

function emptyPrepare(stage: PrepareStage): PrepareData {
  return { stage, cluster: null, prompt: null, context: null, groups: [], candidates: [], truncated: false };
}

/**
 * `wiki prepare` — the deterministic half of one stage.
 *
 * Same graph and same scaffold give byte-identical output. The only
 * non-determinism in this whole pipeline is the agent's model, and it lives
 * outside mex entirely.
 */
export function wikiSynthesisPrepare(
  options: SynthesisOptions & { stage: PrepareStage; cluster?: string },
): ServiceResult<PrepareData> {
  const empty = emptyPrepare(options.stage);
  if (options.codeGraph === undefined || options.codeGraph === null) {
    return { data: empty, diagnostics: [NO_GRAPH] };
  }
  const scope = scopeOf(options);
  const graph = options.codeGraph;

  if (options.stage === "global" || options.stage === "relationships") {
    const projected = projectUnits(options);
    if (projected.diagnostics.length > 0) return { data: empty, diagnostics: projected.diagnostics };

    if (options.stage === "global") {
      const groups = findCandidateGroups(projected.units, { maxGroups: scope.maxGroups });
      return {
        data: {
          ...empty,
          groups,
          truncated: projected.truncated,
          prompt: {
            system: GLOBAL_PASS_SYSTEM,
            user: renderGlobalPassUser(groups),
          },
        },
        diagnostics: [],
      };
    }

    const candidates = findRelationshipCandidates(
      projected.units,
      { outgoingEdges: (nodeId) => graph.outgoingEdges(nodeId) },
      { maxCandidates: scope.maxCandidates, maxPerUnit: scope.maxPerUnit },
    );
    return {
      data: {
        ...empty,
        candidates,
        truncated: projected.truncated,
        prompt: { system: RELATIONSHIP_SYSTEM, user: renderRelationshipUser(candidates) },
      },
      diagnostics: [],
    };
  }

  const clusters = findClusters(graph, { minFiles: scope.minFiles });
  const wanted = options.cluster === undefined ? clusters[0] : clusters.find((entry) => entry.name === options.cluster);
  if (wanted === undefined) {
    return {
      data: empty,
      diagnostics: [
        diagnostic(
          "ENTITY_NOT_FOUND",
          options.cluster === undefined
            ? "No clusters in this repository, so there is no scope to prepare."
            : `No cluster named "${options.cluster}". Run \`mex wiki build\` to list them.`,
        ),
      ],
    };
  }

  const context = extractClusterContext(graph, wanted, options.repoRoot, {
    primaryContextLines: scope.primaryContextLines,
    maxFileLines: scope.maxFileLines,
    supportingMaxLines: scope.supportingMaxLines,
    maxTokens: scope.maxTokens,
    maxNodes: scope.maxNodes,
  });
  const prompt = renderPrompt(context, options.stage);
  return {
    data: {
      stage: options.stage,
      cluster: wanted.name,
      prompt: { system: prompt.system, user: prompt.user },
      context,
      groups: [],
      candidates: [],
      truncated: context.truncated === true,
    },
    diagnostics: [],
  };
}

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

export interface ProposeData {
  stage: PrepareStage | null;
  cluster: string | null;
  /** How many candidates the agent sent. */
  received: number;
  /** How many cleared every gate. */
  accepted: number;
  /** Everything refused, with every reason it was refused. */
  rejected: Array<{ reasons: string[] }>;
  /** One line per operation, for a human deciding whether to apply. */
  operations: Array<{ opId: string; summary: string }>;
  /** The unified diff of every operation, or null when nothing planned. */
  diff: string | null;
  /** True only when bytes were written. */
  applied: boolean;
  changedFiles: string[];
  createdIds: string[];
}

function emptyPropose(): ProposeData {
  return {
    stage: null,
    cluster: null,
    received: 0,
    accepted: 0,
    rejected: [],
    operations: [],
    diff: null,
    applied: false,
    changedFiles: [],
    createdIds: [],
  };
}

function unreadable(reason: string): WikiDiagnostic {
  return diagnostic("INVALID_AGENT_RESPONSE", reason);
}

/**
 * `wiki propose` — the agent's answer becomes operation plans.
 *
 * Plans by default and writes only with `apply: true`, which is §16's rule and
 * P9's posture: the safe outcome is what happens when a caller says nothing.
 * One `parseCache` is threaded through the whole batch (finding 65.6) — a
 * synthesis run is precisely the caller that made `applyOperation`'s re-read
 * and re-parse visible.
 */
export function wikiSynthesisPropose(
  options: SynthesisOptions & { responsePath: string; apply?: boolean; stage?: PrepareStage; cluster?: string },
): ServiceResult<ProposeData> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(options.responsePath), "utf-8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { data: emptyPropose(), diagnostics: [unreadable(`${options.responsePath} is not readable JSON: ${reason}`)] };
  }

  const envelope = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const stage = options.stage ?? (isPrepareStage(envelope["stage"]) ? envelope["stage"] : undefined);
  if (stage === undefined) {
    return {
      data: emptyPropose(),
      diagnostics: [
        unreadable(
          `${options.responsePath} does not say which stage it answers. Add a "stage" field, or pass --stage.`,
        ),
      ],
    };
  }

  if (stage === "global") return proposeGlobalPass(options, envelope, stage);
  if (stage === "relationships") return proposeRelationships(options, envelope, stage);
  return proposeUnitsStage(options, envelope, stage);
}

/** Prepare without writes; the repository graph bridge alone releases commit. */
export function wikiPrepareSynthesisPropose(
  options: SynthesisOptions & { responsePath: string; stage?: PrepareStage; cluster?: string },
): { preflight(): void; commit(): ServiceResult<ProposeData>; discard(): void } {
  let pending: (() => SynthesisBatchWrite) | undefined;
  let active = true;
  const result = wikiSynthesisPropose({ ...options, apply: true, deferApply: commit => { pending = commit; } });
  return {
    preflight() {
      if (!active) throw new Error("The synthesis publication is no longer active.");
    },
    commit() {
      if (!active) throw new Error("The synthesis publication is no longer active.");
      active = false;
      if (!pending || hasBlockingDiagnostic(result.diagnostics)) return result;
      const written = pending();
      return {
        data: { ...result.data, applied: written.applied, changedFiles: written.changedFiles, createdIds: written.createdIds },
        diagnostics: [...result.diagnostics, ...written.diagnostics],
      };
    },
    discard() { active = false; pending = undefined; },
  };
}

function proposeUnitsStage(
  options: SynthesisOptions & { responsePath: string; apply?: boolean; cluster?: string },
  envelope: Record<string, unknown>,
  stage: SynthesisStage,
): ServiceResult<ProposeData> {
  const cluster = options.cluster ?? (typeof envelope["cluster"] === "string" ? envelope["cluster"] : undefined);
  if (cluster === undefined) {
    return {
      data: emptyPropose(),
      diagnostics: [unreadable(`${options.responsePath} does not name a cluster. Add a "cluster" field, or pass --cluster.`)],
    };
  }

  const units = extractArray(envelope["units"] ?? envelope, "units");
  if (units === null) {
    return {
      data: emptyPropose(),
      diagnostics: [unreadable(`${options.responsePath} carries no "units" array for stage "${stage}".`)],
    };
  }

  // Re-derive the context rather than trusting one the agent echoed back: the
  // grounding check is only worth anything if the set of legal node ids came
  // from mex.
  const prepared = wikiSynthesisPrepare({ ...options, stage, cluster });
  if (prepared.data.context === null) {
    return { data: { ...emptyPropose(), stage, cluster }, diagnostics: prepared.diagnostics };
  }

  const gated = validateCandidateUnits(units, {
    stage,
    context: prepared.data.context as Parameters<typeof validateCandidateUnits>[1]["context"],
  });
  const proposed = proposeUnits(gated.accepted, {
    graph: options.graph ?? null,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });

  const applied = runBatch(
    options,
    proposed.operations.map((entry) => ({ opId: entry.opId, summary: `create ${entry.unit.type} "${entry.unit.title}" in ${entry.file}`, envelope: entry.envelope })),
  );

  return {
    data: {
      ...applied.data,
      stage,
      cluster,
      received: units.length,
      accepted: gated.accepted.length,
      rejected: [...gated.rejected, ...proposed.rejected].map((entry) => ({ reasons: entry.reasons })),
    },
    diagnostics: [...proposed.diagnostics, ...applied.diagnostics],
  };
}

function proposeGlobalPass(
  options: SynthesisOptions & { responsePath: string; apply?: boolean },
  envelope: Record<string, unknown>,
  stage: PrepareStage,
): ServiceResult<ProposeData> {
  const actions = extractArray(envelope["actions"] ?? envelope, "actions");
  if (actions === null) {
    return { data: emptyPropose(), diagnostics: [unreadable(`${options.responsePath} carries no "actions" array.`)] };
  }

  const projected = projectUnits(options);
  if (projected.diagnostics.length > 0) return { data: emptyPropose(), diagnostics: projected.diagnostics };

  const scope = scopeOf(options);
  const groups = findCandidateGroups(projected.units, { maxGroups: scope.maxGroups });
  const validated = validateGlobalPassActions(actions, groups);
  const planned = planGlobalPass(validated.valid, groups, { graph: options.graph ?? null });
  const applied = runBatch(options, planned.operations.map((entry) => ({ opId: entry.opId, summary: entry.summary, envelope: entry.envelope })));

  return {
    data: {
      ...applied.data,
      stage,
      received: actions.length,
      accepted: validated.valid.length - planned.refused.length,
      rejected: [...validated.rejected, ...planned.refused].map((entry) => ({ reasons: entry.reasons })),
    },
    diagnostics: [...planned.diagnostics, ...applied.diagnostics],
  };
}

function proposeRelationships(
  options: SynthesisOptions & { responsePath: string; apply?: boolean },
  envelope: Record<string, unknown>,
  stage: PrepareStage,
): ServiceResult<ProposeData> {
  const judgments = extractArray(envelope["judgments"] ?? envelope, "judgments");
  if (judgments === null) {
    return { data: emptyPropose(), diagnostics: [unreadable(`${options.responsePath} carries no "judgments" array.`)] };
  }
  if (options.codeGraph === undefined || options.codeGraph === null) {
    return { data: emptyPropose(), diagnostics: [NO_GRAPH] };
  }

  const projected = projectUnits(options);
  if (projected.diagnostics.length > 0) return { data: emptyPropose(), diagnostics: projected.diagnostics };

  const graph = options.codeGraph;
  const scope = scopeOf(options);
  const candidates = findRelationshipCandidates(
    projected.units,
    { outgoingEdges: (nodeId) => graph.outgoingEdges(nodeId) },
    { maxCandidates: scope.maxCandidates, maxPerUnit: scope.maxPerUnit },
  );
  const validated = validateRelationshipJudgments(judgments, candidates, {
    activeIds: new Set(projected.units.map((unit) => unit.id)),
    existing: projected.relations,
  });
  const planned = planRelationships(validated.valid, candidates);
  const applied = runBatch(options, planned.map((entry) => ({ opId: entry.opId, summary: entry.summary, envelope: entry.envelope })));

  return {
    data: {
      ...applied.data,
      stage,
      received: judgments.length,
      accepted: validated.valid.length,
      rejected: validated.rejected.map((entry) => ({ reasons: entry.reasons })),
    },
    diagnostics: applied.diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

interface BatchEntry {
  opId: string;
  summary: string;
  envelope: Record<string, unknown>;
}

/**
 * Plan every operation, and apply them only with explicit authority.
 *
 * The engine's virtual overlay plans one exact atomic batch. Graph-backed
 * publication can hold that plan until the complete snapshot is revalidated,
 * then apply without re-reading graph facts or minting different entity ids.
 */
function runBatch(
  options: SynthesisOptions & { apply?: boolean },
  entries: readonly BatchEntry[],
): ServiceResult<ProposeData> {
  const planOptions = {
    scaffoldRoot: resolve(options.scaffoldRoot),
    captureCreationProvenance: true,
    parseCache: createParseCache(),
    ...(options.indexPath === undefined ? {} : { indexPath: options.indexPath }),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.graph === undefined || options.graph === null ? {} : { graph: options.graph }),
  };

  const diagnostics: WikiDiagnostic[] = [];

  // Product policy is a batch preflight: one refused generated operation must
  // prevent every sibling from being planned or written. Otherwise an agent
  // could hide one governed Spec escape beside an unrelated safe mutation and
  // still obtain a partial canonical write from the refused invocation.
  const guarded = entries.flatMap((entry) => options.operationGuard?.(entry.envelope) ?? []);
  diagnostics.push(...guarded);
  if (hasBlockingDiagnostic(guarded)) {
    return { data: emptyPropose(), diagnostics };
  }

  if (entries.length === 0) return { data: emptyPropose(), diagnostics };
  const log = readAuditLog(options.scaffoldRoot);
  diagnostics.push(...log.diagnostics);
  if (hasBlockingDiagnostic(diagnostics)) return { data: emptyPropose(), diagnostics };
  const replayIds = new Map<string, readonly string[]>();
  const pending: BatchEntry[] = [];
  for (const entry of entries) {
    const operation = validateOperation(entry.envelope, rootContext());
    if (!operation.ok) return { data: emptyPropose(), diagnostics: [...diagnostics, ...operation.diagnostics] };
    const receipt = recordFor(log, entry.opId);
    const completed = receipt.complete;
    if (!completed && receipt.intent) {
      return { data: emptyPropose(), diagnostics: [...diagnostics,
        diagnostic("CONTENT_HASH_CONFLICT", `Recovery required: synthesis operation ${entry.opId} has an incomplete durable intent. Refusing to remint its recorded identities.`, {
          remediation: "Recover the exact original reviewed operation envelope or plan with the existing Wiki operation recovery path before retrying synthesis. Preserve the recorded opId, payload, identities and audit history; do not delete the intent or renew grounding baselines to bypass recovery.",
        })] };
    }
    if (!completed) { pending.push(entry); continue; }
    if (completed.type !== operation.value.type
      || completed.payloadHash !== payloadHashOf(operation.value.type, operation.value.payload)) {
      return { data: emptyPropose(), diagnostics: [...diagnostics,
        diagnostic("INVALID_OPERATION_ENVELOPE", `Operation ${entry.opId} is recorded with a different payload.`)] };
    }
    // Completed creates retain the exact ids their immutable receipt recorded.
    replayIds.set(entry.opId, completed.createdIds);
  }
  const summaries = entries.map(entry => ({ opId: entry.opId, summary: entry.summary }));
  if (pending.length === 0) return { data: { ...emptyPropose(), operations: summaries,
    createdIds: options.apply === true ? entries.flatMap(entry => [...replayIds.get(entry.opId)!]) : [] }, diagnostics };
  const planned = planOperationBatch(pending.map(entry => entry.envelope), planOptions);
  diagnostics.push(...planned.diagnostics);
  if (!planned.ok) return { data: emptyPropose(), diagnostics };
  const result: ServiceResult<ProposeData> = {
    data: {
      ...emptyPropose(),
      operations: summaries,
      diff: planned.plan.operations.map(plan => renderPreview(previewPlan(plan))).join("\n"),
    },
    diagnostics,
  };
  const commit = (): SynthesisBatchWrite => {
    const applied = applyPlannedOperationBatch(planned.plan, { ...planOptions,
      expectedPreviewRevision: planned.plan.previewRevision });
    return {
      applied: applied.ok && !applied.replayed,
      changedFiles: [...applied.changedFiles],
      createdIds: applied.ok ? entries.flatMap(entry => [...(replayIds.get(entry.opId)
        ?? planned.plan.operations.find(plan => plan.opId === entry.opId)?.createdIds ?? [])]) : [],
      diagnostics: applied.diagnostics,
    };
  };
  if (options.apply === true) {
    if (options.deferApply) options.deferApply(commit);
    else {
      const written = commit();
      result.data.applied = written.applied;
      result.data.changedFiles = written.changedFiles;
      result.data.createdIds = written.createdIds;
      diagnostics.push(...written.diagnostics);
    }
  }
  return result;
}

interface ProjectedUnits {
  units: WikiUnit[];
  relations: Array<{ sourceId: string; targetId: string; type: string }>;
  truncated: boolean;
  diagnostics: WikiDiagnostic[];
}

/**
 * Project the applied wiki into what stages B and C consume.
 *
 * The revision and content hash come from the **file**, through P5's own
 * locator, not from the index. §51.1's guarantee is that locate's answer is the
 * same with a fresh, stale or absent index precisely because every fact it
 * returns comes from the current bytes — and a precondition taken from a stale
 * index is a precondition that says the wrong thing with total confidence.
 *
 * Truncation is reported rather than swallowed. A bounded list that reads as
 * "these are all the entities" is the trap the reference's own adapter comment
 * warns about: a value that looks like an answer and is actually an absence.
 */
function projectUnits(options: SynthesisOptions): ProjectedUnits {
  const bounds = resolveBounds({});
  const opened = withWikiQuery(indexPathFor(options), (session: WikiQuerySession) => {
    const page = session.list({ limit: bounds.limit });
    const cache = createParseCache();
    const units: WikiUnit[] = [];
    const relations: Array<{ sourceId: string; targetId: string; type: string }> = [];

    for (const summary of page.items) {
      const located = locateEntity(summary.id, {
        scaffoldRoot: resolve(options.scaffoldRoot),
        parseCache: cache,
        ...(options.indexPath === undefined ? {} : { indexPath: options.indexPath }),
        ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
        ...(options.registry === undefined ? {} : { registry: options.registry }),
      });
      if (located === null) continue;
      const entity = located.entity;
      units.push({
        id: entity.id,
        type: entity.type,
        title: entity.title,
        summary: entity.summary ?? "",
        body: entity.body,
        status: entity.status,
        file: located.path,
        groundingNodeIds: entity.groundsTo.map((grounding) => grounding.node),
        revision: entity.revision,
        contentHash: entity.location.entityContentHash,
      });
      for (const relation of entity.relations) {
        relations.push({ sourceId: entity.id, targetId: relation.target, type: relation.type });
      }
    }

    return { units, relations, truncated: page.truncated };
  });

  if (!opened.ok) return { units: [], relations: [], truncated: false, diagnostics: [opened.diagnostic] };
  return { ...opened.value, diagnostics: [] };
}

// ---------------------------------------------------------------------------
// Stage B and C prompts
// ---------------------------------------------------------------------------

const GLOBAL_PASS_SYSTEM = `
You are consolidating an existing knowledge wiki. Your job is CONSOLIDATION, not invention.
mex has deterministically grouped entities that may describe one concept; decide what to do
with each group.

HARD RULES:
1. Never invent a claim the group does not already make. You may reword and combine.
2. Preserve concrete technical meaning. Do not generalize a specific, useful statement.
3. A merged entity must be ATOMIC. If a group holds two concepts, keep_separate.
4. A merged entity must be clearer than the best fragment it replaces. If you cannot do
   better than the strongest existing one, use promote_one.
5. A merged entity's groundingNodeIds must be a non-empty subset of the union of the
   group's grounding. Never introduce a node id the group does not already carry.
6. Be conservative. Prefer keep_separate to a bad merge, and promote_one to a mediocre one.
7. Only drop_weak for entities that are clearly redundant. Never drop one carrying unique
   grounding or meaning, and never drop a whole group.
8. Output ONLY valid JSON. No prose, no fences.

ACTIONS
- "merge": one canonicalUnit replaces the group. All members are deprecated in its favour.
- "promote_one": set winnerId to the best existing entity; the rest are deprecated.
- "keep_separate": genuinely different concepts. Nothing changes.
- "drop_weak": deprecate the listed loserIds only.

Output schema:
{ "stage": "global", "actions": [ { "groupId": string, "action": "merge" | "promote_one" |
  "keep_separate" | "drop_weak", "canonicalUnit": { "type": string, "title": string,
  "summary": string, "body": string, "groundingNodeIds": string[] }, "winnerId": string,
  "loserIds": string[], "reasoning": string } ] }
`.trim();

function renderGlobalPassUser(groups: readonly CandidateGroup[]): string {
  if (groups.length === 0) return "mex found no candidate groups. Return an empty actions array.";
  const rendered = groups
    .map((group) => {
      const union = [...new Set(group.units.flatMap((unit) => unit.groundingNodeIds))];
      const members = group.units
        .map((unit) =>
          [
            `- id: ${unit.id}`,
            `  status: ${unit.status}`,
            `  title: ${unit.title}`,
            `  summary: ${unit.summary}`,
            `  groundingNodeIds: ${unit.groundingNodeIds.join(", ") || "(none)"}`,
            "  body: |",
            ...unit.body.split("\n").map((line) => `    ${line}`),
          ].join("\n"),
        )
        .join("\n");
      return [
        `groupId: ${group.groupId}`,
        `type: ${group.type}`,
        `whyGrouped: ${group.reason}`,
        `unionGroundingNodeIds: ${union.join(", ") || "(none)"}`,
        "units:",
        members,
      ].join("\n");
    })
    .join("\n\n");

  return `Evaluate each candidate group independently and return exactly one action per group.

${rendered}

---

Return only the JSON object. When unsure, keep_separate.`;
}

const RELATIONSHIP_SYSTEM = `
You are typing relationships between entities in a knowledge wiki.

mex has proposed candidate PAIRS from structural evidence only: shared grounding, or a
code-graph edge between the nodes the two entities ground to. For each candidate, choose the
MOST SPECIFIC valid type and the correct direction, or skip.

HARD RULES:
1. You may only use a type from that candidate's allowedTypes. Anything else is refused.
2. sourceId and targetId must be the candidate's two entities. Direction matters.
3. Confidence must clear the type's threshold: 0.80 for every type, 0.90 for related_to.
4. Every create needs concrete evidence and a reason, each a real sentence.
5. Prefer skipping to asserting a weak edge. A sparse graph is the goal. Do not overuse
   related_to; it is the last resort and is held to the highest bar for that reason.
6. Output ONLY valid JSON. No prose, no fences.

Output schema:
{ "stage": "relationships", "judgments": [ { "candidateId": string,
  "action": "create" | "skip", "type": string, "sourceId": string, "targetId": string,
  "confidence": number, "evidence": string, "reasoning": string } ] }
`.trim();

function renderRelationshipUser(candidates: readonly RelationshipCandidate[]): string {
  if (candidates.length === 0) return "mex found no candidate pairs. Return an empty judgments array.";
  const rendered = candidates
    .map((candidate) =>
      [
        `candidateId: ${candidate.candidateId}`,
        `source: ${candidate.source.id} (${candidate.source.type}) "${candidate.source.title}"`,
        `target: ${candidate.target.id} (${candidate.target.type}) "${candidate.target.title}"`,
        `allowedTypes: ${candidate.allowedTypes.join(", ")}`,
        `evidence: ${candidate.evidence.adjacencyReason}`,
      ].join("\n"),
    )
    .join("\n\n");

  return `Judge each candidate pair below. Return one judgment per candidate.

${rendered}

---

Return only the JSON object.`;
}
