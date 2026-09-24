/**
 * Sections 13.1, 13.3 and 13.6 — the run, and what it reports.
 *
 * ## Migration owns no bytes
 *
 * Every mutation here goes through P5's `applyOperation`. That is D9, and it is
 * not bookkeeping: going through the pipeline is what buys `verifyPlan`'s
 * "no entity this operation did not name changed", write-scope enforcement over
 * raw bytes, `wiki.readOnly`, path containment and the audit log. A phase that
 * wrote bytes another way would lose all five silently.
 *
 * ## Two passes, because an id's blast radius is its references
 *
 * Adoption mints ids. Legacy `edges` become relations *between* entities, and
 * an edge in one file names another file whose id this same run mints. So every
 * id has to exist before any edge is resolved. That is a second pass over a
 * fresh inventory, not a second loop over the first one — finding 29.
 *
 * ## Order within a file is a correctness property
 *
 * See `orderForAdoption`. Bottom-up, file-level entity last, because inserting
 * a metadata block above a heading shortens the body of whatever entity
 * currently contains it, and P5 refuses a plan that changes an entity it was
 * not told about.
 */
import { diagnostic, hasBlockingDiagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ENTITY_ID_LENGTH, ENTITY_ID_PREFIX, isEntityId, type EntityId } from "../model/ids.js";
import type { WikiGrounding } from "../model/grounding.js";
import type { AbsorbableRootKey, WikiActor, WikiOperation } from "../model/operation.js";
import type { WikiEntityType } from "../model/entity.js";
import type { EntityTypeRegistry } from "../model/entity.js";
import type { GroundingGraph } from "../grounding/adapter.js";
import { applyOperation, applyPlannedOperationSequence, type ApplyOptions } from "../operations/apply.js";
import { planOperation, type WikiPatchPlan } from "../operations/plan.js";
import { createParseCache } from "../operations/locate.js";
import { previewHashOf, previewPlan, renderPreview } from "../operations/preview.js";
import {
  auditRecord,
  operationLogPath,
  readAuditLog,
  readOperationLogExact,
  recordFor,
} from "../operations/audit.js";
import { exactFileContentHash } from "../model/hash.js";
import { defaultIndexPath } from "../index/rebuild.js";
import { acquireWikiMaintenanceLease, type WikiMaintenanceLease } from "../index/dbfile.js";
import { readContainedSource } from "../index/source-read.js";
import { inventoryScaffold, type InventoryFile, type ScaffoldInventory } from "./inventory.js";
import { classifyFile, orderForAdoption, type Abstention, type Candidate, type FileClassification } from "./classify.js";
import { opIdForCandidate, opIdForEdge, opIdForRootGroundings } from "./ids.js";
import { planGroundingMoves, planLegacyEdges, type FileOutcome } from "./legacy.js";

export interface MigrateOptions {
  scaffoldRoot: string;
  /** Optional exact scaffold-relative POSIX Markdown subset. */
  paths?: readonly string[];
  /** Reviewed legacy topic label → canonical topic entity mapping. */
  topicMappings?: Readonly<Record<string, EntityId>>;
  /** `wiki.exclude` globs, passed to discovery. */
  exclude?: readonly string[];
  /** `wiki.readOnly` globs. A matching path is refused at plan time. */
  readOnly?: readonly string[];
  registry?: EntityTypeRegistry;
  /** The code graph, for backfilling a moved grounding's `bodyHash`. */
  graph?: GroundingGraph | null;
  /** Where `wiki.db` lives, when there is one. Absent is normal. */
  indexPath?: string;
  actor?: WikiActor;
  now?: () => string;
  /** The crash seam, forwarded to apply so a test can stage one. */
  onFileWritten?: (path: string) => void;
  /** Deterministic ordinary-failure seams for exact rollback coverage. */
  beforeFileRename?: (path: string) => void;
  beforeAuditAppend?: (phase: "intent" | "complete", opId: string) => void;
  afterAuditWrite?: (phase: "intent" | "complete", opId: string) => void;
  /** Existing engine-owned writer lease. Package-private callers only. */
  maintenanceLease?: WikiMaintenanceLease;
}

export class MigrationSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationSelectionError";
  }
}

function migrationSelection(options: MigrateOptions): {
  paths: string[] | null;
  topicMappings: Record<string, EntityId>;
} {
  const paths = options.paths === undefined || options.paths.length === 0
    ? null
    : [...new Set(options.paths)].sort();
  if (paths !== null) for (const path of paths) {
    if (
      path.length === 0
      || path.includes("\0")
      || path.includes("\\")
      || path.startsWith("/")
      || path.split("/").some((part) => part === "" || part === "." || part === "..")
      || !/\.mdx?$/i.test(path)
    ) throw new MigrationSelectionError("Migration paths must be normalized scaffold-relative Markdown paths.");
  }
  const topicMappings: Record<string, EntityId> = {};
  for (const [topic, id] of Object.entries(options.topicMappings ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    if (topic.trim() === "" || topic.length > 256 || !isEntityId(id)) {
      throw new MigrationSelectionError("Migration topic mappings require a non-empty bounded label and a valid entity id.");
    }
    topicMappings[topic] = id;
  }
  return { paths, topicMappings };
}

function selectMigrationInventory(
  inventory: ScaffoldInventory,
  selection: ReturnType<typeof migrationSelection>,
): ScaffoldInventory {
  if (selection.paths === null) return inventory;
  const selected = new Set(selection.paths);
  const present = new Set(inventory.files.map((file) => file.path));
  const missing = selection.paths.filter((path) => !present.has(path));
  if (missing.length > 0) throw new MigrationSelectionError(`Migration paths were not found: ${missing.join(", ")}.`);
  return {
    root: inventory.root,
    files: inventory.files.filter((file) => selected.has(file.path)),
    diagnostics: inventory.diagnostics.filter((entry) => entry.file === undefined || selected.has(entry.file)),
  };
}

function validateTopicMappingTargets(
  inventory: ScaffoldInventory,
  selection: ReturnType<typeof migrationSelection>,
): void {
  const entities = inventory.files.flatMap((file) => file.parsed.entities.map((entry) => entry.entity));
  for (const id of Object.values(selection.topicMappings)) {
    const target = entities.find((entity) => entity.id === id);
    if (target === undefined || target.type !== "topic") {
      throw new MigrationSelectionError(`Migration topic mapping target ${id} is not a canonical topic entity.`);
    }
  }
}

interface LegacyTopicProjection {
  topics: EntityId[];
  absorb: boolean;
  diagnostics: WikiDiagnostic[];
}

/**
 * Resolve legacy root topic labels only through the caller's explicit map.
 * Partial resolution is deliberately all-or-nothing: otherwise the root key
 * and `mex.topics` would become two competing stores for one membership list.
 */
function projectLegacyTopics(
  file: InventoryFile,
  classification: FileClassification,
  selection: ReturnType<typeof migrationSelection>,
): LegacyTopicProjection {
  const labels = [...new Set(file.parsed.legacy.topics)];
  if (labels.length === 0) return { topics: [], absorb: false, diagnostics: [] };
  if (!classification.candidates.some((candidate) => candidate.target.at === "file")) {
    return {
      topics: [],
      absorb: false,
      diagnostics: [diagnostic(
        "AMBIGUOUS_MIGRATION",
        `${file.path} carries legacy topic labels but has no file-level entity to own them; they were preserved.`,
        { file: file.path },
      )],
    };
  }
  const missing = labels.filter((label) => selection.topicMappings[label] === undefined);
  if (missing.length > 0) {
    return {
      topics: [],
      absorb: false,
      diagnostics: [diagnostic(
        "AMBIGUOUS_MIGRATION",
        `${file.path} carries unmapped legacy topic label(s): ${missing.join(", ")}. They were preserved.`,
        { file: file.path },
      )],
    };
  }
  return {
    topics: [...new Set(labels.map((label) => selection.topicMappings[label]!))],
    absorb: true,
    diagnostics: [],
  };
}

function absorbedRootKeys(hasGroundings: boolean, hasMappedTopics: boolean): AbsorbableRootKey[] {
  const keys: AbsorbableRootKey[] = [];
  if (hasGroundings) keys.push("grounds_to");
  if (hasMappedTopics) keys.push("topics");
  return keys;
}

/** One planned entity, as the dry-run report names it. */
export interface PlannedEntity {
  file: string;
  type: WikiEntityType;
  title: string;
  /** Where its metadata will go, in words. Never an id: a dry run mints none. */
  location: string;
  rule: string;
}

/** Section 13.6. */
export interface MigrationReport {
  dryRun: boolean;
  filesScanned: number;
  filesUnchanged: string[];
  filesSkipped: { file: string; reason: string }[];
  /** Proposed on a dry run; created on an apply. */
  entitiesByType: Record<string, number>;
  planned: PlannedEntity[];
  idsGenerated: EntityId[];
  idsPreserved: EntityId[];
  edgesConverted: number;
  edgesAmbiguous: number;
  groundingsPreserved: number;
  groundingsMoved: number;
  groundingsAmbiguous: number;
  abstentions: Abstention[];
  /** Unified diffs, one per changed file, from P5's own preview renderer. */
  diffs: string[];
  diagnostics: WikiDiagnostic[];
}

const MIGRATION_ACTOR: WikiActor = { kind: "system", id: "mex-migration" };

function locationOf(candidate: Candidate): string {
  return candidate.target.at === "file"
    ? "the file's frontmatter `mex:` key"
    : `the heading "${candidate.target.text}" (depth ${candidate.target.depth})`;
}

function emptyReport(dryRun: boolean, inventory: ScaffoldInventory): MigrationReport {
  return {
    dryRun,
    filesScanned: inventory.files.length,
    filesUnchanged: [],
    filesSkipped: [],
    entitiesByType: {},
    planned: [],
    idsGenerated: [],
    idsPreserved: [],
    edgesConverted: 0,
    edgesAmbiguous: 0,
    groundingsPreserved: 0,
    groundingsMoved: 0,
    groundingsAmbiguous: 0,
    abstentions: [],
    diffs: [],
    diagnostics: [...inventory.diagnostics],
  };
}

function classifyAll(inventory: ScaffoldInventory): Map<string, FileClassification> {
  const classifications = new Map<string, FileClassification>();
  for (const file of inventory.files) classifications.set(file.path, classifyFile(file));
  return classifications;
}

function countType(report: MigrationReport, type: WikiEntityType): void {
  report.entitiesByType[type] = (report.entitiesByType[type] ?? 0) + 1;
}

/**
 * Section 13.3 — a dry run reports planned locations and counts, and mints nothing.
 *
 * Not "writes nothing important": nothing at all, the operation log included.
 * A dry run that minted ids would make the ids a function of how many times
 * somebody looked, and one that journalled would make the *next* apply believe
 * it had already run.
 */
export function planMigration(options: MigrateOptions): MigrationReport {
  const selection = migrationSelection(options);
  const parseCache = createParseCache();
  const observed = inventoryScaffold({
    parseCache,
    scaffoldRoot: options.scaffoldRoot,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });
  validateTopicMappingTargets(observed, selection);
  const inventory = selectMigrationInventory(observed, selection);
  return migrationReportFromInventory(options, inventory, selection);
}

/** Derive every public preview fact from the same exact corpus observation. */
function migrationReportFromInventory(
  options: MigrateOptions,
  inventory: ScaffoldInventory,
  selection: ReturnType<typeof migrationSelection>,
): MigrationReport {
  const report = emptyReport(true, inventory);
  const classifications = classifyAll(inventory);

  for (const file of inventory.files) {
    const classification = classifications.get(file.path)!;
    report.diagnostics.push(...projectLegacyTopics(file, classification, selection).diagnostics);
    if (classification.skipped) {
      report.filesSkipped.push({ file: file.path, reason: classification.skipReason ?? "skipped" });
      for (const entry of file.parsed.entities) report.idsPreserved.push(entry.entity.id);
      continue;
    }
    report.abstentions.push(...classification.abstentions);
    for (const candidate of orderForAdoption(classification.candidates)) {
      report.planned.push({
        file: candidate.file,
        type: candidate.type,
        title: candidate.title,
        location: locationOf(candidate),
        rule: candidate.rule,
      });
      countType(report, candidate.type);
    }
    if (classification.candidates.length === 0) report.filesUnchanged.push(file.path);
    report.groundingsPreserved += file.parsed.legacy.groundsTo.length;
  }

  // Resolution is reported on a dry run too, so a reviewer sees what will be
  // ambiguous *before* anything is written. It needs the outcomes the apply
  // would produce, which are known without minting: which files get a
  // file-level entity, and how many entities each will hold.
  const outcomes = projectedOutcomes(inventory, classifications, null);
  const edges = planLegacyEdges(inventory, outcomes);
  report.edgesConverted = edges.converted.length;
  report.edgesAmbiguous = edges.diagnostics.length;
  report.diagnostics.push(...edges.diagnostics);

  const groundings = planGroundingMoves(
    inventory,
    classifications,
    (path) => classifications.get(path)?.candidates ?? [],
    options.graph ?? null,
  );
  report.groundingsMoved = [...groundings.moved.values()].reduce((sum, list) => sum + list.length, 0)
    + [...groundings.absorbed.values()].reduce((sum, entry) => sum + entry.count, 0);
  report.groundingsAmbiguous = groundings.diagnostics.length;
  report.diagnostics.push(...groundings.diagnostics);

  return report;
}

/** Crockford Base32, so a stand-in has the shape of the id it stands in for. */
const PLACEHOLDER_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A distinct stand-in for the nth entity this run would mint.
 *
 * **Distinct is the whole point.** One shared placeholder made every projected
 * entity equal to every other, and `planLegacyEdges` returns early on an edge
 * whose target resolves to its own source — a real guard, for a file that edges
 * to itself. With a single placeholder that guard fired on *every* edge between
 * two files that both gain an entity, so the dry run dropped them silently:
 * neither converted nor reported. The apply path never showed it, because real
 * ULIDs differ, and no test compared the two counts.
 *
 * Counting from zero keeps the first stand-in byte-identical to the single
 * placeholder this replaced, and the counter runs over the inventory, whose
 * order is already deterministic — so two dry runs of one tree still agree.
 */
function placeholderId(ordinal: number): EntityId {
  let body = "";
  let value = ordinal;
  do {
    body = PLACEHOLDER_ALPHABET[value % 32] + body;
    value = Math.floor(value / 32);
  } while (value > 0);
  return `${ENTITY_ID_PREFIX}${body.padStart(ENTITY_ID_LENGTH - ENTITY_ID_PREFIX.length, "0")}` as EntityId;
}

/**
 * The outcomes an apply will produce, without minting anything.
 *
 * A placeholder id stands in for an entity that does not exist yet, so the
 * dry-run report can say which edges resolve. `mint` supplies real ids on the
 * apply path, and the shape of the answer is identical either way — which is
 * what keeps the dry run's ambiguity report honest about the apply's.
 *
 * The stand-ins never leave this function's answer: section 13.3 says a dry run
 * promises no ids, and the report is asserted to carry none.
 */
function projectedOutcomes(
  inventory: ScaffoldInventory,
  classifications: Map<string, FileClassification>,
  minted: Map<string, EntityId[]> | null,
): Map<string, FileOutcome> {
  const outcomes = new Map<string, FileOutcome>();
  let projected = 0;

  for (const file of inventory.files) {
    const classification = classifications.get(file.path)!;
    const existing = file.parsed.entities.map((entry) => entry.entity.id);
    const ids = minted?.get(file.path) ?? [];
    const candidates = classification.skipped ? [] : orderForAdoption(classification.candidates);

    let fileEntity: EntityId | null =
      file.parsed.entities.find((entry) => entry.metadataKind === "frontmatter")?.entity.id ?? null;
    const entities = [...existing];

    candidates.forEach((candidate, index) => {
      // Advanced for every candidate, minted or not, so a stand-in's ordinal is
      // a function of position in the plan rather than of which branch ran.
      const ordinal = projected;
      projected += 1;
      const id = ids[index] ?? placeholderId(ordinal);
      entities.push(id);
      if (candidate.target.at === "file") fileEntity = id;
    });

    outcomes.set(file.path, { path: file.path, fileEntity, entities });
  }
  return outcomes;
}

function envelope(
  opId: string,
  type: WikiOperation["type"],
  payload: unknown,
  options: MigrateOptions,
  entityId?: EntityId,
): unknown {
  return {
    opId,
    type,
    ...(entityId === undefined ? {} : { entityId }),
    actor: options.actor ?? MIGRATION_ACTOR,
    // Fixed rather than `now()`: the envelope's timestamp is not in the payload
    // hash, but a caller reading two runs' logs should see the run's own time,
    // and a test needs it pinned. `now` supplies it when given.
    timestamp: options.now?.() ?? "2026-01-01T00:00:00.000Z",
    payload,
  };
}

/** A `set-grounding` that only moves a file's root `grounds_to` into its file-level entity. */
function absorbEnvelope(
  path: string,
  absorb: { entityId: EntityId; groundsTo: WikiGrounding[] },
  options: MigrateOptions,
): unknown {
  return envelope(
    opIdForRootGroundings(path, absorb.groundsTo),
    "set-grounding",
    { groundsTo: absorb.groundsTo, absorbRootGroundings: true },
    options,
    absorb.entityId,
  );
}

/**
 * Section 13 — run the migration.
 *
 * Restartable and idempotent: every `opId` is derived from the work it
 * describes, so a second run finds a completion line for each and does nothing.
 * A run interrupted between the write and the completion line resumes through
 * P5's own intent-line machinery, reusing the id it had already minted rather
 * than minting a second entity for the same prose.
 */
export function migrateScaffold(options: MigrateOptions): MigrationReport {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const indexPath = options.indexPath ?? defaultIndexPath(scaffoldRoot);
  const ownedLease = options.maintenanceLease === undefined;
  const lease = options.maintenanceLease ?? acquireWikiMaintenanceLease(indexPath, "migration", scaffoldRoot);
  try {
    return migrateScaffoldHeld({ ...options, scaffoldRoot, maintenanceLease: lease });
  } finally {
    if (ownedLease) lease.release();
  }
}

function migrateScaffoldHeld(options: MigrateOptions & { maintenanceLease: WikiMaintenanceLease }): MigrationReport {
  const selection = migrationSelection(options);
  // One cache for the whole run, created here rather than inside `applyOptions`
  // so every operation shares it. It caches parses keyed on the file's own
  // bytes, so a file this run has just written re-parses on the next operation
  // that reads it — see `ParseCache` in `operations/locate.ts`.
  const parseCache = createParseCache();
  const applyOptions = (): ApplyOptions => ({
    scaffoldRoot: options.scaffoldRoot,
    unconditional: true,
    parseCache,
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.graph === undefined || options.graph === null ? {} : { graph: options.graph }),
    ...(options.indexPath === undefined ? {} : { indexPath: options.indexPath }),
    ...(options.onFileWritten === undefined ? {} : { onFileWritten: options.onFileWritten }),
    ...(options.beforeFileRename === undefined ? {} : { beforeFileRename: options.beforeFileRename }),
    ...(options.beforeAuditAppend === undefined ? {} : { beforeAuditAppend: options.beforeAuditAppend }),
    ...(options.afterAuditWrite === undefined ? {} : { afterAuditWrite: options.afterAuditWrite }),
    maintenanceLease: options.maintenanceLease,
  });

  const observed = inventoryScaffold({
    scaffoldRoot: options.scaffoldRoot,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });
  validateTopicMappingTargets(observed, selection);
  const inventory = selectMigrationInventory(observed, selection);
  const report = emptyReport(false, inventory);
  const classifications = classifyAll(inventory);

  const groundingPlan = planGroundingMoves(
    inventory,
    classifications,
    (path) => classifications.get(path)?.candidates ?? [],
    options.graph ?? null,
  );
  report.groundingsAmbiguous = groundingPlan.diagnostics.length;
  report.diagnostics.push(...groundingPlan.diagnostics);

  const minted = new Map<string, EntityId[]>();
  const changed = new Set<string>();

  // -- pass 1: adopt ---------------------------------------------------------
  for (const file of inventory.files) {
    const classification = classifications.get(file.path)!;
    const legacyTopics = projectLegacyTopics(file, classification, selection);
    report.diagnostics.push(...legacyTopics.diagnostics);
    if (classification.skipped) {
      report.filesSkipped.push({ file: file.path, reason: classification.skipReason ?? "skipped" });
      for (const entry of file.parsed.entities) report.idsPreserved.push(entry.entity.id);
      continue;
    }
    report.abstentions.push(...classification.abstentions);
    report.groundingsPreserved += file.parsed.legacy.groundsTo.length;

    const ordered = orderForAdoption(classification.candidates);
    if (ordered.length === 0) {
      report.filesUnchanged.push(file.path);
      continue;
    }

    const moved = groundingPlan.moved.get(file.path);
    const ids: EntityId[] = [];

    for (const candidate of ordered) {
      const isFileLevel = candidate.target.at === "file";
      const absorbRootKeys = absorbedRootKeys(moved !== undefined, isFileLevel && legacyTopics.absorb);
      const payload: Record<string, unknown> = {
        file: candidate.file,
        adopt:
          candidate.target.at === "file"
            ? { at: "file", ...(absorbRootKeys.length === 0 ? {} : { absorbRootKeys }) }
            : { at: "heading", ordinal: candidate.target.ordinal, text: candidate.target.text },
        type: candidate.type,
        title: candidate.title,
        status: "promoted",
      };
      if (isFileLevel && moved !== undefined) payload["groundsTo"] = moved;
      if (isFileLevel && legacyTopics.absorb) payload["topics"] = legacyTopics.topics;

      const result = applyOperation(
        envelope(opIdForCandidate(file, candidate), "create-entry", payload, options),
        applyOptions(),
      );
      report.diagnostics.push(...result.diagnostics);
      if (!result.ok) continue;

      ids.push(...(result.createdIds as EntityId[]));
      if (!result.replayed) {
        report.idsGenerated.push(...(result.createdIds as EntityId[]));
        for (const path of result.changedFiles) changed.add(path);
      } else {
        report.idsPreserved.push(...(result.createdIds as EntityId[]));
      }
      countType(report, candidate.type);
      report.planned.push({
        file: candidate.file,
        type: candidate.type,
        title: candidate.title,
        location: locationOf(candidate),
        rule: candidate.rule,
      });
      if (moved !== undefined && isFileLevel) report.groundingsMoved += moved.length;
    }
    minted.set(file.path, ids);
  }

  // -- pass 1b: root groundings of files an earlier run adopted (#226) --------
  for (const [path, absorb] of groundingPlan.absorbed) {
    const result = applyOperation(absorbEnvelope(path, absorb, options), applyOptions());
    report.diagnostics.push(...result.diagnostics);
    if (!result.ok) continue;
    report.groundingsMoved += absorb.count;
    if (!result.replayed) for (const changedPath of result.changedFiles) changed.add(changedPath);
  }

  // -- pass 2: legacy edges, over a fresh inventory ---------------------------
  //
  // Re-read rather than reasoned about: pass 1 wrote bytes, so the entities on
  // disk are the authority for what an edge can resolve to. Deriving the second
  // pass from the first pass's bookkeeping would be trusting a projection over
  // the tree it projected.
  const after = inventoryScaffold({
    parseCache,
    scaffoldRoot: options.scaffoldRoot,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });
  const outcomes = outcomesFrom(after);
  const edges = planLegacyEdges(after, outcomes);
  report.edgesAmbiguous = edges.diagnostics.length;
  report.diagnostics.push(...edges.diagnostics);

  for (const edge of edges.converted) {
    const result = applyOperation(
      envelope(
        opIdForEdge(edge.sourceFile, edge.targetFile, edge.index),
        "add-relation",
        {
          relation: {
            type: "related_to",
            target: edge.target,
            ...(edge.note === undefined ? {} : { note: edge.note }),
          },
        },
        options,
        edge.sourceEntity,
      ),
      applyOptions(),
    );
    report.diagnostics.push(...result.diagnostics);
    if (!result.ok) continue;
    report.edgesConverted += 1;
    if (!result.replayed) for (const path of result.changedFiles) changed.add(path);
  }

  for (const file of inventory.files) {
    if (!changed.has(file.path) && !report.filesUnchanged.includes(file.path)) {
      const skipped = report.filesSkipped.some((entry) => entry.file === file.path);
      if (!skipped) report.filesUnchanged.push(file.path);
    }
  }

  report.diffs = diffsFor(options, changed);
  return report;
}

/** Outcomes read off a tree that has already been migrated. */
function outcomesFrom(inventory: ScaffoldInventory): Map<string, FileOutcome> {
  const outcomes = new Map<string, FileOutcome>();
  for (const file of inventory.files) {
    outcomes.set(file.path, {
      path: file.path,
      fileEntity: file.parsed.entities.find((entry) => entry.metadataKind === "frontmatter")?.entity.id ?? null,
      entities: file.parsed.entities.map((entry) => entry.entity.id),
    });
  }
  return outcomes;
}

/**
 * Section 13.6's "exact diffs".
 *
 * P5's own renderer produces them, from a plan built against the *migrated*
 * tree — so what a reader sees is the diff the pipeline would produce, not a
 * second rendering that could disagree with it.
 */
function diffsFor(options: MigrateOptions, changed: Set<string>): string[] {
  void options;
  return [...changed].sort();
}

/** Render a report the way section 13.6 asks, for a caller that wants text. */
export function renderMigrationReport(report: MigrationReport): string {
  const lines: string[] = [];
  lines.push(report.dryRun ? "Migration dry run" : "Migration applied");
  lines.push(`  files scanned:      ${report.filesScanned}`);
  lines.push(`  files unchanged:    ${report.filesUnchanged.length}`);
  lines.push(`  files skipped:      ${report.filesSkipped.length}`);
  const types = Object.keys(report.entitiesByType).sort();
  lines.push(`  entities ${report.dryRun ? "proposed" : "created"}:  ${types.length === 0 ? 0 : ""}`);
  for (const type of types) lines.push(`    ${type}: ${report.entitiesByType[type]}`);
  // A dry run mints nothing by design (section 13.3), so `0` here beside a
  // non-zero proposal count reads as a contradiction unless it says why. The
  // number is unchanged; only the label is.
  lines.push(
    report.dryRun
      ? `  ids generated:      ${report.idsGenerated.length} (a dry run mints none; ids are generated on apply)`
      : `  ids generated:      ${report.idsGenerated.length}`,
  );
  lines.push(`  ids preserved:      ${report.idsPreserved.length}`);
  lines.push(`  edges converted:    ${report.edgesConverted}`);
  lines.push(`  edges ambiguous:    ${report.edgesAmbiguous}`);
  lines.push(`  groundings moved:   ${report.groundingsMoved}`);
  lines.push(`  groundings kept:    ${report.groundingsPreserved}`);
  lines.push(`  groundings unclear: ${report.groundingsAmbiguous}`);
  lines.push(`  abstentions:        ${report.abstentions.length}`);
  const blocking = report.diagnostics.filter((entry) => entry.severity === "error");
  lines.push(`  blocking errors:    ${blocking.length}`);
  return lines.join("\n");
}

/** True when anything in the report would stop a caller proceeding. */
export function reportIsBlocked(report: MigrationReport): boolean {
  return hasBlockingDiagnostic(report.diagnostics);
}

/** One exact corpus artifact captured by a pinned migration preview. */
export interface PinnedMigrationArtifact {
  path: string;
  absolutePath: string;
  existed: boolean;
  baseText: string;
  baseFileHash: string | null;
  proposedText: string;
  proposedFileHash: string | null;
}

/**
 * Opaque, executable migration value.
 *
 * Generated ids and intermediate bytes live only in this engine-owned plan;
 * the public dry-run report continues to promise no final ids. Applying walks
 * these already-validated operation plans and never inventories or classifies
 * the scaffold a second time.
 */
export interface PinnedMigrationPlan {
  v: 1;
  migrationId: string;
  previewRevision: string;
  valid: boolean;
  operations: WikiPatchPlan[];
  /** Exact ledger base/proposal, including the zero-operation case. */
  audit: PinnedMigrationArtifact;
  artifacts: PinnedMigrationArtifact[];
  /** Every scanned Markdown file, including unchanged ones. */
  corpus: PinnedMigrationArtifact[];
  report: MigrationReport;
  /** Exact reviewed selection; included in the preview revision. */
  selection: {
    paths: string[] | null;
    topicMappings: Record<string, EntityId>;
  };
}

export interface PinnedMigrationApplyResult {
  ok: boolean;
  migrationId: string;
  previewRevision: string;
  applied: boolean;
  replayed: boolean;
  report: MigrationReport;
  artifacts: PinnedMigrationArtifact[];
  diagnostics: WikiDiagnostic[];
}

/**
 * Build the complete migration in memory.
 *
 * `readFile` is a virtual overlay over the real discovery walk. Each operation
 * plans against the exact bytes proposed by the preceding one, including the
 * audit ledger, so even the second-pass legacy relations are reviewed without
 * a temporary scaffold or a canonical write.
 */
export function planPinnedMigration(options: MigrateOptions): PinnedMigrationPlan {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const selection = migrationSelection(options);
  const parseCache = createParseCache();
  const observed = inventoryScaffold({
    scaffoldRoot,
    parseCache,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });
  validateTopicMappingTargets(observed, selection);
  const inventory = selectMigrationInventory(observed, selection);
  const report = migrationReportFromInventory(options, inventory, selection);
  const classifications = classifyAll(inventory);
  const virtual = new Map(observed.files.map((file) => [resolve(file.absolutePath), file.text]));
  const initial = new Map(virtual);
  const auditPath = operationLogPath(scaffoldRoot);
  const initialAuditExact = readOperationLogExact(scaffoldRoot);
  const initialAudit = initialAuditExact.text;
  let virtualAudit = initialAudit;
  let virtualAuditExists = initialAuditExact.exists;
  const operations: WikiPatchPlan[] = [];
  const minted = new Map<string, EntityId[]>();
  const diagnostics: WikiDiagnostic[] = [];

  const readVirtual = (absolutePath: string): string => {
    const current = virtual.get(resolve(absolutePath));
    return current ?? readContainedSource(scaffoldRoot, absolutePath);
  };
  const planOptions = (): Parameters<typeof planOperation>[1] => ({
    scaffoldRoot,
    unconditional: true,
    parseCache,
    readFile: readVirtual,
    auditText: virtualAudit,
    auditExists: virtualAuditExists,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.graph === undefined || options.graph === null ? {} : { graph: options.graph }),
    ...(options.indexPath === undefined ? {} : { indexPath: options.indexPath }),
  });
  const remember = (planned: ReturnType<typeof planOperation>): WikiPatchPlan | null => {
    if (!planned.ok) {
      diagnostics.push(...planned.diagnostics);
      return null;
    }
    operations.push(planned.plan);
    for (const file of planned.plan.files) virtual.set(resolve(file.absolutePath), file.proposedText);
    virtualAudit = planned.plan.audit.proposedText;
    virtualAuditExists = true;
    return planned.plan;
  };

  const groundingPlan = planGroundingMoves(
    inventory,
    classifications,
    (path) => classifications.get(path)?.candidates ?? [],
    options.graph ?? null,
  );

  for (const file of inventory.files) {
    const classification = classifications.get(file.path)!;
    if (classification.skipped) continue;
    const moved = groundingPlan.moved.get(file.path);
    const legacyTopics = projectLegacyTopics(file, classification, selection);
    const ids: EntityId[] = [];
    for (const candidate of orderForAdoption(classification.candidates)) {
      const isFileLevel = candidate.target.at === "file";
      const absorbRootKeys = absorbedRootKeys(moved !== undefined, isFileLevel && legacyTopics.absorb);
      const payload: Record<string, unknown> = {
        file: candidate.file,
        adopt: candidate.target.at === "file"
          ? { at: "file", ...(absorbRootKeys.length === 0 ? {} : { absorbRootKeys }) }
          : { at: "heading", ordinal: candidate.target.ordinal, text: candidate.target.text },
        type: candidate.type,
        title: candidate.title,
        status: "promoted",
      };
      if (isFileLevel && moved !== undefined) payload["groundsTo"] = moved;
      if (isFileLevel && legacyTopics.absorb) payload["topics"] = legacyTopics.topics;
      const plan = remember(planOperation(
        envelope(opIdForCandidate(file, candidate), "create-entry", payload, options),
        planOptions(),
      ));
      if (plan !== null) ids.push(...plan.createdIds);
    }
    minted.set(file.path, ids);
  }

  for (const [path, absorb] of groundingPlan.absorbed) {
    remember(planOperation(absorbEnvelope(path, absorb, options), planOptions()));
  }

  // Resolve legacy edges over the virtual post-adoption tree, exactly as the
  // applying migration's second pass would see it.
  const afterObserved = inventoryScaffold({
    scaffoldRoot,
    parseCache,
    readFile: readVirtual,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });
  const after = selectMigrationInventory(afterObserved, selection);
  const edges = planLegacyEdges(after, outcomesFrom(after));
  diagnostics.push(...edges.diagnostics);
  for (const edge of edges.converted) {
    remember(planOperation(
      envelope(
        opIdForEdge(edge.sourceFile, edge.targetFile, edge.index),
        "add-relation",
        {
          relation: {
            type: "related_to",
            target: edge.target,
            ...(edge.note === undefined ? {} : { note: edge.note }),
          },
        },
        options,
        edge.sourceEntity,
      ),
      planOptions(),
    ));
  }

  // `minted` is deliberately used only as a non-vacuity assertion here; final
  // ids remain inside `operations`, never in the dry-run report.
  void minted;
  report.diagnostics.push(...diagnostics);
  const corpus = observed.files.map((file) => artifact(
    file.path,
    file.absolutePath,
    file.text,
    virtual.get(resolve(file.absolutePath)) ?? file.text,
    true,
  ));
  const audit = artifact(
    "events/operations.jsonl",
    auditPath,
    initialAudit,
    virtualAudit,
    initialAuditExact.exists,
  );
  const artifacts = [...corpus.filter((entry) => entry.baseText !== entry.proposedText)];
  if (audit.baseText !== audit.proposedText) artifacts.push(audit);

  const valid = !reportIsBlocked(report) && diagnostics.every((entry) => entry.severity !== "error");
  const previewRevision = pinnedMigrationRevision(operations, corpus, audit, artifacts, valid, report, selection);
  return {
    v: 1,
    migrationId: `migration_${previewRevision.slice(0, 26)}`,
    previewRevision,
    valid,
    operations,
    audit,
    artifacts,
    corpus,
    report,
    selection,
  };
}

/** Apply the stored plans after one whole-corpus preflight. */
export function applyPinnedMigration(
  plan: PinnedMigrationPlan,
  expectedPreviewRevision: string,
  options: MigrateOptions,
): PinnedMigrationApplyResult {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const indexPath = options.indexPath ?? defaultIndexPath(scaffoldRoot);
  const ownedLease = options.maintenanceLease === undefined;
  const lease = options.maintenanceLease ?? acquireWikiMaintenanceLease(indexPath, "migration", scaffoldRoot);
  try {
    return applyPinnedMigrationHeld(
      plan,
      expectedPreviewRevision,
      { ...options, scaffoldRoot, maintenanceLease: lease },
    );
  } finally {
    if (ownedLease) lease.release();
  }
}

function applyPinnedMigrationHeld(
  plan: PinnedMigrationPlan,
  expectedPreviewRevision: string,
  options: MigrateOptions & { maintenanceLease: WikiMaintenanceLease },
): PinnedMigrationApplyResult {
  const diagnostics: WikiDiagnostic[] = [];
  const recomputedRevision = pinnedMigrationRevision(
    plan.operations,
    plan.corpus,
    plan.audit,
    plan.artifacts,
    plan.valid,
    plan.report,
    plan.selection,
  );
  if (
    plan.v !== 1
    || expectedPreviewRevision !== plan.previewRevision
    || recomputedRevision !== plan.previewRevision
    || plan.migrationId !== `migration_${recomputedRevision.slice(0, 26)}`
  ) {
    diagnostics.push(diagnostic("CONTENT_HASH_CONFLICT", "The supplied migration preview revision does not identify this plan."));
    return failedPinnedApply(plan, diagnostics);
  }
  if (!plan.valid) {
    diagnostics.push(...plan.report.diagnostics);
    return failedPinnedApply(plan, diagnostics);
  }

  const scaffoldRoot = resolve(options.scaffoldRoot);
  const log = readAuditLog(scaffoldRoot);
  diagnostics.push(...log.diagnostics);
  let completed = 0;
  let inFlight = false;
  for (let index = 0; index < plan.operations.length; index += 1) {
    const record = recordFor(log, plan.operations[index]!.opId);
    if (record.complete !== null) {
      if (inFlight || completed !== index) {
        diagnostics.push(diagnostic("CONTENT_HASH_CONFLICT", "Migration operation records are not a valid prefix of the reviewed plan."));
        return failedPinnedApply(plan, diagnostics);
      }
      completed += 1;
      continue;
    }
    if (record.intent !== null) inFlight = true;
    break;
  }

  const preflight = preflightPinnedMigration(plan, scaffoldRoot, completed, inFlight, options);
  diagnostics.push(...preflight);
  if (preflight.length > 0) return failedPinnedApply(plan, diagnostics);

  if (completed === plan.operations.length) {
    return {
      ok: true,
      migrationId: plan.migrationId,
      previewRevision: plan.previewRevision,
      applied: false,
      replayed: true,
      report: appliedMigrationReport(plan),
      artifacts: plan.artifacts,
      diagnostics,
    };
  }

  const sequence = applyPlannedOperationSequence(plan.operations, {
    scaffoldRoot,
    expectedSequenceRevision: expectedPreviewRevision,
    sequenceRevision: recomputedRevision,
    unconditional: true,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.graph === undefined || options.graph === null ? {} : { graph: options.graph }),
    ...(options.indexPath === undefined ? {} : { indexPath: options.indexPath }),
    ...(options.onFileWritten === undefined ? {} : { onFileWritten: options.onFileWritten }),
    ...(options.beforeFileRename === undefined ? {} : { beforeFileRename: options.beforeFileRename }),
    ...(options.beforeAuditAppend === undefined ? {} : { beforeAuditAppend: options.beforeAuditAppend }),
    ...(options.afterAuditWrite === undefined ? {} : { afterAuditWrite: options.afterAuditWrite }),
    beforeSequenceCommit: () => assertPinnedCorpusFinal(plan, scaffoldRoot, options),
    maintenanceLease: options.maintenanceLease,
  });
  diagnostics.push(...sequence.diagnostics);
  if (!sequence.ok) return failedPinnedApply(plan, diagnostics);

  return {
    ok: true,
    migrationId: plan.migrationId,
    previewRevision: plan.previewRevision,
    applied: true,
    replayed: false,
    report: appliedMigrationReport(plan),
    artifacts: plan.artifacts,
    diagnostics,
  };
}

function assertPinnedCorpusFinal(
  plan: PinnedMigrationPlan,
  scaffoldRoot: string,
  options: MigrateOptions,
): void {
  const current = inventoryScaffold({
    scaffoldRoot,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });
  const expected = new Map(plan.corpus.map((entry) => [entry.path, entry.proposedText]));
  if (current.files.length !== expected.size) {
    throw new Error("The Wiki corpus changed while the reviewed migration was applying.");
  }
  for (const file of current.files) {
    if (expected.get(file.path) !== file.text) {
      throw new Error("The Wiki corpus changed while the reviewed migration was applying.");
    }
  }
}

function artifact(
  path: string,
  absolutePath: string,
  baseText: string,
  proposedText: string,
  existed: boolean,
): PinnedMigrationArtifact {
  return {
    path,
    absolutePath,
    existed,
    baseText,
    baseFileHash: existed ? exactFileContentHash(baseText) : null,
    proposedText,
    proposedFileHash: proposedText === "" && !existed ? null : exactFileContentHash(proposedText),
  };
}

function pinnedMigrationRevision(
  operations: readonly WikiPatchPlan[],
  corpus: readonly PinnedMigrationArtifact[],
  audit: PinnedMigrationArtifact,
  artifacts: readonly PinnedMigrationArtifact[],
  valid: boolean,
  report: MigrationReport,
  selection: PinnedMigrationPlan["selection"],
): string {
  const hash = createHash("sha256");
  hash.update("wiki-migration-plan-v1\u0000", "utf8");
  for (const [kind, entries] of [["corpus", corpus], ["audit", [audit]], ["artifacts", artifacts]] as const) {
    hash.update(`${kind}\u0000`, "utf8");
    for (const entry of [...entries].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
      hash.update(
        `${entry.path}\u0000${entry.absolutePath}\u0000${entry.existed ? "1" : "0"}\u0000`
        + `${entry.baseFileHash ?? ""}\u0000${exactFileContentHash(entry.baseText)}\u0000`
        + `${entry.proposedFileHash ?? ""}\u0000${exactFileContentHash(entry.proposedText)}\u0000`,
        "utf8",
      );
    }
  }
  for (const operation of operations) hash.update(`${previewHashOf(operation)}\u0000`, "utf8");
  hash.update(`${valid ? "valid" : "invalid"}\u0000${canonicalMigrationValue(report)}\u0000`, "utf8");
  hash.update(`${canonicalMigrationValue(selection)}\u0000`, "utf8");
  return hash.digest("hex");
}

function canonicalMigrationValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalMigrationValue).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalMigrationValue(entry)}`).join(",")}}`;
}

function preflightPinnedMigration(
  plan: PinnedMigrationPlan,
  scaffoldRoot: string,
  completed: number,
  inFlight: boolean,
  options: MigrateOptions,
): WikiDiagnostic[] {
  const diagnostics: WikiDiagnostic[] = [];
  const expected = new Map(plan.corpus.map((entry) => [entry.path, entry.baseText]));
  for (let index = 0; index < completed; index += 1) {
    for (const file of plan.operations[index]!.files) expected.set(file.path, file.proposedText);
  }

  const current = inventoryScaffold({
    scaffoldRoot,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });
  const currentPaths = current.files.map((file) => file.path).sort();
  const expectedPaths = plan.corpus.map((file) => file.path).sort();
  if (currentPaths.length !== expectedPaths.length || currentPaths.some((path, index) => path !== expectedPaths[index])) {
    diagnostics.push(diagnostic("CONTENT_HASH_CONFLICT", "The Wiki corpus changed since this migration was previewed."));
    return diagnostics;
  }

  const active = inFlight ? plan.operations[completed] : undefined;
  for (const file of current.files) {
    const wanted = expected.get(file.path);
    const activeEdit = active?.files.find((entry) => entry.path === file.path);
    if (file.text !== wanted && file.text !== activeEdit?.proposedText) {
      diagnostics.push(diagnostic("CONTENT_HASH_CONFLICT", `${file.path} changed since migration preview.`, { file: file.path }));
    }
  }

  const currentAudit = readOperationLogExact(scaffoldRoot).text;
  let expectedAudit: string;
  if (completed === plan.operations.length) {
    expectedAudit = plan.operations.at(-1)?.audit.proposedText ?? currentAudit;
  } else {
    const operation = plan.operations[completed]!;
    expectedAudit = operation.audit.baseText;
    if (inFlight) expectedAudit += `${JSON.stringify(auditRecord(operation, "intent"))}\n`;
  }
  if (currentAudit !== expectedAudit) {
    diagnostics.push(diagnostic("CONTENT_HASH_CONFLICT", "The operation ledger changed since migration preview."));
  }
  return diagnostics;
}

function failedPinnedApply(
  plan: PinnedMigrationPlan,
  diagnostics: WikiDiagnostic[],
): PinnedMigrationApplyResult {
  return {
    ok: false,
    migrationId: plan.migrationId,
    previewRevision: plan.previewRevision,
    applied: false,
    replayed: false,
    report: plan.report,
    artifacts: [],
    diagnostics,
  };
}

function appliedMigrationReport(plan: PinnedMigrationPlan): MigrationReport {
  return {
    ...plan.report,
    dryRun: false,
    idsGenerated: plan.operations.flatMap((operation) => operation.createdIds),
    diffs: plan.artifacts.map((entry) => entry.path),
  };
}

export { diagnostic, planOperation, previewPlan, renderPreview };
