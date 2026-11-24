import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * The per-home Hub secret. Every session cookie and CSRF token is derived from it, so
 * sessions survive a restart, and replacing the file signs every browser out.
 * Readable by this OS user only. Never logged, never sent anywhere.
 */
export const HUB_SECRET_FILE = "hub-secret";
const SECRET_BYTES = 32;

export interface HubSecret {
  readonly bytes: Buffer;
  /** Changes whenever the file is replaced, so a running Hub notices a sign-out. */
  readonly version: string;
}

export function hubSecretPath(home: string): string {
  return join(home, HUB_SECRET_FILE);
}

/** Read the secret, creating it on first use. Two racing creators agree on one file. */
export function loadHubSecret(home: string): HubSecret {
  const path = hubSecretPath(home);
  const existing = readSecret(path);
  if (existing) return existing;
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
  writeSecretFile(temporary, randomBytes(SECRET_BYTES));
  try {
    // link() fails if another process created the secret first; theirs wins.
    linkSync(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    try { unlinkSync(temporary); } catch { /* already gone */ }
  }
  const created = readSecret(path);
  if (!created) throw new Error("The Hub secret could not be created.");
  return created;
}

/** Replace the secret: every existing session and bootstrap link stops working. */
export function rotateHubSecret(home: string): HubSecret {
  const path = hubSecretPath(home);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
  writeSecretFile(temporary, randomBytes(SECRET_BYTES));
  renameSync(temporary, path);
  const rotated = readSecret(path);
  if (!rotated) throw new Error("The Hub secret could not be replaced.");
  return rotated;
}

/** A cheap identity for the file on disk, compared on each request. */
export function hubSecretVersion(home: string): string | undefined {
  try {
    const stat = statSync(hubSecretPath(home), { bigint: true });
    return `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

function readSecret(path: string): HubSecret | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (bytes.byteLength !== SECRET_BYTES) {
    throw new Error(`The Hub secret at ${path} is damaged. Delete it to sign every browser out and start again.`);
  }
  const stat = statSync(path, { bigint: true });
  return { bytes, version: `${stat.ino}:${stat.mtimeNs}:${stat.size}` };
}

function writeSecretFile(path: string, bytes: Buffer): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
