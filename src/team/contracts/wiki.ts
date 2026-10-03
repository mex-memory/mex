import type {
  Diagnostic,
  EntityId,
  EntityRef,
  EntityVersion,
  FileChange,
  GroundingHealth,
  IndexJobResult,
  IsoTimestamp,
  JsonValue,
  OperationContext,
  Page,
  PageRequest,
  RepoRelativePath,
  Revision,
  SourceLocation,
} from "./shared.js";

export const WIKI_LIFECYCLE_STATES = [
  "in_flight",
  "promoted",
  "deprecated",
  "archived",
] as const;

export const WIKI_OPERATION_TYPES = [
  "create-entry",
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
] as const;

export const WIKI_RELATION_TYPES = [
  "depends_on",
  "implements",
  "supersedes",
  "contradicts",
  "derived_from",
  "grounded_in",
  "related_to",
  "affects",
  "verified_by",
  "refines",
  "constrained_by",
  "caused_by",
] as const;

export const WIKI_SOURCE_TYPES = [
  "file",
  "symbol",
  "commit",
  "pull_request",
  "issue",
  "document",
  "manual",
  "agent_session",
  "test",
  "url",
] as const;

/** First matching state wins when deriving an entity's aggregate health. */
export const WIKI_GROUNDING_HEALTH_PRECEDENCE = [
  "missing",
  "ambiguous",
  "changed",
  "unverified",
  "fresh",
] as const satisfies readonly GroundingHealth[];

export type WikiLifecycleState = (typeof WIKI_LIFECYCLE_STATES)[number];
export type WikiOperationType = (typeof WIKI_OPERATION_TYPES)[number];
export type WikiRelationType = (typeof WIKI_RELATION_TYPES)[number];
export type WikiSourceType = (typeof WIKI_SOURCE_TYPES)[number];

export interface WikiRelationRef {
  type: string;
  target: EntityId;
  note?: string;
  metadata?: Readonly<Record<string, JsonValue>>;
}

export interface WikiRelation {
  type: string;
  source: EntityRef;
  target: EntityRef;
  note?: string;
  metadata?: Readonly<Record<string, JsonValue>>;
}

export interface WikiSource {
  type: WikiSourceType | (string & {});
  ref?: string;
  note?: string;
  repository?: string;
  commit?: string;
  capturedAt?: IsoTimestamp;
  resolved?: boolean;
  metadata?: Readonly<Record<string, JsonValue>>;
}

/** Producer identity is distinct from the evidence recorded in `sources`. */
export interface WikiProvenance {
  kind: "human" | "agent" | "system" | "migration" | "unknown";
  id?: string;
  sessionId?: string;
  capturedAt?: IsoTimestamp;
  metadata?: Readonly<Record<string, JsonValue>>;
}

/** Canonical, Git-tracked grounding data. */
export interface WikiGrounding {
  node: string;
  fingerprint: string;
  file?: RepoRelativePath;
  commit?: string;
  verifiedAt?: IsoTimestamp;
  reason?: string;
}

export type WikiGroundingResolutionState =
  | "fresh"
  | "stale"
  | "missing"
  | "unresolved"
  | "ungrounded";

export interface WikiGroundingCandidate {
  node: string;
  fingerprint?: string;
  file?: RepoRelativePath;
  score?: number;
}

/** Checkout-local resolution; this state is derived and must not be committed. */
interface WikiGroundingResolutionBase {
  requestedNode: string;
  reason?: string;
  observedAt: IsoTimestamp;
}

/** State and normalized application health cannot contradict one another. */
export type WikiGroundingResolution =
  | (WikiGroundingResolutionBase & {
      state: "fresh";
      health: "fresh";
      grounding: WikiGrounding;
      resolvedNode: string;
    })
  | (WikiGroundingResolutionBase & {
      state: "stale";
      health: "changed";
      grounding: WikiGrounding;
      resolvedNode?: string;
      previousSource?: string;
      currentSource?: string;
    })
  | (WikiGroundingResolutionBase & {
      state: "missing";
      health: "missing";
      grounding: WikiGrounding;
    })
  | (WikiGroundingResolutionBase & {
      state: "unresolved";
      health: "ambiguous" | "unverified";
      grounding: WikiGrounding;
      candidates?: readonly WikiGroundingCandidate[];
    })
  | (Omit<WikiGroundingResolutionBase, "requestedNode"> & {
      state: "ungrounded";
      health: "unverified";
      requestedNode?: never;
      grounding?: never;
    });

export interface WikiEntitySummary {
  ref: EntityRef;
  title: string;
  summary?: string;
  location: SourceLocation;
  version: EntityVersion;
  lifecycleState: WikiLifecycleState;
  groundingHealth: GroundingHealth;
  topics: readonly EntityId[];
  sourceTypes: readonly string[];
  diagnostics: readonly Diagnostic[];
}

/**
 * Stable application projection of the canonical Wiki model. Engine-only
 * additions may use `extension`; essential Hub fields are never hidden there.
 */
export interface WikiEntity<TExtension = never> extends WikiEntitySummary {
  body: string;
  relations: readonly WikiRelationRef[];
  backlinks: readonly WikiRelation[];
  sources: readonly WikiSource[];
  provenance?: WikiProvenance;
  groundings: readonly WikiGroundingResolution[];
  diagnostics: readonly Diagnostic[];
  extension?: TExtension;
}

export interface WikiListRequest extends PageRequest {
  kinds?: readonly string[];
  topics?: readonly EntityId[];
  lifecycleStates?: readonly WikiLifecycleState[];
  groundingHealth?: readonly GroundingHealth[];
  sourceTypes?: readonly string[];
  includeArchived?: boolean;
  maxTokens?: number;
}

export interface WikiPage<T> extends Page<T> {
  estimatedTokens: number;
  truncated: boolean;
}

export interface WikiQueryRequest extends WikiListRequest {
  query: string;
}

export interface WikiSearchHit {
  entity: WikiEntitySummary;
  /** Adapter-local rank only; consumers must not fuse it with graph scores. */
  score?: number;
  /** Adapter-local text relevance within the matched field, lower first; never fused with graph scores. */
  relevance?: number;
  matchedFields: readonly ("id" | "title" | "summary" | "body")[];
}

export interface WikiTraverseRequest extends PageRequest {
  entityId: EntityId;
  direction: "outgoing" | "incoming" | "both";
  relationTypes?: readonly string[];
  includeArchived?: boolean;
  maxTokens?: number;
}

export interface WikiRelationHit {
  relation: WikiRelation;
  direction: "outgoing" | "incoming";
  entity: WikiEntitySummary;
}

export interface WikiBacklinksRequest extends PageRequest {
  entityId: EntityId;
  relationTypes?: readonly string[];
  includeArchived?: boolean;
  maxTokens?: number;
}

export interface WikiNeighborhoodRequest {
  entityId: EntityId;
  direction?: "outgoing" | "incoming" | "both";
  relationTypes?: readonly string[];
  depth: number;
  maxEntities: number;
  maxTokens: number;
  includeArchived?: boolean;
}

export interface WikiEntityNeighborhood {
  root: WikiEntitySummary;
  entities: readonly WikiEntitySummary[];
  relations: readonly WikiRelation[];
  estimatedTokens: number;
  truncated: boolean;
}

/**
 * One entity detail and neighborhood projected under the same immutable Wiki
 * session and, when available, the same fresh Graph-grounding lease.
 */
export interface WikiEntityNeighborhoodSnapshot<TEntityExtension = never> {
  indexedRevision: Revision;
  projectionRevision: Revision;
  observedAt: IsoTimestamp;
  entity: WikiEntity<TEntityExtension>;
  neighborhood: WikiEntityNeighborhood;
}

export interface WikiValidationRequest {
  entityIds?: readonly EntityId[];
  paths?: readonly RepoRelativePath[];
  maxDiagnostics?: number;
}

export interface WikiValidationReport {
  valid: boolean;
  diagnostics: readonly Diagnostic[];
}

export interface WikiOperationActor {
  kind: "human" | "agent" | "system";
  id: string;
  sessionId?: string;
}

/** Authoritative envelope shape; operation-specific payload remains generic. */
export interface WikiOperationEnvelope<TPayload = JsonValue> {
  opId: string;
  type: WikiOperationType;
  entityId?: EntityId;
  baseRevision?: number;
  baseContentHash?: Revision;
  actor: WikiOperationActor;
  reason?: string;
  timestamp: IsoTimestamp;
  payload: TPayload;
}

export type WikiRevisionExpectation =
  | {
      target: { kind: "entity"; id: EntityId };
      /** `null` means the entity must not exist yet. */
      version: EntityVersion | null;
    }
  | {
      target: { kind: "artifact"; path: RepoRelativePath };
      /** `null` means the artifact must not exist yet. */
      contentHash: Revision | null;
    };

/**
 * Consumer review envelope. The concrete operation payload remains owned by
 * the Wiki engine, while actor, time, typed vocabulary, and preconditions are
 * mandatory at this boundary.
 */
export interface WikiOperationRequest<
  TOperationPayload = JsonValue,
> {
  /** Caller proposal in the authoritative envelope; payload remains engine-owned. */
  operation: WikiOperationEnvelope<TOperationPayload>;
  expectedRevisions: readonly WikiRevisionExpectation[];
}

export interface WikiOperationPreview<TOperationPlan = unknown> {
  operationId: string;
  /** Engine-produced validated patch plan, opaque to consumers. */
  plan: TOperationPlan;
  /** Hash of the ordered base versions and exact proposed canonical bytes. */
  previewRevision: Revision;
  valid: boolean;
  changes: readonly FileChange[];
  affectedEntities: readonly EntityRef[];
  validation: WikiValidationReport;
  /** Bounded, body-free restart metadata; never an executable plan handle. */
  recoveryManifest?: WikiOperationRecoveryManifest;
}

/**
 * Package-private exact entity projection used by governed Team authoring.
 * It is intentionally omitted from `contracts/index.ts` and the package root:
 * ordinary consumers continue to depend only on {@link WikiPort}.
 */
export interface WikiExactEntityAttestation {
  id: EntityId;
  entity: {
    ref: EntityRef;
    version: EntityVersion;
  } | null;
}

/** One ordered entity set released from one immutable, revalidated Wiki view. */
export interface WikiExactEntityAttestationView {
  indexedRevision: Revision;
  observedAt: IsoTimestamp;
  entities: readonly WikiExactEntityAttestation[];
}

/**
 * Package-private authoring seam. A receipt may pin create IDs, but no opaque
 * executable plan is ever made portable or added to the public WikiPort.
 */
export interface WikiForcedCreatedIdPreviewPort<
  TOperationPayload = JsonValue,
  TOperationPlan = unknown,
> {
  readExactEntityAttestations(
    entityIds: readonly EntityId[],
  ): Promise<WikiExactEntityAttestationView>;
  previewOperationsWithCreatedIds(
    request: WikiOperationRequest<TOperationPayload>,
    createdIds: readonly EntityId[],
  ): Promise<WikiOperationPreview<TOperationPlan>>;
}

/**
 * Package-private governed-update seam. Public Wiki previews retain ordinary
 * whole-corpus freshness; this path tolerates only Team-owned publication
 * drift around one exact Wiki-owned update.
 */
export interface WikiExactAuthoringPreviewPort<
  TOperationPayload = JsonValue,
  TOperationPlan = unknown,
> {
  previewAuthoringOperations(
    request: WikiOperationRequest<TOperationPayload>,
  ): Promise<WikiOperationPreview<TOperationPlan>>;
}

export interface WikiOperationRecoveryManifest {
  schemaVersion: 1;
  requestHash: Revision;
  operationId: string;
  items: readonly {
    operationId: string;
    type: WikiOperationType;
    payloadHash: Revision;
    createdIds: readonly EntityId[];
    files: readonly {
      path: RepoRelativePath;
      beforeRevision: Revision | null;
      afterRevision: Revision;
    }[];
    revisions: readonly {
      entityId: EntityId;
      before: number;
      after: number;
    }[];
    audit: {
      beforeRevision: Revision | null;
      afterRevision: Revision;
    };
  }[];
}

export type WikiOperationRecoveryInspection =
  | {
      schemaVersion: 1;
      state: "none";
      operationIds: readonly string[];
    }
  | {
      schemaVersion: 1;
      state: "prefix";
      operationIds: readonly string[];
      completedOperationIds: readonly string[];
      activeOperationId: string | null;
    }
  | {
      schemaVersion: 1;
      state: "complete";
      operationIds: readonly string[];
      completedOperationIds: readonly string[];
    }
  | {
      schemaVersion: 1;
      state: "mismatch";
      operationIds: readonly string[];
      reason: "authority_mismatch" | "invalid_prefix" | "audit_unsafe";
    };

export interface WikiOperationApplyRequest<
  TOperationPayload = JsonValue,
  TOperationPlan = unknown,
> extends WikiOperationRequest<TOperationPayload> {
  /** Must be the plan returned by preview for this operation and base state. */
  plan: TOperationPlan;
  expectedPreviewRevision: Revision;
}

export interface WikiOperationAuditResult {
  appended: boolean;
  path: ".mex/events/operations.jsonl";
}

export type WikiIndexRefreshOutcome =
  | { state: "refreshed"; indexedRevision: Revision }
  | { state: "rebuild_required"; diagnostic: Diagnostic };

export interface WikiOperationResult {
  operationId: string;
  previewRevision: Revision;
  applied: boolean;
  idempotentReplay: boolean;
  changes: readonly FileChange[];
  resultingVersions: Readonly<Record<EntityId, EntityVersion>>;
  audit: WikiOperationAuditResult;
  indexRefresh: WikiIndexRefreshOutcome;
  diagnostics: readonly Diagnostic[];
}

export type WikiIndexState =
  | "missing"
  | "fresh"
  | "stale"
  | "degraded"
  | "rebuild_required"
  | "corrupt"
  | "migration_required";

export interface WikiIndexStatus {
  state: WikiIndexState;
  observedAt: IsoTimestamp;
  schemaVersion: number | null;
  indexedRevision: Revision | null;
  indexedAt: IsoTimestamp | null;
  diagnostics: readonly Diagnostic[];
}

export interface WikiRebuildResult extends IndexJobResult {
  entitiesIndexed: number;
  relationsIndexed: number;
  indexedRevision: Revision;
}

export interface WikiRefreshResult extends IndexJobResult {
  filesRefreshed: number;
  entitiesIndexed: number;
  relationsIndexed: number;
  indexedRevision: Revision;
}

export interface WikiMigrationOptions {
  paths?: readonly RepoRelativePath[];
  topicMappings?: Readonly<Record<string, EntityId>>;
}

export interface WikiMigrationReport {
  filesScanned: number;
  proposedByType: Readonly<Record<string, number>>;
  createdByType?: Readonly<Record<string, number>>;
  idsPreserved: number;
  idsGenerated?: number;
  legacyEdges: { converted: number; ambiguous: number };
  groundings: { preserved: number; ambiguous: number; unresolved: number };
  filesUnchanged: readonly RepoRelativePath[];
  diagnostics: readonly Diagnostic[];
}

export interface WikiMigrationPreview<TMigrationPlan = unknown> {
  migrationId: string;
  previewRevision: Revision;
  /** Opaque plan must not promise final generated IDs during dry-run. */
  plan: TMigrationPlan;
  expectedRevisions: readonly WikiRevisionExpectation[];
  changes: readonly FileChange[];
  report: WikiMigrationReport;
  validation: WikiValidationReport;
}

export interface WikiMigrationApplyRequest<TMigrationPlan = unknown> {
  migrationId: string;
  previewRevision: Revision;
  plan: TMigrationPlan;
  expectedRevisions: readonly WikiRevisionExpectation[];
}

export interface WikiMigrationResult {
  migrationId: string;
  applied: boolean;
  idempotentReplay: boolean;
  changes: readonly FileChange[];
  report: WikiMigrationReport;
  diagnostics: readonly Diagnostic[];
}

/**
 * The only application-facing seam to structured Wiki behavior. Consumers
 * must never import the adapter database schema or open its SQLite database.
 * Read methods never rebuild or refresh implicitly.
 */
export interface WikiPort<
  TEntityExtension = never,
  TOperationPayload = JsonValue,
  TOperationPlan = unknown,
  TMigrationPlan = unknown,
> {
  getEntity(id: EntityId): Promise<WikiEntity<TEntityExtension> | null>;
  listEntities(request?: WikiListRequest): Promise<WikiPage<WikiEntitySummary>>;
  queryEntities(request: WikiQueryRequest): Promise<WikiPage<WikiSearchHit>>;
  traverseRelations(request: WikiTraverseRequest): Promise<WikiPage<WikiRelationHit>>;
  getBacklinks(request: WikiBacklinksRequest): Promise<WikiPage<WikiRelation>>;
  getNeighborhood(request: WikiNeighborhoodRequest): Promise<WikiEntityNeighborhood>;
  getEntityNeighborhood(
    request: WikiNeighborhoodRequest,
  ): Promise<WikiEntityNeighborhoodSnapshot<TEntityExtension> | null>;
  getGroundingStatus(id: EntityId): Promise<readonly WikiGroundingResolution[]>;
  validate(request?: WikiValidationRequest): Promise<WikiValidationReport>;
  /**
   * Validate optimistic mutation preconditions against bounded canonical
   * filesystem truth. This must not trust wiki.db, initialize storage, refresh,
   * rebuild, or write. Duplicate entity claimants fail closed.
   */
  validateCurrentRevisionExpectations(
    expectations: readonly WikiRevisionExpectation[],
  ): Promise<void>;
  previewOperations(
    request: WikiOperationRequest<TOperationPayload>,
  ): Promise<WikiOperationPreview<TOperationPlan>>;
  applyOperations(
    request: WikiOperationApplyRequest<TOperationPayload, TOperationPlan>,
  ): Promise<WikiOperationResult>;
  inspectIndex(): Promise<WikiIndexStatus>;
  refreshFiles(
    paths: readonly RepoRelativePath[],
    context?: OperationContext,
  ): Promise<WikiRefreshResult>;
  rebuildIndex(context?: OperationContext): Promise<WikiRebuildResult>;
  planMigration(
    options?: WikiMigrationOptions,
  ): Promise<WikiMigrationPreview<TMigrationPlan>>;
  applyMigration(
    request: WikiMigrationApplyRequest<TMigrationPlan>,
  ): Promise<WikiMigrationResult>;
}

export function aggregateWikiGroundingHealth(
  resolutions: readonly WikiGroundingResolution[],
): GroundingHealth {
  if (resolutions.length === 0) return "unverified";
  return WIKI_GROUNDING_HEALTH_PRECEDENCE.find((health) => (
    resolutions.some((resolution) => resolution.health === health)
  )) ?? "unverified";
}
