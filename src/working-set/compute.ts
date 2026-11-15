/**
 * The working set: the files a person is working on now, computed in the
 * background from git and the file index, and cached per checkout for the
 * session-start brief and the edit-time history notice. The hook reads only
 * this cache; it never runs git or walks history.
 */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkoutKey, writeAtomic } from "../file-index/store.js";
import { openIndex } from "../file-index/read.js";
import { openHooksReadOnly } from "../record/index.js";
import { realPath } from "../record/project.js";
import type { RecordLocation } from "../record/location.js";
import { readFactFile } from "../repo-start/facts.js";

export const WORKING_SET_VERSION = 1;

/**
 * Fixed constants. Changing one changes what a session-start brief can say.
 * Co-change comes from the project's change-together facts (the code-facts
 * job's one walk over the last 2,000 commits, re-read when HEAD moves), so
 * the working set reads no history of its own.
 */
export const WORKING_SET_LIMITS = {
  /** Co-change partners kept per seed file. */
  partners: 25,
  /** Seed files kept, in priority order. */
  seeds: 30,
  /** One-hop files kept. */
  hops: 100,
  /** A fix commit touching more files than this is a bulk change and counts for none. */
  fixCommitFiles: 200,
  /** A file needs this many fix commits to carry history. */
  fixMin: 3,
  /** A fix older than this doesn't make a history notice. */
  fixKeepDays: 180,
  fixFiles: 4000,
  /** A git call that takes longer is abandoned; the job tries again next session. */
  gitTimeoutMs: 30_000,
} as const;

export interface WorkingSetFile {
  version: 1;
  /** HEAD commit and branch the set was computed at; "" when detached or unborn. */
  head: string;
  branch: string;
  defaultBranch: string;
  /** When it was computed (ISO). */
  made: string;
  /** Checkout-relative files being worked on, in priority order. */
  seeds: string[];
  /** One hop from the seeds through imports and co-change. */
  hops: string[];
  /** Branch-name words, for matching entry text. */
  words: string[];
}

export function workingSetDirectory(recordDirectory: string, projectId: string): string {
  return join(recordDirectory, "projects", projectId, "working-set");
}
export function workingSetFile(recordDirectory: string, projectId: string, root: string): string {
  return join(workingSetDirectory(recordDirectory, projectId), `${checkoutKey(root)}.json`);
}

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // No optional locks: `git status` must not rewrite the index while the
    // person (or their agent) is using git in the same checkout.
    execFile("git", ["-C", root, "-c", "core.quotepath=off", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: WORKING_SET_LIMITS.gitTimeoutMs, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}
async function gitOr(root: string, args: string[], fallback: string): Promise<string> {
  try { return await git(root, args); } catch { return fallback; }
}

const GENERIC_WORDS = new Set(["feat", "feature", "features", "fix", "fixes", "bugfix", "hotfix", "chore", "wip", "main", "master", "trunk",
  "release", "releases", "dev", "develop", "devel", "refactor", "docs", "doc", "test", "tests", "update", "updates", "patch", "draft",
  "tmp", "temp", "the", "and", "for", "with", "from", "into", "add", "new", "old", "codex", "claude", "copilot", "cursor"]);

/** Branch-name words: split on / - _ . and case changes, at least 3 letters, generic words dropped. */
export function branchWords(branch: string): string[] {
  const out: string[] = [];
  for (const part of branch.split(/[/\-_.\s]+/)) {
    for (const word of part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ")) {
      const w = word.toLowerCase();
      if (w.length >= 3 && /^[a-z][a-z0-9]*$/.test(w) && !/^\d+$/.test(w) && !GENERIC_WORDS.has(w) && !out.includes(w)) out.push(w);
    }
  }
  return out.slice(0, 8);
}

const FIX_SUBJECT = /^(fix|bugfix|hotfix)(\([^)]*\))?!?:|\b(fix|fixes|fixed|bug|bugs|regression|crash)\b/i;
export function isFixSubject(subject: string): boolean { return FIX_SUBJECT.test(subject); }

/** One commit of the code-facts walk, newest first. */
export interface HistoryCommit { files: string[]; time: number; subject: string }

/** Files with enough recent fix commits: path → [fix commits, last fix as Unix seconds]. */
export function fixHistory(commits: readonly HistoryCommit[], now: number, limits = WORKING_SET_LIMITS): Record<string, [number, number]> {
  const counts = new Map<string, [number, number]>();
  for (const commit of commits) {
    if (!isFixSubject(commit.subject) || commit.files.length > limits.fixCommitFiles) continue;
    for (const file of commit.files) {
      const seen = counts.get(file) ?? [0, 0];
      counts.set(file, [seen[0] + 1, Math.max(seen[1], commit.time)]);
    }
  }
  const oldest = now - limits.fixKeepDays * 86_400;
  const kept = [...counts].filter(([, [count, last]]) => count >= limits.fixMin && last >= oldest)
    .sort((a, b) => b[1][1] - a[1][1] || (a[0] < b[0] ? -1 : 1)).slice(0, limits.fixFiles);
  return Object.fromEntries(kept);
}

/** Change-together partners of each seed, most supported first, from the project's code facts. */
export function coChangePartners(pairs: ReadonlyArray<{ a: string; b: string; support: number }>, seeds: readonly string[], limits = WORKING_SET_LIMITS): Map<string, string[]> {
  const seedSet = new Set(seeds);
  const found = new Map<string, Array<{ file: string; support: number }>>();
  for (const pair of pairs) {
    for (const [seed, other] of [[pair.a, pair.b], [pair.b, pair.a]] as const) {
      if (!seedSet.has(seed)) continue;
      const list = found.get(seed) ?? [];
      if (!list.some((item) => item.file === other)) list.push({ file: other, support: pair.support });
      found.set(seed, list);
    }
  }
  const out = new Map<string, string[]>();
  for (const [seed, list] of found) out.set(seed, list.sort((x, y) => y.support - x.support || (x.file < y.file ? -1 : 1)).slice(0, limits.partners).map((item) => item.file));
  return out;
}

export interface ComputeOptions { root: string; projectId: string; recordDirectory: string; /** MEX home, to find hooks.db. */ home?: string; /** Where the project's code facts live. */ location?: RecordLocation; now?: number }

/** Paths git reports relative to the repository top, made relative to the checkout. */
function underPrefix(files: readonly string[], prefix: string): string[] {
  if (!prefix) return [...files];
  return files.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
}

function underPrefixOne(file: string, prefix: string): string {
  return !prefix ? file : file.startsWith(prefix) ? file.slice(prefix.length) : "";
}

function parseStatus(text: string): { branch: string; files: string[] } {
  let branch = "";
  const files: string[] = [];
  const records = text.split("\0");
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.startsWith("## ")) {
      const name = rec.slice(3).split("...")[0]!.trim();
      if (!name.startsWith("HEAD (no branch)") && !name.startsWith("No commits yet on ")) branch = name;
      else if (name.startsWith("No commits yet on ")) branch = name.slice("No commits yet on ".length);
      continue;
    }
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    files.push(rec.slice(3));
    // A rename or copy is followed by its original path; the new path is the one being worked on.
    if (xy[0] === "R" || xy[0] === "C") i++;
  }
  return { branch, files };
}

function previousSessionEdits(options: ComputeOptions, root: string, nowIso: string): { since: string | undefined; files: string[] } {
  let reader;
  if (!options.home) return { since: undefined, files: [] };
  try { reader = openHooksReadOnly({ home: options.home, create: false }); } catch { return { since: undefined, files: [] }; }
  if (!reader) return { since: undefined, files: [] };
  try {
    // The latest session that started more than two minutes ago: the one
    // starting now is what asked for this set.
    const cutoff = new Date(Date.parse(nowIso) - 120_000).toISOString();
    const session = reader.get<{ session_id: string; started_at: string }>(
      "SELECT session_id,started_at FROM sessions WHERE project_id=? AND checkout=? AND started_at<? ORDER BY started_at DESC LIMIT 1",
      options.projectId, root, cutoff);
    if (!session) return { since: undefined, files: [] };
    const rows = reader.all<{ path: string }>("SELECT DISTINCT path FROM epoch_files WHERE session_id=? AND project_id=? AND checkout=? LIMIT 200",
      session.session_id, options.projectId, root);
    return { since: session.started_at, files: rows.map((row) => row.path) };
  } catch { return { since: undefined, files: [] }; }
  finally { reader.close(); }
}

/** Compute the working set of one checkout. Never throws for git trouble: missing parts stay empty. */
export async function computeWorkingSet(options: ComputeOptions): Promise<WorkingSetFile> {
  const root = realPath(options.root);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const made = new Date(now * 1000).toISOString();
  const prefix = (await gitOr(root, ["rev-parse", "--show-prefix"], "")).trim();
  const head = (await gitOr(root, ["rev-parse", "--verify", "--quiet", "HEAD"], "")).trim();
  const status = parseStatus(await gitOr(root, ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=normal"], ""));
  let defaultBranch = (await gitOr(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], "")).trim();
  if (!defaultBranch) {
    for (const name of ["main", "master"]) {
      if ((await gitOr(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], "")).trim()) { defaultBranch = name; break; }
    }
  }
  const shortDefault = defaultBranch.replace(/^origin\//, "");
  let branchDiff: string[] = [];
  if (head && defaultBranch && status.branch && status.branch !== shortDefault) {
    branchDiff = (await gitOr(root, ["diff", "--name-only", "-z", `${defaultBranch}...HEAD`], "")).split("\0").filter(Boolean);
  }
  const previous = previousSessionEdits(options, root, made);
  let committedSince: string[] = [];
  if (previous.since && head) {
    committedSince = (await gitOr(root, ["log", "--no-merges", "--name-only", "-z", "--format=", `--since=${previous.since}`, "-n", "200"], ""))
      .split("\0").map((file) => file.replace(/^\n+/, "")).filter(Boolean);
  }

  // Seeds in priority order: uncommitted work, the previous session, then the branch.
  const seeds: string[] = [];
  for (const file of [...underPrefix(status.files, prefix), ...previous.files, ...underPrefix(committedSince, prefix), ...underPrefix(branchDiff, prefix)]) {
    if (seeds.length >= WORKING_SET_LIMITS.seeds) break;
    if (file && !file.endsWith("/") && !seeds.includes(file)) seeds.push(file);
  }

  const hops: string[] = [];
  const addHop = (file: string) => {
    if (hops.length < WORKING_SET_LIMITS.hops && !seeds.includes(file) && !hops.includes(file)) hops.push(file);
  };
  const index = openIndex({ recordDirectory: options.recordDirectory, projectId: options.projectId, checkout: root });
  if (index) {
    try {
      const graph = index.importEdges();
      const seedSet = new Set(seeds);
      for (const [importer, imported] of graph) {
        for (const target of imported) {
          if (seedSet.has(importer)) addHop(target);
          else if (seedSet.has(target)) addHop(importer);
        }
      }
    } catch { /* imports are optional evidence */ }
    finally { index.close(); }
  }
  const facts = options.location ? readFactFile<{ version: number; change_together?: Array<{ a: string; b: string; support: number }> }>(options.location, options.projectId, "code-facts.json") : undefined;
  const partners = coChangePartners((facts?.change_together ?? []).map((pair) => ({ a: underPrefixOne(pair.a, prefix), b: underPrefixOne(pair.b, prefix), support: pair.support })).filter((pair) => pair.a && pair.b), seeds);
  for (const seed of seeds) for (const partner of partners.get(seed) ?? []) addHop(partner);

  return {
    version: WORKING_SET_VERSION, head, branch: status.branch, defaultBranch, made,
    seeds, hops, words: branchWords(status.branch === shortDefault ? "" : status.branch),
  };
}

/** FNV-1a, 64 bits, over the UTF-8 path: the key the hook looks a file up by. */
export function pathKey(path: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(path, "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash;
}

export const FIXES_MAGIC = "MXF1";

/**
 * The fix history as a sorted table the hook can search without parsing:
 * "MXF1", then 16-byte records (path key u64, fix count u32, last fix as
 * Unix seconds u32), little-endian, sorted by key.
 */
export function encodeFixes(fixes: Record<string, [number, number]>): Buffer {
  const rows = Object.entries(fixes).map(([path, [count, last]]) => ({ key: pathKey(path), count, last }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const out = Buffer.alloc(4 + rows.length * 16);
  out.write(FIXES_MAGIC, 0, "ascii");
  rows.forEach((row, i) => {
    out.writeBigUInt64LE(row.key, 4 + i * 16);
    out.writeUInt32LE(Math.min(row.count, 0xffffffff), 12 + i * 16);
    out.writeUInt32LE(Math.max(0, Math.min(row.last, 0xffffffff)), 16 + i * 16);
  });
  return out;
}

export function fixesFile(recordDirectory: string, projectId: string, root: string): string {
  return join(workingSetDirectory(recordDirectory, projectId), `${checkoutKey(root)}.fixes`);
}

/**
 * Write the fix table for one checkout from the code-facts walk's commits.
 * Called by the code-facts job, so history is read once.
 */
export function writeFixTable(recordDirectory: string, projectId: string, checkout: string, commits: readonly HistoryCommit[], now = Math.floor(Date.now() / 1000)): void {
  const root = realPath(checkout);
  const file = fixesFile(recordDirectory, projectId, root);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeAtomic(file, encodeFixes(fixHistory(commits, now)));
}

export async function writeWorkingSet(options: ComputeOptions): Promise<WorkingSetFile> {
  const set = await computeWorkingSet(options);
  const root = realPath(options.root);
  const file = workingSetFile(options.recordDirectory, options.projectId, root);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeAtomic(file, JSON.stringify(set));
  return set;
}
