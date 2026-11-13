import { registerJobKind } from "../record/jobs.js";

export interface IndexJobParams { checkout: string; full?: boolean }

/**
 * The background build of one checkout's file index. One batch is one build or
 * refresh; a refresh reads only changed files, so it is short after the first.
 */
registerJobKind<IndexJobParams, { builds: number }>({
  name: "file-index",
  label: "File index",
  scope: "project",
  // A build writes new snapshot files and swaps a pointer; running it twice is harmless.
  sideEffects: "idempotent",
  async runBatch({ job, params, checkpoint, writer }) {
    // Loaded here so listing jobs doesn't load the parsers.
    const { buildIndex } = await import("./build.js");
    const result = await buildIndex({ root: params.checkout, projectId: job.project_id!, recordDirectory: writer.location.directory, full: params.full });
    const gaps = Object.values(result.notIndexed).reduce((sum, count) => sum + (count ?? 0), 0);
    return {
      checkpoint: { builds: (checkpoint?.builds ?? 0) + 1 },
      done: true,
      results: result.indexed,
      summary: `${result.indexed} of ${result.files} files indexed in ${(result.ms.total / 1000).toFixed(1)} s (${result.parsed} parsed, ${gaps} not indexed)`,
    };
  },
});
