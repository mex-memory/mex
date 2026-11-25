/**
 * The knowledge services preview a team write as a whole-file replacement:
 * every old line removed, then every new line added. That is exact but hard
 * to read, so the dialog shows a line diff with unchanged runs folded.
 * Display only: the write itself is still bound to the service's revision.
 */
export type DiffLine = { kind: "header" | "context" | "removed" | "added" | "fold"; text: string };

const CONTEXT = 2;
const MAX_CELLS = 400_000;

export function readableDiff(diff: string): DiffLine[] {
  const headers: DiffLine[] = [];
  const before: string[] = [];
  const after: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ") || line.startsWith("@@") || line === "") continue;
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("new file mode")) headers.push({ kind: "header", text: line });
    else if (line.startsWith("-")) before.push(line.slice(1));
    else if (line.startsWith("+")) after.push(line.slice(1));
    else before.push(line.slice(1)), after.push(line.slice(1));
  }
  if (before.length * after.length > MAX_CELLS) return raw(diff);
  return [...headers, ...fold(lineDiff(before, after))];
}

function raw(diff: string): DiffLine[] {
  return diff.split("\n").filter((line) => line !== "").map((line) => ({
    kind: line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@") || line.startsWith("diff ") ? "header"
      : line.startsWith("-") ? "removed" : line.startsWith("+") ? "added" : "context",
    text: line,
  }));
}

/** Longest common subsequence over lines; files are capped at 64 KiB upstream. */
function lineDiff(before: string[], after: string[]): DiffLine[] {
  const rows = before.length, columns = after.length;
  const table = Array.from({ length: rows + 1 }, () => new Uint32Array(columns + 1));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < rows && j < columns) {
    if (before[i] === after[j]) { out.push({ kind: "context", text: " " + before[i] }); i++; j++; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) out.push({ kind: "removed", text: "-" + before[i++] });
    else out.push({ kind: "added", text: "+" + after[j++] });
  }
  while (i < rows) out.push({ kind: "removed", text: "-" + before[i++] });
  while (j < columns) out.push({ kind: "added", text: "+" + after[j++] });
  return out;
}

/** Keep a little context around each change and fold long unchanged runs. */
function fold(lines: DiffLine[]): DiffLine[] {
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.kind === "context") return;
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(lines.length - 1, index + CONTEXT); k++) keep[k] = true;
  });
  const out: DiffLine[] = [];
  let hidden = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (hidden) out.push({ kind: "fold", text: `… ${hidden} unchanged ${hidden === 1 ? "line" : "lines"}` });
      hidden = 0;
      out.push(line);
    } else hidden++;
  });
  if (hidden) out.push({ kind: "fold", text: `… ${hidden} unchanged ${hidden === 1 ? "line" : "lines"}` });
  return out;
}
