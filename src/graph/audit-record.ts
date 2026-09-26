/**
 * A record that the graph database with one exact SHA-256 passed the full
 * structural audit (issue #209).
 *
 * The audit (SQLite's quick-check and every persisted invariant) is a
 * function of the database bytes alone, so a file that hashes to a digest
 * the audit already passed cannot fail it. Maintenance records the digest of
 * each candidate it validated and published; an inspection that proves the
 * live file still holds exactly those bytes skips re-auditing them. The
 * record is local, ignored with `graph.db*`, and bound to the audit version,
 * the canonical database path and the size; any doubt runs the full audit.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";

/** Bump whenever the structural audit gains or changes a check. */
const STRUCTURE_AUDIT_VERSION = 1;
const HASH_CHUNK_BYTES = 1024 * 1024;

interface AuditRecord {
  version: number;
  canonicalDbPath: string;
  size: number;
  digest: string;
}

function recordPath(canonicalDbPath: string): string {
  return `${canonicalDbPath}-audit.json`;
}

/** Record that the database at `canonicalDbPath` with these bytes passed the full audit. */
export function recordAuditedDatabase(canonicalDbPath: string, size: number, digest: string): void {
  const record: AuditRecord = { version: STRUCTURE_AUDIT_VERSION, canonicalDbPath, size, digest };
  const path = recordPath(canonicalDbPath);
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // The record only saves work; failing to write it costs a full audit.
    try {
      unlinkSync(temporary);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Whether the file at `canonicalDbPath`, statted as `statBeforeOpen`, holds
 * exactly the bytes of a recorded audited database: the record matches, the
 * file hashes to its digest, and its stat identity is unchanged from before
 * the caller's open through the end of the hash.
 */
export function holdsAuditedBytes(canonicalDbPath: string, statBeforeOpen: Stats): boolean {
  let record: AuditRecord;
  try {
    record = JSON.parse(readFileSync(recordPath(canonicalDbPath), "utf8")) as AuditRecord;
  } catch {
    return false;
  }
  if (record?.version !== STRUCTURE_AUDIT_VERSION
    || record.canonicalDbPath !== canonicalDbPath
    || record.size !== statBeforeOpen.size
    || typeof record.digest !== "string") return false;
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(canonicalDbPath, constants.O_RDONLY | noFollow);
  } catch {
    return false;
  }
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (let offset = 0; ;) {
      const count = readSync(fd, chunk, 0, chunk.length, offset);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
      offset += count;
    }
    return sameStat(statBeforeOpen, fstatSync(fd)) && hash.digest("hex") === record.digest;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

function sameStat(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}
