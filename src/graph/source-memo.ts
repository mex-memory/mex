import fs, { type Stats } from "node:fs";
import { resolve } from "node:path";

/**
 * Source bytes one maintenance operation has already read, by file identity.
 *
 * A refresh observes the corpus several times: the inspection twice, the
 * candidate's discovery, the input verification after the build, and the
 * candidate's validation twice. Within one operation, a file whose identity
 * (device, inode, size, modification and change time) is unchanged since it
 * was read holds the bytes that read returned: any write moves its change
 * time, which no caller can set. Every other check each observation makes
 * still runs; only the repeated read is skipped.
 *
 * Inactive outside {@link withSourceMemo}, so reads outside a maintenance
 * operation always go to disk.
 */
let active: Map<string, string> | null = null;
/** Bytes held, bounded so a large corpus falls back to reading from disk. */
let heldBytes = 0;
let spooledBytes = 0;
const MAX_HELD_BYTES = 64 * 1024 * 1024;

type Identity = Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">;

function key(stat: Identity): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/**
 * A file's memo key: its canonical path and its identity. The identity alone
 * is not unique: on Windows a 64-bit file id loses precision as a number, and
 * two same-sized files written in the same millisecond can share every other
 * field.
 */
function fileKey(path: string, stat: Identity): string {
  const resolved = resolve(path);
  return `${process.platform === "win32" ? resolved.toLowerCase() : resolved}|${key(stat)}`;
}

/** Run one maintenance operation with its own memo; nested calls share the outer one. */
export async function withSourceMemo<T>(run: () => Promise<T>): Promise<T> {
  if (active) return run();
  active = new Map();
  heldBytes = 0;
  spooledBytes = 0;
  try {
    return await run();
  } finally {
    active = null;
    digests = null;
    walks = null;
  }
}

/** The bytes this operation read from a file with exactly this identity, if any. */
export function recallSource(path: string, stat: Identity): string | undefined {
  return active?.get(fileKey(path, stat));
}

/**
 * Reserve room for staged bytes the source spool keeps in memory during a
 * maintenance operation, on a budget of its own. They are mostly the very
 * strings the memo holds, so the two budgets bound one working set. False
 * outside an operation or past the budget; the spool then writes to disk.
 */
export function reserveHeldBytes(bytes: number): boolean {
  if (!active || spooledBytes + bytes > MAX_HELD_BYTES) return false;
  spooledBytes += bytes;
  return true;
}

/** Remember bytes read from a file whose identity held from before the read to after it. */
export function rememberSource(path: string, stat: Identity, content: string): void {
  if (!active || heldBytes + stat.size > MAX_HELD_BYTES) return;
  heldBytes += stat.size;
  active.set(fileKey(path, stat), content);
}

/**
 * SHA-256 digests of whole files this operation already hashed, by identity:
 * the maintenance envelope identifies the same unchanged database several
 * times (before a copy, around validation, before publication).
 */
let digests: Map<string, string> | null = null;

/** The digest this operation computed for a file with exactly this identity, if any. */
export function recallDigest(path: string, stat: Identity): string | undefined {
  return active ? digests?.get(fileKey(path, stat)) : undefined;
}

/** Remember a digest computed over a file whose identity held throughout the hash. */
export function rememberDigest(path: string, stat: Identity, digest: string): void {
  if (!active) return;
  digests ??= new Map();
  digests.set(fileKey(path, stat), digest);
}

/**
 * Corpus walk results this operation already produced, with the identity of
 * every directory each walk listed. Adding, removing or renaming an entry
 * moves its directory's modification and change times, so a walk whose
 * directories all keep their identity would list the same paths again.
 */
let walks: Map<string, { paths: string[]; directories: Map<string, string> }> | null = null;

/** The `fs` for one corpus walk that records the directories it lists, or null outside an operation. */
export function recordingWalkFs(directories: Map<string, string>): typeof fs | null {
  if (!active) return null;
  const readdirSync = ((path: fs.PathLike, options?: unknown) => {
    const directory = String(path);
    const before = identityOf(directory);
    const entries = (fs.readdirSync as (path: fs.PathLike, options?: unknown) => unknown)(path, options);
    // A directory that changed while it was listed is never remembered.
    directories.set(directory, before !== null && before === identityOf(directory) ? before : "");
    return entries;
  }) as typeof fs.readdirSync;
  return { ...fs, readdirSync };
}

/** The paths an identical walk found, when every directory it listed is unchanged. */
export function recallWalk(key: string): string[] | undefined {
  const walk = active ? walks?.get(key) : undefined;
  if (!walk) return undefined;
  for (const [directory, identity] of walk.directories) {
    if (identityOf(directory) !== identity) return undefined;
  }
  return [...walk.paths];
}

/** Remember a complete walk whose every listed directory held its identity. */
export function rememberWalk(key: string, paths: readonly string[], directories: Map<string, string>): void {
  if (!active) return;
  for (const identity of directories.values()) if (!identity) return;
  walks ??= new Map();
  walks.set(key, { paths: [...paths], directories });
}

function identityOf(path: string): string | null {
  try {
    const stat = fs.lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() ? key(stat) : null;
  } catch {
    return null;
  }
}
