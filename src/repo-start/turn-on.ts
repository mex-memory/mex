import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CheckoutRow, RecordWriter } from "../record/index.js";
import { projectIdentity, realPath, type GitRunner, type KnownRepository } from "../record/project.js";

export interface TurnOnResult {
  projectId: string;
  checkout: CheckoutRow;
  /** True when this run registered the checkout `mex` ran in. */
  registered: boolean;
  /** Other worktrees of the repository this run registered. */
  worktrees: number;
}

const runGit: GitRunner = (directory, args) => execFileSync("git", ["-C", directory, ...args], {
  encoding: "utf8", timeout: 1500, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
}).trim();

const MAX_WORKTREES = 256;

/** Worktree paths from `git worktree list --porcelain`, without bare or prunable entries. */
export function parseWorktrees(porcelain: string): string[] {
  const paths: string[] = [];
  for (const record of porcelain.split(/\r?\n\r?\n/u)) {
    const lines = record.split(/\r?\n/u);
    const path = lines.find(line => line.startsWith("worktree "))?.slice("worktree ".length);
    if (!path || lines.some(line => line === "bare" || line.startsWith("prunable"))) continue;
    paths.push(path);
    if (paths.length >= MAX_WORKTREES) break;
  }
  return paths;
}

/** What `mex` already learned about the repository, so turning it on doesn't ask git again. */
export interface KnownPlace extends KnownRepository {
  /** The `.git` folder every worktree shares; without a `worktrees` folder in it there are no others. */
  commonDir?: string;
}

/**
 * The yes for a repository: register the checkout `mex` ran in and every other
 * worktree git lists. An existing registration keeps its state, so a checkout
 * someone turned off with `mex off` stays off.
 */
export function turnOnRepository(writer: RecordWriter, root: string, git: GitRunner = runGit, known: KnownPlace = {}): TurnOnResult {
  const existing = writer.checkout(root);
  const registered = !existing || !!existing.provisional;
  const project = registered ? writer.register(projectIdentity(root, git, known)) : writer.project(existing.project_id)!;
  const checkout = writer.checkout(root)!;
  let worktrees = 0;
  let listed: string[] = [];
  // Git keeps each linked worktree under <common dir>/worktrees; with none there, skip the git start.
  const linked = known.commonDir === undefined || existsSync(join(known.commonDir, "worktrees"));
  if (linked) {
    try { listed = parseWorktrees(git(root, ["worktree", "list", "--porcelain"])); } catch { /* git too old or busy: only this checkout */ }
  }
  for (const path of listed) {
    let real: string;
    try { if (!existsSync(path)) continue; real = realPath(path); } catch { continue; }
    if (real === checkout.path) continue;
    const row = writer.db.prepare("SELECT * FROM checkouts WHERE path=?").get(real) as unknown as CheckoutRow | undefined;
    if (row && !row.provisional) continue;
    try { writer.register(projectIdentity(real, git)); worktrees++; } catch { /* one unreadable worktree doesn't stop the yes */ }
  }
  return { projectId: project.id, checkout: writer.checkout(root)!, registered, worktrees };
}
