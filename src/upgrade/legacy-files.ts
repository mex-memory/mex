/** Read-only, descriptor-bound I/O for the 0.8 upgrade reader. No store setup. */
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

export const LEGACY_LIMITS = Object.freeze({
  directoryEntries: 100_000,
  files: 10_000,
  depth: 64,
  fileBytes: 8 * 1024 * 1024,
  corpusBytes: 256 * 1024 * 1024,
  diagnostics: 100,
  logRows: 10_000,
  logLineBytes: 64 * 1024,
  excludePatterns: 256,
  patternBytes: 1024,
});

export class LegacyReadError extends Error {
  constructor(readonly code: "LEGACY_UNSAFE_PATH" | "LEGACY_CHANGED" | "LEGACY_LIMIT" | "LEGACY_UNREADABLE", readonly path: string) {
    super(`${code}: ${path}`);
  }
}

export interface LegacySource {
  /** Repository-relative POSIX path. */
  path: string;
  /** Exact UTF-8 text, including BOM and line endings. */
  text: string;
  hash: string;
  bytes: number;
}

interface DirectoryEntry { path: string; directory: boolean; unsafe: boolean; }

function listingHash(entries: readonly DirectoryEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(JSON.stringify([entry.path, entry.directory, entry.unsafe]) + "\n");
  return hash.digest("hex");
}

function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
    && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** One bounded observation; final verification rejects changes during parsing. */
export class LegacyFiles {
  readonly root: string;
  private readonly observed = new Map<string, BigIntStats>();
  private readonly absent = new Set<string>();
  private readonly listed = new Map<string, string>();
  private readonly sourceHashes = new Map<string, string>();
  private entries = 0;
  private readonly readBudget = { files: 0, bytes: 0 };

  constructor(root: string) {
    this.root = realpathSync(resolve(root));
    this.directory("");
  }

  private target(path: string): string {
    if (path !== "" && (isAbsolute(path) || path.includes("\\") || path.includes("\0")
      || path.split("/").some(part => !part || part === "." || part === ".."))) {
      throw new LegacyReadError("LEGACY_UNSAFE_PATH", path);
    }
    return join(this.root, ...path.split("/"));
  }

  private observe(path: string): BigIntStats | undefined {
    let stat: BigIntStats;
    try { stat = lstatSync(this.target(path), { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new LegacyReadError("LEGACY_UNREADABLE", path);
      this.absent.add(path);
      return undefined;
    }
    if (stat.isSymbolicLink()) throw new LegacyReadError("LEGACY_UNSAFE_PATH", path);
    if (this.absent.has(path)) throw new LegacyReadError("LEGACY_CHANGED", path);
    const previous = this.observed.get(path);
    if (previous && !same(previous, stat)) throw new LegacyReadError("LEGACY_CHANGED", path);
    this.observed.set(path, stat);
    return stat;
  }

  directory(path: string): boolean {
    const parts = path ? path.split("/") : [];
    if (parts.length > LEGACY_LIMITS.depth) throw new LegacyReadError("LEGACY_LIMIT", path);
    for (let i = 0; i <= parts.length; i++) {
      const current = parts.slice(0, i).join("/");
      const stat = this.observe(current);
      if (!stat) return false;
      if (!stat.isDirectory()) throw new LegacyReadError("LEGACY_UNSAFE_PATH", current);
      // This rejects junction/parent redirects too, including links swapped
      // after an ancestor's lstat. The selected repository root is canonical.
      if (realpathSync(this.target(current)) !== this.target(current)) throw new LegacyReadError("LEGACY_UNSAFE_PATH", current);
    }
    return true;
  }

  private scan(path: string, budget: { entries: number }): DirectoryEntry[] {
    if (!this.directory(path)) return [];
    const result: DirectoryEntry[] = [];
    const handle = opendirSync(this.target(path));
    try {
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        if (++budget.entries > LEGACY_LIMITS.directoryEntries) throw new LegacyReadError("LEGACY_LIMIT", path);
        const child = path ? `${path}/${entry.name}` : entry.name;
        // Never follow links, even links whose destination is inside the repo.
        result.push({ path: child, directory: entry.isDirectory(), unsafe: entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()) });
      }
    } finally { handle.closeSync(); }
    return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }

  list(path: string): DirectoryEntry[] {
    const budget = { entries: this.entries };
    try {
      const entries = this.scan(path, budget);
      const hash = listingHash(entries);
      const previous = this.listed.get(path);
      if (previous !== undefined && previous !== hash) throw new LegacyReadError("LEGACY_CHANGED", path);
      this.listed.set(path, hash);
      return entries;
    } finally { this.entries = budget.entries; }
  }

  read(path: string): LegacySource | undefined {
    const source = this.readSource(path, this.readBudget);
    if (source) {
      const previous = this.sourceHashes.get(path);
      if (previous !== undefined && previous !== source.hash) throw new LegacyReadError("LEGACY_CHANGED", path);
      this.sourceHashes.set(path, source.hash);
    }
    return source;
  }

  private readSource(path: string, budget: { files: number; bytes: number }): LegacySource | undefined {
    this.target(path);
    const parent = path.split("/").slice(0, -1).join("/");
    if (!this.directory(parent)) return undefined;
    const expected = this.observe(path);
    if (!expected) return undefined;
    if (!expected.isFile()) throw new LegacyReadError("LEGACY_UNSAFE_PATH", path);
    if (++budget.files > LEGACY_LIMITS.files || expected.size > BigInt(LEGACY_LIMITS.fileBytes)
      || BigInt(budget.bytes) + expected.size > BigInt(LEGACY_LIMITS.corpusBytes)) throw new LegacyReadError("LEGACY_LIMIT", path);
    let fd: number | undefined;
    try {
      fd = openSync(this.target(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      if (!same(expected, fstatSync(fd, { bigint: true }))) throw new LegacyReadError("LEGACY_CHANGED", path);
      // One extra byte detects growth without ever allocating from a new size.
      const buffer = Buffer.alloc(Number(expected.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const n = readSync(fd, buffer, length, buffer.length - length, null);
        if (!n) break;
        length += n;
      }
      if (BigInt(length) !== expected.size || !same(expected, fstatSync(fd, { bigint: true }))) throw new LegacyReadError("LEGACY_CHANGED", path);
      // Windows can defer file timestamp updates while this descriptor stays
      // open. Compare a second bounded pass against the bytes already read.
      const proof = Buffer.alloc(Math.min(buffer.length, 64 * 1024));
      let checked = 0;
      while (checked < buffer.length) {
        const n = readSync(fd, proof, 0, Math.min(proof.length, buffer.length - checked), checked);
        if (!n) break;
        if (checked + n > length || !buffer.subarray(checked, checked + n).equals(proof.subarray(0, n))) throw new LegacyReadError("LEGACY_CHANGED", path);
        checked += n;
      }
      if (checked !== length || !same(expected, fstatSync(fd, { bigint: true }))) throw new LegacyReadError("LEGACY_CHANGED", path);
      this.directory(parent);
      this.observe(path);
      budget.bytes += length;
      const bytes = buffer.subarray(0, length);
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      return { path, text, bytes: length, hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
    } catch (error) {
      if (error instanceof LegacyReadError) throw error;
      throw new LegacyReadError("LEGACY_UNREADABLE", path);
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  verify(): void {
    // NTFS can defer directory timestamp changes. Re-enumerate the exact
    // directory sets, with a separate bounded verification-pass budget.
    const budget = { entries: 0 };
    for (const [path, expected] of this.listed) {
      if (listingHash(this.scan(path, budget)) !== expected) throw new LegacyReadError("LEGACY_CHANGED", path);
    }
    const sourceBudget = { files: 0, bytes: 0 };
    for (const [path, expected] of this.sourceHashes) {
      if (this.readSource(path, sourceBudget)?.hash !== expected) throw new LegacyReadError("LEGACY_CHANGED", path);
    }
    for (const [path, stat] of this.observed) {
      const current = lstatSync(this.target(path), { bigint: true });
      if (!same(stat, current) || current.isSymbolicLink()) throw new LegacyReadError("LEGACY_CHANGED", path);
      const within = relative(this.root, realpathSync(this.target(path)));
      if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) throw new LegacyReadError("LEGACY_UNSAFE_PATH", path);
    }
    for (const path of this.absent) {
      try { lstatSync(this.target(path)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      throw new LegacyReadError("LEGACY_CHANGED", path);
    }
  }
}
