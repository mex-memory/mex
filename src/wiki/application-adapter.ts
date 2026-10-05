import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { EntityTypeRegistry } from "./model/entity.js";
import { generateEntityId, isEntityId, type EntityId as EngineEntityId } from "./model/ids.js";
import type { GroundingGraph } from "./grounding/adapter.js";
import { resolveGrounding } from "./grounding/resolve.js";
import type { GroundingResolution as EngineGroundingResolution } from "./model/grounding.js";
import { canonicalJson, type GroundingResolver } from "./index/write.js";
import {
  WikiMaintenanceInterruptedError,
  type WikiMaintenanceProgress,
} from "./index/maintenance.js";
import { WikiMaintenanceLockedError } from "./index/dbfile.js";
import { prepareWikiRebuild, rebuildWikiIndex, type PreparedWikiRebuild } from "./index/rebuild.js";
import {
  prepareWikiRefresh,
  refreshWikiIndex,
  type PreparedWikiRefresh,
} from "./index/refresh.js";
import {
  applyPlannedOperationBatch,
  auditRecord,
  batchPreviewRevisionOf,
  OPERATION_LOG_MAX_BYTES,
  OPERATION_LOG_MAX_ENTRIES,
  attestEntityClaimants,
  attestEntityClaimantsBatch,
  payloadHashOf,
  planOperationBatch,
  readAuditLog,
  recordFor,
  locateEntity,
  WikiClaimantScanIncompleteError,
  type AuditEntry,
  type LocatedEntity,
  type WikiOperationBatchPlan,
  type WikiPatchPlan,
} from "./operations/index.js";
import { readOperationLogExact } from "./operations/audit.js";
import { SimulatedWikiCrashError } from "./operations/apply.js";
import { createParseCache, parseCached } from "./operations/locate.js";
import { isTeamOwnedReadOnlyPath } from "./model/team-owned-paths.js";
import { WIKI_CORPUS_LIMITS, WikiCorpusLimitError } from "./index/corpus-policy.js";
import {
  inspectWikiContractIndex,
  WikiContractReadError,
  withWikiContractReadSession,
  withWikiContractReadSessionAsync,
  type ContractEntity,
  type ContractEntitySummary,
  type ContractGrounding,
  type ContractPage,
  type ContractRelation,
  type ContractRelationHit,
  type ContractSearchHit,
  type ContractWikiIndexStatus,
  type InspectWikiIndexOptions,
  type WikiContractReadSession,
} from "./query/contract-session.js";
import type { WikiDiagnostic } from "./model/diagnostic.js";
import { exactFileContentHash } from "./model/hash.js";
import { readContainedSource } from "./index/source-read.js";
import { estimateTokens } from "./query/budget.js";
import { healthRank, LIFECYCLE_RANK, MATCH_FIELD_RANK } from "./query/rank.js";
import {
  applyPinnedMigration,
  MigrationSelectionError,
  planPinnedMigration,
  type MigrationReport as EngineMigrationReport,
  type PinnedMigrationArtifact,
  type PinnedMigrationPlan,
} from "./migration/migrate.js";
import { canonicalFileDiff } from "../team/artifacts/unified-diff.js";
import type {
  Diagnostic,
  EntityId,
  EntityRef,
  FileChange,
  GroundingHealth,
  IndexProgress,
  JsonValue,
  MexErrorCode,
  OperationContext,
  ProblemDetails,
  RepoRelativePath,
  Revision,
} from "../team/contracts/shared.js";
import {
  aggregateWikiGroundingHealth,
  WIKI_OPERATION_TYPES,
  type WikiBacklinksRequest,
  type WikiEntity,
  type WikiEntityNeighborhood,
  type WikiEntityNeighborhoodSnapshot,
  type WikiEntitySummary,
  type WikiExactEntityAttestationView,
  type WikiExactAuthoringPreviewPort,
  type WikiForcedCreatedIdPreviewPort,
  type WikiGrounding,
  type WikiGroundingCandidate,
  type WikiGroundingResolution,
  type WikiIndexStatus,
  type WikiListRequest,
  type WikiMigrationApplyRequest,
  type WikiMigrationOptions,
  type WikiMigrationPreview,
  type WikiMigrationReport,
  type WikiMigrationResult,
  type WikiNeighborhoodRequest,
  type WikiOperationApplyRequest,
  type WikiOperationPreview,
  type WikiOperationRecoveryInspection,
  type WikiOperationRecoveryManifest,
  type WikiOperationRequest,
  type WikiOperationResult,
  type WikiOperationType,
  type WikiPage,
  type WikiPort,
  type WikiQueryRequest,
  type WikiRevisionExpectation,
  type WikiRelation,
  type WikiRelationHit,
  type WikiSearchHit,
  type WikiTraverseRequest,
  type WikiValidationReport,
  type WikiValidationRequest,
} from "../team/contracts/wiki.js";
import { isRepoRelativePath, MexPortError } from "../team/contracts/shared.js";
import type { CodeSymbol } from "../team/contracts/graph.js";
import { WIKI_ENTITY_TYPES } from "./model/entity.js";

const MAX_DIAGNOSTICS = 100;
const MAX_COUNTED_ENTITIES = 10_000;
const MAX_COUNTED_RELATIONS = 100_000;
const MAX_PRIVATE_PAGE = 50;
const MAX_CONTEXT_NODES = 100;
const MAX_CONTEXT_RELATIONS = 500;
const MAX_CODE_LOOKUP_NODES = 50;
const MAX_CURSOR_BYTES = 4 * 1024;
const MAX_OPAQUE_PLANS = 128;
const MAX_CURRENT_SEARCH_RESULTS = 500;
const MAX_RECOVERY_MANIFEST_BYTES = 64 * 1024;
const MAX_RECOVERY_MANIFEST_FILES = 100;
const MAX_CURRENT_REVISION_EXPECTATIONS = 100;

export type RepositoryWikiOperationPayload = JsonValue;

export type RepositoryWikiBatchOperation =
  | {
      readonly type: "update-entry";
      readonly entityId: EntityId;
      readonly title?: string;
      readonly summary?: string;
      readonly body?: string;
      readonly appendSources?: readonly JsonValue[];
    }
  | {
      readonly type: "add-relation";
      readonly relation: WikiRelation;
    }
  | {
      readonly type: "move-entry";
      readonly entityId: EntityId;
      readonly destinationPath: string;
      readonly insertAt?: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly type: WikiOperationType;
      readonly entityId?: EntityId;
      readonly payload: JsonValue;
    };

export interface RepositoryWikiOperationBatchPayload {
  readonly operations: readonly RepositoryWikiBatchOperation[];
}

/** Package-private Hub batch DTOs. They are deliberately not root exports. */
export interface RepositoryWikiSearchBundle {
  readonly indexedRevision: Revision;
  readonly observedAt: string;
  readonly results: WikiPage<WikiSearchHit>;
}

export interface RepositoryWikiListBundle {
  readonly indexedRevision: Revision;
  readonly observedAt: string;
  readonly results: WikiPage<WikiEntitySummary>;
}

export interface RepositoryWikiGraphOverview {
  readonly indexedRevision: Revision;
  readonly observedAt: string;
  readonly nodes: readonly WikiEntitySummary[];
  readonly relations: readonly WikiRelation[];
  readonly coverage: {
    readonly nodeLimit: 100;
    readonly relationLimit: 500;
    readonly nodesTruncated: boolean;
    readonly relationsTruncated: boolean;
  };
}

export interface RepositoryWikiGroundedCode {
  readonly indexedRevision: Revision;
  readonly observedAt: string;
  readonly entityId: EntityId;
  readonly graphRevision: string | null;
  readonly groundings: readonly {
    readonly requestedNode: string;
    readonly resolvedNode: string | null;
    readonly health: GroundingHealth;
    readonly symbol: CodeSymbol | null;
  }[];
  readonly truncated: boolean;
}

export type RepositoryKnowledgeSelection =
  | { readonly kind: "overview" }
  | { readonly kind: "relations"; readonly results: WikiPage<WikiRelationHit> }
  | { readonly kind: "backlinks"; readonly results: WikiPage<WikiRelation> }
  | { readonly kind: "groundings"; readonly results: readonly WikiGroundingResolution[] };

export interface RepositoryKnowledgeWorkspaceRequest {
  readonly entityId: EntityId;
  readonly view?: "overview" | "relations" | "backlinks" | "groundings";
  readonly direction?: "incoming" | "outgoing" | "both";
  readonly relationTypes?: readonly string[];
  readonly includeArchived?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface RepositoryKnowledgeWorkspace {
  readonly indexedRevision: Revision;
  readonly observedAt: string;
  readonly entity: WikiEntity<never>;
  readonly selection: RepositoryKnowledgeSelection;
}

export interface RepositoryCodeKnowledgeRequest {
  readonly nodeIds: readonly string[];
  readonly includeArchived?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface RepositoryCodeKnowledgeHit {
  readonly entity: WikiEntitySummary;
  readonly matchedNodes: readonly string[];
}

export interface RepositoryCodeKnowledgeResult extends WikiPage<RepositoryCodeKnowledgeHit> {
  readonly indexedRevision: Revision;
  readonly observedAt: string;
}

export type RepositoryWikiOperationPlan =
  | {
      readonly v: 1;
      readonly valid: true;
      readonly requestHash: Revision;
      /** Opaque, process-lifetime handle. It serializes no paths or source bytes. */
      readonly handle: string;
    }
  | {
      readonly v: 1;
      readonly valid: false;
      readonly requestHash: Revision;
      readonly diagnostics: readonly Diagnostic[];
    };

/** Package-private aliases; the canonical internal shapes live with WikiPort. */
export type RepositoryWikiOperationRecoveryManifest = WikiOperationRecoveryManifest;
export type RepositoryWikiOperationRecoveryInspection = WikiOperationRecoveryInspection;

export type RepositoryWikiOperationPreview = WikiOperationPreview<RepositoryWikiOperationPlan> & {
  readonly recoveryManifest?: RepositoryWikiOperationRecoveryManifest;
};

/** Replaced by the engine-owned pinned migration plan once planning succeeds. */
export interface RepositoryWikiMigrationPlan {
  readonly v: 1;
  readonly requestHash: Revision;
  /** Opaque, process-lifetime handle. It serializes no paths or source bytes. */
  readonly handle: string;
}

interface StoredOperationPlan {
  readonly requestHash: Revision;
  readonly enginePreviewRevision: Revision;
  readonly plan: WikiOperationBatchPlan;
}

interface DurableOperationResume {
  readonly activeIndex: number;
  readonly intent: AuditEntry | null;
  readonly auditBaseText: string;
  readonly auditBaseExists: boolean;
  readonly manifest: RepositoryWikiOperationRecoveryManifest;
}

interface OperationRecoveryAnalysis {
  readonly inspection: RepositoryWikiOperationRecoveryInspection;
  readonly exactText: string;
  readonly exactExists: boolean;
  readonly intent: AuditEntry | null;
}

interface PreparedDurableOperationResume {
  readonly envelopes: readonly Record<string, unknown>[];
  readonly preferFile?: string;
  readonly generateId?: () => EngineEntityId;
  readonly settledIntentPlan?: WikiPatchPlan;
  readonly rebindFirstAuthority?: boolean;
}

interface StoredMigrationPlan {
  readonly requestHash: Revision;
  readonly plan: PinnedMigrationPlan;
}

interface AdapterDependencies {
  inspect: typeof inspectWikiContractIndex;
  read: typeof withWikiContractReadSession;
  readAsync: typeof withWikiContractReadSessionAsync;
  rebuild: typeof rebuildWikiIndex;
  refresh: typeof refreshWikiIndex;
  prepareRebuild: typeof prepareWikiRebuild;
  prepareRefresh: typeof prepareWikiRefresh;
}

interface AdapterTestSeams {
  /** @internal Fail only the operation pipeline's post-write index refresh. */
  failOperationIndexRefresh?: () => boolean;
  /** @internal Simulate process death after an operation file is published. */
  onOperationFileWritten?: (path: string) => void;
  /** @internal Simulate process death after one batch child completes. */
  onOperationCompleted?: (opId: string) => void;
  /** @internal Mutate an artifact after its descriptor-bound bytes are read. */
  onCurrentRevisionArtifactRead?: (path: string) => void;
}

class GroundingWorkFailure {
  constructor(readonly cause: unknown) {}
}

export interface RepositoryWikiPortOptions {
  scaffoldRoot?: string;
  indexPath?: string;
  exclude?: readonly string[];
  readOnly?: readonly string[];
  registry?: EntityTypeRegistry;
  /** Package-private fresh Graph bridge; the adapter never opens Graph storage. */
  groundingBridge?: RepositoryWikiGroundingBridge | null;
  now?: () => string;
  /** @internal Deterministic dependency seams for adapter tests. */
  __internal?: Partial<AdapterDependencies> & AdapterTestSeams;
}

export interface RepositoryWikiGroundingBridge {
  withFreshGroundingSnapshot<T>(
    callback: (snapshot: RepositoryWikiGroundingSnapshot) => T | Promise<T>,
  ): Promise<T>;
  withFreshGroundingPublication?<T>(
    prepare: (snapshot: RepositoryWikiGroundingSnapshot) => RepositoryWikiPreparedPublication<T> | Promise<RepositoryWikiPreparedPublication<T>>,
  ): Promise<T>;
}

export type RepositoryWikiGroundingSnapshot = GroundingGraph & {
  /** Exact Graph snapshot revision used to bind current-projection cursors. */
  readonly revision: string;
  /** Optional compact symbol projection, bound to this same revocable snapshot. */
  getSymbols?(nodeIds: readonly string[]): readonly CodeSymbol[];
};

export interface RepositoryWikiPreparedPublication<T> {
  preflight(): void | Promise<void>;
  commit(): T | Promise<T>;
  discard(): void | Promise<void>;
}

/**
 * Repository-bound application adapter over the Wiki engine.
 *
 * Every read is buffered inside one immutable contract session and released
 * only after the session revalidates. No read method refreshes or rebuilds.
 */
export class RepositoryWikiPort implements WikiPort<
  never,
  RepositoryWikiOperationPayload,
  RepositoryWikiOperationPlan,
  RepositoryWikiMigrationPlan
>, WikiForcedCreatedIdPreviewPort<
  RepositoryWikiOperationPayload,
  RepositoryWikiOperationPlan
>, WikiExactAuthoringPreviewPort<
  RepositoryWikiOperationPayload,
  RepositoryWikiOperationPlan
> {
  readonly #projectRoot: string;
  readonly #scaffoldRoot: string;
  readonly #indexPath: string;
  readonly #projectIdentity: { dev: number; ino: number };
  #scaffoldIdentity: { dev: number; ino: number } | null;
  readonly #options: RepositoryWikiPortOptions;
  readonly #deps: AdapterDependencies;
  readonly #planKey = randomBytes(32);
  readonly #operationPlans = new Map<string, StoredOperationPlan>();
  readonly #migrationPlans = new Map<string, StoredMigrationPlan>();
  #postWriteRefreshFailed = false;

  constructor(projectRoot: string, options: RepositoryWikiPortOptions = {}) {
    const lexicalProject = resolve(projectRoot);
    const projectLstat = lstatSync(lexicalProject);
    if (!projectLstat.isDirectory() || projectLstat.isSymbolicLink()) {
      throw portError("PATH_OUTSIDE_PROJECT", 400, "Project root is unsafe", "The repository root must be a real, non-symlink directory.");
    }
    this.#projectRoot = realpathSync(lexicalProject);
    this.#projectIdentity = { dev: projectLstat.dev, ino: projectLstat.ino };
    const lexicalScaffold = resolve(this.#projectRoot, options.scaffoldRoot ?? ".mex");
    const scaffoldRelative = relative(this.#projectRoot, lexicalScaffold);
    if (scaffoldRelative === "" || scaffoldRelative.startsWith("..") || isAbsolute(scaffoldRelative)) {
      throw portError("PATH_OUTSIDE_PROJECT", 400, "Wiki scaffold is unsafe", "The Wiki scaffold must be a child of the repository root.");
    }
    if (existsSync(lexicalScaffold)) {
      const scaffoldLstat = lstatSync(lexicalScaffold);
      if (!scaffoldLstat.isDirectory() || scaffoldLstat.isSymbolicLink()) {
        throw portError("PATH_OUTSIDE_PROJECT", 400, "Wiki scaffold is unsafe", "The Wiki scaffold must be a real, non-symlink directory.");
      }
      const scaffoldReal = realpathSync(lexicalScaffold);
      const realRelative = relative(this.#projectRoot, scaffoldReal);
      if (realRelative === "" || realRelative.startsWith("..") || isAbsolute(realRelative)) {
        throw portError("PATH_OUTSIDE_PROJECT", 400, "Wiki scaffold is unsafe", "The Wiki scaffold resolves outside the repository root.");
      }
      this.#scaffoldRoot = scaffoldReal;
      this.#scaffoldIdentity = { dev: scaffoldLstat.dev, ino: scaffoldLstat.ino };
    } else {
      this.#scaffoldRoot = lexicalScaffold;
      this.#scaffoldIdentity = null;
    }
    this.#indexPath = resolve(this.#scaffoldRoot, options.indexPath ?? "wiki.db");
    const indexRelative = relative(this.#scaffoldRoot, this.#indexPath);
    if (indexRelative === "" || indexRelative.startsWith("..") || isAbsolute(indexRelative)) {
      throw portError("PATH_OUTSIDE_PROJECT", 400, "Wiki index path is unsafe", "The Wiki index must be a file below the Wiki scaffold.");
    }
    this.#options = options;
    this.#deps = {
      inspect: options.__internal?.inspect ?? inspectWikiContractIndex,
      read: options.__internal?.read ?? withWikiContractReadSession,
      readAsync: options.__internal?.readAsync ?? withWikiContractReadSessionAsync,
      rebuild: options.__internal?.rebuild ?? rebuildWikiIndex,
      refresh: options.__internal?.refresh ?? refreshWikiIndex,
      prepareRebuild: options.__internal?.prepareRebuild ?? prepareWikiRebuild,
      prepareRefresh: options.__internal?.prepareRefresh ?? prepareWikiRefresh,
    };
  }

  /** Package-private Wiki search bundle produced under one immutable session. */
  async searchBundle(request: WikiQueryRequest): Promise<RepositoryWikiSearchBundle> {
    return this.#readCurrent((session, graph) => ({
      indexedRevision: session.indexedRevision,
      observedAt: stableObservationTime(session),
      results: this.#currentSearchPage(session, graph, request),
    }));
  }

  /** Package-private Wiki browse bundle produced under one immutable session. */
  async listBundle(request: WikiListRequest = {}): Promise<RepositoryWikiListBundle> {
    return this.#readCurrent((session, graph) => ({
      indexedRevision: session.indexedRevision,
      observedAt: stableObservationTime(session),
      results: this.#currentListPage(session, graph, request),
    }));
  }

  /** All visible Context units and their authored edges from one immutable read. */
  async graphOverview(): Promise<RepositoryWikiGraphOverview> {
    return this.#readCurrent((session, graph) => {
      const status = session.status();
      if (status.state !== "fresh") throw indexError(status);
      const page = session.list({ kinds: WIKI_ENTITY_TYPES, includeArchived: true, limit: MAX_CONTEXT_NODES });
      const nodes = page.items.map((entity) => this.#projectCurrentSummary(session, graph, entity));
      const included = new Set(nodes.map((entity) => entity.ref.id));
      const relations: WikiRelation[] = [];
      let relationsTruncated = false;
      // Each source has at most 200 queryable relationships. Two ordinary pages
      // per source keep the scan bounded even when most targets are excluded.
      sources: for (const node of nodes) {
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
          const edges = session.relations({
            entityId: node.ref.id, direction: "outgoing", includeArchived: true,
            limit: 100, ...(cursor === undefined ? {} : { cursor }),
          });
          for (const hit of edges.items) {
            if (!included.has(hit.relation.target.id)) {
              if (hit.entity !== null && (WIKI_ENTITY_TYPES as readonly string[]).includes(hit.entity.type)) {
                relationsTruncated = true;
              }
              continue;
            }
            if (relations.length === MAX_CONTEXT_RELATIONS) {
              relationsTruncated = true;
              break sources;
            }
            relations.push(projectRelation(hit.relation));
          }
          cursor = edges.nextCursor ?? undefined;
          if (cursor === undefined) {
            if (edges.truncated) relationsTruncated = true;
            break;
          }
          if (pageIndex === 1) relationsTruncated = true;
        }
      }
      return {
        indexedRevision: session.indexedRevision,
        observedAt: stableObservationTime(session), nodes, relations,
        coverage: {
          nodeLimit: MAX_CONTEXT_NODES, relationLimit: MAX_CONTEXT_RELATIONS,
          nodesTruncated: page.truncated, relationsTruncated,
        },
      };
    });
  }

  /** Only direct, resolved grounding symbols; never fetch source bodies or traverse code. */
  async readGroundedCode(entityId: EntityId): Promise<RepositoryWikiGroundedCode> {
    return this.#readCurrent((session, graph) => {
      const status = session.status();
      if (status.state !== "fresh") throw indexError(status);
      const entity = session.get(entityId);
      if (entity === null || !(WIKI_ENTITY_TYPES as readonly string[]).includes(entity.type)) {
        throw portError("NOT_FOUND", 404, "Wiki entity not found", "The requested Context entity does not exist.");
      }
      const projected = projectGroundings(entity.groundings.slice(0, MAX_CODE_LOOKUP_NODES), stableObservationTime(session), graph);
      const groundings = projected.flatMap((grounding) => grounding.state === "ungrounded" ? [] : [{
        requestedNode: grounding.requestedNode,
        resolvedNode: grounding.state === "fresh" || grounding.state === "stale"
          ? grounding.resolvedNode ?? null : null,
        health: grounding.health,
      }]);
      const symbols = graph?.getSymbols?.(groundings.flatMap((grounding) => (
        grounding.resolvedNode === null ? [] : [grounding.resolvedNode]
      ))) ?? [];
      const byId = new Map(symbols.map((symbol) => [symbol.ref.symbolId, symbol]));
      return {
        indexedRevision: session.indexedRevision, observedAt: stableObservationTime(session), entityId,
        graphRevision: graph?.getSymbols === undefined ? null : graph.revision,
        groundings: groundings.map((grounding) => ({
          ...grounding, symbol: grounding.resolvedNode === null ? null : byId.get(grounding.resolvedNode) ?? null,
        })),
        truncated: entity.groundings.length > MAX_CODE_LOOKUP_NODES,
      };
    });
  }

  /**
   * Package-private exact refresh discovery. Added, modified, and deleted
   * canonical paths are compared inside one immutable Wiki read handshake.
   */
  async discoverRefreshPaths(): Promise<readonly RepoRelativePath[]> {
    return this.#read((session) => session.refreshPaths().map(toProjectPath));
  }

  /** Package-private entity workspace; entity and selected panel never mix snapshots. */
  async readKnowledgeWorkspace(
    request: RepositoryKnowledgeWorkspaceRequest,
  ): Promise<RepositoryKnowledgeWorkspace> {
    const view = request.view ?? "overview";
    const limit = strictInteger(request.limit ?? 25, "limit", 1, MAX_PRIVATE_PAGE);
    if (view === "overview" && (request.cursor !== undefined || request.direction !== undefined)) {
      throw validationError("Overview does not accept relation pagination parameters.");
    }
    if (view !== "relations" && request.direction !== undefined) {
      throw validationError("Relation direction is valid only for the relations view.");
    }
    if ((view === "overview" || view === "groundings") && request.cursor !== undefined) {
      throw validationError("This Knowledge view is not paginated.");
    }
    return this.#readCurrent((session, graph) => {
      const entity = session.get(request.entityId);
      if (entity === null) {
        throw portError("NOT_FOUND", 404, "Wiki entity not found", "The requested Wiki entity does not exist.");
      }
      const common = {
        indexedRevision: session.indexedRevision,
        observedAt: stableObservationTime(session),
        entity: projectEntity(entity, stableObservationTime(session), graph),
      };
      if (view === "relations") {
        return {
          ...common,
          selection: {
            kind: "relations" as const,
            results: projectPage(session.relations({
              entityId: request.entityId,
              direction: request.direction ?? "both",
              includeArchived: request.includeArchived ?? false,
              limit,
              ...(request.relationTypes === undefined ? {} : { relationTypes: request.relationTypes }),
              ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
            }), (hit) => this.#projectCurrentRelationHit(session, graph, hit)),
          },
        };
      }
      if (view === "backlinks") {
        return {
          ...common,
          selection: {
            kind: "backlinks" as const,
            results: projectPage(session.backlinks({
              entityId: request.entityId,
              includeArchived: request.includeArchived ?? false,
              limit,
              ...(request.relationTypes === undefined ? {} : { relationTypes: request.relationTypes }),
              ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
            }), projectRelation),
          },
        };
      }
      if (view === "groundings") {
        return {
          ...common,
          selection: {
            kind: "groundings" as const,
            results: projectGroundings(entity.groundings, stableObservationTime(session), graph),
          },
        };
      }
      return { ...common, selection: { kind: "overview" as const } };
    });
  }

  /**
   * Package-private Code→Knowledge lookup. It reads only explicit canonical
   * groundings already projected in the Wiki snapshot; it never opens Graph
   * storage and performs no fuzzy or inferred association.
   */
  async knowledgeForCode(
    request: RepositoryCodeKnowledgeRequest,
  ): Promise<RepositoryCodeKnowledgeResult> {
    const normalizedNodes = normalizeCodeLookupNodes(request.nodeIds);
    const limit = strictInteger(request.limit ?? 25, "limit", 1, MAX_PRIVATE_PAGE);
    const requestHash = hashCanonical({
      nodeIds: normalizedNodes,
      includeArchived: request.includeArchived ?? false,
      limit,
    });
    return this.#read((session) => {
      const offset = decodePrivateCursor(request.cursor, "code-knowledge", session.snapshotRevision, requestHash);
      const requested = new Set(normalizedNodes);
      const matches: RepositoryCodeKnowledgeHit[] = [];
      let scanCursor: string | undefined;
      let scanned = 0;
      let sourceTruncated = false;
      do {
        const page = session.list({
          includeArchived: request.includeArchived ?? false,
          limit: 100,
          ...(scanCursor === undefined ? {} : { cursor: scanCursor }),
        });
        for (const summary of page.items) {
          scanned += 1;
          if (scanned > MAX_COUNTED_ENTITIES) {
            sourceTruncated = true;
            break;
          }
          const entity = session.get(summary.id);
          if (entity === null || entity.groundings.length === 0) continue;
          const matchedNodes = explicitMatchedNodes(entity.groundings, requested);
          if (matchedNodes.length > 0) {
            matches.push({
              entity: { ...projectSummary(entity), groundingHealth: "unverified" },
              matchedNodes,
            });
          }
        }
        if (sourceTruncated) break;
        scanCursor = page.nextCursor ?? undefined;
      } while (scanCursor !== undefined);

      if (request.cursor !== undefined && offset >= matches.length) {
        throw invalidRequest("The Wiki cursor offset is outside this Code→Knowledge result set.");
      }
      const items = matches.slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      const hasMore = nextOffset < matches.length;
      const nextCursor = hasMore
        ? encodePrivateCursor("code-knowledge", session.snapshotRevision, requestHash, nextOffset)
        : null;
      return {
        indexedRevision: session.indexedRevision,
        observedAt: stableObservationTime(session),
        items,
        nextCursor,
        estimatedTokens: estimatePrivateTokens(items),
        truncated: hasMore || sourceTruncated,
      };
    });
  }

  async getEntity(id: EntityId): Promise<WikiEntity<never> | null> {
    return this.#readCurrent((session, graph) => {
      const entity = session.get(id);
      return entity === null ? null : projectEntity(entity, stableObservationTime(session), graph);
    });
  }

  /** Inbox target discovery requires a fresh Wiki snapshot and no Code Graph. */
  async readInboxTarget(id: EntityId): Promise<WikiEntity<never> | null> {
    return this.#read((session) => {
      const status = session.status();
      if (status.state !== "fresh") throw indexError(status);
      const entity = session.get(id);
      return entity === null ? null : projectEntity(entity, stableObservationTime(session), null);
    });
  }

  /**
   * Package-private common-snapshot attestation for governed Team authoring.
   * Unlike separate `getEntity` calls, every requested ID is resolved under
   * one immutable Wiki lease and the canonical corpus is revalidated before
   * this ordered view is released.
   */
  async readExactEntityAttestations(
    entityIds: readonly EntityId[],
  ): Promise<WikiExactEntityAttestationView> {
    if (!Array.isArray(entityIds) || entityIds.length > MAX_CURRENT_REVISION_EXPECTATIONS) {
      throw invalidRequest(`Exact Wiki attestation accepts at most ${MAX_CURRENT_REVISION_EXPECTATIONS} entity IDs.`);
    }
    const seen = new Set<string>();
    for (const id of entityIds) {
      if (!isEntityId(id) || !id.startsWith("mx_")) {
        throw invalidRequest("Exact Wiki attestation contains an invalid mx entity ID.");
      }
      if (seen.has(id)) throw invalidRequest("Exact Wiki attestation contains a duplicate entity ID.");
      seen.add(id);
    }
    return this.#readExactAuthoring((session, fileHashes) => {
      let claimants: ReturnType<typeof attestEntityClaimantsBatch>;
      try {
        claimants = attestEntityClaimantsBatch(entityIds, {
          scaffoldRoot: this.#scaffoldRoot,
          ...(this.#options.exclude === undefined ? {} : { exclude: this.#options.exclude }),
          ...(this.#options.registry === undefined ? {} : { registry: this.#options.registry }),
          parseCache: createParseCache(),
        });
      } catch (error) {
        if (
          error instanceof WikiClaimantScanIncompleteError
          || error instanceof WikiCorpusLimitError
        ) {
          throw revisionConflict(
            "The complete bounded Wiki claimant corpus could not be attested.",
          );
        }
        throw error;
      }
      return {
        indexedRevision: session.indexedRevision,
        observedAt: stableObservationTime(session),
        entities: entityIds.map((id) => {
          const indexed = session.get(id);
          const current = claimants.get(id);
          if (current === undefined) {
            throw revisionConflict("The requested Wiki claimant attestation is incomplete.");
          }
          if (indexed === null) {
            if (current.claimantCount !== 0 || current.winner !== null) {
              throw revisionConflict("A requested Wiki entity has an unindexed current claimant.");
            }
            return { id, entity: null };
          }
          const winner = current.winner;
          if (
            current.claimantCount !== 1
            || current.ambiguous
            || winner === null
            || isTeamOwnedReadOnlyPath(winner.path)
          ) {
            throw revisionConflict(
              "The requested Wiki entity does not have one exact Wiki-owned claimant.",
            );
          }
          const currentFileHash = exactFileContentHash(winner.text);
          if (
            fileHashes.get(winner.path) !== currentFileHash
            || !indexedEntityMatchesCurrentClaimant(indexed, winner, currentFileHash)
          ) {
            throw revisionConflict(
              "The requested Wiki entity row does not match its exact current source bytes.",
            );
          }
          return {
            id,
            entity: {
              ref: {
                id: winner.entity.id,
                kind: winner.entity.type,
                title: winner.entity.title,
              },
              version: {
                semanticRevision: winner.entity.revision,
                contentHash: currentFileHash,
              },
            },
          };
        }),
      };
    });
  }

  async getEntityNeighborhood(
    request: WikiNeighborhoodRequest,
  ): Promise<WikiEntityNeighborhoodSnapshot<never> | null> {
    return this.#readCurrent((session, graph) => {
      const entity = session.get(request.entityId);
      if (entity === null) return null;
      const observedAt = stableObservationTime(session);
      return {
        indexedRevision: session.indexedRevision,
        projectionRevision: currentProjectionRevision(session, graph),
        observedAt,
        entity: projectEntity(entity, observedAt, graph),
        neighborhood: this.#currentNeighborhood(session, graph, request),
      };
    });
  }

  async listEntities(request: WikiListRequest = {}): Promise<WikiPage<WikiEntitySummary>> {
    return this.#readCurrent((session, graph) => this.#currentListPage(session, graph, request));
  }

  async queryEntities(request: WikiQueryRequest): Promise<WikiPage<WikiSearchHit>> {
    return this.#readCurrent((session, graph) => this.#currentSearchPage(session, graph, request));
  }

  #currentListPage(
    session: WikiContractReadSession,
    graph: RepositoryWikiGroundingSnapshot | null,
    request: WikiListRequest,
  ): WikiPage<WikiEntitySummary> {
    const normalized = normalizeCurrentListRequest(request);
    const requestHash = hashCanonical(normalized);
    const projectionRevision = currentProjectionRevision(session, graph);
    const offset = decodePrivateCursor(request.cursor, "wiki-current-list", projectionRevision, requestHash);
    const candidates: WikiEntitySummary[] = [];
    let cursor: string | undefined;
    let sourceTruncated = false;
    do {
      const page = session.list({ ...normalized.engineRequest, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      for (const summary of page.items) {
        if (candidates.length >= MAX_COUNTED_ENTITIES) {
          sourceTruncated = true;
          break;
        }
        const current = this.#projectCurrentSummary(session, graph, summary);
        if (normalized.groundingHealth === undefined || normalized.groundingHealth.includes(current.groundingHealth)) {
          candidates.push(current);
        }
      }
      if (sourceTruncated) break;
      cursor = page.nextCursor ?? undefined;
      if (cursor === undefined && page.truncated) sourceTruncated = true;
    } while (cursor !== undefined);
    return currentProjectionPage(
      candidates,
      offset,
      normalized.limit,
      normalized.maxTokens,
      sourceTruncated,
      request.cursor,
      (nextOffset) => encodePrivateCursor("wiki-current-list", projectionRevision, requestHash, nextOffset),
    );
  }

  #currentSearchPage(
    session: WikiContractReadSession,
    graph: RepositoryWikiGroundingSnapshot | null,
    request: WikiQueryRequest,
  ): WikiPage<WikiSearchHit> {
    const normalized = normalizeCurrentSearchRequest(request);
    const requestHash = hashCanonical(normalized);
    const projectionRevision = currentProjectionRevision(session, graph);
    const offset = decodePrivateCursor(request.cursor, "wiki-current-search", projectionRevision, requestHash);
    const candidateSet = session.searchCandidates({
      ...normalized.engineRequest,
      query: normalized.query,
    });
    const projected = candidateSet.items.flatMap((hit) => {
      const current = this.#projectCurrentSummary(session, graph, hit.entity);
      return normalized.groundingHealth === undefined || normalized.groundingHealth.includes(current.groundingHealth)
        ? [{
          entity: current,
          matchedFields: [...hit.matchedFields],
          ...(hit.score === undefined ? {} : { score: hit.score }),
          ...(hit.relevance === undefined ? {} : { relevance: hit.relevance }),
        }]
        : [];
    }).sort(compareCurrentSearchHits);
    const sourceTruncated = candidateSet.truncated || projected.length > MAX_CURRENT_SEARCH_RESULTS;
    const candidates = projected.slice(0, MAX_CURRENT_SEARCH_RESULTS);
    return currentProjectionPage(
      candidates,
      offset,
      normalized.limit,
      normalized.maxTokens,
      sourceTruncated,
      request.cursor,
      (nextOffset) => encodePrivateCursor("wiki-current-search", projectionRevision, requestHash, nextOffset),
    );
  }

  #projectCurrentSummary(
    session: WikiContractReadSession,
    graph: RepositoryWikiGroundingSnapshot | null,
    summary: ContractEntitySummary,
  ): WikiEntitySummary {
    const groundings = session.groundingStatus(summary.id);
    if (groundings === null) {
      throw portError("INDEX_CORRUPT", 503, "Wiki index is corrupt", "A Wiki summary no longer has a grounding projection.");
    }
    return {
      ...projectSummary(summary),
      groundingHealth: aggregateWikiGroundingHealth(
        projectGroundings(groundings, stableObservationTime(session), graph),
      ),
    };
  }

  #projectCurrentRelationHit(
    session: WikiContractReadSession,
    graph: RepositoryWikiGroundingSnapshot | null,
    hit: ContractRelationHit,
  ): WikiRelationHit {
    const projected = projectRelationHit(hit);
    return {
      ...projected,
      entity: this.#projectCurrentSummary(session, graph, hit.entity!),
    };
  }

  async traverseRelations(request: WikiTraverseRequest): Promise<WikiPage<WikiRelationHit>> {
    return this.#readCurrent((session, graph) => projectPage(
      session.relations(request),
      (hit) => this.#projectCurrentRelationHit(session, graph, hit),
    ));
  }

  async getBacklinks(request: WikiBacklinksRequest): Promise<WikiPage<WikiRelation>> {
    return this.#read((session) => projectPage(session.backlinks(request), projectRelation));
  }

  async getNeighborhood(request: WikiNeighborhoodRequest): Promise<WikiEntityNeighborhood> {
    return this.#readCurrent((session, graph) => this.#currentNeighborhood(session, graph, request));
  }

  #currentNeighborhood(
    session: WikiContractReadSession,
    graph: RepositoryWikiGroundingSnapshot | null,
    request: WikiNeighborhoodRequest,
  ): WikiEntityNeighborhood {
    const result = session.neighborhood(request);
    return {
      root: this.#projectCurrentSummary(session, graph, result.root),
      entities: result.entities.map((entity) => this.#projectCurrentSummary(session, graph, entity)),
      relations: result.relations.map(projectRelation),
      estimatedTokens: result.estimatedTokens,
      truncated: result.truncated,
    };
  }

  async getGroundingStatus(id: EntityId): Promise<readonly WikiGroundingResolution[]> {
    return this.#readCurrent((session, graph) => {
      const entity = session.get(id);
      if (entity === null) throw portError("NOT_FOUND", 404, "Wiki entity not found", "The requested Wiki entity does not exist.");
      return projectGroundings(entity.groundings, stableObservationTime(session), graph);
    });
  }

  async validate(request: WikiValidationRequest = {}): Promise<WikiValidationReport> {
    const paths = request.paths?.map((path) => toScaffoldPath(path));
    const requestedMaxDiagnostics = request.maxDiagnostics ?? MAX_DIAGNOSTICS;
    if (!Number.isSafeInteger(requestedMaxDiagnostics) || requestedMaxDiagnostics < 0) {
      throw portError(
        "INVALID_REQUEST",
        400,
        "Wiki request invalid",
        "maxDiagnostics must be a non-negative integer.",
      );
    }
    const maxDiagnostics = Math.min(requestedMaxDiagnostics, MAX_DIAGNOSTICS);
    const observed = this.#inspect();
    if (["missing", "corrupt", "rebuild_required", "migration_required"].includes(observed.state)) {
      const diagnostics = observed.diagnostics.slice(0, maxDiagnostics).map(projectDiagnostic);
      return { valid: false, diagnostics };
    }
    return this.#read((session) => {
      const filters = {
        ...(request.entityIds === undefined ? {} : { entityIds: request.entityIds }),
        ...(paths === undefined ? {} : { paths }),
      };
      const diagnostics = session.diagnostics({
        ...filters,
        limit: maxDiagnostics,
      }).items.map(projectDiagnostic);
      return {
        valid: session.diagnosticValidation(filters).valid,
        diagnostics,
      };
    });
  }

  async validateCurrentRevisionExpectations(
    expectations: readonly WikiRevisionExpectation[],
  ): Promise<void> {
    if (expectations.length > MAX_CURRENT_REVISION_EXPECTATIONS) {
      throw validationError("Too many current Wiki revision expectations were requested.");
    }
    const options = { ...this.#operationOptions(null), parseCache: createParseCache() };
    const targets = new Set<string>();
    for (const expectation of expectations) {
      const targetKey = expectation.target.kind === "entity"
        ? `entity:${expectation.target.id}`
        : `artifact:${expectation.target.path}`;
      if (targets.has(targetKey)) throw validationError("A Wiki revision target appears more than once.");
      targets.add(targetKey);
      if ("contentHash" in expectation) {
        const path = toScaffoldPath(expectation.target.path);
        const actual = readContainedArtifactRevision(
          this.#scaffoldRoot,
          path,
          this.#options.__internal?.onCurrentRevisionArtifactRead,
        );
        if (actual !== expectation.contentHash) {
          throw revisionConflict("A Wiki artifact changed after it was read.");
        }
        continue;
      }

      if (!isEntityId(expectation.target.id)) {
        throw validationError("A Wiki entity revision expectation contains an invalid entity id.");
      }
      let current;
      try {
        current = attestEntityClaimants(expectation.target.id, options);
      } catch (error) {
        if (
          error instanceof WikiClaimantScanIncompleteError
          || error instanceof WikiCorpusLimitError
        ) {
          throw revisionConflict(
            "The complete bounded Wiki claimant corpus could not be observed safely.",
          );
        }
        throw error;
      }
      if (current.ambiguous || current.claimantCount === 2) {
        throw revisionConflict("A Wiki entity has duplicate canonical claimants.");
      }
      if (!("version" in expectation)) throw validationError("A Wiki revision expectation is malformed.");
      if (expectation.version === null) {
        if (current.claimantCount !== 0 || current.winner !== null) throw revisionConflict("A Wiki entity now exists.");
        continue;
      }
      if (current.claimantCount !== 1
        || current.winner === null
        || current.winner.entity.revision !== expectation.version.semanticRevision
        || exactFileContentHash(current.winner.text) !== expectation.version.contentHash) {
        throw revisionConflict("A Wiki entity changed after it was read.");
      }
    }
  }

  async previewOperations(
    request: WikiOperationRequest<RepositoryWikiOperationPayload>,
  ): Promise<RepositoryWikiOperationPreview> {
    return this.#previewOperationRequest(request, null, null, false);
  }

  /** Package-private exact-authoring update preview; public previews stay strict. */
  async previewAuthoringOperations(
    request: WikiOperationRequest<RepositoryWikiOperationPayload>,
  ): Promise<RepositoryWikiOperationPreview> {
    const items = normalizeRepositoryOperations(request.operation);
    if (items.length !== 1 || items[0]?.type !== "update-entry") {
      throw validationError(
        "Exact Wiki authoring preview accepts exactly one governed update and no generated IDs.",
      );
    }
    return this.#previewOperationRequest(request, null, null, true);
  }

  /**
   * Package-private receipt-bound create preview. It is deliberately narrower
   * than WikiPort: one direct create consumes exactly one caller-pinned ID.
   */
  async previewOperationsWithCreatedIds(
    request: WikiOperationRequest<RepositoryWikiOperationPayload>,
    createdIds: readonly EntityId[],
  ): Promise<RepositoryWikiOperationPreview> {
    return this.#previewOperationRequest(request, null, createdIds, true);
  }

  /** Package-private recovery entry point; callers persist only its bounded manifest. */
  async resumeOperations(
    request: WikiOperationRequest<RepositoryWikiOperationPayload>,
    manifest: RepositoryWikiOperationRecoveryManifest,
  ): Promise<RepositoryWikiOperationPreview> {
    return this.#previewOperationRequest(request, manifest, null, false);
  }

  /** Package-private, read-only classification of this request's ledger records. */
  inspectOperationRecovery(
    request: WikiOperationRequest<RepositoryWikiOperationPayload>,
  ): RepositoryWikiOperationRecoveryInspection {
    const items = normalizeRepositoryOperations(request.operation);
    assertOperationPayloadPaths(items);
    this.#assertOperationEnvelope(request, items);
    return this.#operationRecoveryAnalysis(request, items).inspection;
  }

  async #previewOperationRequest(
    request: WikiOperationRequest<RepositoryWikiOperationPayload>,
    manifest: RepositoryWikiOperationRecoveryManifest | null,
    forcedCreatedIds: readonly EntityId[] | null,
    exactAuthoring: boolean,
  ): Promise<RepositoryWikiOperationPreview> {
    const items = normalizeRepositoryOperations(request.operation);
    assertOperationPayloadPaths(items);
    this.#assertOperationEnvelope(request, items);
    const pinnedIds = forcedCreatedIds === null
      ? null
      : normalizeForcedCreatedIds(request, items, forcedCreatedIds);
    const requestHash = hashCanonical({ operation: request.operation, expectedRevisions: request.expectedRevisions });
    const recovery = this.#operationRecoveryAnalysis(request, items);
    let durableResume: DurableOperationResume | null = null;
    if (recovery.inspection.state === "mismatch") {
      throw validationError("The Wiki operation ledger does not match this recovery request.");
    }
    if (recovery.inspection.state === "complete") {
      throw validationError("This Wiki operation batch is already complete.");
    }
    if (recovery.inspection.state === "prefix") {
      if (manifest === null) {
        throw validationError("This Wiki operation requires its bounded recovery manifest after restart.");
      }
      this.#validateRecoveryManifest(request, items, requestHash, manifest);
      durableResume = {
        activeIndex: recovery.inspection.completedOperationIds.length,
        intent: recovery.intent,
        auditBaseText: recovery.intent === null
          ? recovery.exactText
          : recovery.exactText.slice(0, -`${JSON.stringify(recovery.intent)}\n`.length),
        auditBaseExists: manifest.items[recovery.inspection.completedOperationIds.length]?.audit.beforeRevision !== null,
        manifest,
      };
    } else if (manifest !== null) {
      throw validationError("No durable Wiki operation prefix exists for this recovery manifest.");
    }
    const prepared: PreparedDurableOperationResume = durableResume === null
      ? { envelopes: this.#prepareOperationBatch(request, items, exactAuthoring) }
      : this.#prepareDurableOperationResume(request, items, durableResume);
    let pinnedIdIndex = 0;
    const result = await this.#withStableGrounding((graph) => {
      const operationOptions = {
        ...this.#operationOptions(graph),
        ...(prepared.preferFile === undefined ? {} : { preferFile: prepared.preferFile }),
        ...(pinnedIds !== null ? {
          generateId: () => {
            const id = pinnedIds[pinnedIdIndex];
            pinnedIdIndex += 1;
            if (id === undefined) {
              throw validationError("The Wiki create attempted to consume more receipt-pinned IDs than were supplied.");
            }
            return id as EngineEntityId;
          },
        } : prepared.generateId === undefined ? {} : { generateId: prepared.generateId }),
        ...(durableResume === null ? {} : {
          auditText: prepared.settledIntentPlan?.audit.proposedText ?? durableResume.auditBaseText,
          auditExists: prepared.settledIntentPlan === undefined ? durableResume.auditBaseExists : true,
        }),
      };
      const planned = prepared.envelopes.length === 0
        ? {
            ok: true as const,
            plan: {
              v: 1 as const,
              operations: [] as readonly WikiPatchPlan[],
              previewRevision: batchPreviewRevisionOf({ v: 1, operations: [] }),
            },
            diagnostics: [],
          }
        : planOperationBatch(prepared.envelopes, operationOptions);
      if (!planned.ok || durableResume === null) return planned;
      if (prepared.settledIntentPlan !== undefined) {
        const operations = [prepared.settledIntentPlan, ...planned.plan.operations];
        const unsigned = { v: 1 as const, operations };
        return { ...planned, plan: { ...unsigned, previewRevision: batchPreviewRevisionOf(unsigned) } };
      }
      if (durableResume.intent === null) return planned;
      return {
        ...planned,
        plan: this.#bindDurableResumePlan(
          planned.plan,
          durableResume,
          prepared.rebindFirstAuthority === true,
        ),
      };
    });
    if (pinnedIds !== null && pinnedIdIndex > pinnedIds.length) {
      throw validationError("The Wiki create consumed more receipt-pinned IDs than were supplied.");
    }
    if (!result.ok) {
      const diagnostics = result.diagnostics.map(projectDiagnostic);
      const pathProblem = pathDiagnostic(result.diagnostics);
      if (pathProblem) throw pathProblem;
      return invalidOperationPreview(request.operation.opId, requestHash, diagnostics);
    }

    if (pinnedIds !== null) {
      const plannedCreatedIds = result.plan.operations.flatMap((operation) => operation.createdIds);
      if (pinnedIdIndex !== pinnedIds.length
        || canonical(plannedCreatedIds) !== canonical(pinnedIds)) {
        throw validationError("The Wiki create did not consume exactly the receipt-pinned entity ID.");
      }
    }

    await this.#validatePlannedAuthority(
      request,
      result.plan.operations,
      durableResume !== null,
      exactAuthoring,
    );
    if (durableResume !== null) this.#validateResumedPlan(result.plan, durableResume);

    const enginePreviewRevision = result.plan.previewRevision;
    const stored = {
      requestHash,
      enginePreviewRevision,
      plan: result.plan,
    } as const;
    const handle = this.#signPlan("operation", stored);
    rememberOpaquePlan(this.#operationPlans, handle, stored);
    const plan: RepositoryWikiOperationPlan = {
      v: 1,
      valid: true,
      requestHash,
      handle,
    };
    const changes = operationBatchChanges(result.plan);
    const affectedIds = [...new Set(result.plan.operations.flatMap((operation) => (
      [...operation.entityIds, ...operation.createdIds]
    )))];
    const affectedEntities = await this.#affectedEntities(
      affectedIds,
      result.plan.operations,
      exactAuthoring,
    );
    const recoveryManifest = durableResume?.manifest
      ?? operationRecoveryManifest(request.operation.opId, requestHash, result.plan);
    return {
      operationId: request.operation.opId,
      plan,
      previewRevision: operationPreviewRevision(plan),
      valid: true,
      changes,
      affectedEntities,
      recoveryManifest,
      validation: {
        valid: !result.diagnostics.some((entry) => entry.severity === "error"),
        diagnostics: result.diagnostics.map(projectDiagnostic),
      },
    };
  }

  async applyOperations(
    request: WikiOperationApplyRequest<RepositoryWikiOperationPayload, RepositoryWikiOperationPlan>,
  ): Promise<WikiOperationResult> {
    const requestHash = hashCanonical({ operation: request.operation, expectedRevisions: request.expectedRevisions });
    if (request.plan.v !== 1 || request.plan.requestHash !== requestHash) {
      throw validationError("The operation request does not match the reviewed Wiki plan.");
    }
    if (!request.plan.valid) throw validationError("An invalid Wiki operation plan cannot be applied.", request.plan.diagnostics);
    const stored = this.#operationPlans.get(request.plan.handle);
    if (stored === undefined || stored.requestHash !== requestHash) {
      throw validationError("The Wiki operation plan is unavailable; request a new preview in this process.");
    }
    const expected = operationPreviewRevision(request.plan);
    if (request.expectedPreviewRevision !== expected) {
      throw validationError("The expected preview revision does not identify this Wiki plan.");
    }

    // The executable plan carries every exact base byte and is revalidated by
    // the engine immediately before writing. Rechecking the caller's original
    // versions here would incorrectly reject an exact idempotent replay after
    // those reviewed bytes have already landed.
    let result;
    try {
      result = applyPlannedOperationBatch(stored.plan, {
        ...this.#operationOptions(null),
        expectedPreviewRevision: stored.enginePreviewRevision,
      });
    } catch (error) {
      throw translateWriteError(error);
    }
    if (!result.ok) throw errorForDiagnostics(result.diagnostics, "The Wiki operation could not be applied.");

    const changes = operationBatchChanges(stored.plan);
    const indexRefreshDiagnostic = result.diagnostics.find((entry) => entry.code === "INDEX_REFRESH_REQUIRED");
    const status = this.#inspect();
    const resultingVersions = indexRefreshDiagnostic === undefined
      ? await this.#versionsOnChangedFiles(changes)
      : {};
    const diagnostics = result.diagnostics.map(projectDiagnostic);
    if (indexRefreshDiagnostic !== undefined
      && !diagnostics.some((entry) => entry.code === indexRefreshDiagnostic.code)) {
      diagnostics.push(projectDiagnostic(indexRefreshDiagnostic));
    }
    this.#postWriteRefreshFailed = indexRefreshDiagnostic !== undefined;
    return {
      operationId: request.operation.opId,
      previewRevision: expected,
      // `applied` describes durable canonical state. An exact replay remains
      // applied; `idempotentReplay` distinguishes that no second write ran.
      applied: result.ok,
      idempotentReplay: result.replayed,
      changes,
      resultingVersions,
      audit: { appended: true, path: ".mex/events/operations.jsonl" },
      indexRefresh: indexRefreshDiagnostic === undefined && status.indexedRevision !== null
        ? { state: "refreshed", indexedRevision: status.indexedRevision }
        : {
            state: "rebuild_required",
            diagnostic: projectDiagnostic(indexRefreshDiagnostic ?? {
              code: "INDEX_REFRESH_REQUIRED",
              severity: "warning",
              message: "The canonical Wiki changed but its disposable index could not be refreshed.",
            }),
          },
      diagnostics,
    };
  }

  async inspectIndex(): Promise<WikiIndexStatus> {
    const status = projectIndexStatus(this.#inspect());
    return this.#postWriteRefreshFailed
      ? {
          ...status,
          state: "rebuild_required",
          diagnostics: status.diagnostics.some((entry) => entry.code === "INDEX_REFRESH_REQUIRED")
            ? status.diagnostics
            : [...status.diagnostics, {
                code: "INDEX_REFRESH_REQUIRED",
                severity: "error",
                message: "Canonical Wiki changes landed, but the disposable index refresh did not.",
              }],
        }
      : status;
  }

  async refreshFiles(paths: readonly RepoRelativePath[], context: OperationContext = {}) {
    const normalized = [...new Set(paths.map(toScaffoldPath))];
    if (normalized.length === 0) throw validationError("At least one Wiki path is required for refresh.");
    const startedAt = this.#now();
    try {
      const result = await this.#withPreparedGroundingMaintenance(
        (graph) => this.#prepareRefresh(normalized, context, graph),
        () => this.#prepareRefresh(normalized, context, null),
      );
      if (!result.ok) throw errorForDiagnostics([result.diagnostic], "The Wiki index could not be refreshed.");
      const status = this.#inspect();
      if (status.indexedRevision === null) throw indexError(status);
      const counts = await this.#countIndex();
      this.#postWriteRefreshFailed = false;
      return {
        state: "succeeded" as const,
        startedAt,
        finishedAt: this.#now(),
        diagnostics: result.diagnostics.map(projectDiagnostic),
        // Frozen port semantics count selected paths checked by refresh, not
        // physical writes. An unchanged path was still freshness-verified.
        filesRefreshed: result.reparsed.length + result.removed.length + result.unchanged.length,
        entitiesIndexed: counts.entities,
        relationsIndexed: counts.relations,
        indexedRevision: status.indexedRevision,
      };
    } catch (error) {
      throw translateMaintenanceError(error);
    }
  }

  async rebuildIndex(context: OperationContext = {}) {
    const startedAt = this.#now();
    try {
      const result = await this.#withPreparedGroundingMaintenance(
        (graph) => this.#deps.prepareRebuild({
          ...this.#writeOptions(graph),
          maintenance: maintenanceContext(context),
        }),
        () => this.#deps.prepareRebuild({
          ...this.#writeOptions(null),
          maintenance: maintenanceContext(context),
        }),
      );
      if (result.fileCount === 0
        && result.entityCount === 0
        && result.diagnostics.some((entry) => entry.code === "WIKI_INDEX_REBUILD_REQUIRED")) {
        throw portError(
          "OPERATION_INTERRUPTED",
          409,
          "Wiki rebuild interrupted",
          "The existing Wiki index is still in use, so the candidate index was not published.",
          result.diagnostics.map(projectDiagnostic),
        );
      }
      const status = this.#inspect();
      if (status.indexedRevision === null) throw indexError(status);
      const counts = await this.#countIndex();
      this.#postWriteRefreshFailed = false;
      return {
        state: "succeeded" as const,
        startedAt,
        finishedAt: this.#now(),
        diagnostics: result.diagnostics.map(projectDiagnostic),
        entitiesIndexed: counts.entities,
        relationsIndexed: counts.relations,
        indexedRevision: status.indexedRevision,
      };
    } catch (error) {
      throw translateMaintenanceError(error);
    }
  }

  async planMigration(
    options: WikiMigrationOptions = {},
  ): Promise<WikiMigrationPreview<RepositoryWikiMigrationPlan>> {
    const paths = options.paths?.map(toScaffoldPath);
    const topicMappings = options.topicMappings === undefined
      ? undefined
      : Object.fromEntries(Object.entries(options.topicMappings).map(([topic, id]) => {
          if (!isEntityId(id)) throw validationError("Wiki migration topic mappings require valid Wiki entity IDs.");
          return [topic, id];
        })) as Record<string, EngineEntityId>;
    const requestHash = hashCanonical(options);
    let enginePlan: PinnedMigrationPlan;
    try {
      enginePlan = await this.#withStableGrounding((graph) => planPinnedMigration({
        ...this.#migrationOptions(graph),
        ...(paths === undefined ? {} : { paths }),
        ...(topicMappings === undefined ? {} : { topicMappings }),
      }));
    } catch (error) {
      throw translateWriteError(error);
    }
    assertMigrationPlanPaths(enginePlan);
    const stored = { requestHash, plan: enginePlan } as const;
    const handle = this.#signPlan("migration", stored);
    rememberOpaquePlan(this.#migrationPlans, handle, stored);
    const plan: RepositoryWikiMigrationPlan = {
      v: 1,
      requestHash,
      handle,
    };
    const expectedRevisions = enginePlan.corpus.map((artifact) => ({
      target: { kind: "artifact" as const, path: toProjectPath(artifact.path) },
      contentHash: artifact.baseFileHash,
    }));
    const validation: WikiValidationReport = {
      valid: enginePlan.valid,
      diagnostics: enginePlan.report.diagnostics.map(projectDiagnostic),
    };
    return {
      migrationId: enginePlan.migrationId,
      previewRevision: migrationPreviewRevision(plan),
      plan,
      expectedRevisions,
      changes: migrationChanges(enginePlan.artifacts),
      report: projectMigrationReport(enginePlan.report, false),
      validation,
    };
  }

  async applyMigration(
    request: WikiMigrationApplyRequest<RepositoryWikiMigrationPlan>,
  ): Promise<WikiMigrationResult> {
    if (request.plan.v !== 1
      || request.migrationId.length === 0
      || request.previewRevision !== migrationPreviewRevision(request.plan)) {
      throw validationError("The migration request does not identify the reviewed Wiki plan.");
    }
    const stored = this.#migrationPlans.get(request.plan.handle);
    if (stored === undefined
      || stored.requestHash !== request.plan.requestHash
      || request.migrationId !== stored.plan.migrationId) {
      throw validationError("The Wiki migration plan is unavailable; request a new preview in this process.");
    }
    const expected = stored.plan.corpus.map((artifact) => ({
      target: { kind: "artifact" as const, path: toProjectPath(artifact.path) },
      contentHash: artifact.baseFileHash,
    }));
    if (canonical(request.expectedRevisions) !== canonical(expected)) {
      throw validationError("The migration revision expectations do not match the reviewed Wiki plan.");
    }
    let result;
    try {
      result = applyPinnedMigration(
        stored.plan,
        stored.plan.previewRevision,
        this.#migrationOptions(null),
      );
    } catch (error) {
      throw translateWriteError(error);
    }
    if (!result.ok) throw errorForDiagnostics(result.diagnostics, "The Wiki migration could not be applied.");

    // Migration is explicit write authority. When it creates the first
    // canonical entities in a legacy scaffold, publish the disposable index
    // before returning so the reviewed result is immediately readable.
    if (result.applied) {
      try {
        this.#deps.rebuild(this.#writeOptions(null));
        this.#postWriteRefreshFailed = false;
      } catch {
        // Canonical migration output remains authoritative. The result below
        // reports that its disposable index needs an explicit rebuild.
        this.#postWriteRefreshFailed = true;
      }
    }
    const diagnostics = result.diagnostics.map(projectDiagnostic);
    const indexStatus = this.#inspect();
    if (this.#postWriteRefreshFailed || (indexStatus.state !== "fresh" && indexStatus.state !== "degraded")) {
      diagnostics.push({
        code: "INDEX_REFRESH_REQUIRED",
        severity: "warning",
        message: "The Wiki migration applied, but its disposable index requires an explicit rebuild.",
      });
    }
    return {
      migrationId: result.migrationId,
      applied: result.applied,
      idempotentReplay: result.replayed,
      changes: migrationChanges(result.artifacts),
      report: projectMigrationReport(result.report, true),
      diagnostics,
    };
  }

  #read<T>(read: (session: WikiContractReadSession) => T): T {
    try {
      return this.#deps.read(this.#readOptions(), read);
    } catch (error) {
      throw translateReadError(error, this.#inspect());
    }
  }

  #readOperationPreview<T>(
    exactAuthoring: boolean,
    read: (session: WikiContractReadSession) => T,
  ): T {
    return exactAuthoring
      ? this.#readExactAuthoring((session) => read(session))
      : this.#read(read);
  }

  /**
   * Governed authoring needs a narrower freshness scope than ordinary Wiki
   * reads: Team-owned Markdown may advance independently, while every
   * Wiki-owned path and exact requested entity source must remain unchanged.
   */
  #readExactAuthoring<T>(
    read: (
      session: WikiContractReadSession,
      fileHashes: ReadonlyMap<string, string>,
    ) => T,
  ): T {
    try {
      return this.#deps.read(this.#readOptions(), (session) => {
        const status = session.status();
        if (status.state !== "fresh" && status.state !== "stale") {
          throw indexError(status);
        }
        const before = session.authoringCorpusAttestation();
        this.#assertExactAuthoringCorpus(status, before);
        const value = read(
          session,
          new Map(before.allFiles.map((file) => [file.path, file.contentHash])),
        );
        const after = session.authoringCorpusAttestation();
        this.#assertExactAuthoringCorpus(status, after);
        if (
          before.wikiOwnedRevision !== after.wikiOwnedRevision
          || !sameAttestedFileInventory(before.files, after.files)
          || !sameAttestedFileInventory(before.allFiles, after.allFiles)
        ) {
          throw revisionConflict(
            "The Wiki-owned canonical corpus changed during exact authoring attestation.",
          );
        }
        return value;
      });
    } catch (error) {
      throw translateReadError(error, this.#inspect());
    }
  }

  #assertExactAuthoringCorpus(
    status: ContractWikiIndexStatus,
    attestation: ReturnType<WikiContractReadSession["authoringCorpusAttestation"]>,
  ): void {
    if (!attestation.containmentSafe) {
      throw portError(
        "PATH_OUTSIDE_PROJECT",
        400,
        "Wiki path is outside the project",
        "Exact Wiki authoring attestation found an unsafe canonical path.",
      );
    }
    if (!attestation.wikiOwnedFresh) {
      throw status.state === "stale"
        ? indexError(status)
        : revisionConflict(
            "The Wiki-owned canonical corpus changed during exact authoring attestation.",
          );
    }
    if (!attestation.wikiOwnedDiagnosticsHealthy) {
      throw indexError(status);
    }
    if (
      (status.state === "fresh" && attestation.teamOwnedDrift)
      || (status.state === "stale" && !attestation.teamOwnedDrift)
    ) {
      throw revisionConflict(
        "The Wiki corpus freshness state changed during exact authoring attestation.",
      );
    }
  }

  async #readCurrent<T>(
    read: (session: WikiContractReadSession, graph: RepositoryWikiGroundingSnapshot | null) => T | Promise<T>,
  ): Promise<T> {
    try {
      return await this.#deps.readAsync(this.#readOptions(), (session) => (
        this.#withStableGrounding((graph) => read(session, graph))
      ));
    } catch (error) {
      throw translateReadError(error, this.#inspect());
    }
  }

  #assertOperationEnvelope(
    request: WikiOperationRequest<RepositoryWikiOperationPayload>,
    items: readonly NormalizedRepositoryOperation[],
  ): void {
    if (request.expectedRevisions.length === 0) {
      throw validationError("Every Wiki operation target requires an optimistic revision expectation.");
    }
    const first = items[0]!;
    if (request.operation.type !== first.type || request.operation.entityId !== first.entityId) {
      throw validationError("The operation envelope must identify the first ordered Wiki operation.");
    }
  }

  #operationRecoveryAnalysis(
    request: WikiOperationRequest<RepositoryWikiOperationPayload>,
    items: readonly NormalizedRepositoryOperation[],
  ): OperationRecoveryAnalysis {
    const operationIds = items.map((_, index) => operationItemId(request.operation.opId, index, items.length));
    let exact: ReturnType<typeof readOperationLogExact>;
    let log: ReturnType<typeof readAuditLog>;
    try {
      exact = readOperationLogExact(this.#scaffoldRoot);
      log = readAuditLog(this.#scaffoldRoot);
    } catch {
      return recoveryMismatch(operationIds, "audit_unsafe");
    }
    if (Buffer.byteLength(exact.text, "utf8") > OPERATION_LOG_MAX_BYTES
      || log.entries.length > OPERATION_LOG_MAX_ENTRIES
      || log.diagnostics.length > 0) {
      return recoveryMismatch(operationIds, "audit_unsafe", exact);
    }

    const expected = items.map((item, index) => operationAuditAuthority(request, item, index, items.length));
    const expectedIdSet = new Set(operationIds);
    const anyExpectedRecord = log.entries.some((entry) => expectedIdSet.has(entry.opId));
    const recordedIds = [...new Set(log.entries.map((entry) => entry.opId))];
    const unfinished = recordedIds.flatMap((opId) => {
      const record = recordFor(log, opId);
      return record.intent !== null && record.complete === null ? [record.intent] : [];
    });
    if (!anyExpectedRecord) {
      return unfinished.length === 0
        ? { inspection: { schemaVersion: 1, state: "none", operationIds }, exactText: exact.text, exactExists: exact.exists, intent: null }
        : recoveryMismatch(operationIds, "invalid_prefix", exact);
    }

    const completedOperationIds: string[] = [];
    const tailEntries: AuditEntry[] = [];
    let active: AuditEntry | null = null;
    let gap = false;
    for (let index = 0; index < expected.length; index += 1) {
      const authority = expected[index]!;
      const entries = log.entries.filter((entry) => entry.opId === authority.opId);
      if (entries.length === 0) {
        gap = true;
        continue;
      }
      if (gap) return recoveryMismatch(operationIds, "invalid_prefix", exact);
      if (entries.length === 2 && entries[0]?.phase === "intent" && entries[1]?.phase === "complete") {
        if (!matchesAuditAuthority(entries[0], authority) || !matchesAuditAuthority(entries[1], authority)) {
          return recoveryMismatch(operationIds, "authority_mismatch", exact);
        }
        completedOperationIds.push(authority.opId);
        tailEntries.push(entries[0], entries[1]);
        continue;
      }
      if (entries.length === 1 && entries[0]?.phase === "intent" && active === null) {
        if (!matchesAuditAuthority(entries[0], authority) || !validResumeIntent(entries[0])) {
          return recoveryMismatch(operationIds, "authority_mismatch", exact);
        }
        active = entries[0];
        tailEntries.push(active);
        gap = true;
        continue;
      }
      return recoveryMismatch(operationIds, "invalid_prefix", exact);
    }

    if (unfinished.some((entry) => entry !== active)) {
      return recoveryMismatch(operationIds, "invalid_prefix", exact);
    }
    if (completedOperationIds.length === operationIds.length) {
      return {
        inspection: { schemaVersion: 1, state: "complete", operationIds, completedOperationIds },
        exactText: exact.text,
        exactExists: exact.exists,
        intent: null,
      };
    }
    const actualTail = log.entries.slice(-tailEntries.length);
    if (tailEntries.length === 0
      || actualTail.some((entry, index) => entry !== tailEntries[index])) {
      return recoveryMismatch(operationIds, "invalid_prefix", exact);
    }
    if (active !== null) {
      const intentLine = `${JSON.stringify(active)}\n`;
      if (!exact.exists || !exact.text.endsWith(intentLine)) {
        return recoveryMismatch(operationIds, "invalid_prefix", exact);
      }
    }
    return {
      inspection: {
        schemaVersion: 1,
        state: "prefix",
        operationIds,
        completedOperationIds,
        activeOperationId: active?.opId ?? null,
      },
      exactText: exact.text,
      exactExists: exact.exists,
      intent: active,
    };
  }

  #prepareDurableOperationResume(
    request: WikiOperationRequest<RepositoryWikiOperationPayload>,
    items: readonly NormalizedRepositoryOperation[],
    resume: DurableOperationResume,
  ): PreparedDurableOperationResume {
    const activeItem = items[resume.activeIndex]!;
    const settledIntentPlan = resume.intent === null ? null : this.#settledIntentPlan(resume);
    const suffixStart = resume.activeIndex + (settledIntentPlan === null ? 0 : 1);
    const preferFile = resume.intent === null || settledIntentPlan !== null
      ? undefined
      : this.#resumePreferredFile(activeItem, resume.intent);
    const resumeSupersedeSourceOnly = settledIntentPlan === null
      && resume.intent !== null
      && this.#resumeSupersedeSourceOnly(activeItem, resume);
    const options = this.#operationOptions(null);
    const envelopes = items.slice(suffixStart).map((item, suffixIndex) => {
      const index = suffixStart + suffixIndex;
      const plannedItem: NormalizedRepositoryOperation = suffixIndex === 0 && resumeSupersedeSourceOnly
        ? {
            type: "set-property",
            entityId: item.entityId,
            payload: { property: "status", value: "deprecated" },
          }
        : item;
      const entity = item.entityId === undefined
        ? null
        : locateEntity(item.entityId, {
            ...options,
            ...(suffixIndex === 0 && preferFile !== undefined ? { preferFile } : {}),
          });
      if (item.entityId !== undefined && entity === null && item.type !== "create-entry") {
        throw portError("NOT_FOUND", 404, "Wiki entity not found", "A Wiki recovery target does not exist.");
      }
      return {
        opId: operationItemId(request.operation.opId, index, items.length),
        type: plannedItem.type,
        ...(plannedItem.entityId === undefined ? {} : { entityId: plannedItem.entityId }),
        ...(entity === null ? {} : {
          baseRevision: entity.entity.revision,
          baseContentHash: entity.entity.location.entityContentHash,
        }),
        actor: request.operation.actor,
        ...(request.operation.reason === undefined ? {} : { reason: request.operation.reason }),
        timestamp: request.operation.timestamp,
        payload: plannedItem.payload,
      };
    });

    const forcedIds = resume.manifest.items
      .slice(suffixStart + (resumeSupersedeSourceOnly ? 1 : 0))
      .flatMap((item) => item.createdIds)
      .map((id) => id as EngineEntityId);
    let forcedIndex = 0;
    return {
      envelopes,
      ...(preferFile === undefined ? {} : { preferFile }),
      ...(settledIntentPlan === null ? {} : { settledIntentPlan }),
      ...(resumeSupersedeSourceOnly ? { rebindFirstAuthority: true } : {}),
      ...(forcedIds.length === 0 ? {} : {
        generateId: () => forcedIds[forcedIndex++] ?? generateEntityId(),
      }),
    };
  }

  #resumeSupersedeSourceOnly(
    item: NormalizedRepositoryOperation,
    resume: DurableOperationResume,
  ): boolean {
    // A cross-file supersede writes its larger replacement first. Once those
    // exact reviewed bytes have landed, replaying the original create/relation
    // would correctly reject a duplicate. Re-plan only the still-original
    // source deprecation; #bindDurableResumePlan restores the original audit
    // authority and #validateResumedPlan proves both files against the manifest.
    if (item.type !== "supersede-entry" || item.entityId === undefined) return false;
    const expected = resume.manifest.items[resume.activeIndex];
    if (expected === undefined || expected.files.length < 2) return false;
    const source = locateEntity(item.entityId, this.#operationOptions(null));
    if (source === null) return false;
    const sourceEffect = expected.files.find((file) => toScaffoldPath(file.path) === source.path);
    if (sourceEffect === undefined
      || sourceEffect.beforeRevision === null
      || exactFileContentHash(source.text) !== sourceEffect.beforeRevision) return false;
    for (const file of expected.files) {
      if (file === sourceEffect) continue;
      let text: string;
      try {
        text = readContainedSource(
          this.#scaffoldRoot,
          resolve(this.#scaffoldRoot, toScaffoldPath(file.path)),
        );
      } catch {
        return false;
      }
      if (exactFileContentHash(text) !== file.afterRevision) return false;
    }
    return true;
  }

  #settledIntentPlan(resume: DurableOperationResume): WikiPatchPlan | null {
    const intent = resume.intent;
    const expected = resume.manifest.items[resume.activeIndex];
    if (intent === null || expected === undefined) return null;
    const expectedFiles = new Map(expected.files.map((file) => [toScaffoldPath(file.path), file]));
    if (expectedFiles.size !== intent.files.length
      || intent.files.some((path) => !expectedFiles.has(path))) return null;
    const files: WikiPatchPlan["files"] = [];
    for (const path of intent.files) {
      const recorded = expectedFiles.get(path)!;
      let text: string;
      try {
        text = readContainedSource(this.#scaffoldRoot, resolve(this.#scaffoldRoot, path));
      } catch {
        return null;
      }
      if (exactFileContentHash(text) !== recorded.afterRevision) return null;
      files.push({
        path,
        absolutePath: resolve(this.#scaffoldRoot, path),
        baseText: text,
        baseFileHash: recorded.afterRevision,
        existed: true,
        declared: [],
        edits: [],
        proposedText: text,
      });
    }
    const core: Omit<WikiPatchPlan, "audit"> = {
      opId: intent.opId,
      type: intent.type as WikiOperationType,
      actor: {
        kind: intent.actor.kind,
        id: intent.actor.id,
        ...(intent.sessionId === undefined ? {} : { sessionId: intent.sessionId }),
      },
      timestamp: intent.timestamp,
      ...(intent.reason === undefined ? {} : { reason: intent.reason }),
      payloadHash: intent.payloadHash,
      entityIds: intent.entityIds.map((id) => id as EngineEntityId),
      createdIds: intent.createdIds.map((id) => id as EngineEntityId),
      files,
      preconditions: [],
      revisions: intent.revisions.map((revision) => ({
        entityId: revision.entityId as EngineEntityId,
        before: revision.before,
        after: revision.after,
      })),
      diagnostics: [],
    };
    if (JSON.stringify(auditRecord(core, "intent")) !== JSON.stringify(intent)) return null;
    const complete = auditRecord(core, "complete");
    return {
      ...core,
      audit: {
        path: "events/operations.jsonl",
        absolutePath: resolve(this.#scaffoldRoot, "events", "operations.jsonl"),
        baseText: resume.auditBaseText,
        baseFileHash: resume.auditBaseExists ? exactFileContentHash(resume.auditBaseText) : null,
        proposedText: `${resume.auditBaseText}${JSON.stringify(intent)}\n${JSON.stringify(complete)}\n`,
      },
    };
  }

  #resumePreferredFile(
    item: NormalizedRepositoryOperation,
    intent: AuditEntry,
  ): string | undefined {
    if (item.type !== "move-entry" || item.entityId === undefined || !isPlainObject(item.payload)) return undefined;
    const destination = item.payload["file"];
    if (typeof destination !== "string") return undefined;
    const options = this.#operationOptions(null);
    for (const path of intent.files) {
      if (path === destination) continue;
      const located = locateEntity(item.entityId, { ...options, preferFile: path });
      if (located?.path === path) return path;
    }
    return undefined;
  }

  #bindDurableResumePlan(
    plan: WikiOperationBatchPlan,
    resume: DurableOperationResume,
    rebindFirstAuthority: boolean,
  ): WikiOperationBatchPlan {
    const recordedIntent = resume.intent;
    const plannedFirst = plan.operations[0];
    const first = plannedFirst === undefined || recordedIntent === null || !rebindFirstAuthority
      ? plannedFirst
      : {
          ...plannedFirst,
          type: recordedIntent.type as WikiOperationType,
          payloadHash: recordedIntent.payloadHash,
          actor: {
            kind: recordedIntent.actor.kind,
            id: recordedIntent.actor.id,
            ...(recordedIntent.sessionId === undefined ? {} : { sessionId: recordedIntent.sessionId }),
          },
          timestamp: recordedIntent.timestamp,
          ...(recordedIntent.reason === undefined ? {} : { reason: recordedIntent.reason }),
        };
    if (recordedIntent === null || first === undefined || !resumePlanIsSubset(first, recordedIntent)) {
      throw validationError("The current Wiki corpus cannot reproduce the recorded recovery intent.");
    }
    const files: WikiPatchPlan["files"] = [...first.files];
    for (const path of recordedIntent.files) {
      if (files.some((file) => file.path === path)) continue;
      let text: string;
      try {
        text = readContainedSource(this.#scaffoldRoot, resolve(this.#scaffoldRoot, path));
      } catch {
        throw validationError("A recorded Wiki recovery path is no longer safely readable.");
      }
      files.push({
        path,
        absolutePath: resolve(this.#scaffoldRoot, path),
        baseText: text,
        baseFileHash: exactFileContentHash(text),
        existed: true,
        declared: [],
        edits: [],
        proposedText: text,
      });
    }

    const reboundFirst: WikiPatchPlan = {
      ...first,
      entityIds: recordedIntent.entityIds.map((id) => id as EngineEntityId),
      createdIds: recordedIntent.createdIds.map((id) => id as EngineEntityId),
      files,
      revisions: recordedIntent.revisions.map((revision) => ({
        entityId: revision.entityId as EngineEntityId,
        before: revision.before,
        after: revision.after,
      })),
    };
    let auditText = resume.auditBaseText;
    let auditExists = resume.auditBaseExists;
    const operations = plan.operations.map((operation, index): WikiPatchPlan => {
      const current = index === 0 ? reboundFirst : operation;
      const { audit: _discarded, ...core } = current;
      const intent = auditRecord(core, "intent");
      if (index === 0 && JSON.stringify(intent) !== JSON.stringify(recordedIntent)) {
        throw validationError("The reproduced Wiki plan does not match the exact durable intent.");
      }
      const complete = auditRecord(core, "complete");
      const proposedText = `${auditText}${JSON.stringify(intent)}\n${JSON.stringify(complete)}\n`;
      const rebound: WikiPatchPlan = {
        ...core,
        audit: {
          path: "events/operations.jsonl",
          absolutePath: resolve(this.#scaffoldRoot, "events", "operations.jsonl"),
          baseText: auditText,
          baseFileHash: auditExists ? exactFileContentHash(auditText) : null,
          proposedText,
        },
      };
      auditText = proposedText;
      auditExists = true;
      return rebound;
    });
    const unsigned = { v: 1 as const, operations };
    return { ...unsigned, previewRevision: batchPreviewRevisionOf(unsigned) };
  }

  #validateRecoveryManifest(
    request: WikiOperationRequest<RepositoryWikiOperationPayload>,
    items: readonly NormalizedRepositoryOperation[],
    requestHash: Revision,
    manifest: RepositoryWikiOperationRecoveryManifest,
  ): void {
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(manifest), "utf8");
    } catch {
      throw validationError("The Wiki recovery manifest is not deterministic JSON.");
    }
    if (bytes > MAX_RECOVERY_MANIFEST_BYTES
      || !isPlainObject(manifest)
      || !hasExactKeys(manifest, ["items", "operationId", "requestHash", "schemaVersion"])
      || manifest.schemaVersion !== 1
      || manifest.requestHash !== requestHash
      || manifest.operationId !== request.operation.opId
      || !Array.isArray(manifest.items)
      || manifest.items.length !== items.length) {
      throw validationError("The Wiki recovery manifest does not identify this exact bounded request.");
    }

    const createdIds = new Set<string>();
    let fileCount = 0;
    for (let index = 0; index < manifest.items.length; index += 1) {
      const recorded = manifest.items[index];
      const item = items[index]!;
      const authority = operationAuditAuthority(request, item, index, items.length);
      if (!isPlainObject(recorded)
        || !hasExactKeys(recorded, ["audit", "createdIds", "files", "operationId", "payloadHash", "revisions", "type"])
        || recorded.operationId !== authority.opId
        || recorded.type !== authority.type
        || recorded.payloadHash !== authority.payloadHash
        || !Array.isArray(recorded.createdIds)
        || !Array.isArray(recorded.files)
        || !Array.isArray(recorded.revisions)
        || recorded.createdIds.length > 25
        || recorded.files.length > MAX_RECOVERY_MANIFEST_FILES
        || recorded.revisions.length > 50) {
        throw validationError("The Wiki recovery manifest item authority is invalid.");
      }
      for (const id of recorded.createdIds) {
        if (!isEntityId(id) || createdIds.has(id)) {
          throw validationError("The Wiki recovery manifest contains an invalid or repeated created id.");
        }
        createdIds.add(id);
      }
      const paths = new Set<string>();
      for (const file of recorded.files) {
        fileCount += 1;
        if (!isPlainObject(file)
          || !hasExactKeys(file, ["afterRevision", "beforeRevision", "path"])
          || typeof file.path !== "string"
          || (file.beforeRevision !== null && !isExactRevision(file.beforeRevision))
          || !isExactRevision(file.afterRevision)) {
          throw validationError("The Wiki recovery manifest contains an invalid file revision.");
        }
        const path = toScaffoldPath(file.path);
        if (!isWikiMarkdownMutationPath(path) || paths.has(path)) {
          throw validationError("The Wiki recovery manifest contains an invalid or repeated path.");
        }
        paths.add(path);
      }
      for (const revision of recorded.revisions) {
        if (!isPlainObject(revision)
          || !hasExactKeys(revision, ["after", "before", "entityId"])
          || !isEntityId(revision.entityId)
          || typeof revision.before !== "number"
          || typeof revision.after !== "number"
          || !Number.isSafeInteger(revision.before)
          || !Number.isSafeInteger(revision.after)
          || revision.before < 0
          || revision.after < 0) {
          throw validationError("The Wiki recovery manifest contains an invalid semantic revision.");
        }
      }
      if (!isPlainObject(recorded.audit)
        || !hasExactKeys(recorded.audit, ["afterRevision", "beforeRevision"])
        || (recorded.audit.beforeRevision !== null && !isExactRevision(recorded.audit.beforeRevision))
        || !isExactRevision(recorded.audit.afterRevision)) {
        throw validationError("The Wiki recovery manifest contains an invalid audit revision.");
      }
    }
    if (fileCount > MAX_RECOVERY_MANIFEST_FILES) {
      throw validationError("The Wiki recovery manifest contains too many file effects.");
    }
  }

  #validateResumedPlan(
    plan: WikiOperationBatchPlan,
    resume: DurableOperationResume,
  ): void {
    const expectedItems = resume.manifest.items.slice(resume.activeIndex);
    if (plan.operations.length !== expectedItems.length) {
      throw validationError("The reproduced Wiki recovery suffix has the wrong operation count.");
    }
    for (let index = 0; index < plan.operations.length; index += 1) {
      const operation = plan.operations[index]!;
      const expected = expectedItems[index]!;
      if (operation.opId !== expected.operationId
        || operation.type !== expected.type
        || operation.payloadHash !== expected.payloadHash
        || canonical(operation.createdIds) !== canonical(expected.createdIds)
        || canonical(operation.revisions) !== canonical(expected.revisions)) {
        throw validationError("The reproduced Wiki recovery operation differs from its manifest.");
      }
      const expectedFiles = new Map(expected.files.map((file) => [toScaffoldPath(file.path), file]));
      if (operation.files.length !== expectedFiles.size) {
        throw validationError("The reproduced Wiki recovery file set differs from its manifest.");
      }
      for (const file of operation.files) {
        const recorded = expectedFiles.get(file.path);
        const beforeRevision = file.existed ? exactFileContentHash(file.baseText) : null;
        const afterRevision = exactFileContentHash(file.proposedText);
        if (recorded === undefined
          || afterRevision !== recorded.afterRevision
          || (beforeRevision !== recorded.beforeRevision && beforeRevision !== recorded.afterRevision)) {
          throw validationError("The reproduced Wiki recovery bytes differ from the reviewed manifest.");
        }
      }
      const auditBefore = operation.audit.baseFileHash === null
        ? null
        : exactFileContentHash(operation.audit.baseText);
      if (auditBefore !== expected.audit.beforeRevision
        || exactFileContentHash(operation.audit.proposedText) !== expected.audit.afterRevision) {
        throw validationError("The reproduced Wiki recovery audit differs from the reviewed manifest.");
      }
    }
  }

  #prepareOperationBatch(
    request: WikiOperationRequest<RepositoryWikiOperationPayload>,
    items: readonly NormalizedRepositoryOperation[],
    exactAuthoring: boolean,
  ): readonly Record<string, unknown>[] {
    return this.#readOperationPreview(exactAuthoring, (session) => {
      for (const expected of request.expectedRevisions) {
        if (expected.target.kind === "artifact" && "contentHash" in expected) {
          const path = toScaffoldPath(expected.target.path);
          const actual = readContainedArtifactRevision(this.#scaffoldRoot, path);
          if (actual !== expected.contentHash) throw revisionConflict("A Wiki artifact changed after it was read.");
        }
      }
      return items.map((item, index) => {
        const entity = item.entityId === undefined ? null : session.get(item.entityId);
        if (item.entityId !== undefined && entity === null && item.type !== "create-entry") {
          throw portError("NOT_FOUND", 404, "Wiki entity not found", "A Wiki operation target does not exist.");
        }
        const expectation = item.entityId === undefined
          ? undefined
          : request.expectedRevisions.find((candidate): candidate is Extract<(typeof request.expectedRevisions)[number], { target: { kind: "entity" } }> => (
              candidate.target.kind === "entity" && candidate.target.id === item.entityId
            ));
        if (entity !== null) {
          if (expectation === undefined || expectation.version === null) {
            throw validationError("Every existing Wiki batch target requires an exact entity revision expectation.");
          }
          if (expectation.version.semanticRevision !== entity.semanticRevision
            || expectation.version.contentHash !== entity.fileContentHash) {
            throw revisionConflict("A Wiki batch target changed after it was read.");
          }
          if (index === 0 && (request.operation.baseRevision !== expectation.version.semanticRevision
            || request.operation.baseContentHash !== expectation.version.contentHash)) {
            throw validationError("The operation envelope contradicts its optimistic revision expectation.");
          }
        }
        return {
          opId: operationItemId(request.operation.opId, index, items.length),
          type: item.type,
          ...(item.entityId === undefined ? {} : { entityId: item.entityId }),
          ...(entity === null ? {} : {
            baseRevision: entity.semanticRevision,
            baseContentHash: entity.entityContentHash,
          }),
          actor: request.operation.actor,
          ...(request.operation.reason === undefined ? {} : { reason: request.operation.reason }),
          timestamp: request.operation.timestamp,
          payload: item.payload,
        };
      });
    });
  }

  async #validatePlannedAuthority(
    request: WikiOperationRequest<RepositoryWikiOperationPayload>,
    plans: readonly WikiPatchPlan[],
    durableResume = false,
    exactAuthoring = false,
  ): Promise<void> {
    for (const plan of plans) {
      if (plan.audit.path !== "events/operations.jsonl") {
        throw portError("PATH_OUTSIDE_PROJECT", 400, "Wiki path is outside the project", "The Wiki plan contains an invalid operation-ledger path.");
      }
      for (const file of plan.files) {
        if (!isWikiMarkdownMutationPath(file.path)) {
          throw portError("PATH_OUTSIDE_PROJECT", 400, "Wiki path is outside the project", "Wiki operations may change only canonical Markdown under .mex/.");
        }
      }
    }

    if (durableResume) return;

    await this.#readOperationPreview(exactAuthoring, (session) => {
      const created = new Set(plans.flatMap((plan) => plan.createdIds));
      const entityExpectations = new Map(request.expectedRevisions.flatMap((expectation) => (
        expectation.target.kind === "entity" && "version" in expectation
          ? [[expectation.target.id, expectation] as const]
          : []
      )));
      const artifactExpectations = new Map(request.expectedRevisions.flatMap((expectation) => (
        expectation.target.kind === "artifact" && "contentHash" in expectation
          ? [[toScaffoldPath(expectation.target.path), expectation.contentHash] as const]
          : []
      )));
      const coveredFiles = new Set<string>();

      for (const entityId of new Set(plans.flatMap((plan) => plan.entityIds))) {
        if (created.has(entityId)) continue;
        const expectation = entityExpectations.get(entityId);
        if (expectation?.version === null || expectation === undefined) {
          throw validationError("Every existing entity changed by a Wiki plan needs an exact revision expectation.");
        }
        const entity = session.get(entityId);
        if (entity === null) throw revisionConflict("A Wiki plan target no longer exists.");
        if (expectation.version.semanticRevision !== entity.semanticRevision
          || expectation.version.contentHash !== entity.fileContentHash) {
          throw revisionConflict("A Wiki plan target changed after it was read.");
        }
        coveredFiles.add(entity.location.path);
      }

      const firstFilePlans = new Map<string, (typeof plans)[number]["files"][number]>();
      for (const plan of plans) {
        for (const file of plan.files) if (!firstFilePlans.has(file.path)) firstFilePlans.set(file.path, file);
      }
      for (const file of firstFilePlans.values()) {
        if (coveredFiles.has(file.path)) continue;
        const expected = artifactExpectations.get(file.path);
        if (!artifactExpectations.has(file.path)) {
          throw validationError("Every additional Wiki artifact changed by a plan needs an exact revision expectation.");
        }
        const actual = readContainedArtifactRevision(this.#scaffoldRoot, file.path);
        if (actual !== expected) throw revisionConflict("A Wiki artifact changed after it was read.");
        if (file.existed !== (actual !== null)) throw revisionConflict("A Wiki artifact's existence changed during planning.");
      }
    });
  }

  async #affectedEntities(
    ids: readonly string[],
    plans: readonly WikiPatchPlan[],
    exactAuthoring: boolean,
  ): Promise<readonly EntityRef[]> {
    if (ids.length === 0) return [];
    const requested = new Set(ids);
    const planned = new Map<string, EntityRef>();
    const parseCache = createParseCache();
    // Parse only the exact already-planned bytes. Building generic operation
    // options here would consume write-only failure hooks during a read-only
    // preview projection.
    const options = {
      scaffoldRoot: this.#scaffoldRoot,
      ...(this.#options.registry === undefined ? {} : { registry: this.#options.registry }),
      parseCache,
    };
    for (const plan of plans) {
      for (const file of plan.files) {
        const parsed = parseCached(options, file.path, file.absolutePath, file.proposedText);
        for (const candidate of parsed.entities) {
          if (!requested.has(candidate.entity.id)) continue;
          planned.set(candidate.entity.id, {
            id: candidate.entity.id,
            kind: candidate.entity.type,
            title: candidate.entity.title,
          });
        }
      }
    }
    if (exactAuthoring) {
      return ids.map((id) => {
        const ref = planned.get(id);
        if (ref === undefined) {
          throw revisionConflict(
            "The exact Wiki authoring plan did not project every affected entity from its proposed bytes.",
          );
        }
        return ref;
      });
    }
    return this.#read((session) => ids.flatMap((id) => {
      const entity = session.get(id);
      const ref = entity === null ? planned.get(id) : projectRef(entity);
      return ref === undefined ? [] : [ref];
    }));
  }

  async #versionsOnChangedFiles(changes: readonly FileChange[]) {
    const paths = new Set(changes
      .filter((change) => change.path !== ".mex/events/operations.jsonl")
      .map((change) => change.path));
    return this.#read((session) => {
      const versions: Record<string, { semanticRevision: number; contentHash: string }> = {};
      let cursor: string | undefined;
      do {
        const page = session.list({ includeArchived: true, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
        for (const entity of page.items) {
          if (paths.has(toProjectPath(entity.location.path))) {
            versions[entity.id] = {
              semanticRevision: entity.semanticRevision,
              contentHash: entity.fileContentHash,
            };
          }
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return versions;
    });
  }

  async #countIndex(): Promise<{ entities: number; relations: number }> {
    return this.#read((session) => {
      let entities = 0;
      let relations = 0;
      let cursor: string | undefined;
      do {
        const page = session.list({ includeArchived: true, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
        for (const entity of page.items) {
          entities += 1;
          if (entities > MAX_COUNTED_ENTITIES) throw portError("INDEX_CORRUPT", 503, "Wiki index is unsafe", "The Wiki index exceeds its bounded entity census.");
          let relationCursor: string | undefined;
          do {
            const related = session.relations({
              entityId: entity.id,
              direction: "outgoing",
              includeArchived: true,
              limit: 100,
              ...(relationCursor === undefined ? {} : { cursor: relationCursor }),
            });
            relations += related.items.length;
            if (relations > MAX_COUNTED_RELATIONS) throw portError("INDEX_CORRUPT", 503, "Wiki index is unsafe", "The Wiki index exceeds its bounded relation census.");
            relationCursor = related.nextCursor ?? undefined;
          } while (relationCursor !== undefined);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return { entities, relations };
    });
  }

  #inspect(): ContractWikiIndexStatus {
    try {
      return this.#deps.inspect(this.#readOptions());
    } catch (error) {
      if (error instanceof MexPortError) throw error;
      return {
        state: "corrupt",
        observedAt: this.#now(),
        schemaVersion: null,
        indexedRevision: null,
        indexedAt: null,
        diagnostics: [],
      };
    }
  }

  #readOptions(): InspectWikiIndexOptions {
    this.#assertBoundRoots();
    return {
      scaffoldRoot: this.#scaffoldRoot,
      indexPath: this.#indexPath,
      ...(this.#options.exclude === undefined ? {} : { exclude: this.#options.exclude }),
      now: () => this.#now(),
    };
  }

  #writeOptions(graph: GroundingGraph | null) {
    this.#assertBoundRoots();
    const resolver = this.#groundingResolver(graph);
    return {
      scaffoldRoot: this.#scaffoldRoot,
      indexPath: this.#indexPath,
      ...(this.#options.exclude === undefined ? {} : { exclude: this.#options.exclude }),
      ...(this.#options.registry === undefined ? {} : { registry: this.#options.registry }),
      ...(resolver === undefined ? {} : { resolveGrounding: resolver }),
    };
  }

  #operationOptions(graph: GroundingGraph | null) {
    return {
      ...this.#writeOptions(graph),
      ...(this.#options.readOnly === undefined ? {} : { readOnly: this.#options.readOnly }),
      ...(graph === null ? {} : { graph }),
      ...(this.#options.__internal?.onOperationFileWritten === undefined ? {} : {
        onFileWritten: this.#options.__internal.onOperationFileWritten,
      }),
      ...(this.#options.__internal?.onOperationCompleted === undefined ? {} : {
        onOperationCompleted: this.#options.__internal.onOperationCompleted,
      }),
      now: () => this.#now(),
    };
  }

  #migrationOptions(graph: GroundingGraph | null) {
    this.#assertBoundRoots();
    return {
      scaffoldRoot: this.#scaffoldRoot,
      indexPath: this.#indexPath,
      ...(this.#options.exclude === undefined ? {} : { exclude: this.#options.exclude }),
      ...(this.#options.readOnly === undefined ? {} : { readOnly: this.#options.readOnly }),
      ...(this.#options.registry === undefined ? {} : { registry: this.#options.registry }),
      ...(graph === null ? {} : { graph }),
      now: () => this.#now(),
    };
  }

  #groundingResolver(graph: GroundingGraph | null): GroundingResolver | undefined {
    if (graph === null) {
      if (this.#options.__internal?.failOperationIndexRefresh?.() !== true) return undefined;
      return () => {
        throw new Error("injected-operation-index-refresh-failure");
      };
    }
    return (grounding, context) => {
          if (this.#options.__internal?.failOperationIndexRefresh?.() === true) {
            throw new Error("injected-operation-index-refresh-failure");
          }
          return resolveGrounding(grounding, graph, context);
        };
  }

  async #withStableGrounding<T>(
    work: (graph: RepositoryWikiGroundingSnapshot | null) => T | Promise<T>,
  ): Promise<T> {
    const bridge = this.#options.groundingBridge;
    if (bridge === undefined || bridge === null) return work(null);
    try {
      return await bridge.withFreshGroundingSnapshot(async (snapshot) => {
        try {
          assertGroundingSnapshotRevision(snapshot);
          return await work(snapshot);
        } catch (error) {
          if (isGraphBridgeUnavailable(error)) throw error;
          throw new GroundingWorkFailure(error);
        }
      });
    } catch (error) {
      if (error instanceof GroundingWorkFailure) throw error.cause;
      if (!isGraphBridgeUnavailable(error)) throw error;
      return work(null);
    }
  }

  #prepareRefresh(
    paths: readonly string[],
    context: OperationContext,
    graph: GroundingGraph | null,
  ): PreparedWikiRefresh {
    const result = this.#deps.prepareRefresh({
      ...this.#writeOptions(graph),
      changed: paths,
      maintenance: maintenanceContext(context),
    });
    if (!result.ok) throw errorForDiagnostics([result.diagnostic], "The Wiki index could not be refreshed.");
    return result.prepared;
  }

  async #withPreparedGroundingMaintenance<T>(
    prepareGrounded: (graph: GroundingGraph) => RepositoryWikiPreparedPublication<T>,
    prepareUnverified: () => RepositoryWikiPreparedPublication<T>,
  ): Promise<T> {
    const bridge = this.#options.groundingBridge;
    const publishUnverified = async (): Promise<T> => {
      const prepared = prepareUnverified();
      try {
        await prepared.preflight();
      } catch (error) {
        await prepared.discard();
        throw error;
      }
      return prepared.commit();
    };
    if (bridge?.withFreshGroundingPublication === undefined) return publishUnverified();
    try {
      return await bridge.withFreshGroundingPublication(async (snapshot) => {
        try {
          assertGroundingSnapshotRevision(snapshot);
          return prepareGrounded(snapshot);
        } catch (error) {
          if (isGraphBridgeUnavailable(error)) throw error;
          throw new GroundingWorkFailure(error);
        }
      });
    } catch (error) {
      if (error instanceof GroundingWorkFailure) throw error.cause;
      if (!isGraphBridgeUnavailable(error)) throw error;
      return publishUnverified();
    }
  }

  #signPlan(kind: "operation" | "migration", value: unknown): string {
    return createHmac("sha256", this.#planKey).update(kind).update("\0").update(canonical(value)).digest("hex");
  }

  #assertBoundRoots(): void {
    try {
      const project = lstatSync(this.#projectRoot);
      if (!project.isDirectory()
        || project.isSymbolicLink()
        || project.dev !== this.#projectIdentity.dev
        || project.ino !== this.#projectIdentity.ino
        || realpathSync(this.#projectRoot) !== this.#projectRoot) {
        throw new Error("project-root-replaced");
      }
      if (!existsSync(this.#scaffoldRoot)) return;
      const scaffold = lstatSync(this.#scaffoldRoot);
      const scaffoldReal = realpathSync(this.#scaffoldRoot);
      const rel = relative(this.#projectRoot, scaffoldReal);
      if (!scaffold.isDirectory()
        || scaffold.isSymbolicLink()
        || rel === ""
        || rel.startsWith("..")
        || isAbsolute(rel)
        || (this.#scaffoldIdentity !== null
          && (scaffold.dev !== this.#scaffoldIdentity.dev || scaffold.ino !== this.#scaffoldIdentity.ino))) {
        throw new Error("scaffold-root-replaced");
      }
      if (this.#scaffoldIdentity === null) {
        this.#scaffoldIdentity = { dev: scaffold.dev, ino: scaffold.ino };
      }
    } catch (error) {
      if (error instanceof MexPortError) throw error;
      throw portError(
        "PATH_OUTSIDE_PROJECT",
        400,
        "Wiki scaffold is unsafe",
        "The repository or Wiki scaffold root changed identity or resolves outside the project.",
      );
    }
  }

  #now(): string {
    return (this.#options.now ?? (() => new Date().toISOString()))();
  }
}

function sameAttestedFileInventory(
  left: readonly { path: string; contentHash: string }[],
  right: readonly { path: string; contentHash: string }[],
): boolean {
  return left.length === right.length
    && left.every((file, index) => (
      file.path === right[index]?.path
      && file.contentHash === right[index]?.contentHash
    ));
}

function indexedEntityMatchesCurrentClaimant(
  indexed: ContractEntity,
  current: LocatedEntity,
  currentFileHash: string,
): boolean {
  const entity = current.entity;
  const location = entity.location;
  return indexed.indexRow.entityKey === current.entityKey
    && indexed.indexRow.metadataKind === current.metadataKind
    && indexed.indexRow.provenance === canonicalJson(entity.provenance)
    && indexed.indexRow.metadata === canonicalJson(entity.metadata)
    && indexed.id === entity.id
    && indexed.type === entity.type
    && indexed.title === entity.title
    && indexed.summary === (entity.summary ?? null)
    && indexed.body === entity.body
    && indexed.lifecycleState === entity.status
    && indexed.semanticRevision === entity.revision
    && indexed.fileContentHash === currentFileHash
    && location.fileContentHash === currentFileHash
    && indexed.entityContentHash === location.entityContentHash
    && indexed.location.path === current.path
    && location.file === current.path
    && indexed.location.metadataStart === location.metadataStart
    && indexed.location.metadataEnd === location.metadataEnd
    && indexed.location.headingStart === location.headingStart
    && indexed.location.headingEnd === location.headingEnd
    && indexed.location.bodyStart === location.bodyStart
    && indexed.location.bodyEnd === location.bodyEnd
    && indexed.location.startLine === location.startLine
    && indexed.location.endLine === location.endLine
    && indexed.location.headingDepth === location.headingDepth
    && indexed.topics.length === entity.topics.length
    && indexed.topics.every((topic, index) => topic === entity.topics[index]);
}

export function createRepositoryWikiPort(
  projectRoot: string,
  options: RepositoryWikiPortOptions = {},
): RepositoryWikiPort {
  return new RepositoryWikiPort(projectRoot, options);
}

function projectPage<TInput, TOutput>(
  page: ContractPage<TInput>,
  project: (item: TInput) => TOutput,
): WikiPage<TOutput> {
  return {
    items: page.items.map(project),
    nextCursor: page.nextCursor,
    estimatedTokens: page.estimatedTokens,
    truncated: page.truncated,
  };
}

function projectRef(entity: Pick<ContractEntitySummary, "id" | "type" | "title">): EntityRef {
  return { id: entity.id, kind: entity.type, title: entity.title };
}

function projectSummary(entity: ContractEntitySummary): WikiEntitySummary {
  return {
    ref: projectRef(entity),
    title: entity.title,
    ...(entity.summary === null ? {} : { summary: entity.summary }),
    location: {
      path: toProjectPath(entity.location.path),
      startLine: entity.location.startLine,
      endLine: entity.location.endLine,
      startOffset: entity.location.metadataStart,
      endOffset: entity.location.bodyEnd,
      headingDepth: entity.location.headingDepth,
    },
    version: {
      semanticRevision: entity.semanticRevision,
      contentHash: entity.fileContentHash,
    },
    lifecycleState: entity.lifecycleState as WikiEntitySummary["lifecycleState"],
    groundingHealth: entity.groundingHealth,
    topics: [...entity.topics],
    sourceTypes: [...entity.sourceTypes],
    diagnostics: entity.diagnostics.map(projectDiagnostic),
  };
}

function projectEntity(
  entity: ContractEntity,
  observedAt: string,
  graph: GroundingGraph | null,
): WikiEntity<never> {
  const groundings = projectGroundings(entity.groundings, observedAt, graph);
  return {
    ...projectSummary(entity),
    groundingHealth: aggregateWikiGroundingHealth(groundings),
    body: entity.body,
    relations: entity.relations.map((relation) => ({
      type: relation.type,
      target: relation.targetId,
      ...(relation.note === undefined ? {} : { note: relation.note }),
      ...optionalMetadata(relation.metadata),
    })),
    backlinks: entity.backlinks.map(projectRelation),
    sources: entity.sources.map((source) => ({
      type: source.type,
      ...(source.ref === undefined ? {} : { ref: source.ref }),
      ...(source.note === undefined ? {} : { note: source.note }),
      ...(source.repository === undefined ? {} : { repository: source.repository }),
      ...(source.commit === undefined ? {} : { commit: source.commit }),
      ...(source.capturedAt === undefined ? {} : { capturedAt: source.capturedAt }),
      ...optionalMetadata(source.metadata),
    })),
    ...(entity.provenance === undefined ? {} : {
      provenance: {
        kind: entity.provenance.createdBy.kind,
        id: entity.provenance.createdBy.id,
        ...(entity.provenance.agentSessionId === undefined ? {} : { sessionId: entity.provenance.agentSessionId }),
        ...(entity.provenance.createdAt === undefined ? {} : { capturedAt: entity.provenance.createdAt }),
      },
    }),
    groundings,
    diagnostics: entity.diagnostics.map(projectDiagnostic),
  };
}

function projectSearchHit(hit: ContractSearchHit): WikiSearchHit {
  return {
    entity: projectSummary(hit.entity),
    matchedFields: [...hit.matchedFields],
    ...(hit.score === undefined ? {} : { score: hit.score }),
    ...(hit.relevance === undefined ? {} : { relevance: hit.relevance }),
  };
}

function projectRelation(relation: ContractRelation): WikiRelation {
  return {
    type: relation.type,
    source: { id: relation.source.id, kind: relation.source.type, title: relation.source.title },
    target: {
      id: relation.target.id,
      kind: relation.target.type ?? "unknown",
      ...(relation.target.title === undefined ? {} : { title: relation.target.title }),
    },
    ...(relation.note === undefined ? {} : { note: relation.note }),
    ...optionalMetadata(relation.metadata),
  };
}

function projectRelationHit(hit: ContractRelationHit): WikiRelationHit {
  if (hit.entity === null) {
    throw portError("NOT_FOUND", 404, "Related Wiki entity not found", "The related Wiki entity is not present in this index.");
  }
  return {
    relation: projectRelation(hit.relation),
    direction: hit.direction,
    entity: projectSummary(hit.entity),
  };
}

function projectGroundings(
  groundings: readonly ContractGrounding[],
  observedAt = new Date(0).toISOString(),
  graph?: GroundingGraph | null,
): readonly WikiGroundingResolution[] {
  if (groundings.length === 0) return [{ state: "ungrounded", health: "unverified", observedAt }];
  const current = graph === undefined ? groundings : currentContractGroundings(groundings, graph);
  return current.map((grounding) => projectGrounding(grounding, observedAt));
}

function currentContractGroundings(
  groundings: readonly ContractGrounding[],
  graph: GroundingGraph | null,
): readonly ContractGrounding[] {
  return groundings.map((grounding) => ({
    ...grounding,
    resolution: resolveGrounding({
      node: grounding.requestedNode,
      fingerprint: grounding.fingerprint,
      ...(grounding.bodyHash === undefined ? {} : { bodyHash: grounding.bodyHash }),
      ...(grounding.file === undefined ? {} : { file: grounding.file }),
      ...(grounding.commit === undefined ? {} : { commit: grounding.commit }),
      ...(grounding.verifiedAt === undefined ? {} : { verifiedAt: grounding.verifiedAt }),
      ...(grounding.reason === undefined ? {} : { reason: grounding.reason }),
    }, graph) as unknown as Readonly<Record<string, unknown>>,
  }));
}

function projectGrounding(value: ContractGrounding, observedAt: string): WikiGroundingResolution {
  const grounding: WikiGrounding = {
    node: value.requestedNode,
    fingerprint: value.fingerprint,
    ...(value.file === undefined ? {} : { file: value.file }),
    ...(value.commit === undefined ? {} : { commit: value.commit }),
    ...(value.verifiedAt === undefined ? {} : { verifiedAt: value.verifiedAt }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  };
  const resolution = value.resolution as Partial<EngineGroundingResolution> | null;
  if (resolution?.state === "fresh" && typeof resolution.resolvedNode === "string") {
    return {
      state: "fresh",
      health: "fresh",
      requestedNode: value.requestedNode,
      observedAt,
      grounding,
      resolvedNode: resolution.resolvedNode,
      ...(value.reason === undefined ? {} : { reason: value.reason }),
    };
  }
  if (resolution?.state === "stale") {
    return {
      state: "stale",
      health: "changed",
      requestedNode: value.requestedNode,
      observedAt,
      grounding,
      ...(typeof resolution.resolvedNode === "string" ? { resolvedNode: resolution.resolvedNode } : {}),
      ...(value.reason === undefined ? {} : { reason: value.reason }),
    };
  }
  if (resolution?.state === "missing") {
    return {
      state: "missing",
      health: "missing",
      requestedNode: value.requestedNode,
      observedAt,
      grounding,
      ...(typeof resolution.reason === "string" ? { reason: resolution.reason } : {}),
    };
  }
  if (resolution?.state === "unresolved") {
    const candidates = Array.isArray(resolution.candidates)
      ? resolution.candidates.filter((candidate): candidate is string => typeof candidate === "string").map((node): WikiGroundingCandidate => ({ node }))
      : undefined;
    return {
      state: "unresolved",
      health: resolution.health === "ambiguous" ? "ambiguous" : "unverified",
      requestedNode: value.requestedNode,
      observedAt,
      grounding,
      ...(candidates === undefined ? {} : { candidates }),
      ...(typeof resolution.reason === "string" ? { reason: resolution.reason } : {}),
    };
  }
  return {
    state: "unresolved",
    health: "unverified",
    requestedNode: value.requestedNode,
    observedAt,
    grounding,
    reason: "This grounding was indexed without a code-graph observation.",
  };
}

function projectIndexStatus(status: ContractWikiIndexStatus): WikiIndexStatus {
  return {
    state: status.state,
    observedAt: status.observedAt,
    schemaVersion: status.schemaVersion,
    indexedRevision: status.indexedRevision,
    indexedAt: status.indexedAt,
    diagnostics: status.diagnostics.map(projectDiagnostic),
  };
}

function projectDiagnostic(entry: WikiDiagnostic): Diagnostic {
  const path = safeProjectPath(entry.file ?? entry.location?.file);
  return {
    code: entry.code,
    severity: entry.severity,
    message: sanitizeMessage(entry.message),
    ...(path === undefined ? {} : { path }),
    ...(entry.location === undefined || path === undefined ? {} : {
      location: {
        path,
        ...(entry.location.startLine === undefined ? {} : { startLine: entry.location.startLine }),
        ...(entry.location.endLine === undefined ? {} : { endLine: entry.location.endLine }),
        ...(entry.location.startOffset === undefined ? {} : { startOffset: entry.location.startOffset }),
        ...(entry.location.endOffset === undefined ? {} : { endOffset: entry.location.endOffset }),
      },
    }),
    ...(entry.remediation === undefined ? {} : {
      remediation: [{ label: sanitizeMessage(entry.remediation).slice(0, 256) }],
    }),
  };
}

function operationBatchChanges(plan: WikiOperationBatchPlan): readonly FileChange[] {
  const changes: FileChange[] = [];
  const files = new Map<string, {
    path: string;
    existed: boolean;
    baseText: string;
    proposedText: string;
  }>();
  for (const operation of plan.operations) {
    for (const file of operation.files) {
      const current = files.get(file.path);
      if (current === undefined) {
        files.set(file.path, {
          path: file.path,
          existed: file.existed,
          baseText: file.baseText,
          proposedText: file.proposedText,
        });
      } else {
        current.proposedText = file.proposedText;
      }
    }
  }
  for (const file of files.values()) {
    if (file.existed && file.baseText === file.proposedText) continue;
    const path = toProjectPath(file.path);
    const beforeRevision = file.existed ? exactFileContentHash(file.baseText) : null;
    const afterRevision = exactFileContentHash(file.proposedText);
    changes.push(file.existed
      ? {
          kind: "update",
          path,
          beforeRevision: beforeRevision!,
          afterRevision,
          diff: canonicalFileDiff(path, file.baseText, file.proposedText),
        }
      : {
          kind: "create",
          path,
          beforeRevision: null,
          afterRevision,
          diff: canonicalFileDiff(path, null, file.proposedText),
        });
  }
  const firstAudit = plan.operations[0]!.audit;
  const lastAudit = plan.operations.at(-1)!.audit;
  const auditPath = toProjectPath(firstAudit.path);
  changes.push(firstAudit.baseFileHash === null
    ? {
        kind: "create",
        path: auditPath,
        beforeRevision: null,
        afterRevision: exactFileContentHash(lastAudit.proposedText),
        diff: canonicalFileDiff(auditPath, null, lastAudit.proposedText),
      }
    : {
        kind: "update",
        path: auditPath,
        beforeRevision: exactFileContentHash(firstAudit.baseText),
        afterRevision: exactFileContentHash(lastAudit.proposedText),
        diff: canonicalFileDiff(auditPath, firstAudit.baseText, lastAudit.proposedText),
      });
  return changes;
}

function operationPreviewRevision(plan: Extract<RepositoryWikiOperationPlan, { valid: true }>): Revision {
  return hashCanonical({
    v: plan.v,
    requestHash: plan.requestHash,
    handle: plan.handle,
  });
}

function migrationPreviewRevision(plan: RepositoryWikiMigrationPlan): Revision {
  return hashCanonical({
    v: plan.v,
    requestHash: plan.requestHash,
    handle: plan.handle,
  });
}

function assertMigrationPlanPaths(plan: PinnedMigrationPlan): void {
  if (plan.audit.path !== "events/operations.jsonl") {
    throw portError("PATH_OUTSIDE_PROJECT", 400, "Wiki path is outside the project", "The Wiki migration contains an invalid operation-ledger path.");
  }
  for (const artifact of [...plan.corpus, ...plan.artifacts]) {
    if (artifact.path === "events/operations.jsonl") continue;
    if (!isWikiMarkdownMutationPath(artifact.path)) {
      throw portError("PATH_OUTSIDE_PROJECT", 400, "Wiki path is outside the project", "Wiki migration may change only canonical Markdown under .mex/.");
    }
  }
  for (const operation of plan.operations) {
    if (operation.audit.path !== "events/operations.jsonl"
      || operation.files.some((file) => !isWikiMarkdownMutationPath(file.path))) {
      throw portError("PATH_OUTSIDE_PROJECT", 400, "Wiki path is outside the project", "The Wiki migration operation plan contains an unsafe target.");
    }
  }
}

function migrationChanges(artifacts: readonly PinnedMigrationArtifact[]): readonly FileChange[] {
  return artifacts.flatMap((artifact): FileChange[] => {
    if (artifact.baseText === artifact.proposedText) return [];
    const path = toProjectPath(artifact.path);
    if (!artifact.existed) {
      return [{
        kind: "create",
        path,
        beforeRevision: null,
        afterRevision: exactFileContentHash(artifact.proposedText),
        diff: canonicalFileDiff(path, null, artifact.proposedText),
      }];
    }
    if (artifact.proposedFileHash === null) {
      return [{
        kind: "delete",
        path,
        beforeRevision: exactFileContentHash(artifact.baseText),
        afterRevision: null,
        diff: deletionDiff(path, artifact.baseText),
      }];
    }
    return [{
      kind: "update",
      path,
      beforeRevision: exactFileContentHash(artifact.baseText),
      afterRevision: exactFileContentHash(artifact.proposedText),
      diff: canonicalFileDiff(path, artifact.baseText, artifact.proposedText),
    }];
  });
}

function deletionDiff(path: RepoRelativePath, before: string): string {
  const lines = before.endsWith("\n") ? before.slice(0, -1).split("\n") : before.split("\n");
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    "+++ /dev/null",
    `@@ -1,${before === "" ? 0 : lines.length} +0,0 @@`,
    ...lines.filter((_, index) => before !== "" || index > 0).map((line) => `-${line}`),
    "",
  ].join("\n");
}

function projectMigrationReport(
  report: EngineMigrationReport,
  applied: boolean,
): WikiMigrationReport {
  return {
    filesScanned: report.filesScanned,
    proposedByType: { ...report.entitiesByType },
    ...(applied ? { createdByType: { ...report.entitiesByType } } : {}),
    idsPreserved: report.idsPreserved.length,
    ...(applied ? { idsGenerated: report.idsGenerated.length } : {}),
    legacyEdges: { converted: report.edgesConverted, ambiguous: report.edgesAmbiguous },
    groundings: {
      preserved: report.groundingsPreserved + report.groundingsMoved,
      ambiguous: report.groundingsAmbiguous,
      unresolved: report.groundingsAmbiguous,
    },
    filesUnchanged: report.filesUnchanged.map(toProjectPath),
    diagnostics: report.diagnostics.map(projectDiagnostic),
  };
}

function maintenanceContext(context: OperationContext) {
  return {
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.reportProgress === undefined ? {} : {
      reportProgress: (progress: WikiMaintenanceProgress) => context.reportProgress!({
        phase: progress.phase,
        ...(progress.completed === undefined ? {} : { completed: progress.completed }),
        ...(progress.total === undefined ? {} : { total: progress.total }),
        message: maintenanceMessage(progress.phase),
      } satisfies IndexProgress),
    }),
  };
}

function maintenanceMessage(phase: string): string {
  return ({
    discover: "Discovering Wiki files",
    stage: "Preparing a candidate Wiki index",
    parse: "Parsing Wiki entities",
    resolve: "Resolving Wiki relationships",
    validate: "Validating the Wiki index",
    publish: "Publishing the Wiki index",
  } as Record<string, string>)[phase] ?? "Maintaining the Wiki index";
}

function toProjectPath(path: string): RepoRelativePath {
  const normalized = path.startsWith(".mex/") ? path : `.mex/${path}`;
  if (!isRepoRelativePath(normalized)) throw portError("INDEX_CORRUPT", 503, "Wiki path is unsafe", "The Wiki index contains an unsafe path.");
  return normalized;
}

function safeProjectPath(path: string | undefined): RepoRelativePath | undefined {
  if (path === undefined) return undefined;
  try {
    return toProjectPath(path);
  } catch {
    return undefined;
  }
}

function toScaffoldPath(path: string): RepoRelativePath {
  if (!isRepoRelativePath(path) || !path.startsWith(".mex/")) {
    throw portError("PATH_OUTSIDE_PROJECT", 400, "Wiki path is outside the project", "Wiki paths must be safe repository-relative paths below .mex/.");
  }
  const relative = path.slice(".mex/".length);
  if (!isRepoRelativePath(relative)) {
    throw portError("PATH_OUTSIDE_PROJECT", 400, "Wiki path is outside the project", "Wiki paths must be safe repository-relative paths below .mex/.");
  }
  return relative;
}

function readContainedArtifactRevision(
  scaffoldRoot: string,
  path: string,
  afterRead?: (path: string) => void,
): Revision | null {
  try {
    const absolute = resolve(scaffoldRoot, path);
    const root = realpathSync(scaffoldRoot);
    const target = realpathSync(absolute);
    const rel = relative(root, target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw portError("PATH_OUTSIDE_PROJECT", 400, "Wiki path is outside the project", "A Wiki artifact resolves outside .mex/.");
    }
    const before = lstatSync(absolute);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw portError("PATH_OUTSIDE_PROJECT", 400, "Wiki path is outside the project", "A Wiki artifact is not a contained regular file.");
    }
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const fd = openSync(target, constants.O_RDONLY | noFollow);
    try {
      const opened = fstatSync(fd);
      const after = lstatSync(absolute);
      if (!sameFileIdentity(before, opened) || !sameFileIdentity(opened, after)) {
        throw revisionConflict("A Wiki artifact changed while its revision was being observed.");
      }
      const maxBytes = path === "events/operations.jsonl"
        ? OPERATION_LOG_MAX_BYTES
        : WIKI_CORPUS_LIMITS.maxFileBytes;
      if (opened.size > maxBytes) {
        throw revisionConflict("A Wiki artifact exceeds the bounded revision-observation limit.");
      }
      const bytes = readBoundedArtifactBytes(fd, maxBytes);
      afterRead?.(path);
      const observedAfterRead = fstatSync(fd);
      const leafAfterRead = lstatSync(absolute);
      if (
        bytes.byteLength !== opened.size
        || !sameFileIdentity(opened, observedAfterRead)
        || !sameFileIdentity(observedAfterRead, leafAfterRead)
      ) {
        throw revisionConflict("A Wiki artifact changed while its revision was being observed.");
      }
      return exactFileContentHash(bytes);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof MexPortError) throw error;
    if (isMissingFilesystemEntry(error) && proveContainedArtifactAbsence(scaffoldRoot, path)) {
      return null;
    }
    throw revisionConflict("A Wiki artifact could not be observed safely.");
  }
}

/**
 * Consume at most one byte beyond the accepted artifact budget. A size check
 * before reading is not a bound: another process can grow the open file after
 * `fstat`, and `readFileSync(fd)` would then allocate for the new size. The
 * extra byte distinguishes exact-budget EOF from concurrent/oversized input
 * without ever retaining more than `maxBytes + 1` bytes.
 */
function readBoundedArtifactBytes(fd: number, maxBytes: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const bytesRead = readSync(fd, chunk, 0, chunk.byteLength, total);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maxBytes) {
    throw revisionConflict("A Wiki artifact exceeds the bounded revision-observation limit.");
  }
  return Buffer.concat(chunks, total);
}

/**
 * Treat `ENOENT` as absence only after binding the scaffold and the nearest
 * extant directory on both sides of a second leaf probe. A dangling symlink,
 * escaping/mutated ancestor, unreadable directory, and every non-ENOENT error
 * remain observation failures rather than silently becoming `null`.
 */
function proveContainedArtifactAbsence(scaffoldRoot: string, path: string): boolean {
  const root = resolve(scaffoldRoot);
  const target = resolve(root, path);
  const lexical = relative(root, target);
  if (lexical === "" || lexical.startsWith("..") || isAbsolute(lexical)) return false;

  try {
    const realRoot = realpathSync(root);
    const rootStats = lstatSync(realRoot);
    if (!rootStats.isDirectory()) return false;

    try {
      lstatSync(target);
      return false;
    } catch (error) {
      if (!isMissingFilesystemEntry(error)) return false;
    }

    let ancestor = dirname(target);
    let realAncestor: string;
    let ancestorStats: ReturnType<typeof lstatSync>;
    for (;;) {
      try {
        const declaredStats = lstatSync(ancestor);
        if (!declaredStats.isDirectory() || declaredStats.isSymbolicLink()) return false;
        realAncestor = realpathSync(ancestor);
        ancestorStats = lstatSync(realAncestor);
        break;
      } catch (error) {
        if (!isMissingFilesystemEntry(error)) return false;
        const parent = dirname(ancestor);
        if (parent === ancestor) return false;
        ancestor = parent;
      }
    }

    const ancestorRelative = relative(realRoot, realAncestor);
    if (ancestorRelative.startsWith("..") || isAbsolute(ancestorRelative)) return false;

    try {
      lstatSync(target);
      return false;
    } catch (error) {
      if (!isMissingFilesystemEntry(error)) return false;
    }

    const realRootAfter = realpathSync(root);
    const rootAfter = lstatSync(realRootAfter);
    const realAncestorAfter = realpathSync(ancestor);
    const ancestorAfter = lstatSync(realAncestorAfter);
    return realRootAfter === realRoot
      && sameFileIdentity(rootStats, rootAfter)
      && realAncestorAfter === realAncestor
      && sameFileIdentity(ancestorStats, ancestorAfter);
  } catch {
    return false;
  }
}

function isMissingFilesystemEntry(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function stableObservationTime(session: WikiContractReadSession): string {
  return session.status().indexedAt ?? session.observedAt;
}

function normalizeCodeLookupNodes(nodeIds: readonly string[]): readonly string[] {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0 || nodeIds.length > MAX_CODE_LOOKUP_NODES) {
    throw validationError(`Code→Knowledge lookup requires between 1 and ${MAX_CODE_LOOKUP_NODES} node IDs.`);
  }
  const normalized = [...new Set(nodeIds.map((node) => {
    if (typeof node !== "string"
      || node.length === 0
      || Buffer.byteLength(node, "utf8") > 256
      || /[\0-\x1f\x7f\\]/.test(node)) {
      throw validationError("Code→Knowledge lookup contains an invalid node ID.");
    }
    return node;
  }))];
  normalized.sort(compareCodePoints);
  return normalized;
}

function explicitMatchedNodes(
  groundings: readonly ContractGrounding[],
  requested: ReadonlySet<string>,
): readonly string[] {
  const matched = new Set<string>();
  for (const grounding of groundings) {
    if (requested.has(grounding.requestedNode)) matched.add(grounding.requestedNode);
  }
  return [...matched].sort(compareCodePoints);
}

interface NormalizedCurrentListRequest {
  readonly limit: number;
  readonly maxTokens?: number;
  readonly groundingHealth?: readonly GroundingHealth[];
  readonly engineRequest: Omit<WikiListRequest, "cursor" | "limit" | "maxTokens" | "groundingHealth">;
}

function normalizeCurrentListRequest(request: WikiListRequest): NormalizedCurrentListRequest {
  const normalize = (values: readonly string[] | undefined, field: string): readonly string[] | undefined => {
    if (values === undefined) return undefined;
    if (values.length === 0 || values.length > 100 || values.some((value) => typeof value !== "string" || value.length === 0)) {
      throw invalidRequest(`${field} must contain 1-100 nonempty values.`);
    }
    return [...new Set(values.map((value) => value.normalize("NFC")))].sort(compareCodePoints);
  };
  const grounding = normalize(request.groundingHealth, "groundingHealth") as GroundingHealth[] | undefined;
  if (grounding?.some((value) => !["fresh", "changed", "missing", "ambiguous", "unverified"].includes(value))) {
    throw invalidRequest("groundingHealth contains an unsupported value.");
  }
  const kinds = normalize(request.kinds, "kinds");
  const topics = normalize(request.topics, "topics") as EntityId[] | undefined;
  const lifecycleStates = normalize(request.lifecycleStates, "lifecycleStates") as WikiListRequest["lifecycleStates"];
  const sourceTypes = normalize(request.sourceTypes, "sourceTypes");
  const limit = strictRequestInteger(request.limit ?? 25, "limit", 1, 100);
  const maxTokens = request.maxTokens === undefined
    ? undefined
    : strictRequestInteger(request.maxTokens, "maxTokens", 64, 1_000_000);
  return {
    limit,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(grounding === undefined ? {} : { groundingHealth: grounding }),
    engineRequest: {
      ...(kinds === undefined ? {} : { kinds }),
      ...(topics === undefined ? {} : { topics }),
      ...(lifecycleStates === undefined ? {} : { lifecycleStates }),
      ...(sourceTypes === undefined ? {} : { sourceTypes }),
      includeArchived: request.includeArchived === true,
    },
  };
}

function normalizeCurrentSearchRequest(request: WikiQueryRequest): NormalizedCurrentListRequest & { query: string } {
  if (typeof request.query !== "string" || request.query.length > 256) {
    throw invalidRequest("Wiki search query must be at most 256 characters.");
  }
  return {
    ...normalizeCurrentListRequest(request),
    query: request.query.trim().normalize("NFC"),
  };
}

function currentProjectionRevision(
  session: WikiContractReadSession,
  graph: RepositoryWikiGroundingSnapshot | null,
): Revision {
  return hashCanonical({
    wiki: session.snapshotRevision,
    graph: graph === null ? "unavailable" : graph.revision,
  });
}

function assertGroundingSnapshotRevision(snapshot: RepositoryWikiGroundingSnapshot): void {
  if (typeof snapshot.revision !== "string"
    || snapshot.revision.length === 0
    || Buffer.byteLength(snapshot.revision, "utf8") > 256
    || /[\u0000-\u001f\u007f]/u.test(snapshot.revision)) {
    throw portError(
      "OPERATION_INTERRUPTED",
      409,
      "Graph read interrupted",
      "The Graph grounding snapshot did not provide a stable revision.",
    );
  }
}

/**
 * Search order. A `score` marks a hit that matched only some query terms
 * (#235): every unscored, all-terms hit comes first, then those by score.
 */
function compareCurrentSearchHits(left: WikiSearchHit, right: WikiSearchHit): number {
  const tier = Number(left.score !== undefined) - Number(right.score !== undefined);
  if (tier !== 0) return tier;
  const coverage = (right.score ?? 0) - (left.score ?? 0);
  if (coverage !== 0) return coverage;
  const leftField = left.matchedFields[0] ?? "body";
  const rightField = right.matchedFields[0] ?? "body";
  const field = MATCH_FIELD_RANK[leftField] - MATCH_FIELD_RANK[rightField];
  if (field !== 0) return field;
  const lifecycle = (LIFECYCLE_RANK[left.entity.lifecycleState] ?? 3)
    - (LIFECYCLE_RANK[right.entity.lifecycleState] ?? 3);
  if (lifecycle !== 0) return lifecycle;
  const health = healthRank(left.entity.groundingHealth) - healthRank(right.entity.groundingHealth);
  if (health !== 0) return health;
  const relevance = (left.relevance ?? 0) - (right.relevance ?? 0);
  if (relevance !== 0) return relevance;
  return compareCodePoints(left.entity.title, right.entity.title)
    || compareCodePoints(left.entity.ref.id, right.entity.ref.id);
}

function currentProjectionPage<T>(
  candidates: readonly T[],
  offset: number,
  limit: number,
  maxTokens: number | undefined,
  sourceTruncated: boolean,
  suppliedCursor: string | undefined,
  nextCursor: (offset: number) => string,
): WikiPage<T> {
  if (suppliedCursor !== undefined && offset >= candidates.length) {
    throw invalidRequest("The Wiki cursor offset is outside this current result set.");
  }
  const bounded = candidates.slice(offset, offset + limit);
  const items: T[] = [];
  let used = 0;
  for (const item of bounded) {
    const cost = Math.max(1, estimateTokens(item));
    if (maxTokens !== undefined && used + cost > maxTokens) break;
    items.push(item);
    used += cost;
  }
  if (items.length === 0 && bounded.length > 0) {
    throw invalidRequest("maxTokens is too small for the first bounded Wiki result.");
  }
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < candidates.length;
  const tokenTruncated = items.length < bounded.length;
  return {
    items,
    nextCursor: hasMore && items.length > 0 ? nextCursor(nextOffset) : null,
    estimatedTokens: estimateTokens(items),
    truncated: hasMore || tokenTruncated || sourceTruncated,
  };
}

function encodePrivateCursor(
  operation: string,
  indexedRevision: Revision,
  requestHash: Revision,
  offset: number,
): string {
  const encoded = Buffer.from(canonical({
    v: 1,
    operation,
    indexedRevision,
    requestHash,
    offset,
  }), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAX_CURSOR_BYTES) {
    throw invalidRequest("The Wiki cursor exceeds its safety bound.");
  }
  return encoded;
}

function decodePrivateCursor(
  cursor: string | undefined,
  operation: string,
  indexedRevision: Revision,
  requestHash: Revision,
): number {
  if (cursor === undefined) return 0;
  if (cursor.length === 0 || Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw invalidRequest("The Wiki cursor is invalid.");
  }
  let parsed: unknown;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error("non-canonical cursor");
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalidRequest("The Wiki cursor is invalid.");
  }
  if (!isPlainObject(parsed)
    || Object.keys(parsed).sort(compareCodePoints).join(",") !== "indexedRevision,offset,operation,requestHash,v"
    || parsed["v"] !== 1
    || parsed["operation"] !== operation
    || typeof parsed["requestHash"] !== "string"
    || typeof parsed["indexedRevision"] !== "string"
    || !Number.isInteger(parsed["offset"])
    || (parsed["offset"] as number) < 0
    || (parsed["offset"] as number) > MAX_COUNTED_ENTITIES) {
    throw invalidRequest("The Wiki cursor is invalid.");
  }
  if (parsed["requestHash"] !== requestHash) {
    throw invalidRequest("The Wiki cursor does not match this request.");
  }
  if (parsed["indexedRevision"] !== indexedRevision) {
    throw revisionConflict("The Wiki or Graph snapshot changed after this page was read.");
  }
  return parsed["offset"] as number;
}

function estimatePrivateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 4);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidOperationPreview(
  operationId: string,
  requestHash: Revision,
  diagnostics: readonly Diagnostic[],
): WikiOperationPreview<RepositoryWikiOperationPlan> {
  const plan: RepositoryWikiOperationPlan = { v: 1, valid: false, requestHash, diagnostics };
  return {
    operationId,
    plan,
    previewRevision: hashCanonical(plan),
    valid: false,
    changes: [],
    affectedEntities: [],
    validation: { valid: false, diagnostics },
  };
}

interface OperationAuditAuthority {
  readonly opId: string;
  readonly type: WikiOperationType;
  readonly payloadHash: Revision;
  readonly actor: WikiOperationRequest<RepositoryWikiOperationPayload>["operation"]["actor"];
  readonly timestamp: string;
  readonly reason?: string;
}

function operationItemId(operationId: string, index: number, itemCount: number): string {
  return itemCount === 1
    ? operationId
    : `${operationId}_item_${String(index + 1).padStart(2, "0")}`;
}

function operationAuditAuthority(
  request: WikiOperationRequest<RepositoryWikiOperationPayload>,
  item: NormalizedRepositoryOperation,
  index: number,
  itemCount: number,
): OperationAuditAuthority {
  return {
    opId: operationItemId(request.operation.opId, index, itemCount),
    type: item.type,
    payloadHash: payloadHashOf(item.type, item.payload),
    actor: request.operation.actor,
    timestamp: request.operation.timestamp,
    ...(request.operation.reason === undefined ? {} : { reason: request.operation.reason }),
  };
}

function matchesAuditAuthority(entry: AuditEntry, authority: OperationAuditAuthority): boolean {
  return validResumeIntent({ ...entry, phase: "intent" })
    && entry.opId === authority.opId
    && entry.type === authority.type
    && entry.payloadHash === authority.payloadHash
    && entry.actor.kind === authority.actor.kind
    && entry.actor.id === authority.actor.id
    && entry.sessionId === authority.actor.sessionId
    && entry.timestamp === authority.timestamp
    && entry.reason === authority.reason;
}

function validResumeIntent(entry: AuditEntry): boolean {
  if (!isPlainObject(entry)
    || !hasExactKeys(entry, [
      "actor",
      "createdIds",
      "entityIds",
      "files",
      "opId",
      "payloadHash",
      "phase",
      "revisions",
      "timestamp",
      "type",
      "v",
    ], ["reason", "sessionId"])
    || entry.v !== 1
    || entry.phase !== "intent"
    || typeof entry.opId !== "string"
    || entry.opId.length === 0
    || entry.opId.length > 256
    || !(WIKI_OPERATION_TYPES as readonly string[]).includes(entry.type)
    || !isExactRevision(entry.payloadHash)
    || !isPlainObject(entry.actor)
    || !hasExactKeys(entry.actor, ["id", "kind"])
    || !["human", "agent", "system"].includes(entry.actor.kind)
    || typeof entry.actor.id !== "string"
    || entry.actor.id.length === 0
    || entry.actor.id.length > 256
    || typeof entry.timestamp !== "string"
    || entry.timestamp.length > 64
    || (entry.reason !== undefined && (typeof entry.reason !== "string" || entry.reason.length > 4_096))
    || (entry.sessionId !== undefined && (typeof entry.sessionId !== "string" || entry.sessionId.length > 256))
    || !Array.isArray(entry.entityIds)
    || !Array.isArray(entry.createdIds)
    || !Array.isArray(entry.files)
    || !Array.isArray(entry.revisions)
    || entry.entityIds.length > 50
    || entry.createdIds.length > 25
    || entry.files.length > MAX_RECOVERY_MANIFEST_FILES
    || entry.revisions.length > 50
    || entry.entityIds.some((id) => !isEntityId(id))
    || entry.createdIds.some((id) => !isEntityId(id))
    || entry.files.some((path) => typeof path !== "string" || !isWikiMarkdownMutationPath(path))) {
    return false;
  }
  return entry.revisions.every((revision) => isPlainObject(revision)
    && hasExactKeys(revision, ["after", "before", "entityId"])
    && isEntityId(revision.entityId)
    && Number.isSafeInteger(revision.before)
    && Number.isSafeInteger(revision.after)
    && revision.before >= 0
    && revision.after >= 0);
}

function resumePlanIsSubset(plan: WikiPatchPlan, intent: AuditEntry): boolean {
  const authority: OperationAuditAuthority = {
    opId: plan.opId,
    type: plan.type,
    payloadHash: plan.payloadHash,
    actor: plan.actor,
    timestamp: plan.timestamp,
    ...(plan.reason === undefined ? {} : { reason: plan.reason }),
  };
  if (!matchesAuditAuthority(intent, authority)) return false;
  const recordedEntities = new Set(intent.entityIds);
  const recordedCreated = new Set(intent.createdIds);
  const recordedFiles = new Set(intent.files);
  return plan.entityIds.every((id) => recordedEntities.has(id))
    && plan.createdIds.every((id) => recordedCreated.has(id))
    && plan.files.every((file) => recordedFiles.has(file.path))
    && plan.revisions.every((revision) => intent.revisions.some((recorded) => (
      recorded.entityId === revision.entityId
      && recorded.before === revision.before
      && recorded.after === revision.after
    )));
}

function recoveryMismatch(
  operationIds: readonly string[],
  reason: Extract<RepositoryWikiOperationRecoveryInspection, { state: "mismatch" }>["reason"],
  exact: { readonly text: string; readonly exists: boolean } = { text: "", exists: false },
): OperationRecoveryAnalysis {
  return {
    inspection: { schemaVersion: 1, state: "mismatch", operationIds, reason },
    exactText: exact.text,
    exactExists: exact.exists,
    intent: null,
  };
}

function operationRecoveryManifest(
  operationId: string,
  requestHash: Revision,
  plan: WikiOperationBatchPlan,
): RepositoryWikiOperationRecoveryManifest {
  let fileCount = 0;
  const manifest: RepositoryWikiOperationRecoveryManifest = {
    schemaVersion: 1,
    requestHash,
    operationId,
    items: plan.operations.map((operation) => ({
      operationId: operation.opId,
      type: operation.type,
      payloadHash: operation.payloadHash,
      createdIds: operation.createdIds,
      files: operation.files.map((file) => {
        fileCount += 1;
        return {
          path: toProjectPath(file.path),
          beforeRevision: file.existed ? exactFileContentHash(file.baseText) : null,
          afterRevision: exactFileContentHash(file.proposedText),
        };
      }),
      revisions: operation.revisions.map((revision) => ({
        entityId: revision.entityId,
        before: revision.before,
        after: revision.after,
      })),
      audit: {
        beforeRevision: operation.audit.baseFileHash,
        afterRevision: exactFileContentHash(operation.audit.proposedText),
      },
    })),
  };
  if (fileCount > MAX_RECOVERY_MANIFEST_FILES
    || Buffer.byteLength(JSON.stringify(manifest), "utf8") > MAX_RECOVERY_MANIFEST_BYTES) {
    throw validationError("The Wiki recovery manifest exceeds its fixed release bounds.");
  }
  return manifest;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...required, ...optional.filter((key) => value[key] !== undefined)].sort();
  return canonical(keys) === canonical(expected) && required.every((key) => key in value);
}

function isExactRevision(value: unknown): value is Revision {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

interface NormalizedRepositoryOperation {
  readonly type: WikiOperationType;
  readonly entityId?: EntityId;
  readonly payload: JsonValue;
}

function normalizeRepositoryOperations(
  operation: WikiOperationRequest<RepositoryWikiOperationPayload>["operation"],
): readonly NormalizedRepositoryOperation[] {
  if (!isPlainObject(operation.payload)
    || !Array.isArray(operation.payload["operations"])) {
    return [{
      type: operation.type,
      ...(operation.entityId === undefined ? {} : { entityId: operation.entityId }),
      payload: operation.payload,
    }];
  }
  const raw = operation.payload["operations"];
  if (raw.length === 0 || raw.length > 25) {
    throw validationError("A Wiki operation batch must contain between 1 and 25 ordered operations.");
  }
  return raw.map((item) => normalizeRepositoryOperationItem(item));
}

function normalizeForcedCreatedIds(
  request: WikiOperationRequest<RepositoryWikiOperationPayload>,
  items: readonly NormalizedRepositoryOperation[],
  createdIds: readonly EntityId[],
): readonly EngineEntityId[] {
  if (!Array.isArray(createdIds)
    || createdIds.length !== 1
    || !isEntityId(createdIds[0])
    || !createdIds[0].startsWith("mx_")) {
    throw validationError("A receipt-bound Wiki create requires exactly one canonical mx entity ID.");
  }
  if (items.length !== 1
    || items[0]?.type !== "create-entry"
    || items[0].entityId !== undefined
    || request.operation.entityId !== undefined
    || (isPlainObject(request.operation.payload)
      && Array.isArray(request.operation.payload["operations"]))) {
    throw validationError("Receipt-bound Wiki preview accepts exactly one direct create-entry operation.");
  }
  return [createdIds[0] as EngineEntityId];
}

function normalizeRepositoryOperationItem(value: unknown): NormalizedRepositoryOperation {
  if (!isPlainObject(value)
    || typeof value["type"] !== "string"
    || !(WIKI_OPERATION_TYPES as readonly string[]).includes(value["type"])) {
    throw validationError("A Wiki operation batch contains an invalid operation item.");
  }
  const type = value["type"] as WikiOperationType;
  if (type === "update-entry" && !("payload" in value)) {
    return {
      type,
      ...(typeof value["entityId"] === "string" ? { entityId: value["entityId"] } : {}),
      payload: {
        ...(value["title"] === undefined ? {} : { title: value["title"] as JsonValue }),
        ...(value["summary"] === undefined ? {} : { summary: value["summary"] as JsonValue }),
        ...(value["body"] === undefined ? {} : { body: value["body"] as JsonValue }),
        ...(value["appendSources"] === undefined ? {} : { appendSources: value["appendSources"] as JsonValue }),
      },
    };
  }
  if (type === "add-relation" && !("payload" in value)) {
    const relation = value["relation"];
    const source = isPlainObject(relation) ? relation["source"] : undefined;
    const target = isPlainObject(relation) ? relation["target"] : undefined;
    if (!isPlainObject(relation)
      || !isPlainObject(source)
      || !isPlainObject(target)
      || typeof source["id"] !== "string"
      || typeof target["id"] !== "string"
      || typeof relation["type"] !== "string") {
      throw validationError("A Wiki add-relation batch item is invalid.");
    }
    return {
      type,
      entityId: source["id"],
      payload: {
        relation: {
          type: relation["type"],
          target: target["id"],
          ...(relation["note"] === undefined ? {} : { note: relation["note"] as JsonValue }),
          ...(relation["metadata"] === undefined ? {} : { metadata: relation["metadata"] as JsonValue }),
        },
      },
    };
  }
  if (type === "move-entry" && !("payload" in value)) {
    return {
      type,
      ...(typeof value["entityId"] === "string" ? { entityId: value["entityId"] } : {}),
      payload: {
        file: value["destinationPath"] as JsonValue,
        insertAt: (value["insertAt"] ?? { at: "end-of-file" }) as JsonValue,
      },
    };
  }
  if (!("payload" in value)) {
    throw validationError("This Wiki batch operation requires an explicit engine payload.");
  }
  return {
    type,
    ...(typeof value["entityId"] === "string" ? { entityId: value["entityId"] } : {}),
    payload: value["payload"] as JsonValue,
  };
}

function assertOperationPayloadPaths(items: readonly NormalizedRepositoryOperation[]): void {
  for (const operation of items) {
    if ((operation.type !== "move-entry" && operation.type !== "create-entry")
      || !isPlainObject(operation.payload)) continue;
    const file = operation.payload["file"];
    if (typeof file !== "string" || !isRepoRelativePath(file)) {
      throw portError(
        "PATH_OUTSIDE_PROJECT",
        400,
        "Wiki path is outside the project",
        "The Wiki operation contains an unsafe destination path.",
      );
    }
  }
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function strictInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw validationError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function strictRequestInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalidRequest(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function optionalMetadata(
  value: Readonly<Record<string, unknown>> | undefined,
): { metadata?: Readonly<Record<string, JsonValue>> } {
  if (value === undefined) return {};
  const bounded = boundedJson(value, 0);
  return bounded !== undefined && bounded !== null && typeof bounded === "object" && !Array.isArray(bounded)
    ? { metadata: bounded as Readonly<Record<string, JsonValue>> }
    : {};
}

function boundedJson(value: unknown, depth: number): JsonValue | undefined {
  if (depth > 4) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.length <= 4096 ? value : undefined;
  if (Array.isArray(value)) {
    if (value.length > 50) return undefined;
    const items = value.map((entry) => boundedJson(entry, depth + 1));
    return items.some((entry) => entry === undefined) ? undefined : items as JsonValue[];
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 50) return undefined;
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of entries) {
    if (key.length > 128 || key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
    const projected = boundedJson(entry, depth + 1);
    if (projected === undefined) return undefined;
    result[key] = projected;
  }
  return result;
}

function isWikiMarkdownMutationPath(path: string): boolean {
  return isRepoRelativePath(path) && /\.mdx?$/i.test(path);
}

function sameFileIdentity(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function hashCanonical(value: unknown): Revision {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function rememberOpaquePlan<T>(registry: Map<string, T>, handle: string, value: T): void {
  if (registry.has(handle)) registry.delete(handle);
  registry.set(handle, value);
  while (registry.size > MAX_OPAQUE_PLANS) {
    const oldest = registry.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    registry.delete(oldest);
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function sanitizeMessage(message: string): string {
  const bounded = message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512);
  return containsLocalPath(bounded)
    ? "Wiki diagnostic detail was withheld because it contained a local path."
    : bounded;
}

function containsLocalPath(value: string): boolean {
  if (/\bfile:(?:\/\/)?(?:\/|[A-Za-z]:[\\/]|\\\\)/iu.test(value)) return true;
  const withoutUrls = value.replace(/\bhttps?:\/\/[^\s"'`]+/giu, "");
  return /(?:^|[^A-Za-z0-9/])\/(?!\/)/u.test(withoutUrls)
    || /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/u.test(withoutUrls)
    || /(?:^|[^\\])\\\\[^\\]/u.test(withoutUrls);
}

function pathDiagnostic(diagnostics: readonly WikiDiagnostic[]): MexPortError | null {
  return diagnostics.some((entry) => entry.code === "PATH_OUTSIDE_SCAFFOLD" || entry.code === "WRITE_SCOPE_VIOLATION")
    ? portError("PATH_OUTSIDE_PROJECT", 400, "Wiki path is outside the project", "The Wiki operation contains an unsafe path.")
    : null;
}

function isGraphBridgeUnavailable(error: unknown): boolean {
  return error instanceof MexPortError && new Set<MexErrorCode>([
    "INDEX_MISSING",
    "INDEX_STALE",
    "MIGRATION_REQUIRED",
    "INDEX_CORRUPT",
    "OPERATION_INTERRUPTED",
    "REVISION_CONFLICT",
  ]).has(error.problem.code);
}

function translateReadError(error: unknown, status: ContractWikiIndexStatus): MexPortError {
  if (error instanceof MexPortError) return error;
  if (error instanceof WikiContractReadError) {
    if (error.code === "INVALID_REQUEST") {
      return portError("INVALID_REQUEST", 400, "Wiki request invalid", "The Wiki read request is invalid.");
    }
    if (error.code === "NOT_FOUND") {
      return portError("NOT_FOUND", 404, "Wiki entity not found", "The requested Wiki entity does not exist.");
    }
    if (error.code === "REVISION_CONFLICT") return revisionConflict("The Wiki index changed during the read.");
    return indexError(status);
  }
  return portError("INTERNAL_ERROR", 500, "Wiki read failed", "The Wiki read could not be completed safely.");
}

function translateWriteError(error: unknown): MexPortError {
  if (error instanceof MexPortError) return error;
  if (error instanceof SimulatedWikiCrashError) {
    return portError(
      "OPERATION_INTERRUPTED",
      409,
      "Wiki operation interrupted",
      "The Wiki operation was interrupted after a durable recovery boundary.",
    );
  }
  if (error instanceof MigrationSelectionError) {
    return validationError("The Wiki migration selection is invalid.");
  }
  if (error instanceof WikiMaintenanceInterruptedError || error instanceof WikiMaintenanceLockedError) {
    return portError("OPERATION_INTERRUPTED", 409, "Wiki operation interrupted", "The Wiki operation could not acquire or retain its maintenance boundary.");
  }
  return portError("INTERNAL_ERROR", 500, "Wiki write failed", "The Wiki write could not be completed safely.");
}

function translateMaintenanceError(error: unknown): MexPortError {
  if (error instanceof MexPortError) return error;
  if (error instanceof WikiMaintenanceInterruptedError || error instanceof WikiMaintenanceLockedError) {
    return portError("OPERATION_INTERRUPTED", 409, "Wiki maintenance interrupted", "The Wiki maintenance operation was interrupted safely.");
  }
  return portError("INTERNAL_ERROR", 500, "Wiki maintenance failed", "The Wiki index could not be maintained safely.");
}

function errorForDiagnostics(diagnostics: readonly WikiDiagnostic[], detail: string): MexPortError {
  const path = pathDiagnostic(diagnostics);
  if (path) return path;
  const projected = diagnostics.map(projectDiagnostic);
  if (diagnostics.some((entry) => entry.code === "CONTENT_HASH_CONFLICT" || entry.code === "REVISION_CONFLICT")) {
    return revisionConflict("The Wiki changed after the operation was reviewed.", projected);
  }
  if (diagnostics.some((entry) => entry.code === "ENTITY_NOT_FOUND")) {
    return portError("NOT_FOUND", 404, "Wiki entity not found", "The Wiki operation target does not exist.", projected);
  }
  return validationError(detail, projected);
}

function indexError(status: ContractWikiIndexStatus): MexPortError {
  switch (status.state) {
    case "missing":
      return portError("INDEX_MISSING", 503, "Wiki index missing", "The Wiki index has not been built.");
    case "migration_required":
      return portError("MIGRATION_REQUIRED", 503, "Wiki index migration required", "The Wiki index was created by a newer incompatible schema.");
    case "stale":
      return portError("INDEX_STALE", 409, "Wiki index stale", "The Wiki index does not match the canonical Wiki files.");
    case "degraded":
      return portError("OPERATION_INTERRUPTED", 503, "Wiki index unavailable", "The Wiki index cannot be observed safely while another operation is active.");
    case "corrupt":
    case "rebuild_required":
    case "fresh":
      return portError("INDEX_CORRUPT", 503, "Wiki index corrupt", "The Wiki index cannot be read safely and requires an explicit rebuild.");
  }
}

function validationError(detail: string, diagnostics?: readonly Diagnostic[]): MexPortError {
  return portError("VALIDATION_FAILED", 400, "Wiki validation failed", detail, diagnostics);
}

function invalidRequest(detail: string, diagnostics?: readonly Diagnostic[]): MexPortError {
  return portError("INVALID_REQUEST", 400, "Wiki request invalid", detail, diagnostics);
}

function revisionConflict(detail: string, diagnostics?: readonly Diagnostic[]): MexPortError {
  return portError("REVISION_CONFLICT", 409, "Wiki revision conflict", detail, diagnostics);
}

function portError(
  code: MexErrorCode,
  status: number,
  title: string,
  detail: string,
  diagnostics?: readonly Diagnostic[],
): MexPortError {
  const problem: ProblemDetails = {
    code,
    status,
    title,
    detail,
    ...(diagnostics === undefined || diagnostics.length === 0 ? {} : { diagnostics }),
  };
  return new MexPortError(problem);
}
