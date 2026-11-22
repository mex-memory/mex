/**
 * "Would have fired", at $0: replay the person's own last commits in this checkout through the speed
 * bump's matching (the native `--would-fire` mode) and say which learned rules would have stopped which
 * change. It shows the value of a run on the person's own code, and helps them decide what to tick.
 * Bounded everywhere; on any failure it shows nothing.
 */
import { spawnSync } from "node:child_process";
import { nativeBinary } from "../knowledge/check.js";
import { command } from "./git.js";

export const WOULD_FIRE_LIMITS = { commits: 20, files: 200, lines: 3, logBytes: 4 << 20 } as const;

export interface PastEdit { commit: string; path: string; added: string; removed: string; addedLines: Array<{ line: number; text: string }> }
export interface WouldFireLine { entryId: string; commit: string; path: string; line?: number }

/** Parse `git log -p -U0` output (commits marked with a NUL line) into one edit per changed file. */
export function parseEdits(log: string): PastEdit[] {
  const edits: PastEdit[] = [];
  let commit = "", current: PastEdit | undefined, next = 0;
  for (const raw of log.split("\n")) {
    const line = raw.replace(/\r$/u, "");
    if (line.startsWith("\u0000commit ")) { commit = line.slice(8).trim(); current = undefined; continue; }
    if (line.startsWith("diff --git ")) { current = undefined; continue; }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//u, "");
      if (path === "/dev/null" || !commit) { current = undefined; continue; }
      current = { commit, path, added: "", removed: "", addedLines: [] };
      edits.push(current);
      continue;
    }
    if (!current || line.startsWith("--- ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk) { next = Number(hunk[1]); continue; }
    if (line.startsWith("+")) {
      current.added += line.slice(1) + "\n";
      current.addedLines.push({ line: next++, text: line.slice(1) });
    } else if (line.startsWith("-")) current.removed += line.slice(1) + "\n";
  }
  return edits.filter(edit => edit.added).slice(0, WOULD_FIRE_LIMITS.files);
}

/** The person's last commits here, by their own git email; none without one. */
export async function pastEdits(root: string): Promise<PastEdit[]> {
  const email = (await command(root, "git", ["config", "user.email"]))?.trim();
  if (!email || !/^[^\s@]+@[^\s@]+$/u.test(email)) return [];
  const pattern = email.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const log = await command(root, "git", ["log", "--no-color", "--no-ext-diff", "--no-textconv", "--no-merges",
    `--max-count=${WOULD_FIRE_LIMITS.commits}`, `--author=<${pattern}>`, "--format=%x00commit %H", "-p", "-U0", "HEAD"],
  undefined, WOULD_FIRE_LIMITS.logBytes, 10_000);
  return log ? parseEdits(log) : [];
}

/** Which of these learned entry files would have stopped which of these edits; at most three lines. */
export function wouldFire(entryFiles: readonly string[], edits: readonly PastEdit[], env: NodeJS.ProcessEnv = process.env): WouldFireLine[] {
  if (!entryFiles.length || !edits.length) return [];
  const binary = nativeBinary(env);
  if (!binary) return [];
  const run = spawnSync(binary, ["--would-fire"], {
    input: JSON.stringify({ entries: entryFiles.slice(0, 64), edits: edits.map(({ commit, path, added, removed }) => ({ commit, path, added, removed })) }),
    encoding: "utf8", timeout: 15_000, windowsHide: true, maxBuffer: 1 << 20, env: { ...env, MEX_BACKGROUND: "1" },
  });
  let reply: { ok?: boolean; matches?: Array<{ entry: string; commit: string; path: string; type: string; pattern: string }> };
  try { reply = JSON.parse(run.stdout || "{}"); } catch { return []; }
  if (!reply.ok || !Array.isArray(reply.matches)) return [];
  const out: WouldFireLine[] = [];
  for (const match of reply.matches) {
    const edit = edits.find(item => item.commit === match.commit && item.path === match.path);
    const line = edit?.addedLines.find(item => item.text.includes(match.pattern))?.line ?? edit?.addedLines[0]?.line;
    out.push({ entryId: match.entry, commit: match.commit, path: match.path, ...(line ? { line } : {}) });
    if (out.length === WOULD_FIRE_LIMITS.lines) break;
  }
  return out;
}
