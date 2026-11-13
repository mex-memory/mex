/**
 * Replays recorded edits against the file index. Opt-in, because the inputs
 * are private or large:
 *
 *   MEX_INDEX_REPLAY_SESSIONS=<folder of Claude Code .jsonl transcripts>
 *     every Edit/Write result with `originalFile` and `structuredPatch`
 *   MEX_INDEX_REPLAY_GIT=<repository>  (MEX_INDEX_REPLAY_COMMITS, default 300)
 *     every changed source file in the last commits, from `git diff -U0`
 *
 * Each prints a summary; every kept span must equal a fresh parse.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { langOf } from "../classify.js";
import { rangesFromStructuredPatch, rangesFromUnifiedDiff, replayEdit, type ReplayResult } from "../replay.js";

const sessions = process.env.MEX_INDEX_REPLAY_SESSIONS;
const repository = process.env.MEX_INDEX_REPLAY_GIT;

interface Totals { edits: number; skipped: number; symbols: number; compared: number; dropped: number; mismatches: string[] }
const totals = (): Totals => ({ edits: 0, skipped: 0, symbols: 0, compared: 0, dropped: 0, mismatches: [] });
function add(total: Totals, label: string, result: ReplayResult): void {
  total.edits++;
  if (result.skipped) { total.skipped++; return; }
  total.symbols += result.symbols; total.compared += result.compared; total.dropped += result.dropped;
  for (const miss of result.mismatches) total.mismatches.push(`${label}: ${miss.kind} ${miss.name} shifted ${miss.shifted} parsed ${miss.parsed}`);
}

/** Apply a structured patch to the original text. */
function applyPatch(original: string, patch: ReadonlyArray<{ oldStart: number; lines: string[] }>): string | undefined {
  const lines = original.split("\n");
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of patch) {
    const start = hunk.oldStart - 1;
    if (start < cursor) return undefined;
    out.push(...lines.slice(cursor, start));
    cursor = start;
    for (const text of hunk.lines) {
      if (text.startsWith("\\")) continue;
      const body = text.slice(1);
      if (text[0] === "+") out.push(body);
      else {
        if (lines[cursor] !== body) return undefined;
        if (text[0] === " ") out.push(body);
        cursor++;
      }
    }
  }
  out.push(...lines.slice(cursor));
  return out.join("\n");
}

function* jsonlFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* jsonlFiles(path);
    else if (entry.endsWith(".jsonl")) yield path;
  }
}

describe.skipIf(!sessions)("replaying recorded Claude Code edits", () => {
  it("keeps every span exact", async () => {
    const total = totals();
    let unusable = 0;
    for (const file of jsonlFiles(sessions!)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.includes("structuredPatch") || !line.includes("originalFile")) continue;
        let entry: { toolUseResult?: { filePath?: string; originalFile?: string | null; structuredPatch?: Array<{ oldStart: number; lines: string[] }> } };
        try { entry = JSON.parse(line); } catch { continue; }
        const result = entry.toolUseResult;
        if (!result?.filePath || typeof result.originalFile !== "string" || !result.structuredPatch?.length) continue;
        const path = result.filePath.split("\\").join("/");
        if (langOf(path) === "other") continue;
        const after = applyPatch(result.originalFile, result.structuredPatch);
        if (after === undefined) { unusable++; continue; }
        add(total, path, await replayEdit(path, result.originalFile, after, rangesFromStructuredPatch(result.structuredPatch, langOf(path))));
      }
    }
    console.log(JSON.stringify({ source: "claude-code sessions", ...total, mismatches: total.mismatches.length, unusable, examples: total.mismatches.slice(0, 10) }, null, 2));
    expect(total.mismatches).toEqual([]);
  }, 1_800_000);
});

describe.skipIf(!repository)("replaying git history", () => {
  it("keeps every span exact", async () => {
    const git = (...args: string[]) => execFileSync("git", ["-C", repository!, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
    const count = Number(process.env.MEX_INDEX_REPLAY_COMMITS ?? 300);
    const total = totals();
    const commits = git("log", "--no-merges", `-n${count}`, "--format=%H %P").trim().split("\n").map((row) => row.split(" "));
    for (const [commit, parent] of commits) {
      if (!commit || !parent) continue;
      const files = git("diff", "--name-only", "--diff-filter=M", parent, commit).trim().split("\n").filter((path) => path && langOf(path) !== "other");
      for (const path of files) {
        const diff = git("diff", "-U0", "--no-color", parent, commit, "--", path);
        const before = git("show", `${parent}:${path}`), after = git("show", `${commit}:${path}`);
        add(total, `${commit.slice(0, 8)} ${path}`, await replayEdit(path, before, after, rangesFromUnifiedDiff(diff, langOf(path))));
      }
    }
    console.log(JSON.stringify({ source: repository, commits: commits.length, ...total, mismatches: total.mismatches.length, examples: total.mismatches.slice(0, 10) }, null, 2));
    expect(total.mismatches).toEqual([]);
  }, 1_800_000);
});
