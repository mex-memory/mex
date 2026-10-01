/**
 * Where an operation is allowed to write, and where it is not.
 *
 * Three separate questions, answered here so that no operation has to remember
 * to ask them:
 *
 * 1. **Containment.** Does this path resolve inside the scaffold root? The
 *    lexical half is `insideRoot`, the *same* function `discoverMarkdownFiles`
 *    calls, because a read side and a write side that disagree about "inside
 *    the scaffold" is its own class of bug (handoff §29.9). The symlink half is
 *    here, because the write side has two problems the read side never had.
 * 2. **Read-only reservation.** TeamWorkflowPort-owned paths are immutable to
 *    Wiki regardless of configuration. Project `wiki.readOnly` globs add more
 *    reservations. Both are enforced at plan time, before a preview exists — a
 *    preview of a change that can never be applied is worse than a refusal.
 * 3. **Writability.** Is this a Markdown file, or the temp file about to become
 *    one? That is the runtime guard behind `apply.ts`'s lint exemption,
 *    following `dbfile.ts`'s pattern: a lint rule cannot tell that
 *    `writeFileSync(p, t)` is safe, and this can, and it fails closed.
 *
 * ## The two problems the read side never had
 *
 * **`realpathSync` throws on a path that does not exist**, and `create-entry`
 * writes new files by definition. So the resolution walks up to the nearest
 * ancestor that *does* exist, resolves that, and re-appends the remaining
 * segments. A file that does not exist yet still has a real directory above it,
 * and that directory is what can be a symlink out of the scaffold.
 *
 * **Discovery only realpaths entries it walked over.** A write target can sit
 * under a symlinked *directory* the walk skipped, so resolving only the leaf
 * would miss it. Resolving the nearest existing ancestor resolves the whole
 * chain above it in one call, which is what `realpath(3)` does.
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { toPosix } from "../../paths.js";
import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import { isTeamOwnedReadOnlyPath } from "../model/team-owned-paths.js";
import { isLogOwnedPath } from "../model/log-owned-paths.js";
import { escapedSymlinkDiagnostic, insideRoot, matchesAnyGlob } from "../index/discover.js";

export {
  TEAM_OWNED_READ_ONLY_PATHS,
  isTeamOwnedReadOnlyPath,
} from "../model/team-owned-paths.js";

/** Markdown, the only content this engine writes. */
const MARKDOWN = /\.mdx?$/i;

/**
 * The temp file an atomic write goes through.
 *
 * **Deliberately not `*.md`.** Discovery walks for Markdown, so a concurrent
 * rebuild would index a half-written `foo.md.tmp` as a real file and briefly
 * publish an index containing a truncated entity — or a duplicate of one.
 */
const TEMP_SUFFIX = /\.mdx?(?:\.recovery-[0-9a-z]+)?\.tmp-[0-9a-z]+$/i;
/** Exact prior bytes retained only when in-process rollback itself fails. */
const RECOVERY_SUFFIX = /\.mdx?\.recovery-[0-9a-z]+$/i;

/**
 * Canonical TeamWorkflowPort paths that Wiki may index but must never write.
 *
 * This is an engine invariant, not a configurable default. An empty or custom
 * `wiki.readOnly` list therefore cannot transfer ownership to Wiki.
 */
export class WritePathError extends Error {
  readonly path: string;
  constructor(path: string, why: string) {
    super(`Refusing to write ${JSON.stringify(path)}: ${why}`);
    this.name = "WritePathError";
    this.path = path;
  }
}

/**
 * Resolve `absolute` through any symlinks above it, without requiring it to exist.
 *
 * Returns the real path of the nearest existing ancestor with the remaining
 * segments re-appended. When nothing on the chain exists — which cannot happen
 * for a path under a scaffold root that does — the input is returned unchanged
 * so the lexical check still gets a say.
 */
export function resolveThroughSymlinks(absolute: string): string {
  const target = resolve(absolute);
  const missing: string[] = [];
  let cursor = target;

  for (;;) {
    if (existsSync(cursor)) {
      try {
        return missing.length === 0 ? realpathSync(cursor) : join(realpathSync(cursor), ...missing.reverse());
      } catch {
        return target;
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) return target;
    missing.push(basename(cursor));
    cursor = parent;
  }
}

/** A scaffold-relative POSIX path, the key every layer in this engine uses. */
export function toScaffoldRelative(scaffoldRoot: string, absolute: string): string {
  return toPosix(relative(resolve(scaffoldRoot), resolve(absolute)));
}

export interface ContainmentResult {
  /** Absolute path with the ancestor chain resolved. */
  resolved: string;
  /** Scaffold-relative POSIX path of the *declared* location, for reporting. */
  path: string;
  diagnostic: WikiDiagnostic | null;
}

/**
 * Check one write target: lexically first, then through the symlink chain.
 *
 * Lexical first, because a `../` in a caller-supplied path should be refused
 * for what it says rather than for where it happens to land — the model's own
 * `scaffoldPathValidator` already rejects it, and this is the second gate for
 * a path that reached here another way. The realpath check is what catches the
 * case string inspection cannot see.
 */
export function checkContainment(scaffoldRoot: string, relativePath: string): ContainmentResult {
  const root = resolve(scaffoldRoot);
  const declared = toPosix(relativePath);
  const absolute = resolve(root, relativePath);

  if (isAbsolute(relativePath) || declared.split("/").includes("..") || !insideRoot(root, absolute)) {
    return {
      resolved: absolute,
      path: declared,
      diagnostic: diagnostic("PATH_OUTSIDE_SCAFFOLD", `${declared} is not inside the scaffold root.`, {
        file: declared,
        severity: "error",
      }),
    };
  }

  const resolved = resolveThroughSymlinks(absolute);
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  if (!insideRoot(realRoot, resolved)) {
    // The same report the read side gives for the same path, raised to `error`:
    // a read skips an escaping file, a write must refuse to make one.
    return {
      resolved,
      path: declared,
      diagnostic: { ...escapedSymlinkDiagnostic(declared, resolved), severity: "error" },
    };
  }

  return { resolved, path: declared, diagnostic: null };
}

/**
 * Is this path reserved from Wiki writes?
 *
 * Hard team ownership is checked first and cannot be configured away. Project
 * patterns are matched against the scaffold-relative POSIX path with the same
 * glob matcher `wiki.exclude` uses, so the settings cannot come to mean
 * different things about the same pattern.
 */
export function isReadOnlyPath(relativePath: string, readOnly: readonly string[]): boolean {
  const path = toPosix(relativePath);
  return isTeamOwnedReadOnlyPath(path) || isLogOwnedPath(path) || matchesAnyGlob(path, readOnly);
}

/** The diagnostic a plan returns when its target is reserved. */
export function readOnlyDiagnostic(relativePath: string): WikiDiagnostic {
  const path = toPosix(relativePath);
  const reason = isLogOwnedPath(path)
    ? "is owned by the note writer and is always read-only to Wiki"
    : isTeamOwnedReadOnlyPath(path)
    ? "is owned by TeamWorkflowPort and is always read-only to Wiki"
    : "is reserved read-only by wiki.readOnly";
  return diagnostic(
    "WRITE_SCOPE_VIOLATION",
    `${path} ${reason}. Nothing was written.`,
    { file: path },
  );
}

/**
 * The runtime write guard. Throws unless `absolute` is a Markdown file, or the
 * temp file that is about to become one, inside `scaffoldRoot`.
 *
 * This is `dbfile.ts`'s `assertIndexPath` for the operations layer, and it
 * exists for the same reason: being on the lint's allowlist is an exemption
 * with nothing behind it. A guard fails closed on a caller's bug; a lint rule
 * cannot see one.
 */
export function assertWritablePath(scaffoldRoot: string, absolute: string): void {
  const root = resolve(scaffoldRoot);
  const target = resolve(absolute);
  const name = basename(target);

  if (!MARKDOWN.test(name) && !TEMP_SUFFIX.test(name) && !RECOVERY_SUFFIX.test(name)) {
    throw new WritePathError(target, "the operation pipeline only writes Markdown files.");
  }
  if (!insideRoot(root, target) || !insideRoot(existsSync(root) ? realpathSync(root) : root, resolveThroughSymlinks(target))) {
    throw new WritePathError(target, `it is outside the scaffold root ${root}${sep}.`);
  }
}
