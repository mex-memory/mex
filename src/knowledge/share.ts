/**
 * `mex share`: commit the approved notes as team entries, with the config,
 * the sources read and the agents' rule files, to a new branch made in a
 * temporary worktree. Your branch and working tree are never touched. MEX
 * never pushes, except when you ask for a pull request with --pr.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { KnowledgeError } from "./contract.js";
import { serializeEntry } from "./entry.js";
import { containedDirectory } from "./files.js";
import { rebuildNative } from "./native.js";
import { scanRuleFiles } from "./rule-files.js";
import { git, prepareShare, type SharePlan } from "./share-plan.js";
import { clearShareState, firstLink, readShareState, removeWorktree, saveShareState, type ShareState, type ShareStep } from "./share-state.js";
import { applyTeamWrite, prepareTeamWrite } from "./team.js";

export interface ShareResult { branch: string; commit: string; entries: string[]; files: string[]; pr?: string; }
export interface ShareRun {
  /** Open a pull request: pushes the share branch and runs `gh pr create`. */
  pr?: boolean;
  now?: Date;
  skip?: string[];
  /** Tests only: stop as if killed after this step. */
  stopAfter?: ShareStep;
}

const ORDER: ShareStep[] = ["started", "worktree", "written", "committed"];

function projectDirectory(options: KnowledgeOptions): { dir: string; projectId: string; root: string } {
  const project = knowledgeProject(options);
  if (!existsSync(project.location.home)) throw new KnowledgeError("SHARE_NOTHING", "No personal notes on this machine to share.");
  return { dir: containedDirectory(project.location.home, ["projects", project.projectId], true)!, projectId: project.projectId, root: project.root };
}

/** Merge MEX's key into the repo's config, keeping everything else. */
function writeConfig(worktree: string): void {
  const file = join(worktree, ".mex", "config.json");
  let config: Record<string, unknown> = {};
  if (existsSync(file)) {
    try { config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; }
    catch { throw new KnowledgeError("SHARE_CONFIG", ".mex/config.json isn't valid JSON; fix it before sharing."); }
  }
  const next = { ...config, knowledge: { version: 1, shared: true } };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
}

/** What was read to build the team's knowledge, so teammates don't pay to read it again. */
function writeSources(worktree: string): void {
  const scan = scanRuleFiles(worktree);
  const sources = { version: 1, rule_files: scan.files.map(f => ({ path: f.path, hash: f.hash, agents: f.agents })) };
  writeFileSync(join(worktree, ".mex", "sources.json"), `${JSON.stringify(sources, null, 2)}\n`);
}

const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

function writeShare(worktree: string, plan: SharePlan): Record<string, string | null> {
  const options = { projectPath: worktree };
  const paths = new Set([".mex/config.json", ".mex/sources.json"]);
  for (const c of plan.entries) {
    const preview = prepareTeamWrite(c.entry, options, c.entry.mex.source.quote);
    applyTeamWrite(preview, preview.revision, options, c.entry.mex.source.quote);
    paths.add(preview.path);
  }
  writeConfig(worktree);
  writeSources(worktree);
  const native = rebuildNative(options, { sharedOnly: true, force: true });
  for (const path of [...native.written ?? [], ...native.removed ?? [], ...native.unchanged ?? []]) paths.add(path);
  if (existsSync(join(worktree, ".mex/native.json"))) paths.add(".mex/native.json");
  return Object.fromEntries([...paths].map(path => [path, existsSync(join(worktree, path)) ? digest(readFileSync(join(worktree, path))) : null]));
}

function commit(worktree: string, count: number, files: ShareState["files"]): string {
  if (!files || !Object.keys(files).length) throw new KnowledgeError("SHARE_LOST", "The share has no recorded output; discard it and preview again.");
  for (const [path, expected] of Object.entries(files)) {
    if (!ownedPath(path)) throw new KnowledgeError("SHARE_CHANGED", "The share's recorded paths changed.");
    const actual = existsSync(join(worktree, path)) ? digest(readFileSync(join(worktree, path))) : null;
    if (actual !== expected) throw new KnowledgeError("SHARE_CHANGED", `The share's ${path} changed after writing; its worktree was kept for review.`);
    // Excludes are shared by worktrees. Stage only the exact share outputs,
    // explicitly, even when solo setup hides .mex or a generated AGENTS.md.
    git(worktree, "add", "--force", "--", path);
  }
  git(worktree, "commit", "-q", "-m", `Share team knowledge: ${count} ${count === 1 ? "entry" : "entries"}`);
  return git(worktree, "rev-parse", "HEAD");
}

function step(dir: string, state: ShareState, next: ShareStep, stopAfter?: ShareStep): void {
  state.step = next;
  saveShareState(dir, state);
  if (stopAfter === next) throw new KnowledgeError("SHARE_STOPPED", `Stopped after ${next}.`);
}

function openPr(root: string, plan: { branch: string; baseName: string }, count: number): string {
  git(root, "push", "-u", "origin", plan.branch);
  try {
    return execFileSync("gh", ["pr", "create", "--base", plan.baseName.replace(/^origin\//u, ""), "--head", plan.branch, "--title", "Share team knowledge",
      "--body", `${count} ${count === 1 ? "entry" : "entries"} from MEX, with the agents' rule files.`],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
  } catch {
    throw new KnowledgeError("SHARE_PR", `Pushed ${plan.branch}, but couldn't open the pull request; open it yourself, or install and log in to gh.`);
  }
}

/** Run an approved share. `expected` is the revision the preview printed. */
export function runShare(options: KnowledgeOptions, expected: string, run: ShareRun = {}): ShareResult {
  const { dir } = projectDirectory(options);
  const waiting = readShareState(dir);
  if (waiting) throw new KnowledgeError("SHARE_IN_PROGRESS", `A share to ${waiting.branch} didn't finish. Run mex share --finish or mex share --discard.`);
  const plan = prepareShare(options, { now: run.now, skip: run.skip });
  if (plan.revision !== expected) throw new KnowledgeError("STALE_PREVIEW", "What would be shared changed; run mex share again to see it.");
  if (!plan.entries.length) throw new KnowledgeError("SHARE_NOTHING", "Nothing to share.");
  const state: ShareState = {
    version: 1, branch: plan.branch, base: plan.base, step: "started", ids: plan.entries.map(e => e.entry.mex.id),
    worktree: join(dir, `share-${randomBytes(4).toString("hex")}`), started: (run.now ?? new Date()).toISOString().slice(0, 10),
    baseName: plan.baseName, entryHashes: Object.fromEntries(plan.entries.map(e => [e.entry.mex.id, digest(serializeEntry(e.entry))])),
  };
  saveShareState(dir, state);
  if (run.stopAfter === "started") throw new KnowledgeError("SHARE_STOPPED", "Stopped after started.");
  git(plan.root, "worktree", "add", "-q", "-b", plan.branch, state.worktree, plan.base);
  step(dir, state, "worktree", run.stopAfter);
  return complete(dir, plan.root, state, plan, run);
}

function complete(dir: string, root: string, state: ShareState, plan: SharePlan | undefined, run: ShareRun): ShareResult {
  validateWorktree(dir, root, state);
  let sha = git(root, "rev-parse", `refs/heads/${state.branch}`);
  if (state.step === "written" && sha !== state.base) {
    // A kill can land after git commit but before saving the committed step.
    const changed = git(root,"diff","--name-only",state.base,sha).split("\n").filter(Boolean);
    if (!state.files || git(root,"rev-parse",`${sha}^`) !== state.base || changed.some(path => !(path in state.files!))
      || Object.entries(state.files).some(([path, expected]) => !ownedPath(path) || (existsSync(join(state.worktree,path)) ? digest(readFileSync(join(state.worktree,path))) : null) !== expected)
      || git(state.worktree,"diff","--name-only","HEAD") || git(state.worktree,"diff","--cached","--name-only")) {
      throw new KnowledgeError("SHARE_CHANGED","The share branch changed after its recorded write; it was kept for review.");
    }
    step(dir,state,"committed",run.stopAfter);
  }
  if (ORDER.indexOf(state.step) < ORDER.indexOf("written")) {
    if (!plan) throw new KnowledgeError("SHARE_LOST", "The share's notes changed since it started; discard it and share again.");
    state.files = writeShare(state.worktree, plan);
    step(dir, state, "written", run.stopAfter);
  }
  if (ORDER.indexOf(state.step) < ORDER.indexOf("committed")) {
    sha = commit(state.worktree, state.ids.length, state.files);
    step(dir, state, "committed", run.stopAfter);
  }
  const files = git(root, "diff", "--name-only", state.base, sha).split("\n").filter(Boolean);
  removeWorktree(root, state.worktree);
  const result: ShareResult = { branch: state.branch, commit: sha, entries: state.ids, files };
  if (run.pr) result.pr = openPr(root, { branch: state.branch, baseName: state.baseName ?? plan?.baseName ?? "main" }, state.ids.length);
  clearShareState(dir);
  return result;
}

/** Finish a share that was killed: rewrite what's missing, commit, clean up. */
export function finishShare(options: KnowledgeOptions, run: ShareRun = {}): ShareResult {
  const { dir, root } = projectDirectory(options);
  const state = readShareState(dir);
  if (!state) throw new KnowledgeError("SHARE_NONE", "No unfinished share.");
  validateState(dir, state);
  if (state.step === "started" && !existsSync(state.worktree)) {
    clearShareState(dir);
    throw new KnowledgeError("SHARE_NONE", "That share had created nothing yet; run mex share again.");
  }
  // Rebuild the plan from the same notes, minus any that changed since.
  let plan: SharePlan | undefined;
  if (ORDER.indexOf(state.step) < ORDER.indexOf("written")) {
    plan = prepareShare(options, { now: run.now });
    plan.entries = plan.entries.filter(e => state.ids.includes(e.entry.mex.id));
    if (plan.base !== state.base || plan.entries.length !== state.ids.length || !state.entryHashes
      || plan.entries.some(e => state.entryHashes![e.entry.mex.id] !== digest(serializeEntry(e.entry)))) plan = undefined;
  }
  return complete(dir, root, state, plan, run);
}

/** Files a share writes; nothing else in its worktree is ever deleted. */
const OWN = /^(?:\.mex\/(?:learned\/(?:[a-z]+\/)?mx_[a-z0-9]{6,64}\.md|config\.json|sources\.json|native\.json)|\.claude\/rules\/mex[\w-]*\.md|(?:[\w.-]+\/)*AGENTS\.md)$/u;

function ownedPath(path: string): boolean {
  return OWN.test(path) && path.split("/").every(part => part !== "." && part !== ".." && part !== "");
}

function validateState(dir: string, state: ShareState): void {
  if (!/^mex\/share-\d{4}-\d{2}-\d{2}(?:-\d+)?$/u.test(state.branch) || !/^[a-f0-9]{40,64}$/u.test(state.base)
    || !Array.isArray(state.ids) || state.ids.length > 10_000 || !state.ids.every(id => /^mx_[a-z0-9]{6,64}$/u.test(id))
    || !ORDER.includes(state.step) || dirname(resolve(state.worktree)) !== resolve(dir) || !/^share-[a-f0-9]{8}$/u.test(basename(state.worktree))) {
    throw new KnowledgeError("SHARE_CHANGED", "The recorded share does not name an owned temporary worktree; it was kept for review.");
  }
}

function validateWorktree(dir: string, root: string, state: ShareState): void {
  validateState(dir, state);
  if (!existsSync(state.worktree)) {
    if (state.step === "committed") return; // cleanup finished before the caller was killed
    throw new KnowledgeError("SHARE_CHANGED", "The share's temporary worktree is missing.");
  }
  const link = firstLink(state.worktree);
  if (link) throw new KnowledgeError("SHARE_LINK", `The share's worktree holds a link (${link}); check it yourself before continuing.`);
  const common = (cwd: string) => resolve(cwd, git(cwd, "rev-parse", "--git-common-dir"));
  if (common(state.worktree) !== common(root) || git(state.worktree, "symbolic-ref", "--quiet", "HEAD") !== `refs/heads/${state.branch}`)
    throw new KnowledgeError("SHARE_CHANGED", "The share's worktree identity changed.");
}

/** Undo the share's own writes in its temporary worktree, so git removes it without forcing. */
function undoOwnWrites(worktree: string, files: NonNullable<ShareState["files"]>): void {
  for (const [path, expected] of Object.entries(files)) {
    if (!ownedPath(path)) continue;
    const full = join(worktree, ...path.split("/"));
    if ((existsSync(full) ? digest(readFileSync(full)) : null) !== expected) continue;
    const tracked = git(worktree, "ls-tree", "--name-only", "HEAD", "--", path);
    if (tracked) git(worktree, "restore", "--source=HEAD", "--staged", "--worktree", "--", path);
    else {
      git(worktree, "rm", "--cached", "--ignore-unmatch", "--", path);
      if (existsSync(full)) unlinkSync(full);
    }
  }
}

/** Drop an unfinished share: remove its worktree without forcing, and its branch only if it holds nothing. */
export function discardShare(options: KnowledgeOptions): { branch: string; branchKept: boolean } {
  const { dir, root } = projectDirectory(options);
  const state = readShareState(dir);
  if (!state) throw new KnowledgeError("SHARE_NONE", "No unfinished share.");
  validateState(dir, state);
  if (existsSync(state.worktree)) {
    validateWorktree(dir, root, state);
    // A kill during writing has no complete ownership record. Keep any
    // partial files for review rather than guessing which edits are ours.
    if (state.files) undoOwnWrites(state.worktree, state.files);
  }
  removeWorktree(root, state.worktree);
  let branchKept = false;
  try {
    const tip = git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${state.branch}`);
    if (tip === state.base) git(root, "branch", "-d", state.branch);
    else branchKept = true;
  } catch { /* no branch was made */ }
  clearShareState(dir);
  return { branch: state.branch, branchKept };
}

/** An unfinished share, if one was killed. */
export function pendingShare(options: KnowledgeOptions): ShareState | undefined {
  const project = knowledgeProject(options);
  if (!existsSync(project.location.home)) return undefined;
  return readShareState(join(project.location.home, "projects", project.projectId));
}
