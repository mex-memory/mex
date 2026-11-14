import type { KnowledgeEntry } from "./entry.js";

export const KNOWLEDGE_PRIORITY = ["current-request", "personal", "repo-instructions", "team", "hint"] as const;
export type KnowledgeLevel = "personal" | "team" | "hint";
export function entryLabel(entry: KnowledgeEntry, level: KnowledgeLevel, observations = 1): string {
  if (level === "hint") return observations === 1 ? "[hint, seen once]" : `[hint, seen ${observations} times]`;
  if (level === "team") return `[team, from ${entry.mex.evidence === "ci" ? "CI" : entry.mex.evidence === "person" ? "a person" : entry.mex.evidence}]`;
  if (entry.mex.source.type !== "person") return `[personal, from ${entry.mex.evidence}]`;
  const day = Number(entry.mex.created.slice(8, 10));
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(entry.mex.created.slice(5, 7)) - 1];
  return `[you said, ${day} ${month}]`;
}
