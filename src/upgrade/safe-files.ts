import { createHash } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { realPath } from "../record/project.js";
import { atomicCreateArtifact, atomicReplaceArtifact, tryReadContainedArtifact } from "../team/artifacts/filesystem.js";
import { revisionOf } from "../team/artifacts/revision.js";
import type { RepoRelativePath } from "../team/contracts/shared.js";
import { KnowledgeError } from "../knowledge/entry.js";
import type { UpgradeFileChange } from "./cleanup-plan.js";

export const digest = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");
export function safePath(path: string): path is RepoRelativePath {
  return path.length <= 2048 && !/^(?:\/|[A-Za-z]:)/u.test(path) && !/[\\\x00-\x1f\x7f]/u.test(path)
    && path.split("/").every(p => !!p && p !== "." && p !== "..");
}
export function readBytes(root: string, path: string, max = 1024 * 1024): Uint8Array | null {
  if (!safePath(path)) throw new KnowledgeError("UPGRADE_PATH", "An upgrade path is unsafe.");
  return tryReadContainedArtifact(root, path, max)?.bytes ?? null;
}
export function readText(root: string, path: string): string | null {
  const bytes = readBytes(root, path);
  if (bytes === null) return null;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new KnowledgeError("UPGRADE_ENCODING", `Cannot preview non-UTF-8 text: ${path}`); }
  return Buffer.from(bytes).toString("utf8");
}
/** Team's atomic writer expects a non-root parent path. Keep the same
 * containment proof for root files by anchoring at the canonical parent. */
export function artifactLocation(root: string, path: RepoRelativePath): { root: string; path: RepoRelativePath } {
  const canonical = realPath(root);
  return path.includes("/") ? { root: canonical, path } : { root: dirname(canonical), path: `${basename(canonical)}/${path}` as RepoRelativePath };
}
/** Idempotent exact write: recovery accepts only the approved before or after. */
export function applyChange(root: string, change: UpgradeFileChange): void {
  const current = readText(root, change.path);
  if (current === change.after) return;
  if (current !== change.before) throw new KnowledgeError("STALE_PREVIEW", `Upgrade target changed: ${change.path}`);
  if (!safePath(change.path)) throw new KnowledgeError("UPGRADE_PATH", "An upgrade path is unsafe.");
  const target = artifactLocation(root, change.path);
  if (change.after === null) {
    // Contained reads above reject redirected ancestors and non-regular files.
    // Unlink never follows a final symlink; repeat the identity proof just before it.
    const full = join(root, ...change.path.split("/"));
    const before = lstatSync(full, { bigint: true });
    if (readText(root, change.path) !== current) throw new KnowledgeError("STALE_PREVIEW", `Upgrade target changed: ${change.path}`);
    const after = lstatSync(full, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new KnowledgeError("STALE_PREVIEW", `Upgrade target changed: ${change.path}`);
    unlinkSync(full);
  } else if (current === null) atomicCreateArtifact(target.root, target.path, change.after);
  else atomicReplaceArtifact(target.root, target.path, revisionOf(current), change.after, 1024 * 1024);
}
