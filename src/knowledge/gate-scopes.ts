import { globPrefix, normalizeGlob } from "../file-index/glob.js";

function alternatives(segment: string): string[] | undefined {
  const parts = [segment];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const start = part.indexOf("{"), end = part.indexOf("}", start + 1);
    if (start < 0 || end < 0) continue;
    const choices = part.slice(start + 1, end).split(",").map(choice => part.slice(0, start) + choice + part.slice(end + 1));
    if (parts.length + choices.length > 128) return undefined;
    parts.splice(i--, 1, ...choices);
  }
  return parts;
}

function segmentOverlap(left: string, right: string): boolean {
  const pending = [[0, 0, 0]], seen = new Set<string>();
  while (pending.length) {
    const [i, j, used] = pending.pop() as [number, number, number];
    const key = `${i},${j},${used}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const a = left[i], b = right[j];
    if (a === undefined && b === undefined && used) return true;
    if (a === "*") pending.push([i + 1, j, used]);
    if (b === "*") pending.push([i, j + 1, used]);
    if (a !== undefined && b !== undefined && (a === b || a === "*" || b === "*" || a === "?" || b === "?")) {
      pending.push([a === "*" ? i : i + 1, b === "*" ? j : j + 1, 1]);
    }
  }
  return false;
}

export function scopesOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  const aPrefix = globPrefix(left), bPrefix = globPrefix(right);
  if (!aPrefix.startsWith(bPrefix) && !bPrefix.startsWith(aPrefix)) return false;
  const a = normalizeGlob(left).split("/"), b = normalizeGlob(right).split("/");
  const pending = [[0, 0]], seen = new Set<string>();
  while (pending.length) {
    const [i, j] = pending.pop() as [number, number];
    const key = `${i},${j}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const x = a[i], y = b[j];
    if (x === undefined && y === undefined) return true;
    if (x === "**") pending.push([i + 1, j]);
    if (y === "**") pending.push([i, j + 1]);
    if (x === undefined || y === undefined) continue;
    if (x === "**" || y === "**") {
      pending.push([x === "**" ? i : i + 1, y === "**" ? j : j + 1]);
    } else {
      const xs = alternatives(x), ys = alternatives(y);
      if (!xs || !ys || xs.some(left => ys.some(right => segmentOverlap(left, right)))) pending.push([i + 1, j + 1]);
    }
  }
  return false;
}
