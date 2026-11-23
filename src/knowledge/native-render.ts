/**
 * Each agent's own rule file, rendered from entries. Every file starts with
 * the generated marker, so MEX never reads it back as a source, and each item
 * carries its entry id as an HTML comment.
 */
import type { Candidate } from "./native-select.js";
import { GENERATED_MARK } from "./rule-files.js";

export const GENERATED_LINE = `${GENERATED_MARK} by MEX from its entries; edit the entries, not this file -->`;
/** Under every title: these are notes about the code, and the code wins when they disagree. */
export const PRECEDENCE_LINE = "Existing code takes precedence over these notes.";

/**
 * Size caps, in bytes. Codex reads at most 32 KiB of AGENTS.md along a path, so one generated file takes a quarter.
 * Copilot publishes no cap for path-scoped instructions; they share its context with AGENTS.md, so they take Claude's.
 */
export const CAPS = { "claude-rules": 6 * 1024, "codex-agents": 8 * 1024, "copilot-instructions": 6 * 1024 } as const;
export type NativeFormat = keyof typeof CAPS;

const EVIDENCE_ORDER = ["person", "ci", "docs", "review", "mined", "observed"];

/** Strongest first, so a cap drops the weakest. */
export function byStrength(a: Candidate, b: Candidate): number {
  return EVIDENCE_ORDER.indexOf(a.entry.mex.evidence) - EVIDENCE_ORDER.indexOf(b.entry.mex.evidence)
    || a.entry.mex.id.localeCompare(b.entry.mex.id);
}

function item(c: Candidate): string {
  return `- ${c.entry.text.replace(/\s+/gu, " ").trim()} <!-- mex:${c.entry.mex.id} -->`;
}

function frame(format: NativeFormat, area: string): { head: string; tail: string } {
  const title = `${area ? `# MEX rules for ${area}` : "# MEX rules"}\n\n${PRECEDENCE_LINE}\nReport a wrong rule with \`mex wrong <id> "<reason>"\`.`;
  if (format === "claude-rules" && area) {
    return { head: `---\npaths:\n  - "${area}/**"\n---\n${GENERATED_LINE}\n${title}\n\n`, tail: "" };
  }
  if (format === "copilot-instructions") {
    // Copilot's path-scoped format: applyTo is a glob from the repository root.
    return { head: `---\napplyTo: "${area ? `${area}/**` : "**"}"\n---\n${GENERATED_LINE}\n${title}\n\n`, tail: "" };
  }
  return { head: `${GENERATED_LINE}\n${title}\n\n`, tail: "" };
}

export interface Rendered { text: string; ids: string[]; dropped: string[]; }

/** Render one file, dropping the weakest items that don't fit the format's cap. */
export function renderNative(format: NativeFormat, area: string, candidates: Candidate[]): Rendered {
  const { head, tail } = frame(format, area);
  const ordered = [...candidates].sort(byStrength);
  const lines: string[] = [], ids: string[] = [], dropped: string[] = [];
  let bytes = Buffer.byteLength(head + tail);
  for (const c of ordered) {
    const line = `${item(c)}\n`;
    const size = Buffer.byteLength(line);
    if (bytes + size > CAPS[format]) { dropped.push(c.entry.mex.id); continue; }
    bytes += size;
    lines.push(line);
    ids.push(c.entry.mex.id);
  }
  return { text: head + lines.join("") + tail, ids, dropped };
}
