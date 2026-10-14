/**
 * The only module in `src/context/` that mutates the filesystem.
 *
 * Everything the context feature writes is derived, checkout-local and
 * disposable, and it all lives under `.mex/local/`. Keeping the write calls in
 * one file lets the architecture inventory pin a single writer, and keeps the
 * composer itself (ranking, packets, health) free of side effects.
 */

import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";

function contained(localDir: string, target: string): string {
  const root = resolve(localDir);
  const path = resolve(target);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error(`Refusing to touch ${basename(path)} outside ${basename(root)}.`);
  }
  return path;
}

/** Publish `text` at `target` by writing a sibling temp file and renaming it over. */
export function writeTextAtomic(localDir: string, target: string, text: string): void {
  const path = contained(localDir, target);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, text, { encoding: "utf8", flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The temp name is unique; a leftover is swept by the next prune.
    }
    throw error;
  }
}

export function removeLocalFile(localDir: string, target: string): void {
  rmSync(contained(localDir, target), { force: true });
}

export interface PruneOptions {
  /** Delete files not modified for this long. */
  maxAgeMs: number;
  /** Then keep only this many of the newest. */
  maxFiles: number;
  now?: number;
}

/** Delete stale and surplus files (and orphaned temp files) in one flat directory. */
export function pruneDirectory(localDir: string, directory: string, options: PruneOptions): number {
  const dir = contained(localDir, directory);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const now = options.now ?? Date.now();
  const entries: Array<{ path: string; mtime: number }> = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (stat.isFile()) entries.push({ path, mtime: stat.mtimeMs });
    } catch {
      // Raced with another process; nothing to prune.
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  entries.forEach((entry, position) => {
    if (position >= options.maxFiles || now - entry.mtime > options.maxAgeMs) {
      try {
        rmSync(entry.path, { force: true });
        removed += 1;
      } catch {
        // Best effort: pruning never fails a prompt.
      }
    }
  });
  return removed;
}

/** Remove a directory this feature created (the managed semantic install). */
export function removeManagedDirectory(parent: string, directory: string): void {
  const path = resolve(directory);
  const root = resolve(parent);
  if (!path.startsWith(root + sep)) throw new Error("Refusing to remove a directory outside the MEX home.");
  rmSync(path, { recursive: true, force: true });
}

/** Create a directory (and parents) for managed content. */
export function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Write a small file inside a managed directory (the semantic install marker). */
export function writeManagedFile(managedDir: string, target: string, text: string): void {
  const dir = resolve(managedDir);
  const path = resolve(target);
  if (!path.startsWith(dir + sep)) throw new Error("Refusing to write outside the managed directory.");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}
