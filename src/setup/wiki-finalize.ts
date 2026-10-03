import { resolve } from "node:path";
import {
  createWikiEngine,
  type MigrationApplyResult,
  type ServiceResult,
  type WikiDiagnostic,
} from "../wiki/service.js";

export type SetupWikiFinalizationStage =
  | "plan"
  | "migration"
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
}

/** A compact, setup-oriented summary over the existing Wiki service results. */
export interface SetupWikiFinalizationResult {
  ready: boolean;
  stage: SetupWikiFinalizationStage;
  reason: string | null;
  migrated: boolean;
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
 * Migration remains plan-first: the Wiki engine re-plans before apply and
 * refuses if the scaffold changed under the reviewed plan. Every underlying
 * operation is already restartable, so calling this again only rebuilds the
 * derived index and validates the same canonical Markdown.
 */
export async function finalizeSetupWiki(
  options: SetupWikiFinalizationOptions,
): Promise<SetupWikiFinalizationResult> {
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
    plannedEntities,
    indexedEntities,
    filesScanned,
    entitiesChecked,
    abstentions,
    warningCount: warnings.size,
    diagnostics: [...diagnostics.values()],
  });

  options.onProgress?.("Planning Wiki migration...");
  const plan = await engine.planMigration();
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
  // Every knowledge file outside the Wiki is either adopted by the migration
  // this run applies next or already reported above as one of its
  // abstentions, so telling the user to run `mex wiki migrate` here would be
  // wrong twice over (#227).
  collectDiagnostics(withoutAdoptionGaps(preflight.diagnostics, ["KNOWLEDGE_NOT_ADOPTED", "KNOWLEDGE_UNTYPED"]));
  filesScanned = preflight.data.filesScanned;
  entitiesChecked = preflight.data.entitiesChecked;
  if (plan.data.blocked || hasErrors(plan) || hasErrors(preflight)) {
    return result(false, "plan", "Wiki migration is blocked by errors in the populated scaffold.");
  }

  options.onProgress?.("Applying Wiki migration...");
  const applied = await engine.applyMigration(plan.data);
  collectDiagnostics(applied.diagnostics);
  migrated = migrationChangedFiles(applied).length > 0;
  if (!applied.data.applied || hasErrors(applied)) {
    return result(false, "migration", "Wiki migration could not be applied safely.");
  }

  options.onProgress?.("Rebuilding Wiki index...");
  const rebuilt = await engine.rebuildIndex();
  collectDiagnostics(rebuilt.diagnostics);
  indexedEntities = rebuilt.data.entityCount;
  if (hasErrors(rebuilt)) {
    return result(false, "index", "Wiki index rebuild failed validation.");
  }

  options.onProgress?.("Validating Wiki scaffold...");
  const validated = await engine.validate({ projectRoot });
  // An untyped context file was reported as a migration abstention above. A
  // file still not adopted after the migration is not expected, and is kept.
  collectDiagnostics(withoutAdoptionGaps(validated.diagnostics, ["KNOWLEDGE_UNTYPED"]));
  filesScanned = validated.data.filesScanned;
  entitiesChecked = validated.data.entitiesChecked;
  if (hasErrors(validated)) {
    return result(false, "validation", "Wiki scaffold validation found blocking errors.");
  }

  options.onProgress?.("Wiki migration and index are ready.");
  return result(true, "complete", null);
}

function hasErrors(result: ServiceResult<unknown>): boolean {
  return result.diagnostics.some((entry) => entry.severity === "error");
}

function migrationChangedFiles(result: ServiceResult<MigrationApplyResult>): readonly string[] {
  return result.data.report.diffs;
}

/** Drop the adoption-gap codes this stage of setup already accounts for (#227). */
function withoutAdoptionGaps(
  diagnostics: readonly WikiDiagnostic[],
  codes: readonly WikiDiagnostic["code"][],
): WikiDiagnostic[] {
  return diagnostics.filter((entry) => !codes.includes(entry.code));
}
