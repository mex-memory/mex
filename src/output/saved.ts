/**
 * Saved command output (plan sheet 35, L3): when the hook or `mex run` trims a
 * command's output, the full text is saved first, under the record directory:
 *
 *   projects/<project-id>/out/<n>.txt   the full output, byte for byte
 *   projects/<project-id>/out/<n>.json  { version, n, command, exit_code, agent, session_id?, created_at, lines, chars }
 *
 * Only the native side (native/output/spill.go) writes these files; this
 * module reads them for `mex out`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Must match MetaVersion in native/output/spill.go. */
export const SAVED_OUTPUT_VERSION = 1;

export interface SavedOutput {
  n: number;
  command: string;
  exit_code: number;
  agent: string;
  created_at: string;
  lines: number;
  chars: number;
}

export function savedOutputDirectory(recordDirectory: string, projectId: string): string {
  if (!/^[gf]-[a-f0-9]{24}$/.test(projectId)) throw new Error("Invalid project id");
  return join(recordDirectory, "projects", projectId, "out");
}

function readMeta(directory: string, n: number): SavedOutput | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(directory, `${n}.json`), "utf8")) as Partial<SavedOutput> & { version?: number };
    if (meta.version !== SAVED_OUTPUT_VERSION || meta.n !== n || typeof meta.command !== "string") return undefined;
    return {
      n, command: meta.command, exit_code: Number(meta.exit_code ?? 0), agent: String(meta.agent ?? ""),
      created_at: String(meta.created_at ?? ""), lines: Number(meta.lines ?? 0), chars: Number(meta.chars ?? 0),
    };
  } catch { return undefined; }
}

/** Saved outputs, newest first. Only complete ones (meta written) are listed. */
export function listSavedOutputs(directory: string): SavedOutput[] {
  if (!existsSync(directory)) return [];
  const out: SavedOutput[] = [];
  for (const name of readdirSync(directory)) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) continue;
    const meta = readMeta(directory, Number(match[1]));
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => b.n - a.n);
}

/** The full text of one saved output, or undefined when it is gone. */
export function readSavedOutput(directory: string, n: number): { meta: SavedOutput; text: string } | undefined {
  if (!Number.isSafeInteger(n) || n <= 0) return undefined;
  const meta = readMeta(directory, n);
  if (!meta) return undefined;
  try { return { meta, text: readFileSync(join(directory, `${n}.txt`), "utf8") }; } catch { return undefined; }
}

export interface GrepLine { line: number; text: string; match: boolean }

/**
 * Lines of text matching pattern (a regular expression; plain text works too),
 * with `context` lines around each match. Line numbers are 1-based.
 */
export function grepSaved(text: string, pattern: string, options: { ignoreCase?: boolean; context?: number } = {}): GrepLine[] {
  let re: RegExp;
  try { re = new RegExp(pattern, options.ignoreCase ? "i" : ""); }
  catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), options.ignoreCase ? "i" : ""); }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const context = Math.max(0, options.context ?? 0);
  const show = new Map<number, boolean>();
  lines.forEach((line, i) => {
    if (!re.test(line.replace(/\r$/, ""))) return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
      if (!show.has(j)) show.set(j, false);
    }
    show.set(i, true);
  });
  return [...show.entries()].sort((a, b) => a[0] - b[0]).map(([i, match]) => ({ line: i + 1, text: lines[i]!.replace(/\r$/, ""), match }));
}
