/**
 * §11.3 steps 8–11. **The only module under `src/wiki/` that writes Markdown.**
 *
 * Its lint exemption carries a runtime guard, following `dbfile.ts`'s pattern:
 * every mutation goes through {@link assertWritablePath}, which rejects
 * anything that is not a Markdown file (or the temp file about to become one)
 * inside the scaffold root, and fails closed. A lint rule cannot tell that
 * `writeFileSync(p, t)` is safe; the guard can.
 *
 * ## Apply re-plans. It does not replay bytes.
 *
 * The plan carries offsets computed against one parse. Trusting them after a
 * revalidation boundary is exactly the failure `applyEdits`' complement check
 * exists to catch — an edit whose range was computed against a stale parse
 * lands in the wrong place and still produces plausible text. So apply plans
 * again from the current tree and compares:
 *
 * - the **preconditions** must still hold, entity by entity, on the normalized
 *   hash the codec computes;
 * - if the caller supplies a `previewHash`, the whole tree must still be the
 *   one the preview was produced against — that is what an approval binds to.
 *
 * A concurrent edit to an *unrelated* entity in the same file therefore does
 * not block an unbound apply, and is carried through, because the re-plan is
 * built on it. A concurrent edit to the subject does block, as
 * `CONTENT_HASH_CONFLICT`.
 *
 * ## Multi-file operations cannot be atomic, so the question is which bad state
 *
 * There is no two-file rename and rollback code does not run under `SIGKILL`.
 * The constraint (HARD 7) is absolute in one direction only: **a process killed
 * at any point must leave the entity present somewhere.** So files are written
 * **largest gain first** — the file that receives content before the file that
 * loses it. A crash between the two renames leaves a duplicate id, which is a
 * state the index is built to hold and report: both claimants are stored,
 * `DUPLICATE_ENTITY_ID` is emitted, and `MIN(entity_key)` shadows one
 * deterministically. Replaying the `opId` finishes the move. Source-first would
 * leave the entity nowhere, and no probability of that is acceptable.
 *
 * ## The index is a cache and is treated like one
 *
 * If the post-write refresh fails — or there is no `wiki.db` at all, which is
 * the *normal* case, since nothing in production builds one — the result
 * carries `INDEX_REFRESH_REQUIRED` and **the Markdown write stands**. Never
 * undo a valid write because a disposable cache broke, and never rebuild one
 * behind the user's back in the middle of an apply.
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import type { EntityId } from "../model/ids.js";
import { entityContentHash, exactFileContentHash } from "../model/hash.js";
import { entityTextOf } from "../markdown/codec.js";
import type { GroundingResolver } from "../index/write.js";
import { refreshWikiIndex } from "../index/refresh.js";
import { defaultIndexPath } from "../index/rebuild.js";
import { WikiCorpusLimitError } from "../index/corpus-policy.js";
import { readContainedSource } from "../index/source-read.js";
import { acquireWikiMaintenanceLease, type WikiMaintenanceLease } from "../index/dbfile.js";
import { assertWritablePath, checkContainment, isReadOnlyPath, readOnlyDiagnostic, WritePathError } from "./paths.js";
import { syncDirectory } from "./durability.js";
import {
  attestEntityClaimants,
  locateEntity,
  WikiClaimantScanIncompleteError,
  type AttestedEntityClaimants,
} from "./locate.js";
import { applyEdits } from "../markdown/patch.js";
import { payloadHashOf, planOperation, verifyPlan, writeScopeDiagnostic, type PlanOptions, type PlannedFileEdit, type RevisionChange, type WikiPatchPlan } from "./plan.js";
import { previewHashOf, previewPlan, type WikiPreview } from "./preview.js";
import {
  appendAudit,
  auditRecord,
  OperationLogPathError,
  readAuditLog,
  readOperationLogExact,
  recordFor,
  restoreOperationLogExact,
  type AuditEntry,
} from "./audit.js";

export interface ApplyOptions extends PlanOptions {
  /** Where `wiki.db` lives. Absent is normal, not an error. */
  indexPath?: string;
  /** Bind this apply to the exact tree a preview was produced against. */
  previewHash?: string;
  /** Grounding health for the post-write refresh, when a graph is available. */
  resolveGrounding?: GroundingResolver;
  targetedGroundings?: boolean;
  now?: () => string;
  /**
   * Called after each file is renamed into place.
   *
   * The crash seam. There is no portable way to `SIGKILL` a process mid-apply
   * inside a test runner, so the kill is injected here: a hook that throws
   * after the first rename leaves precisely the on-disk state a real crash
   * would, and the recovery path is then exercised against real bytes rather
   * than against a mock.
   */
  onFileWritten?: (path: string) => void;
  /** Test-only process-death seam after one child completes durably. */
  onOperationCompleted?: (opId: string) => void;
  /** Deterministic adversarial seam before the bound parent is revalidated. */
  beforeFileOpen?: (path: string) => void;
  /** Deterministic adversarial seam before the final same-directory rename. */
  beforeFileRename?: (path: string) => void;
  /** Deterministic ordinary-failure seam after rename but before durability. */
  afterFileRename?: (path: string) => void;
  /** Deterministic ordinary-failure seam used to prove ledger rollback. */
  beforeAuditAppend?: (phase: "intent" | "complete", opId: string) => void;
  /** Deterministic failure after ledger bytes land but before their fsync. */
  afterAuditWrite?: (phase: "intent" | "complete", opId: string) => void;
  /** Internal final corpus/revision assertion, still inside rollback scope. */
  beforeSequenceCommit?: () => void;
  /** Existing migration/operation lease; internal callers use it to avoid re-entry. */
  maintenanceLease?: WikiMaintenanceLease;
}

/** A test-only process-death seam. Ordinary exceptions are rolled back. */
export class SimulatedWikiCrashError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SimulatedWikiCrashError";
    this.cause = cause;
  }
}

export class WikiWriteRecoveryError extends Error {
  readonly cause: unknown;
  readonly recoveryPaths: readonly string[];
  constructor(cause: unknown, recoveryPaths: readonly string[] = []) {
    super(
      "The Wiki write failed and its exact prior bytes could not be fully restored; manual recovery is required."
      + (recoveryPaths.length === 0 ? "" : ` Recovery artifacts: ${recoveryPaths.join(", ")}.`)
      // The write that started this is the only thing that says *why*, and it
      // was being retained as `cause` and printed nowhere: every log line, test
      // failure and user-facing report said only that recovery was incomplete.
      // A cause nobody prints is a cause nobody reads.
      + causeSummary(cause),
    );
    this.name = "WikiWriteRecoveryError";
    this.cause = cause;
    this.recoveryPaths = recoveryPaths;
  }
}

/** The `{ writeError, recoveryErrors }` cause, rendered for the message. */
function causeSummary(cause: unknown): string {
  if (!isPlainRecord(cause)) return cause === undefined ? "" : ` Cause: ${messageOf(cause)}.`;
  const parts: string[] = [];
  if ("writeError" in cause) parts.push(`the write failed with ${messageOf(cause.writeError)}`);
  const recoveryErrors = "recoveryErrors" in cause ? cause.recoveryErrors : undefined;
  if (Array.isArray(recoveryErrors) && recoveryErrors.length > 0) {
    parts.push(`recovery then failed with ${recoveryErrors.map(messageOf).join("; ")}`);
  }
  return parts.length === 0 ? "" : ` Cause: ${parts.join(", and ")}.`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return String(value);
}

export interface ApplyResult {
  ok: boolean;
  opId: string;
  /** Scaffold-relative paths actually written. Empty on a replayed no-op. */
  changedFiles: string[];
  revisions: RevisionChange[];
  createdIds: string[];
  /** True when the log already held a completion for this `opId`. */
  replayed: boolean;
  preview: WikiPreview | null;
  diagnostics: WikiDiagnostic[];
}

export interface ApplyPlannedOptions extends ApplyOptions {
  /** Must be the revision returned with this exact opaque plan. */
  expectedPreviewHash: string;
}

function failure(opId: string, diagnostics: WikiDiagnostic[]): ApplyResult {
  return {
    ok: false,
    opId,
    changedFiles: [],
    revisions: [],
    createdIds: [],
    replayed: false,
    preview: null,
    diagnostics,
  };
}

/** The envelope's opId, without trusting the envelope's shape. */
function opIdOf(envelope: unknown): string {
  const raw = envelope as { opId?: unknown };
  return typeof raw?.opId === "string" ? raw.opId : "";
}

function payloadOf(envelope: unknown): unknown {
  return (envelope as { payload?: unknown })?.payload;
}

function typeOf(envelope: unknown): string {
  const raw = envelope as { type?: unknown };
  return typeof raw?.type === "string" ? raw.type : "";
}

/**
 * Apply one operation, or say why not.
 *
 * Idempotent by `opId`: a replayed operation is a no-op that reports what the
 * original did. **The same `opId` with a different payload is a validation
 * failure**, not a retry — accepting it would make the audit log a work of
 * fiction, since one line would then describe two different changes.
 */
export function applyOperation(envelope: unknown, options: ApplyOptions): ApplyResult {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const indexPath = options.indexPath ?? defaultIndexPath(scaffoldRoot);
  const ownedLease = options.maintenanceLease === undefined;
  const lease = options.maintenanceLease ?? acquireWikiMaintenanceLease(indexPath, "operation", scaffoldRoot);
  try {
    return applyOperationHeld(envelope, { ...options, maintenanceLease: lease });
  } finally {
    if (ownedLease) lease.release();
  }
}

function applyOperationHeld(envelope: unknown, options: ApplyOptions): ApplyResult {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const opId = opIdOf(envelope);
  const log = readAuditLog(scaffoldRoot);
  const carried = [...log.diagnostics];

  if (opId === "") {
    return failure(opId, [...carried, diagnostic("INVALID_OPERATION_ENVELOPE", "An operation needs an `opId`.")]);
  }

  const record = recordFor(log, opId);
  const proposed = payloadHashOf(typeOf(envelope) as never, payloadOf(envelope));

  const priorHash = record.complete?.payloadHash ?? record.intent?.payloadHash ?? null;
  if (priorHash !== null && priorHash !== proposed) {
    return failure(opId, [
      ...carried,
      diagnostic(
        "INVALID_OPERATION_ENVELOPE",
        `Operation ${opId} has already been recorded with a different payload. Reusing an opId for a different change is a caller bug, not a retry.`,
      ),
    ]);
  }

  if (record.complete !== null) {
    return {
      ok: true,
      opId,
      changedFiles: [...record.complete.files],
      revisions: record.complete.revisions.map((change) => ({ ...change })),
      createdIds: [...record.complete.createdIds],
      replayed: true,
      preview: null,
      diagnostics: carried,
    };
  }

  // An intent with no completion is work that was interrupted. Resume it with
  // the ids it already minted and the file it started from, so a resumed
  // `create-entry` re-uses its id rather than minting a second entity and a
  // resumed `move-entry` finishes in the direction it began.
  const resuming = record.intent;
  const planOptions: PlanOptions = resuming === null
    ? options
    : {
        ...options,
        ...(resuming.createdIds.length > 0 ? { generateId: mintFrom(resuming.createdIds) } : {}),
        ...(resuming.files.length > 0 && resuming.type === "move-entry"
          ? { preferFile: sourceFileOf(resuming, options) }
          : {}),
      };

  const planned = planOperation(envelope, planOptions);
  if (!planned.ok) {
    if (resuming !== null && alreadySettled(resuming, options)) {
      // The interrupted work had in fact landed; the process died before it
      // could say so. Record the completion rather than reporting a failure
      // for an operation that succeeded.
      const exactAudit = readOperationLogExact(scaffoldRoot);
      appendAudit(
        scaffoldRoot,
        { ...resuming, phase: "complete", ...(options.now ? { timestamp: options.now() } : {}) },
        { expectedText: exactAudit.text, expectedExists: exactAudit.exists },
      );
      return {
        ok: true,
        opId,
        changedFiles: [...resuming.files],
        revisions: resuming.revisions.map((change) => ({ ...change })),
        createdIds: [...resuming.createdIds],
        replayed: true,
        preview: null,
        diagnostics: carried,
      };
    }
    return failure(opId, [...carried, ...planned.diagnostics]);
  }

  const plan = planned.plan;

  if (options.previewHash !== undefined && previewHashOf(plan) !== options.previewHash) {
    return failure(opId, [
      ...carried,
      diagnostic(
        "CONTENT_HASH_CONFLICT",
        "The tree changed since this operation was previewed. Re-plan, re-review and retry.",
      ),
    ]);
  }

  const stale = revalidate(
    plan,
    planOptions,
    resuming !== null && plan.type === "move-entry" ? resuming.files : undefined,
  );
  if (stale.length > 0) return failure(opId, [...carried, ...stale]);
  const revision = previewHashOf(plan);
  const applied = applyPlannedOperationSequence([plan], {
    ...options,
    expectedSequenceRevision: revision,
    sequenceRevision: revision,
  });
  return {
    ok: applied.ok,
    opId,
    changedFiles: applied.changedFiles,
    revisions: applied.ok ? plan.revisions.map((change) => ({ ...change })) : [],
    createdIds: applied.ok ? [...plan.createdIds] : [],
    replayed: applied.replayed,
    preview: applied.ok ? previewPlan(plan) : null,
    diagnostics: applied.diagnostics,
  };
}

/**
 * Apply the exact bytes a caller reviewed, without re-planning or re-minting.
 *
 * The compatibility `applyOperation(envelope)` above intentionally retains the
 * original CLI behaviour. Application adapters use this function: the plan is
 * the executable value, the preview hash binds every base and proposed byte,
 * and revalidation happens immediately before the first append/rename.
 */
export function applyPlannedOperation(plan: WikiPatchPlan, options: ApplyPlannedOptions): ApplyResult {
  const computed = previewHashOf(plan);
  if (options.expectedPreviewHash !== computed) {
    return failure(plan.opId, [
      diagnostic("INVALID_OPERATION_ENVELOPE", "The supplied preview revision does not identify this operation plan."),
    ]);
  }
  const result = applyPlannedOperationSequence([plan], {
    ...options,
    expectedSequenceRevision: options.expectedPreviewHash,
    sequenceRevision: computed,
  });
  return {
    ok: result.ok,
    opId: plan.opId,
    changedFiles: result.changedFiles,
    revisions: result.ok ? plan.revisions.map((change) => ({ ...change })) : [],
    createdIds: result.ok ? [...plan.createdIds] : [],
    replayed: result.replayed,
    preview: result.ok ? previewPlan(plan) : null,
    diagnostics: result.diagnostics,
  };
}

export interface ApplyPlannedSequenceOptions extends ApplyOptions {
  /** One digest for the ordered, exact operation-plan sequence. */
  expectedSequenceRevision: string;
  /** Recomputed by the batch planner; never accepted from the caller alone. */
  sequenceRevision: string;
}

export interface ApplyPlannedSequenceResult {
  ok: boolean;
  changedFiles: string[];
  replayed: boolean;
  diagnostics: WikiDiagnostic[];
}

interface SequenceFileBase {
  path: string;
  absolutePath: string;
  existed: boolean;
  text: string;
}

/**
 * Apply an ordered set of already-reviewed plans as one canonical transaction.
 *
 * All virtual file/audit links and all current bytes are checked before the
 * first intent append. Ordinary in-process failures restore the sequence's
 * exact initial Markdown and ledger bytes. The explicit crash seam is not
 * caught: it deliberately leaves an intent/prefix for the next invocation to
 * resume, matching a real process death.
 */
export function applyPlannedOperationSequence(
  plans: readonly WikiPatchPlan[],
  options: ApplyPlannedSequenceOptions,
): ApplyPlannedSequenceResult {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  if (options.expectedSequenceRevision !== options.sequenceRevision) {
    return {
      ok: false,
      changedFiles: [],
      replayed: false,
      diagnostics: [diagnostic("INVALID_OPERATION_ENVELOPE", "The supplied preview revision does not identify this operation batch.")],
    };
  }
  if (plans.length === 0) return { ok: true, changedFiles: [], replayed: true, diagnostics: [] };

  const indexPath = options.indexPath ?? defaultIndexPath(scaffoldRoot);
  const ownedLease = options.maintenanceLease === undefined;
  const lease = options.maintenanceLease ?? acquireWikiMaintenanceLease(indexPath, "operation", scaffoldRoot);
  try {
    return applyPlannedOperationSequenceHeld(plans, { ...options, scaffoldRoot, maintenanceLease: lease });
  } finally {
    if (ownedLease) lease.release();
  }
}

function applyPlannedOperationSequenceHeld(
  plans: readonly WikiPatchPlan[],
  options: ApplyPlannedSequenceOptions & { maintenanceLease: WikiMaintenanceLease },
): ApplyPlannedSequenceResult {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const log = readAuditLog(scaffoldRoot);
  const diagnostics = [...log.diagnostics];
  const ids = new Set<string>();
  let completed = 0;
  let inFlight = false;
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index]!;
    if (ids.has(plan.opId)) {
      return { ok: false, changedFiles: [], replayed: false, diagnostics: [
        ...diagnostics,
        diagnostic("INVALID_OPERATION_ENVELOPE", `Operation ${plan.opId} appears more than once in the reviewed batch.`),
      ] };
    }
    ids.add(plan.opId);
    const record = recordFor(log, plan.opId);
    const priorHash = record.complete?.payloadHash ?? record.intent?.payloadHash ?? null;
    if (priorHash !== null && priorHash !== plan.payloadHash) {
      return { ok: false, changedFiles: [], replayed: false, diagnostics: [
        ...diagnostics,
        diagnostic("INVALID_OPERATION_ENVELOPE", `Operation ${plan.opId} is recorded with a different payload.`),
      ] };
    }
    if (record.complete !== null) {
      if (inFlight || completed !== index) {
        return { ok: false, changedFiles: [], replayed: false, diagnostics: [
          ...diagnostics,
          diagnostic("CONTENT_HASH_CONFLICT", "Batch operation records are not a valid prefix of the reviewed plan."),
        ] };
      }
      completed += 1;
    } else if (record.intent !== null) {
      if (inFlight || completed !== index) {
        return { ok: false, changedFiles: [], replayed: false, diagnostics: [
          ...diagnostics,
          diagnostic("CONTENT_HASH_CONFLICT", "Batch operation intents are not a valid prefix of the reviewed plan."),
        ] };
      }
      inFlight = true;
    }
  }

  const linked = validateSequenceLinks(plans, options);
  if (linked.length > 0) {
    return { ok: false, changedFiles: [], replayed: false, diagnostics: [...diagnostics, ...linked] };
  }
  const activeIntentFiles = inFlight
    ? recordFor(log, plans[completed]!.opId).intent?.files
    : undefined;
  const claimantConflicts = validateSequenceClaimants(
    plans,
    options,
    completed,
    inFlight,
    activeIntentFiles,
  );
  if (claimantConflicts.length > 0) {
    return {
      ok: false,
      changedFiles: [],
      replayed: false,
      diagnostics: [...diagnostics, ...claimantConflicts],
    };
  }
  const invocationAudit = readOperationLogExact(scaffoldRoot);
  const current = validateSequenceCurrent(plans, scaffoldRoot, completed, inFlight, invocationAudit.text);
  if (current.length > 0) {
    return { ok: false, changedFiles: [], replayed: false, diagnostics: [...diagnostics, ...current] };
  }
  if (completed === plans.length) {
    return { ok: true, changedFiles: [], replayed: true, diagnostics };
  }

  // Roll an ordinary exception back to this invocation's starting point, not
  // to the beginning of a batch that may have a durable crash-resume prefix.
  const originalAudit = invocationAudit;
  const originals = sequenceInvocationFiles(plans, scaffoldRoot);
  const expectedFiles = new Map(originals.map((file) => [file.path, file.existed ? file.text : null]));
  const changed = new Set<string>();
  let expectedAudit = invocationAudit.text;
  let expectedAuditExists = invocationAudit.exists;
  let pendingAudit: string | null = null;
  try {
    for (let index = completed; index < plans.length; index += 1) {
      const plan = plans[index]!;
      const hasDurableIntent = inFlight && index === completed;
      if (!hasDurableIntent) {
        options.beforeAuditAppend?.("intent", plan.opId);
        const entry = auditRecord(plan, "intent");
        pendingAudit = `${expectedAudit}${JSON.stringify(entry)}\n`;
        appendAudit(scaffoldRoot, entry, {
          expectedText: expectedAudit,
          expectedExists: expectedAuditExists,
          ...(options.afterAuditWrite === undefined ? {} : {
            afterWrite: () => options.afterAuditWrite?.("intent", plan.opId),
          }),
        });
        expectedAudit = pendingAudit;
        expectedAuditExists = true;
        pendingAudit = null;
      }

      for (const file of [...plan.files].sort((left, right) => gain(right) - gain(left))) {
        if (!fileChanges(file)) continue;
        const currentText = readCanonicalOrNull(scaffoldRoot, file.absolutePath);
        if (currentText === file.proposedText) {
          changed.add(file.path);
          continue;
        }
        try {
          writeAtomically(scaffoldRoot, file, options);
        } catch (error) {
          const afterFailure = readCanonicalOrNull(scaffoldRoot, file.absolutePath);
          if (afterFailure !== currentText) {
            // Enrol a post-rename failure in the outer transaction. Exact
            // proposed bytes can be rolled back; any third-party value will
            // fail the expected-current check and retain recovery artifacts.
            changed.add(file.path);
            expectedFiles.set(file.path, file.proposedText);
          }
          throw error;
        }
        changed.add(file.path);
        expectedFiles.set(file.path, file.proposedText);
        try {
          options.onFileWritten?.(file.path);
        } catch (error) {
          throw new SimulatedWikiCrashError(error);
        }
      }

      options.beforeAuditAppend?.("complete", plan.opId);
      const entry = auditRecord(plan, "complete");
      pendingAudit = `${expectedAudit}${JSON.stringify(entry)}\n`;
      appendAudit(scaffoldRoot, entry, {
        expectedText: expectedAudit,
        expectedExists: expectedAuditExists,
        ...(options.afterAuditWrite === undefined ? {} : {
          afterWrite: () => options.afterAuditWrite?.("complete", plan.opId),
        }),
      });
      expectedAudit = pendingAudit;
      expectedAuditExists = true;
      pendingAudit = null;
      try {
        options.onOperationCompleted?.(plan.opId);
      } catch (error) {
        throw new SimulatedWikiCrashError(error);
      }
    }
    options.beforeSequenceCommit?.();
    const finalAudit = readOperationLogExact(scaffoldRoot);
    if (finalAudit.exists !== expectedAuditExists || finalAudit.text !== expectedAudit) {
      throw new OperationLogPathError("events/operations.jsonl");
    }
    for (const [path, expectedText] of [...expectedFiles.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      const absolutePath = resolve(scaffoldRoot, path);
      if (readCanonicalOrNull(scaffoldRoot, absolutePath) !== expectedText) {
        throw new WritePathError(absolutePath, "the canonical bytes changed before sequence commit.");
      }
    }
  } catch (error) {
    if (error instanceof SimulatedWikiCrashError) throw error;
    const recoveryErrors: unknown[] = [];
    try {
      const actualAudit = readOperationLogExact(scaffoldRoot).text;
      const knownAudit = actualAudit === expectedAudit
        || (pendingAudit !== null && actualAudit.startsWith(expectedAudit) && pendingAudit.startsWith(actualAudit));
      if (!knownAudit) throw new OperationLogPathError("events/operations.jsonl");
      restoreOperationLogExact(scaffoldRoot, actualAudit, originalAudit);
    } catch (recoveryError) {
      recoveryErrors.push(recoveryError);
    }
    try {
      restoreSequenceFiles(scaffoldRoot, originals, expectedFiles, changed, options);
    } catch (recoveryError) {
      recoveryErrors.push(recoveryError);
    }
    if (recoveryErrors.length > 0) {
      const recoveryPaths = retainSequenceRecoveryArtifacts(scaffoldRoot, originals);
      throw new WikiWriteRecoveryError({ writeError: error, recoveryErrors }, recoveryPaths);
    }
    throw error;
  }

  diagnostics.push(...plans.flatMap((plan) => plan.diagnostics));
  diagnostics.push(...refreshIndex(scaffoldRoot, [...changed], options));
  return { ok: true, changedFiles: [...changed].sort(), replayed: false, diagnostics };
}

function retainSequenceRecoveryArtifacts(
  scaffoldRoot: string,
  originals: readonly SequenceFileBase[],
): string[] {
  const retained: string[] = [];
  for (let index = 0; index < originals.length; index += 1) {
    const original = originals[index]!;
    if (!original.existed) continue;
    const path = `.wiki-recovery-${index}-${randomBytes(5).toString("hex")}.md.recovery-${randomBytes(5).toString("hex")}`;
    const absolutePath = resolve(scaffoldRoot, path);
    try {
      writeAtomically(scaffoldRoot, {
        path,
        absolutePath,
        baseText: "",
        baseFileHash: "",
        existed: false,
        declared: [],
        edits: [],
        proposedText: original.text,
      }, { scaffoldRoot });
      retained.push(path);
    } catch {
      // Report only artifacts whose exact bytes were durably published.
    }
  }
  return retained;
}

function validateSequenceLinks(plans: readonly WikiPatchPlan[], options: ApplyOptions): WikiDiagnostic[] {
  const diagnostics: WikiDiagnostic[] = [];
  const scaffoldRoot = resolve(options.scaffoldRoot);
  let audit = plans[0]?.audit.baseText ?? "";
  const files = new Map<string, { text: string; existed: boolean }>();
  for (const plan of plans) {
    if (
      resolve(plan.audit.absolutePath) !== resolve(scaffoldRoot, "events", "operations.jsonl")
      || plan.audit.path !== "events/operations.jsonl"
      || (plan.audit.baseFileHash === null
        ? plan.audit.baseText !== ""
        : exactFileContentHash(plan.audit.baseText) !== plan.audit.baseFileHash)
    ) diagnostics.push(diagnostic("INVALID_OPERATION_ENVELOPE", "The operation batch names an invalid reviewed ledger."));
    if (plan.audit.baseText !== audit) {
      diagnostics.push(diagnostic("INVALID_OPERATION_ENVELOPE", "The operation batch has a broken ledger overlay."));
    }
    const intent = `${JSON.stringify(auditRecord(plan, "intent"))}\n`;
    const complete = `${JSON.stringify(auditRecord(plan, "complete"))}\n`;
    if (plan.audit.proposedText !== `${plan.audit.baseText}${intent}${complete}`) {
      diagnostics.push(diagnostic("INVALID_OPERATION_ENVELOPE", "The operation batch contains an invalid reviewed ledger append."));
    }
    audit = plan.audit.proposedText;
    for (const file of plan.files) {
      const containment = checkContainment(scaffoldRoot, file.path);
      if (
        resolve(file.absolutePath) !== resolve(scaffoldRoot, file.path)
        || containment.diagnostic !== null
        || (file.existed && exactFileContentHash(file.baseText) !== file.baseFileHash)
      ) {
        diagnostics.push(
          containment.diagnostic
          ?? diagnostic("WRITE_SCOPE_VIOLATION", `The operation batch names an invalid target for ${file.path}.`, { file: file.path }),
        );
        continue;
      }
      const prior = files.get(file.path);
      if (prior !== undefined && (file.baseText !== prior.text || file.existed !== prior.existed)) {
        diagnostics.push(diagnostic("INVALID_OPERATION_ENVELOPE", `${file.path} is not chained to the preceding reviewed bytes.`, { file: file.path }));
      }
      files.set(file.path, { text: file.proposedText, existed: true });
    }
    diagnostics.push(...verifyPlan(plan, options));
  }
  return diagnostics;
}

/**
 * Re-attest claimant ownership while the Wiki maintenance lease is held. Exact
 * file checks alone cannot see a new second file claiming the same entity id.
 * The one allowed ambiguous state is the recorded active half of a multi-file
 * move recovery, whose exact reviewed file states are checked next.
 */
function validateSequenceClaimants(
  plans: readonly WikiPatchPlan[],
  options: ApplyOptions,
  completed: number,
  inFlight: boolean,
  activeIntentFiles: readonly string[] | undefined,
): WikiDiagnostic[] {
  const diagnostics: WikiDiagnostic[] = [];
  const observations = new Map<string, AttestedEntityClaimants>();
  const failedObservations = new Set<string>();
  const observe = (entityId: EntityId): AttestedEntityClaimants | null => {
    const prior = observations.get(entityId);
    if (prior !== undefined) return prior;
    if (failedObservations.has(entityId)) return null;
    try {
      const observed = attestEntityClaimants(entityId, options);
      observations.set(entityId, observed);
      return observed;
    } catch (error) {
      if (
        error instanceof WikiClaimantScanIncompleteError
        || error instanceof WikiCorpusLimitError
      ) {
        failedObservations.add(entityId);
        diagnostics.push(claimantScanConflict(entityId));
        return null;
      }
      throw error;
    }
  };
  const activeRecovery = inFlight && plans[completed]?.type === "move-entry"
    ? plans[completed]
    : undefined;
  const preconditions = new Map<string, WikiPatchPlan["preconditions"][number]>();
  for (const plan of plans) {
    for (const precondition of plan.preconditions) {
      if (!preconditions.has(precondition.entityId)) {
        preconditions.set(precondition.entityId, precondition);
      }
    }
  }
  // When a completed prefix and the active move touch the same entity, recovery
  // authority belongs to the active plan's reviewed source, not the earliest
  // historical precondition in the batch.
  for (const precondition of activeRecovery?.preconditions ?? []) {
    preconditions.set(precondition.entityId, precondition);
  }

  for (const precondition of preconditions.values()) {
    const claimants = observe(precondition.entityId);
    if (claimants === null) continue;
    if (
      claimants.ambiguous
      && !isExactMoveRecoveryClaimants(
        claimants,
        precondition,
        activeRecovery?.preconditions.some((item) => item.entityId === precondition.entityId)
          ? activeIntentFiles
          : undefined,
      )
    ) {
      diagnostics.push(diagnostic(
        "CONTENT_HASH_CONFLICT",
        `Entity ${precondition.entityId} has duplicate current claimants at apply time.`,
        { entityId: precondition.entityId },
      ));
    }
  }

  const createdOrigins = new Map<EntityId, number>();
  for (let index = 0; index < plans.length; index += 1) {
    for (const createdId of plans[index]!.createdIds) {
      if (createdOrigins.has(createdId)) {
        diagnostics.push(diagnostic(
          "INVALID_OPERATION_ENVELOPE",
          `Entity ${createdId} is minted more than once in the reviewed batch.`,
          { entityId: createdId },
        ));
        continue;
      }
      createdOrigins.set(createdId, index);
    }
  }

  for (const [createdId, origin] of createdOrigins) {
    const claimants = observe(createdId);
    if (claimants === null) continue;
    const originCompleted = origin < completed;
    const originActive = inFlight && origin === completed;

    // A preview-exposed generated id remains reserved by absence until its own
    // durable intent is active. Any claimant before then is a collision.
    if (!originCompleted && !originActive) {
      if (claimants.claimantCount !== 0) diagnostics.push(createdClaimantConflict(
        createdId,
        "already has a current claimant before its reviewed create is applied",
      ));
      continue;
    }

    const activePrecondition = activeRecovery?.preconditions.find(
      (precondition) => precondition.entityId === createdId,
    );
    if (
      activePrecondition !== undefined
      && claimants.ambiguous
      && isExactMoveRecoveryClaimants(claimants, activePrecondition, activeIntentFiles)
    ) {
      continue;
    }

    // An active create may be either immediately before or immediately after
    // its reviewed rename. Completed creates must have landed exactly once.
    if (originActive && claimants.claimantCount === 0) continue;
    const allowedPaths = reviewedCreatedClaimantPaths(
      plans,
      createdId,
      completed,
      inFlight,
      activeIntentFiles,
    );
    const evidence = claimants.claimantEvidence;
    if (
      claimants.claimantCount !== 1
      || evidence.length !== 1
      || !allowedPaths.has(evidence[0]!.path)
    ) {
      diagnostics.push(createdClaimantConflict(
        createdId,
        "does not have exactly one claimant in its reviewed recovery files",
      ));
    }
  }
  return diagnostics;
}

function reviewedCreatedClaimantPaths(
  plans: readonly WikiPatchPlan[],
  createdId: EntityId,
  completed: number,
  inFlight: boolean,
  activeIntentFiles: readonly string[] | undefined,
): ReadonlySet<string> {
  const paths = new Set<string>();
  const last = Math.min(plans.length - 1, completed);
  for (let index = 0; index <= last; index += 1) {
    const plan = plans[index];
    if (plan === undefined) continue;
    const relevant = plan.createdIds.includes(createdId)
      || plan.preconditions.some((precondition) => precondition.entityId === createdId);
    if (!relevant) continue;
    if (inFlight && index === completed) {
      for (const path of activeIntentFiles ?? []) paths.add(path);
    } else if (index < completed) {
      for (const file of plan.files) paths.add(file.path);
    }
  }
  return paths;
}

function validateSequenceCurrent(
  plans: readonly WikiPatchPlan[],
  scaffoldRoot: string,
  completed: number,
  inFlight: boolean,
  currentAudit: string,
): WikiDiagnostic[] {
  const diagnostics: WikiDiagnostic[] = [];
  const expected = new Map<string, { text: string; existed: boolean }>();
  for (const plan of plans) {
    for (const file of plan.files) if (!expected.has(file.path)) {
      expected.set(file.path, { text: file.baseText, existed: file.existed });
    }
  }
  for (let index = 0; index < completed; index += 1) {
    for (const file of plans[index]!.files) expected.set(file.path, { text: file.proposedText, existed: true });
  }
  const active = inFlight ? plans[completed] : undefined;
  for (const [path, wanted] of expected) {
    const absolute = resolve(scaffoldRoot, path);
    const actual = readCanonicalOrNull(scaffoldRoot, absolute);
    const activeProposal = active?.files.find((file) => file.path === path)?.proposedText;
    if (actual !== (wanted.existed ? wanted.text : null) && actual !== activeProposal) {
      diagnostics.push(diagnostic("CONTENT_HASH_CONFLICT", `${path} changed since this batch was previewed.`, { file: path }));
    }
  }
  let expectedAudit = completed === plans.length
    ? plans.at(-1)!.audit.proposedText
    : plans[completed]!.audit.baseText;
  const resumedBase = expectedAudit;
  if (inFlight) expectedAudit += `${JSON.stringify(auditRecord(plans[completed]!, "intent"))}\n`;
  if (currentAudit !== expectedAudit && !(inFlight && currentAudit === resumedBase)) {
    diagnostics.push(diagnostic("CONTENT_HASH_CONFLICT", "The operation ledger changed since this batch was previewed."));
  }
  return diagnostics;
}

function sequenceInvocationFiles(
  plans: readonly WikiPatchPlan[],
  scaffoldRoot: string,
): SequenceFileBase[] {
  const files = new Map<string, SequenceFileBase>();
  for (const plan of plans) for (const file of plan.files) if (!files.has(file.path)) {
    const current = readCanonicalOrNull(scaffoldRoot, file.absolutePath);
    files.set(file.path, {
      path: file.path,
      absolutePath: file.absolutePath,
      existed: current !== null,
      text: current ?? "",
    });
  }
  return [...files.values()];
}

function restoreSequenceFiles(
  scaffoldRoot: string,
  originals: readonly SequenceFileBase[],
  expectedFiles: ReadonlyMap<string, string | null>,
  touched: ReadonlySet<string>,
  options: ApplyOptions,
): void {
  for (const original of [...originals].reverse()) {
    if (!touched.has(original.path)) continue;
    const current = readCanonicalOrNull(scaffoldRoot, original.absolutePath);
    if (current !== expectedFiles.get(original.path)) {
      throw new WritePathError(original.absolutePath, "the file changed after this operation wrote it; automatic rollback refused.");
    }
    if (original.existed) {
      if (current === original.text) continue;
      if (current === null) throw new WritePathError(original.absolutePath, "the file vanished before rollback.");
      writeAtomically(scaffoldRoot, {
        path: original.path,
        absolutePath: original.absolutePath,
        baseText: current,
        baseFileHash: exactFileContentHash(current),
        existed: true,
        declared: [],
        edits: [],
        proposedText: original.text,
      }, {
        ...options,
        beforeFileOpen: undefined,
        beforeFileRename: undefined,
        afterFileRename: undefined,
        onFileWritten: undefined,
      });
    } else if (current !== null) {
      removeExactFile(scaffoldRoot, original.absolutePath, current);
    }
  }
}

function removeExactFile(scaffoldRoot: string, absolutePath: string, expected: string): void {
  const target = resolve(absolutePath);
  const binding = bindWriteDirectory(scaffoldRoot, target);
  assertLeafMatches(target, expected);
  let fd: number | undefined;
  try {
    fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!pathMatchesFd(target, fd)) throw new WritePathError(target, "the rollback target changed.");
    assertWriteDirectoryBinding(binding, target);
    rmSync(target);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fileChanges(file: PlannedFileEdit): boolean {
  return !file.existed || file.proposedText !== file.baseText;
}

function readCanonicalOrNull(scaffoldRoot: string, absolutePath: string): string | null {
  if (!existsSync(absolutePath)) return null;
  return readContainedSource(scaffoldRoot, absolutePath);
}

/** Net bytes a file gains. Gains are written first; see the module comment. */
function gain(file: PlannedFileEdit): number {
  return file.proposedText.length - file.baseText.length;
}

/** Hand back recorded ids in order, then fall back to minting. */
function mintFrom(ids: readonly string[]): NonNullable<PlanOptions["generateId"]> {
  let index = 0;
  return () => {
    const next = ids[index];
    index += 1;
    if (next === undefined) throw new Error("resumed operation minted more ids than its intent recorded");
    return next as EntityId;
  };
}

/** Where a recorded `move-entry` started: the file the entity is still in. */
function sourceFileOf(intent: AuditEntry, options: ApplyOptions): string | undefined {
  for (const id of intent.entityIds) {
    for (const path of intent.files) {
      const located = locateEntity(id, { ...options, preferFile: path });
      if (located !== null && located.path === path) return path;
    }
  }
  return undefined;
}

/**
 * Did the interrupted work already land?
 *
 * Checked against the filesystem, not inferred: every entity the intent named
 * or minted has to be findable. That is the question the intent line exists to
 * let a resume ask.
 */
function alreadySettled(intent: AuditEntry, options: ApplyOptions): boolean {
  const ids = [...intent.entityIds, ...intent.createdIds];
  if (ids.length === 0) return false;
  return ids.every((id) => locateEntity(id, options) !== null);
}

/**
 * Re-check every precondition against the tree as it is *now*.
 *
 * The plan was just re-derived from disk, so its own recorded preconditions
 * describe current state; what this adds is the comparison against what the
 * *envelope* asked for, which `planOperation` also made — deliberately twice,
 * because the two run at different moments in a concurrent world and the
 * second is the one that matters.
 */
function revalidate(
  plan: WikiPatchPlan,
  options: PlanOptions,
  recoveryFiles?: readonly string[],
): WikiDiagnostic[] {
  const diagnostics: WikiDiagnostic[] = [];
  for (const precondition of plan.preconditions) {
    let claimants;
    try {
      claimants = attestEntityClaimants(precondition.entityId, options);
    } catch (error) {
      if (
        error instanceof WikiClaimantScanIncompleteError
        || error instanceof WikiCorpusLimitError
      ) {
        diagnostics.push(claimantScanConflict(precondition.entityId));
        continue;
      }
      throw error;
    }
    if (
      claimants.ambiguous
      && !isExactMoveRecoveryClaimants(claimants, precondition, recoveryFiles)
    ) {
      diagnostics.push(diagnostic(
        "CONTENT_HASH_CONFLICT",
        `Entity ${precondition.entityId} has duplicate current claimants at apply time.`,
        { entityId: precondition.entityId },
      ));
      continue;
    }
    const located = claimants.winner;
    if (located === null) {
      diagnostics.push(
        diagnostic("ENTITY_NOT_FOUND", `Entity ${precondition.entityId} vanished between planning and applying.`, {
          entityId: precondition.entityId,
        }),
      );
      continue;
    }
    const current = entityContentHash(entityTextOf(located.text, located.entity.location));
    if (current !== precondition.entityContentHash) {
      diagnostics.push(
        diagnostic("CONTENT_HASH_CONFLICT", `Entity ${precondition.entityId} changed between planning and applying.`, {
          entityId: precondition.entityId,
          file: located.path,
        }),
      );
    }
  }
  return diagnostics;
}

/**
 * A move crash may leave exactly one reviewed source claimant and one reviewed
 * destination claimant. The attestation retains a third witness specifically
 * so "2+" can never be mistaken for that exact two-file state.
 */
function isExactMoveRecoveryClaimants(
  claimants: AttestedEntityClaimants,
  precondition: WikiPatchPlan["preconditions"][number],
  reviewedFiles: readonly string[] | undefined,
): boolean {
  if (reviewedFiles === undefined || reviewedFiles.length !== 2) return false;
  const reviewed = new Set(reviewedFiles);
  if (reviewed.size !== 2 || !reviewed.has(precondition.file)) return false;
  if (claimants.claimantEvidence.length !== 2) return false;
  const observed = new Set(claimants.claimantEvidence.map((claimant) => claimant.path));
  if (observed.size !== 2) return false;
  return observed.size === reviewed.size && [...observed].every((path) => reviewed.has(path));
}

function claimantScanConflict(entityId: EntityId): WikiDiagnostic {
  return diagnostic(
    "CONTENT_HASH_CONFLICT",
    `The complete bounded claimant corpus for entity ${entityId} could not be observed at apply time.`,
    { entityId },
  );
}

function createdClaimantConflict(entityId: EntityId, detail: string): WikiDiagnostic {
  return diagnostic(
    "CONTENT_HASH_CONFLICT",
    `Generated entity ${entityId} ${detail}.`,
    { entityId },
  );
}

/**
 * Temp file in the **same directory**, then rename.
 *
 * Same directory because a cross-device rename is a copy, and a copy is not
 * atomic. The temp name is deliberately not `*.md`: discovery walks for
 * Markdown, and a concurrent rebuild would index a half-written file as a real
 * one — which for an entity block means indexing a truncated body, or a second
 * copy of an entity that is about to exist once.
 */
interface WriteDirectoryBinding {
  root: string;
  realRoot: string;
  rootDev: bigint;
  rootIno: bigint;
  parent: string;
  realParent: string;
  parentDev: bigint;
  parentIno: bigint;
}

/**
 * Bind both the scaffold and the target directory before creating a temp file.
 *
 * Node does not expose `openat(2)`, so every pathname mutation is bracketed by
 * a realpath + device/inode check of both directories.  The temp and existing
 * leaf are separately opened with `O_NOFOLLOW` and tied back to the pathname by
 * inode before the final same-directory rename.
 */
function bindWriteDirectory(scaffoldRoot: string, target: string): WriteDirectoryBinding {
  const root = resolve(scaffoldRoot);
  assertWritablePath(root, target);
  let rootLexical;
  try {
    rootLexical = lstatSync(root, { bigint: true });
  } catch {
    throw new WritePathError(target, "the scaffold root does not exist.");
  }
  if (!rootLexical.isDirectory() || rootLexical.isSymbolicLink()) {
    throw new WritePathError(target, "the scaffold root is not a real directory.");
  }
  const realRoot = realpathSync(root);
  const rootStats = lstatSync(realRoot, { bigint: true });
  const parent = dirname(target);
  const rel = relative(root, parent);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new WritePathError(target, "its parent is outside the scaffold root.");
  }

  // Create missing ancestors one segment at a time. Recursive mkdir would
  // follow a directory swapped to a symlink between the initial check and the
  // creation of a deeper descendant.
  let cursor = root;
  for (const segment of rel === "" ? [] : rel.split(sep)) {
    assertWriteRoot(root, realRoot, rootStats.dev, rootStats.ino, target);
    cursor = resolve(cursor, segment);
    if (!existsSync(cursor)) mkdirSync(cursor, { recursive: false, mode: 0o700 });
    const lexical = lstatSync(cursor, { bigint: true });
    if (!lexical.isDirectory() || lexical.isSymbolicLink()) {
      throw new WritePathError(target, "a containing directory is a symlink or not a directory.");
    }
    const realCursor = realpathSync(cursor);
    const cursorRel = relative(realRoot, realCursor);
    if (cursorRel === ".." || cursorRel.startsWith(`..${sep}`)) {
      throw new WritePathError(target, "a containing directory escapes the scaffold root.");
    }
  }

  const parentLexical = lstatSync(parent, { bigint: true });
  if (!parentLexical.isDirectory() || parentLexical.isSymbolicLink()) {
    throw new WritePathError(target, "the target parent is not a real directory.");
  }
  const realParent = realpathSync(parent);
  const parentStats = lstatSync(realParent, { bigint: true });
  const binding = {
    root,
    realRoot,
    rootDev: rootStats.dev,
    rootIno: rootStats.ino,
    parent,
    realParent,
    parentDev: parentStats.dev,
    parentIno: parentStats.ino,
  };
  assertWriteDirectoryBinding(binding, target);
  return binding;
}

function assertWriteRoot(
  root: string,
  realRoot: string,
  dev: bigint,
  ino: bigint,
  target: string,
): void {
  try {
    const lexical = lstatSync(root, { bigint: true });
    const currentReal = realpathSync(root);
    const current = lstatSync(currentReal, { bigint: true });
    if (
      !lexical.isDirectory()
      || lexical.isSymbolicLink()
      || currentReal !== realRoot
      || current.dev !== dev
      || current.ino !== ino
    ) throw new WritePathError(target, "the scaffold directory changed during the write.");
  } catch (error) {
    if (error instanceof WritePathError) throw error;
    throw new WritePathError(target, "the scaffold directory changed during the write.");
  }
}

function assertWriteDirectoryBinding(binding: WriteDirectoryBinding, target: string): void {
  assertWritablePath(binding.root, target);
  if (dirname(resolve(target)) !== binding.parent) {
    throw new WritePathError(target, "the target moved outside its bound parent.");
  }
  assertWriteRoot(binding.root, binding.realRoot, binding.rootDev, binding.rootIno, target);
  try {
    const lexical = lstatSync(binding.parent, { bigint: true });
    const currentReal = realpathSync(binding.parent);
    const current = lstatSync(currentReal, { bigint: true });
    if (
      !lexical.isDirectory()
      || lexical.isSymbolicLink()
      || currentReal !== binding.realParent
      || current.dev !== binding.parentDev
      || current.ino !== binding.parentIno
    ) throw new WritePathError(target, "the target directory changed during the write.");
  } catch (error) {
    if (error instanceof WritePathError) throw error;
    throw new WritePathError(target, "the target directory changed during the write.");
  }
}

function assertLeafMatches(path: string, expected: string | null): void {
  if (expected === null) {
    try {
      lstatSync(path, { bigint: true });
      throw new WritePathError(path, "a new target appeared during the write.");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ENOENT") throw error;
    }
    return;
  }

  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    const lexical = lstatSync(path, { bigint: true });
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const leafAfter = lstatSync(path, { bigint: true });
    if (
      !opened.isFile()
      || lexical.isSymbolicLink()
      || opened.dev !== lexical.dev
      || opened.ino !== lexical.ino
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs
      || after.ctimeNs !== opened.ctimeNs
      || leafAfter.isSymbolicLink()
      || leafAfter.dev !== opened.dev
      || leafAfter.ino !== opened.ino
      || new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== expected
    ) throw new WritePathError(path, "the target bytes changed during the write.");
  } catch (error) {
    if (error instanceof WritePathError) throw error;
    throw new WritePathError(path, "the target could not be bound without following links.");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function pathMatchesFd(path: string, fd: number): boolean {
  try {
    const opened = fstatSync(fd, { bigint: true });
    const lexical = lstatSync(path, { bigint: true });
    return !lexical.isSymbolicLink()
      && opened.dev === lexical.dev
      && opened.ino === lexical.ino;
  } catch {
    return false;
  }
}

interface WrittenTempBinding {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function bindWrittenTemp(fd: number, bytes: Buffer, path: string): WrittenTempBinding {
  const stats = fstatSync(fd, { bigint: true });
  if (!stats.isFile() || stats.size !== BigInt(bytes.length)) {
    throw new WritePathError(path, "the temp file does not contain the reviewed byte count.");
  }
  assertFdBytes(fd, bytes, path);
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function assertWrittenTemp(
  path: string,
  fd: number,
  expected: WrittenTempBinding,
  bytes: Buffer,
  allowRenameCtime = false,
): void {
  const stats = fstatSync(fd, { bigint: true });
  const lexical = lstatSync(path, { bigint: true });
  if (
    !stats.isFile()
    || lexical.isSymbolicLink()
    || stats.dev !== expected.dev
    || stats.ino !== expected.ino
    || stats.size !== expected.size
    || stats.mtimeNs !== expected.mtimeNs
    || (!allowRenameCtime && stats.ctimeNs !== expected.ctimeNs)
    || lexical.dev !== stats.dev
    || lexical.ino !== stats.ino
  ) throw new WritePathError(path, "the exact reviewed temp generation changed before publication.");
  assertFdBytes(fd, bytes, path);
}

function assertFdBytes(fd: number, expected: Buffer, path: string): void {
  const actual = Buffer.alloc(expected.length);
  let offset = 0;
  while (offset < actual.length) {
    const read = readSync(fd, actual, offset, actual.length - offset, offset);
    if (read <= 0) throw new WritePathError(path, "the temp file could not be read exactly.");
    offset += read;
  }
  if (!actual.equals(expected)) throw new WritePathError(path, "the temp bytes differ from the reviewed plan.");
}

function writeAtomically(scaffoldRoot: string, file: PlannedFileEdit, options: ApplyOptions): void {
  const target = resolve(file.absolutePath);
  const binding = bindWriteDirectory(scaffoldRoot, target);
  const expected = file.existed ? file.baseText : null;
  assertLeafMatches(target, expected);
  options.beforeFileOpen?.(file.path);
  assertWriteDirectoryBinding(binding, target);
  assertLeafMatches(target, expected);

  const temp = `${target}.tmp-${randomBytes(6).toString("hex")}`;
  assertWritablePath(scaffoldRoot, temp);
  let tempFd: number | undefined;
  let ourTemp = false;
  let tempBinding: WrittenTempBinding | undefined;
  const proposedBytes = Buffer.from(file.proposedText, "utf8");
  try {
    tempFd = openSync(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    ourTemp = true;
    if (!fstatSync(tempFd, { bigint: true }).isFile()) throw new WritePathError(temp, "the temp target is not a regular file.");
    assertWriteDirectoryBinding(binding, target);
    if (!pathMatchesFd(temp, tempFd)) throw new WritePathError(temp, "the temp path changed during the write.");
    writeExact(tempFd, proposedBytes, temp);
    fsyncSync(tempFd);
    tempBinding = bindWrittenTemp(tempFd, proposedBytes, temp);
    closeSync(tempFd);
    tempFd = undefined;

    options.beforeFileRename?.(file.path);
    assertWriteDirectoryBinding(binding, target);
    let verifyFd: number | undefined;
    try {
      verifyFd = openSync(temp, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (tempBinding === undefined) throw new WritePathError(temp, "the temp generation was not bound.");
      assertWrittenTemp(temp, verifyFd, tempBinding, proposedBytes);
      assertLeafMatches(target, expected);
      renameSync(temp, target);
      assertWrittenTemp(target, verifyFd, tempBinding, proposedBytes, true);
      ourTemp = false;
      options.afterFileRename?.(file.path);
    } finally {
      if (verifyFd !== undefined) closeSync(verifyFd);
    }
    // The rename above is only durable once the directory entry that names the
    // target reaches stable storage. See `durability.ts` for the one platform
    // where that cannot be asked for, and what is given up there.
    syncDirectory(binding.parent);
  } catch (error) {
    if (tempFd !== undefined) closeSync(tempFd);
    if (ourTemp) {
      // Never unlink by a pathname that no longer denotes our bound directory
      // or our own temp inode.
      try {
        assertWriteDirectoryBinding(binding, target);
        const cleanupFd = openSync(temp, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const ours = tempBinding !== undefined
          && (() => {
            try {
              assertWrittenTemp(temp, cleanupFd, tempBinding, proposedBytes);
              return true;
            } catch {
              return false;
            }
          })();
        closeSync(cleanupFd);
        if (ours) rmSync(temp, { force: true });
      } catch {
        // Failing closed can retain a temp file; it must never remove a path an
        // attacker swapped in after the failed write.
      }
    }
    throw error;
  }
}

function writeExact(fd: number, bytes: Buffer, path: string): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new WritePathError(path, "the filesystem did not accept the complete file.");
    offset += written;
  }
}

/**
 * Refresh the rows the write touched — and never build an index that is absent.
 *
 * An absent `wiki.db` is the ordinary state of a production scaffold, so it is
 * reported as `INDEX_REFRESH_REQUIRED` rather than as an error, and rebuilding
 * one here would turn a millisecond write into a five-second surprise in the
 * middle of an operation.
 */
function refreshIndex(scaffoldRoot: string, changedFiles: readonly string[], options: ApplyOptions): WikiDiagnostic[] {
  if (changedFiles.length === 0) return [];
  const indexPath = options.indexPath ?? defaultIndexPath(scaffoldRoot);
  if (!existsSync(indexPath)) {
    return [
      diagnostic("INDEX_REFRESH_REQUIRED", "The Markdown write succeeded; there is no wiki index to refresh.", {}),
    ];
  }

  try {
    const refreshed = refreshWikiIndex({
      scaffoldRoot,
      indexPath,
      changed: [...changedFiles],
      ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
      ...(options.registry === undefined ? {} : { registry: options.registry }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.resolveGrounding === undefined ? {} : { resolveGrounding: options.resolveGrounding }),
      ...(options.targetedGroundings ? { targetedGroundings: true } : {}),
      ...(options.maintenanceLease === undefined ? {} : { maintenanceLease: options.maintenanceLease }),
    });
    if (refreshed.ok) return refreshed.diagnostics;
    return [
      diagnostic(
        "INDEX_REFRESH_REQUIRED",
        `The Markdown write succeeded but the index did not refresh: ${refreshed.diagnostic.message}`,
        {},
      ),
    ];
  } catch (error) {
    return [
      diagnostic(
        "INDEX_REFRESH_REQUIRED",
        `The Markdown write succeeded but the index did not refresh: ${error instanceof Error ? error.message : String(error)}`,
        {},
      ),
    ];
  }
}

/**
 * Regenerate a file's generated section — the one Markdown write that is not an
 * operation, and why it is not one.
 *
 * P6 shipped detection, deterministic rendering and a marker-bounded edit, and
 * left applying it as a stated seam with two candidate homes: a twelfth
 * operation type, or a command. Building it settles the question, because a
 * `WikiPatchPlan` carries a `WikiOperationType` and that field is not
 * decoration — it is what the audit log records and what `acceptedOperations()`
 * reports as having changed this wiki. So the choice is really:
 *
 * - **a twelfth type**, which puts a *rendering* act into the vocabulary of
 *   knowledge changes and makes §11.4's ledger report cosmetic regenerations
 *   alongside the decisions people actually made; or
 * - **a plan carrying one of the eleven**, which is a lie in the audit log; or
 * - **a write that is not an operation.**
 *
 * The third, because a generated section is *derived state*, exactly like
 * `wiki.db`: it contains no knowledge that is not already recorded in the
 * entities it lists, it is re-derivable from the scaffold at any moment, it
 * mints no id, bumps no revision and has no precondition worth taking. There is
 * nothing for replay to protect and nothing for a reviewer to review, so there
 * is no audit line — the audit log is the ledger of knowledge operations, and
 * padding it with regenerations would make the thing it exists to answer harder
 * to read.
 *
 * **It is not a second writer.** The bytes go through `applyEdits`, which
 * verifies that nothing outside the declared range moved, and through
 * `writeAtomically` in this module — the single guarded writer D9 names, with
 * `assertWritablePath` in front of every mutation exactly as before. What is
 * new is a second *caller*, not a second writer.
 *
 * Opt-in at the command line, never a side effect of a read.
 */
export function applyGeneratedViews(options: GeneratedViewApplyOptions): GeneratedViewApplyResult {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const diagnostics: WikiDiagnostic[] = [];
  const changedFiles: string[] = [];
  const readOnly = options.readOnly ?? [];

  for (const candidate of options.views) {
    if (!candidate.stale) continue;

    if (isReadOnlyPath(candidate.file, readOnly)) {
      diagnostics.push(readOnlyDiagnostic(candidate.file));
      continue;
    }
    const containment = checkContainment(scaffoldRoot, candidate.file);
    if (containment.diagnostic !== null) {
      diagnostics.push(containment.diagnostic);
      continue;
    }

    const absolutePath = resolve(scaffoldRoot, candidate.file);
    let patched;
    try {
      patched = applyEdits(candidate.baseText, [
        { start: candidate.region.start, end: candidate.region.end, text: candidate.rendered, label: `generated view in ${candidate.file}` },
      ]);
    } catch (error) {
      diagnostics.push(writeScopeDiagnostic(error, candidate.file));
      continue;
    }

    if (patched.text === candidate.baseText) continue;
    writeAtomically(scaffoldRoot, {
      path: candidate.file,
      absolutePath,
      baseText: candidate.baseText,
      baseFileHash: exactFileContentHash(candidate.baseText),
      existed: true,
      declared: patched.declared,
      edits: [],
      proposedText: patched.text,
    }, options);
    changedFiles.push(candidate.file);
    options.onFileWritten?.(candidate.file);
  }

  diagnostics.push(...refreshIndex(scaffoldRoot, changedFiles, options));
  return { changedFiles, diagnostics };
}

/** One file's generated section, as the caller measured it. */
export interface GeneratedViewCandidate {
  file: string;
  baseText: string;
  region: { start: number; end: number };
  rendered: string;
  stale: boolean;
}

export interface GeneratedViewApplyOptions extends ApplyOptions {
  views: readonly GeneratedViewCandidate[];
}

export interface GeneratedViewApplyResult {
  changedFiles: string[];
  diagnostics: WikiDiagnostic[];
}
