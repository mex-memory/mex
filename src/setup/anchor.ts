import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { planManagedBlockEdit } from "../managed-block.js";
import {
  ANCHOR_FILES,
  MEX_ANCHOR_END,
  MEX_ANCHOR_START,
  isToolConfigCopy,
  opencodeInstructions,
  referencesScaffold,
} from "../tool-config.js";

export { MEX_ANCHOR_END, MEX_ANCHOR_START };

/**
 * Writing the scaffold pointer into a tool anchor the user may already own.
 *
 * Setup used to skip any anchor that already existed, which is the default
 * outcome for the most likely adopter -- an established repo with a
 * hand-written `.cursorrules`. The scaffold got populated, at the cost of a
 * full AI pass over the codebase, and then nothing ever loaded it.
 *
 * Claude Code and Codex were rescued in 0.8 by the agent-skills installer,
 * which owns `CLAUDE.md` and `AGENTS.md`. This is the same treatment for the
 * four anchors that installer does not seed from a template, and which must
 * stay linked whether or not a project's skills have been synced.
 * See https://github.com/mex-memory/mex/issues/106
 */

/** Matches the agent-skills cap: refuse to preview an unreasonable block. */
const MAX_ANCHOR_PREVIEW_BYTES = 32 * 1024;

/**
 * Fail closed on any destination that is not a known root tool config.
 *
 * This module writes into files a human wrote, so it is one of the few writers
 * outside the wiki engine (see the pinned inventory in
 * test/wiki-architecture.test.ts). It never touches `.mex/`, and this is what
 * makes that a fact rather than a claim about current call sites: the
 * destination comes from the fixed registry, not from the caller.
 */
function assertAnchorPath(relativePath: string): void {
  if (!ANCHOR_FILES.some((anchor) => anchor.path === relativePath)) {
    throw new Error(
      `Refusing to write ${relativePath}: not a known AI tool config. `
        + `Expected one of ${ANCHOR_FILES.map((a) => a.path).join(", ")}.`,
    );
  }
}

/** The scaffold file OpenCode is pointed at, matching the shipped template. */
const OPENCODE_INSTRUCTION = ".mex/AGENTS.md";

export type AnchorOutcome =
  /** No anchor existed; the full template was copied. */
  | "created"
  /** A pointer block was appended to the user's existing file. */
  | "appended"
  /** An existing mex-owned pointer block was brought up to date. */
  | "updated"
  /** The anchor already pointed at the scaffold; nothing to do. */
  | "already-linked"
  /** The file could not be edited safely and was left untouched. */
  | "conflict";

export interface AnchorWriteResult {
  readonly outcome: AnchorOutcome;
  /** Present only for `conflict`, explaining what to do by hand. */
  readonly reason?: string;
}

/** The block appended to a markdown anchor that has no mex pointer. */
export function renderAnchorPointerBlock(eol: "\n" | "\r\n" = "\n"): string {
  return [
    MEX_ANCHOR_START,
    "## MEX project context",
    "- At the start of every session, read `.mex/AGENTS.md` and `.mex/ROUTER.md` before project work; follow `ROUTER.md` to load only the relevant context.",
    "- Treat the scaffold as the source of truth for architecture, stack, conventions, and decisions; prefer it over re-deriving context from the code.",
    "- Do not claim an author, date, or historical event unless the retrieved data actually provides it.",
    MEX_ANCHOR_END,
  ].join(eol);
}

/**
 * Plan the edit for a markdown anchor. Split out from the write so `--dry-run`
 * reports the branch that will actually be taken -- the old dry-run message
 * claimed setup would overwrite the file when the real run skipped it.
 */
export function planAnchorPointer(currentBytes: Uint8Array | null): AnchorWriteResult & {
  readonly desiredBytes?: Uint8Array;
} {
  const edit = planManagedBlockEdit(
    {
      start: MEX_ANCHOR_START,
      end: MEX_ANCHOR_END,
      render: renderAnchorPointerBlock,
      maxPreviewBytes: MAX_ANCHOR_PREVIEW_BYTES,
      // A file mex itself wrote from `.tool-configs/` already carries the
      // pointer in its own prose. Appending a block would restate it.
      isAlreadyPointing: (content) => isToolConfigCopy(content) || referencesScaffold(content),
    },
    currentBytes,
  );

  switch (edit.action) {
    case "create":
      return { outcome: "created", desiredBytes: edit.desiredBytes };
    case "noop":
      return { outcome: "already-linked" };
    case "update":
      return {
        outcome: edit.reason === "append" ? "appended" : "updated",
        desiredBytes: edit.desiredBytes,
      };
    default:
      return { outcome: "conflict", reason: conflictReason(edit.reason) };
  }
}

function conflictReason(reason: string): string {
  if (reason === "invalid-encoding") return "the file is not valid UTF-8";
  if (reason === "malformed-markers") {
    return `it contains unbalanced ${MEX_ANCHOR_START} / ${MEX_ANCHOR_END} markers`;
  }
  return "its existing mex block is too large to edit safely";
}

/**
 * Ensure a markdown anchor points at the scaffold, preserving every byte the
 * user wrote. Copies the template when the file is absent, appends a pointer
 * block when it is not.
 */
export function ensureMarkdownAnchor(
  projectRoot: string,
  relativePath: string,
  templatePath: string,
): AnchorWriteResult {
  assertAnchorPath(relativePath);
  const dest = resolve(projectRoot, relativePath);

  if (!existsSync(dest)) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(templatePath, dest);
    return { outcome: "created" };
  }

  const plan = planAnchorPointer(readFileSync(dest));
  if (plan.desiredBytes) writeFileSync(dest, plan.desiredBytes);
  return { outcome: plan.outcome, reason: plan.reason };
}

/**
 * Plan the OpenCode edit without writing, so `--dry-run` reports the branch
 * the real run will take.
 */
export function planOpencodeAnchor(content: string): AnchorWriteResult & {
  readonly serialized?: string;
} {
  const instructions = opencodeInstructions(content);
  if (instructions === null) {
    return {
      outcome: "conflict",
      reason: "it is not a JSON object with an optional string `instructions` array",
    };
  }
  if (instructions.some((entry) => entry.startsWith(".mex/") || referencesScaffold(entry))) {
    return { outcome: "already-linked" };
  }

  const parsed = JSON.parse(content) as Record<string, unknown>;
  parsed.instructions = [...instructions, OPENCODE_INSTRUCTION];
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`.split("\n").join(eol);
  return { outcome: "appended", serialized };
}

/**
 * Ensure OpenCode's config lists a scaffold instruction file. OpenCode reads
 * a JSON array rather than prose, so the merge is a list insertion; the rest
 * of the user's config is preserved and re-serialized.
 */
export function ensureOpencodeAnchor(
  projectRoot: string,
  relativePath: string,
  templatePath: string,
): AnchorWriteResult {
  assertAnchorPath(relativePath);
  const dest = resolve(projectRoot, relativePath);

  if (!existsSync(dest)) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(templatePath, dest);
    return { outcome: "created" };
  }

  const plan = planOpencodeAnchor(readFileSync(dest, "utf-8"));
  if (plan.serialized !== undefined) writeFileSync(dest, plan.serialized, "utf-8");
  return { outcome: plan.outcome, reason: plan.reason };
}
