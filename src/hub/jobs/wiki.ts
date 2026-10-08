import type { IndexProgress } from "../../team/contracts/shared.js";
import { performance } from "node:perf_hooks";
import type { RepositoryWikiPort } from "../../wiki/application-adapter.js";
import type { HubJobExecutors, HubJobProgressUpdate } from "./types.js";

/** Production Wiki executors. Every write is an explicit durable Hub job. */
export function createWikiJobExecutors(wiki: RepositoryWikiPort): HubJobExecutors {
  return {
    wiki_refresh: async ({ signal, reportProgress }) => {
      reportProgress({ phase: "discover" });
      const changedPaths = await wiki.discoverRefreshPaths();
      signal.throwIfAborted();
      // A concurrent CLI refresh may make the exact changed set empty between
      // eligibility and execution. That is a truthful successful no-op.
      if (changedPaths.length === 0) return;
      await wiki.refreshFiles(changedPaths, {
        signal,
        reportProgress: boundedProgress(signal, reportProgress),
      });
    },
    wiki_rebuild: async ({ signal, reportProgress }) => {
      await wiki.rebuildIndex({
        signal,
        reportProgress: boundedProgress(signal, reportProgress),
      });
    },
  };
}

/** Persist phase changes and completion immediately; sample intermediate counts. */
function boundedProgress(
  signal: AbortSignal,
  report: (progress: HubJobProgressUpdate) => void,
): (progress: IndexProgress) => void {
  let lastPhase: HubJobProgressUpdate["phase"];
  let lastReport = -Infinity;
  return (progress) => {
    signal.throwIfAborted();
    const projected = projectProgress(progress);
    const now = performance.now();
    const complete = progress.total !== undefined && progress.completed === progress.total;
    if (projected.phase !== lastPhase || complete || now - lastReport >= 100) {
      report(projected);
      lastPhase = projected.phase;
      lastReport = now;
    }
  };
}

function projectProgress(progress: IndexProgress): HubJobProgressUpdate {
  return {
    phase: asWikiPhase(progress.phase),
    ...(progress.completed === undefined ? {} : { completed: progress.completed }),
    ...(progress.total === undefined ? {} : { total: progress.total }),
  };
}

function asWikiPhase(phase: string): HubJobProgressUpdate["phase"] {
  return ["discover", "stage", "parse", "resolve", "validate", "publish"].includes(phase)
    ? phase as HubJobProgressUpdate["phase"]
    : "running";
}
