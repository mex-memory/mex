/**
 * Replaying edits against the file index: parse a file, move its outline
 * through an edit's line shifts, parse the edited file, and check every span
 * that was kept against the fresh parse. Used by the tests and by the replay
 * of recorded agent edits and git history.
 */
import { recordFor } from "./batch.js";
import { applyShifts, changesNesting, type ShiftRange } from "./shifts.js";

/**
 * Ranges from Claude Code's Edit/Write response (`structuredPatch`), the same
 * as RangesFromStructuredPatch in native/index/edit.go. `lang` decides the
 * nesting rule (see changesNesting).
 */
export function rangesFromStructuredPatch(patch: ReadonlyArray<{ oldStart: number; lines: readonly string[] }>, lang = "other"): ShiftRange[] {
  const ranges: ShiftRange[] = [];
  for (const hunk of patch) {
    let line = hunk.oldStart, from = 0;
    let removed: string[] = [], added: string[] = [];
    const flush = () => {
      if (removed.length > 0 || added.length > 0) {
        const range: ShiftRange = { from, to: from + removed.length - 1, delta: added.length - removed.length };
        if (changesNesting(lang, removed, added)) range.nest = true;
        ranges.push(range);
      }
      removed = []; added = [];
    };
    for (const text of hunk.lines) {
      const mark = text[0];
      if (mark === "-") { if (removed.length === 0 && added.length === 0) from = line; removed.push(text.slice(1)); line++; }
      else if (mark === "+") { if (removed.length === 0 && added.length === 0) from = line; added.push(text.slice(1)); }
      else if (mark === "\\") { /* "\ No newline at end of file" */ }
      else { flush(); line++; }
    }
    flush();
  }
  return ranges.sort((a, b) => a.from - b.from);
}

/** Ranges from `git diff -U0`: hunk headers `@@ -a,b +c,d @@` and their lines. */
export function rangesFromUnifiedDiff(diff: string, lang = "other"): ShiftRange[] {
  const ranges: ShiftRange[] = [];
  const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
  let current: { range: ShiftRange; removed: string[]; added: string[] } | undefined;
  const finish = () => {
    if (!current) return;
    if (changesNesting(lang, current.removed, current.added)) current.range.nest = true;
    ranges.push(current.range);
    current = undefined;
  };
  for (const line of diff.split("\n")) {
    const match = header.exec(line);
    if (match) {
      finish();
      const start = Number(match[1]), removed = match[2] === undefined ? 1 : Number(match[2]), added = match[3] === undefined ? 1 : Number(match[3]);
      // With nothing removed, git numbers the line *before* the insertion.
      const from = removed === 0 ? start + 1 : start;
      current = { range: { from, to: from + removed - 1, delta: added - removed }, removed: [], added: [] };
    } else if (current && line.startsWith("-") && !line.startsWith("---")) current.removed.push(line.slice(1));
    else if (current && line.startsWith("+") && !line.startsWith("+++")) current.added.push(line.slice(1));
  }
  finish();
  return ranges.sort((a, b) => a.from - b.from);
}

export interface ReplayResult {
  /** Symbols in the old outline. */
  symbols: number;
  /** Kept through the shift and compared with the fresh parse. */
  compared: number;
  /** Left out because the edit touched their first or last line. */
  dropped: number;
  /** Kept symbols whose shifted span differs from the fresh parse (must be none). */
  mismatches: Array<{ name: string; kind: string; shifted: [number, number]; parsed: [number, number] | undefined }>;
  /** True when either side didn't parse; nothing is compared then. */
  skipped: boolean;
}

export async function replayEdit(path: string, before: string, after: string, ranges: readonly ShiftRange[]): Promise<ReplayResult> {
  const result: ReplayResult = { symbols: 0, compared: 0, dropped: 0, mismatches: [], skipped: false };
  const old = await recordFor(path, before);
  const fresh = await recordFor(path, after);
  if (!old || !fresh || old.parse_error || fresh.parse_error) return { ...result, skipped: true };
  result.symbols = old.outline.length;
  const shifted = applyShifts(old.outline, [{ path, mtime_ns: "1", ranges: [...ranges] }]);
  if (!shifted) return { ...result, skipped: true };
  result.dropped = shifted.dropped;
  // Every span the index reports must be a real span in the fresh parse: a
  // symbol of the same kind and name starting on that line and ending on the
  // same line. (Matching by position also survives a renamed parent.)
  const fresh_ = new Map<string, number[]>();
  for (const item of fresh.outline) {
    const key = `${item.kind}:${item.name}:${item.start}`;
    fresh_.set(key, [...(fresh_.get(key) ?? []), item.end]);
  }
  for (const item of shifted.outline) {
    result.compared++;
    const ends = fresh_.get(`${item.kind}:${item.name}:${item.start}`) ?? [];
    if (!ends.includes(item.end)) {
      const nearest = fresh.outline.filter((other) => other.kind === item.kind && other.name === item.name)
        .sort((a, b) => Math.abs(a.start - item.start) - Math.abs(b.start - item.start))[0];
      result.mismatches.push({ name: item.name, kind: item.kind, shifted: [item.start, item.end], parsed: nearest ? [nearest.start, nearest.end] : undefined });
    }
  }
  return result;
}
