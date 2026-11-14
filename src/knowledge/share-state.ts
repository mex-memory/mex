/**
 * A share in progress is recorded before anything is created, so a share
 * killed halfway can be finished or discarded. Cleanup never forces and
 * stops at any link or junction.
 */
import { lstatSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { KnowledgeError } from "./contract.js";
import { git } from "./share-plan.js";

export type ShareStep = "started" | "worktree" | "written" | "committed";
export interface ShareState {
  version: 1;
  branch: string;
  base: string;
  /** The temporary worktree's folder. */
  worktree: string;
  step: ShareStep;
  ids: string[];
  started: string;
}

export const SHARE_STATE = "share.json";

export function readShareState(projectDirectory: string): ShareState | undefined {
  try {
    const state = JSON.parse(readFileSync(join(projectDirectory, SHARE_STATE), "utf8")) as ShareState;
    return state.version === 1 ? state : undefined;
  } catch { return undefined; }
}

export function saveShareState(projectDirectory: string, state: ShareState): void {
  const file = join(projectDirectory, SHARE_STATE);
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export function clearShareState(projectDirectory: string): void {
  try { unlinkSync(join(projectDirectory, SHARE_STATE)); } catch { /* already gone */ }
}

/** The first link or junction inside a folder, if any. Junctions read as links to Node. */
export function firstLink(folder: string, limit = 50_000): string | undefined {
  const stack = [folder];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    let children;
    try { children = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      if (++seen > limit) return join(dir, child.name);
      const path = join(dir, child.name);
      if (child.isSymbolicLink() || lstatSync(path).isSymbolicLink()) return path;
      if (child.isDirectory() && !(dir === folder && child.name === ".git")) stack.push(path);
    }
  }
  return undefined;
}

/**
 * Remove a temporary worktree the way git allows without forcing: a worktree
 * with changes git won't drop is left, and so is one holding a link.
 */
export function removeWorktree(root: string, worktree: string): void {
  let exists = true;
  try { lstatSync(worktree); } catch { exists = false; }
  if (!exists) { git(root, "worktree", "prune"); return; }
  const link = firstLink(worktree);
  if (link) throw new KnowledgeError("SHARE_LINK", `The share's worktree holds a link (${link}); remove it yourself after checking it: ${worktree}`);
  try { git(root, "worktree", "remove", worktree); }
  catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim().split("\n")[0] ?? "";
    throw new KnowledgeError("SHARE_CLEANUP", `git won't remove the share's worktree without forcing (${detail}). Check it and remove it yourself: ${worktree}`);
  }
}
