/**
 * Commit-anchored decisions. A decision that cites a commit is `proposed` until
 * that commit, or a squash or rebase copy of it, is reachable from the default
 * branch; a revert withdraws it. Acceptance and withdrawal are events in an
 * append-only log in record.db, never a status written back into the entry.
 * The in-force set is mirrored to a small file the hook reads. Code checks stay
 * the test of whether a decision is still true; this only decides when it
 * comes into force.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openRecord, type RecordWriter } from "../record/index.js";
import type { KnowledgeEntry } from "./entry.js";
import type { KnowledgeOptions } from "./context.js";
import { aidCorpus, refreshAids, type CorpusItem } from "./aid-store.js";

/** Phrases that mark a commit message as recording a choice. Kept equal to the hook's list. */
export const DECISION_WORDS = [
  "adopt", "adopted", "avoid", "chose", "choose", "decide", "decided", "deprecate", "deprecated", "drop", "dropped",
  "in favor of", "in favour of", "instead of", "migrate to", "migrated to", "move to", "moved to", "no longer", "prefer",
  "rather than", "replace", "replaced", "switch to", "switched to",
] as const;
/** One word matches about half of all commits; two is the trigger. */
export const DECISION_TRIGGER = 2;

/** The distinct decision phrases in a commit message, matched on word boundaries, ignoring case. */
export function decisionWords(message: string): string[] {
  const text = ` ${message.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  return DECISION_WORDS.filter(w => text.includes(` ${w} `));
}

export interface Git { (args: string[], input?: string): string | undefined; }
export const runGit = (root: string): Git => (args, input) => {
  if (input === undefined) {
    try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }); }
    catch { return undefined; }
  }
  const r = spawnSync("git", ["-C", root, ...args], { input, encoding: "utf8", timeout: 20_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return r.status === 0 ? r.stdout : undefined;
};

/** The default branch: origin's HEAD, else main, else master. */
export function defaultRef(git: Git): string | undefined {
  for (const ref of ["refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master"]) if (git(["rev-parse", "-q", "--verify", `${ref}^{commit}`])?.trim()) return ref;
  return undefined;
}

export interface CommitFacts { sha: string; patch_id?: string; subject: string; files: string[]; }
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
/** What a note records about the commit it cites, so a copy can be matched after the original is gone. */
export function commitFacts(git: Git, rev: string): CommitFacts | undefined {
  const sha = git(["rev-parse", "-q", "--verify", `${rev}^{commit}`])?.trim();
  if (!sha || !SHA.test(sha)) return undefined;
  const subject = (git(["log", "-1", "--format=%s", sha]) ?? "").trim().slice(0, 512);
  const files = (git(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha]) ?? "").split(/\r?\n/u).filter(f => f && !f.startsWith("/") && !f.includes("\\") && !f.split("/").some(p => p === ".." || p === "." || p === "")).slice(0, 64);
  const patch = patchIds(git, ["log", "-1", "-p", "--format=commit %H", sha]).get(sha);
  return { sha, subject, files, ...(patch ? { patch_id: patch } : {}) };
}
function patchIds(git: Git, logArgs: string[]): Map<string, string> {
  const log = git(logArgs);
  const out = new Map<string, string>();
  if (!log) return out;
  for (const line of (git(["patch-id", "--stable"], log) ?? "").split(/\r?\n/u)) {
    const [patch, commit] = line.trim().split(/\s+/u);
    if (patch && commit && SHA.test(patch) && SHA.test(commit)) out.set(commit, patch);
  }
  return out;
}

export interface Landing { landed?: string; matchedBy?: "sha" | "patch-id" | "subject-files"; revertedBy?: string; actor?: string; }
/** How the cited commit reached the default branch, if it did, and whether it was reverted there. */
export function landing(git: Git, ref: string, anchor: NonNullable<KnowledgeEntry["mex"]["commit"]>, since: string): Landing {
  const out: Landing = {};
  const committer = (sha: string) => (git(["log", "-1", "--format=%cn", sha]) ?? "").trim().slice(0, 200) || "unknown";
  if (git(["cat-file", "-e", `${anchor.sha}^{commit}`]) !== undefined && git(["merge-base", "--is-ancestor", anchor.sha, ref]) !== undefined) {
    Object.assign(out, { landed: anchor.sha, matchedBy: "sha", actor: committer(anchor.sha) });
  } else {
    // A squash or rebase copy: same patch, else the same subject over the same files. Bounded to recent
    // commits on the default branch that touch the anchor's files.
    const window = ["--since", since, "-n", "500", ref, ...(anchor.files?.length ? ["--", ...anchor.files] : [])];
    if (anchor.patch_id) {
      for (const [commit, patch] of patchIds(git, ["log", "-p", "--format=commit %H", ...window])) {
        if (patch === anchor.patch_id) { Object.assign(out, { landed: commit, matchedBy: "patch-id" }); break; }
      }
    }
    if (!out.landed && anchor.subject) {
      const files = [...(anchor.files ?? [])].sort().join("\n");
      for (const line of (git(["log", "--format=%H%x00%s", ...window]) ?? "").split(/\r?\n/u)) {
        const [commit, subject] = line.split("\0");
        if (!commit || !SHA.test(commit) || subject?.trim() !== anchor.subject) continue;
        const touched = (git(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", commit]) ?? "").split(/\r?\n/u).filter(Boolean).sort().join("\n");
        if (touched === files) { Object.assign(out, { landed: commit, matchedBy: "subject-files" }); break; }
      }
    }
    if (out.landed) out.actor = committer(out.landed);
  }
  if (out.landed) {
    const reverts = git(["log", "--format=%H%x00%B%x01", "--grep", "This reverts commit", "-n", "500", `${out.landed}..${ref}`]) ?? "";
    const landed = out.landed;
    const ancestor = (a: string, b: string) => git(["merge-base", "--is-ancestor", a, b]) !== undefined;
    // A revert names the commit itself, or the merge that brought it in (a reverted pull request).
    const undoes = (target: string) => target === anchor.sha || target === landed
      || (git(["rev-parse", "-q", "--verify", `${target}^2`]) !== undefined && ancestor(landed, target) && !ancestor(landed, `${target}^1`));
    for (const block of reverts.split("\x01")) {
      const [commit, body] = block.trim().split("\0");
      const targets = [...(body ?? "").matchAll(/This reverts commit ([a-f0-9]{40}|[a-f0-9]{64})/gu)].map(m => m[1]);
      if (commit && targets.some(undoes)) { out.revertedBy = commit.trim(); out.actor = committer(out.revertedBy); break; }
    }
  }
  return out;
}

export interface DecisionEvent { id: number; entry_id: string; event: "accepted" | "withdrawn"; commit_sha: string; landed_sha: string | null; matched_by: string; branch: string; actor: string; at: string; }
export type DecisionState = "proposed" | "accepted" | "withdrawn";
export interface DecisionRow { id: string; level: CorpusItem["level"]; one_line: string; commit: string; state: DecisionState; events: DecisionEvent[]; }

function lastEvents(writer: RecordWriter, projectId: string): Map<string, DecisionEvent[]> {
  const rows = writer.db.prepare("SELECT * FROM decision_events WHERE project_id=? ORDER BY id").all(projectId) as unknown as DecisionEvent[];
  const out = new Map<string, DecisionEvent[]>();
  for (const r of rows) out.set(r.entry_id, [...(out.get(r.entry_id) ?? []), r]);
  return out;
}

/** The mirror the hook reads: ids of proposed entries now in force. */
export function inForcePath(home: string, projectId: string): string { return join(home, "projects", projectId, "decisions-in-force.json"); }

/**
 * One acceptance pass for a project: append an event for every decision whose
 * state changed, then publish the in-force mirror. Only proposed entries with
 * a commit anchor take part.
 */
export function acceptDecisions(options: KnowledgeOptions, git: Git = runGit(options.projectPath), now = new Date()): DecisionRow[] {
  const { projectId, items } = aidCorpus(options);
  const anchored = items.filter(i => i.entry.mex.status === "proposed" && i.entry.mex.commit);
  const writer = openRecord({ ...options, create: anchored.length > 0 });
  try {
    if (!writer.project(projectId)) return [];
    const ref = anchored.length ? defaultRef(git) : undefined;
    const rows: DecisionRow[] = [];
    writer.db.exec("BEGIN IMMEDIATE");
    try {
      const history = lastEvents(writer, projectId);
      const append = writer.db.prepare("INSERT INTO decision_events(project_id,entry_id,event,commit_sha,landed_sha,matched_by,branch,actor,at) VALUES(?,?,?,?,?,?,?,?,?)");
      for (const item of anchored) {
        const anchor = item.entry.mex.commit!;
        const events = history.get(item.entry.mex.id) ?? [];
        const last = events.at(-1);
        if (ref) {
          const since = new Date(Date.parse(`${item.entry.mex.created}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
          const land = landing(git, ref, anchor, since);
          const inForce = !!land.landed && !land.revertedBy;
          const at = now.toISOString();
          if (inForce && last?.event !== "accepted") {
            append.run(projectId, item.entry.mex.id, "accepted", anchor.sha, land.landed!, land.matchedBy!, ref, `git:${land.actor}`, at);
          } else if (!inForce && last?.event === "accepted") {
            append.run(projectId, item.entry.mex.id, "withdrawn", anchor.sha, land.revertedBy ?? null, land.revertedBy ? "revert" : "missing", ref, land.revertedBy ? `git:${land.actor}` : "mex", at);
          }
        }
        const after = (writer.db.prepare("SELECT * FROM decision_events WHERE project_id=? AND entry_id=? ORDER BY id").all(projectId, item.entry.mex.id) as unknown as DecisionEvent[]);
        rows.push({ id: item.entry.mex.id, level: item.level, one_line: item.entry.mex.one_line, commit: anchor.sha, state: after.length ? (after.at(-1)!.event === "accepted" ? "accepted" : "withdrawn") : "proposed", events: after });
      }
      publishInForce(writer.location.home, projectId, rows);
      writer.db.exec("COMMIT");
    } catch (error) { writer.db.exec("ROLLBACK"); throw error; }
    return rows;
  } finally { writer.close(); }
}

function publishInForce(home: string, projectId: string, rows: readonly DecisionRow[]): void {
  const file = inForcePath(home, projectId);
  const ids = rows.filter(r => r.state === "accepted").map(r => r.id).sort();
  const body = `${JSON.stringify({ version: 1, ids })}\n`;
  if (!ids.length && !existsSync(file)) return;
  try { if (readFileSync(file, "utf8") === body) return; } catch { /* write it */ }
  mkdirSync(join(home, "projects", projectId), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, body, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** Where the background process leaves the newest commit that reads like a decision, for the next session start. */
export function decisionCommitPath(recordDirectory: string, projectId: string): string { return join(recordDirectory, "decision-commits", `${projectId}.json`); }
export function noteDecisionCommit(recordDirectory: string, projectId: string, git: Git): boolean {
  const out = git(["log", "-1", "--format=%H%x00%B"]);
  if (!out) return false;
  const [sha, body = ""] = out.split("\0");
  if (!SHA.test(sha.trim())) return false;
  const words = decisionWords(body);
  if (words.length < DECISION_TRIGGER) return false;
  const file = decisionCommitPath(recordDirectory, projectId);
  const value = `${JSON.stringify({ version: 1, sha: sha.trim(), words })}\n`;
  try { if (readFileSync(file, "utf8") === value) return false; } catch { /* new */ }
  mkdirSync(join(recordDirectory, "decision-commits"), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, value, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return true;
}

const lastSeen = new Map<string, string>();
const lastEntries = new Map<string, string>();
/** Folder times of a checkout's entry stores: they change when an entry is added, replaced or removed. */
function entryStamp(home: string, projectId: string, path: string): string {
  return [join(home, "projects", projectId, "notes"), join(path, ".mex", "learned")].map(dir => {
    try { const s = statSync(dir); return `${s.mtimeMs}`; } catch { return "-"; }
  }).join("|");
}
/**
 * The background process's pass, once a minute: for each switched-on checkout
 * whose HEAD or default branch moved, note a decision-like HEAD commit for the
 * next session start, and run the acceptance pass. Returns the checkouts it read.
 */
export function decisionPass(writer: RecordWriter, maxCheckouts = 32, gitFor: (root: string) => Git = runGit): number {
  const rows = writer.db.prepare("SELECT project_id, path FROM checkouts WHERE state='on' AND provisional IS NULL LIMIT ?").all(maxCheckouts) as Array<{ project_id: string; path: string }>;
  let read = 0;
  for (const { project_id: projectId, path } of rows) {
    if (!existsSync(join(path, ".git"))) continue;
    const git = gitFor(path);
    const ref = defaultRef(git);
    const marker = `${git(["rev-parse", "-q", "--verify", "HEAD"])?.trim() ?? ""}|${ref ? git(["rev-parse", "-q", "--verify", ref])?.trim() ?? "" : ""}`;
    // Aliases and asks are rechecked when the entries or the checkout moved.
    const entries = `${entryStamp(writer.location.home, projectId, path)}|${marker}`;
    if (lastEntries.get(path) !== entries) {
      lastEntries.set(path, entries);
      try { refreshAids({ projectPath: path, home: writer.location.home }); } catch { /* the next change retries */ }
    }
    if (lastSeen.get(path) === marker) continue;
    lastSeen.set(path, marker);
    read++;
    try { noteDecisionCommit(writer.location.directory, projectId, git); } catch { /* the next move retries */ }
    try { acceptDecisions({ projectPath: path, home: writer.location.home }, git); } catch { /* the next move retries */ }
  }
  return read;
}
