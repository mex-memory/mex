import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  isRepoRelativePath,
  type RepoRelativePath,
  type Revision,
} from "../contracts/shared.js";
import { artifactError } from "./errors.js";
import { revisionOf } from "./revision.js";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const ARTIFACT_LOCK_METADATA_VERSION = 1 as const;
const MAX_ARTIFACT_LOCK_BYTES = 2 * 1024;
const ARTIFACT_LOCK_TOKEN = /^[a-f0-9]{64}$/;

export interface ContainedArtifactRead {
  bytes: Uint8Array;
  revision: Revision;
  canonicalPath: string;
  /** Nonzero only for an explicitly requested bounded tail read. */
  offset: number;
}

/** Only known canonical Team records opt into checkout-neutral bytes. */
export type ArtifactByteMode = "canonical" | "exact";

/** Resolve a caller-supplied root once so repositories cannot follow a later symlink swap. */
export function canonicalizeProjectRoot(projectRoot: string): string {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(projectRoot);
  } catch {
    throw artifactError("NOT_FOUND", "Repository not found", "The project root does not exist.");
  }
  if (!statSync(canonicalRoot, { bigint: true }).isDirectory()) {
    throw artifactError("PATH_OUTSIDE_PROJECT", "Unsafe project root", "The project root is not a directory.");
  }
  return canonicalRoot;
}

/** Read exact regular-file bytes without following the final path through a symlink. */
export function readContainedArtifact(
  projectRoot: string,
  path: RepoRelativePath,
  maxBytes: number,
  byteMode: ArtifactByteMode = "exact",
  tail = false,
): ContainedArtifactRead {
  const { canonicalRoot, lexicalPath } = resolveArtifactPath(projectRoot, path);
  let descriptor: number | undefined;
  try {
    assertSafeExistingComponents(canonicalRoot, path, true);
    descriptor = openSync(lexicalPath, constants.O_RDONLY | NO_FOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw unsafePath(path, "Artifact is not a regular file.");
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw unsafePath(path, "Artifact size is not safely addressable.");
    const offset = tail ? Math.max(0, Number(before.size) - maxBytes) : 0;
    if (!tail && before.size > BigInt(maxBytes)) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Artifact is too large",
        `Artifact exceeds ${maxBytes} bytes.`,
        path,
      );
    }
    const bytes = readDescriptorBounded(descriptor, maxBytes, () => {
      throw artifactError(
        "VALIDATION_FAILED",
        "Artifact is too large",
        `Artifact exceeds ${maxBytes} bytes.`,
        path,
      );
    }, offset);
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, after) || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs || BigInt(bytes.byteLength + offset) !== after.size) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Artifact changed during read",
        "The artifact changed while it was being read. Retry the operation.",
        path,
      );
    }

    const pathStat = lstatSync(lexicalPath, { bigint: true });
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || !sameIdentity(after, pathStat)) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Artifact path changed during read",
        "The artifact path changed while it was being read. Retry the operation.",
        path,
      );
    }
    const canonicalPath = realpathSync(lexicalPath);
    assertContained(canonicalRoot, canonicalPath, path);
    const canonicalStat = statSync(canonicalPath, { bigint: true });
    if (!sameIdentity(after, canonicalStat)) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Artifact path changed during read",
        "The artifact target changed while it was being read. Retry the operation.",
        path,
      );
    }
    // A caller that owns a canonical Team codec may opt into its LF identity.
    // Wiki snapshots, local receipts, and other files retain their exact bytes.
    const revisionBytes = byteMode === "exact" ? bytes : canonicalCheckoutBytes(bytes);
    return { bytes: revisionBytes, revision: revisionOf(revisionBytes), canonicalPath, offset };
  } catch (error) {
    if (isNotFound(error)) {
      throw artifactError("NOT_FOUND", "Artifact not found", `Artifact ${path} does not exist.`, path);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function tryReadContainedArtifact(
  projectRoot: string,
  path: RepoRelativePath,
  maxBytes: number,
  byteMode: ArtifactByteMode = "exact",
): ContainedArtifactRead | null {
  try {
    return readContainedArtifact(projectRoot, path, maxBytes, byteMode);
  } catch (error) {
    if (isMexCode(error, "NOT_FOUND")) return null;
    throw error;
  }
}

/** Publish a fully-written file without ever replacing an existing target. */
export function atomicCreateArtifact(
  projectRoot: string,
  path: RepoRelativePath,
  bytes: string | Uint8Array,
  mode: 0o600 | 0o644 = 0o644,
  durable = false,
): Revision {
  if (mode !== 0o600 && mode !== 0o644) {
    throw artifactError("INVALID_REQUEST", "Invalid artifact mode", "Artifact mode must be owner-only or standard readable.");
  }
  const { canonicalRoot, lexicalPath } = resolveArtifactPath(projectRoot, path);
  const parentPath = ensureSafeDirectory(canonicalRoot, dirname(path) as RepoRelativePath);
  assertTargetAbsentOrRegular(lexicalPath, path, true);
  const payload = asBytes(bytes);
  const temporaryPath = stageFile(parentPath, basename(path), payload, mode);

  try {
    assertSafeExistingComponents(canonicalRoot, dirname(path) as RepoRelativePath, false);
    try {
      linkSync(temporaryPath, lexicalPath);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw artifactError(
          "REVISION_CONFLICT",
          "Artifact already exists",
          `Artifact ${path} already exists.`,
          path,
        );
      }
      throw error;
    }
    unlinkIfPresent(temporaryPath);
    if (durable) syncArtifactParents(canonicalRoot, path);
    else fsyncDirectory(parentPath);
    return revisionOf(payload);
  } finally {
    unlinkIfPresent(temporaryPath);
  }
}

/** Atomically replace a regular artifact after an optimistic check in the selected byte mode. */
export function atomicReplaceArtifact(
  projectRoot: string,
  path: RepoRelativePath,
  expectedRevision: Revision,
  bytes: string | Uint8Array,
  maxExistingBytes: number,
  byteMode: ArtifactByteMode = "exact",
): Revision {
  const { canonicalRoot, lexicalPath } = resolveArtifactPath(projectRoot, path);
  const parentRelative = dirname(path) as RepoRelativePath;
  const parentPath = ensureSafeDirectory(canonicalRoot, parentRelative);
  const lockName = `.${basename(path)}.mex-lock`;
  const lockPath = resolve(parentPath, lockName);
  const recoveryPath = `${lockPath}.recovery`;
  let lockDescriptor: number | undefined;
  let lockOwned = false;
  let lockIdentity: FileIdentity | undefined;
  let temporaryPath: string | undefined;

  try {
    const lock = acquireArtifactLock(
      lockPath,
      recoveryPath,
      lockName,
      artifactLockOwner(canonicalRoot, parentPath),
      canonicalRoot,
      parentPath,
      parentRelative,
    );
    lockDescriptor = lock.descriptor;
    lockOwned = true;
    lockIdentity = lock.identity;

    assertExpectedRevision(projectRoot, path, expectedRevision, maxExistingBytes, byteMode);
    const payload = asBytes(bytes);
    temporaryPath = stageFile(parentPath, basename(path), payload);

    // Revalidate after all potentially expensive serialization/staging work.
    assertSafeExistingComponents(canonicalRoot, parentRelative, false);
    assertExpectedRevision(projectRoot, path, expectedRevision, maxExistingBytes, byteMode);
    assertTargetAbsentOrRegular(lexicalPath, path, false);
    renameSync(temporaryPath, lexicalPath);
    temporaryPath = undefined;
    fsyncDirectory(parentPath);
    return revisionOf(payload);
  } finally {
    if (lockDescriptor !== undefined) closeSync(lockDescriptor);
    if (temporaryPath !== undefined) unlinkIfPresent(temporaryPath);
    if (lockOwned && lockIdentity !== undefined) unlinkOwnedLock(lockPath, lockIdentity);
  }
}

export function assertContainedArtifactDirectory(
  projectRoot: string,
  path: RepoRelativePath,
): string | null {
  const { canonicalRoot, lexicalPath } = resolveArtifactPath(projectRoot, path);
  let current = canonicalRoot;
  for (const segment of path.split("/")) {
    current = resolve(current, segment);
    let stat;
    try {
      stat = lstatSync(current, { bigint: true });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw unsafePath(path, `Path component ${segment} is not a regular directory.`);
    }
    assertContained(canonicalRoot, realpathSync(current), path);
  }
  return lexicalPath;
}

/** Serialize cooperating multi-file invariants such as member-alias uniqueness. */
export async function withContainedArtifactLock<T>(
  projectRoot: string,
  directory: RepoRelativePath,
  lockName: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(lockName)) {
    throw artifactError("VALIDATION_FAILED", "Invalid artifact lock", "Artifact lock name is invalid.");
  }
  const { canonicalRoot } = resolveArtifactPath(projectRoot, directory);
  const directoryPath = ensureSafeDirectory(canonicalRoot, directory);
  const lockPath = resolve(directoryPath, lockName);
  const recoveryPath = `${lockPath}.recovery`;
  const owner = artifactLockOwner(canonicalRoot, directoryPath);
  let descriptor: number | undefined;
  let owned = false;
  let lockIdentity: FileIdentity | undefined;
  try {
    const lock = acquireArtifactLock(
      lockPath,
      recoveryPath,
      lockName,
      owner,
      canonicalRoot,
      directoryPath,
      directory,
    );
    descriptor = lock.descriptor;
    owned = true;
    lockIdentity = lock.identity;
    assertSafeExistingComponents(canonicalRoot, directory, false);
    return await operation();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (owned && lockIdentity !== undefined) unlinkOwnedLock(lockPath, lockIdentity);
  }
}

type ArtifactLockProcessStatus = "alive" | "dead" | "ambiguous";

interface ArtifactLockIdentity {
  dev: string;
  ino: string;
}

interface ArtifactLockMetadata {
  version: typeof ARTIFACT_LOCK_METADATA_VERSION;
  pid: number;
  token: string;
  acquiredAt: string;
  root: ArtifactLockIdentity;
  directory: ArtifactLockIdentity;
}

interface ObservedArtifactLock {
  metadata: ArtifactLockMetadata;
  identity: FileIdentity;
}

function artifactLockOwner(canonicalRoot: string, directoryPath: string): ArtifactLockMetadata {
  return {
    version: ARTIFACT_LOCK_METADATA_VERSION,
    pid: process.pid,
    token: randomBytes(32).toString("hex"),
    acquiredAt: new Date().toISOString(),
    root: persistedFileIdentity(statSync(canonicalRoot, { bigint: true })),
    directory: persistedFileIdentity(lstatSync(directoryPath, { bigint: true })),
  };
}

function acquireArtifactLock(
  lockPath: string,
  recoveryPath: string,
  lockName: string,
  owner: ArtifactLockMetadata,
  canonicalRoot: string,
  directoryPath: string,
  directory: RepoRelativePath,
): { descriptor: number; identity: FileIdentity } {
  recoverAbandonedArtifactLockMarker(
    recoveryPath,
    lockName,
    canonicalRoot,
    directoryPath,
    directory,
  );
  try {
    return createArtifactLockFile(lockPath, owner);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }

  const existing = readArtifactLockFile(
    lockPath,
    lockName,
    canonicalRoot,
    directoryPath,
    directory,
  );
  const status = probeArtifactLockProcess(existing.metadata.pid);
  if (status !== "dead") {
    throw artifactLockHeld(lockName, directory, existing.metadata.pid, status);
  }

  let recoveryDescriptor: number | undefined;
  let recoveryIdentity: FileIdentity | undefined;
  try {
    let marker;
    try {
      marker = createArtifactLockFile(recoveryPath, owner);
    } catch (recoveryError) {
      if (isAlreadyExists(recoveryError)) {
        throw artifactError(
          "REVISION_CONFLICT",
          "Artifact lock recovery is in progress",
          `Artifact lock ${lockName} is already being recovered by another writer.`,
          directory,
        );
      }
      throw recoveryError;
    }
    recoveryDescriptor = marker.descriptor;
    recoveryIdentity = marker.identity;

    // The recovery marker blocks cooperating writers while the original path
    // and owner token are revalidated immediately before reclamation.
    const confirmed = readArtifactLockFile(
      lockPath,
      lockName,
      canonicalRoot,
      directoryPath,
      directory,
    );
    if (
      !sameIdentity(confirmed.identity, existing.identity)
      || confirmed.metadata.token !== existing.metadata.token
      || probeArtifactLockProcess(confirmed.metadata.pid) !== "dead"
    ) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Artifact lock changed during recovery",
        `Artifact lock ${lockName} changed before its dead owner could be recovered.`,
        directory,
      );
    }
    unlinkOwnedLock(lockPath, confirmed.identity);
    return createArtifactLockFile(lockPath, owner);
  } finally {
    if (recoveryDescriptor !== undefined) closeSync(recoveryDescriptor);
    if (recoveryIdentity !== undefined) unlinkOwnedLock(recoveryPath, recoveryIdentity);
  }
}

function createArtifactLockFile(
  path: string,
  metadata: ArtifactLockMetadata,
): { descriptor: number; identity: FileIdentity } {
  let descriptor: number | undefined;
  let identity: FileIdentity | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    identity = identityOf(fstatSync(descriptor, { bigint: true }));
    const bytes = `${JSON.stringify(metadata)}\n`;
    if (Buffer.byteLength(bytes, "utf8") > MAX_ARTIFACT_LOCK_BYTES) {
      throw new Error("Generated artifact lock metadata exceeds its byte limit.");
    }
    writeFileSync(descriptor, bytes, "utf8");
    fsyncSync(descriptor);
    fsyncDirectory(dirname(path));
    return { descriptor, identity };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (identity !== undefined) unlinkOwnedLock(path, identity);
    throw error;
  }
}

function readArtifactLockFile(
  path: string,
  lockName: string,
  canonicalRoot: string,
  directoryPath: string,
  directory: RepoRelativePath,
): ObservedArtifactLock {
  let descriptor: number | undefined;
  try {
    const pathBefore = lstatSync(path, { bigint: true });
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
      throw unsafePath(directory, `Artifact lock ${lockName} is not a regular file.`);
    }
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || !sameIdentity(before, pathBefore)) {
      throw unsafePath(directory, `Artifact lock ${lockName} changed during inspection.`);
    }
    if (before.size < 1n || before.size > BigInt(MAX_ARTIFACT_LOCK_BYTES)) {
      throw unknownArtifactLock(lockName, directory, "has invalid bounded metadata");
    }
    const bytes = readDescriptorBounded(descriptor, MAX_ARTIFACT_LOCK_BYTES, () => {
      throw unknownArtifactLock(lockName, directory, "exceeds the metadata byte limit");
    });
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      !sameIdentity(before, after)
      || before.size !== after.size
      || BigInt(bytes.byteLength) !== after.size
      || pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || !sameIdentity(after, pathAfter)
    ) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Artifact lock changed during inspection",
        `Artifact lock ${lockName} changed while its owner was being verified.`,
        directory,
      );
    }
    const metadata = parseArtifactLockMetadata(bytes, lockName, directory);
    const expectedRoot = persistedFileIdentity(statSync(canonicalRoot, { bigint: true }));
    const expectedDirectory = persistedFileIdentity(lstatSync(directoryPath, { bigint: true }));
    if (
      !samePersistedIdentity(metadata.root, expectedRoot)
      || !samePersistedIdentity(metadata.directory, expectedDirectory)
    ) {
      throw unknownArtifactLock(lockName, directory, "belongs to a different repository root");
    }
    return { metadata, identity: identityOf(after) };
  } catch (error) {
    if (isErrno(error, "ELOOP")) {
      throw unsafePath(directory, `Artifact lock ${lockName} must not be a symbolic link.`);
    }
    if (isNotFound(error)) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Artifact lock disappeared",
        `Artifact lock ${lockName} disappeared while its owner was being verified.`,
        directory,
      );
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseArtifactLockMetadata(
  bytes: Uint8Array,
  lockName: string,
  directory: RepoRelativePath,
): ArtifactLockMetadata {
  const text = Buffer.from(bytes).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw unknownArtifactLock(lockName, directory, "contains malformed metadata");
  }
  if (!isRecord(value)) {
    throw unknownArtifactLock(lockName, directory, "contains malformed metadata");
  }
  const expectedKeys = ["version", "pid", "token", "acquiredAt", "root", "directory"];
  if (!hasExactKeys(value, expectedKeys)) {
    throw unknownArtifactLock(lockName, directory, "contains unknown metadata fields");
  }
  const root = parseArtifactLockIdentity(value.root);
  const directoryIdentity = parseArtifactLockIdentity(value.directory);
  if (
    value.version !== ARTIFACT_LOCK_METADATA_VERSION
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) < 1
    || typeof value.token !== "string"
    || !ARTIFACT_LOCK_TOKEN.test(value.token)
    || typeof value.acquiredAt !== "string"
    || !isCanonicalIsoTimestamp(value.acquiredAt)
    || root === null
    || directoryIdentity === null
  ) {
    throw unknownArtifactLock(lockName, directory, "contains invalid owner metadata");
  }
  const metadata: ArtifactLockMetadata = {
    version: ARTIFACT_LOCK_METADATA_VERSION,
    pid: value.pid as number,
    token: value.token,
    acquiredAt: value.acquiredAt,
    root,
    directory: directoryIdentity,
  };
  if (`${JSON.stringify(metadata)}\n` !== text) {
    throw unknownArtifactLock(lockName, directory, "contains non-canonical owner metadata");
  }
  return metadata;
}

function parseArtifactLockIdentity(value: unknown): ArtifactLockIdentity | null {
  if (!isRecord(value) || !hasExactKeys(value, ["dev", "ino"])) return null;
  if (
    typeof value.dev !== "string"
    || typeof value.ino !== "string"
    || !/^(?:0|[1-9][0-9]*)$/.test(value.dev)
    || !/^(?:0|[1-9][0-9]*)$/.test(value.ino)
  ) return null;
  return { dev: value.dev, ino: value.ino };
}

function persistedFileIdentity(value: FileIdentity): ArtifactLockIdentity {
  return { dev: String(value.dev), ino: String(value.ino) };
}

function samePersistedIdentity(left: ArtifactLockIdentity, right: ArtifactLockIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function probeArtifactLockProcess(pid: number): ArtifactLockProcessStatus {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return isErrno(error, "ESRCH") ? "dead" : "ambiguous";
  }
}

function recoverAbandonedArtifactLockMarker(
  recoveryPath: string,
  lockName: string,
  canonicalRoot: string,
  directoryPath: string,
  directory: RepoRelativePath,
): void {
  try {
    lstatSync(recoveryPath, { bigint: true });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  const marker = readArtifactLockFile(
    recoveryPath,
    `${lockName}.recovery`,
    canonicalRoot,
    directoryPath,
    directory,
  );
  const status = probeArtifactLockProcess(marker.metadata.pid);
  if (status !== "dead") {
    throw artifactLockHeld(`${lockName}.recovery`, directory, marker.metadata.pid, status);
  }
  unlinkOwnedLock(recoveryPath, marker.identity);
}

function artifactLockHeld(
  lockName: string,
  directory: RepoRelativePath,
  pid: number,
  status: Exclude<ArtifactLockProcessStatus, "dead">,
): Error {
  return artifactError(
    "REVISION_CONFLICT",
    "Artifact collection is being updated",
    status === "alive"
      ? `Artifact lock ${lockName} is held by live process ${pid}.`
      : `Artifact lock ${lockName} owner ${pid} could not be verified dead; refusing recovery.`,
    directory,
  );
}

function unknownArtifactLock(
  lockName: string,
  directory: RepoRelativePath,
  reason: string,
): Error {
  return artifactError(
    "REVISION_CONFLICT",
    "Artifact lock owner is unknown",
    `Artifact lock ${lockName} ${reason}; refusing recovery.`,
    directory,
  );
}

function assertExpectedRevision(
  projectRoot: string,
  path: RepoRelativePath,
  expectedRevision: Revision,
  maxBytes: number,
  byteMode: ArtifactByteMode = "exact",
): void {
  let current: ContainedArtifactRead;
  try {
    current = readContainedArtifact(projectRoot, path, maxBytes, byteMode);
  } catch (error) {
    if (isMexCode(error, "NOT_FOUND")) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Artifact revision conflict",
        `Artifact ${path} disappeared before the write could be applied.`,
        path,
      );
    }
    throw error;
  }
  if (current.revision !== expectedRevision) {
    throw artifactError(
      "REVISION_CONFLICT",
      "Artifact revision conflict",
      `Artifact ${path} no longer matches the expected revision.`,
      path,
    );
  }
}

/** Read at most one byte beyond a trusted budget, even if the file grows after fstat. */
function readDescriptorBounded(
  descriptor: number,
  maxBytes: number,
  tooLarge: () => never,
  offset = 0,
): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const bytesRead = readSync(descriptor, chunk, 0, chunk.byteLength, offset + total);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maxBytes) tooLarge();
  return Buffer.concat(chunks, total);
}

function stageFile(parentPath: string, targetName: string, bytes: Uint8Array, mode: 0o600 | 0o644 = 0o644): string {
  const temporaryPath = resolve(
    parentPath,
    `.${targetName}.mex-tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      mode,
    );
    if (mode === 0o600) fchmodSync(descriptor, mode);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    return temporaryPath;
  } catch (error) {
    unlinkIfPresent(temporaryPath);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function ensureSafeDirectory(canonicalRoot: string, path: RepoRelativePath): string {
  assertValidPath(path);
  let current = canonicalRoot;
  for (const segment of path.split("/")) {
    current = resolve(current, segment);
    try {
      mkdirSync(current, { mode: 0o755 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const stat = lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw unsafePath(path, `Path component ${segment} is not a regular directory.`);
    }
    assertContained(canonicalRoot, realpathSync(current), path);
  }
  return current;
}

function assertSafeExistingComponents(
  canonicalRoot: string,
  path: RepoRelativePath,
  finalMustBeFile: boolean,
): void {
  assertValidPath(path);
  let current = canonicalRoot;
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!);
    const stat = lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw unsafePath(path, `Path component ${segments[index]} must not be a symbolic link.`);
    }
    const final = index === segments.length - 1;
    if ((!final || !finalMustBeFile) && !stat.isDirectory()) {
      throw unsafePath(path, `Path component ${segments[index]} is not a directory.`);
    }
    if (final && finalMustBeFile && !stat.isFile()) {
      throw unsafePath(path, "Artifact is not a regular file.");
    }
    assertContained(canonicalRoot, realpathSync(current), path);
  }
}

function assertTargetAbsentOrRegular(
  target: string,
  path: RepoRelativePath,
  mustBeAbsent: boolean,
): void {
  try {
    const stat = lstatSync(target, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw unsafePath(path, "Artifact target is not a regular file.");
    }
    if (mustBeAbsent) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Artifact already exists",
        `Artifact ${path} already exists.`,
        path,
      );
    }
  } catch (error) {
    if (isNotFound(error)) {
      if (!mustBeAbsent) {
        throw artifactError("NOT_FOUND", "Artifact not found", `Artifact ${path} does not exist.`, path);
      }
      return;
    }
    throw error;
  }
}

function resolveArtifactPath(
  projectRoot: string,
  path: RepoRelativePath,
): { canonicalRoot: string; lexicalPath: string } {
  assertValidPath(path);
  const canonicalRoot = canonicalizeProjectRoot(projectRoot);
  const lexicalPath = resolve(canonicalRoot, ...path.split("/"));
  assertContained(canonicalRoot, lexicalPath, path);
  return { canonicalRoot, lexicalPath };
}

function assertValidPath(path: string): asserts path is RepoRelativePath {
  if (
    !isRepoRelativePath(path)
    || /[\u0000-\u001f\u007f]/.test(path)
    || Buffer.byteLength(path, "utf8") > 4096
  ) {
    throw artifactError(
      "PATH_OUTSIDE_PROJECT",
      "Unsafe repository path",
      "Artifact paths must be bounded canonical repository-relative paths.",
    );
  }
}

function assertContained(root: string, candidate: string, path: RepoRelativePath): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw unsafePath(path, "Artifact path escapes the project root.");
  }
}

function sameIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

function identityOf(value: FileIdentity): FileIdentity {
  return { dev: value.dev, ino: value.ino };
}

function unlinkOwnedLock(path: string, expected: FileIdentity): void {
  try {
    const current = lstatSync(path, { bigint: true });
    if (current.isFile() && !current.isSymbolicLink() && sameIdentity(current, expected)) {
      unlinkSync(path);
      fsyncDirectory(dirname(path));
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is unsupported on some otherwise supported platforms.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** A read-only directory check shared with bounded artifact discovery. */
export function inspectArtifactDirectory(projectRoot: string, path: RepoRelativePath): string {
  const { canonicalRoot, lexicalPath } = resolveArtifactPath(projectRoot, path);
  assertSafeExistingComponents(canonicalRoot, path, false);
  return lexicalPath;
}

/**
 * Flush every naming directory, including newly created ancestors. Windows
 * cannot flush directory handles through Node; callers must expose that limit.
 * Unlike the historical best-effort writer, supported-platform failures escape.
 */
export function syncArtifactParents(projectRoot: string, path: RepoRelativePath): void {
  const { canonicalRoot } = resolveArtifactPath(projectRoot, path);
  const parent = dirname(path) as RepoRelativePath;
  assertSafeExistingComponents(canonicalRoot, parent, false);
  if (process.platform === "win32") return;
  let current = resolve(canonicalRoot, parent);
  for (;;) {
    const before = lstatSync(current, { bigint: true });
    const fd = openSync(current, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NO_FOLLOW);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isDirectory() || !sameIdentity(before, opened)) throw unsafePath(path, "Publication directory changed.");
      fsyncSync(fd);
      const after = lstatSync(current, { bigint: true });
      if (after.isSymbolicLink() || !sameIdentity(opened, after)) throw unsafePath(path, "Publication directory changed.");
    } finally {
      closeSync(fd);
    }
    if (current === canonicalRoot) break;
    current = dirname(current);
  }
  assertSafeExistingComponents(canonicalRoot, parent, false);
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function unsafePath(path: RepoRelativePath, detail: string): Error {
  return artifactError("PATH_OUTSIDE_PROJECT", "Unsafe artifact path", detail, path);
}

function asBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

const CARRIAGE_RETURN = 0x0d;
const LINE_FEED = 0x0a;

/**
 * Undo Git checkout conversion only at an explicitly selected boundary.
 *
 * Canonical Team records are serialized as LF. Accept a uniform CRLF checkout
 * at those explicit codec boundaries and the tracked-config comparison only.
 * Mixed terminators and lone CR bytes remain unchanged for strict validation;
 * arbitrary local files and Wiki byte revisions must not use this transform.
 * Does not rewrite disk bytes or relax the original on-disk size bound.
 */
export function canonicalCheckoutBytes(bytes: Uint8Array): Uint8Array {
  let converted = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === CARRIAGE_RETURN && bytes[index + 1] !== LINE_FEED) return bytes;
    if (bytes[index] === LINE_FEED) {
      if (index === 0 || bytes[index - 1] !== CARRIAGE_RETURN) return bytes;
      converted += 1;
    }
  }
  if (converted === 0) return bytes;
  const canonical = new Uint8Array(bytes.length - converted);
  let cursor = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === CARRIAGE_RETURN && bytes[index + 1] === LINE_FEED) continue;
    canonical[cursor] = bytes[index]!;
    cursor += 1;
  }
  return canonical;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function isNotFound(error: unknown): boolean {
  return isErrno(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return isErrno(error, "EEXIST");
}

function isMexCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "problem" in error
    && (error as { problem?: { code?: unknown } }).problem?.code === code;
}
