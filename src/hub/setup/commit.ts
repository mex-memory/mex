import { AGENT_SKILL_TARGETS, OFFICIAL_MEX_SKILLS } from "../../agent-skills/types.js";
import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SETUP_COMMIT_MAX_FILES,
  SETUP_COMMIT_MAX_FILE_BYTES,
  SETUP_COMMIT_MAX_FILE_DIFF_CHARACTERS,
  SETUP_COMMIT_MAX_TOTAL_DIFF_CHARACTERS,
  type SetupCommitDiff,
  type SetupCommitDiffRequest,
  type SetupCommitFile,
  type SetupCommitPreview,
  type SetupCommitRequest,
  type SetupCommitResult,
} from "@mex/hub-contracts/setup";
import type { AiTool } from "../../types.js";
import { HubHttpError } from "../http/errors.js";

const PREVIEW_LIFETIME_MS = 5 * 60_000;
const MAX_INDEX_BYTES = 16 * 1_048_576;
const MAX_GIT_OUTPUT_BYTES = 4 * 1_048_576;
const operationDeadline = new AsyncLocalStorage<number>();
const COMMIT_HOOKS = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "reference-transaction"];
const ANCHORS: Record<AiTool, string> = {
  claude: "CLAUDE.md", codex: "AGENTS.md", cursor: ".cursorrules", windsurf: ".windsurfrules",
  copilot: ".github/copilot-instructions.md", opencode: ".opencode/opencode.json",
};
const ACTIVE_OPERATIONS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG"];

interface GitContext {
  root: string;
  gitDir: string;
  index: string;
  head: string | null;
  ref: string | null;
  identity: string;
}
interface Snapshot {
  git: GitContext;
  fingerprint: string;
  paths: string[];
  indexBytes: Buffer | null;
}
/** The preview lists metadata; the diff text stays here and is served one file at a time. */
interface ReviewedFile {
  path: string;
  status: SetupCommitFile["status"];
  diff: string;
  truncated: boolean;
}
interface Review {
  preview: SetupCommitPreview;
  files: ReviewedFile[];
  tools: readonly AiTool[];
  fingerprint: string;
  tree: string;
}
interface Candidate {
  index: string;
  tree: string;
  files: ReviewedFile[];
  blockedReason: string | null;
}

/** A local, explicitly reviewed setup commit. Never stages arbitrary project files or pushes. */
export class SetupCommitService {
  private readonly projectRoot: string;
  private readonly now: () => number;
  private review: Review | null = null;
  private receipt: { revision: string; requestedMessage: string; result: SetupCommitResult } | null = null;
  private active: Promise<unknown> | null = null;
  private closed = false;

  constructor(options: { projectRoot: string; now?: () => number | Date }) {
    this.projectRoot = resolve(options.projectRoot);
    this.now = () => Number(options.now?.() ?? Date.now());
  }

  clear(): void { this.review = null; }

  /** A manual index recovery must be verified before the runner promotes setup to ready. */
  verifyRecovery(): Promise<void> {
    return this.exclusive(async () => {
      const receipt = this.receipt;
      if (!receipt?.result.recoveryRequired) return;
      const context = await this.gitContext();
      if (await exists(`${context.index}.lock`)) throw blocked("Git index recovery is still pending. Inspect the retained index.lock file and finish recovery manually before opening Hub.");
      for (const name of ACTIVE_OPERATIONS) {
        if (await exists(join(context.gitDir, name))) throw blocked("Finish the active Git operation before verifying index recovery.");
      }
      if ((await git(context.root, ["ls-files", "--unmerged", "-z"])).text !== "") throw blocked("Resolve Git index conflicts before verifying setup recovery.");
      const staged = await git(context.root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--quiet", "--exit-code", "--", ...receipt.result.files], { allowFailure: true });
      if (staged.code !== 0) throw blocked("The setup files still differ between Git's index and HEAD. Finish the manual index recovery before opening Hub.");
      const { recoveryRequired: _recovered, ...result } = receipt.result;
      receipt.result = result;
    });
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.clear();
    await this.active?.catch(() => undefined);
  }

  preview(tools: readonly AiTool[]): Promise<SetupCommitPreview> {
    return this.exclusive(async () => {
      this.clear();
      const preview: SetupCommitPreview = {
        revision: randomUUID(), expiresAt: new Date(this.now() + PREVIEW_LIFETIME_MS).toISOString(),
        branch: null, head: null, defaultMessage: "chore: initialize MEX", files: [],
        canCommit: false, blockedReason: null,
      };
      const temporary = await mkdtemp(join(tmpdir(), "mex-setup-review-"));
      try {
        const selected = [...new Set(tools)];
        const snapshot = await this.snapshot(selected);
        preview.branch = snapshot.git.ref?.replace(/^refs\/heads\//u, "") ?? null;
        preview.head = snapshot.git.head;
        const candidate = await this.candidate(snapshot, temporary);
        preview.files = candidate.files.map(fileSummary);
        preview.blockedReason = candidate.blockedReason;
        if ((await this.snapshot(selected)).fingerprint !== snapshot.fingerprint) throw stale();
        if (preview.files.length === 0 && preview.blockedReason === null) {
          preview.blockedReason = "There are no setup file changes to commit. Refresh setup, or use Git manually if other files need attention.";
        }
        preview.canCommit = preview.files.length > 0 && preview.blockedReason === null;
        // A blocked review stays readable so its diffs can guide the manual commit.
        if (preview.files.length > 0) {
          this.review = { preview, files: candidate.files, tools: selected, fingerprint: snapshot.fingerprint, tree: candidate.tree };
        }
      } catch (error) {
        preview.blockedReason = safeReason(error);
      } finally {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      }
      // Caller mutations cannot change the authorization stored by this service.
      return structuredClone(preview);
    });
  }

  /** Reads retained review text only; it never runs Git or rereads the working tree. */
  diff(request: SetupCommitDiffRequest): SetupCommitDiff {
    if (this.closed) throw blocked("The setup session has closed. Reopen Hub to continue.");
    const review = this.review;
    if (review === null || request.revision !== review.preview.revision
      || this.now() >= Date.parse(review.preview.expiresAt)) throw stale();
    const file = review.files.find((entry) => entry.path === request.path);
    if (file === undefined) throw new HubHttpError(404, "NOT_FOUND", "File not in review", "This file is not part of the current setup review.");
    return { revision: review.preview.revision, path: file.path, diff: file.diff, truncated: file.truncated };
  }

  commit(request: SetupCommitRequest): Promise<SetupCommitResult> {
    return this.exclusive(async () => {
      const message = request.message.trim();
      if (!message || message.length > 2_000 || message.includes("\0")) {
        throw blocked("Enter a commit message between 1 and 2,000 characters.", 400);
      }
      if (this.receipt?.revision === request.revision) {
        if (this.receipt.requestedMessage !== message) throw stale();
        return structuredClone(this.receipt.result);
      }
      const review = this.review;
      if (review === null || !review.preview.canCommit || request.revision !== review.preview.revision
        || this.now() >= Date.parse(review.preview.expiresAt)) throw stale();
      // Consume the review before work starts, including on a failed commit.
      this.clear();
      const temporary = await mkdtemp(join(tmpdir(), "mex-setup-commit-"));
      let lock: Awaited<ReturnType<typeof open>> | null = null;
      let lockPath: string | null = null;
      let keepLock = false;
      let committed: string | null = null;
      let original: GitContext | null = null;
      try {
        const snapshot = await this.snapshot(review.tools);
        original = snapshot.git;
        if (snapshot.fingerprint !== review.fingerprint) throw stale();
        const requestedLock = `${snapshot.git.index}.lock`;
        try {
          lock = await open(requestedLock, "wx", 0o600);
          lockPath = requestedLock;
        } catch { throw blocked("Git is busy or its index cannot be locked. Finish other Git operations, then review again."); }
        const candidate = await this.candidate(snapshot, temporary);
        if (candidate.blockedReason !== null || candidate.tree !== review.tree
          || JSON.stringify(candidate.files) !== JSON.stringify(review.files)) throw stale();
        const merged = await this.mergedIndex(snapshot, candidate, temporary);
        // Both the real index and every reviewed working file must still be the reviewed version.
        if ((await this.snapshot(review.tools)).fingerprint !== review.fingerprint) throw stale();
        await lock.writeFile(merged);
        await lock.sync();

        // Create the exact reviewed tree and parent before publishing any ref. Hooks are
        // explicitly unsupported; identity and configured signing retain normal Git behavior.
        const signing = await git(original.root, ["config", "--type=bool", "--get", "commit.gpgSign"], { allowFailure: true });
        const result = await git(original.root, ["commit-tree", candidate.tree,
          ...(original.head === null ? [] : ["-p", original.head]),
          ...(signing.text.trim() === "true" ? ["-S"] : []), "-F", "-"], {
          input: message + "\n", timeout: 120_000, allowFailure: true,
        });
        if (result.code !== 0) {
          throw blocked("Git could not create the reviewed commit. Check your Git identity and signing setup, then review again or commit manually.");
        }
        const commitObject = objectId(result.text.trim());
        if ((await this.snapshot(review.tools)).fingerprint !== review.fingerprint) throw stale();
        // Git's prepared transaction holds both HEAD and its referent. Check branch identity
        // under those locks before publishing, including a branch switched to the same old oid.
        await publishCommit(original, commitObject, async () => {
          if ((await this.snapshot(review.tools)).fingerprint !== review.fingerprint) throw stale();
        });
        committed = commitObject;
        const currentIndex = await optionalFile(original.index, MAX_INDEX_BYTES);
        if (hashNullable(currentIndex) !== hashNullable(snapshot.indexBytes)) throw stale();
        await lock.close();
        lock = null;
        await rename(lockPath, original.index);
        lockPath = null;
        const response: SetupCommitResult = {
          commit: committed, files: candidate.files.map((file) => file.path),
          message: "Setup committed locally. Nothing was pushed.",
        };
        this.receipt = { revision: request.revision, requestedMessage: message, result: response };
        return structuredClone(response);
      } catch (error) {
        if (error instanceof PublicationUncertainError) keepLock = true;
        if (committed !== null && original !== null) {
          // If index installation failed, restore only the exact ref value created by this operation.
          const target = original.ref ?? "HEAD";
          const rollback = await git(original.root, original.head === null
            ? ["update-ref", "-d", target, committed]
            : ["update-ref", target, original.head, committed], { allowFailure: true, recovery: true }).catch(() => null);
          if (rollback?.code !== 0) {
            // A known commit must never be presented as a failed/no-op request (or duplicated on retry).
            keepLock = true;
            const response: SetupCommitResult = {
              commit: committed, files: review.files.map((file) => file.path),
              recoveryRequired: true,
              message: "The setup commit was created, but Git changed before its index could be installed. Nothing was pushed. Keep the Git index.lock recovery file and inspect Git status before continuing manually.",
            };
            this.receipt = { revision: request.revision, requestedMessage: message, result: response };
            return structuredClone(response);
          }
        }
        if (error instanceof HubHttpError) throw error;
        throw blocked(safeReason(error));
      } finally {
        await lock?.close().catch(() => undefined);
        if (lockPath !== null && !keepLock) await rm(lockPath, { force: true }).catch(() => undefined);
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      }
    }, 120_000);
  }

  private exclusive<T>(operation: () => Promise<T>, budget = 60_000): Promise<T> {
    if (this.closed) return Promise.reject(blocked("The setup session has closed. Reopen Hub to continue."));
    if (this.active !== null) return Promise.reject(new HubHttpError(409, "JOB_ALREADY_RUNNING", "Git operation running", "Wait for the current setup review or commit to finish."));
    const active = operationDeadline.run(Date.now() + budget, operation);
    this.active = active;
    void active.finally(() => { if (this.active === active) this.active = null; }).catch(() => undefined);
    return active;
  }

  private async gitContext(): Promise<GitContext> {
    const root = await realpath(this.projectRoot);
    const rootStat = await lstat(this.projectRoot);
    if (root !== this.projectRoot || !rootStat.isDirectory() || rootStat.isSymbolicLink()) throw blocked("Open the physical repository root to review setup files safely.");
    const top = (await git(root, ["rev-parse", "--show-toplevel"])).text.trim();
    if (await realpath(top) !== root) throw blocked("Setup commits are available only from the Git repository root. Commit manually in this folder.");
    const gitDir = (await git(root, ["rev-parse", "--absolute-git-dir"])).text.trim();
    const index = resolve(root, (await git(root, ["rev-parse", "--git-path", "index"])).text.trim());
    const headResult = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFailure: true });
    const refResult = await git(root, ["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true });
    const head = headResult.code === 0 ? objectId(headResult.text.trim()) : null;
    const ref = refResult.code === 0 ? refResult.text.trim() : null;
    if ((head === null && ref === null) || (ref !== null && (!ref.startsWith("refs/heads/") || ref.length > 1_035 || /[\x00-\x20\x7f]/u.test(ref)))) throw blocked("This Git HEAD cannot be reviewed safely. Repair it or commit manually.");
    const gitStat = await lstat(gitDir);
    if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) throw blocked("The Git directory is linked or unavailable. Commit setup manually.");
    return {
      root, gitDir, index, head, ref,
      identity: `${root}:${rootStat.dev}:${rootStat.ino}:${rootStat.birthtimeMs}:${gitDir}:${gitStat.dev}:${gitStat.ino}`,
    };
  }

  private async snapshot(tools: readonly AiTool[]): Promise<Snapshot> {
    const context = await this.gitContext();
    if (context.ref === null) throw blocked("Switch to a named Git branch before committing setup in Hub, or commit manually from detached HEAD.");
    const fingerprint = createHash("sha256");
    fingerprint.update(JSON.stringify(context));
    for (const name of ACTIVE_OPERATIONS) {
      if (await exists(join(context.gitDir, name))) throw blocked("Finish the active merge, rebase, cherry-pick, revert or bisect before committing setup in Hub.");
    }
    const unmerged = await git(context.root, ["ls-files", "--unmerged", "-z"]);
    if (unmerged.text.length > 0) throw blocked("Resolve Git index conflicts before committing setup in Hub.");
    // Hash effective config, including includes/global configuration: signing, ignore and attribute behavior are review inputs.
    const config = await git(context.root, ["config", "--null", "--list"]);
    fingerprint.update(config.bytes);
    fingerprint.update(JSON.stringify(Object.entries(process.env).filter(([key]) => /^(?:GIT_(?:AUTHOR|COMMITTER)_|EMAIL$)/u.test(key)).sort()));
    const hookConfig = await git(context.root, ["config", "--path", "--get", "core.hooksPath"], { allowFailure: true });
    const hooksPath = hookConfig.code === 0
      ? resolve(context.root, hookConfig.text.trim())
      : resolve(context.root, (await git(context.root, ["rev-parse", "--git-path", "hooks"])).text.trim());
    fingerprint.update(hooksPath);
    for (const name of COMMIT_HOOKS) {
      const path = join(hooksPath, name);
      try {
        const stat = await lstat(path);
        fingerprint.update(`${name}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ino}`);
        if (stat.isSymbolicLink() || (stat.mode & 0o111) !== 0 || process.platform === "win32") {
          throw blocked("This repository has active Git commit or reference hooks. Run the setup commit manually so those hooks can be reviewed and respected.");
        }
      } catch (error) { if (!missing(error)) throw error; }
    }
    const indexBytes = await optionalFile(context.index, MAX_INDEX_BYTES);
    fingerprint.update(hashNullable(indexBytes));
    for (const directory of [".mex", ".mex/context", ".mex/patterns"]) {
      await safeAncestors(context.root, `${directory}/_`);
    }
    const prefixes = scopePrefixes(tools);
    for (const prefix of prefixes) await safeAncestors(context.root, prefix);
    const listed = await git(context.root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...prefixes]);
    const paths = [...new Set(listed.text.split("\0").filter((path) => path !== "" && inScope(path, tools)))].sort();
    if (paths.length > SETUP_COMMIT_MAX_FILES) throw blocked("Setup contains more than 200 files. Review and commit these files manually.");
    for (const path of paths) {
      checkDeadline();
      if (!safePath(path)) throw blocked("A setup file has an unsupported path. Rename it or commit manually.");
      await safeAncestors(context.root, path);
      const bytes = await optionalFile(join(context.root, path), SETUP_COMMIT_MAX_FILE_BYTES);
      if (bytes !== null) textBytes(bytes);
      fingerprint.update(`${path}\0${hashNullable(bytes)}\0`);
      const stat = await lstat(join(context.root, path)).catch((error: unknown) => { if (missing(error)) return null; throw error; });
      fingerprint.update(`${stat?.mode ?? "missing"}\0`);
    }
    if (paths.length > 0) {
      const attributes = await git(context.root, ["check-attr", "-z", "--all", "--stdin"], { input: paths.join("\0") + "\0" });
      fingerprint.update(attributes.bytes);
      const parts = attributes.text.split("\0");
      for (let offset = 0; offset + 2 < parts.length; offset += 3) {
        if (["filter", "working-tree-encoding"].includes(parts[offset + 1]!) && !["unset", "unspecified"].includes(parts[offset + 2]!)) {
          throw blocked("Setup files use a custom Git clean filter or working-tree encoding. Commit manually so the reviewed content and committed bytes stay consistent.");
        }
      }
    }
    return { git: context, fingerprint: fingerprint.digest("hex"), paths, indexBytes };
  }

  private async candidate(snapshot: Snapshot, temporary: string): Promise<Candidate> {
    const index = join(temporary, "candidate-index");
    await git(snapshot.git.root, ["read-tree", snapshot.git.head ?? "--empty"], { index });
    if (snapshot.paths.length > 0) await git(snapshot.git.root, ["add", "-A", "--", ...snapshot.paths], { index });
    const tree = objectId((await git(snapshot.git.root, ["write-tree"], { index })).text.trim());
    const changed = await git(snapshot.git.root, ["diff", "--cached", "--name-status", "--no-renames", "-z"], { index });
    const fields = changed.text.split("\0");
    const files: ReviewedFile[] = [];
    let total = 0;
    let blockedReason: string | null = null;
    for (let offset = 0; offset + 1 < fields.length && fields[offset] !== ""; offset += 2) {
      const status = fields[offset];
      const path = fields[offset + 1]!;
      if (!snapshot.paths.includes(path) || !["A", "M", "D"].includes(status!)) throw blocked("The setup diff includes an unsupported file change. Commit manually.");
      // Read both Git blobs, not just the working file: binary or huge old content cannot be hidden by a small replacement.
      for (const revision of [snapshot.git.head, tree]) {
        if (revision === null) continue;
        const entry = await git(snapshot.git.root, ["ls-tree", "-z", revision, "--", path]);
        if (entry.text === "") continue;
        const match = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t/u.exec(entry.text);
        if (match === null) throw blocked("Setup includes a symlink, submodule or unsupported Git file mode. Commit manually.");
        const size = Number((await git(snapshot.git.root, ["cat-file", "-s", match[2]!])).text.trim());
        if (!Number.isSafeInteger(size) || size > SETUP_COMMIT_MAX_FILE_BYTES) throw blocked("A setup file exceeds the 256 KiB review limit. Commit it manually.");
        textBytes((await git(snapshot.git.root, ["cat-file", "blob", match[2]!])).bytes);
      }
      const raw = (await git(snapshot.git.root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--text", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--", path], { index })).text;
      const available = Math.max(0, Math.min(SETUP_COMMIT_MAX_FILE_DIFF_CHARACTERS, SETUP_COMMIT_MAX_TOTAL_DIFF_CHARACTERS - total));
      const diff = sliceText(raw, available);
      const truncated = diff.length !== raw.length;
      total += diff.length;
      files.push({ path, status: status === "A" ? "added" : status === "D" ? "deleted" : "modified", diff, truncated });
      if (truncated) blockedReason = "The setup diff exceeds Hub's complete review limit. Review and commit these files manually.";
    }
    return { index, tree, files, blockedReason };
  }

  private async mergedIndex(snapshot: Snapshot, candidate: Candidate, temporary: string): Promise<Buffer> {
    const index = join(temporary, "merged-index");
    if (snapshot.indexBytes !== null) {
      const file = await open(index, "wx", 0o600);
      try { await file.writeFile(snapshot.indexBytes); } finally { await file.close(); }
    } else {
      await git(snapshot.git.root, ["read-tree", "--empty"], { index });
    }
    // Convert split indexes to a self-contained index before moving it out of this temporary directory.
    await git(snapshot.git.root, ["update-index", "--no-split-index"], { index });
    const entries = await git(snapshot.git.root, ["ls-files", "--stage", "-z", "--", ...candidate.files.map((file) => file.path)], { index: candidate.index });
    const deletions = candidate.files.filter((file) => file.status === "deleted")
      .map((file) => `0 ${"0".repeat(candidate.tree.length)}\t${file.path}\0`).join("");
    await git(snapshot.git.root, ["update-index", "-z", "--index-info"], { index, input: entries.text + deletions });
    return (await optionalFile(index, MAX_INDEX_BYTES))!;
  }
}

function fileSummary(file: ReviewedFile): SetupCommitFile {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of file.diff.split("\n")) {
    // Header lines such as "--- a/path" precede the first hunk; inside hunks they are content.
    if (line.startsWith("@@ ")) inHunk = true;
    else if (inHunk && line.startsWith("+")) additions++;
    else if (inHunk && line.startsWith("-")) deletions++;
  }
  return { path: file.path, status: file.status, additions, deletions, diffCharacters: file.diff.length, truncated: file.truncated };
}
function skillRoots(tool: AiTool): string[] {
  return tool === "claude" || tool === "codex" ? OFFICIAL_MEX_SKILLS.map(skill => `${AGENT_SKILL_TARGETS[tool].skillsDirectory}/${skill}`) : [];
}
function scopePrefixes(tools: readonly AiTool[]): string[] {
  return [".mex", ...tools.flatMap(tool => [ANCHORS[tool], ...skillRoots(tool)])];
}
function inScope(path: string, tools: readonly AiTool[]): boolean {
  if (path === ".mex/config.json" || path === ".mex/.gitignore" || /^\.mex\/[^/]+\.md$/u.test(path)
    || /^\.mex\/(?:context|patterns)\/.+\.md$/u.test(path)) return true;
  return tools.some(tool => path === ANCHORS[tool] || skillRoots(tool).some(root => path.startsWith(`${root}/`)));
}
function safePath(path: string): boolean {
  return path.length <= 1_024 && !/[\\\x00-\x1f\x7f]/u.test(path)
    && !path.startsWith("/") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
async function safeAncestors(root: string, path: string): Promise<void> {
  const components = path.split("/");
  for (let end = 1; end < components.length; end++) {
    try {
      const stat = await lstat(join(root, ...components.slice(0, end)));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw blocked("A setup directory is linked or is not a directory. Commit these files manually.");
    } catch (error) { if (missing(error)) return; throw error; }
  }
}
async function optionalFile(path: string, maximum: number): Promise<Buffer | null> {
  let file: Awaited<ReturnType<typeof open>>;
  try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if (missing(error)) return null; throw blocked("A setup file or Git index is linked or cannot be read safely. Commit manually."); }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw blocked("A setup path is not a regular file. Commit manually.");
    if (stat.size > maximum) throw blocked(maximum === SETUP_COMMIT_MAX_FILE_BYTES
      ? "A setup file exceeds the 256 KiB review limit. Commit it manually."
      : "This Git index exceeds Hub's review limit. Commit setup manually.");
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw stale();
    return buffer.subarray(0, bytesRead);
  } finally { await file.close(); }
}
function textBytes(bytes: Buffer): string {
  if (bytes.includes(0)) throw blocked("A setup file contains binary content. Review and commit it manually.");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw blocked("A setup file is not UTF-8 text. Review and commit it manually."); }
}
function hashNullable(value: Buffer | null): string { return value === null ? "missing" : createHash("sha256").update(value).digest("hex"); }
function missing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"); }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; } }
function objectId(value: string): string { if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) throw blocked("Git returned an unsupported object identity. Commit setup manually."); return value; }
function sliceText(value: string, maximum: number): string {
  const end = maximum > 0 && /[\uD800-\uDBFF]/u.test(value[maximum - 1] ?? "") ? maximum - 1 : maximum;
  return value.slice(0, end);
}
function stale(): HubHttpError { return new HubHttpError(409, "REVISION_CONFLICT", "Review changed", "The Git branch, index, setup files or Git settings changed, or the review expired. Review the latest diff before committing."); }
function blocked(detail: string, status = 409): HubHttpError { return new HubHttpError(status, "CAPABILITY_UNAVAILABLE", "Setup commit unavailable", detail); }
class PublicationUncertainError extends HubHttpError {
  constructor() {
    super(409, "CAPABILITY_UNAVAILABLE", "Inspect Git before continuing", "Git did not confirm whether the setup commit was published. The prepared index.lock recovery file was retained. Inspect Git status and history and recover the index manually before reviewing again. Nothing was pushed.");
  }
}
function safeReason(error: unknown): string { return error instanceof HubHttpError ? error.message : "Git could not safely review these setup files. Check Git status and commit setup manually."; }
function checkDeadline(): number {
  const remaining = (operationDeadline.getStore() ?? (Date.now() + 15_000)) - Date.now();
  if (remaining <= 0) throw blocked("The setup Git operation exceeded its time limit. Review again or commit manually.");
  return remaining;
}

async function git(root: string, args: string[], options: {
  index?: string; input?: string; timeout?: number; allowFailure?: boolean; recovery?: boolean;
} = {}): Promise<{ text: string; bytes: Buffer; code: number }> {
  const env = gitEnvironment();
  if (options.index !== undefined) env.GIT_INDEX_FILE = options.index;
  return new Promise((resolvePromise, reject) => {
    const child = execFile("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd: root, env, encoding: "buffer", maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: Math.max(1, Math.min(options.timeout ?? 15_000, options.recovery ? 15_000 : checkDeadline())), windowsHide: true,
    }, (error, stdout) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
      if (code !== 0 && (!options.allowFailure || code < 0)) reject(blocked("Git could not complete this bounded setup operation. Check Git status and commit manually."));
      else resolvePromise({ text: stdout.toString("utf8"), bytes: stdout, code });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input ?? "");
  });
}

function gitEnvironment(): NodeJS.ProcessEnv {
  // Preserve identity, signing and config-location settings while removing repository redirection.
  const redirects = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_PREFIX", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !redirects.has(key)));
  Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" });
  return env;
}

async function publishCommit(context: GitContext, commit: string, verify: () => Promise<void>): Promise<void> {
  let published = false;
  let commitSent = false;
  let prepared = false;
  let pending = "";
  let finish!: (code: number) => void;
  let prepare!: () => void;
  let rejectPreparation!: (error: unknown) => void;
  const finished = new Promise<number>((resolvePromise) => { finish = resolvePromise; });
  const preparation = new Promise<void>((resolvePromise, reject) => { prepare = resolvePromise; rejectPreparation = reject; });
  const child = execFile("git", ["-c", "core.fsmonitor=false", "update-ref", "-m", "commit: initialize MEX", "--stdin"], {
    cwd: context.root, env: gitEnvironment(), encoding: "utf8", maxBuffer: 16_384,
    timeout: checkDeadline(), windowsHide: true,
  }, (error) => {
    if (!prepared) rejectPreparation(stale());
    finish(error === null ? 0 : 1);
  });
  child.stdout?.on("data", (chunk: Buffer | string) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop()!.slice(-256);
    for (const line of lines) {
      if (line === "prepare: ok") { prepared = true; prepare(); }
      if (line === "commit: ok") published = true;
    }
  });
  child.stdin?.on("error", () => undefined);
  child.stdin?.write(`start\nupdate HEAD ${commit} ${context.head ?? "0".repeat(commit.length)}\nprepare\n`);
  try {
    await preparation;
    await verify();
    checkDeadline();
    commitSent = true;
    child.stdin?.end("commit\n");
    const code = await finished;
    // A commit acknowledgement is an authoritative success even if the process subsequently fails.
    if (!published && code !== 0) throw stale();
    if (!published) throw blocked("Git did not confirm the setup commit. Inspect Git status before continuing manually.");
  } catch (error) {
    if (!child.stdin?.writableEnded) child.stdin?.end("abort\n");
    await finished;
    if (!published && commitSent) {
      // The ref write can complete before stdout's acknowledgement reaches this process.
      // Reconcile that known candidate before discarding the prepared index or inviting a retry.
      const observed = await git(context.root, ["rev-parse", "--verify", context.ref!], { allowFailure: true, recovery: true }).catch(() => null);
      if (observed?.code === 0 && observed.text.trim() === commit) published = true;
      if (!published) throw new PublicationUncertainError();
    }
    if (!published) throw error;
  }
}
