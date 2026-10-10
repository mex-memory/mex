import type { GraphMaintenanceProgress } from "../team/contracts/graph.js";

const LABELS: Record<GraphMaintenanceProgress["phase"], string> = {
  discover: "Checking existing graph and project files",
  stage: "Preparing an isolated graph build",
  parse: "Parsing source files",
  resolve: "Resolving code references",
  validate: "Validating the rebuilt graph",
  publish: "Saving the verified graph",
};

/** Keep maintenance text and arbitrary paths out of the presentation contract. */
export function setupGraphActivity(update: GraphMaintenanceProgress): {
  detail: string;
  progress?: { completed: number; total?: number; unit: string };
} {
  const detail = LABELS[update.phase];
  const completed = update.completed;
  if (update.phase !== "parse" || completed === undefined || !Number.isSafeInteger(completed) || completed < 0) return { detail };
  const total = update.total !== undefined && Number.isSafeInteger(update.total) && update.total > 0 && update.total >= completed
    ? update.total : undefined;
  return { detail, progress: { completed, ...(total === undefined ? {} : { total }), unit: "files parsed" } };
}

export function formatSetupGraphActivity(update: GraphMaintenanceProgress): string {
  const { detail, progress } = setupGraphActivity(update);
  return progress ? `${detail}: ${progress.completed}${progress.total === undefined ? "" : ` / ${progress.total}`} ${progress.unit}` : detail;
}
