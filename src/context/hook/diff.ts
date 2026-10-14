/**
 * What the working tree changed against HEAD, as base-side line ranges.
 *
 * An edit hook needs to know which lines of the *old* file were touched, since
 * the facts it checks were recorded against the old code. `git diff -U0` gives
 * exactly that in its `@@ -a,b` hunk headers. Reading is the only thing done
 * here: git is run with `--no-optional-locks` so a hook never writes the index.
 */

import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Windows sometimes fails to start a child in a console-less process with STATUS_DLL_INIT_FAILED. */
const DLL_INIT_FAILED = 0xc0000142;
const GIT_TIMEOUT_MS = 8000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

export function runGit(cwd: string, args: readonly string[]): string | null {
  let result;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result = spawnSync("git", [...GIT_ARGS, ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    // The child never ran when it died of 0xC0000142, so running it again is safe.
    if (result.status !== DLL_INIT_FAILED) break;
  }
  if (result === undefined || result.error || result.status !== 0) return null;
  return result.stdout;
}

const GIT_ARGS = ["--no-optional-locks", "-c", "core.quotepath=false"] as const;

/** {@link runGit} without blocking: lets a hook overlap the process start with its own work. */
export function runGitAsync(cwd: string, args: readonly string[]): Promise<string | null> {
  const attempt = (remaining: number): Promise<string | null> =>
    new Promise((resolveRun) => {
      execFile(
        "git",
        [...GIT_ARGS, ...args],
        { cwd, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => {
          const code = (error as (Error & { code?: unknown }) | null)?.code;
          if (code === DLL_INIT_FAILED && remaining > 1) {
            // The child never ran; run it again.
            resolveRun(attempt(remaining - 1));
            return;
          }
          resolveRun(error ? null : stdout);
        },
      );
    });
  return attempt(3);
}

export interface FileDiff {
  /** Inclusive base-side (HEAD) line ranges the change touches; a pure insertion is the half line after the line it follows. */
  ranges: Array<[number, number]>;
  /** Hash of the hunks, so an unchanged change is recognisable on the next call. */
  signature: string;
}

const posix = (path: string): string => path.replace(/\\/g, "/");

/** Parse `git diff -U0` output into per-file base-side ranges. */
export function parseUnifiedZero(diff: string): Map<string, FileDiff> {
  const files = new Map<string, { ranges: Array<[number, number]>; hunks: string[] }>();
  let current: { ranges: Array<[number, number]>; hunks: string[] } | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      continue;
    }
    // A deleted file has no `+++ b/` name; `--- a/` carries it. Prefer the new side when there is one.
    const minus = /^--- (?:a\/(.+?)|\/dev\/null)\t?$/.exec(line);
    if (minus) {
      if (minus[1] !== undefined) {
        const name = posix(minus[1]);
        current = files.get(name) ?? { ranges: [], hunks: [] };
        files.set(name, current);
      } else {
        current = null;
      }
      continue;
    }
    const plus = /^\+\+\+ b\/(.+?)\t?$/.exec(line);
    if (plus) {
      const name = posix(plus[1]!);
      if (current === null) {
        current = files.get(name) ?? { ranges: [], hunks: [] };
        files.set(name, current);
      }
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
    if (hunk && current !== null) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      // A pure insertion (count 0) lands between `start` and the next line. Recording it as the
      // half line after `start` makes it overlap a symbol exactly when it falls inside the symbol's
      // lines, not when it merely follows its last line or precedes its first.
      current.ranges.push(count === 0 ? [start + 0.5, start + 0.5] : [start, start + count - 1]);
      current.hunks.push(line);
      continue;
    }
    if (current !== null && (line.startsWith("+") || line.startsWith("-"))) current.hunks.push(line);
  }
  const out = new Map<string, FileDiff>();
  for (const [file, value] of files) {
    if (value.ranges.length === 0) continue;
    out.set(file, { ranges: value.ranges, signature: createHash("sha1").update(value.hunks.join("\n")).digest("hex").slice(0, 12) });
  }
  return out;
}

function diffArgs(files?: readonly string[]): string[] | null {
  const args = ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", "--relative", "HEAD"];
  if (files !== undefined) {
    if (files.length === 0) return null;
    // `:(literal)` so a file name with glob characters means exactly itself.
    args.push("--", ...files.map((file) => `:(literal)${file}`));
  }
  return args;
}

/** Diff of the named files (or all tracked changes), relative to `cwd`. Null when git cannot say. */
export function diffAgainstHead(cwd: string, files?: readonly string[]): Map<string, FileDiff> | null {
  const args = diffArgs(files);
  if (args === null) return new Map();
  const text = runGit(cwd, args);
  return text === null ? null : parseUnifiedZero(text);
}

/** {@link diffAgainstHead}, started now and awaited later. */
export async function diffAgainstHeadAsync(cwd: string, files?: readonly string[]): Promise<Map<string, FileDiff> | null> {
  const args = diffArgs(files);
  if (args === null) return new Map();
  const text = await runGitAsync(cwd, args);
  return text === null ? null : parseUnifiedZero(text);
}

/** A cheap change signature for a source file: size and modification time, or "gone". */
export function fileSignature(projectRoot: string, file: string): string {
  try {
    const stat = statSync(join(projectRoot, file));
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return "gone";
  }
}

/** Whether any of `ranges` overlaps the inclusive `[start, end]`. */
export function touches(ranges: readonly [number, number][], start: number, end: number): boolean {
  return ranges.some(([a, b]) => a <= end && b >= start);
}

// ---------------------------------------------------------------------------
// HEAD without a process
// ---------------------------------------------------------------------------

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

/** The directory holding `.git`, walking up from the project root; a worktree's `.git` file is followed. */
function findGitDir(start: string): { gitDir: string; commonDir: string } | null {
  let current = resolve(start);
  for (;;) {
    const dot = join(current, ".git");
    if (existsSync(dot)) {
      let gitDir = dot;
      try {
        if (statSync(dot).isFile()) {
          const pointer = /^gitdir:\s*(.+)$/m.exec(readText(dot) ?? "");
          if (!pointer) return null;
          gitDir = resolve(current, pointer[1]!.trim());
        }
      } catch {
        return null;
      }
      const common = readText(join(gitDir, "commondir"));
      return { gitDir, commonDir: common ? resolve(gitDir, common) : gitDir };
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The commit HEAD names, read from `.git` directly (no git process), or null when it cannot be told. */
export function readHead(projectRoot: string): string | null {
  const dirs = findGitDir(projectRoot);
  if (dirs === null) return null;
  const head = readText(join(dirs.gitDir, "HEAD"));
  if (head === null) return null;
  const ref = /^ref:\s*(.+)$/.exec(head);
  if (!ref) return /^[0-9a-f]{40,64}$/.test(head) ? head : null;
  const name = ref[1]!.trim();
  const loose = readText(join(dirs.commonDir, name)) ?? readText(join(dirs.gitDir, name));
  if (loose !== null && /^[0-9a-f]{40,64}$/.test(loose)) return loose;
  const packed = readText(join(dirs.commonDir, "packed-refs"));
  if (packed !== null) {
    for (const line of packed.split("\n")) {
      const match = /^([0-9a-f]{40,64}) (.+)$/.exec(line.trim());
      if (match && match[2] === name) return match[1]!;
    }
  }
  return null;
}
