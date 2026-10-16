import type { GraphRefreshWork } from "../team/contracts/graph.js";

/**
 * How a refresh did its work, in one line: whether it re-extracted only what
 * changed or the whole corpus, and why it went the long way when it did.
 * Counts and a fixed-vocabulary reason only, never a path.
 *
 * A refresh that finds the stored graph already describes the sources reports
 * no work at all, which is `undefined` here.
 */
export function describeRefreshWork(
  work: Pick<GraphRefreshWork, "mode" | "fallbackReason" | "filesChanged" | "filesReextracted"> | undefined,
): string {
  if (work === undefined) return "Refresh: nothing changed.";
  const reason = work.mode === "full" && work.fallbackReason ? ` (${work.fallbackReason})` : "";
  return `Refresh: ${work.mode}${reason}, ${work.filesChanged} changed, ${work.filesReextracted} re-extracted.`;
}

/** What a caller that ran `mex graph refresh --json` keeps of the result. */
export interface RefreshWorkSummary {
  /** `unchanged`: the graph already described the sources, so nothing was extracted. */
  mode: "incremental" | "full" | "unchanged";
  /** Why a full refresh was not incremental, when the graph said. */
  reason?: string;
  changed: number;
  reextracted: number;
}

/** The mode a `mex graph refresh --json` result reports, or null when the output is not that result. */
export function readRefreshWork(stdout: string): RefreshWorkSummary | null {
  try {
    const result = JSON.parse(stdout) as { state?: unknown; refresh?: Partial<GraphRefreshWork> | null } | null;
    if (result === null || typeof result !== "object" || result.state !== "succeeded") return null;
    const refresh = result.refresh;
    if (!refresh) return { mode: "unchanged", changed: 0, reextracted: 0 };
    if (refresh.mode !== "incremental" && refresh.mode !== "full") return null;
    return {
      mode: refresh.mode,
      ...(typeof refresh.fallbackReason === "string" ? { reason: refresh.fallbackReason } : {}),
      changed: typeof refresh.filesChanged === "number" ? refresh.filesChanged : 0,
      reextracted: typeof refresh.filesReextracted === "number" ? refresh.filesReextracted : 0,
    };
  } catch {
    return null;
  }
}
