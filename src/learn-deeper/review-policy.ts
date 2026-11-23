import type { Cluster } from "./cluster.js";

/**
 * A person can leave a learned item waiting without refusing it. Later evidence may add support.
 * The entry stays proposed until the person ticks it.
 */
export function preserveWaiting<T extends Pick<Cluster, "earlier" | "waiting">>(cluster: T, waiting: ReadonlySet<string>): T {
  if (cluster.earlier && waiting.has(cluster.earlier)) return { ...cluster, waiting: true };
  return cluster;
}

/** What the terminal says after a wait or a drop, so a shared copy and a loaded rule file stay visible. */
export function reviewBoundaryNotes(sharedIds: readonly string[], sessionActive: boolean): string[] {
  const lines = [
    sessionActive
      ? "Rule text an agent has already loaded stays until that agent starts again."
      : "Generated rule files are rebuilt when no agent session is running.",
  ];
  if (sharedIds.length) lines.unshift(`Shared copies of ${sharedIds.join(", ")} are separate and stay as the team left them.`);
  return lines;
}
