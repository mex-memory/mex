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

export const WORKING_SET_VERSION = 1;

/** Fixed constants. Changing one changes what a session-start brief can say. */
export const WORKING_SET_LIMITS = {
  /** Commits read for co-change and fix history. */
  window: 2000,
  /** Commits touching more files than this make no pairs (they are moves and bulk edits). */
  pairFiles: 200,
  /** Only commits touching at most this many files count as support for a pair. */
  focusedFiles: 30,
  /** Pair weights decay by commit order, exp(-commits ago / decay). */
  decay: 500,
  /** Shared focused commits a pair needs before it counts. */
  minSupport: 2,
  /** Co-change partners kept per seed file. */
  partners: 25,
  /** Seed files kept, in priority order. */
  seeds: 30,
  /** One-hop files kept. */
  hops: 100,
  /** A file needs this many fix commits to carry history. */
  fixMin: 3,
  /** Fix histories older than this are not kept. */
  fixKeepDays: 365,
  fixFiles: 5000,
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
  /** path → [fix commits in the window, last fix as Unix seconds]. */
  fixes: Record<string, [number, number]>;
}

export function workingSetDirectory(recordDirectory: string, projectId: string): string {
  return join(recordDirectory, "projects", projectId, "working-set");
}
export function workingSetFile(recordDirectory: string, projectId: string, root: string): string {
  return join(workingSetDirectory(recordDirectory, projectId), `${checkoutKey(root)}.json`);
}

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", root, "-c", "core.quotepath=off", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: WORKING_SET_LIMITS.gitTimeoutMs, windowsHide: true },
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

export interface Commit { files: string[]; time: number; fix: boolean }

/** Parse `git log -z --name-only --format=%x01%ct%x02%s`. */
export function parseLog(text: string): Commit[] {
  const commits: Commit[] = [];
  for (const chunk of text.split("\x01")) {
    if (!chunk) continue;
    const head = chunk.indexOf("\x02");
    const lineEnd = chunk.indexOf("\n", head);
    if (head < 0 || lineEnd < 0) continue;
    const time = Number(chunk.slice(0, head));
    const subject = chunk.slice(head + 1, lineEnd);
    const files = chunk.slice(lineEnd + 1).split("\0").map((file) => file.replace(/^\n+/, "")).filter(Boolean);
    commits.push({ files, time: Number.isFinite(time) ? time : 0, fix: isFixSubject(subject) });
  }
  return commits;
}

/**
 * Co-change partners of the seed files. Commits are newest first. A pair's
 * weight sums exp(-ordinal / decay) over commits of at most `pairFiles` files;
 * it counts only with `minSupport` shared commits of at most `focusedFiles`.
 */
export function coChangePartners(commits: readonly Commit[], seeds: readonly string[], limits = WORKING_SET_LIMITS): Map<string, string[]> {
  const seedSet = new Set(seeds);
  const pairs = new Map<string, Map<string, { weight: number; support: number }>>();
  commits.slice(0, limits.window).forEach((commit, ordinal) => {
    if (commit.files.length > limits.pairFiles || commit.files.length < 2) return;
    const focused = commit.files.length <= limits.focusedFiles;
    const decay = Math.exp(-ordinal / limits.decay);
    for (const seed of commit.files) {
      if (!seedSet.has(seed)) continue;
      let partners = pairs.get(seed);
      if (!partners) pairs.set(seed, partners = new Map());
      for (const other of commit.files) {
        if (other === seed) continue;
        const pair = partners.get(other) ?? { weight: 0, support: 0 };
        pair.weight += decay;
        if (focused) pair.support++;
        partners.set(other, pair);
      }
    }
  });
  const out = new Map<string, string[]>();
  for (const [seed, partners] of pairs) {
    out.set(seed, [...partners].filter(([, pair]) => pair.support >= limits.minSupport)
      .sort((a, b) => b[1].weight - a[1].weight || (a[0] < b[0] ? -1 : 1)).slice(0, limits.partners).map(([file]) => file));
  }
  return out;
}

export function fixHistory(commits: readonly Commit[], now: number, limits = WORKING_SET_LIMITS): Record<string, [number, number]> {
  const counts = new Map<string, [number, number]>();
  for (const commit of commits.slice(0, limits.window)) {
    if (!commit.fix || commit.files.length > limits.pairFiles) continue;
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

export interface ComputeOptions { root: string; projectId: string; recordDirectory: string; /** MEX home, to find hooks.db. */ home?: string; now?: number }

/** Paths git reports relative to the repository top, made relative to the checkout. */
function underPrefix(files: readonly string[], prefix: string): string[] {
  if (!prefix) return [...files];
  return files.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
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
  const log = head ? parseLog(await gitOr(root, ["log", "--no-merges", "-z", "--name-only", `-n`, String(WORKING_SET_LIMITS.window), "--format=%x01%ct%x02%s"], "")) : [];
  for (const commit of log) commit.files = underPrefix(commit.files, prefix);

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
  const partners = coChangePartners(log, seeds);
  for (const seed of seeds) for (const partner of partners.get(seed) ?? []) addHop(partner);

  return {
    version: WORKING_SET_VERSION, head, branch: status.branch, defaultBranch, made,
    seeds, hops, words: branchWords(status.branch === shortDefault ? "" : status.branch), fixes: fixHistory(log, now),
  };
}

export async function writeWorkingSet(options: ComputeOptions): Promise<WorkingSetFile> {
  const set = await computeWorkingSet(options);
  const file = workingSetFile(options.recordDirectory, options.projectId, realPath(options.root));
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeAtomic(file, JSON.stringify(set));
  return set;
}
