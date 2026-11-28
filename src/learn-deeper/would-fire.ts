/**
 * Replay the person's own last commits through the native delivery matchers
 * and show which rules would have stopped an edit or appeared on a file touch.
 * Bounded everywhere; on any failure it shows nothing.
 */
import { spawnSync } from "node:child_process";
import { nativeBinary } from "../knowledge/check.js";
import { command } from "./git.js";

export const WOULD_FIRE_LIMITS = { commits: 20, files: 200, lines: 3, logBytes: 4 << 20 } as const;

export interface PastEdit { commit: string; path: string; added: string; removed: string; addedLines: Array<{ line: number; text: string }> }
export interface WouldFireLine { entryId: string; commit: string; path: string; kind: "stop" | "show"; line?: number; hypothetical: true }

/** Parse `git log -p -U0` output (commits marked with a NUL line) into one edit per changed file. */
export function parseEdits(log: string): PastEdit[] {
  const edits: PastEdit[] = [];
  let commit = "", current: PastEdit | undefined, next = 0;
  for (const raw of log.split("\n")) {
    const line = raw.replace(/\r$/u, "");
    if (line.startsWith("\u0000commit ")) { commit = line.slice(8).trim(); current = undefined; continue; }
    if (line.startsWith("diff --git ")) { current = undefined; continue; }
    if (!current && line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//u, "").trimEnd().replace(/\\/g, "/");
      if (path === "/dev/null" || !commit) { current = undefined; continue; }
      current = { commit, path, added: "", removed: "", addedLines: [] };
      edits.push(current);
      continue;
    }
    if (!current) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk) { next = Number(hunk[1]); continue; }
    if (line.startsWith("+")) {
      current.added += line.slice(1) + "\n";
      current.addedLines.push({ line: next++, text: line.slice(1) });
    } else if (line.startsWith("-")) current.removed += line.slice(1) + "\n";
  }
  return edits.filter(edit => edit.added || edit.removed).slice(0, WOULD_FIRE_LIMITS.files);
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

/** Show at most three examples. Keep looking across batches until edit stops fill the list. */
export function wouldFire(entryFiles: readonly string[], edits: readonly PastEdit[], env: NodeJS.ProcessEnv = process.env): WouldFireLine[] {
  if (!entryFiles.length || !edits.length) return [];
  const binary = nativeBinary(env);
  if (!binary) return [];
  const stops: WouldFireLine[] = [], shown: WouldFireLine[] = [];
  const seen = new Set<string>();
  const replayEdits: string[] = [];
  let editBytes = 0;
  for (const { commit, path, added, removed } of edits.slice(0, WOULD_FIRE_LIMITS.files)) {
    const json = JSON.stringify({ commit, path, added, removed });
    editBytes += Buffer.byteLength(json) + 1;
    if (editBytes > WOULD_FIRE_LIMITS.logBytes) break;
    replayEdits.push(json);
  }
  const deadline = performance.now() + 15_000;
  let offset = 0;
  while (offset < entryFiles.length && stops.length < WOULD_FIRE_LIMITS.lines) {
    const entries: string[] = [];
    let entryBytes = 0;
    while (offset < entryFiles.length && entries.length < 64) {
      const json = JSON.stringify(entryFiles[offset]!);
      entryBytes += Buffer.byteLength(json) + 1;
      if (entries.length && entryBytes > 3 << 20) break;
      entries.push(json);
      offset++;
    }
    const timeout = Math.floor(deadline - performance.now());
    if (timeout < 1) break;
    const run = spawnSync(binary, ["--would-fire"], {
      // Both halves are bounded in encoded bytes before crossing the native payload limit.
      input: `{"entries":[${entries.join(",")}],"edits":[${replayEdits.join(",")}]}`,
      encoding: "utf8", timeout, windowsHide: true, maxBuffer: 1 << 20, env: { ...env, MEX_BACKGROUND: "1" },
    });
    if (run.error || run.status !== 0) return [];
    let reply: { ok?: boolean; matches?: Array<{ entry: string; commit: string; path: string; type: string; pattern?: string }> };
    try { reply = JSON.parse(run.stdout || "{}"); } catch { return []; }
    if (!reply.ok || !Array.isArray(reply.matches)) return [];
    for (const match of reply.matches) {
      if (seen.has(match.entry)) continue;
      seen.add(match.entry);
      const item = { entryId: match.entry, commit: match.commit, path: match.path };
      if (match.type === "anchor-touch") {
        shown.push({ ...item, kind: "show", hypothetical: true });
      } else {
        const edit = edits.find(edit => edit.commit === match.commit && edit.path === match.path);
        const line = edit?.addedLines.find(item => match.pattern && item.text.includes(match.pattern))?.line ?? edit?.addedLines[0]?.line;
        stops.push({ ...item, kind: "stop", hypothetical: true, ...(line ? { line } : {}) });
      }
    }
  }
  return [...stops, ...shown].slice(0, WOULD_FIRE_LIMITS.lines);
}
