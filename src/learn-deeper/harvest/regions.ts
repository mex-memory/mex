import { command } from "../git.js";
import { sourceDigest } from "../source.js";
import { safePath, safeRaw, type Gaps } from "./evidence.js";
import type { Candidate, Region } from "./types.js";

export const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const CONTEXT = 15;
export const MAX_BLOB = 512 << 10;
const MAX_BLOB_READS = 96;
const MAX_REGION = 8 << 10;
const MAX_HUNK = 64 << 10;
const MAX_ANCHOR_LINES = 16;
const MAX_DIFF_LINES = 20_000;
const MAX_DIFF_GAP = 60;
const DIFF_CONTEXT = 3;
const lineContent = /[\p{L}\p{N}_]/u;
const normalize = (line: string) => line.replace(/\s+/gu, "");
const same = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => normalize(line) === normalize(b[i]!));
const splitLines = (text: string) => text === "" ? [] : text.replace(/\r\n/gu, "\n").replace(/\n$/u, "").split("\n");
export type ReadReviewedFile = (commit: string, path: string, headRepo?: string) => Promise<string | undefined>;

export class RegionReader {
  private readonly reads = new Map<string, Promise<string[] | undefined>>();
  private readonly commits = new Map<string, Promise<boolean>>();
  limitReached = false;
  constructor(readonly root: string, private readonly readRemote?: ReadReviewedFile) {}

  read(commit: string, path: string): Promise<string[] | undefined> {
    if (!oid.test(commit) || !safePath(path)) return Promise.resolve(undefined);
    const key = `${commit}:${path}`;
    let read = this.reads.get(key);
    if (!read) {
      if (this.reads.size >= MAX_BLOB_READS) {
        this.limitReached = true;
        return Promise.resolve(undefined);
      }
      read = command(this.root, "git", ["show", "--no-ext-diff", "--no-textconv", key], undefined, MAX_BLOB)
        .then(raw => raw === undefined || raw.includes("\0") ? undefined : splitLines(raw));
      this.reads.set(key, read);
    }
    return read;
  }

  async reviewed(commit: string, path: string, headRepo?: string): Promise<string[] | undefined> {
    const local = await this.read(commit, path);
    if (local !== undefined || !this.readRemote || this.limitReached || !oid.test(commit) || !safePath(path)) return local;
    let exists = this.commits.get(commit);
    if (!exists) {
      // cat-file -e is silent on success. A present object can still have a
      // missing, binary or oversized path. Only a missing object needs the forge.
      exists = command(this.root, "git", ["cat-file", "-e", commit]).then(output => output !== undefined);
      this.commits.set(commit, exists);
    }
    if (await exists) return undefined;
    const remote = await this.readRemote(commit, path, headRepo);
    return remote === undefined ? undefined : splitLines(remote);
  }
}

interface Span { lines: string[]; offset: number; first: number; last: number; context?: number; }

function cut(path: string, commit: string, span: Span, gaps: Gaps): Region | undefined {
  const context = span.context ?? CONTEXT;
  const from = Math.max(0, span.first - context), to = Math.min(span.lines.length, span.last + context);
  const text = span.lines.slice(from, to).join("\n");
  if (!text || Buffer.byteLength(text) > MAX_REGION) return undefined;
  if (safeRaw(text) !== text) { gaps.withheld(true); return undefined; }
  return { path, commit, start: span.offset + from + 1, end: span.offset + to, text, hash: sourceDigest(text) };
}

function hunkSide(hunk: string, side: string): { start: number; lines: string[] } | undefined {
  const [header, ...rows] = splitLines(hunk);
  const ranges = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(header ?? "");
  if (!ranges) return undefined;
  const start = Number(ranges[side === "LEFT" ? 1 : 2]);
  const lines: string[] = [];
  for (const row of rows) {
    if (row === "\\ No newline at end of file") continue;
    if (![" ", "-", "+"].includes(row[0] ?? "")) return undefined;
    if (row[0] !== (side === "LEFT" ? "+" : "-")) lines.push(row.slice(1));
  }
  return { start, lines };
}

/** One side of the recorded hunk. The end offset is exclusive. */
export function hunkSpan(hunk: string, side: string, first: number, last: number): Span | undefined {
  if ((side !== "LEFT" && side !== "RIGHT") || !Number.isSafeInteger(first) || !Number.isSafeInteger(last)
    || first < 1 || last < first || last - first >= MAX_ANCHOR_LINES) return undefined;
  const parsed = hunkSide(hunk, side);
  if (!parsed) return undefined;
  const { start, lines } = parsed;
  if (start < 1 || first < start || last >= start + lines.length) return undefined;
  return { lines, offset: start - 1, first: first - start, last: last - start + 1 };
}

function anchors(lines: string[], near: number, direction: -1 | 1): string[][] {
  const neighbors = direction === -1 ? lines.slice(Math.max(0, near - 8), near).reverse() : lines.slice(near, near + 8);
  const keys = neighbors.map(normalize);
  return [3, 2, 1].filter(size => size <= keys.length && keys.slice(0, size).some(key => lineContent.test(key)))
    .map(size => direction === -1 ? keys.slice(0, size).reverse() : keys.slice(0, size));
}

function hits(lines: string[], keys: string[]): number[] {
  const positions: number[] = [];
  for (let i = 0; i <= lines.length - keys.length; i++) {
    if (keys.every((key, offset) => key === lines[i + offset])) positions.push(i);
    if (positions.length > 32) return [];
  }
  return positions;
}

/** Match contiguous context on both sides. Never choose between equally supported locations. */
export function align(span: Span, lines: string[]): Span | undefined {
  const left = anchors(span.lines, span.first, -1), right = anchors(span.lines, span.last, 1);
  const keys = lines.map(normalize);
  const width = span.last - span.first;
  const at = (first: number, last: number): Span => ({ lines, offset: 0, first, last });
  for (const before of left) for (const after of right) {
    const starts = hits(keys, before).map(i => i + before.length);
    const ends = hits(keys, after);
    const pairs = starts.flatMap(first => ends.filter(last => last >= first && last - first <= width + 30)
      .map(last => at(first, last)));
    if (pairs.length === 1) return pairs[0];
    if (pairs.length > 1) return undefined;
  }
  // GitHub often ends the hunk at the comment. A single flank only proves
  // an unchanged anchor if the anchor also matches at that location.
  if (!width) return undefined;
  const anchor = span.lines.slice(span.first, span.last);
  for (const [side, options] of [[-1, left], [1, right]] as const) for (const context of options) {
    const adjacent = hits(keys, context).map(i => side === -1 ? i + context.length : i - width)
      .filter(first => first >= 0 && same(anchor, lines.slice(first, first + width)));
    if (adjacent.length === 1) return at(adjacent[0]!, adjacent[0]! + width);
    if (adjacent.length > 1) return undefined;
  }
}

interface LinePair { before: number; after: number; }

function uniquePositions(lines: string[]): Map<string, number> {
  const positions = new Map<string, number>();
  for (const [index, line] of lines.entries()) {
    // Structural lines can extend a match, but cannot establish one on their own.
    if (lineContent.test(line)) positions.set(line, positions.has(line) ? -1 : index);
  }
  return positions;
}

function orderedAnchors(before: string[], after: string[]): LinePair[] {
  const afterPositions = uniquePositions(after);
  const pairs: LinePair[] = [];
  for (const [line, left] of uniquePositions(before)) {
    const right = afterPositions.get(line);
    if (left >= 0 && right !== undefined && right >= 0) pairs.push({ before: left, after: right });
  }
  // Keep the lowest ending position for each run length so matches can't cross.
  const tails: number[] = [];
  const previous: number[] = [];
  for (const [index, pair] of pairs.entries()) {
    let low = 0, high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (pairs[tails[middle]!]!.after < pair.after) low = middle + 1;
      else high = middle;
    }
    previous[index] = tails[low - 1] ?? -1;
    tails[low] = index;
  }
  const anchors: LinePair[] = [];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]!) anchors.push(pairs[index]!);
  return anchors.reverse();
}

function mapSpan(span: Span, lines: string[]): Span | undefined {
  if (span.lines.length > MAX_DIFF_LINES || lines.length > MAX_DIFF_LINES) return align(span, lines);
  const before = span.lines.map(normalize), after = lines.map(normalize);
  const at = (first: number, last: number): Span => ({ lines, offset: 0, first, last, context: DIFF_CONTEXT });
  if (before.length === after.length && before.every((line, i) => line === after[i])) return at(span.first, span.last);

  const anchors = orderedAnchors(before, after);
  if (!anchors.length) return undefined;
  const mapped = new Int32Array(before.length).fill(-1);
  let left = 0, right = 0;
  // Extend into each gap from both ends without crossing another match.
  for (const anchor of [...anchors, { before: before.length, after: after.length }]) {
    while (left < anchor.before && right < anchor.after && before[left] === after[right]) mapped[left++] = right++;
    let i = anchor.before - 1, j = anchor.after - 1;
    while (i >= left && j >= right && before[i] === after[j]) mapped[i--] = j--;
    if (anchor.before < before.length) mapped[anchor.before] = anchor.after;
    left = anchor.before + 1;
    right = anchor.after + 1;
  }

  const { first, last } = span;
  const start = mapped[first] ?? -1;
  if (first < last && start >= 0 && mapped.subarray(first, last).every((line, i) => line === start + i)) {
    return at(start, start + last - first);
  }

  let above = first - 1, below = last;
  while (above >= 0 && first - above <= MAX_DIFF_GAP && mapped[above] === -1) above--;
  while (below < before.length && below - last < MAX_DIFF_GAP && mapped[below] === -1) below++;
  if (first - above > MAX_DIFF_GAP || below - last >= MAX_DIFF_GAP) return undefined;
  // A range touching a file boundary can use that edge as one flank.
  if ((above < 0 && first !== 0) || (below === before.length && last !== before.length)
    || (above < 0 && below === before.length)) return undefined;
  const from = above < 0 ? -1 : mapped[above]!;
  const to = below === before.length ? after.length : mapped[below]!;
  if (to - from <= MAX_DIFF_GAP) return at(from + 1, to);
}

export interface ReviewLocation {
  path: string; side: string; first: number; last: number; hunk: string; original: string;
  merge?: string; head: string; changedPaths: string[]; headRepo?: string;
}

export async function reviewRegions(where: ReviewLocation, reader: RegionReader, gaps: Gaps):
Promise<{ code?: Candidate["code"]; actedOn: boolean; withheld?: boolean }> {
  const { path, side, hunk, first, last, merge, head } = where;
  if (safeRaw(hunk) !== hunk) { gaps.withheld(true); return { actedOn: false, withheld: true }; }
  if (Buffer.byteLength(hunk) > MAX_HUNK) {
    gaps.messages.add("Some review hunks exceeded the size limit.");
    return { actedOn: false };
  }
  const hunkCode = hunkSpan(hunk, side, first, last);
  if (!hunkCode || !oid.test(where.original)) return { actedOn: false };
  let original = where.original;
  if (side === "LEFT") {
    const base = merge && oid.test(merge) ? (await command(reader.root, "git", ["merge-base", original, merge + "^"]))?.trim() : undefined;
    if (!base || !oid.test(base)) {
      gaps.messages.add("Some left-side review bases could not be recovered.");
      return { actedOn: false };
    }
    original = base;
  }
  let span = hunkCode;
  const blob = side === "RIGHT" ? await reader.reviewed(original, path, where.headRepo) : await reader.read(original, path);
  if (blob && same(hunkCode.lines, blob.slice(hunkCode.offset, hunkCode.offset + hunkCode.lines.length))) {
    span = { lines: blob, offset: 0, first: first - 1, last };
  } else if (side === "LEFT") {
    gaps.messages.add("Some left-side review bases did not match the recorded hunk.");
    return { actedOn: false };
  }
  const before = cut(path, original, span, gaps);
  if (!before) return { actedOn: false };
  const anchorLines = span.lines.slice(span.first, span.last);
  const anchor = anchorLines.join("\n");
  const code: NonNullable<Candidate["code"]> = { before, anchor };
  let context = span;
  if (side === "RIGHT" && merge && oid.test(merge) && span === hunkCode && span.last === span.lines.length) {
    // GitHub can end a hunk at the anchor. When the reviewed commit is
    // absent locally, the matching left side can supply the next context.
    const left = hunkSide(hunk, "LEFT"), parent = left && left.start > 0 && left.lines.length >= 2
      ? (await command(reader.root, "git", ["rev-parse", "--verify", merge + "^"]))?.trim() : undefined;
    const base = parent && await reader.read(parent, path);
    const end = left ? left.start - 1 + left.lines.length : 0;
    if (base && left && same(left.lines, base.slice(left.start - 1, end))) context = { ...span, lines: [...span.lines, ...base.slice(end, end + 3)] };
  }
  let afterSpan: Span | undefined;
  let afterPath = path;
  if (merge) {
    const merged = await reader.read(merge, path);
    if (merged) afterSpan = span === hunkCode ? align(context, merged) : mapSpan(span, merged);
    else {
      // A short mapped interval alone doesn't establish which changed path is a rename.
      const matches: Array<{ path: string; span: Span }> = [];
      for (const renamed of where.changedPaths.filter(changed => changed !== path).slice(0, 12)) {
        const revised = await reader.read(merge, renamed);
        const match = revised && align(context, revised);
        if (match) matches.push({ path: renamed, span: match });
      }
      if (matches.length === 1) ({ path: afterPath, span: afterSpan } = matches[0]!);
    }
    if (afterSpan) code.after = cut(afterPath, merge, afterSpan, gaps);
    else gaps.messages.add(merged ? "Some merged review anchors could not be located uniquely."
      : "Some merged review files were unavailable and had no unique rename.");
  } else gaps.messages.add("Some reviews had no readable merge commit.");

  if (head === merge) {
    if (code.after) code.head = code.after;
  } else if (afterSpan) {
    const current = await reader.read(head, afterPath);
    const location = current && mapSpan(afterSpan, current);
    if (location) code.head = cut(afterPath, head, location, gaps);
  }
  // Insertions beside the anchor can widen the bracket without changing any
  // of the reviewed lines. Credit only the removal or replacement of those lines.
  const afterLines = afterSpan?.lines.slice(afterSpan.first, afterSpan.last);
  const actedOn = !!code.after && !!afterLines
    && !afterLines.some((_, i) => same(anchorLines, afterLines.slice(i, i + anchorLines.length)));
  return { code, actedOn };
}

/** A zero-context git hunk supplies independent positions on both sides. */
export async function commitRegions(reader: RegionReader, path: string, from: string, to: string, gaps: Gaps):
Promise<{ before?: Region; after?: Region; anchor?: string }> {
  if (!oid.test(from) || !oid.test(to) || !safePath(path)) return {};
  const diff = await command(reader.root, "git", ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv",
    "--no-color", "--no-renames", "-U0", from, to, "--", path], undefined, MAX_HUNK);
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/mu.exec(diff ?? "");
  if (!match) return {};
  const result: { before?: Region; after?: Region; anchor?: string } = {};
  for (const [name, commit, index] of [["before", from, 1], ["after", to, 3]] as const) {
    const lines = await reader.read(commit, path);
    if (!lines) continue;
    const count = Number(match[index + 1] ?? "1");
    const first = Number(match[index]) - (count ? 1 : 0);
    const last = Math.min(first + count, first + MAX_ANCHOR_LINES);
    const region = cut(path, commit, { lines, offset: 0, first, last }, gaps);
    if (region) {
      result[name] = region;
      if (name === "before" && count) result.anchor = lines.slice(first, last).join("\n");
    }
  }
  return result;
}
