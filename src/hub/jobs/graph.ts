import type { GraphMaintenanceProgress } from "../../team/contracts/graph.js";
import type { RepositoryGraphPort } from "../../graph/application-adapter.js";
import type { HubJobExecutors, HubJobProgressUpdate } from "./types.js";

/** Production graph executors. Maintenance remains explicit and capability-injected. */
export function createGraphJobExecutors(graph: RepositoryGraphPort): HubJobExecutors {
  return {
    graph_refresh: async ({ signal, reportProgress }) => {
      const project = progressProjector();
      await graph.refresh({
        signal,
        onProgress: (progress) => reportProgress(project(progress)),
      });
    },
    graph_rebuild: async ({ signal, reportProgress }) => {
      const project = progressProjector();
      await graph.rebuild({
        signal,
        onProgress: (progress) => reportProgress(project(progress)),
      });
    },
  };
}

/**
 * A Hub job has one progress bar: its count never falls and its total never
 * changes once seen. Graph maintenance counts each phase from zero (the
 * engine's parse then resolve), so counts that would break the bar are
 * dropped and only the phase moves on.
 */
function progressProjector(): (progress: GraphMaintenanceProgress) => HubJobProgressUpdate {
  let completed: number | undefined;
  let total: number | undefined;
  return (progress) => {
    const update: HubJobProgressUpdate = { phase: progress.phase };
    if (progress.completed === undefined) return update;
    const sameTotal = total === undefined || progress.total === undefined || progress.total === total;
    if (!sameTotal || (completed !== undefined && progress.completed < completed)) return update;
    completed = progress.completed;
    total ??= progress.total;
    return {
      ...update,
      completed: progress.completed,
      ...(progress.total === undefined ? {} : { total: progress.total }),
    };
  };
}
