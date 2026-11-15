/**
 * A share in progress is recorded before anything is created, so a share
 * killed halfway can be finished or discarded. Cleanup never forces and
 * stops at any link or junction.
 */
import { lstatSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { KnowledgeError } from "./contract.js";
import { git } from "./share-plan.js";
import { readBoundedTextFile } from "./files.js";

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
  baseName?: string;
  /** Exact approved notes, so recovery cannot silently accept later edits. */
  entryHashes?: Record<string, string>;
  /** Exact output at the written checkpoint; null means an owned removal. */
  files?: Record<string, string | null>;
}

export const SHARE_STATE = "share.json";

export function readShareState(projectDirectory: string): ShareState | undefined {
  try {
    const text = readBoundedTextFile(join(projectDirectory, SHARE_STATE), 1024 * 1024);
    if (text === undefined) return undefined;
    const state = JSON.parse(text) as ShareState;
    if (state.version !== 1) throw new Error("unsupported state");
    return state;
  } catch { throw new KnowledgeError("SHARE_STATE", "The unfinished share record could not be read safely; it was kept for review."); }
}

export function saveShareState(projectDirectory: string, state: ShareState): void {
  const file = join(projectDirectory, SHARE_STATE);
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const text = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(text) > 1024 * 1024) throw new KnowledgeError("SHARE_STATE", "The share's progress record exceeds its size limit.");
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, file);
}

export function clearShareState(projectDirectory: string): void {
  try { unlinkSync(join(projectDirectory, SHARE_STATE)); } catch { /* already gone */ }
}

/** The first link or junction inside a folder, if any. Junctions read as links to Node. */
export function firstLink(folder: string, limit = 50_000): string | undefined {
  if (lstatSync(folder).isSymbolicLink()) return folder;
  const stack = [folder];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    let children;
    try { children = readdirSync(dir, { withFileTypes: true }); } catch { return dir; }
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
  if (!exists) return;
  const link = firstLink(worktree);
  if (link) throw new KnowledgeError("SHARE_LINK", `The share's worktree holds a link (${link}); remove it yourself after checking it: ${worktree}`);
  // Without --exclude-standard, ignored additions count too. Git can otherwise
  // remove ignored files even without --force; they may be somebody else's work.
  if (git(worktree, "ls-files", "--others", "-z")) throw new KnowledgeError("SHARE_CLEANUP", `The share's worktree has extra files; check it before removing it without forcing: ${worktree}`);
  try { git(root, "worktree", "remove", worktree); }
  catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim().split("\n")[0] ?? "";
    throw new KnowledgeError("SHARE_CLEANUP", `git won't remove the share's worktree without forcing (${detail}). Check it and remove it yourself: ${worktree}`);
  }
}
