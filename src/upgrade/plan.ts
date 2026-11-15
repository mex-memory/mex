/** Exact upgrade preview. Scratch worktrees never touch the invoking checkout. */
import { existsSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knowledgeProject, type KnowledgeOptions } from "../knowledge/context.js";
import { KnowledgeError, serializeEntry } from "../knowledge/entry.js";
import { gateEntry } from "../knowledge/gates.js";
import { containedDirectory } from "../knowledge/files.js";
import { references } from "../knowledge/references.js";
import { defaultBase, git } from "../knowledge/share-plan.js";
import { firstLink, removeWorktree } from "../knowledge/share-state.js";
import { writeSharedKnowledgeFiles } from "../knowledge/share.js";
import { applyTeamWrite, prepareTeamWrite } from "../knowledge/team.js";
import { upgradeDiff } from "./diff.js";
import { planLegacyCleanup, type UpgradeFileChange } from "./cleanup-plan.js";
import { convertLegacy } from "./convert-legacy.js";
import { readLegacyScaffold } from "./legacy-reader.js";
import { oldAssets, type OldAssets, type UpgradeIssue } from "./local-plan.js";
import { applyChange, digest, readText, safePath } from "./safe-files.js";

export interface UpgradePlan {
  root: string; projectId: string; home: string; head: string; base: string; baseName: string; branch: string; created: string;
  revision: string; ready: boolean; present: boolean;
  /** Complete source inventory, including preserved Inbox/Relay records. */
  sources: Record<string, string>;
  tracked: UpgradeFileChange[]; local: UpgradeFileChange[]; personal: UpgradeFileChange[];
  assets: OldAssets; issues: UpgradeIssue[]; retained: string[]; entries: Array<{ id: string; level: "team" | "personal"; one_line: string }>;
  diff: string;
}

function branch(root: string, date: string): string {
  for (let n = 1; n < 100; n++) {
    const value = `mex/upgrade-${date}${n === 1 ? "" : `-${n}`}`;
    try { git(root, "show-ref", "--verify", "--quiet", `refs/heads/${value}`); }
    catch { return value; }
  }
  throw new KnowledgeError("UPGRADE_BRANCH", "Too many upgrade branches today; review the old ones first.");
}
const tracked = (root: string, path: string) => !!git(root, "ls-files", "--", path);

/** Scratch writes reuse team evidence/privacy gates and shared-file ownership. */
export function prepareUpgrade(options: KnowledgeOptions, now = new Date()): UpgradePlan {
  const project = knowledgeProject(options), root = project.root;
  const base = defaultBase(root), created = now.toISOString().slice(0, 10);
  const snapshot = readLegacyScaffold(root), assets = oldAssets(root);
  const cleanup = planLegacyCleanup(snapshot), conversion = convertLegacy(snapshot, created);
  const plan: UpgradePlan = { root, projectId: project.projectId, home: project.location.home, head: git(root, "rev-parse", "HEAD"), base: base.sha, baseName: base.name,
    branch: branch(root, created), created, ready: snapshot.complete, present: snapshot.present, revision: "", sources: {},
    tracked: [], local: [], personal: [], assets, issues: [...snapshot.diagnostics.map(d => ({ code: d.code, path: d.path, blocking: true })), ...cleanup.issues, ...conversion.issues, ...assets.issues],
    retained: [...snapshot.retained.map(s => s.path), ...conversion.preserved, ...snapshot.excluded], entries: [], diff: "" };
  for (const source of [...snapshot.documents, ...snapshot.retained, ...snapshot.config ? [snapshot.config] : [], ...snapshot.log ? [snapshot.log] : []]) plan.sources[source.path] = source.hash;
  const staged = new Set(git(root, "diff", "--cached", "--name-only", "--no-renames").split("\n"));
  const requireBase = (path: string) => {
    // Git's own clean test accounts for attributes and platform line endings.
    try {
      git(root, "diff", "--quiet", "--no-ext-diff", base.sha, "--", path);
      if (staged.has(path)) throw new Error("staged source");
    } catch { plan.issues.push({ code: "SOURCE_NOT_ON_BASE", path, blocking: true }); }
  };
  for (const path of Object.keys(plan.sources)) if (tracked(root, path)) requireBase(path);
  for (const cache of assets.caches) if (tracked(root, cache.path)) plan.issues.push({ code: "TRACKED_CACHE_REVIEW", path: cache.path, blocking: true });
  const removals = [...cleanup.changes, ...assets.skills];
  for (const change of removals) {
    if (tracked(root, change.path)) { requireBase(change.path); plan.tracked.push(change); }
    else plan.local.push(change);
  }
  if (assets.hook) {
    // A hook is an explicit local change; its exact bytes are in the preview.
    plan.diff += upgradeDiff("post-commit (local Git hook)", assets.hook.before, assets.hook.after);
  }
  const team = [];
  const context = references(root);
  const notesRoot = existsSync(project.location.home) ? containedDirectory(project.location.home, ["projects", project.projectId, "notes"]) : undefined;
  for (const candidate of conversion.candidates) {
    const level = !candidate.source.line && tracked(root, candidate.source.path) ? "team" : "personal";
    if (project.retired.has(candidate.entry.mex.id)) { plan.issues.push({ code: "RETIRED_ENTRY", path: candidate.source.path }); continue; }
    try {
      const entry = gateEntry(candidate.entry, context);
      // Sanitizing prose is visible in the entry diff, but old evidence may
      // never be transformed by a gate while being imported.
      if (JSON.stringify(entry.mex.checks.filter(c => c.kind === "legacy-grounding")) !== JSON.stringify(candidate.entry.mex.checks.filter(c => c.kind === "legacy-grounding"))) throw new Error("altered grounding");
      if (level === "team") team.push(entry);
      else {
        const path = `${entry.mex.id}.md`, after = serializeEntry(entry);
        const before = notesRoot ? readText(notesRoot, path) : null;
        if (before !== null && before !== after) { plan.issues.push({ code: "ENTRY_EXISTS", path: `personal/${path}`, blocking: true }); continue; }
        if (before === null) plan.personal.push({ path, before, after });
      }
      plan.entries.push({ id: entry.mex.id, level, one_line: entry.mex.one_line });
    } catch { plan.issues.push({ code: "ENTRY_GATE_REVIEW", path: candidate.source.path }); }
  }
  if (plan.issues.some(i => i.blocking)) plan.ready = false;
  if (plan.ready && (team.length || plan.tracked.length)) {
    const parent = mkdtempSync(join(tmpdir(), "mex-upgrade-preview-")), worktree = join(parent, "repo");
    let completed = false;
    const paths = new Set(plan.tracked.map(c => c.path));
    try {
      // .git is a regular pointer file in a worktree, so this hook directory
      // cannot exist. Preview must never execute a repo's post-checkout hook.
      git(root, "-c", `core.hooksPath=${join(worktree, ".git", "upgrade-disabled")}`, "worktree", "add", "--quiet", "--detach", worktree, base.sha);
      if (firstLink(worktree)) throw new KnowledgeError("UPGRADE_LINK", "The upgrade base contains a link; its scratch worktree was kept for review.");
      const shared = { ...options, projectPath: worktree };
      for (const entry of team) {
        const ownPath = `.mex/learned/${entry.mex.id}.md`;
        if (readText(worktree, ownPath) === serializeEntry(entry)) { paths.add(ownPath); continue; }
        const preview = prepareTeamWrite(entry, shared);
        // An import never overwrites another stable identity, even if active.
        if (preview.before !== null && preview.before !== preview.after) throw new KnowledgeError("UPGRADE_COLLISION", `An entry already uses ${entry.mex.id}; review it before upgrading.`);
        paths.add(preview.path);
        if (preview.before === null) applyTeamWrite(preview, preview.revision, shared);
      }
      for (const change of plan.tracked) applyChange(worktree, change);
      // Source inventory/config and generated native files travel in the same
      // reviewed PR as the entries, exactly as they do for mex share.
      if (snapshot.present || team.length) for (const path of writeSharedKnowledgeFiles(shared)) paths.add(path);
      const output: UpgradeFileChange[] = [];
      for (const path of [...paths].sort()) {
        if (!safePath(path)) throw new KnowledgeError("UPGRADE_PATH", "An upgrade output path is unsafe.");
        const after = readText(worktree, path);
        const onBase = !!git(root, "ls-tree", "--name-only", base.sha, "--", path);
        const current = readText(root, path);
        let before: string | null = null;
        if (onBase) { requireBase(path); before = current; }
        else if (current !== null) plan.issues.push({ code: "DESTINATION_EXISTS", path, blocking: true });
        if (before !== after) output.push({ path, before, after });
      }
      plan.tracked = output;
      // Restore only the exact output we just observed. Git itself removes
      // the worktree; extra files or redirects always stop cleanup.
      for (const change of output) {
        if (readText(worktree, change.path) !== change.after) throw new KnowledgeError("UPGRADE_CHANGED", "The upgrade scratch output changed.");
        if (change.before === null) applyChange(worktree, { ...change, before: change.after, after: null });
        else git(worktree, "-c", `core.hooksPath=${join(worktree, ".git", "upgrade-disabled")}`, "restore", "--source=HEAD", "--worktree", "--", change.path);
      }
      completed = true;
    } catch (error) {
      // No broad cleanup after a partial write: the exact worktree is reviewable.
      throw Object.assign(new KnowledgeError("UPGRADE_PREVIEW", `${error instanceof KnowledgeError ? error.message : "Could not prepare the upgrade."} Scratch kept at ${worktree}`), { cause: error });
    } finally {
      if (completed) { removeWorktree(root, worktree); rmdirSync(parent); }
    }
  }
  if (plan.issues.some(i => i.blocking)) plan.ready = false;
  for (const change of [...plan.tracked, ...plan.local]) plan.diff += upgradeDiff(change.path, change.before, change.after);
  for (const change of plan.personal) plan.diff += upgradeDiff(`personal/${change.path}`, null, change.after);
  for (const cache of assets.caches) plan.diff += `Remove local disposable cache ${cache.path} (${cache.bytes} bytes, sha256:${cache.hash})\n`;
  if (Buffer.byteLength(JSON.stringify(plan)) > 16 * 1024 * 1024) throw new KnowledgeError("UPGRADE_LIMIT", "Upgrade preview exceeds its byte limit; no changes applied.");
  plan.revision = digest(JSON.stringify(plan));
  return plan;
}
