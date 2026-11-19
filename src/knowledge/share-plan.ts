/**
 * What `mex share` would share: the strongest personal notes, checked, in
 * order, against the default branch. Pure: it writes nothing. The person
 * approves the exact revision it prints.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { approvedCoverage, coverageKey, MANIFEST_PATH, noteKey, parseManifest, type SharedCoverage } from "../learn-deeper/coverage.js";
import { repositoryFromRemote } from "../learn-deeper/source.js";
import { openRecordReadOnly } from "../record/index.js";
import { currentVerdicts } from "./check.js";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { KnowledgeError } from "./contract.js";
import { serializeEntry } from "./entry.js";
import { entryLabel } from "./labels.js";
import { personalNotes } from "./native.js";
import { byStrength } from "./native-render.js";
import { isBroad, type Candidate } from "./native-select.js";
import { shareProblems, type ShareProblem } from "./share-checks.js";
import { claimHash } from "./state.js";

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
  coverage: SharedCoverage[];
}

// Scratch worktrees live under the MEX home, deeper than the user's checkout:
// without long paths, Git for Windows can't check out a large repository there.
const LONG_PATHS = process.platform === "win32" ? ["-c", "core.longpaths=true"] : [];
export function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...LONG_PATHS, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).trim();
}
function tryGit(root: string, ...args: string[]): string | undefined {
  try { return git(root, ...args); } catch { return undefined; }
}

/**
 * The commit MEX makes needs a Git author. Asked before anything changes, so a
 * fresh machine gets a clear instruction instead of a half-finished run.
 */
export function requireGitIdentity(root: string): void {
  if (tryGit(root, "var", "GIT_AUTHOR_IDENT") === undefined || tryGit(root, "var", "GIT_COMMITTER_IDENT") === undefined) {
    throw new KnowledgeError("GIT_IDENTITY", "Git doesn't know who you are. Set it with git config --global user.name \"Your Name\" and git config --global user.email you@example.com, then run this again.");
  }
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
  const covered = parseManifest(tryGit(root, "show", `${base.sha}:${MANIFEST_PATH}`))?.learn_deeper ?? [];
  const baseClaims = new Set(covered.map(record => record.claim));
  const baseSources = new Set(covered.flatMap(record => record.sources.map(coverageKey)));
  const notes = personalNotes(project.location.home, project.projectId, project.retired, root).sort(byStrength);
  const verdicts = notes.some(c => c.entry.mex.checks.length) ? currentVerdicts(options, project) ?? new Map() : new Map();
  const skip = new Set(choose.skip ?? []);
  const plan: SharePlan = { root, projectId: project.projectId, base: base.sha, baseName: base.name, branch: freeBranch(root, now), share: [], blocked: [], skipped: [], revision: "", entries: [], coverage: [] };
  const repo = repositoryFromRemote(tryGit(root, "remote", "get-url", "origin") ?? "");
  const reader = openRecordReadOnly(options);
  try {
    for (const c of notes) {
      const { id } = c.entry.mex;
      const verdict = verdicts.get(`personal/${id}`);
      if (skip.has(id)) plan.skipped.push({ id, reason: "you left it out" });
      else if (onBase.has(id)) plan.skipped.push({ id, reason: `already shared on ${base.name}` });
      else if (baseClaims.has(claimHash(c.entry.text))) plan.skipped.push({ id, reason: `the rule is already recorded on ${base.name}` });
      else if (!STRONG.has(c.entry.mex.evidence)) plan.skipped.push({ id, reason: "evidence too weak for the team" });
      else if (verdict === "broken" || verdict === "changed") plan.skipped.push({ id, reason: `verdict is ${verdict}` });
      else if (c.entry.mex.checks.length && verdict !== "held") plan.skipped.push({ id, reason: "current checks have not held" });
      else {
        const problems = shareProblems(c.entry);
        if (problems.length) { plan.blocked.push(...problems); continue; }
        const coverage = approvedCoverage(c.entry, serializeEntry(c.entry), reader?.setting(project.projectId, noteKey(id)), repo);
        if (coverage.sources.length && coverage.sources.every(source => baseSources.has(coverageKey(source)))) {
          plan.skipped.push({ id, reason: `its sources are already covered on ${base.name}` }); continue;
        }
        plan.coverage.push(coverage);
        plan.entries.push({ level: "team", entry: c.entry });
        plan.share.push({ id, one_line: c.entry.mex.one_line, label: entryLabel(c.entry, "personal") });
      }
    }
  } finally { reader?.close(); }
  // Broad entries first: those are the rules every session sees.
  plan.entries.sort((a, b) => Number(!a.entry.mex.scope.every(isBroad)) - Number(!b.entry.mex.scope.every(isBroad)));
  plan.share = plan.entries.map(e => plan.share.find(s => s.id === e.entry.mex.id)!);
  plan.coverage = plan.entries.map(e => plan.coverage.find(item => item.id === e.entry.mex.id)!);
  const digest = createHash("sha256").update(JSON.stringify({ root, base: base.sha, branch: plan.branch,
    entries: plan.entries.map(e => serializeEntry(e.entry)), coverage: plan.coverage }));
  plan.revision = digest.digest("hex").slice(0, 16);
  return plan;
}
