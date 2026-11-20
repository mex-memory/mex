import type { KnowledgeEntry } from "./entry.js";

export const KNOWLEDGE_PRIORITY = ["current-request", "personal", "repo-instructions", "team", "hint"] as const;
export type KnowledgeLevel = "personal" | "team" | "hint";
export function statementDate(entry: KnowledgeEntry): string {
  const date = /^(?:capture|mex edit|mex note by \S+) (\d{4}-\d{2}-\d{2})(?: |$)/u.exec(entry.mex.source.ref)?.[1];
  return date && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date ? date : entry.mex.created;
}
export function entryLabel(entry: KnowledgeEntry, level: KnowledgeLevel, observations = 1): string {
  if ((entry.mex.evidence === "mined" || entry.mex.evidence === "observed") && entry.mex.source.label) return `[${entry.mex.source.label}]`;
  if (level === "hint") return observations === 1 ? "[hint, seen once]" : `[hint, seen ${observations} times]`;
  if (level === "team") return `[team, from ${entry.mex.evidence === "ci" ? "CI" : entry.mex.evidence === "person" ? "a person" : entry.mex.evidence}]`;
  if (entry.mex.source.type === "config") return `[repo, from ${entry.mex.source.ref}]`;
  if (/^mx_deep[a-f0-9]{32}$/u.test(entry.mex.id) && ["review", "docs", "person"].includes(entry.mex.source.type)) return "[learned, not shared]";
  if (entry.mex.source.type !== "person") return `[personal, from ${entry.mex.evidence}]`;
  const date = statementDate(entry);
  const day = Number(date.slice(8, 10));
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(date.slice(5, 7)) - 1];
  const by = savedByAgent(entry);
  return by ? `[${by} noted, ${day} ${month}]` : `[you said, ${day} ${month}]`;
}

const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };
/** The agent that saved a person-sourced note with `mex note`, if one did. */
export function savedByAgent(entry: KnowledgeEntry): string | undefined {
  const by = /^mex note by (\S+) \d{4}-\d{2}-\d{2}$/u.exec(entry.mex.source.ref)?.[1];
  return by ? AGENT_NAMES[by] ?? by : undefined;
}
