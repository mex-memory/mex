/**
 * The operation pipeline: plan → preview → apply, plus the audit log.
 *
 * Designed for a batch caller as well as a single one, because one exists: P6's
 * migration owns classification and no bytes, and emits `create-entry` and
 * `set-property` envelopes into this pipeline rather than growing a writer of
 * its own (D9).
 */

export { planOperation, verifyPlan, payloadHashOf } from "./plan.js";
export type {
  EntityPrecondition,
  PlanOptions,
  PlanResult,
  PlannedAuditAppend,
  PlannedFileEdit,
  RevisionChange,
  WikiPatchPlan,
} from "./plan.js";

export { previewPlan, previewHashOf, renderPreview } from "./preview.js";
export type { DiffHunk, FileDiff, WikiPreview } from "./preview.js";

export { applyOperation, applyPlannedOperation } from "./apply.js";
export type { ApplyOptions, ApplyPlannedOptions, ApplyResult } from "./apply.js";

export {
  applyPlannedOperationBatch,
  batchPreviewRevisionOf,
  planOperationBatch,
  planOperationBatchReport,
} from "./batch.js";
export type {
  BatchRefusal,
  PlanOperationBatchOptions,
  PlanOperationBatchReport,
  ApplyPlannedOperationBatchOptions,
  ApplyPlannedOperationBatchResult,
  PlanOperationBatchResult,
  WikiOperationBatchPlan,
} from "./batch.js";

export {
  OPERATION_LOG_FILE,
  OPERATION_LOG_MAX_BYTES,
  OPERATION_LOG_MAX_ENTRIES,
  acceptedOperations,
  appendAudit,
  auditRecord,
  operationLogPath,
  readAuditLog,
  recordFor,
} from "./audit.js";
export type { AuditEntry, AuditLog, AuditPhase, OperationRecord } from "./audit.js";

export {
  attestEntityClaimants,
  attestEntityClaimantsBatch,
  locateEntity,
  locateEntityClaimants,
  locateFile,
  WikiClaimantScanIncompleteError,
} from "./locate.js";
export type {
  AttestedEntityClaimants,
  LocateOptions,
  LocatedEntity,
  LocatedEntityClaimants,
  LocatedFile,
} from "./locate.js";

export {
  assertWritablePath,
  checkContainment,
  isReadOnlyPath,
  readOnlyDiagnostic,
  resolveThroughSymlinks,
  toScaffoldRelative,
  WritePathError,
} from "./paths.js";
