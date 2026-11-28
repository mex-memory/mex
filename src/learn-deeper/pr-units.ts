import type { Candidate, DiscussionLine } from "./harvest/types.js";

export const TRIAGE_LIMIT = 60_000;
const TRIAGE_TEXT_BUDGET = TRIAGE_LIMIT - 4_000;
export const maintainerLine = (line: Pick<DiscussionLine, "role">) => line.role.startsWith("maintainer");

interface UnitLine { candidate?: string; kind?: Candidate["kind"]; line: DiscussionLine }
export interface PRUnit { header: string; lines: UnitLine[] }
export interface TriageLine extends UnitLine { id: string }

const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();
const clip = (text: string, limit: number) => text.length > limit ? text.slice(0, limit).trimEnd() : text;

export function prUnits(candidates: readonly Candidate[]): PRUnit[] {
  const descriptions = new Set(candidates.filter(item => item.kind === "pr-text").map(item => item.pull));
  const units = new Map<string, { header: string; lines: Map<string, UnitLine> }>();
  for (const candidate of candidates) {
    if (candidate.kind === "doc") continue;
    const { pull, title, prText, prState, changedPaths } = candidate;
    const group = pull && (prState !== undefined || ["conversation", "review-summary", "review-thread", "pr-text", "closed-pr"].includes(candidate.kind));
    const key = group ? "pull:" + pull : candidate.id;
    let unit = units.get(key);
    if (!unit) {
      const heading = "=== " + (group ? "PR #" + pull + " (" + (prState ?? (candidate.kind === "closed-pr" ? "closed" : "merged")) + ")" : candidate.kind)
        + (title ? " " + clip(oneLine(title), 256) : "");
      const files = changedPaths?.slice(0, 15).map(path => clip(path, 256)).join(", ");
      const extra = (changedPaths?.length ?? 0) - 15;
      unit = { header: [heading, ...(files ? ["Files: " + files + (extra > 0 ? " (+" + extra + " more)" : "")] : []),
        ...(prText && !descriptions.has(pull) ? ["Description: " + clip(oneLine(prText), 600)] : [])].join("\n"), lines: new Map() };
      units.set(key, unit);
    }
    const lines = candidate.lines ?? [{ id: candidate.id, at: candidate.at, role: "maintainer" as const, text: candidate.text, path: candidate.path }];
    for (const line of lines) {
      const text = clip(line.text, maintainerLine(line) ? 1800 : line.role === "PR author" ? 400 : 200);
      if (text && !unit.lines.has(line.id)) unit.lines.set(line.id, { candidate: candidate.id, kind: candidate.kind, line: { ...line, text } });
    }
    for (const line of candidate.context ?? []) {
      const text = clip(line.text, line.role === "PR author" ? 400 : 200);
      if (text && !unit.lines.has(line.id)) unit.lines.set(line.id, { line: { ...line, text } });
    }
  }
  return [...units.values()].filter(unit => [...unit.lines.values()].some(item => item.candidate && maintainerLine(item.line)))
    .map(({ header, lines }) => ({ header, lines: [...lines.values()].sort((a, b) => a.line.at.localeCompare(b.line.at)) }));
}

export function renderUnits(units: readonly PRUnit[]) {
  const lines = new Map<string, TriageLine>();
  const text = units.map(unit => [unit.header, ...unit.lines.map(item => {
    const id = "i" + (lines.size + 1);
    lines.set(id, { ...item, id });
    const { line, kind } = item;
    const where = [kind === "review-summary" ? "review summary" : undefined, line.path].filter(Boolean).join(", ");
    return "[" + id + "] " + line.role + (where ? " (" + where + ")" : "") + ": " + line.text.replace(/\r?\n/gu, "\n    ")
      + (line.hunk ? "\n    Code: " + line.hunk.replace(/\r?\n/gu, "\n    ") : "");
  })].join("\n")).join("\n\n");
  return { text, lines };
}

export function packUnits(units: readonly PRUnit[]): PRUnit[][] {
  const batches: PRUnit[][] = [];
  let batch: PRUnit[] = [], size = 0;
  const flush = () => {
    if (batch.length) batches.push(batch);
    batch = [];
    size = 0;
  };
  for (const unit of units) {
    const parts: PRUnit[] = [];
    let part: PRUnit = { header: unit.header, lines: [] }, partSize = unit.header.length;
    for (const line of unit.lines) {
      // Ids are longer in a packed batch than they are in this one-line sample.
      const lineSize = renderUnits([{ header: "", lines: [line] }]).text.length + 8;
      if (part.lines.length && partSize + lineSize > TRIAGE_TEXT_BUDGET) {
        parts.push(part);
        part = { header: unit.header, lines: [] };
        partSize = unit.header.length;
      }
      part.lines.push(line);
      partSize += lineSize;
    }
    if (part.lines.length) parts.push(part);
    for (const fragment of parts) {
      if (!fragment.lines.some(item => item.candidate && maintainerLine(item.line))) continue;
      const length = renderUnits([fragment]).text.length + fragment.lines.length * 6 + 2;
      if (size + length > TRIAGE_TEXT_BUDGET) flush();
      batch.push(fragment);
      size += length;
    }
  }
  flush();
  return batches;
}
