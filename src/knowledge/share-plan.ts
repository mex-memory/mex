/**
 * What `mex share` would share: the strongest personal notes, checked, in
 * order, against the default branch. Pure: it writes nothing. The person
 * approves the exact revision it prints.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cachedVerdicts } from "./check.js";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { KnowledgeError } from "./contract.js";
import { serializeEntry } from "./entry.js";
import { entryLabel } from "./labels.js";
import { personalNotes } from "./native.js";
import { byStrength } from "./native-render.js";
import { isBroad, type Candidate } from "./native-select.js";
import { shareProblems, type ShareProblem } from "./share-checks.js";

const STRONG = new Set(["person", "docs", "ci", "review"]);

export interface ShareItem { id: string; one_line: string; label: string; }
export interface SharePlan {
  root: string;
  projectId: string;
  /** The commit the share branch starts from: the default branch, never your branch. */
  base: string;
  baseName: string;
  branch: string;
  share: ShareItem[];
  blocked: ShareProblem[];
  /** Notes left out and why: weak, stale, or already shared. */
  skipped: Array<{ id: string; reason: string }>;
  /** Approve exactly this. */
  revision: string;
  entries: Candidate[];
}

export function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).trim();
}
function tryGit(root: string, ...args: string[]): string | undefined {
  try { return git(root, ...args); } catch { return undefined; }
}

/** The default branch's commit: origin's HEAD, else main or master, else your HEAD. */
export function defaultBase(root: string): { sha: string; name: string } {
  const origin = tryGit(root, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
  for (const ref of [origin, "refs/remotes/origin/main", "refs/heads/main", "refs/heads/master"]) {
    if (!ref) continue;
    const sha = tryGit(root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    if (sha) return { sha, name: ref.replace(/^refs\/(?:heads|remotes)\//u, "") };
  }
  const head = tryGit(root, "rev-parse", "--verify", "--quiet", "HEAD^{commit}");
  if (!head) throw new KnowledgeError("SHARE_NO_COMMIT", "Share needs at least one commit to branch from.");
  return { sha: head, name: "HEAD" };
}

/** A branch name nobody uses yet: mex/share-YYYY-MM-DD, then -2, -3... */
export function freeBranch(root: string, now: Date): string {
  const stem = `mex/share-${now.toISOString().slice(0, 10)}`;
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? stem : `${stem}-${n}`;
    if (!tryGit(root, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`)) return name;
  }
  throw new KnowledgeError("SHARE_BRANCH", "Too many share branches today; delete old ones first.");
}

export function prepareShare(options: KnowledgeOptions, choose: { skip?: string[]; now?: Date } = {}): SharePlan {
  const project = knowledgeProject(options);
  const root = project.root;
  const now = choose.now ?? new Date();
  if (!existsSync(project.location.home)) throw new KnowledgeError("SHARE_NOTHING", "No personal notes on this machine to share.");
  const base = defaultBase(root);
  const onBase = new Set((tryGit(root, "ls-tree", "-r", "--name-only", base.sha, "--", ".mex/learned") ?? "").split("\n").filter(Boolean)
    .map(path => /(mx_[a-z0-9]{6,64})\.md$/u.exec(path)?.[1]).filter((id): id is string => !!id));
  const verdicts = cachedVerdicts(options, project.projectId, root) ?? new Map();
  const skip = new Set(choose.skip ?? []);
  const plan: SharePlan = { root, projectId: project.projectId, base: base.sha, baseName: base.name, branch: freeBranch(root, now), share: [], blocked: [], skipped: [], revision: "", entries: [] };
  for (const c of personalNotes(project.location.home, project.projectId, project.retired, root).sort(byStrength)) {
    const { id } = c.entry.mex;
    const verdict = verdicts.get(id);
    if (skip.has(id)) plan.skipped.push({ id, reason: "you left it out" });
    else if (onBase.has(id)) plan.skipped.push({ id, reason: `already shared on ${base.name}` });
    else if (!STRONG.has(c.entry.mex.evidence)) plan.skipped.push({ id, reason: "evidence too weak for the team" });
    else if (verdict === "broken" || verdict === "changed") plan.skipped.push({ id, reason: `verdict is ${verdict}` });
    else {
      const problems = shareProblems(c.entry);
      if (problems.length) { plan.blocked.push(...problems); continue; }
      plan.entries.push({ level: "team", entry: c.entry });
      plan.share.push({ id, one_line: c.entry.mex.one_line, label: entryLabel(c.entry, "personal") });
    }
  }
  // Broad entries first: those are the rules every session sees.
  plan.entries.sort((a, b) => Number(!a.entry.mex.scope.every(isBroad)) - Number(!b.entry.mex.scope.every(isBroad)));
  plan.share = plan.entries.map(e => plan.share.find(s => s.id === e.entry.mex.id)!);
  const digest = createHash("sha256").update(JSON.stringify({ root, base: base.sha, branch: plan.branch, entries: plan.entries.map(e => serializeEntry(e.entry)) }));
  plan.revision = digest.digest("hex").slice(0, 16);
  return plan;
}
