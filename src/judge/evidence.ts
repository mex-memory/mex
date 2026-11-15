import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { relative, sep } from "node:path";
import { containedDirectory, readBoundedTextFile, readEntryFile } from "../knowledge/files.js";
import { parseEntry, type KnowledgeEntry } from "../knowledge/entry.js";
import { repoFile } from "../knowledge/references.js";
import type { NativeItem, CheckResult } from "../knowledge/check.js";
import { canonicalFileDiff } from "../team/artifacts/unified-diff.js";
import type { RepoRelativePath } from "../team/contracts/shared.js";

export const JUDGE_LIMITS = Object.freeze({ entries: 10_000, scanBytes: 8 << 20, batch: 5, files: 16, fileBytes: 64 << 10, promptBytes: 256 << 10, history: 32 });
export const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
export interface Position { branch: string | null; head: string | null; }
export interface Candidate {
  item: NativeItem; entry: KnowledgeEntry; content: string; files: string[]; checks: CheckResult[];
  /** Held, complete entries are opportunistic work, after the unresolved pile. */
  spare: boolean; distance: number;
  inputs?: Record<string, string>;
}
export interface FileEvidence {
  path: string; current: string | null; current_hash: string | null;
  baselines: Array<{ hash: string; commit: string | null; diff: string | null }>;
}
export interface Evidence {
  checkout: string; position: Position; entries: Array<{ id: string; entry: KnowledgeEntry; checks_now: CheckResult[]; rule_change?: string[] }>;
  files: FileEvidence[];
}

/** Match the evaluator's parsed entry and actual reads, not a later file view. */
export function coherent(candidates: Candidate[], snapshot: Evidence): boolean {
  return candidates.every(candidate => candidate.item.entry_hash === hash(candidate.content) && candidate.inputs !== undefined
    && candidate.files.every(path => {
      const file = snapshot.files.find(file => file.path === path);
      const observed = candidate.inputs![path];
      return !!file && (file.current_hash === null ? observed === "missing" : observed === file.current_hash);
    }));
}

export function git(checkout: string, args: string[], bytes = 128 << 10): Promise<string | undefined> {
  const env={...process.env,GIT_NO_REPLACE_OBJECTS:"1"};
  for(const key of ["GIT_DIR","GIT_WORK_TREE","GIT_COMMON_DIR","GIT_INDEX_FILE","GIT_NAMESPACE","GIT_PREFIX"]) delete (env as NodeJS.ProcessEnv)[key];
  return new Promise(resolve => {
    execFile("git", ["--literal-pathspecs", "-C", checkout, ...args], {
      encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: bytes, env,
    }, (error, stdout) => resolve(error ? undefined : stdout));
  });
}
export async function position(checkout: string): Promise<Position> {
  const [branch, head] = await Promise.all([
    git(checkout, ["symbolic-ref", "--quiet", "HEAD"]), git(checkout, ["rev-parse", "--verify", "HEAD"]),
  ]);
  return { branch: branch?.trim() || null, head: head?.trim() || null };
}
export function samePosition(a: Position, b: Position): boolean { return a.branch === b.branch && a.head === b.head; }

/** Check every parent of native-supplied paths, including personal storage. */
export function readCandidate(item: NativeItem, checkout: string, home: string, projectId: string): { content: string; entry: KnowledgeEntry } | undefined {
  const base = item.level === "team" ? containedDirectory(checkout, [".mex", "learned"])
    : item.level === "personal" ? containedDirectory(home, ["projects", projectId, "notes"]) : undefined;
  if (!base) return undefined;
  const path = relative(base, item.path).split(sep).join("/");
  if (path.startsWith("../") || path === "..") return undefined;
  const safe = repoFile(base, path);
  const content = safe && readEntryFile(safe);
  if (content === undefined) return undefined;
  const entry = parseEntry(content);
  if (entry.mex.id !== item.id || entry.mex.status !== "active") return undefined;
  return { content, entry };
}

export function entryFiles(entry: KnowledgeEntry): string[] {
  return [...new Set(entry.mex.checks.flatMap(c => [...Object.keys(c.files), ...("file" in c.target && typeof c.target.file === "string" ? [c.target.file] : [])]))].sort();
}
export function readSource(checkout: string, path: string): string | null {
  const safe = repoFile(checkout, path);
  return safe ? readBoundedTextFile(safe, JUDGE_LIMITS.fileBytes) ?? null : null;
}
export function distance(files: string[], near: string[]): number {
  let closest = 10_000;
  for (const file of files) for (const touched of near) {
    const a = file.split("/"), b = touched.split("/");
    let common = 0;
    while (common < a.length && common < b.length && a[common] === b[common]) common++;
    closest = Math.min(closest, a.length + b.length - 2 * common);
  }
  return closest;
}
export function orderCandidates(candidates: Candidate[]): Candidate[] {
  return candidates.sort((a, b) => Number(a.spare) - Number(b.spare) || a.distance - b.distance || a.item.id.localeCompare(b.item.id));
}
/** A batch shares a file with its first entry and never promotes spare work. */
export function nextBatch(candidates: Candidate[]): Candidate[] {
  const first = candidates[0];
  if (!first) return [];
  const rest = candidates.slice(1).filter(c => c.spare === first.spare);
  const shared = first.files.find(file => rest.some(c => c.files.includes(file)));
  return [first, ...rest.filter(c => shared && c.files.includes(shared)).slice(0, JUDGE_LIMITS.batch - 1)];
}

/** Full-file changes matter: a caller in this file can invalidate its helper's note. */
export async function evidence(checkout: string, candidates: Candidate[], at: Position): Promise<Evidence> {
  const deadline = Date.now() + 30_000;
  const paths = [...new Set(candidates.flatMap(c => c.files))].sort();
  if (paths.length > JUDGE_LIMITS.files) throw new Error("The judge's source-file limit was reached.");
  const files: FileEvidence[] = [];
  for (const path of paths) {
    const current = readSource(checkout, path);
    const expected = [...new Set(candidates.flatMap(c => c.entry.mex.checks.flatMap(check => {
      const floors: Record<string, string> = check.files;
      const baseline = floors[path];
      return baseline ? [baseline] : [];
    })))];
    const baselines: FileEvidence["baselines"] = [];
    const commits = (await git(checkout, ["log", `-${JUDGE_LIMITS.history}`, "--format=%H", "--", path]))?.trim().split("\n").filter(Boolean) ?? [];
    const old = new Map<string, { text: string; commit: string }>();
    for (const commit of commits) {
      if (Date.now() > deadline) throw new Error("The judge's evidence time limit was reached.");
      if (!/^[a-f0-9]{40,64}$/u.test(commit)) continue;
      const text = await git(checkout, ["show", `${commit}:${path}`], JUDGE_LIMITS.fileBytes);
      if (text !== undefined) old.set(hash(text), { text, commit });
      if (expected.every(h => old.has(h) || (current !== null && h === hash(current)))) break;
    }
    for (const baseline of expected) {
      const found = old.get(baseline);
      const before = current !== null && hash(current) === baseline ? current : found?.text;
      baselines.push({ hash: baseline, commit: found?.commit ?? null,
        diff: before === undefined ? null : canonicalFileDiff(path as RepoRelativePath, before, current ?? "") });
    }
    files.push({ path, current, current_hash: current === null ? null : hash(current), baselines });
  }
  return { checkout, position: at, entries: candidates.map(c => ({ id: c.item.id, entry: c.entry, checks_now: c.checks,
    ...(c.item.rule_evidence?.length ? { rule_change: c.item.rule_evidence } : {}) })), files };
}

/** Exact proof immediately before persisting a response; no result survives a checkout switch. */
export async function unchanged(checkout: string, home: string, projectId: string, candidates: Candidate[], snapshot: Evidence): Promise<boolean> {
  if (!samePosition(snapshot.position, await position(checkout))) return false;
  try {
    if (candidates.some(c => readCandidate(c.item, checkout, home, projectId)?.content !== c.content)) return false;
    return snapshot.files.every(f => { const now = readSource(checkout, f.path); return (now === null ? null : hash(now)) === f.current_hash; });
  } catch { return false; }
}
