import { createHash } from "node:crypto";

/**
 * Merging a mex-owned block into a file the user already wrote.
 *
 * Two callers need this and they must not diverge: the agent-skills installer
 * maintains the skills policy block in `CLAUDE.md` / `AGENTS.md`, and setup
 * maintains a scaffold pointer block in the anchors that have no skills
 * (`.cursorrules`, `.windsurfrules`, `.github/copilot-instructions.md`). Both
 * face the same hazard -- a hand-written file whose bytes outside the block
 * must survive byte-for-byte -- so the marker parsing, EOL detection and
 * append/replace decision live here once.
 */

export type ManagedBlockAction =
  | "create"
  | "migrate"
  | "update"
  | "noop"
  | "conflict";

export type ManagedBlockScope =
  | "create"
  | "append"
  | "replace"
  | "known-legacy-migration";

export type ManagedBlockReason =
  | "absent"
  | "legacy"
  | "append"
  | "replace"
  | "exact"
  | "managed-block-too-large"
  | "malformed-markers"
  | "invalid-encoding";

/** Bounded exact block preview; never contains arbitrary user-file bytes. */
export interface ManagedBlockChange {
  readonly scope: ManagedBlockScope;
  /** Exact previous marker-delimited block, or null when none existed. */
  readonly before: string | null;
  /** Exact marker-delimited block that will be installed. */
  readonly after: string;
}

export interface ManagedBlockEdit {
  readonly action: ManagedBlockAction;
  readonly desiredBytes?: Uint8Array;
  readonly change?: ManagedBlockChange;
  readonly reason: ManagedBlockReason;
}

export interface ManagedBlockSpec {
  readonly start: string;
  readonly end: string;
  /** Renders the full block, markers included, using the file's own EOL. */
  readonly render: (eol: "\n" | "\r\n") => string;
  /** Refuse to preview a block larger than this, in bytes. */
  readonly maxPreviewBytes: number;
  /**
   * Exact SHA-256 values of files a previous mex version wrote verbatim. Such
   * a file is replaced wholesale rather than appended to, since every byte of
   * it is already mex's. A hand-edited descendant does not match and is
   * appended to instead.
   */
  readonly legacyHashes?: ReadonlySet<string>;
  /**
   * Recognises a file that already carries mex's pointer by other means -- an
   * older full-template copy, say. Such a file needs no block: appending one
   * would duplicate guidance the file already gives.
   */
  readonly isAlreadyPointing?: (content: string) => boolean;
}

/**
 * Compute an edit without writing. Bytes outside a valid managed block are
 * copied into the desired output unchanged.
 */
export function planManagedBlockEdit(
  spec: ManagedBlockSpec,
  currentBytes: Uint8Array | null,
): ManagedBlockEdit {
  if (currentBytes === null) {
    const after = spec.render("\n");
    return {
      action: "create",
      desiredBytes: Buffer.from(`${after}\n`, "utf8"),
      change: { scope: "create", before: null, after },
      reason: "absent",
    };
  }

  let current: string;
  try {
    // `ignoreBOM: true` counterintuitively means "do not consume the BOM".
    // Keeping U+FEFF in the decoded string preserves the original BOM bytes.
    current = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(currentBytes);
  } catch {
    return { action: "conflict", reason: "invalid-encoding" };
  }

  const starts = allIndexesOf(current, spec.start);
  const ends = allIndexesOf(current, spec.end);

  if (starts.length === 0 && ends.length === 0) {
    const eol = detectEol(current);

    if (spec.legacyHashes?.has(sha256(currentBytes))) {
      const after = spec.render(eol);
      return {
        action: "migrate",
        desiredBytes: Buffer.from(`${after}${eol}`, "utf8"),
        change: { scope: "known-legacy-migration", before: null, after },
        reason: "legacy",
      };
    }

    if (spec.isAlreadyPointing?.(current)) {
      return { action: "noop", reason: "exact" };
    }

    const after = spec.render(eol);
    const separator = current.length === 0 ? "" : current.endsWith("\n") ? eol : `${eol}${eol}`;
    return {
      action: "update",
      desiredBytes: Buffer.from(`${current}${separator}${after}${eol}`, "utf8"),
      change: { scope: "append", before: null, after },
      reason: "append",
    };
  }

  if (
    starts.length !== 1 ||
    ends.length !== 1 ||
    starts[0]! >= ends[0]! ||
    !isStandaloneMarker(current, starts[0]!, spec.start) ||
    !isStandaloneMarker(current, ends[0]!, spec.end)
  ) {
    return { action: "conflict", reason: "malformed-markers" };
  }

  const eol = detectEol(current);
  const before = current.slice(starts[0]!, ends[0]! + spec.end.length);
  if (Buffer.byteLength(before, "utf8") > spec.maxPreviewBytes) {
    return { action: "conflict", reason: "managed-block-too-large" };
  }

  const after = spec.render(eol);
  const desired =
    current.slice(0, starts[0]!) + after + current.slice(ends[0]! + spec.end.length);
  if (desired === current) {
    return { action: "noop", reason: "exact" };
  }
  return {
    action: "update",
    desiredBytes: Buffer.from(desired, "utf8"),
    change: { scope: "replace", before, after },
    reason: "replace",
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function detectEol(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function allIndexesOf(content: string, needle: string): number[] {
  const indexes: number[] = [];
  let offset = 0;
  while (offset <= content.length - needle.length) {
    const found = content.indexOf(needle, offset);
    if (found < 0) break;
    indexes.push(found);
    offset = found + needle.length;
  }
  return indexes;
}

function isStandaloneMarker(content: string, index: number, marker: string): boolean {
  const before = index === 0 ? "" : content[index - 1];
  const afterIndex = index + marker.length;
  const after = afterIndex === content.length ? "" : content[afterIndex];
  const beginsLine = before === "" || before === "\n";
  const endsLine =
    after === "" || after === "\n" || (after === "\r" && content[afterIndex + 1] === "\n");
  return beginsLine && endsLine;
}

export interface ManagedBlockRemoval {
  readonly action: "remove" | "noop" | "conflict";
  /** The file as it should be once the block is gone; absent unless `action` is `remove`. */
  readonly desiredBytes?: Uint8Array;
  /** True when nothing but whitespace remains, i.e. the file held only the block. */
  readonly empty?: boolean;
  /** Exact marker-delimited block that will be removed. */
  readonly removed?: string;
  readonly reason: "absent" | "removed" | "malformed-markers" | "invalid-encoding";
}

/**
 * Compute the removal of a managed block without writing. It inverts
 * {@link planManagedBlockEdit}'s append: the block, the line ending after it and
 * the blank-line separator before it go, and every other byte stays. Removing
 * a block that was appended to a file therefore restores that file exactly,
 * except that a file which had no final newline gets one: the append writes the
 * same bytes for both, so the original cannot be recovered.
 */
export function planManagedBlockRemoval(
  spec: Pick<ManagedBlockSpec, "start" | "end">,
  currentBytes: Uint8Array | null,
): ManagedBlockRemoval {
  if (currentBytes === null) return { action: "noop", reason: "absent" };
  let current: string;
  try {
    current = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(currentBytes);
  } catch {
    return { action: "conflict", reason: "invalid-encoding" };
  }
  const starts = allIndexesOf(current, spec.start);
  const ends = allIndexesOf(current, spec.end);
  if (starts.length === 0 && ends.length === 0) return { action: "noop", reason: "absent" };
  if (
    starts.length !== 1 ||
    ends.length !== 1 ||
    starts[0]! >= ends[0]! ||
    !isStandaloneMarker(current, starts[0]!, spec.start) ||
    !isStandaloneMarker(current, ends[0]!, spec.end)
  ) {
    return { action: "conflict", reason: "malformed-markers" };
  }

  const eol = detectEol(current);
  const blockEnd = ends[0]! + spec.end.length;
  let head = current.slice(0, starts[0]!);
  let tail = current.slice(blockEnd);
  if (tail.startsWith(eol)) tail = tail.slice(eol.length);
  // The append put a blank line between existing text and the block; take that back.
  if (head.endsWith(`${eol}${eol}`) && tail === "") head = head.slice(0, -eol.length);
  const desired = head + tail;
  return {
    action: "remove",
    desiredBytes: Buffer.from(desired, "utf8"),
    empty: desired.trim() === "",
    removed: current.slice(starts[0]!, blockEnd),
    reason: "removed",
  };
}
