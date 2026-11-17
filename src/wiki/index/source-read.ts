/** Descriptor-bound, no-follow reads of canonical Wiki Markdown. */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, relative, resolve, sep } from "node:path";
import { WIKI_CORPUS_LIMITS, WikiCorpusLimitError } from "./corpus-policy.js";

export class WikiSourceReadError extends Error {
  readonly path: string;
  constructor(path: string, readonly exactByteHash?: string) {
    super(`Could not safely read ${path}.`);
    this.name = "WikiSourceReadError";
    this.path = path;
  }
}

export interface ContainedSourceReadOptions {
  /** Test-only data seam, invoked only after the real leaf is safely bound. */
  readFile?: (absolutePath: string) => string;
  /** Deterministic race seam after descriptor open and before final binding. */
  afterOpen?: () => void;
  /** Deterministic race seam after bytes are read and before post-binding. */
  afterRead?: () => void;
}

/**
 * Read one regular file without ever following its leaf or accepting a parent
 * or scaffold retarget. A discovered pathname is only a candidate; the opened
 * descriptor and its final pathname identity are the authority.
 */
export function readContainedSource(
  scaffoldRoot: string,
  absolutePath: string,
  options: ContainedSourceReadOptions = {},
): string {
  const root = resolve(scaffoldRoot);
  const target = resolve(absolutePath);
  const rel = relative(root, target);
  const label = rel.split(sep).join("/");
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || rel.includes("\0")) {
    throw new WikiSourceReadError(label);
  }

  let fd: number | undefined;
  try {
    const rootLexical = lstatSync(root, { bigint: true });
    if (!rootLexical.isDirectory() || rootLexical.isSymbolicLink()) throw new WikiSourceReadError(label);
    // Native resolution avoids repeated ancestor walks while the descriptor and
    // before/after directory identities still enforce the same containment.
    const realRoot = realpathSync.native(root);
    const rootStats = lstatSync(realRoot, { bigint: true });
    const parent = dirname(target);
    const parentLexical = lstatSync(parent, { bigint: true });
    if (!parentLexical.isDirectory() || parentLexical.isSymbolicLink()) throw new WikiSourceReadError(label);
    const realParent = realpathSync.native(parent);
    const parentRel = relative(realRoot, realParent);
    if (parentRel === ".." || parentRel.startsWith(`..${sep}`)) throw new WikiSourceReadError(label);
    const parentStats = lstatSync(realParent, { bigint: true });

    fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) throw new WikiSourceReadError(label);
    if (opened.size > BigInt(WIKI_CORPUS_LIMITS.maxFileBytes)) {
      throw new WikiCorpusLimitError("maxFileBytes");
    }
    options.afterOpen?.();

    const rootNowLexical = lstatSync(root, { bigint: true });
    const realRootNow = realpathSync.native(root);
    const rootNow = lstatSync(realRootNow, { bigint: true });
    const parentNowLexical = lstatSync(parent, { bigint: true });
    const realParentNow = realpathSync.native(parent);
    const parentNow = lstatSync(realParentNow, { bigint: true });
    const leafNow = lstatSync(target, { bigint: true });
    if (
      !rootNowLexical.isDirectory()
      || rootNowLexical.isSymbolicLink()
      || realRootNow !== realRoot
      || rootNow.dev !== rootStats.dev
      || rootNow.ino !== rootStats.ino
      || !parentNowLexical.isDirectory()
      || parentNowLexical.isSymbolicLink()
      || realParentNow !== realParent
      || parentNow.dev !== parentStats.dev
      || parentNow.ino !== parentStats.ino
      || leafNow.isSymbolicLink()
      || leafNow.dev !== opened.dev
      || leafNow.ino !== opened.ino
    ) throw new WikiSourceReadError(label);

    // Test readers model unreadability/deterministic alternate bytes. The safe
    // descriptor binding above still proves the supplied path is canonical.
    const rawBytes = readFileSync(fd);
    const exactByteHash = createHash("sha256").update(rawBytes).digest("hex");
    let result: string;
    try {
      result = options.readFile !== undefined
        ? options.readFile(target)
        // Fatal decoding preserves the claim that the stored hash is over exact
        // file bytes: every accepted UTF-8 byte sequence round-trips exactly,
        // while malformed bytes are diagnosed instead of collapsing to U+FFFD.
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBytes);
    } catch {
      throw new WikiSourceReadError(label, exactByteHash);
    }
    if (Buffer.byteLength(result, "utf8") > WIKI_CORPUS_LIMITS.maxFileBytes) {
      throw new WikiCorpusLimitError("maxFileBytes");
    }
    options.afterRead?.();

    // Reading is itself a race boundary. Rebind the descriptor, its pathname,
    // and both containing directories after every byte has been consumed so a
    // same-inode edit or parent/leaf swap cannot enter a supposedly exact
    // corpus observation.
    const afterRead = fstatSync(fd, { bigint: true });
    const rootAfterLexical = lstatSync(root, { bigint: true });
    const realRootAfter = realpathSync.native(root);
    const rootAfter = lstatSync(realRootAfter, { bigint: true });
    const parentAfterLexical = lstatSync(parent, { bigint: true });
    const realParentAfter = realpathSync.native(parent);
    const parentAfter = lstatSync(realParentAfter, { bigint: true });
    const leafAfter = lstatSync(target, { bigint: true });
    if (
      !rootAfterLexical.isDirectory()
      || rootAfterLexical.isSymbolicLink()
      || realRootAfter !== realRoot
      || rootAfter.dev !== rootStats.dev
      || rootAfter.ino !== rootStats.ino
      || !parentAfterLexical.isDirectory()
      || parentAfterLexical.isSymbolicLink()
      || realParentAfter !== realParent
      || parentAfter.dev !== parentStats.dev
      || parentAfter.ino !== parentStats.ino
      || leafAfter.isSymbolicLink()
      || leafAfter.dev !== opened.dev
      || leafAfter.ino !== opened.ino
      || afterRead.dev !== opened.dev
      || afterRead.ino !== opened.ino
      || afterRead.size !== opened.size
      || afterRead.mtimeNs !== opened.mtimeNs
      || afterRead.ctimeNs !== opened.ctimeNs
    ) throw new WikiSourceReadError(label);
    return result;
  } catch (error) {
    if (error instanceof WikiSourceReadError || error instanceof WikiCorpusLimitError) throw error;
    throw new WikiSourceReadError(label);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
