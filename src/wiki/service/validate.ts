/**
 * §16 `wiki_validate` — the whole-scaffold pass, behind the service contract.
 *
 * A thin adapter on purpose. Every decision lives in `validation/validate.ts`;
 * this maps its report onto `ServiceResult` so `ok` and the exit status are
 * derived by the same envelope every other command uses.
 */

import { validateScaffold, type ValidateOptions, type ValidationReport } from "../validation/validate.js";
import type { ServiceResult } from "./read.js";

export interface ValidateData {
  filesScanned: number;
  entitiesChecked: number;
  counts: ValidationReport["counts"];
  /** True when a bound stopped the diagnostic list — data, never a diagnostic. */
  truncated: boolean;
}

export function wikiValidate(options: ValidateOptions): ServiceResult<ValidateData> {
  const report = validateScaffold(options);
  return {
    data: {
      filesScanned: report.filesScanned,
      entitiesChecked: report.entitiesChecked,
      counts: report.counts,
      truncated: report.truncated,
    },
    diagnostics: report.diagnostics,
  };
}
