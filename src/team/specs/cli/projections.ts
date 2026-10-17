import { MexPortError, type Diagnostic, type MexErrorCode } from "../../contracts/shared.js";
import { WIKI_MIGRATION_RECOVERY } from "../../../wiki/migration/recovery.js";
import type {
  SpecDetailProjection,
  SpecIndexProjection,
  SpecListPageProjection,
  SpecListResult,
  SpecShowResult,
} from "../service.js";

export interface SpecCliListProjection {
  availability: "ready";
  index: SpecIndexProjection;
  page: SpecListPageProjection;
}

export interface SpecCliShowProjection {
  availability: "ready";
  index: SpecIndexProjection;
  detail: SpecDetailProjection;
}

export function projectSpecList(result: SpecListResult): SpecCliListProjection {
  if (result.availability !== "ready") throw unavailableError(result.index);
  return structuredClone(result);
}

export function projectSpecShow(result: SpecShowResult): SpecCliShowProjection {
  if (result.availability !== "ready") throw unavailableError(result.index);
  return structuredClone(result);
}

export function specListDiagnostics(
  projection: SpecCliListProjection,
): readonly Diagnostic[] {
  return boundedDiagnostics([
    ...projection.index.diagnostics,
    ...projection.page.items.flatMap((item) => item.diagnostics),
  ]);
}

export function specShowDiagnostics(
  projection: SpecCliShowProjection,
): readonly Diagnostic[] {
  return boundedDiagnostics([
    ...projection.index.diagnostics,
    ...projection.detail.spec.diagnostics,
    ...projection.detail.hierarchy.requirements.flatMap((item) => item.diagnostics),
    ...projection.detail.hierarchy.acceptanceCriteria.flatMap((item) => item.diagnostics),
    ...projection.detail.hierarchy.constraints.flatMap((item) => item.diagnostics),
  ]);
}

function unavailableError(index: SpecIndexProjection): MexPortError {
  const code = problemCode(index.state);
  const description = index.state.replaceAll("_", " ");
  const recovery = recoveryFor(index.state);
  return new MexPortError({
    title: "Specs unavailable",
    status: code === "INDEX_STALE" || code === "OPERATION_INTERRUPTED" ? 409 : 503,
    code,
    detail: `The read-only Specs surface is unavailable because the Wiki index is ${description}.`,
    diagnostics: index.diagnostics,
    ...(recovery.length === 0 ? {} : { recovery }),
  });
}

function recoveryFor(
  state: SpecIndexProjection["state"],
): readonly { label: string; command: string }[] {
  if (state === "migration_required") {
    return [{
      label: WIKI_MIGRATION_RECOVERY.label,
      command: `${WIKI_MIGRATION_RECOVERY.command} --json`,
    }];
  }
  if (state === "missing" || state === "stale" || state === "rebuild_required") {
    return [{
      label: "Rebuild the Wiki index",
      command: "mex wiki rebuild-index --json",
    }];
  }
  return [];
}

function problemCode(state: SpecIndexProjection["state"]): MexErrorCode {
  switch (state) {
    case "stale":
    case "rebuild_required":
      return "INDEX_STALE";
    case "missing":
      return "INDEX_MISSING";
    case "migration_required":
      return "MIGRATION_REQUIRED";
    case "degraded":
      return "OPERATION_INTERRUPTED";
    case "corrupt":
      return "INDEX_CORRUPT";
    case "fresh":
      return "INTERNAL_ERROR";
  }
}

function boundedDiagnostics(values: readonly Diagnostic[]): readonly Diagnostic[] {
  const seen = new Set<string>();
  const results: Diagnostic[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(structuredClone(value));
    if (results.length >= 100) break;
  }
  return results;
}
