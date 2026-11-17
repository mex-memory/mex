/**
 * Line shifts: how the hook keeps outlines exact between an edit and the
 * re-parse, without a parser. After an edit the Go hook writes one small file:
 *
 *   <index>/shifts/<checkout key>/<path key>/<mtime_ns, 20 digits>-<pid>-<n>.json
 *   {"path":"src/a.ts","mtime_ns":"…","ranges":[{"from":10,"to":12,"delta":3}]}
 *
 * `ranges` are in the file's line numbers before that edit: lines from..to
 * changed (to = from - 1 for a pure insertion) and the file gained `delta`
 * lines there. `"unknown": true` means the hook couldn't place the edit; the
 * file reads as "changed since the last parse" until it is re-parsed.
 *
 * A shift applies while its mtime is newer than the mtime the snapshot parsed.
 * Files are written once and never changed; the indexer deletes stale ones.
 * The same rules are in native/index/shifts.go.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shortHash } from "../record/project.js";
import type { OutlineItem } from "./types.js";

/**
 * One changed block: lines from..to changed (to = from - 1 for a pure
 * insertion) and the file gained `delta` lines there. `nest` means the change
 * opens or closes blocks (or, in Python, is code at all), so a symbol around
 * it may now end elsewhere.
 */
export interface ShiftRange { from: number; to: number; delta: number; nest?: boolean }
export interface Shift { path: string; mtime_ns: string; ranges: ShiftRange[]; unknown?: boolean }

export function shiftDirectory(indexDirectory: string, checkoutKey: string, path: string): string {
  return join(indexDirectory, "shifts", checkoutKey, shortHash(path));
}

/** Path keys that have shift files at all, so a scan over many paths checks only those. */
export function shiftedPathKeys(indexDirectory: string, checkoutKey: string): Set<string> {
  try { return new Set(readdirSync(join(indexDirectory, "shifts", checkoutKey))); } catch { return new Set(); }
}

/** Shifts for one path that are newer than `parsedMtimeNs`, oldest first. */
export function pendingShifts(indexDirectory: string, checkoutKey: string, path: string, parsedMtimeNs: string): Shift[] {
  const directory = shiftDirectory(indexDirectory, checkoutKey, path);
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const parsed = BigInt(parsedMtimeNs || "0");
  const shifts: Shift[] = [];
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    try {
      const shift = JSON.parse(readFileSync(join(directory, name), "utf8")) as Shift;
      if (shift.path === path && BigInt(shift.mtime_ns) > parsed) shifts.push(shift);
    } catch { /* half-written or broken: the next one still applies */ }
  }
  return shifts;
}

/** Map one line through an edit's ranges, or undefined when the line itself changed. */
export function mapLine(line: number, ranges: readonly ShiftRange[]): number | undefined {
  let moved = line;
  for (const range of ranges) {
    if (line >= range.from && line <= range.to) return undefined;
    if (range.to < line) moved += range.delta;
  }
  return moved;
}

/**
 * Move a symbol's span through one edit, or undefined when the edit may have
 * changed it: a changed line is its first or last line, or the change alters
 * structure (`nest`) and the symbol holds it or sits right next to it (a
 * decorator added above, a continuation line added below).
 */
export function mapSpan(start: number, end: number, ranges: readonly ShiftRange[]): [number, number] | undefined {
  for (const { from, to, nest } of ranges) {
    if ((start >= from && start <= to) || (end >= from && end <= to)) return undefined;
    if (nest && start <= to + 1 && end >= from - 1) return undefined;
  }
  const from = mapLine(start, ranges), to = mapLine(end, ranges);
  return from === undefined || to === undefined ? undefined : [from, to];
}

/** A span through several edits in order. */
export function shiftSpan(start: number, end: number, shifts: readonly Shift[]): [number, number] | undefined {
  let span: [number, number] | undefined = [start, end];
  for (const shift of shifts) {
    span = mapSpan(span[0], span[1], shift.ranges);
    if (!span) return undefined;
  }
  return span;
}

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;
const CONTINUES_FROM_ABOVE =/^\s*([|&.+\-*/?:,=)\]}]|=>)/;
const CONTINUES_BELOW = /([=+\-*/|&?:,([{]|=>)\s*$/;

/**
 * Whether a change's removed or added lines may alter structure: they open or
 * close blocks, add or remove a decorator or attribute, or continue the
 * statement above or below (a new `| 'x'` member of a union type). Python's
 * structure is indentation, so any code change there counts. The hook decides
 * this; native/index/edit.go has the same rule.
 */
export function changesNesting(lang: string, removed: readonly string[], added: readonly string[]): boolean {
  if (lang === "py") return [...removed, ...added].some((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  for (const lines of [removed, added]) {
    const code = lines.filter((line) => line.trim() !== "" && !COMMENT_LINE.test(line));
    if (code.length === 0) continue;
    if (code.some((line) => /^\s*(@|#\[)/.test(line) || (lang === "cs" && /^\s*\[/.test(line)))) return true;
    if (CONTINUES_FROM_ABOVE.test(code[0]!) || CONTINUES_BELOW.test(code[code.length - 1]!)) return true;
    if (!balanced(lines.join("\n"))) return true;
  }
  return false;
}

function balanced(text: string): boolean {
  const depth: Record<string, number> = { "{": 0, "(": 0, "[": 0 };
  const open: Record<string, string> = { "}": "{", ")": "(", "]": "[" };
  for (const char of text) {
    if (char in depth) depth[char]!++;
    else if (char in open && --depth[open[char]!]! < 0) return false;
  }
  return depth["{"] === 0 && depth["("] === 0 && depth["["] === 0;
}

/**
 * Apply shifts to an outline. Symbols whose first or last line was edited are
 * dropped until the re-parse; every other span is moved exactly. Returns
 * undefined when a shift is unknown. `kept` gives each result's index in the input.
 */
export function applyShifts(outline: readonly OutlineItem[], shifts: readonly Shift[]): { outline: OutlineItem[]; dropped: number; kept: number[] } | undefined {
  if (shifts.some((shift) => shift.unknown)) return undefined;
  if (shifts.length === 0) return { outline: outline.map((item) => ({ ...item })), dropped: 0, kept: outline.map((_, index) => index) };
  const kept: Array<OutlineItem | undefined> = outline.map((item) => {
    const span = shiftSpan(item.start, item.end, shifts);
    return span ? { ...item, start: span[0], end: span[1] } : undefined;
  });
  const position = new Map<number, number>();
  const result: OutlineItem[] = [];
  const keptIndexes: number[] = [];
  kept.forEach((item, index) => {
    if (!item) return;
    let parent = outline[index]!.parent;
    while (parent !== undefined && !kept[parent]) parent = outline[parent]!.parent;
    const copy: OutlineItem = { name: item.name, kind: item.kind, start: item.start, end: item.end };
    if (parent !== undefined) copy.parent = position.get(parent)!;
    position.set(index, result.length);
    result.push(copy);
    keptIndexes.push(index);
  });
  return { outline: result, dropped: outline.length - result.length, kept: keptIndexes };
}

let written = 0;
/** Write one shift. Go's hook is the normal writer; this exists for the Node fallback and tests. */
export function writeShift(indexDirectory: string, checkoutKey: string, shift: Shift): void {
  const directory = shiftDirectory(indexDirectory, checkoutKey, shift.path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = `${shift.mtime_ns.padStart(20, "0")}-${process.pid}-${written++}.json`;
  // A new name each time, completed through a rename, so readers never see half a file.
  writeFileSync(join(directory, `${name}.tmp`), JSON.stringify(shift), { mode: 0o600 });
  renameSync(join(directory, `${name}.tmp`), join(directory, name));
}

/**
 * Delete shifts the snapshot already includes: older than the mtime it parsed,
 * or written before this refresh began (it read the file after that edit),
 * and those for paths it no longer has.
 */
export function removeStaleShifts(indexDirectory: string, checkoutKey: string, parsedMtime: ReadonlyMap<string, string>, startedAtMs = 0): number {
  const root = join(indexDirectory, "shifts", checkoutKey);
  let removed = 0;
  let directories: string[];
  try { directories = readdirSync(root); } catch { return 0; }
  const byKey = new Map([...parsedMtime].map(([path, mtime]) => [shortHash(path), mtime]));
  for (const key of directories) {
    const directory = join(root, key);
    const parsed = byKey.get(key);
    let names: string[] = [];
    try { names = readdirSync(directory); } catch { continue; }
    for (const name of names) {
      const mtime = name.split("-")[0] ?? "0";
      let writtenBefore = false;
      try { writtenBefore = statSync(join(directory, name)).mtimeMs < startedAtMs - 1000; } catch { /* gone */ }
      if (parsed === undefined || !/^\d+$/.test(mtime) || BigInt(mtime) <= BigInt(parsed) || writtenBefore) {
        try { unlinkSync(join(directory, name)); removed++; } catch { /* in use; next time */ }
      }
    }
    try { rmdirSync(directory); } catch { /* not empty */ }
  }
  return removed;
}
