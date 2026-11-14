import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface Snapshot { data: string | null; mode: number; }
export const MAX_SETTINGS_BYTES = 1 << 20;
export const MAX_RUNTIME_BYTES = 32 << 20;
export function samePath(a: string, b: string): boolean {
  const fold = (value: string) => process.platform === "win32" ? value.replace(/[A-Z]/g, letter => letter.toLowerCase()) : value;
  return fold(resolve(a)) === fold(resolve(b));
}

/** Canonicalize the existing parent, never the leaf (a link there is refused). */
export function installPath(path: string): string {
  let parent = dirname(resolve(path));
  const suffix = [basename(path)];
  while (true) {
    try { return join(realpathSync.native(parent), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(parent) === parent) throw error;
      suffix.unshift(basename(parent)); parent = dirname(parent);
    }
  }
}

export function readSnapshot(path: string, maxBytes = MAX_RUNTIME_BYTES): Snapshot {
  if (!samePath(installPath(path), path)) throw new Error(`Installation path was redirected: ${path}`);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { data: null, mode: 0o600 }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error(`Not a bounded, private regular file: ${path}`);
  const fd = openSync(path, "r");
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > maxBytes) throw new Error(`File changed while reading: ${path}`);
    return { data: readFileSync(fd).toString("base64"), mode: stat.mode & 0o777 };
  } finally { closeSync(fd); }
}

export function snapshotBytes(snapshot: Snapshot): Buffer | null { return snapshot.data === null ? null : Buffer.from(snapshot.data, "base64"); }
export function equalSnapshot(a: Snapshot, b: Snapshot): boolean {
  const sameMode = process.platform === "win32" ? (a.mode & 0o200) === (b.mode & 0o200) : a.mode === b.mode;
  return a.data === b.data && (a.data === null || sameMode);
}

/** A settings directory can itself belong to a dotfiles repo. Never edit tracked files. */
export function assertUntracked(path: string): void {
  let parent = dirname(path);
  while (true) {
    try { lstatSync(parent); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; parent = dirname(parent); }
  }
  const result = spawnSync("git", ["-C", parent, "ls-files", "--error-unmatch", "--", path], { encoding: "utf8", timeout: 1500, windowsHide: true });
  if (result.status === 0) throw new Error(`MEX will not edit a tracked file: ${path}`);
  if (result.error || result.signal || (result.status !== 1 && !(result.status === 128 && /not a git repository/i.test(result.stderr)))) {
    throw new Error(`Could not check whether this settings file is tracked: ${path}`);
  }
}

/** Compare again immediately before replacement, and preserve permissions. */
export function replaceFile(path: string, expected: Snapshot, desired: Snapshot): void {
  if (!equalSnapshot(readSnapshot(path), expected)) throw new Error(`File changed before installation could write it: ${path}`);
  if (desired.data === null) { if (expected.data !== null) unlinkSync(path); return; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!samePath(installPath(path), path)) throw new Error(`Installation path was redirected: ${path}`);
  const temporary = join(dirname(path), `.mex-install-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    writeFileSync(temporary, Buffer.from(desired.data, "base64"), { flag: "wx", mode: desired.mode });
    chmodSync(temporary, desired.mode);
    if (!equalSnapshot(readSnapshot(path), expected)) throw new Error(`File changed during installation: ${path}`);
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
