import type { StalenessThresholds } from "../../types.js";

/**
 * Default thresholds. Overridden via MexConfig.stalenessThresholds / CLI flags.
 *
 * Kept apart from the checker so that loading the configuration does not load
 * Git: `config.ts` needs only these numbers, and the Git client is a large import
 * that a per-tool-call hook cannot afford.
 */
export const DEFAULT_STALENESS_THRESHOLDS: StalenessThresholds = {
  warnDays: 30,
  errorDays: 90,
  warnCommits: 50,
  errorCommits: 200,
};
