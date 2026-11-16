/** Recoverable upgrade publication. Only --pr permits remote operations. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { openRecord } from "../record/index.js";
import { realPath } from "../record/project.js";
import { knowledgeProject, type KnowledgeOptions } from "../knowledge/context.js";
import { containedDirectory, createEntryFile } from "../knowledge/files.js";
import { KnowledgeError, parseEntry } from "../knowledge/entry.js";
import { git, defaultBase, requireGitIdentity } from "../knowledge/share-plan.js";
import { firstLink, removeWorktree } from "../knowledge/share-state.js";
import { atomicCreateArtifact, atomicReplaceArtifact, withContainedArtifactLock } from "../team/artifacts/filesystem.js";
import { revisionOf } from "../team/artifacts/revision.js";
import type { RepoRelativePath } from "../team/contracts/shared.js";
import { prepareUpgrade, type UpgradePlan } from "./plan.js";
import { readLegacyScaffold } from "./legacy-reader.js";
import { seedOwnedCheckout } from "./checkout.js";
import { applyChange, artifactLocation, digest, readBytes, readText, safePath } from "./safe-files.js";
import type { UpgradeFileChange } from "./cleanup-plan.js";

const STEPS = ["started", "local", "worktree", "written", "committed"] as const;
export type UpgradeStep = typeof STEPS[number];
export interface UpgradeRun {
  pr?: boolean; now?: Date; stopAfter?: UpgradeStep;
  /** Internal deterministic publication seam; never set by CLI arguments. */
  gh?: (root: string, args: string[]) => string;
}
export interface UpgradeResult { branch: string; commit: string | null; base: string; files: string[]; personal: number; local: number; pr?: string; }
interface State { version: 1; plan: UpgradePlan; worktree: string; step: UpgradeStep; commit?: string; pr?: string; }
const STATE = "upgrade.json";
const receipt = (root: string) => `upgrade-done-${digest(root).slice(0, 24)}.json`;
const JOURNAL_LIMIT = 16 * 1024 * 1024;
const OWN = /^(?:\.mex\/(?:AGENTS\.md|SETUP\.md|SYNC\.md|config\.json|sources\.json|native\.json|learned\/(?:[a-z]+\/)?mx_[a-z0-9]{6,64}\.md)|(?:\.agents|\.claude|\.codex)\/skills\/(?:mex-inbox|mex-relay)\/.+|\.claude\/rules\/mex[\w-]*\.md|(?:[^/]+\/)*(?:AGENTS|CLAUDE)\.md)$/u;
const LOCAL = /^(?:\.mex\/(?:AGENTS|SETUP|SYNC)\.md|(?:AGENTS|CLAUDE)\.md|(?:\.agents|\.claude|\.codex)\/skills\/(?:mex-inbox|mex-relay)\/.+)$/u;

function projectDirectory(options: KnowledgeOptions, create: boolean): string | undefined {
  if (create) {
    const writer = openRecord({ ...options, create: true });
    writer.close();
  }
  const p = knowledgeProject(options);
  return existsSync(p.location.home) ? containedDirectory(p.location.home, ["projects", p.projectId], create) : undefined;
}
function json(dir: string, name: string): unknown {
  const bytes = readBytes(dir, name, JOURNAL_LIMIT);
  if (bytes === null) return undefined;
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new KnowledgeError("UPGRADE_STATE", "The upgrade record could not be read safely; it was kept for review."); }
}
function save(dir: string, name: string, value: unknown, create = false): void {
  const text = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(text) > JOURNAL_LIMIT) throw new KnowledgeError("UPGRADE_LIMIT", "Upgrade recovery record exceeds its size limit.");
  const before = readBytes(dir, name, JOURNAL_LIMIT);
  const target = artifactLocation(dir, name as RepoRelativePath);
  if (create || before === null) atomicCreateArtifact(target.root, target.path, text, 0o600);
  else atomicReplaceArtifact(target.root, target.path, revisionOf(before), text, JOURNAL_LIMIT);
}
function clear(dir: string): void {
  if (readBytes(dir, STATE, JOURNAL_LIMIT) !== null) unlinkSync(join(dir, STATE));
}
function assertState(value: unknown, options: KnowledgeOptions, dir: string): State {
  const s = value as State, p = knowledgeProject(options);
  const validChange = (c: UpgradeFileChange) => c && safePath(c.path) && (c.before === null || typeof c.before === "string") && (c.after === null || typeof c.after === "string");
  const changes = (list: UpgradeFileChange[], pattern: RegExp) => Array.isArray(list) && list.length <= 20_000 && list.every(c => validChange(c) && pattern.test(c.path));
  const plan = s?.plan;
  if (s?.version !== 1 || !STEPS.includes(s.step) || !plan || !plan.ready || plan.root !== p.root || plan.home !== p.location.home || plan.projectId !== p.projectId
    || !/^[a-f0-9]{40,64}$/u.test(plan.base) || !/^[a-f0-9]{40,64}$/u.test(plan.head) || !/^mex\/upgrade-\d{4}-\d{2}-\d{2}(?:-\d+)?$/u.test(plan.branch)
    || !changes(plan.tracked, OWN) || !changes(plan.local, LOCAL) || !changes(plan.personal, /^mx_[a-z0-9]{6,64}\.md$/u)
    || !plan.sources || Object.entries(plan.sources).some(([path, hash]) => !safePath(path) || typeof hash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(hash))
    || !plan.assets || plan.assets.gitDirectory !== resolve(p.root, git(p.root, "rev-parse", "--git-common-dir"))
    || !Array.isArray(plan.assets.caches) || plan.assets.caches.length > 3 || plan.assets.caches.some(c => !/^\.mex\/wiki\.db(?:-wal|-shm)?$/u.test(c.path) || !/^[a-f0-9]{64}$/u.test(c.hash))
    || (plan.assets.hook && (!validChange(plan.assets.hook) || plan.assets.hook.path !== "hooks/post-commit" || plan.assets.hook.after !== null))
    || resolve(s.worktree, "..") !== resolve(dir) || !/^upgrade-[a-f0-9]{16}$/u.test(s.worktree.slice(s.worktree.lastIndexOf(process.platform === "win32" ? "\\" : "/") + 1))
    || digest(JSON.stringify({ ...plan, revision: "" })) !== plan.revision) {
    throw new KnowledgeError("UPGRADE_STATE", "The upgrade record no longer describes an owned upgrade; it was kept for review.");
  }
  return s;
}
export function pendingUpgrade(options: KnowledgeOptions): { branch: string; step: UpgradeStep } | undefined {
  const dir = projectDirectory(options, false);
  if (!dir) return undefined;
  const value = json(dir, STATE);
  if (!value) return undefined;
  const state = assertState(value, options, dir);
  return { branch: state.plan.branch, step: state.step };
}
export function completedUpgrade(options: KnowledgeOptions): UpgradeResult | undefined {
  const dir = projectDirectory(options, false);
  if (!dir) return undefined;
  const value = json(dir, receipt(knowledgeProject(options).root)) as { version?: number; root?: string; result?: UpgradeResult } | undefined;
  return value?.version === 1 && value.root === knowledgeProject(options).root ? value.result : undefined;
}
function inputs(plan: UpgradePlan): void {
  if (git(plan.root, "rev-parse", "HEAD") !== plan.head || defaultBase(plan.root).sha !== plan.base) throw new KnowledgeError("STALE_PREVIEW", "The checkout or default branch changed; preview the upgrade again.");
  const snapshot = readLegacyScaffold(plan.root);
  if (!snapshot.complete) throw new KnowledgeError("STALE_PREVIEW", "Legacy sources are incomplete or changed.");
  const current = Object.fromEntries([...snapshot.documents, ...snapshot.retained, ...snapshot.config ? [snapshot.config] : [], ...snapshot.log ? [snapshot.log] : []].map(s => [s.path, s.hash]));
  const expected = { ...plan.sources };
  // Local changes deliberately apply before the tracked PR. A recovery may
  // observe any of these exact approved outputs, without accepting new input.
  for (const c of plan.local) if (c.path in expected && readText(plan.root, c.path) === c.after) {
    if (c.after === null) delete expected[c.path];
    else expected[c.path] = `sha256:${digest(c.after)}`;
  }
  if (JSON.stringify(Object.entries(current).sort()) !== JSON.stringify(Object.entries(expected).sort())) throw new KnowledgeError("STALE_PREVIEW", "Legacy sources changed; discard the pending tracked change and preview again.");
  const staged = new Set(git(plan.root, "diff", "--cached", "--name-only").split("\n"));
  for (const c of plan.tracked) if (readText(plan.root, c.path) !== c.before || staged.has(c.path)) throw new KnowledgeError("STALE_PREVIEW", `Upgrade target changed: ${c.path}`);
}
function local(plan: UpgradePlan): void {
  const writer = openRecord({ home: plan.home, projectPath: plan.root });
  writer.db.exec("BEGIN IMMEDIATE");
  try {
    const notes = containedDirectory(plan.home, ["projects", plan.projectId, "notes"], true)!;
    for (const c of plan.personal) {
      const current = readText(notes, c.path);
      if (current === c.after) continue;
      if (current !== null || c.before !== null || c.after === null) throw new KnowledgeError("UPGRADE_COLLISION", "An imported personal entry changed; it was kept.");
      const entry = parseEntry(c.after);
      createEntryFile(notes, entry.mex.id, c.after);
    }
  } finally { writer.db.exec("ROLLBACK"); writer.close(); }
  for (const c of plan.local) applyChange(plan.root, c);
  if (plan.assets.hook) applyChange(plan.assets.gitDirectory, plan.assets.hook);
  for (const cache of plan.assets.caches) {
    const bytes = readBytes(plan.root, cache.path, 64 * 1024 * 1024);
    if (bytes === null) continue;
    if (digest(bytes) !== cache.hash) throw new KnowledgeError("STALE_PREVIEW", `Legacy cache changed: ${cache.path}`);
    // No followed link, recursive deletion or SQLite engine is involved.
    const full = join(plan.root, cache.path), info = lstatSync(full, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) throw new KnowledgeError("UPGRADE_PATH", "Legacy cache is no longer a regular file.");
    unlinkSync(full);
  }
}
function checkpoint(dir: string, state: State, step: UpgradeStep, run: UpgradeRun): void {
  state.step = step; save(dir, STATE, state);
  if (run.stopAfter === step) throw new KnowledgeError("UPGRADE_STOPPED", `Stopped after ${step}.`);
}
function worktree(state: State): void {
  const { plan, worktree: path } = state;
  if (firstLink(path)) throw new KnowledgeError("UPGRADE_LINK", "The upgrade worktree contains a link; it was kept for review.");
  const common = (root: string) => realPath(resolve(root, git(root, "rev-parse", "--git-common-dir")));
  if (common(path) !== common(plan.root) || git(path, "symbolic-ref", "--quiet", "HEAD") !== `refs/heads/${plan.branch}`) throw new KnowledgeError("UPGRADE_CHANGED", "The upgrade worktree identity changed.");
  const allowed = new Set(plan.tracked.map(c => c.path));
  for (const name of [git(path, "diff", "--name-only", "HEAD"), git(path, "ls-files", "--others", "-z")].join("\0").split(/[\n\0]/u).filter(Boolean)) {
    if (!allowed.has(name)) throw new KnowledgeError("UPGRADE_CHANGED", "The upgrade worktree has unrelated changes; it was kept for review.");
  }
}
function publish(state: State, run: UpgradeRun): string {
  const plan = state.plan;
  git(plan.root, "push", "-u", "origin", plan.branch);
  const gh = run.gh ?? ((root: string, args: string[]) => execFileSync("gh", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim());
  const args = ["pr", "view", plan.branch, "--json", "url", "--jq", ".url"];
  try { return gh(plan.root, args); }
  catch { /* no PR yet */ }
  try {
    return gh(plan.root, ["pr", "create", "--base", plan.baseName.replace(/^origin\//u, ""), "--head", plan.branch,
      "--title", "Upgrade MEX knowledge from 0.8", "--body", "Imports preserved legacy knowledge and previews the obsolete workflow cleanup. Legacy code groundings remain not checked until reviewed. Original knowledge documents, logs, Inbox proposals and Relays stay in place."]);
  } catch { throw new KnowledgeError("UPGRADE_PR", `Pushed ${plan.branch}, but gh could not open its pull request. The exact upgrade is retained; retry with mex upgrade --finish --pr.`); }
}
function complete(dir: string, state: State, run: UpgradeRun): UpgradeResult {
  const plan = state.plan;
  if (STEPS.indexOf(state.step) < STEPS.indexOf("written")) inputs(plan);
  if (state.step === "started") { local(plan); checkpoint(dir, state, "local", run); }
  if (plan.tracked.length) {
    if (state.step === "local") {
      if (!existsSync(state.worktree)) {
        // A failed checkout can leave its new branch behind. Reuse it only
        // while it still points at the approved base; anything else is kept.
        let existing: string | undefined;
        try { existing = git(plan.root, "rev-parse", "--verify", "--quiet", `refs/heads/${plan.branch}`); } catch { existing = undefined; }
        if (existing !== undefined && existing !== plan.base) throw new KnowledgeError("UPGRADE_CHANGED", "The upgrade branch changed; it was kept for review.");
        git(plan.root, "-c", `core.hooksPath=${join(state.worktree, ".git", "upgrade-disabled")}`, "worktree", "add", "--quiet",
          ...(existing === undefined ? ["-b", plan.branch, state.worktree, plan.base] : [state.worktree, plan.branch]));
      }
      worktree(state);
      seedOwnedCheckout(state.worktree, plan.base, plan.tracked);
      checkpoint(dir, state, "worktree", run);
    }
    if (state.step !== "committed") {
      worktree(state);
      const head = git(state.worktree, "rev-parse", "HEAD");
      if (head !== plan.base) {
        // A kill may land after commit but before its journal checkpoint.
        if (state.step !== "written" || git(state.worktree, "rev-parse", `${head}^`) !== plan.base) throw new KnowledgeError("UPGRADE_CHANGED", "The upgrade branch changed.");
        const allowed = new Set(plan.tracked.map(c => c.path));
        if (git(state.worktree, "diff", "--name-only", plan.base, head).split("\n").some(path => path && !allowed.has(path)) || git(state.worktree, "diff", "--name-only", "HEAD")) throw new KnowledgeError("UPGRADE_CHANGED", "The upgrade commit has unrelated changes; it was kept for review.");
        for (const c of plan.tracked) if (readText(state.worktree, c.path) !== c.after) throw new KnowledgeError("UPGRADE_CHANGED", `Upgrade output changed: ${c.path}`);
        state.commit = head; checkpoint(dir, state, "committed", run);
      } else {
        for (const c of plan.tracked) applyChange(state.worktree, c);
        checkpoint(dir, state, "written", run);
        for (const c of plan.tracked) {
          if (readText(state.worktree, c.path) !== c.after) throw new KnowledgeError("UPGRADE_CHANGED", `Upgrade output changed: ${c.path}`);
          git(state.worktree, "-c", `core.hooksPath=${join(state.worktree, ".git", "upgrade-disabled")}`, "add", "--force", "--", c.path);
        }
        // Repo hooks are unrelated to importing knowledge and may modify it.
        git(state.worktree, "-c", `core.hooksPath=${join(state.worktree, ".git", "upgrade-disabled")}`, "commit", "-q", "-m", "Upgrade MEX knowledge from 0.8");
        state.commit = git(state.worktree, "rev-parse", "HEAD"); checkpoint(dir, state, "committed", run);
      }
    }
    if (git(plan.root, "rev-parse", `refs/heads/${plan.branch}`) !== state.commit) throw new KnowledgeError("UPGRADE_CHANGED", "The committed upgrade branch changed; it was kept for review.");
    if (existsSync(state.worktree)) { worktree(state); removeWorktree(plan.root, state.worktree); }
    if (run.pr && !state.pr) { state.pr = publish(state, run); save(dir, STATE, state); }
  }
  const result: UpgradeResult = { branch: plan.branch, commit: state.commit ?? null, base: plan.base, files: plan.tracked.map(c => c.path), personal: plan.personal.length,
    local: plan.local.length + plan.assets.caches.length + Number(!!plan.assets.hook), ...(state.pr ? { pr: state.pr } : {}) };
  save(dir, receipt(plan.root), { version: 1, root: plan.root, created: plan.created, result });
  clear(dir);
  return result;
}
export async function runUpgrade(options: KnowledgeOptions, expected: string, run: UpgradeRun = {}): Promise<UpgradeResult> {
  if (completedUpgrade(options)) throw new KnowledgeError("UPGRADE_DONE", "This checkout already has an upgrade; review its recorded branch.");
  // Prepare and compare before initializing the local record or journal.
  const plan = prepareUpgrade(options, run.now);
  if (!plan.ready || plan.revision !== expected) throw new KnowledgeError("STALE_PREVIEW", "The upgrade changed or has blockers; run mex upgrade again.");
  if (!plan.tracked.length && !plan.local.length && !plan.personal.length && !plan.assets.caches.length && !plan.assets.hook) throw new KnowledgeError("UPGRADE_NOTHING", "Nothing needs upgrading.");
  if (plan.tracked.length) requireGitIdentity(plan.root);
  const dir = projectDirectory(options, true)!;
  return withContainedArtifactLock(plan.home, `projects/${plan.projectId}` as RepoRelativePath, "upgrade.lock", () => {
    if (json(dir, STATE)) throw new KnowledgeError("UPGRADE_IN_PROGRESS", "An upgrade is pending; use --finish or --discard.");
    const state: State = { version: 1, plan, step: "started", worktree: join(dir, `upgrade-${randomBytes(8).toString("hex")}`) };
    save(dir, STATE, state, true);
    if (run.stopAfter === "started") throw new KnowledgeError("UPGRADE_STOPPED", "Stopped after started.");
    return complete(dir, state, run);
  });
}
export async function finishUpgrade(options: KnowledgeOptions, run: UpgradeRun = {}): Promise<UpgradeResult> {
  const dir = projectDirectory(options, false);
  if (!dir) throw new KnowledgeError("UPGRADE_NONE", "No unfinished upgrade.");
  const p = knowledgeProject(options);
  return withContainedArtifactLock(p.location.home, `projects/${p.projectId}` as RepoRelativePath, "upgrade.lock", () => {
    const value = json(dir, STATE);
    if (!value) throw new KnowledgeError("UPGRADE_NONE", "No unfinished upgrade.");
    const state = assertState(value, options, dir);
    if (state.plan.tracked.length && state.step !== "committed") requireGitIdentity(state.plan.root);
    return complete(dir, state, run);
  });
}
/** Discard pending tracked output. Already-applied personal/local changes stay. */
export async function discardUpgrade(options: KnowledgeOptions): Promise<{ branch: string; branchKept: boolean; localKept: true }> {
  const dir = projectDirectory(options, false), p = knowledgeProject(options);
  if (!dir) throw new KnowledgeError("UPGRADE_NONE", "No unfinished upgrade.");
  return withContainedArtifactLock(p.location.home, `projects/${p.projectId}` as RepoRelativePath, "upgrade.lock", () => {
    const state = assertState(json(dir, STATE), options, dir), plan = state.plan;
    if (existsSync(state.worktree)) {
      worktree(state);
      for (const c of plan.tracked) {
        const text = readText(state.worktree, c.path);
        if (text !== c.before && text !== c.after) throw new KnowledgeError("UPGRADE_CHANGED", "Edited upgrade output was kept for review.");
        if (git(state.worktree, "ls-tree", "--name-only", "HEAD", "--", c.path)) git(state.worktree, "-c", `core.hooksPath=${join(state.worktree, ".git", "upgrade-disabled")}`, "restore", "--source=HEAD", "--staged", "--worktree", "--", c.path);
        else if (text !== null) { git(state.worktree, "-c", `core.hooksPath=${join(state.worktree, ".git", "upgrade-disabled")}`, "rm", "--cached", "--ignore-unmatch", "--", c.path); applyChange(state.worktree, { path: c.path, before: text, after: null }); }
      }
      removeWorktree(plan.root, state.worktree);
    }
    let branchKept = false;
    try { if (git(plan.root, "rev-parse", `refs/heads/${plan.branch}`) === plan.base) git(plan.root, "branch", "-d", plan.branch); else branchKept = true; } catch { /* no branch yet */ }
    clear(dir);
    return { branch: plan.branch, branchKept, localKept: true };
  });
}
