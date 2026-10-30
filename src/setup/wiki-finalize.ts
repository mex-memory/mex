import { resolve } from "node:path";
import { throwIfSetupAborted } from "./phases.js";
import { stampScaffoldFiles } from "../wiki/migration/stamp.js";
import { wikiLinkSections } from "../wiki/service/link-sections.js";
import {
  createWikiEngine,
  type MigrationApplyResult,
  type ServiceResult,
  type WikiDiagnostic,
} from "../wiki/service.js";

export type SetupWikiFinalizationStage =
  | "ids"
  | "plan"
  | "migration"
  | "links"
  | "index"
  | "validation"
  | "complete";

export interface SetupWikiFinalizationOptions {
  projectRoot: string;
  scaffoldRoot: string;
  exclude?: readonly string[];
  readOnly?: readonly string[];
  onProgress?: (message: string) => void;
  onWarning?: (message: string) => void;
  signal?: AbortSignal;
}

/** A compact, setup-oriented summary over the existing Wiki service results. */
export interface SetupWikiFinalizationResult {
  ready: boolean;
  stage: SetupWikiFinalizationStage;
  reason: string | null;
  migrated: boolean;
  /** Files the finish step gave a file-level id, apart from migration's own. */
  stampedFiles: number;
  /** Structural `refines` links added from sections to their enclosing knowledge. */
  linkedSections: number;
  plannedEntities: number;
  indexedEntities: number;
  filesScanned: number;
  entitiesChecked: number;
  abstentions: number;
  warningCount: number;
  diagnostics: WikiDiagnostic[];
}

/**
 * Canonicalize and index the populated setup scaffold.
 *
 * Setup's own templates already carry their Wiki ids from placement (#286), so
 * this no longer migrates them. It gives an id to each file still without one
 * that migration would not adopt (a file holding only entities the population
 * agent created, or one no rule types, which takes its folder's type), runs
 * migration for what an older scaffold still needs (unadopted legacy files,
 * the decision log's entries, legacy edges and root groundings), then links
 * every section to its enclosing knowledge before indexing.
 *
 * Migration remains plan-first: the Wiki engine re-plans before apply and
 * refuses if the scaffold changed under the reviewed plan. Every underlying
 * operation is already restartable, so calling this again only rebuilds the
 * derived index and validates the same canonical Markdown.
 */
export async function finalizeSetupWiki(
  options: SetupWikiFinalizationOptions,
): Promise<SetupWikiFinalizationResult> {
  throwIfSetupAborted(options.signal);
  const projectRoot = resolve(options.projectRoot);
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const engine = createWikiEngine({
    scaffoldRoot,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  const diagnostics = new Map<string, WikiDiagnostic>();
  const warnings = new Set<string>();
  let plannedEntities = 0;
  let indexedEntities = 0;
  let filesScanned = 0;
  let entitiesChecked = 0;
  let abstentions = 0;
  let migrated = false;
  let stampedFiles = 0;
  let linkedSections = 0;

  const collectDiagnostics = (entries: readonly WikiDiagnostic[]): void => {
    for (const entry of entries) {
      const key = JSON.stringify([
        entry.code,
        entry.severity,
        entry.file ?? null,
        entry.entityId ?? null,
        entry.message,
      ]);
      diagnostics.set(key, entry);
      if (entry.severity !== "warning") continue;
      const message = `${entry.code}${entry.file === undefined ? "" : ` ${entry.file}`}: ${entry.message}`;
      if (warnings.has(message)) continue;
      warnings.add(message);
      options.onWarning?.(message);
    }
  };

  const result = (
    ready: boolean,
    stage: SetupWikiFinalizationStage,
    reason: string | null,
  ): SetupWikiFinalizationResult => ({
    ready,
    stage,
    reason,
    migrated,
    stampedFiles,
    linkedSections,
    plannedEntities,
    indexedEntities,
    filesScanned,
    entitiesChecked,
    abstentions,
    warningCount: warnings.size,
    diagnostics: [...diagnostics.values()],
  });

  options.onProgress?.("Checking Wiki ids...");
  throwIfSetupAborted(options.signal);
  // Stamping is a write too. Refuse structural errors before adding ids to
  // otherwise healthy files in a scaffold that cannot safely be finalized.
  const initial = await engine.validate({ projectRoot });
  throwIfSetupAborted(options.signal);
  if (hasErrors(initial)) {
    collectDiagnostics(initial.diagnostics);
    return result(false, "plan", "Wiki migration is blocked by errors in the populated scaffold.");
  }
  const stamped = stampScaffoldFiles({
    scaffoldRoot,
    scope: "remaining",
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  throwIfSetupAborted(options.signal);
  collectDiagnostics(withoutPendingIndex(stamped.diagnostics));
  if (!stamped.applied || stamped.diagnostics.some((entry) => entry.severity === "error")) {
    return result(false, "ids", "Wiki ids could not be added to the populated scaffold.");
  }
  stampedFiles = stamped.stamped.length;

  options.onProgress?.("Planning Wiki migration...");
  throwIfSetupAborted(options.signal);
  const plan = await engine.planMigration();
  throwIfSetupAborted(options.signal);
  collectDiagnostics(plan.diagnostics);
  plannedEntities = plan.data.report.planned.length;
  filesScanned = plan.data.report.filesScanned;
  abstentions = plan.data.report.abstentions.length;
  for (const abstention of plan.data.report.abstentions) {
    const message = `Wiki migration left ${abstention.file} for review: ${abstention.reason}`;
    if (warnings.has(message)) continue;
    warnings.add(message);
    options.onWarning?.(message);
  }
  // The migration planner deliberately abstains on malformed entity blocks;
  // validation supplies the blocking diagnostic that keeps setup from writing
  // other files around a scaffold which is already structurally unsafe.
  const preflight = await engine.validate({ projectRoot });
  throwIfSetupAborted(options.signal);
  // Every knowledge file outside the Wiki is either adopted by the migration
  // this run applies next or already reported above as one of its
  // abstentions, so telling the user to run `mex wiki migrate` here would be
  // wrong twice over (#227).
  const preflightFindings = withoutAdoptionGaps(preflight.diagnostics, ["KNOWLEDGE_NOT_ADOPTED", "KNOWLEDGE_UNTYPED"]);
  const blocked = plan.data.blocked || hasErrors(plan) || hasErrors(preflight);
  // Only the blocking findings, unless nothing runs after this: the rest
  // describe the scaffold before this run converts edges and links sections
  // (an entity orphaned here is linked a moment later, #286), and the final
  // validation reports whatever still holds once it has.
  collectDiagnostics(blocked ? preflightFindings : preflightFindings.filter((entry) => entry.severity === "error"));
  filesScanned = preflight.data.filesScanned;
  entitiesChecked = preflight.data.entitiesChecked;
  if (blocked) {
    return result(false, "plan", "Wiki migration is blocked by errors in the populated scaffold.");
  }

  options.onProgress?.("Applying Wiki migration...");
  throwIfSetupAborted(options.signal);
  const applied = await engine.applyMigration(plan.data);
  throwIfSetupAborted(options.signal);
  collectDiagnostics(applied.diagnostics);
  migrated = migrationChangedFiles(applied).length > 0;
  if (!applied.data.applied || hasErrors(applied)) {
    return result(false, "migration", "Wiki migration could not be applied safely.");
  }

  options.onProgress?.("Linking Wiki sections...");
  throwIfSetupAborted(options.signal);
  const linked = wikiLinkSections({
    scaffoldRoot,
    apply: true,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  throwIfSetupAborted(options.signal);
  collectDiagnostics(withoutPendingIndex(linked.diagnostics));
  if (hasErrors(linked) || (linked.data.links.length > 0 && !linked.data.applied)) {
    return result(false, "links", "Wiki sections could not be linked to their files.");
  }
  linkedSections = linked.data.links.length;

  options.onProgress?.("Rebuilding Wiki index...");
  throwIfSetupAborted(options.signal);
  const rebuilt = await engine.rebuildIndex(options.signal ? { signal: options.signal } : undefined);
  throwIfSetupAborted(options.signal);
  collectDiagnostics(rebuilt.diagnostics);
  indexedEntities = rebuilt.data.entityCount;
  if (hasErrors(rebuilt)) {
    return result(false, "index", "Wiki index rebuild failed validation.");
  }

  options.onProgress?.("Validating Wiki scaffold...");
  throwIfSetupAborted(options.signal);
  const validated = await engine.validate({ projectRoot });
  throwIfSetupAborted(options.signal);
  // An untyped context file was reported as a migration abstention above. A
  // file still not adopted after the migration is not expected, and is kept.
  collectDiagnostics(withoutAdoptionGaps(validated.diagnostics, ["KNOWLEDGE_UNTYPED"]));
  filesScanned = validated.data.filesScanned;
  entitiesChecked = validated.data.entitiesChecked;
  if (hasErrors(validated)) {
    return result(false, "validation", "Wiki scaffold validation found blocking errors.");
  }

  options.onProgress?.("Wiki ids, links and index are ready.");
  return result(true, "complete", null);
}

function hasErrors(result: ServiceResult<unknown>): boolean {
  return result.diagnostics.some((entry) => entry.severity === "error");
}

function migrationChangedFiles(result: ServiceResult<MigrationApplyResult>): readonly string[] {
  return result.data.report.diffs;
}

/**
 * Drop "no index to refresh yet" from a write this step makes before it
 * rebuilds the index anyway: the notice is true and already being acted on.
 */
function withoutPendingIndex(diagnostics: readonly WikiDiagnostic[]): WikiDiagnostic[] {
  return diagnostics.filter((entry) => entry.code !== "INDEX_REFRESH_REQUIRED");
}

/** Drop the adoption-gap codes this stage of setup already accounts for (#227). */
function withoutAdoptionGaps(
  diagnostics: readonly WikiDiagnostic[],
  codes: readonly WikiDiagnostic["code"][],
): WikiDiagnostic[] {
  return diagnostics.filter((entry) => !codes.includes(entry.code));
}
