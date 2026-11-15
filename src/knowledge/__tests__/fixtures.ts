import type { KnowledgeEntry } from "../entry.js";

/** A valid person-sourced entry for tests; override any field. */
export function entry(id: string, over: Partial<KnowledgeEntry["mex"]> = {}, text = "Use date-fns, because moment is unmaintained."): KnowledgeEntry {
  return {
    mex: { id, kind: "rule", scope: ["**"], source: { type: "person", ref: "mex note 2026-11-15", quote: text }, evidence: "person", one_line: text, checks: [], status: "active", created: "2026-11-15", ...over },
    text,
  };
}
