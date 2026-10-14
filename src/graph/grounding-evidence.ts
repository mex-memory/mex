/**
 * Evidence about a grounded body that no longer matches its committed hash.
 *
 * A grounding commits `bodyHash` (and, since #236, a `codeHash` bound to it).
 * When the live body differs, the warning is right only if the difference is
 * one a reader would care about. This module answers the two mechanical
 * questions — did only comments change, did only layout change — and hands
 * the old and new bodies to the caller for anything finer.
 *
 * ## The old body
 *
 * Markdown commits hashes, not text, so the old side of a diff comes from a
 * checkout-local cache of bodies this checkout has seen, keyed by body hash
 * (`.mex/local/grounded-bodies/<bodyHash>.txt`). It is content-addressed and
 * re-hashed on every read, so it can only ever supply the body the committed
 * hash names: it cannot turn a changed body into a fresh one by itself the way
 * a re-captured baseline would. A missing or unreadable entry leaves the
 * warning exactly as it was.
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { bodyTokenHash, codeHash, committedCodeHash, declarationRenameHash } from "./code-hash.js";
import { readContainedRepositorySource } from "./status.js";

export interface GroundingChangeEvidence {
  /** Only comments differ: the committed code hash, or the remembered old body, says so. */
  commentOnly: boolean;
  /** Only comments and layout (semicolons, trailing commas, quote style) differ. */
  layoutOnly: boolean;
  /** Both verified bodies differ only in their outer declaration name and layout. */
  renameOnly?: boolean;
  /** The body the committed `bodyHash` names, when this checkout has seen it. */
  oldBody: string | null;
  /** The node's body now, read as the graph indexed it. */
  newBody: string | null;
}

/** What a grounding committed, as far as this module reads it. */
export interface CommittedBody {
  bodyHash?: string;
  codeHash?: string;
}

export interface GroundingEvidence {
  explainChange(committed: CommittedBody, nodeId: string): GroundingChangeEvidence | null;
  rememberBody(nodeId: string, bodyHash: string): void;
}

interface EvidenceNode {
  filePath: string;
  startLine: number;
  endLine: number;
  bodyHash?: string | null;
}

/** The graph's body normalization: whitespace runs collapsed, then sha256. */
function hashNodeBody(source: string): string {
  return createHash("sha256").update(source.replace(/\s+/g, " ").trim()).digest("hex");
}

/** Where a project's remembered grounded bodies live. */
export function groundedBodyCacheDir(projectRoot: string): string {
  return join(projectRoot, ".mex", "local", "grounded-bodies");
}

export function createGroundingEvidence(options: {
  projectRoot: string;
  getNode(nodeId: string): EvidenceNode | null;
  /** Defaults to {@link groundedBodyCacheDir}. */
  bodyCacheDir?: string;
  /**
   * A second, read-only place an old body may be found by its hash: the
   * graph's `_mex_grounded_source` rows. Content-addressed and re-verified
   * here, so it can never stand in for a body it does not hash to.
   */
  recallBody?(bodyHash: string): string | null;
}): GroundingEvidence {
  const dir = options.bodyCacheDir ?? groundedBodyCacheDir(options.projectRoot);
  const pathFor = (bodyHash: string): string | null =>
    /^[0-9a-f]{64}$/.test(bodyHash) ? join(dir, `${bodyHash}.txt`) : null;

  const cached = (bodyHash: string): string | null => {
    const path = pathFor(bodyHash);
    if (path === null) return null;
    try {
      const body = readContainedRepositorySource(options.projectRoot, relative(options.projectRoot, path));
      return hashNodeBody(body) === bodyHash ? body : null;
    } catch {
      return null;
    }
  };
  const recall = (bodyHash: string): string | null => {
    const body = cached(bodyHash);
    if (body !== null) return body;
    try {
      const recorded = options.recallBody?.(bodyHash) ?? null;
      return recorded !== null && hashNodeBody(recorded) === bodyHash ? recorded : null;
    } catch {
      return null;
    }
  };

  /** The node's file and body, only while the file still holds the indexed body. */
  const readNode = (nodeId: string): { filePath: string; file: string; body: string; startLine: number; endLine: number } | null => {
    try {
      const node = options.getNode(nodeId);
      if (node === null || !node.bodyHash) return null;
      const file = readContainedRepositorySource(options.projectRoot, node.filePath);
      const body = file.split("\n").slice(node.startLine - 1, node.endLine).join("\n");
      if (hashNodeBody(body) !== node.bodyHash) return null;
      return { filePath: node.filePath, file, body, startLine: node.startLine, endLine: node.endLine };
    } catch {
      return null;
    }
  };

  return {
    explainChange(committed, nodeId) {
      const current = readNode(nodeId);
      if (current === null) return null;
      const oldBody = committed.bodyHash === undefined ? null : recall(committed.bodyHash);
      // The committed code hash (#236) answers "only comments" without the old
      // body; the remembered body answers it, and the layout question, with it.
      const committedCode = committedCodeHash(committed.codeHash, committed.bodyHash);
      let commentOnly = committedCode !== null
        && committedCode === codeHash(current.filePath, current.file, current.startLine, current.endLine);
      let layoutOnly = commentOnly;
      let renameOnly: boolean | undefined;
      if (oldBody !== null) {
        const oldCode = bodyTokenHash(current.filePath, oldBody, false);
        commentOnly ||= oldCode !== null && oldCode === bodyTokenHash(current.filePath, current.body, false);
        const oldLayout = bodyTokenHash(current.filePath, oldBody, true);
        layoutOnly ||= commentOnly || (oldLayout !== null && oldLayout === bodyTokenHash(current.filePath, current.body, true));
        const oldRename = declarationRenameHash(current.filePath, oldBody);
        const newRename = declarationRenameHash(current.filePath, current.body);
        // Undefined, not false, when either side cannot be hashed: an unproven
        // rename is no evidence either way.
        renameOnly = oldRename === null || newRename === null ? undefined : oldRename === newRename;
      }
      return { commentOnly, layoutOnly, ...(renameOnly === undefined ? {} : { renameOnly }), oldBody, newBody: current.body };
    },
    rememberBody(nodeId, bodyHash) {
      const path = pathFor(bodyHash);
      if (path === null || cached(bodyHash) !== null) return;
      const current = readNode(nodeId);
      if (current === null || hashNodeBody(current.body) !== bodyHash) return;
      try {
        writePrivateCachedBody(options.projectRoot, dir, bodyHash, current.body);
      } catch {
        /* A cache that cannot be written only means a later change stays `changed`. */
      }
    },
  };
}

interface CacheDirectoryBinding {
  lexicalRoot: string;
  canonicalRoot: string;
  directories: Array<{ path: string; dev: bigint; ino: bigint }>;
}

/** Bind every ancestor before an opportunistic cache write; never traverse links. */
function bindCacheDirectory(projectRoot: string, directory: string): CacheDirectoryBinding {
  const lexicalRoot = resolve(projectRoot);
  const canonicalRoot = realpathSync(lexicalRoot);
  const suffix = relative(lexicalRoot, resolve(directory));
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) throw new Error("Body cache escapes the checkout.");
  const segments = suffix === "" ? [] : suffix.split(sep);
  if (segments.length > 32) throw new Error("Body cache directory exceeds its path bound.");
  const root = lstatSync(canonicalRoot, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Unsafe body cache checkout.");
  const binding: CacheDirectoryBinding = { lexicalRoot, canonicalRoot,
    directories: [{ path: canonicalRoot, dev: root.dev, ino: root.ino }] };
  let current = canonicalRoot;
  for (const segment of segments) {
    assertCacheDirectories(binding);
    current = join(current, segment);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe body cache directory.");
    binding.directories.push({ path: current, dev: stat.dev, ino: stat.ino });
    assertCacheDirectories(binding);
  }
  return binding;
}

function assertCacheDirectories(binding: CacheDirectoryBinding): void {
  if (realpathSync(binding.lexicalRoot) !== binding.canonicalRoot) throw new Error("Body cache checkout changed.");
  for (const directory of binding.directories) {
    const current = lstatSync(directory.path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== directory.dev || current.ino !== directory.ino) throw new Error("Body cache directory changed.");
  }
}

/** Create private cache bytes only at an absent target, preserving every existing path. */
function writePrivateCachedBody(projectRoot: string, directory: string, bodyHash: string, body: string): void {
  const binding = bindCacheDirectory(projectRoot, directory);
  const parent = binding.directories.at(-1)!.path;
  const target = join(parent, `${bodyHash}.txt`);
  try { lstatSync(target); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = `${target}.body-${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let owned: { dev: bigint; ino: bigint } | undefined;
  try {
    assertCacheDirectories(binding);
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) throw new Error("Unsafe body cache temporary file.");
    owned = { dev: opened.dev, ino: opened.ino };
    assertCacheDirectories(binding);
    writeFileSync(descriptor, body, "utf8");
    const written = fstatSync(descriptor, { bigint: true });
    if (written.size !== BigInt(Buffer.byteLength(body, "utf8"))) throw new Error("Body cache write was incomplete.");
    closeSync(descriptor);
    descriptor = undefined;
    assertCacheDirectories(binding);
    const staged = lstatSync(temporary, { bigint: true });
    if (!staged.isFile() || staged.isSymbolicLink() || staged.dev !== owned.dev || staged.ino !== owned.ino) {
      throw new Error("Body cache temporary file changed.");
    }
    // A content-addressed target never needs replacement. A concurrent creator
    // or unsafe leaf makes this optional cache write fail rather than clobber.
    linkSync(temporary, target);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (owned !== undefined) {
      try {
        assertCacheDirectories(binding);
        const current = lstatSync(temporary, { bigint: true });
        if (current.isFile() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) unlinkSync(temporary);
      } catch { /* Keep a replaced path; cache cleanup never owns unrelated files. */ }
    }
  }
}
