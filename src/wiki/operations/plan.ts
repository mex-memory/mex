/**
 * §11.3 steps 1–6: envelope in, patch plan out. Nothing here writes a byte.
 *
 * ## The plan is a value, and that is the point
 *
 * It carries the declared ranges, the exact proposed bytes, and the base
 * versions it was built against. That is what lets preview (step 7) and apply
 * (step 8) **disagree** — which they must be able to do, or revalidation is
 * theatre. Apply re-plans against the current tree and compares; a plan that
 * could not be re-derived is a plan that cannot be checked.
 *
 * ## The three checks, and why they are three
 *
 * 1. **Preconditions**, on the normalized entity hash (D6). CRLF and LF
 *    checkouts of one file must agree, or a precondition minted on Windows is
 *    rejected on Linux.
 * 2. **Write scope**, on **raw** bytes, via `applyEdits`. These are different
 *    comparisons and both are required: a scope check against normalized text
 *    passes happily while CRLF line endings get rewritten across a whole file.
 * 3. **The re-parse**, below. Every plan is verified by parsing the text it
 *    produced and asserting that no entity other than the operation's own
 *    subjects changed, compared by content hash. Offsets shift when text is
 *    inserted above them; an entity's *text* does not. So "cannot alter
 *    adjacent entities" — a §11.2 requirement stated separately for
 *    `update-entry`, `add-relation` and the rest — becomes one property checked
 *    the same way for all eleven, rather than eleven tests that each hope.
 *
 *    Compared on {@link neighbourFingerprint} — the entity's text with its
 *    body's *trailing* whitespace trimmed, not the raw content hash. That is
 *    not a loosening; it is the difference between two questions. A body runs
 *    to the start of the next entity's metadata, so **appending an entity at
 *    end of file necessarily extends the previous entity's body range** by the
 *    blank line separating them. Under a raw comparison the most ordinary
 *    operation in the engine — `create-entry` at end-of-file — reports that it
 *    altered an entity it never named, and the check would have to be switched
 *    off for creates, which is where it is needed most. Trailing whitespace at
 *    a body's end is separator, not content: no character of anyone's prose can
 *    change without the fingerprint moving.
 *
 * ## Preconditions are required, not optional
 *
 * §11.1 makes `baseRevision` and `baseContentHash` optional and
 * `checkOperationPreconditions` treats an omitted one as "the caller accepts
 * whatever is on disk". Combined with replay, an unconditional `update-entry`
 * is a loaded gun: it overwrites an edit made between plan and apply, silently,
 * and the audit log records a success. So the pipeline **requires**
 * `baseContentHash` for every operation that mutates an existing entity. A
 * deliberate unconditional write is expressed as `PlanOptions.unconditional`,
 * at the pipeline level rather than in the envelope, because it is a property
 * of the caller's situation and not of the proposal: P6's migration is the real
 * one, planning and applying in one pass with no human in between and no prior
 * revision to name.
 */

import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  checkOperationPreconditions,
  validateOperation,
  type WikiActor,
  type WikiOperation,
  type WikiOperationType,
} from "../model/operation.js";
import { diagnostic, hasBlockingDiagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import { rootContext } from "../model/validate.js";
import { generateEntityId, type EntityId } from "../model/ids.js";
import { entityContentHash, exactFileContentHash } from "../model/hash.js";
import type { EntityTypeRegistry } from "../model/entity.js";
import { applyEdits, WriteScopeError, type PatchEdit } from "../markdown/patch.js";
import type { LabeledRange } from "../markdown/ranges.js";
import { entityTextOf } from "../markdown/codec.js";
import type { GroundingGraph } from "../grounding/adapter.js";
import { checkContainment, isReadOnlyPath, readOnlyDiagnostic } from "./paths.js";
import { locateEntity, locateFile, parseCached, type LocateOptions } from "./locate.js";
import { buildOperationEdits, type OperationContext, type OperationEdits } from "./operations.js";
import { auditRecord, operationLogPath, readOperationLogExact } from "./audit.js";

/** One file's worth of a plan: the exact bytes, and the ranges they may occupy. */
export interface PlannedFileEdit {
  /** Scaffold-relative POSIX path. */
  path: string;
  absolutePath: string;
  /** The text the plan was built against; `""` when the file is being created. */
  baseText: string;
  /** Hash of `baseText`; `""` when creating. */
  baseFileHash: string;
  existed: boolean;
  declared: LabeledRange[];
  /**
   * The edits themselves, kept so the preview can render an exact diff from the
   * plan's own declaration rather than re-deriving one by comparing two texts.
   * A diff that says something different from what the plan declared would be a
   * reviewer approving one change and applying another.
   */
  edits: PatchEdit[];
  proposedText: string;
}

/** What must still be true at apply time for the plan to remain valid. */
export interface EntityPrecondition {
  entityId: EntityId;
  file: string;
  revision: number;
  entityContentHash: string;
}

export interface RevisionChange {
  entityId: EntityId;
  before: number;
  after: number;
}

/** Exact append that completes the reviewed operation ledger change. */
export interface PlannedAuditAppend {
  /** Scaffold-relative path. The application adapter adds the `.mex/` prefix. */
  path: "events/operations.jsonl";
  absolutePath: string;
  baseText: string;
  baseFileHash: string | null;
  proposedText: string;
}

export interface WikiPatchPlan {
  opId: string;
  type: WikiOperationType;
  actor: WikiActor;
  timestamp: string;
  reason?: string;
  /**
   * Hash of the operation's type and payload.
   *
   * §11.4 forbids storing the payload in the audit log, and replay has to be
   * able to tell a retry from a caller reusing an `opId` for a different
   * change. A hash is not a payload.
   */
  payloadHash: string;
  /** Entities the operation acts on. */
  entityIds: EntityId[];
  /** Ids this operation mints, in mint order. Empty for everything but creates. */
  createdIds: EntityId[];
  files: PlannedFileEdit[];
  preconditions: EntityPrecondition[];
  revisions: RevisionChange[];
  diagnostics: WikiDiagnostic[];
  /** Exact ledger bytes included in the preview revision. */
  audit: PlannedAuditAppend;
}

export type PlanResult =
  | { ok: true; plan: WikiPatchPlan; diagnostics: WikiDiagnostic[] }
  | { ok: false; diagnostics: WikiDiagnostic[] };

export interface PlanOptions extends LocateOptions {
  scaffoldRoot: string;
  /**
   * Stamp newly authored content from this operation's explicit authority.
   * Off by default so legacy low-level plans and recovery keep their bytes.
   * Adoption and existing entities never infer an original creator.
   */
  captureCreationProvenance?: boolean;
  registry?: EntityTypeRegistry;
  /** `wiki.readOnly` globs. Enforced here, before any preview exists. */
  readOnly?: readonly string[];
  /** The code graph, for `set-grounding`'s provenance check. */
  graph?: GroundingGraph | null;
  /** Id source for created entities. Injectable so a test can pin ids. */
  generateId?: () => EntityId;
  /**
   * Give an authored section entry its place in the Wiki's structure: a
   * `create-entry` inserted under a heading, with no `refines` of its own,
   * refines the nearest enclosing entity, and a file with no file-level entity
   * gets one in the same operation (see `operations.ts`). On for the authoring
   * surfaces (`wiki apply` and the service facade); off for migration,
   * synthesis and every low-level caller, whose bytes stay exactly theirs.
   */
  deriveStructure?: boolean;
  /**
   * Accept a mutating operation carrying no `baseContentHash`.
   *
   * For a caller that plans and applies in one pass over a tree nobody else is
   * touching — migration, and nothing else so far.
   */
  unconditional?: boolean;
  /**
   * Virtual audit bytes for an in-memory multi-operation planner.
   *
   * Ordinary callers leave this absent and the current committed ledger is
   * read. Migration supplies the result of the preceding virtual operation so
   * every stored plan is still exact without writing during preview.
   */
  auditText?: string;
  /** Whether a virtual empty audit text represents an existing empty file. */
  auditExists?: boolean;
}

/**
 * Stable hash of what an operation proposes to do.
 *
 * The fields are separated by U+0000, which cannot occur in a type name or in
 * canonical JSON, so no two different proposals can render to the same input.
 * A space would be ambiguous, since values can contain one.
 *
 * **Written as the unicode escape, never as a literal byte.** Git detects a
 * binary file by scanning for NUL, so a raw one would make this module — one of
 * the two that decide what gets written into a user's files — render as
 * `Bin 0 -> 17856 bytes` in every diff, opt it out of the line-ending
 * normalization the rest of `src/` gets, and turn any future merge on it into a
 * binary conflict instead of a three-way one. Identical at runtime.
 */
export function payloadHashOf(type: WikiOperationType, payload: unknown): string {
  return createHash("sha256").update(`${type}\u0000${canonical(payload)}`, "utf8").digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

/** Operations that act on an entity that must already exist. */
const MUTATES_EXISTING = new Set<WikiOperationType>([
  "update-entry",
  "set-property",
  "add-relation",
  "remove-relation",
  "add-source",
  "remove-source",
  "set-grounding",
  "supersede-entry",
  "move-entry",
  "archive-entry",
]);

function fail(diagnostics: WikiDiagnostic[]): PlanResult {
  return { ok: false, diagnostics };
}

/**
 * Plan one operation.
 *
 * Returns diagnostics rather than throwing, at every step — including the one
 * place a throw can legitimately arrive. `applyEdits` throws `WriteScopeError`
 * because its contract is "this must never happen", which is right for a
 * primitive; the operations layer is where that becomes a typed
 * `WRITE_SCOPE_VIOLATION` and a refusal to write. This function and
 * {@link verifyPlan} are the only two places that catch it, and there is no
 * third, so the conversion cannot be forgotten at a new call site.
 */
export function planOperation(envelope: unknown, options: PlanOptions): PlanResult {
  const scaffoldRoot = resolve(options.scaffoldRoot);

  // -- step 1: the envelope -------------------------------------------------
  const validated = validateOperation(envelope, rootContext());
  if (!validated.ok) return fail(validated.diagnostics);
  const operation: WikiOperation = validated.value;
  const carried = validated.diagnostics;

  // File-bearing operations must establish containment before attempting to
  // read an existing target. Otherwise an escaping symlink degrades to a
  // generic unreadable-file error and, more importantly, the semantic builder
  // reaches the read boundary before the path authority boundary.
  const declaredFile = operation.payload && typeof operation.payload === "object"
    && "file" in operation.payload && typeof operation.payload.file === "string"
      ? operation.payload.file
      : undefined;
  if (declaredFile !== undefined) {
    const containment = checkContainment(scaffoldRoot, declaredFile);
    if (containment.diagnostic !== null) return fail([...carried, containment.diagnostic]);
  }

  // -- step 2: resolve the subject and its file -----------------------------
  const located = operation.entityId === undefined ? null : locateEntity(operation.entityId, options);
  if (MUTATES_EXISTING.has(operation.type) && located === null) {
    return fail([
      ...carried,
      diagnostic("ENTITY_NOT_FOUND", `No entity ${String(operation.entityId)} in this scaffold.`, {
        entityId: operation.entityId,
      }),
    ]);
  }

  // -- step 3: preconditions ------------------------------------------------
  const diagnostics: WikiDiagnostic[] = [...carried];
  if (located !== null) {
    if (
      MUTATES_EXISTING.has(operation.type) &&
      operation.baseContentHash === undefined &&
      options.unconditional !== true
    ) {
      diagnostics.push(
        diagnostic(
          "INVALID_OPERATION_ENVELOPE",
          `A "${operation.type}" operation must carry \`baseContentHash\`; an unconditional write would silently overwrite an edit made since it was planned.`,
          { entityId: operation.entityId },
        ),
      );
    }
    diagnostics.push(
      ...checkOperationPreconditions(operation, {
        revision: located.entity.revision,
        entityContentHash: located.entity.location.entityContentHash,
      }),
    );
  }
  if (hasBlockingDiagnostic(diagnostics)) return fail(diagnostics);

  // -- steps 4 and 5: semantics, and the edits they imply -------------------
  const context: OperationContext = {
    options,
    scaffoldRoot,
    located,
    ...(options.captureCreationProvenance === true ? {
      creationProvenance: {
        createdBy: { kind: operation.actor.kind, id: operation.actor.id },
        createdAt: operation.timestamp,
        ...(operation.actor.kind === "agent" && operation.actor.sessionId !== undefined
          ? { agentSessionId: operation.actor.sessionId }
          : {}),
      },
    } : {}),
    timestamp: operation.timestamp,
    mintId: options.generateId ?? generateEntityId,
    locate: (path) => locateFile(options, path),
    locateEntity: (id) => locateEntity(id, options),
  };

  let built: OperationEdits;
  try {
    built = buildOperationEdits(operation, context);
  } catch (error) {
    return fail([...diagnostics, writeScopeDiagnostic(error, located?.path)]);
  }
  diagnostics.push(...built.diagnostics);
  if (hasBlockingDiagnostic(diagnostics)) return fail(diagnostics);

  // -- the read-only reservation, before a preview exists -------------------
  const readOnly = options.readOnly ?? [];
  for (const file of built.files) {
    if (isReadOnlyPath(file.path, readOnly)) return fail([...diagnostics, readOnlyDiagnostic(file.path)]);
    const containment = checkContainment(scaffoldRoot, file.path);
    if (containment.diagnostic !== null) return fail([...diagnostics, containment.diagnostic]);
  }

  // -- step 6: the patch, and the ranges it is allowed to touch -------------
  const files: PlannedFileEdit[] = [];
  try {
    for (const file of built.files) {
      const patched = applyEdits(file.baseText, file.edits);
      files.push({
        path: file.path,
        absolutePath: file.absolutePath,
        baseText: file.baseText,
        baseFileHash: file.existed ? exactFileContentHash(file.baseText) : "",
        existed: file.existed,
        declared: patched.declared,
        edits: [...file.edits].sort((left, right) => left.start - right.start),
        proposedText: patched.text,
      });
    }
  } catch (error) {
    return fail([...diagnostics, writeScopeDiagnostic(error, located?.path)]);
  }

  const core = {
    opId: operation.opId,
    type: operation.type,
    actor: operation.actor,
    timestamp: operation.timestamp,
    ...(operation.reason === undefined ? {} : { reason: operation.reason }),
    payloadHash: payloadHashOf(operation.type, operation.payload),
    entityIds: built.entityIds,
    createdIds: built.createdIds,
    files,
    preconditions: built.preconditions,
    revisions: built.revisions,
    diagnostics,
  };
  const audit = plannedAuditAppend(core, scaffoldRoot, options.auditText, options.auditExists);
  const plan: WikiPatchPlan = { ...core, audit };

  const verified = verifyPlan(plan, options);
  if (verified.length > 0) return fail([...diagnostics, ...verified]);

  return { ok: true, plan, diagnostics };
}

type AuditPlan = Parameters<typeof auditRecord>[0];

/**
 * Bind the audit append to the same exact-byte plan as the Markdown edits.
 *
 * The log remains append-only at apply time. Holding its complete proposed
 * bytes here is what lets a consumer preview the real canonical change and
 * what makes a concurrent append a revision conflict rather than interleaved
 * JSONL.
 */
function plannedAuditAppend(
  plan: AuditPlan,
  scaffoldRoot: string,
  virtualText: string | undefined,
  virtualExists: boolean | undefined,
): PlannedAuditAppend {
  const absolutePath = operationLogPath(scaffoldRoot);
  const exact = virtualText === undefined
    ? readOperationLogExact(scaffoldRoot)
    : { exists: virtualExists ?? virtualText.length > 0, text: virtualText };
  const existed = exact.exists;
  const baseText = exact.text;
  const intent = `${JSON.stringify(auditRecord(plan, "intent"))}\n`;
  const complete = `${JSON.stringify(auditRecord(plan, "complete"))}\n`;
  return {
    path: "events/operations.jsonl",
    absolutePath,
    baseText,
    baseFileHash: existed ? exactFileContentHash(baseText) : null,
    proposedText: `${baseText}${intent}${complete}`,
  };
}

/**
 * Parse what the plan produced and check the entities it did not name.
 *
 * The strongest single check in the phase, and the cheapest to state: an
 * entity's content hash is over its own text, so inserting bytes above it moves
 * its offsets and leaves its hash alone. Every entity present both before and
 * after, other than the operation's own subjects and the ids it minted, must
 * therefore hash identically. That is "cannot alter adjacent entities",
 * "changes only the source entity metadata" and "insertion must not overwrite
 * existing prose" all at once — and it catches an indentation bug that produced
 * valid YAML in the wrong map, which `checkOnlyRangesChanged` cannot see
 * because the wrong map is inside the declared range.
 */
export function verifyPlan(plan: WikiPatchPlan, options: PlanOptions): WikiDiagnostic[] {
  const untouchable = new Set<string>([...plan.entityIds, ...plan.createdIds]);
  const diagnostics: WikiDiagnostic[] = [];

  for (const file of plan.files) {
    // Routed through the cache rather than `parseWikiMarkdown` directly: the
    // base text is the text `locate` just read and parsed, and the proposed
    // text is what the file will hold a moment from now, so both are worth
    // remembering. A hit still requires byte equality, so neither can hand a
    // later caller a tree that does not describe the bytes on disk.
    const parse = (text: string) => parseCached(options, file.path, file.absolutePath, text);

    const before = new Map(
      parse(file.baseText).entities.map((entry) => [
        entry.entity.id as string,
        neighbourFingerprint(file.baseText, entry.entity.location),
      ]),
    );
    const after = parse(file.proposedText);

    for (const entry of after.entities) {
      const id = entry.entity.id as string;
      if (untouchable.has(id)) continue;
      const was = before.get(id);
      if (was === undefined) {
        diagnostics.push(
          diagnostic(
            "WRITE_SCOPE_VIOLATION",
            `Planning ${plan.type} would introduce entity ${id} into ${file.path}, which it does not name. Nothing was written.`,
            { file: file.path, entityId: id },
          ),
        );
        continue;
      }
      if (was !== neighbourFingerprint(file.proposedText, entry.entity.location)) {
        diagnostics.push(
          diagnostic(
            "WRITE_SCOPE_VIOLATION",
            `Planning ${plan.type} would change entity ${id} in ${file.path}, which it does not name. Nothing was written.`,
            { file: file.path, entityId: id },
          ),
        );
      }
    }

    for (const [id] of before) {
      if (untouchable.has(id)) continue;
      if (!after.entities.some((entry) => (entry.entity.id as string) === id)) {
        diagnostics.push(
          diagnostic(
            "WRITE_SCOPE_VIOLATION",
            `Planning ${plan.type} would remove entity ${id} from ${file.path}, which it does not name. Nothing was written.`,
            { file: file.path, entityId: id },
          ),
        );
      }
    }

    // A plan must not introduce a parse error that was not already there.
    const newErrors = after.diagnostics.filter(
      (entry) => entry.severity === "error" && !parse(file.baseText).diagnostics.some((was) => was.code === entry.code && was.message === entry.message),
    );
    for (const entry of newErrors) {
      diagnostics.push(
        diagnostic("WRITE_SCOPE_VIOLATION", `Planning ${plan.type} would make ${file.path} unreadable: ${entry.message}`, {
          file: file.path,
        }),
      );
    }
  }

  return diagnostics;
}

/**
 * An entity's text, for the "did an entity I did not name change?" question.
 *
 * The body's trailing whitespace is trimmed, and only there. A body ends where
 * the next entity's metadata begins, so a neighbour's body range grows by the
 * separator whenever anything is inserted after it; treating that separator as
 * content makes the check fire on every append.
 *
 * This never replaces `entityContentHash`. The *precondition* stays over the
 * raw text, because there a caller is asserting the entity is byte-for-byte
 * where it left it, and trailing whitespace is part of that claim.
 */
export function neighbourFingerprint(text: string, location: Parameters<typeof entityTextOf>[1]): string {
  return entityContentHash(
    text.slice(location.metadataStart, location.metadataEnd) +
      text.slice(location.headingStart, location.headingEnd) +
      text.slice(location.bodyStart, location.bodyEnd).replace(/\s+$/, ""),
  );
}

/** The one conversion from the primitive's throw to this layer's diagnostic. */
export function writeScopeDiagnostic(error: unknown, file: string | undefined): WikiDiagnostic {
  if (error instanceof WriteScopeError) {
    return diagnostic("WRITE_SCOPE_VIOLATION", `${error.message} Nothing was written.`, file === undefined ? {} : { file });
  }
  throw error;
}

/** Recompute an entity's precondition hash the way the codec does. */
export function preconditionOf(
  entityId: EntityId,
  file: string,
  revision: number,
  text: string,
  location: Parameters<typeof entityTextOf>[1],
): EntityPrecondition {
  return { entityId, file, revision, entityContentHash: entityContentHash(entityTextOf(text, location)) };
}

export type { PatchEdit };
