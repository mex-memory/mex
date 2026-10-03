/**
 * §14 — one pass over one scaffold, producing one ordered, bounded report.
 *
 * ## What this re-derives, and what it does not read
 *
 * **It does not read the index at all**, and that is a deviation from the brief
 * worth stating rather than burying. The brief proposed using `wiki.db` as a
 * hint that saves a walk, falling back to discovery when it is absent. The
 * *detail* half of its reasoning is right and is why this exists: finding 26
 * says the codec deliberately collapses every model-validation failure into one
 * `WIKI_PARSE_ERROR`, so the index cannot tell a user *which field* is wrong,
 * and P9's validation pass is where that detail is supposed to come from.
 *
 * But the hint half buys almost nothing. The walk is a `readdir`; the parse is
 * the cost, and validation has to parse every file regardless because it re-runs
 * the validators over real entities. So an index-backed path would save
 * milliseconds and add a second code path that could answer differently from
 * the first — and "the answer must be identical either way" is then a property
 * somebody has to keep true rather than one that cannot be false. There is one
 * path. The test that asserts a current index, a stale index and no index give
 * the same report therefore passes by construction, which is the point: it is
 * there so that adding an index dependency later fails.
 *
 * It follows that `wiki validate` works on a fresh clone, in CI, and on every
 * scaffold in the wild today — which matters, because nothing in production has
 * ever built an index (handoff §54.8) and P9 is the phase shipping the command
 * that creates one. Walking and parsing to answer a question is not "a read
 * that rebuilds": nothing is written, and validate never creates `wiki.db`.
 *
 * ## Two deliberate asymmetries
 *
 * **A missing code graph degrades rather than fails.** P4's write path refuses
 * every grounding when the graph is absent, because minting a permanent
 * canonical reference unverified is worse than not minting it (handoff §38).
 * A read is the opposite: a CI box with no `graph.db` still gets §14.1 and
 * §14.2 in full, and its grounding checks report `unverified` — a verdict of
 * "nobody looked", not a claim that anything is wrong.
 *
 * **Nothing here fetches a URL** (§19). External evidence is reported as
 * unresolved, which is a diagnostic, not a network call. The resolver is an
 * injected predicate defaulting to "not resolved", so a caller that genuinely
 * has an issue tracker can supply one and a test can supply one that throws.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  diagnostic,
  sortDiagnostics,
  type DiagnosticSeverity,
  type WikiDiagnostic,
} from "../model/diagnostic.js";
import type { EntityId } from "../model/ids.js";
import {
  createEntityValidator,
  validateEntitySetIdentity,
  type EntityTypeRegistry,
  type WikiEntity,
} from "../model/entity.js";
import { validateRelationGraph, type RelationSubject } from "../model/relation.js";
import {
  buildTopicIndex,
  validateTopicHierarchy,
  validateTopicMembership,
  type TopicMemberSubject,
} from "../model/topic.js";
import { findDuplicateSources, reportUnresolvedSources, type WikiSource } from "../model/source.js";
import type { WikiGrounding } from "../model/grounding.js";
import type { GroundingGraph } from "../grounding/adapter.js";
import { resolveGrounding } from "../grounding/resolve.js";
import { inventoryScaffold, type InventoryFile, type ScaffoldInventory } from "../migration/inventory.js";
import { planGeneratedView } from "../migration/generated.js";
import { findAdoptionGaps } from "../migration/adoption-gaps.js";
import { createParseCache } from "../operations/locate.js";
import { readAuditLog } from "../operations/audit.js";
import { resolveBounds, type BoundsInput } from "../query/budget.js";

export interface ValidateOptions extends BoundsInput {
  /** Absolute path to the scaffold root. */
  scaffoldRoot: string;
  /**
   * Where file evidence is resolved from. Defaults to the scaffold's parent.
   *
   * A `file` source names a path in the repository, not in the scaffold, so
   * resolving it against the scaffold root would report every one of them
   * missing.
   */
  projectRoot?: string;
  exclude?: readonly string[];
  registry?: EntityTypeRegistry;
  /** Null or absent degrades every grounding check to `unverified`. */
  graph?: GroundingGraph | null;
  /**
   * Does this external reference resolve?
   *
   * **Never a fetch** (§19). Defaults to "no", which reports unresolved
   * external evidence at info severity — explicit rather than assumed fine, so
   * a reviewer does not read an unchecked URL as verified.
   */
  isExternalResolved?: (source: WikiSource) => boolean;
  /** Injectable so a test can assert what was and was not looked at on disk. */
  fileExists?: (absolutePath: string) => boolean;
}

export interface ValidationReport {
  filesScanned: number;
  entitiesChecked: number;
  /** Ordered worst-first, then by file and position. Deterministic across runs. */
  diagnostics: WikiDiagnostic[];
  counts: Record<DiagnosticSeverity, number>;
  /** True when a bound stopped the diagnostic list. Data, never a diagnostic. */
  truncated: boolean;
  /**
   * True when there were groundings and not one of them produced a verdict.
   *
   * Distinct from "every grounding is fine": the caller has to be able to tell
   * a clean bill of health from an unread one.
   *
   * **It has two causes, and this flag does not say which.** Either no code
   * graph was available, or the graph was there and nothing could be compared
   * against it — an undecodable committed fingerprint, a node the graph holds
   * no fingerprint for, a rebind onto a node it cannot produce. Pair it with
   * {@link codeGraphAvailable} to tell them apart before telling a user where
   * to look.
   */
  groundingsUnverified: boolean;
  /**
   * Whether a code graph was supplied for this pass.
   *
   * The discriminator for {@link groundingsUnverified}, and it has to be
   * carried rather than inferred: the grounding diagnostics that would hint at
   * it are subject to the same bound as every other diagnostic, so a truncated
   * report could lose the evidence and leave a reader guessing.
   */
  codeGraphAvailable: boolean;
}

/** Commit shape: a hex object name, abbreviated or full. */
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

/** Source kinds whose `ref` is a path this repository should still contain. */
const FILE_BEARING_SOURCES = new Set(["file", "test"]);

export function validateScaffold(options: ValidateOptions): ValidationReport {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const projectRoot = resolve(options.projectRoot ?? dirname(scaffoldRoot));
  const exists = options.fileExists ?? ((absolutePath: string) => existsSync(absolutePath));
  const graph = options.graph ?? null;

  const inventory = inventoryScaffold({
    scaffoldRoot,
    parseCache: createParseCache(),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });

  const collected: WikiDiagnostic[] = [...inventory.diagnostics];
  const entities: Array<{ entity: WikiEntity; file: string }> = [];
  for (const file of inventory.files) {
    collected.push(...file.parsed.diagnostics);
    for (const entry of file.parsed.entities) entities.push({ entity: entry.entity, file: file.path });

    // The blocks the model refused. The codec reported one collapsed
    // `WIKI_PARSE_ERROR` for each and produced no entity — correctly, since a
    // scaffold must not index an entity whose type or lifecycle is nonsense —
    // so this is the only place the per-field reasons are reachable, and
    // finding 26 names this layer as where a user is owed them.
    for (const rejection of file.parsed.rejected) {
      collected.push(
        ...rejection.diagnostics.map((entry) => ({
          ...entry,
          file: entry.file ?? file.path,
          ...(rejection.entityId === undefined || entry.entityId !== undefined
            ? {}
            : { entityId: rejection.entityId }),
          location: entry.location ?? { file: file.path, startOffset: rejection.range.start, endOffset: rejection.range.end },
        })),
      );
    }
  }

  collected.push(...structuralChecks(entities, options.registry));
  collected.push(...referentialChecks(entities));
  collected.push(...sourceChecks(entities, projectRoot, exists, options.isExternalResolved));

  const groundingResults = groundingChecks(entities, graph);
  collected.push(...groundingResults.diagnostics);
  collected.push(...anchorChecks(inventory));
  collected.push(...generatedViewChecks(inventory));
  collected.push(...adoptionChecks(inventory));
  collected.push(...operationLogChecks(scaffoldRoot));

  const bounds = resolveBounds(options);
  const ordered = sortDiagnostics(dedupe(collected));
  const kept = ordered.slice(0, bounds.limit);

  const counts: Record<DiagnosticSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const entry of kept) counts[entry.severity] += 1;

  return {
    filesScanned: inventory.files.length,
    entitiesChecked: entities.length,
    diagnostics: kept,
    counts,
    truncated: ordered.length > kept.length,
    groundingsUnverified: groundingResults.unverified,
    codeGraphAvailable: graph !== null,
  };
}

/**
 * Two diagnostics are the same finding when every reported field matches.
 *
 * Needed because several checks legitimately look at the same fact from
 * different directions — a dangling relation target is visible from the
 * relation graph and from the entity that declares it — and a report that says
 * the same thing twice trains a reader to skim.
 */
function dedupe(diagnostics: readonly WikiDiagnostic[]): WikiDiagnostic[] {
  const seen = new Set<string>();
  const kept: WikiDiagnostic[] = [];
  for (const entry of diagnostics) {
    const key = [
      entry.code,
      entry.severity,
      entry.message,
      entry.file ?? "",
      entry.entityId ?? "",
      entry.path ?? "",
      String(entry.location?.startOffset ?? ""),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
  }
  return kept;
}

/** Attach the file an entity lives in, which the pure model validators cannot know. */
function inFile(entries: readonly WikiDiagnostic[], file: string, entityId?: string): WikiDiagnostic[] {
  return entries.map((entry) => ({
    ...entry,
    file: entry.file ?? file,
    ...(entityId === undefined || entry.entityId !== undefined ? {} : { entityId }),
  }));
}

/**
 * §14.1 — structure, re-derived rather than read back.
 *
 * The per-entity validator runs again here on purpose. The codec collapsed its
 * output into one `WIKI_PARSE_ERROR` to keep its own diagnostic surface
 * independent of the model's internals (finding 26); this is the layer that is
 * allowed to depend on them, so a user finds out that it was the lifecycle
 * state and not the revision.
 */
function structuralChecks(
  entities: readonly { entity: WikiEntity; file: string }[],
  registry: EntityTypeRegistry | undefined,
): WikiDiagnostic[] {
  const validate = createEntityValidator({
    requireLocation: true,
    ...(registry === undefined ? {} : { registry }),
  });

  const diagnostics: WikiDiagnostic[] = [];
  for (const { entity, file } of entities) {
    const result = validate(entity, { path: "", entityId: entity.id });
    diagnostics.push(...inFile(result.diagnostics, file, entity.id));
  }

  // Both claimants, by design: reporting a duplicate id usefully means naming
  // the two files, and this is the one place that must see the row every other
  // query filters out as `shadowed`.
  diagnostics.push(
    ...validateEntitySetIdentity(entities.map(({ entity }) => ({ id: entity.id, location: entity.location }))),
  );

  diagnostics.push(...overlapChecks(entities));
  return diagnostics;
}

/** Two entities claiming overlapping regions of one file. */
function overlapChecks(entities: readonly { entity: WikiEntity; file: string }[]): WikiDiagnostic[] {
  const byFile = new Map<string, WikiEntity[]>();
  for (const { entity, file } of entities) {
    const list = byFile.get(file) ?? [];
    list.push(entity);
    byFile.set(file, list);
  }

  const diagnostics: WikiDiagnostic[] = [];
  for (const [file, list] of byFile) {
    const sorted = [...list].sort((left, right) => left.location.metadataStart - right.location.metadataStart);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1]!;
      const current = sorted[index]!;
      if (current.location.metadataStart < previous.location.bodyEnd && current.location.bodyEnd > previous.location.metadataStart) {
        if (current.location.metadataStart >= previous.location.bodyEnd) continue;
        diagnostics.push(
          diagnostic(
            "ENTITY_RANGE_OVERLAP",
            `Entities ${previous.id} and ${current.id} claim overlapping regions of ${file}.`,
            { file, entityId: current.id, location: { file, startOffset: current.location.metadataStart } },
          ),
        );
      }
    }
  }
  return diagnostics;
}

/** §14.2 — relations, topics, orphans, contradictions. */
function referentialChecks(entities: readonly { entity: WikiEntity; file: string }[]): WikiDiagnostic[] {
  const fileOf = new Map<EntityId, string>();
  for (const { entity, file } of entities) fileOf.set(entity.id, file);

  const subjects: RelationSubject[] = entities.map(({ entity }) => ({
    id: entity.id,
    type: entity.type,
    status: entity.status,
    relations: entity.relations,
  }));

  const diagnostics: WikiDiagnostic[] = [];
  for (const entry of validateRelationGraph(subjects)) {
    const file = entry.entityId === undefined ? undefined : fileOf.get(entry.entityId as EntityId);
    diagnostics.push(file === undefined ? entry : { ...entry, file: entry.file ?? file });
  }

  const index = buildTopicIndex(entities.map(({ entity }) => entity));
  diagnostics.push(...validateTopicHierarchy(index));

  const members: TopicMemberSubject[] = entities.map(({ entity }) => ({ id: entity.id, topics: entity.topics }));
  const byId = new Map<EntityId, { type: string }>(entities.map(({ entity }) => [entity.id, { type: entity.type }]));
  for (const entry of validateTopicMembership(members, byId)) {
    const file = entry.entityId === undefined ? undefined : fileOf.get(entry.entityId as EntityId);
    diagnostics.push(file === undefined ? entry : { ...entry, file: entry.file ?? file });
  }

  diagnostics.push(...orphanChecks(entities));
  return diagnostics;
}

/**
 * A promoted entity nothing points at and that points at nothing.
 *
 * Info severity, from the registry: an orphan is hard to find, not wrong. Both
 * directions are required before reporting, because an entity that relates
 * outward is reachable by anyone reading its neighbour.
 */
function orphanChecks(entities: readonly { entity: WikiEntity; file: string }[]): WikiDiagnostic[] {
  const targeted = new Set<string>();
  for (const { entity } of entities) {
    for (const relation of entity.relations) targeted.add(String(relation.target));
    for (const topic of entity.topics) targeted.add(String(topic));
  }

  const diagnostics: WikiDiagnostic[] = [];
  for (const { entity, file } of entities) {
    if (entity.status !== "promoted") continue;
    if (entity.type === "topic") continue;
    if (entity.relations.length > 0 || entity.topics.length > 0) continue;
    if (targeted.has(String(entity.id))) continue;
    diagnostics.push(
      diagnostic("ORPHANED_ENTITY", `${entity.title} (${entity.id}) is promoted but relates to nothing and nothing relates to it.`, {
        file,
        entityId: entity.id,
      }),
    );
  }
  return diagnostics;
}

/** §14.3, source half — malformed refs, missing files, bad commits, unresolved evidence. */
function sourceChecks(
  entities: readonly { entity: WikiEntity; file: string }[],
  projectRoot: string,
  exists: (absolutePath: string) => boolean,
  isExternalResolved: ((source: WikiSource) => boolean) | undefined,
): WikiDiagnostic[] {
  const diagnostics: WikiDiagnostic[] = [];
  for (const { entity, file } of entities) {
    diagnostics.push(...inFile(findDuplicateSources(entity.sources), file, entity.id));
    diagnostics.push(
      ...inFile(
        reportUnresolvedSources(entity.sources, isExternalResolved ?? (() => false)),
        file,
        entity.id,
      ),
    );

    for (let index = 0; index < entity.sources.length; index += 1) {
      const source = entity.sources[index]!;
      const path = `sources[${index}]`;

      if (source.commit !== undefined && !COMMIT_PATTERN.test(source.commit)) {
        diagnostics.push(
          diagnostic("INVALID_COMMIT_FORMAT", `"${source.commit}" is not a commit object name.`, {
            file,
            entityId: entity.id,
            path,
          }),
        );
      }

      if (!FILE_BEARING_SOURCES.has(source.type) || source.ref === undefined) continue;
      // Resolved against the project root, never fetched, and never followed
      // outside it: a `..` ref is a missing file rather than a licence to stat
      // an arbitrary path.
      const absolute = resolve(projectRoot, source.ref);
      if (!absolute.startsWith(projectRoot)) {
        diagnostics.push(
          diagnostic("MALFORMED_SOURCE", `Source ref "${source.ref}" resolves outside the project.`, {
            file,
            entityId: entity.id,
            path,
          }),
        );
        continue;
      }
      if (!exists(absolute)) {
        diagnostics.push(
          diagnostic("SOURCE_FILE_MISSING", `${source.ref}, cited as ${source.type} evidence, is not in this checkout.`, {
            file,
            entityId: entity.id,
            path,
          }),
        );
      }
    }
  }
  return diagnostics;
}

/** §14.3, grounding half — resolution against the live graph, and the blind ones. */
function groundingChecks(
  entities: readonly { entity: WikiEntity; file: string }[],
  graph: GroundingGraph | null,
): { diagnostics: WikiDiagnostic[]; unverified: boolean } {
  const diagnostics: WikiDiagnostic[] = [];
  let sawGrounding = false;
  let sawVerdict = false;

  for (const { entity, file } of entities) {
    for (let index = 0; index < entity.groundsTo.length; index += 1) {
      const grounding: WikiGrounding = entity.groundsTo[index]!;
      const path = `groundsTo[${index}]`;
      sawGrounding = true;

      // Finding 39: a grounding with no committed body hash falls back to the
      // structural comparator, which is blind to a changed constant or a
      // renamed local — so it reports `fresh` straight through a literal edit.
      // Everything mex writes carries one; a hand-authored or pre-P4 grounding
      // does not, and until now nothing anywhere said so.
      if (grounding.bodyHash === undefined) {
        diagnostics.push(
          diagnostic(
            "MALFORMED_GROUNDING",
            `The grounding on ${entity.id} for ${grounding.node} carries no body hash, so drift in the grounded code cannot be detected — only a change to its structure.`,
            {
              file,
              entityId: entity.id,
              path,
              severity: "warning",
              // `MALFORMED_GROUNDING` covers six different problems and its
              // registry remediation is written for the first two — a missing
              // node id or fingerprint. This case has both, and telling a
              // reader to supply them sends them looking for a field that is
              // already in the file. Say what is actually absent and what
              // writes it. Reported on a real scaffold where all sixteen
              // warnings carried advice that did not apply to any of them.
              remediation:
                "The node id and fingerprint are present; only the baseline body hash is missing, and nothing you can hand-write supplies it. A grounding capture records it from the graph — `mex graph ground` on an existing scaffold, or `mex sync`. Until then drift is compared structurally.",
            },
          ),
        );
      }

      const resolution = resolveGrounding(grounding, graph);
      if (resolution.health !== "unverified") sawVerdict = true;

      if (resolution.state === "missing") {
        diagnostics.push(
          diagnostic("GROUNDING_MISSING", `${grounding.node} no longer exists in the code graph. ${resolution.reason}`, {
            file,
            entityId: entity.id,
            path,
          }),
        );
        continue;
      }
      if (resolution.state === "unresolved" && graph !== null) {
        diagnostics.push(
          diagnostic("GROUNDING_UNRESOLVED", `${grounding.node} could not be resolved. ${resolution.reason}`, {
            file,
            entityId: entity.id,
            path,
          }),
        );
        continue;
      }
      if (resolution.health === "changed") {
        diagnostics.push(
          diagnostic("GROUNDING_STALE", `The code under ${grounding.node} changed since ${entity.id} was grounded to it.`, {
            file,
            entityId: entity.id,
            path,
          }),
        );
      }
    }
  }

  return { diagnostics, unverified: sawGrounding && !sawVerdict };
}

/**
 * §14.3, last clause — an inline anchor disagreeing with the entity's grounding
 * *where they are declared equivalent*.
 *
 * What declares the equivalence is the entity itself: an entity that grounds to
 * code is claiming "this knowledge is about those nodes", and an anchor inside
 * its body is claiming the same of a node of its own. An entity with **no**
 * grounding declares no equivalence at all, so an anchor in it is a plain link
 * and is left alone — which is the conservative reading, and the one that keeps
 * a scaffold full of `mex://` links from lighting up before it is grounded.
 */
function anchorChecks(inventory: ScaffoldInventory): WikiDiagnostic[] {
  const diagnostics: WikiDiagnostic[] = [];
  for (const file of inventory.files) {
    const grounded = new Map<string, Set<string>>();
    for (const entry of file.parsed.entities) {
      if (entry.entity.groundsTo.length === 0) continue;
      grounded.set(String(entry.entity.id), new Set(entry.entity.groundsTo.map((entry_) => entry_.node)));
    }

    for (const anchor of file.parsed.anchors) {
      if (anchor.entityId === null) continue;
      const nodes = grounded.get(String(anchor.entityId));
      if (nodes === undefined || nodes.has(anchor.nodeId)) continue;
      diagnostics.push(
        diagnostic(
          "ANCHOR_GROUNDING_MISMATCH",
          `An inline anchor in ${anchor.entityId} points at ${anchor.nodeId}, which is not among the nodes that entity grounds to.`,
          {
            file: file.path,
            entityId: String(anchor.entityId),
            location: { file: file.path, startOffset: anchor.range.start, endOffset: anchor.range.end },
          },
        ),
      );
    }
  }
  return diagnostics;
}

/** §14.1's last clause — a generated section that no longer matches the scaffold. */
function generatedViewChecks(inventory: ScaffoldInventory): WikiDiagnostic[] {
  const diagnostics: WikiDiagnostic[] = [];
  for (const file of inventory.files) {
    const type = generatedViewTypeFor(file);
    if (type === null) continue;
    const plan = planGeneratedView(file, inventory, type);
    if (plan !== null) diagnostics.push(...plan.diagnostics);
  }
  return diagnostics;
}

/**
 * Which entity type a file's generated section lists.
 *
 * Read off the path, the way P6's classifier reads every other convention. A
 * file with a generated region and no rule is not an error — the section may be
 * generated by something else entirely — so it is simply not checked.
 */
function generatedViewTypeFor(file: InventoryFile): "pattern" | "decision" | null {
  if (/(^|\/)patterns\/(INDEX|README)\.md$/.test(file.path)) return "pattern";
  if (/(^|\/)decisions?\.md$/.test(file.path)) return "decision";
  return null;
}

/**
 * Knowledge files outside the Wiki (#227): files migration would adopt, and
 * context files nothing types. Read off migration's own classifier, so this
 * reports exactly what `mex wiki migrate` would do or decline to do.
 */
function adoptionChecks(inventory: ScaffoldInventory): WikiDiagnostic[] {
  return findAdoptionGaps(inventory).map((gap) =>
    diagnostic(gap.kind === "not-adopted" ? "KNOWLEDGE_NOT_ADOPTED" : "KNOWLEDGE_UNTYPED", gap.message, { file: gap.file }),
  );
}

/** §14.1 — malformed operation-log entries. The Markdown is unaffected by these. */
function operationLogChecks(scaffoldRoot: string): WikiDiagnostic[] {
  // `readAuditLog` already reports a line it could not parse, as
  // `MALFORMED_OPERATION_LOG`. Re-deriving that here would be a second reader
  // of one format, which is how the two come to disagree about what a valid
  // line is (finding 43 is about exactly that kind of divergence).
  return readAuditLog(scaffoldRoot).diagnostics;
}
