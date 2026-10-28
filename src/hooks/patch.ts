/** Bounded apply_patch evidence. Patch text is parsed, never executed. */
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { shellRelative } from "./shell.js";
import type { FileDiff } from "../context/hook/diff.js";

export interface PatchChunk { before: string[]; after: string[] }
export interface PatchFile {
  file: string;
  kind: "update" | "add" | "delete";
  moveTo?: string;
  chunks: PatchChunk[];
}
const MAX_PATCH_BYTES = 256 * 1024;
const MAX_FILES = 200;

/** Reject an incomplete/oversized patch rather than attributing a partial parse. */
export function parseApplyPatch(command: string, root: string, cwd = root): PatchFile[] {
  if (Buffer.byteLength(command) > MAX_PATCH_BYTES) return [];
  const lines = command.replace(/\r\n/g, "\n").trimEnd().split("\n");
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") return [];
  const out: PatchFile[] = [];
  let current: PatchFile | null = null;
  let chunk: PatchChunk | null = null;
  const pathOf = (path: string) => {
    const file = shellRelative(root, isAbsolute(path) ? path : resolve(cwd, path));
    return file !== null && /^\.mex(?:\/|$)/i.test(file) ? null : file;
  };
  for (const line of lines.slice(1, -1)) {
    const header = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (header) {
      if (out.length >= MAX_FILES) return [];
      const file = pathOf(header[2]!);
      current = file === null ? null : { file, kind: header[1]!.toLowerCase() as PatchFile["kind"], chunks: [] };
      if (current) out.push(current);
      chunk = null;
      continue;
    }
    if (line.startsWith("*** Move to: ")) {
      if (current) {
        const target = pathOf(line.slice(13));
        // An escaping move is not evidence for an in-project update.
        if (target === null) { out.splice(out.indexOf(current), 1); current = null; }
        else current.moveTo = target;
      }
      continue;
    }
    if (!current) continue;
    if (line === "@@" || line.startsWith("@@ ")) {
      chunk = { before: [], after: [] }; current.chunks.push(chunk); continue;
    }
    if (line === "*** End of File") continue;
    if (!chunk && current.kind === "add") { chunk = { before: [], after: [] }; current.chunks.push(chunk); }
    if (!chunk) return [];
    if (line.startsWith(" ")) { chunk.before.push(line.slice(1)); chunk.after.push(line.slice(1)); }
    else if (line.startsWith("-")) chunk.before.push(line.slice(1));
    else if (line.startsWith("+")) chunk.after.push(line.slice(1));
    else return [];
  }
  return out;
}

export const patchedFiles = (patch: readonly PatchFile[]): string[] => [...new Set(patch.flatMap(p => [p.file, ...(p.moveTo ? [p.moveTo] : [])]))];

/** Exact line correspondence, with a hard work ceiling and common edges removed first. */
function correspondence(base: string[], before: string[]): Map<number, number> | null {
  const map = new Map<number, number>();
  let prefix = 0;
  while (prefix < base.length && prefix < before.length && base[prefix] === before[prefix]) { map.set(prefix, prefix); prefix++; }
  let a = base.length, b = before.length;
  while (a > prefix && b > prefix && base[a - 1] === before[b - 1]) { map.set(--b, --a); }
  const n = a - prefix, m = b - prefix;
  if ((n + 1) * (m + 1) > 1_000_000) return null;
  const rows = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    rows[i]![j] = base[prefix + i] === before[prefix + j] ? rows[i + 1]![j + 1]! + 1 : Math.max(rows[i + 1]![j]!, rows[i]![j + 1]!);
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (base[prefix + i] === before[prefix + j]) { map.set(prefix + j++, prefix + i++); }
    else if (rows[i + 1]![j]! > rows[i]![j + 1]!) i++;
    else j++;
  }
  return map;
}

/**
 * Recover the pre-patch file from unique postimage contexts, then map only the
 * patch's changed lines to HEAD. This excludes older dirty lines even when Git
 * coalesces them into the same hunk. Ambiguous contexts/work overflow abstain.
 */
export function attributePatch(file: PatchFile, source: string, diff: FileDiff): FileDiff | null {
  if (file.kind === "delete" || file.moveTo) return diff;
  if (file.kind === "add" || !diff.chunks) return null;
  const post = source.replace(/\r\n/g, "\n").split("\n");
  if (post.at(-1) === "") post.pop();
  if (post.length > 50_000) return null;
  const base = [...post];
  for (const chunk of [...diff.chunks].reverse()) base.splice(chunk.newStart, chunk.newLines.length, ...chunk.oldLines);
  const located: Array<{ at: number; chunk: PatchChunk }> = [];
  const deletions: Array<[number, number]> = [];
  let end = 0, comparisons = 0;
  for (const chunk of file.chunks) {
    if (!chunk.after.length) {
      // A context-free removal has no postimage. Its own '-' lines can still
      // prove a unique HEAD location; unseen-hunk filtering is applied later.
      if (!chunk.before.length) continue;
      let found = -1;
      for (let at = 0; at + chunk.before.length <= base.length; at++) {
        let matches = true;
        for (let k = 0; k < chunk.before.length; k++) {
          if (++comparisons > 1_000_000) return null;
          if (base[at + k] !== chunk.before[k]) { matches = false; break; }
        }
        if (matches) { if (found !== -1) return null; found = at; }
      }
      if (found < 0) return null;
      deletions.push([found + 1, found + chunk.before.length]);
      continue;
    }
    let found = -1;
    for (let at = end; at + chunk.after.length <= post.length; at++) {
      let matches = true;
      for (let k = 0; k < chunk.after.length; k++) {
        if (++comparisons > 1_000_000) return null;
        if (post[at + k] !== chunk.after[k]) { matches = false; break; }
      }
      if (matches) { if (found !== -1) return null; found = at; }
    }
    if (found < 0) return null;
    located.push({ at: found, chunk }); end = found + chunk.after.length;
  }
  const before = [...post];
  for (const { at, chunk } of [...located].reverse()) before.splice(at, chunk.after.length, ...chunk.before);
  const mapping = correspondence(base, before);
  if (!mapping) return null;
  const ranges: Array<[number, number]> = [...deletions];
  const lineRange = (index: number): [number, number] | null => {
    const exact = mapping.get(index);
    if (exact !== undefined) return [exact + 1, exact + 1];
    let left = index - 1, right = index + 1;
    while (left >= 0 && !mapping.has(left)) left--;
    while (right < before.length && !mapping.has(right)) right++;
    const oldLeft = left < 0 ? -1 : mapping.get(left)!;
    const oldRight = right === before.length ? base.length : mapping.get(right)!;
    // A prior replacement with equal line counts preserves positional evidence.
    if (oldRight - oldLeft === right - left) {
      const at = oldLeft + index - left + 1;
      return [at, at];
    }
    // Editing a previously inserted line still touches the exact original gap.
    if (oldRight === oldLeft + 1) return [oldLeft + 1.5, oldLeft + 1.5];
    return null;
  };
  let shift = 0;
  for (const { at, chunk } of located) {
    // Minimal changed runs, using the patch's own -/+ sides. Common context and
    // re-added lines (e.g. a comment inserted before a function) aren't edits.
    const unchanged = correspondence(chunk.before, chunk.after);
    if (!unchanged) return null;
    const kept = new Set(unchanged.values());
    for (let i = 0; i < chunk.before.length; i++) if (!kept.has(i)) {
      const range = lineRange(at + shift + i);
      if (range !== null) ranges.push(range);
    }
    const anchors = [...unchanged].sort(([a], [b]) => a - b);
    let cursor = 0;
    for (let i = 0; i < chunk.after.length; i++) {
      while (cursor < anchors.length && anchors[cursor]![0] < i) cursor++;
      if (unchanged.has(i)) continue;
      // Insertions belong to a gap only if both neighbouring unchanged lines
      // establish its exact base location. Never absorb a pre-existing change.
      const next = anchors[cursor];
      const previous = anchors[cursor - 1];
      const left = previous ? mapping.get(at + shift + previous[1]) : at + shift === 0 ? -1 : mapping.get(at + shift - 1);
      const right = next ? mapping.get(at + shift + next[1]) : mapping.get(at + shift + chunk.before.length);
      if (left !== undefined && right === left + 1) ranges.push([left + 1.5, left + 1.5]);
    }
    shift += chunk.before.length - chunk.after.length;
  }
  if (!ranges.length) return null;
  const unique = [...new Map(ranges.map(r => [r.join(":"), r])).values()];
  const signature = createHash("sha1").update(JSON.stringify(unique)).update(diff.signature).digest("hex").slice(0, 12);
  return { ranges: unique, signature };
}
