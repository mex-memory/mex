/**
 * Adapter-facing Wiki read session.
 *
 * This is deliberately an engine API rather than an application contract: it
 * does not import `WikiPort`, HTTP schemas, or Hub types. It gives the adapter
 * one immutable index snapshot, complete projections, strict revision-bound
 * cursors, and a final validation hook. No method refreshes or rebuilds.
 */

import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { openSqlite, type SqliteDatabase } from "../../graph/db/sqlite.js";
import {
  diagnostic,
  isWikiDiagnosticCode,
  type WikiDiagnostic,
} from "../model/diagnostic.js";
import { indexedCorpusRevision, exactFileContentHash, isContentHash } from "../model/hash.js";
import type { GroundingHealth } from "../model/grounding.js";
import { isEntityId } from "../model/ids.js";
import { discoverMarkdownFiles, insideRoot } from "../index/discover.js";
import {
  WIKI_CORPUS_LIMITS,
  WikiCorpusLimitError,
  addWikiCorpusBytes,
} from "../index/corpus-policy.js";
import { readContainedSource } from "../index/source-read.js";
import { WIKI_META_KEYS, WIKI_SCHEMA_VERSION, WIKI_TABLES } from "../index/schema.js";
import { fts5UnavailableDiagnostic } from "../index/fts5.js";
import { isTeamOwnedReadOnlyPath } from "../model/team-owned-paths.js";
import { estimateTokens } from "./budget.js";
import { healthRank, LIFECYCLE_RANK, MATCH_FIELD_RANK, type MatchField } from "./rank.js";
import { findSomeTermsMatches, planWikiSearch } from "./search-plan.js";
import type { SearchMatch } from "./session.js";

const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;
const MAX_CURSOR_BYTES = 4096;
const MAX_SEARCH_RESULTS = 500;
const MAX_RELATIONS_PER_ENTITY = 200;
const MIN_TOKEN_BUDGET = 64;

export type ContractWikiIndexState =
  | "missing"
  | "fresh"
  | "stale"
  | "degraded"
  | "rebuild_required"
  | "corrupt"
  | "migration_required";

export interface ContractWikiIndexStatus {
  state: ContractWikiIndexState;
  observedAt: string;
  schemaVersion: number | null;
  indexedRevision: string | null;
  indexedAt: string | null;
  diagnostics: readonly WikiDiagnostic[];
}

export interface InspectWikiIndexOptions {
  scaffoldRoot: string;
  indexPath?: string;
  exclude?: readonly string[];
  now?: () => string;
  /** Deterministic race seam used by the ABA regression only. */
  hooks?: {
    afterInitialIndexBind?: () => void;
    /** @internal Deterministic canonical-corpus race seam. */
    afterInitialStatusInspection?: () => void;
    /** @internal Deterministic sidecar-probe failure seam. */
    beforeSidecarStat?: (path: string) => void;
    /** @internal Deterministic immutable-open failure seam. */
    beforeSessionImmutableOpen?: () => void;
    /** @internal Descriptor cleanup observation seam. */
    afterIndexDescriptorClose?: () => void;
  };
}

export interface ContractSourceLocation {
  path: string;
  metadataStart: number;
  metadataEnd: number;
  headingStart: number;
  headingEnd: number;
  bodyStart: number;
  bodyEnd: number;
  startLine: number;
  endLine: number;
  headingDepth: number;
}

export interface ContractEntitySummary {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  lifecycleState: string;
  semanticRevision: number;
  /** SHA-256 of exact containing-file bytes. */
  fileContentHash: string;
  entityContentHash: string;
  location: ContractSourceLocation;
  groundingHealth: GroundingHealth;
  topics: readonly string[];
  sourceTypes: readonly string[];
  diagnostics: readonly WikiDiagnostic[];
}

export interface ContractRelationRef {
  type: string;
  targetId: string;
  note?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ContractRelation {
  type: string;
  source: { id: string; type: string; title: string };
  target: { id: string; type?: string; title?: string };
  note?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ContractSource {
  type: string;
  ref?: string;
  note?: string;
  repository?: string;
  commit?: string;
  capturedAt?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ContractProvenance {
  createdBy: { kind: "human" | "agent" | "system"; id: string };
  createdAt?: string;
  lastModifiedBy?: { kind: "human" | "agent" | "system"; id: string };
  lastModifiedAt?: string;
  agentSessionId?: string;
}

export interface ContractGrounding {
  requestedNode: string;
  fingerprint: string;
  bodyHash?: string;
  codeHash?: string;
  file?: string;
  commit?: string;
  verifiedAt?: string;
  reason?: string;
  observedAt: string;
  resolution: Readonly<Record<string, unknown>> | null;
}

export interface ContractEntity extends ContractEntitySummary {
  /** @internal Exact stored row fields used for source-bound authoring attestation. */
  indexRow: {
    entityKey: string;
    metadataKind: "frontmatter" | "comment";
    provenance: string | null;
    metadata: string | null;
  };
  body: string;
  relations: readonly ContractRelationRef[];
  backlinks: readonly ContractRelation[];
  sources: readonly ContractSource[];
  provenance?: ContractProvenance;
  groundings: readonly ContractGrounding[];
}

export interface ContractListRequest {
  cursor?: string;
  limit?: number;
  kinds?: readonly string[];
  topics?: readonly string[];
  lifecycleStates?: readonly string[];
  groundingHealth?: readonly GroundingHealth[];
  sourceTypes?: readonly string[];
  includeArchived?: boolean;
  maxTokens?: number;
}

export interface ContractSearchRequest extends ContractListRequest {
  query: string;
}

export interface ContractSearchHit {
  entity: ContractEntitySummary;
  matchedFields: readonly MatchField[];
  /** Every query term, or only some of them (#235); see `search-plan.ts`. */
  match: SearchMatch;
  /** For a `some_terms` hit: the query terms it matched, in query order. */
  matchedTerms?: readonly string[];
  /** For a `some_terms` hit: its coverage of the query, higher first. Never comparable across indexes. */
  score?: number;
  /**
   * FTS5 `bm25()`, lower first: in its best matched field for an `all_terms`
   * hit, over every field for a `some_terms` hit (the tie-break after score).
   */
  relevance?: number;
}

export interface ContractRelationRequest {
  entityId: string;
  direction: "outgoing" | "incoming" | "both";
  relationTypes?: readonly string[];
  includeArchived?: boolean;
  cursor?: string;
  limit?: number;
  maxTokens?: number;
}

export interface ContractRelationHit {
  relation: ContractRelation;
  direction: "outgoing" | "incoming";
  entity: ContractEntitySummary | null;
}

export interface ContractNeighborhoodRequest {
  entityId: string;
  direction?: "outgoing" | "incoming" | "both";
  relationTypes?: readonly string[];
  depth: number;
  maxEntities: number;
  maxTokens: number;
  includeArchived?: boolean;
}

export interface ContractNeighborhood {
  root: ContractEntitySummary;
  entities: readonly ContractEntitySummary[];
  relations: readonly ContractRelation[];
  estimatedTokens: number;
  truncated: boolean;
}

export interface ContractPage<T> {
  items: readonly T[];
  /** More ordinary pages exist under this exact request and revision. */
  nextCursor: string | null;
  estimatedTokens: number;
  /** Any paging, safety, or token bound omitted content from this response. */
  truncated: boolean;
}

export interface ContractReadValidation {
  valid: boolean;
  status: ContractWikiIndexStatus;
}

/**
 * Package-private freshness proof for governed authoring. Team-owned Markdown
 * participates in the ordinary Wiki corpus, but cannot invalidate an exact
 * read of Wiki-owned canonical bytes merely because Team published it.
 */
export interface ContractAuthoringCorpusAttestation {
  containmentSafe: boolean;
  wikiOwnedFresh: boolean;
  /** Stored error diagnostics must be confined to Team-owned source files. */
  wikiOwnedDiagnosticsHealthy: boolean;
  teamOwnedDrift: boolean;
  wikiOwnedRevision: string;
  /** Exact full inventory used to bind current claimant source bytes. */
  allFiles: readonly { path: string; contentHash: string }[];
  /** Wiki-owned subset compared to the disposable index. */
  files: readonly { path: string; contentHash: string }[];
}

export interface ContractDiagnosticRequest {
  entityIds?: readonly string[];
  paths?: readonly string[];
  limit?: number;
}

export interface ContractDiagnosticValidation {
  /** Validity is computed over every matching diagnostic, not the returned page. */
  valid: boolean;
}

export type ContractSearchCandidateRequest = Omit<
  ContractSearchRequest,
  "cursor" | "limit" | "maxTokens" | "groundingHealth"
>;

export interface ContractSearchCandidates {
  items: readonly ContractSearchHit[];
  truncated: boolean;
}

export class WikiContractReadError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "NOT_FOUND" | "REVISION_CONFLICT" | "INDEX_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "WikiContractReadError";
  }
}

export interface WikiContractReadSession {
  readonly indexedRevision: string;
  /** Exact immutable index generation, including derived grounding state. */
  readonly snapshotRevision: string;
  readonly observedAt: string;
  status(): ContractWikiIndexStatus;
  get(id: string): ContractEntity | null;
  list(request?: ContractListRequest): ContractPage<ContractEntitySummary>;
  search(request: ContractSearchRequest): ContractPage<ContractSearchHit>;
  /** Package-private pre-health candidate set for current Graph projection. */
  searchCandidates(request: ContractSearchCandidateRequest): ContractSearchCandidates;
  /** Exact added, modified, and deleted canonical paths under this read snapshot. */
  refreshPaths(): readonly string[];
  /** @internal Exact Wiki-owned inventory under this immutable index lease. */
  authoringCorpusAttestation(): ContractAuthoringCorpusAttestation;
  relations(request: ContractRelationRequest): ContractPage<ContractRelationHit>;
  backlinks(request: Omit<ContractRelationRequest, "direction">): ContractPage<ContractRelation>;
  neighborhood(request: ContractNeighborhoodRequest): ContractNeighborhood;
  groundingStatus(id: string): readonly ContractGrounding[] | null;
  diagnostics(request?: number | ContractDiagnosticRequest): ContractPage<WikiDiagnostic>;
  diagnosticValidation(request?: Omit<ContractDiagnosticRequest, "limit">): ContractDiagnosticValidation;
  validate(): ContractReadValidation;
  close(): void;
}

interface EntityRow {
  entity_key: string;
  id: string;
  type: string;
  title: string;
  summary: string | null;
  body: string;
  status: string;
  revision: number;
  file: string;
  metadata_start: number;
  metadata_end: number;
  heading_start: number;
  heading_end: number;
  body_start: number;
  body_end: number;
  start_line: number;
  end_line: number;
  heading_depth: number;
  file_content_hash: string;
  entity_content_hash: string;
  metadata_kind: "frontmatter" | "comment";
  provenance: string | null;
  metadata: string | null;
}

interface CursorPayload {
  v: 1;
  operation: string;
  indexedRevision: string;
  requestHash: string;
  offset: number;
}

interface BoundIndex {
  path: string;
  identity: string;
  digest: string;
  close(): void;
}

interface CorpusObservation {
  revision: string;
  files: readonly { path: string; contentHash: string }[];
  diagnostics: WikiDiagnostic[];
  stable: boolean;
}

interface ContractSidecarProbe {
  state: "clear" | "active" | "unavailable";
  paths: readonly string[];
}

const ENTITY_COLUMNS = [
  "e.entity_key", "e.id", "e.type", "e.title", "e.summary", "e.body", "e.status", "e.revision", "e.file",
  "e.metadata_start", "e.metadata_end", "e.heading_start", "e.heading_end", "e.body_start", "e.body_end",
  "e.start_line", "e.end_line", "e.heading_depth", "e.file_content_hash", "e.entity_content_hash",
  "e.metadata_kind", "e.provenance", "e.metadata",
].join(", ");

/** Inspect exact index/corpus state without creating or changing either. */
export function inspectWikiContractIndex(options: InspectWikiIndexOptions): ContractWikiIndexStatus {
  const observedAt = (options.now ?? (() => new Date().toISOString()))();
  const scaffoldRoot = canonicalRoot(options.scaffoldRoot);
  const indexPath = resolveIndexPath(scaffoldRoot, options.indexPath, options.scaffoldRoot);
  if (indexPath === null) {
    return status("corrupt", observedAt, null, null, null, [
      diagnostic("PATH_OUTSIDE_SCAFFOLD", "The wiki index path is outside the scaffold."),
    ]);
  }

  let bound: BoundIndex;
  try {
    bound = bindIndex(indexPath, options.hooks?.afterIndexDescriptorClose);
  } catch (error) {
    if (error instanceof WikiCorpusLimitError) {
      return status("degraded", observedAt, null, null, null, [
        diagnostic(
          "WIKI_PARSE_ERROR",
          "The disposable Wiki index corpus exceeds MEX's bounded inspection policy.",
          { remediation: "Narrow the canonical Wiki corpus before rebuilding the index." },
        ),
      ]);
    }
    const missing = isMissing(error);
    let legacy = false;
    if (missing) {
      try {
        legacy = hasLegacyInventory(scaffoldRoot, options.exclude);
      } catch (legacyError) {
        if (legacyError instanceof WikiCorpusLimitError) {
          return status("degraded", observedAt, null, null, null, [
            diagnostic(
              "WIKI_PARSE_ERROR",
              "The canonical Wiki corpus exceeds MEX's bounded inspection policy.",
              { remediation: "Narrow wiki.exclude or the canonical Wiki corpus before retrying inspection." },
            ),
          ]);
        }
        throw legacyError;
      }
    }
    return status(legacy ? "migration_required" : missing ? "missing" : "corrupt", observedAt, null, null, null, [
      diagnostic(
        legacy || !missing ? "WIKI_INDEX_REBUILD_REQUIRED" : "WIKI_INDEX_MISSING",
        legacy
          ? "Legacy Wiki documents require an explicit migration before indexing."
          : missing ? "The wiki index is missing." : "The wiki index is not a stable regular file.",
      ),
    ]);
  }

  let db: SqliteDatabase | null = null;
  try {
    const sidecars = inspectIndexSidecars(indexPath, options.hooks?.beforeSidecarStat);
    if (sidecars.state !== "clear") {
      return status("degraded", observedAt, null, null, null, [
        diagnostic(
          "WIKI_INDEX_REBUILD_REQUIRED",
          sidecars.state === "active"
            ? "Wiki index writer activity is in progress; immutable inspection was skipped."
            : "Wiki index recovery state could not be inspected safely; immutable inspection was skipped.",
        ),
      ]);
    }
    // The index answers searches through `wiki_fts`, so a Node whose SQLite
    // lacks FTS5 cannot read it even though the file is intact (issue #110).
    // Degraded, not corrupt: nothing is wrong with the store, and no rebuild
    // on this Node would improve matters.
    const fts5 = fts5UnavailableDiagnostic(bound.path);
    if (fts5) return status("degraded", observedAt, null, null, null, [fts5]);

    db = openSqlite(bound.path, { readOnly: true, immutable: true });
    const schemaVersion = readSchemaVersion(db);
    if (schemaVersion === null) {
      return status("corrupt", observedAt, null, null, null, [
        diagnostic("WIKI_INDEX_REBUILD_REQUIRED", "The wiki index metadata is missing or unreadable."),
      ]);
    }
    if (schemaVersion !== WIKI_SCHEMA_VERSION) {
      return revalidateObservedStatus(indexPath, bound, status(
        schemaVersion > WIKI_SCHEMA_VERSION ? "migration_required" : "rebuild_required",
        observedAt,
        schemaVersion,
        null,
        readMeta(db, WIKI_META_KEYS.builtAt),
        [diagnostic("WIKI_INDEX_REBUILD_REQUIRED", "The wiki index schema is incompatible with this build.")],
      ));
    }

    const structureProblem = validateIndexStructure(db);
    if (structureProblem !== null) {
      return revalidateObservedStatus(indexPath, bound, status("corrupt", observedAt, schemaVersion, null, null, [
        diagnostic("WIKI_INDEX_REBUILD_REQUIRED", structureProblem),
      ]));
    }

    const indexedRevision = readMeta(db, WIKI_META_KEYS.indexedRevision);
    const indexedAt = readMeta(db, WIKI_META_KEYS.builtAt);
    const files = db.prepare(
      `SELECT path, content_hash FROM wiki_files
       ORDER BY path LIMIT ${WIKI_CORPUS_LIMITS.maxMarkdownFiles + 1}`,
    ).all() as { path: string; content_hash: string }[];
    const recomputed = indexedCorpusRevision(files.map((file) => ({
      path: file.path,
      contentHash: file.content_hash,
    })));
    if (indexedRevision === null
      || files.length > WIKI_CORPUS_LIMITS.maxMarkdownFiles
      || recomputed !== indexedRevision) {
      return revalidateObservedStatus(indexPath, bound, status("corrupt", observedAt, schemaVersion, indexedRevision, indexedAt, [
        diagnostic("WIKI_INDEX_REBUILD_REQUIRED", "The wiki index corpus revision is invalid."),
      ]));
    }

    const corpus = observeCorpus(scaffoldRoot, options.exclude);
    const storedDiagnostics = readDiagnostics(db, 101);
    const diagnostics = [...corpus.diagnostics, ...storedDiagnostics.slice(0, 100)];
    if (!corpus.stable) return revalidateObservedStatus(
      indexPath,
      bound,
      status("degraded", observedAt, schemaVersion, indexedRevision, indexedAt, diagnostics),
    );
    if (corpus.revision !== indexedRevision) return revalidateObservedStatus(
      indexPath,
      bound,
      status("stale", observedAt, schemaVersion, indexedRevision, indexedAt, diagnostics),
    );
    if (storedDiagnostics.some((entry) => entry.severity === "error")) {
      return revalidateObservedStatus(
        indexPath,
        bound,
        status("degraded", observedAt, schemaVersion, indexedRevision, indexedAt, diagnostics),
      );
    }
    return revalidateObservedStatus(
      indexPath,
      bound,
      status("fresh", observedAt, schemaVersion, indexedRevision, indexedAt, diagnostics),
    );
  } catch (error) {
    if (error instanceof WikiCorpusLimitError) {
      return status("degraded", observedAt, null, null, null, [
        diagnostic(
          "WIKI_PARSE_ERROR",
          "The canonical Wiki corpus exceeds MEX's bounded inspection policy.",
          { remediation: "Narrow wiki.exclude or the canonical Wiki corpus before retrying inspection." },
        ),
      ]);
    }
    return status("corrupt", observedAt, null, null, null, [
      diagnostic("WIKI_INDEX_REBUILD_REQUIRED", "The wiki index could not be inspected safely."),
    ]);
  } finally {
    db?.close();
    bound.close();
  }
}

/** Open one inode-bound immutable session. The caller must invoke `validate`. */
export function openWikiContractReadSession(options: InspectWikiIndexOptions): WikiContractReadSession {
  const scaffoldRoot = canonicalRoot(options.scaffoldRoot);
  const indexPath = resolveIndexPath(scaffoldRoot, options.indexPath, options.scaffoldRoot);
  if (indexPath === null
    || inspectIndexSidecars(indexPath, options.hooks?.beforeSidecarStat).state !== "clear") {
    throw new WikiContractReadError("INDEX_UNAVAILABLE", "Wiki index is not safe for an immutable read.");
  }
  let bound: BoundIndex;
  try {
    bound = bindIndex(indexPath, options.hooks?.afterIndexDescriptorClose);
  } catch {
    const unavailable = inspectWikiContractIndex(options);
    throw new WikiContractReadError("INDEX_UNAVAILABLE", `Wiki index is ${unavailable.state}.`);
  }
  let db: SqliteDatabase | null = null;
  let transferred = false;
  try {
    options.hooks?.afterInitialIndexBind?.();
    const corpusBeforeInspection = observeCorpus(scaffoldRoot, options.exclude);
    const initial = inspectWikiContractIndex(options);
    options.hooks?.afterInitialStatusInspection?.();
    const corpusAfterInspection = observeCorpus(scaffoldRoot, options.exclude);
    if (corpusBeforeInspection.revision !== corpusAfterInspection.revision
      || corpusBeforeInspection.stable !== corpusAfterInspection.stable) {
      throw new WikiContractReadError(
        "REVISION_CONFLICT",
        "The canonical Wiki changed while the read session was opening.",
      );
    }
    if (initial.indexedRevision === null || ["missing", "corrupt", "rebuild_required", "migration_required"].includes(initial.state)) {
      throw new WikiContractReadError("INDEX_UNAVAILABLE", `Wiki index is ${initial.state}.`);
    }
    if (!pathStillNamesBoundIndex(indexPath, bound)) {
      throw new WikiContractReadError("REVISION_CONFLICT", "Wiki index changed while the read session was opening.");
    }
    options.hooks?.beforeSessionImmutableOpen?.();
    // Same FTS5 requirement as the status path, reported through the existing
    // INDEX_UNAVAILABLE code: for a reader the index genuinely is unavailable
    // on this Node, and the message says why and what to change.
    const fts5 = fts5UnavailableDiagnostic(bound.path);
    if (fts5) throw new WikiContractReadError("INDEX_UNAVAILABLE", fts5.message);

    db = openSqlite(bound.path, { readOnly: true, immutable: true });
    if (readSchemaVersion(db) !== WIKI_SCHEMA_VERSION
      || readMeta(db, WIKI_META_KEYS.indexedRevision) !== initial.indexedRevision
      || validateIndexStructure(db) !== null) {
      throw new WikiContractReadError("REVISION_CONFLICT", "Wiki index changed while the read session was opening.");
    }
    const session = new ContractSession(
      db,
      bound,
      { ...options, scaffoldRoot, indexPath },
      initial,
      corpusAfterInspection.revision,
    );
    db = null;
    transferred = true;
    return session;
  } finally {
    db?.close();
    if (!transferred) bound.close();
  }
}

export function withWikiContractReadSession<T>(
  options: InspectWikiIndexOptions,
  read: (session: WikiContractReadSession) => T,
): T {
  const session = openWikiContractReadSession(options);
  try {
    const value = read(session);
    const validation = session.validate();
    if (!validation.valid) {
      throw new WikiContractReadError("REVISION_CONFLICT", "Wiki index or canonical files changed during the read.");
    }
    return value;
  } finally {
    session.close();
  }
}

/**
 * Async counterpart to `withWikiContractReadSession`.
 *
 * The descriptor-bound index and corpus observation remain owned by the
 * session until the callback settles. This is used by package-private
 * consumers that must compose a Wiki read with another independently fresh
 * snapshot without releasing either side of the handshake early.
 */
export async function withWikiContractReadSessionAsync<T>(
  options: InspectWikiIndexOptions,
  read: (session: WikiContractReadSession) => T | Promise<T>,
): Promise<T> {
  const session = openWikiContractReadSession(options);
  try {
    const value = await read(session);
    const validation = session.validate();
    if (!validation.valid) {
      throw new WikiContractReadError(
        "REVISION_CONFLICT",
        "Wiki index or canonical files changed during the read.",
      );
    }
    return value;
  } finally {
    session.close();
  }
}

class ContractSession implements WikiContractReadSession {
  readonly indexedRevision: string;
  readonly snapshotRevision: string;
  readonly observedAt: string;
  private open = true;
  private readonly corpusRevisionAtOpen: string;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly bound: BoundIndex,
    private readonly options: InspectWikiIndexOptions & { scaffoldRoot: string; indexPath: string },
    private readonly initial: ContractWikiIndexStatus,
    corpusRevisionAtOpen: string,
  ) {
    this.indexedRevision = initial.indexedRevision!;
    this.snapshotRevision = bound.digest;
    this.observedAt = initial.observedAt;
    this.corpusRevisionAtOpen = corpusRevisionAtOpen;
  }

  status(): ContractWikiIndexStatus {
    this.assertOpen();
    return this.initial;
  }

  get(id: string): ContractEntity | null {
    this.assertOpen();
    validateIdentifier(id, "entity id");
    const row = this.entityRow(id);
    if (row === undefined) return null;
    const summary = this.summaries([row])[0]!;
    return {
      ...summary,
      indexRow: {
        entityKey: row.entity_key,
        metadataKind: row.metadata_kind,
        provenance: row.provenance,
        metadata: row.metadata,
      },
      body: row.body,
      relations: this.relationRefs(row.entity_key),
      backlinks: this.fullBacklinks(id),
      sources: this.sources(row.entity_key),
      ...(parseObject<ContractProvenance>(row.provenance) === undefined
        ? {}
        : { provenance: parseObject<ContractProvenance>(row.provenance)! }),
      groundings: this.groundings(row.entity_key),
    };
  }

  list(request: ContractListRequest = {}): ContractPage<ContractEntitySummary> {
    this.assertOpen();
    const normalized = normalizeListRequest(request);
    const paging = this.paging("list", normalized, request.cursor);
    const filter = entityFilterSql(normalized, "e");
    if (request.cursor !== undefined) {
      const atOffset = this.db.prepare(
        `SELECT e.entity_key FROM wiki_entities e
          WHERE ${filter.sql}
          ORDER BY e.title, e.id LIMIT 1 OFFSET ?`,
      ).get(...filter.params, paging.offset);
      if (atOffset === undefined) {
        throw new WikiContractReadError("INVALID_REQUEST", "Cursor offset is outside the requested result set.");
      }
    }
    const rows = this.db.prepare(
      `SELECT ${ENTITY_COLUMNS} FROM wiki_entities e
        WHERE ${filter.sql}
        ORDER BY e.title, e.id LIMIT ? OFFSET ?`,
    ).all(...filter.params, normalized.limit + 1, paging.offset) as EntityRow[];
    const candidates = this.summaries(rows.slice(0, normalized.limit));
    const fitted = fitTokenPage(candidates, normalized.maxTokens);
    const hasMore = rows.length > normalized.limit || fitted.items.length < candidates.length;
    return this.page(
      "list",
      normalized,
      paging.requestHash,
      paging.offset,
      fitted.items,
      hasMore,
      fitted.truncated,
    );
  }

  search(request: ContractSearchRequest): ContractPage<ContractSearchHit> {
    this.assertOpen();
    const normalized = normalizeSearchRequest(request);
    const paging = this.paging("search", normalized, request.cursor);
    if (normalized.query.length === 0) {
      this.assertCursorOffset(request.cursor, paging.offset, 0);
      return this.page("search", normalized, paging.requestHash, paging.offset, [], false, false);
    }
    const candidateSet = this.searchCandidateSet(normalized);
    let safetyTruncated = candidateSet.truncated;
    const hits = [...candidateSet.items].sort(compareSearchHits);
    const bounded = hits.slice(0, MAX_SEARCH_RESULTS);
    this.assertCursorOffset(request.cursor, paging.offset, bounded.length);
    if (hits.length > bounded.length) safetyTruncated = true;
    const candidates = bounded.slice(paging.offset, paging.offset + normalized.limit);
    const fitted = fitTokenPage(candidates, normalized.maxTokens);
    const hasMore = paging.offset + fitted.items.length < bounded.length;
    return this.page(
      "search",
      normalized,
      paging.requestHash,
      paging.offset,
      fitted.items,
      hasMore,
      safetyTruncated || fitted.truncated,
    );
  }

  searchCandidates(request: ContractSearchCandidateRequest): ContractSearchCandidates {
    this.assertOpen();
    const normalized = normalizeSearchRequest({ ...request, limit: MAX_PAGE_LIMIT });
    if (normalized.query.length === 0) return { items: [], truncated: false };
    return this.searchCandidateSet(normalized);
  }

  refreshPaths(): readonly string[] {
    this.assertOpen();
    const current = observeCorpus(this.options.scaffoldRoot, this.options.exclude);
    if (!current.stable || current.files.length > 10_000) {
      throw new WikiContractReadError(
        "INDEX_UNAVAILABLE",
        "The canonical Wiki corpus is not stable enough for targeted refresh discovery.",
      );
    }
    const indexed = this.db.prepare(
      `SELECT path, content_hash FROM wiki_files ORDER BY path LIMIT 10001`,
    ).all() as Array<{ path: string; content_hash: string }>;
    if (indexed.length > 10_000 || indexed.some((row) => (
      !isSafeRepoPath(row.path) || !isContentHash(row.content_hash)
    ))) {
      throw new WikiContractReadError(
        "INDEX_UNAVAILABLE",
        "The indexed Wiki file inventory is not safe for targeted refresh discovery.",
      );
    }
    const indexedByPath = new Map(indexed.map((row) => [row.path, row.content_hash]));
    const currentByPath = new Map(current.files.map((file) => [file.path, file.contentHash]));
    return [...new Set([
      ...current.files
        .filter((file) => indexedByPath.get(file.path) !== file.contentHash)
        .map((file) => file.path),
      ...indexed
        .filter((file) => !currentByPath.has(file.path))
        .map((file) => file.path),
    ])].sort(compareString);
  }

  authoringCorpusAttestation(): ContractAuthoringCorpusAttestation {
    this.assertOpen();
    const current = observeCorpus(this.options.scaffoldRoot, this.options.exclude);
    if (!current.stable) {
      throw new WikiContractReadError(
        "INDEX_UNAVAILABLE",
        "The canonical Wiki corpus is not stable enough for exact authoring attestation.",
      );
    }
    const indexed = this.db.prepare(
      `SELECT path, content_hash FROM wiki_files
       ORDER BY path LIMIT ${WIKI_CORPUS_LIMITS.maxMarkdownFiles + 1}`,
    ).all() as Array<{ path: string; content_hash: string }>;
    if (
      indexed.length > WIKI_CORPUS_LIMITS.maxMarkdownFiles
      || indexed.some((row) => (
        !isSafeRepoPath(row.path) || !isContentHash(row.content_hash)
      ))
    ) {
      throw new WikiContractReadError(
        "INDEX_UNAVAILABLE",
        "The indexed Wiki file inventory is not safe for exact authoring attestation.",
      );
    }

    const currentWikiOwned = current.files.filter(
      (file) => !isTeamOwnedReadOnlyPath(file.path),
    );
    const indexedWikiOwned = indexed
      .filter((file) => !isTeamOwnedReadOnlyPath(file.path))
      .map((file) => ({ path: file.path, contentHash: file.content_hash }));
    const currentTeamOwned = current.files.filter(
      (file) => isTeamOwnedReadOnlyPath(file.path),
    );
    const indexedTeamOwned = indexed
      .filter((file) => isTeamOwnedReadOnlyPath(file.path))
      .map((file) => ({ path: file.path, contentHash: file.content_hash }));

    return {
      containmentSafe: !current.diagnostics.some(
        (entry) => entry.code === "PATH_OUTSIDE_SCAFFOLD",
      ),
      wikiOwnedFresh: sameFileInventory(currentWikiOwned, indexedWikiOwned),
      wikiOwnedDiagnosticsHealthy: !this.hasWikiOwnedErrorDiagnostic(
        new Set(indexedTeamOwned.map((file) => file.path)),
      ),
      teamOwnedDrift: !sameFileInventory(currentTeamOwned, indexedTeamOwned),
      wikiOwnedRevision: indexedCorpusRevision(currentWikiOwned),
      allFiles: current.files,
      files: currentWikiOwned,
    };
  }

  /**
   * Preserve the index's pre-drift quality classification. Whole-corpus
   * inspection reports `stale` before stored diagnostics once Team publishes,
   * so exact authoring must independently retain Wiki-owned error state.
   */
  private hasWikiOwnedErrorDiagnostic(indexedTeamOwnedPaths: ReadonlySet<string>): boolean {
    const rows = this.db.prepare(
      `SELECT d.file,
              (SELECT e.file
                 FROM wiki_entities e
                WHERE e.id = d.entity_id AND e.shadowed = 0
                ORDER BY e.entity_key
                LIMIT 1) AS entity_file
         FROM wiki_diagnostics d
        WHERE d.severity = 'error'
        ORDER BY d.scope, d.code, d.file, d.entity_id, d.path, d.start_offset, d.message
        LIMIT 100001`,
    ).iterate() as IterableIterator<{ file: string | null; entity_file: string | null }>;
    let count = 0;
    for (const row of rows) {
      count += 1;
      if (count > 100_000) {
        throw new WikiContractReadError(
          "INDEX_UNAVAILABLE",
          "The indexed Wiki diagnostic inventory exceeds its safety bound.",
        );
      }
      const sourcePath = row.file ?? row.entity_file;
      if (sourcePath === null
        || !isTeamOwnedReadOnlyPath(sourcePath)
        || !indexedTeamOwnedPaths.has(sourcePath)) return true;
    }
    return false;
  }

  private searchCandidateSet(
    normalized: ReturnType<typeof normalizeSearchRequest>,
  ): ContractSearchCandidates {
    const filter = entityFilterSql(normalized, "e");
    const byId = new Map<string, { row: EntityRow; fields: Set<MatchField>; relevance?: number }>();
    // Fields arrive best first, so an entity's relevance is its best field's.
    const add = (rows: (EntityRow & { relevance?: number })[], field: MatchField): void => {
      for (const row of rows) {
        const existing = byId.get(row.id);
        if (existing) existing.fields.add(field);
        else byId.set(row.id, { row, fields: new Set([field]), ...(row.relevance === undefined ? {} : { relevance: Number(row.relevance) }) });
      }
    };
    add(this.db.prepare(
      `SELECT ${ENTITY_COLUMNS} FROM wiki_entities e WHERE e.id = ? AND ${filter.sql} LIMIT 1`,
    ).all(normalized.query, ...filter.params) as EntityRow[], "id");
    const plan = planWikiSearch(normalized.query);
    const expression = plan.allTermsExpression;
    let safetyTruncated = false;
    if (expression !== null) {
      for (const [columns, field] of [
        ["title", "title"], ["summary", "summary"], ["body aliases meta", "body"],
      ] as const) {
        const rows = this.db.prepare(
          `SELECT ${ENTITY_COLUMNS}, round(bm25(wiki_fts), 6) AS relevance FROM wiki_fts f
            JOIN wiki_entities e ON e.entity_key = f.entity_key
           WHERE wiki_fts MATCH ? AND ${filter.sql}
           ORDER BY relevance, e.title, e.id LIMIT ?`,
        ).all(`{${columns}} : (${expression})`, ...filter.params, MAX_SEARCH_RESULTS + 1) as (EntityRow & { relevance: number })[];
        if (rows.length > MAX_SEARCH_RESULTS) safetyTruncated = true;
        add(rows.slice(0, MAX_SEARCH_RESULTS), field);
      }
    }
    const summaries = new Map(this.summaries([...byId.values()].map((value) => value.row)).map((item) => [item.id, item]));
    const hits: ContractSearchHit[] = [...byId.entries()].map(([id, value]) => ({
      entity: summaries.get(id)!,
      matchedFields: [...value.fields].sort((left, right) => MATCH_FIELD_RANK[left] - MATCH_FIELD_RANK[right]),
      match: "all_terms",
      ...(value.relevance === undefined ? {} : { relevance: value.relevance }),
    }));
    if (plan.terms.length === 0 || hits.length >= MAX_SEARCH_RESULTS) return { items: hits, truncated: safetyTruncated };

    // Entities matching only some of the terms follow every all-terms hit
    // (#235), ordered as the CLI session orders them.
    const broader = findSomeTermsMatches(this.db, plan.terms, filter, MAX_SEARCH_RESULTS);
    if (broader.truncated) safetyTruncated = true;
    const room = broader.matches.slice(0, MAX_SEARCH_RESULTS);
    const rows = room.length === 0 ? [] : this.db.prepare(
      `SELECT ${ENTITY_COLUMNS} FROM wiki_entities e WHERE e.entity_key IN (${placeholders(room.length)}) AND ${filter.sql} LIMIT ?`,
    ).all(...room.map((match) => match.entityKey), ...filter.params, room.length) as EntityRow[];
    const rowsByKey = new Map(rows.map((row) => [row.entity_key, row]));
    const unseen = room.filter((match) => rowsByKey.has(match.entityKey) && !byId.has(rowsByKey.get(match.entityKey)!.id));
    const fresh = unseen.slice(0, MAX_SEARCH_RESULTS - hits.length);
    if (unseen.length > fresh.length) safetyTruncated = true;
    const freshSummaries = new Map(this.summaries(fresh.map((match) => rowsByKey.get(match.entityKey)!)).map((item) => [item.id, item]));
    for (const match of fresh) {
      hits.push({
        entity: freshSummaries.get(rowsByKey.get(match.entityKey)!.id)!,
        matchedFields: [match.field],
        match: "some_terms",
        matchedTerms: match.matchedTerms,
        score: match.score,
        relevance: match.relevance,
      });
    }
    if (broader.matches.length > room.length) safetyTruncated = true;
    return { items: hits, truncated: safetyTruncated };
  }

  relations(request: ContractRelationRequest): ContractPage<ContractRelationHit> {
    this.assertOpen();
    validateIdentifier(request.entityId, "entity id");
    if (this.entityRow(request.entityId) === undefined) {
      throw new WikiContractReadError("NOT_FOUND", "Relation root does not exist.");
    }
    return this.rawRelations(request);
  }

  backlinks(request: Omit<ContractRelationRequest, "direction">): ContractPage<ContractRelation> {
    const page = this.relations({ ...request, direction: "incoming" });
    return { ...page, items: page.items.map((hit) => hit.relation) };
  }

  neighborhood(request: ContractNeighborhoodRequest): ContractNeighborhood {
    this.assertOpen();
    validateIdentifier(request.entityId, "entity id");
    const depth = strictInteger(request.depth, "depth", 1, 5);
    const maxEntities = strictInteger(request.maxEntities, "maxEntities", 1, 100);
    const maxTokens = strictInteger(request.maxTokens, "maxTokens", MIN_TOKEN_BUDGET, 1_000_000);
    const direction = request.direction ?? "both";
    const rootRow = this.entityRow(request.entityId);
    if (rootRow === undefined) throw new WikiContractReadError("NOT_FOUND", "Neighborhood root does not exist.");
    const root = this.summaries([rootRow])[0]!;
    const visited = new Set([root.id]);
    const entities: ContractEntitySummary[] = [];
    const relationByKey = new Map<string, ContractRelation>();
    let frontier = [root.id];
    let truncated = false;
    for (let level = 0; level < depth && frontier.length > 0 && !truncated; level += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        const edges = this.rawRelations({
          entityId: id,
          direction,
          relationTypes: request.relationTypes,
          includeArchived: request.includeArchived,
          limit: MAX_PAGE_LIMIT,
        });
        if (edges.truncated) truncated = true;
        for (const hit of edges.items) {
          const key = `${hit.relation.source.id}\u001f${hit.relation.type}\u001f${hit.relation.target.id}`;
          relationByKey.set(key, hit.relation);
          if (hit.entity === null || visited.has(hit.entity.id)) continue;
          const nextCost = estimateTokens({ root, entities: [...entities, hit.entity], relations: [...relationByKey.values()] });
          if (entities.length >= maxEntities || nextCost > maxTokens) {
            truncated = true;
            break;
          }
          visited.add(hit.entity.id);
          entities.push(hit.entity);
          next.push(hit.entity.id);
        }
        if (truncated) break;
      }
      frontier = next;
    }
    entities.sort(compareEntitySummary);
    const relations = [...relationByKey.values()].sort(compareRelations);
    return {
      root,
      entities,
      relations,
      estimatedTokens: estimateTokens({ root, entities, relations }),
      truncated,
    };
  }

  groundingStatus(id: string): readonly ContractGrounding[] | null {
    this.assertOpen();
    validateIdentifier(id, "entity id");
    const row = this.entityRow(id);
    return row === undefined ? null : this.groundings(row.entity_key);
  }

  diagnostics(request: number | ContractDiagnosticRequest = DEFAULT_PAGE_LIMIT): ContractPage<WikiDiagnostic> {
    this.assertOpen();
    const normalized = normalizeDiagnosticRequest(request);
    const items = readFilteredDiagnostics(this.db, normalized.limit + 1, normalized);
    const hasMore = items.length > normalized.limit;
    const kept = items.slice(0, normalized.limit);
    return {
      items: kept,
      nextCursor: null,
      estimatedTokens: estimateTokens(kept),
      truncated: hasMore,
    };
  }

  diagnosticValidation(
    request: Omit<ContractDiagnosticRequest, "limit"> = {},
  ): ContractDiagnosticValidation {
    this.assertOpen();
    const normalized = normalizeDiagnosticFilters(request);
    const { where, params } = diagnosticFilterSql(normalized);
    const row = this.db.prepare(
      `SELECT EXISTS(
         SELECT 1
           FROM wiki_diagnostics d
           ${where}
          ${where === "" ? "WHERE" : "AND"} d.severity = 'error'
          LIMIT 1
       ) AS has_error`,
    ).get(...params) as { has_error: number };
    return { valid: Number(row.has_error) === 0 };
  }

  validate(): ContractReadValidation {
    if (!this.open) return { valid: false, status: this.initial };
    const current = inspectWikiContractIndex(this.options);
    const currentCorpus = observeCorpus(this.options.scaffoldRoot, this.options.exclude);
    let sameIdentity = false;
    try {
      sameIdentity = pathStillNamesBoundIndex(this.options.indexPath, this.bound);
    } catch {
      sameIdentity = false;
    }
    return {
      valid: sameIdentity
        && current.indexedRevision === this.indexedRevision
        && current.state === this.initial.state
        && currentCorpus.revision === this.corpusRevisionAtOpen,
      status: current,
    };
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    try {
      this.db.close();
    } finally {
      this.bound.close();
    }
  }

  private assertOpen(): void {
    if (!this.open) throw new WikiContractReadError("INDEX_UNAVAILABLE", "Wiki read session is closed.");
  }

  private entityRow(id: string): EntityRow | undefined {
    return this.db.prepare(
      `SELECT ${ENTITY_COLUMNS} FROM wiki_entities e WHERE e.id = ? AND e.shadowed = 0 LIMIT 1`,
    ).get(id) as EntityRow | undefined;
  }

  private summaries(rows: readonly EntityRow[]): ContractEntitySummary[] {
    return rows.map((row) => {
      const groundings = this.groundings(row.entity_key);
      return {
        id: row.id,
        type: row.type,
        title: row.title,
        summary: row.summary,
        lifecycleState: row.status,
        semanticRevision: Number(row.revision),
        fileContentHash: row.file_content_hash,
        entityContentHash: row.entity_content_hash,
        location: {
          path: row.file,
          metadataStart: Number(row.metadata_start),
          metadataEnd: Number(row.metadata_end),
          headingStart: Number(row.heading_start),
          headingEnd: Number(row.heading_end),
          bodyStart: Number(row.body_start),
          bodyEnd: Number(row.body_end),
          startLine: Number(row.start_line),
          endLine: Number(row.end_line),
          headingDepth: Number(row.heading_depth),
        },
        groundingHealth: aggregateHealth(groundings),
        topics: this.topics(row.entity_key),
        sourceTypes: this.sourceTypes(row.entity_key),
        diagnostics: this.entityDiagnostics(row.id),
      };
    });
  }

  private topics(key: string): string[] {
    const rows = this.db.prepare(
      `SELECT topic_entity_id FROM wiki_entity_topics WHERE entity_key = ? ORDER BY ordinal LIMIT 201`,
    ).all(key) as { topic_entity_id: string }[];
    this.assertCanonicalMetadataBound(rows, "topics");
    return rows.map((row) => row.topic_entity_id);
  }

  private sourceTypes(key: string): string[] {
    const rows = this.db.prepare(
      `SELECT type FROM wiki_sources WHERE entity_key = ? ORDER BY ordinal LIMIT 201`,
    ).all(key) as { type: string }[];
    this.assertCanonicalMetadataBound(rows, "sources");
    return [...new Set(rows.map((row) => row.type))].sort(compareString);
  }

  private entityDiagnostics(id: string): WikiDiagnostic[] {
    const rows = readDiagnostics(this.db, MAX_RELATIONS_PER_ENTITY + 1, id);
    this.assertCanonicalMetadataBound(rows, "diagnostics");
    return rows;
  }

  private relationRefs(key: string): ContractRelationRef[] {
    const rows = this.db.prepare(
      `SELECT type, target_id, note, metadata FROM wiki_relations
        WHERE source_key = ? ORDER BY ordinal LIMIT ?`,
    ).all(key, MAX_RELATIONS_PER_ENTITY + 1) as Array<{
      type: string; target_id: string; note: string | null; metadata: string | null;
    }>;
    this.assertCanonicalMetadataBound(rows, "relations");
    return rows.map((row) => ({
      type: row.type,
      targetId: row.target_id,
      ...(row.note === null ? {} : { note: row.note }),
      ...(parseObject<Record<string, unknown>>(row.metadata) === undefined
        ? {}
        : { metadata: parseObject<Record<string, unknown>>(row.metadata)! }),
    }));
  }

  private sources(key: string): ContractSource[] {
    const rows = this.db.prepare(
      `SELECT type, ref, note, repository, commit_sha, captured_at, metadata
         FROM wiki_sources WHERE entity_key = ? ORDER BY ordinal LIMIT ?`,
    ).all(key, MAX_RELATIONS_PER_ENTITY + 1) as Array<Record<string, string | null>>;
    this.assertCanonicalMetadataBound(rows, "sources");
    return rows.map((row) => ({
      type: row["type"]!,
      ...(row["ref"] === null ? {} : { ref: row["ref"]! }),
      ...(row["note"] === null ? {} : { note: row["note"]! }),
      ...(row["repository"] === null ? {} : { repository: row["repository"]! }),
      ...(row["commit_sha"] === null ? {} : { commit: row["commit_sha"]! }),
      ...(row["captured_at"] === null ? {} : { capturedAt: row["captured_at"]! }),
      ...(parseObject<Record<string, unknown>>(row["metadata"] ?? null) === undefined
        ? {}
        : { metadata: parseObject<Record<string, unknown>>(row["metadata"] ?? null)! }),
    }));
  }

  private groundings(key: string): ContractGrounding[] {
    const rows = this.db.prepare(
      `SELECT node_id, fingerprint, body_hash, code_hash, file, commit_sha, verified_at, reason, resolution
         FROM wiki_groundings WHERE entity_key = ? ORDER BY ordinal LIMIT ?`,
    ).all(key, MAX_RELATIONS_PER_ENTITY + 1) as Array<Record<string, string | null>>;
    this.assertCanonicalMetadataBound(rows, "groundings");
    return rows.map((row) => ({
      requestedNode: row["node_id"]!,
      fingerprint: row["fingerprint"]!,
      ...(row["body_hash"] === null ? {} : { bodyHash: row["body_hash"]! }),
      ...(row["code_hash"] === null ? {} : { codeHash: row["code_hash"]! }),
      ...(row["file"] === null ? {} : { file: row["file"]! }),
      ...(row["commit_sha"] === null ? {} : { commit: row["commit_sha"]! }),
      ...(row["verified_at"] === null ? {} : { verifiedAt: row["verified_at"]! }),
      ...(row["reason"] === null ? {} : { reason: row["reason"]! }),
      observedAt: this.observedAt,
      resolution: parseObject<Record<string, unknown>>(row["resolution"] ?? null) ?? null,
    }));
  }

  private rawRelations(request: ContractRelationRequest): ContractPage<ContractRelationHit> {
    const normalized = normalizeRelationRequest(request);
    const paging = this.paging("relations", normalized, request.cursor);
    const rows: RelationDbRow[] = [];
    if (normalized.direction !== "incoming") {
      rows.push(...this.outgoingRows(normalized).map((row) => ({ ...row, direction: "outgoing" as const })));
    }
    if (normalized.direction !== "outgoing") {
      rows.push(...this.incomingRows(normalized).map((row) => ({ ...row, direction: "incoming" as const })));
    }
    const hits = rows.map((row) => this.relationHit(row)).filter((hit) => (
      hit.entity !== null
      && (normalized.includeArchived || hit.entity.lifecycleState !== "archived")
    )).sort(compareRelationHits);
    const safetyTruncated = hits.length > MAX_RELATIONS_PER_ENTITY;
    const bounded = hits.slice(0, MAX_RELATIONS_PER_ENTITY);
    this.assertCursorOffset(request.cursor, paging.offset, bounded.length);
    const candidates = bounded.slice(paging.offset, paging.offset + normalized.limit);
    const fitted = fitTokenPage(candidates, normalized.maxTokens);
    const hasMore = paging.offset + fitted.items.length < bounded.length;
    return this.page(
      "relations",
      normalized,
      paging.requestHash,
      paging.offset,
      fitted.items,
      hasMore,
      safetyTruncated || fitted.truncated,
    );
  }

  private fullBacklinks(entityId: string): ContractRelation[] {
    const normalized = normalizeRelationRequest({
      entityId,
      direction: "incoming",
      includeArchived: true,
      limit: MAX_PAGE_LIMIT,
    });
    const rows = this.incomingRows(normalized);
    this.assertCanonicalMetadataBound(rows, "backlinks");
    return rows
      .map((row) => this.relationHit({ ...row, direction: "incoming" }))
      .sort(compareRelationHits)
      .map((hit) => hit.relation);
  }

  private assertCanonicalMetadataBound(rows: readonly unknown[], field: string): void {
    if (rows.length > MAX_RELATIONS_PER_ENTITY) {
      throw new WikiContractReadError(
        "INDEX_UNAVAILABLE",
        `Wiki entity ${field} exceed the canonical metadata safety bound.`,
      );
    }
  }

  private outgoingRows(request: ReturnType<typeof normalizeRelationRequest>): RelationDbRow[] {
    const relationFilter = inClause("r.type", request.relationTypes);
    return this.db.prepare(
      `SELECT r.type, r.note, r.metadata, source.id AS source_id, source.type AS source_type,
              source.title AS source_title, r.target_id, target.id AS target_entity_id
         FROM wiki_relations r
         JOIN wiki_entities source ON source.entity_key = r.source_key AND source.shadowed = 0
         JOIN wiki_entities target ON target.id = r.target_id AND target.shadowed = 0
        WHERE source.id = ?
          ${request.includeArchived ? "" : "AND target.status <> 'archived'"}
          ${relationFilter.sql}
        ORDER BY r.type, COALESCE(target.title, ''), r.target_id LIMIT ?`,
    ).all(request.entityId, ...relationFilter.params, MAX_RELATIONS_PER_ENTITY + 1) as RelationDbRow[];
  }

  private incomingRows(request: ReturnType<typeof normalizeRelationRequest>): RelationDbRow[] {
    const relationFilter = inClause("r.type", request.relationTypes);
    return this.db.prepare(
      `SELECT r.type, r.note, r.metadata, source.id AS source_id, source.type AS source_type,
              source.title AS source_title, r.target_id, target.id AS target_entity_id
         FROM wiki_relations r
         JOIN wiki_entities source ON source.entity_key = r.source_key AND source.shadowed = 0
         JOIN wiki_entities target ON target.id = r.target_id AND target.shadowed = 0
        WHERE r.target_id = ?
          ${request.includeArchived ? "" : "AND source.status <> 'archived'"}
          ${relationFilter.sql}
        ORDER BY r.type, source.title, source.id LIMIT ?`,
    ).all(request.entityId, ...relationFilter.params, MAX_RELATIONS_PER_ENTITY + 1) as RelationDbRow[];
  }

  private relationHit(row: RelationDbRow): ContractRelationHit {
    const targetRow = row.target_entity_id === null ? undefined : this.entityRow(row.target_entity_id);
    const sourceRow = this.entityRow(row.source_id);
    const direction = row.direction ?? "outgoing";
    const relation: ContractRelation = {
      type: row.type,
      source: { id: row.source_id, type: row.source_type, title: row.source_title },
      target: {
        id: row.target_id,
        ...(targetRow === undefined ? {} : { type: targetRow.type, title: targetRow.title }),
      },
      ...(row.note === null ? {} : { note: row.note }),
      ...(parseObject<Record<string, unknown>>(row.metadata) === undefined
        ? {}
        : { metadata: parseObject<Record<string, unknown>>(row.metadata)! }),
    };
    const entityRow = direction === "outgoing" ? targetRow : sourceRow;
    return {
      relation,
      direction,
      entity: entityRow === undefined ? null : this.summaries([entityRow])[0]!,
    };
  }

  private paging(operation: string, request: object, cursor: string | undefined): { requestHash: string; offset: number } {
    const requestHash = sha256(canonicalJson(request));
    if (cursor === undefined) return { requestHash, offset: 0 };
    const payload = decodeCursor(cursor);
    if (payload.operation !== operation || payload.requestHash !== requestHash) {
      throw new WikiContractReadError("INVALID_REQUEST", "Cursor does not belong to this request.");
    }
    if (payload.indexedRevision !== this.snapshotRevision) {
      throw new WikiContractReadError("REVISION_CONFLICT", "Cursor belongs to a different Wiki revision.");
    }
    return { requestHash, offset: payload.offset };
  }

  private assertCursorOffset(cursor: string | undefined, offset: number, available: number): void {
    if (cursor !== undefined && offset >= available) {
      throw new WikiContractReadError("INVALID_REQUEST", "Cursor offset is outside the requested result set.");
    }
  }

  private page<T>(
    operation: string,
    request: object & { limit: number; maxTokens?: number },
    requestHash: string,
    offset: number,
    items: readonly T[],
    hasMore: boolean,
    truncated: boolean,
  ): ContractPage<T> {
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: hasMore && items.length > 0
        ? encodeCursor({ v: 1, operation, indexedRevision: this.snapshotRevision, requestHash, offset: nextOffset })
        : null,
      estimatedTokens: estimateTokens(items),
      truncated: hasMore || truncated,
    };
  }
}

interface RelationDbRow {
  type: string;
  note: string | null;
  metadata: string | null;
  source_id: string;
  source_type: string;
  source_title: string;
  target_id: string;
  target_entity_id: string | null;
  direction?: "outgoing" | "incoming";
}

function fitTokenPage<T>(
  candidates: readonly T[],
  maxTokens: number | undefined,
): { items: T[]; truncated: boolean } {
  if (maxTokens === undefined) return { items: [...candidates], truncated: false };
  const items: T[] = [];
  let used = 0;
  for (const candidate of candidates) {
    const cost = Math.max(1, estimateTokens(candidate));
    if (used + cost > maxTokens) break;
    used += cost;
    items.push(candidate);
  }
  if (items.length === 0 && candidates.length > 0) {
    throw new WikiContractReadError("INVALID_REQUEST", "maxTokens is too small for the first bounded result.");
  }
  return { items, truncated: items.length < candidates.length };
}

function normalizeListRequest(request: ContractListRequest): Required<Pick<ContractListRequest, "limit" | "includeArchived">> & Omit<ContractListRequest, "cursor" | "limit" | "includeArchived"> {
  return {
    limit: strictInteger(request.limit ?? DEFAULT_PAGE_LIMIT, "limit", 1, MAX_PAGE_LIMIT),
    includeArchived: request.includeArchived === true,
    ...(request.kinds === undefined ? {} : { kinds: normalizedStrings(request.kinds, "kinds") }),
    ...(request.topics === undefined ? {} : { topics: normalizedStrings(request.topics, "topics") }),
    ...(request.lifecycleStates === undefined ? {} : { lifecycleStates: normalizedStrings(request.lifecycleStates, "lifecycleStates") }),
    ...(request.groundingHealth === undefined ? {} : { groundingHealth: normalizedStrings(request.groundingHealth, "groundingHealth") as GroundingHealth[] }),
    ...(request.sourceTypes === undefined ? {} : { sourceTypes: normalizedStrings(request.sourceTypes, "sourceTypes") }),
    ...(request.maxTokens === undefined ? {} : { maxTokens: strictInteger(request.maxTokens, "maxTokens", MIN_TOKEN_BUDGET, 1_000_000) }),
  };
}

function normalizeSearchRequest(request: ContractSearchRequest): ReturnType<typeof normalizeListRequest> & { query: string } {
  if (typeof request.query !== "string" || request.query.length > 256) {
    throw new WikiContractReadError("INVALID_REQUEST", "Search query must be at most 256 characters.");
  }
  return { ...normalizeListRequest(request), query: request.query.trim().normalize("NFC") };
}

function normalizeRelationRequest(request: ContractRelationRequest) {
  if (!["outgoing", "incoming", "both"].includes(request.direction)) {
    throw new WikiContractReadError("INVALID_REQUEST", "Invalid relation direction.");
  }
  return {
    entityId: request.entityId,
    direction: request.direction,
    limit: strictInteger(request.limit ?? DEFAULT_PAGE_LIMIT, "limit", 1, MAX_PAGE_LIMIT),
    includeArchived: request.includeArchived === true,
    ...(request.relationTypes === undefined ? {} : { relationTypes: normalizedStrings(request.relationTypes, "relationTypes") }),
    ...(request.maxTokens === undefined ? {} : { maxTokens: strictInteger(request.maxTokens, "maxTokens", MIN_TOKEN_BUDGET, 1_000_000) }),
  };
}

function normalizeDiagnosticRequest(
  request: number | ContractDiagnosticRequest,
): Required<Pick<ContractDiagnosticRequest, "limit">> & Omit<ContractDiagnosticRequest, "limit"> {
  if (typeof request === "number") return { limit: strictInteger(request, "limit", 0, MAX_PAGE_LIMIT) };
  return {
    limit: strictInteger(request.limit ?? DEFAULT_PAGE_LIMIT, "limit", 0, MAX_PAGE_LIMIT),
    ...normalizeDiagnosticFilters(request),
  };
}

function normalizeDiagnosticFilters(
  request: Omit<ContractDiagnosticRequest, "limit">,
): Omit<ContractDiagnosticRequest, "limit"> {
  const normalizeIds = (values: readonly string[] | undefined): string[] | undefined => {
    if (values === undefined) return undefined;
    if (values.length > 100) {
      throw new WikiContractReadError("INVALID_REQUEST", "entityIds must contain at most 100 values.");
    }
    for (const value of values) validateIdentifier(value, "entity id");
    return [...new Set(values)].sort(compareString);
  };
  const normalizePaths = (values: readonly string[] | undefined): string[] | undefined => {
    if (values === undefined) return undefined;
    if (values.length > 100 || values.some((value) => !isSafeRepoPath(value))) {
      throw new WikiContractReadError("INVALID_REQUEST", "paths must contain at most 100 safe Wiki-relative paths.");
    }
    return [...new Set(values)].sort(compareString);
  };
  const entityIds = normalizeIds(request.entityIds);
  const paths = normalizePaths(request.paths);
  return {
    ...(entityIds === undefined ? {} : { entityIds }),
    ...(paths === undefined ? {} : { paths }),
  };
}

function entityFilterSql(request: ReturnType<typeof normalizeListRequest>, alias: string): { sql: string; params: unknown[] } {
  const clauses = [`${alias}.shadowed = 0`];
  const params: unknown[] = [];
  if (!request.includeArchived) clauses.push(`${alias}.status <> 'archived'`);
  appendIn(clauses, params, `${alias}.type`, request.kinds);
  appendIn(clauses, params, `${alias}.status`, request.lifecycleStates);
  if (request.topics !== undefined) {
    clauses.push(`EXISTS (SELECT 1 FROM wiki_entity_topics topic WHERE topic.entity_key = ${alias}.entity_key AND topic.topic_entity_id IN (${placeholders(request.topics.length)}) LIMIT 1)`);
    params.push(...request.topics);
  }
  if (request.sourceTypes !== undefined) {
    clauses.push(`EXISTS (SELECT 1 FROM wiki_sources source WHERE source.entity_key = ${alias}.entity_key AND source.type IN (${placeholders(request.sourceTypes.length)}) LIMIT 1)`);
    params.push(...request.sourceTypes);
  }
  if (request.groundingHealth !== undefined) {
    clauses.push(`COALESCE((SELECT grounding.health FROM wiki_groundings grounding
      WHERE grounding.entity_key = ${alias}.entity_key AND grounding.health IS NOT NULL
      ORDER BY CASE grounding.health WHEN 'missing' THEN 0 WHEN 'ambiguous' THEN 1 WHEN 'changed' THEN 2 WHEN 'unverified' THEN 3 ELSE 4 END LIMIT 1), 'unverified')
      IN (${placeholders(request.groundingHealth.length)})`);
    params.push(...request.groundingHealth);
  }
  return { sql: clauses.join(" AND "), params };
}

function appendIn(clauses: string[], params: unknown[], column: string, values: readonly string[] | undefined): void {
  if (values === undefined) return;
  clauses.push(`${column} IN (${placeholders(values.length)})`);
  params.push(...values);
}

function inClause(column: string, values: readonly string[] | undefined): { sql: string; params: string[] } {
  if (values === undefined) return { sql: "", params: [] };
  return { sql: `AND ${column} IN (${placeholders(values.length)})`, params: [...values] };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function normalizedStrings(values: readonly string[], field: string): string[] {
  if (values.length === 0 || values.length > 100) throw new WikiContractReadError("INVALID_REQUEST", `${field} must contain 1-100 values.`);
  const normalized = values.map((value) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0")) {
      throw new WikiContractReadError("INVALID_REQUEST", `${field} contains an invalid value.`);
    }
    return value.normalize("NFC");
  });
  return [...new Set(normalized)].sort(compareString);
}

function strictInteger(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new WikiContractReadError("INVALID_REQUEST", `${field} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function validateIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0") || value.includes("/") || value.includes("\\")) {
    throw new WikiContractReadError("INVALID_REQUEST", `${field} is invalid.`);
  }
}

function encodeCursor(payload: CursorPayload): string {
  const encoded = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAX_CURSOR_BYTES) throw new WikiContractReadError("INVALID_REQUEST", "Cursor is too large.");
  return encoded;
}

function decodeCursor(cursor: string): CursorPayload {
  if (typeof cursor !== "string" || cursor.length === 0 || Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new WikiContractReadError("INVALID_REQUEST", "Cursor is invalid.");
  }
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) throw new Error("encoding");
    const parsed = JSON.parse(decoded) as Partial<CursorPayload>;
    if (canonicalJson(parsed) !== decoded) throw new Error("canonical");
    if (Object.keys(parsed).sort(compareString).join(",") !== "indexedRevision,offset,operation,requestHash,v") {
      throw new Error("keys");
    }
    if (parsed.v !== 1 || typeof parsed.operation !== "string" || typeof parsed.indexedRevision !== "string"
      || typeof parsed.requestHash !== "string" || !Number.isSafeInteger(parsed.offset)
      || parsed.offset! < 0 || parsed.offset! > 100_000) {
      throw new Error("shape");
    }
    return parsed as CursorPayload;
  } catch {
    throw new WikiContractReadError("INVALID_REQUEST", "Cursor is invalid.");
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => compareString(left, right))
    .map(([key, entry]) => [key, sortJson(entry)]));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalRoot(root: string): string {
  const absolute = resolve(root);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function resolveIndexPath(scaffoldRoot: string, configured: string | undefined, originalRoot: string): string | null {
  const lexicalRoot = resolve(originalRoot);
  const lexicalCandidate = resolve(configured ?? resolve(lexicalRoot, "wiki.db"));
  const lexicalRelative = relative(lexicalRoot, lexicalCandidate);
  let candidate = lexicalRelative !== "" && !lexicalRelative.startsWith("..") && !isAbsolute(lexicalRelative)
    ? resolve(scaffoldRoot, lexicalRelative)
    : lexicalCandidate;
  try {
    candidate = realpathSync(candidate);
  } catch {
    // A missing default is still reported as missing. Containment is checked
    // against the lexical location it would occupy.
  }
  if (!insideRoot(scaffoldRoot, candidate) || relative(scaffoldRoot, candidate).includes("..")) return null;
  return candidate;
}

function bindIndex(indexPath: string, afterClose?: () => void): BoundIndex {
  const before = lstatSync(indexPath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("not-file");
  assertBoundedIndexSize(before.size);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const fd = openSync(indexPath, constants.O_RDONLY | noFollow);
  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    try {
      closeSync(fd);
    } finally {
      try {
        afterClose?.();
      } catch {
        // Test-only cleanup observation must never compromise descriptor close.
      }
    }
  };
  try {
    const opened = fstatSync(fd);
    const after = lstatSync(indexPath);
    if (!opened.isFile() || !sameIdentity(before, opened) || !sameIdentity(opened, after)) throw new Error("changed");
    assertBoundedIndexSize(opened.size);
    const digest = hashBoundedIndex(fd, opened.size);
    const readAfter = fstatSync(fd);
    const pathAfter = lstatSync(indexPath);
    if (!sameIdentity(opened, readAfter) || !sameIdentity(readAfter, pathAfter)) throw new Error("changed");
    return {
      path: descriptorPath(fd, indexPath),
      identity: fileIdentity(readAfter),
      digest,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

function assertBoundedIndexSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > WIKI_CORPUS_LIMITS.maxIndexBytes) {
    throw new WikiCorpusLimitError("maxIndexBytes");
  }
}

/** Hash one bound descriptor with fixed working memory and positional reads. */
function hashBoundedIndex(fd: number, size: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < size) {
    const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.byteLength, size - offset), offset);
    if (bytesRead <= 0) throw new Error("short-read");
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest("hex");
}

function descriptorPath(fd: number, fallback: string): string {
  if (process.platform === "win32") return fallback;
  for (const prefix of ["/dev/fd", "/proc/self/fd"]) {
    const candidate = `${prefix}/${fd}`;
    try {
      statSync(candidate);
      return candidate;
    } catch {
      // Try the next descriptor namespace.
    }
  }
  throw new Error("descriptor-path-unavailable");
}

function observeCorpus(scaffoldRoot: string, exclude: readonly string[] | undefined): CorpusObservation {
  const discovery = discoverMarkdownFiles({ root: scaffoldRoot, exclude });
  const files: { path: string; contentHash: string }[] = [];
  const diagnostics = discovery.diagnostics
    .map(safeDiagnostic)
    .slice(0, WIKI_CORPUS_LIMITS.maxDiagnostics);
  let omittedDiagnostics = Math.max(0, discovery.diagnostics.length - diagnostics.length);
  let stable = diagnostics.every((entry) => entry.severity !== "error");
  let corpusBytes = 0;
  const report = (entry: WikiDiagnostic): void => {
    if (diagnostics.length < WIKI_CORPUS_LIMITS.maxDiagnostics - 1) diagnostics.push(entry);
    else omittedDiagnostics += 1;
  };
  for (const file of discovery.files) {
    try {
      const bytes = readContainedFile(scaffoldRoot, file.absolutePath);
      corpusBytes = addWikiCorpusBytes(corpusBytes, bytes.byteLength);
      files.push({ path: file.path, contentHash: exactFileContentHash(bytes) });
    } catch (error) {
      stable = false;
      if (error instanceof WikiCorpusLimitError) {
        report(diagnostic(
          "WIKI_PARSE_ERROR",
          "The canonical Wiki corpus exceeds MEX's bounded inspection policy.",
          {
            remediation: "Narrow the configured Wiki corpus before retrying inspection.",
          },
        ));
        break;
      }
      report(diagnostic("WIKI_PARSE_ERROR", `Could not inspect ${file.path} safely.`, { file: file.path }));
    }
  }
  if (omittedDiagnostics > 0) {
    if (diagnostics.length === WIKI_CORPUS_LIMITS.maxDiagnostics) {
      diagnostics.pop();
      omittedDiagnostics += 1;
    }
    diagnostics.push(diagnostic(
      "WIKI_PARSE_ERROR",
      `${omittedDiagnostics} additional Wiki corpus diagnostic(s) were omitted.`,
      {
        severity: "info",
        remediation: "Resolve the visible diagnostics, then inspect again for any remaining issues.",
      },
    ));
  }
  files.sort((left, right) => compareString(left.path, right.path));
  return { revision: indexedCorpusRevision(files), files, diagnostics, stable };
}

function sameFileInventory(
  left: readonly { path: string; contentHash: string }[],
  right: readonly { path: string; contentHash: string }[],
): boolean {
  return left.length === right.length
    && left.every((file, index) => (
      file.path === right[index]?.path
      && file.contentHash === right[index]?.contentHash
    ));
}

function hasLegacyInventory(scaffoldRoot: string, exclude: readonly string[] | undefined): boolean {
  try {
    const files = discoverMarkdownFiles({ root: scaffoldRoot, exclude }).files;
    if (files.length === 0 || files.length > 10_000) return false;
    let sawLegacyShape = false;
    let sawCanonicalShape = false;
    let corpusBytes = 0;
    for (const file of files) {
      const bytes = readContainedFile(scaffoldRoot, file.absolutePath);
      corpusBytes = addWikiCorpusBytes(corpusBytes, bytes.byteLength);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (/(?:^|\n)[ \t]*mex:[ \t]*(?:\r?\n|$)|<!--[ \t]*mex:entity\b/u.test(text)) {
        sawCanonicalShape = true;
      } else if (/^(?:ROUTER|AGENTS|SETUP|SYNC)\.md$/i.test(file.path)
        || /^(?:context|patterns)\//i.test(file.path)
        || /(?:^|\n)(?:name|description|last_updated|edges|grounds_to):/u.test(text)) {
        sawLegacyShape = true;
      }
    }
    return !sawCanonicalShape && sawLegacyShape;
  } catch (error) {
    if (error instanceof WikiCorpusLimitError) throw error;
    return false;
  }
}

function readContainedFile(root: string, candidate: string): Uint8Array {
  // Use the same descriptor-bound/no-follow acceptance rule as rebuild and
  // refresh. Re-encoding is byte-exact for the accepted, fatal UTF-8 domain.
  return Buffer.from(readContainedSource(root, candidate), "utf8");
}

function readSchemaVersion(db: SqliteDatabase): number | null {
  const value = readMeta(db, WIKI_META_KEYS.schemaVersion);
  if (value === null || !/^\d+$/.test(value)) return null;
  const version = Number(value);
  return Number.isSafeInteger(version) ? version : null;
}

const EXPECTED_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  wiki_meta: ["key", "value"],
  wiki_files: ["path", "content_hash", "parse_status", "entity_count", "text_length", "indexed_at"],
  wiki_entities: [
    "entity_key", "id", "shadowed", "file", "type", "title", "summary", "body", "status", "revision",
    "metadata_kind", "metadata_start", "metadata_end", "heading_start", "heading_end", "body_start", "body_end",
    "start_line", "end_line", "heading_depth", "file_content_hash", "entity_content_hash", "provenance", "metadata",
  ],
  wiki_relations: ["source_key", "ordinal", "type", "target_id", "target_resolved", "note", "metadata"],
  wiki_entity_topics: ["entity_key", "ordinal", "topic_entity_id"],
  wiki_sources: ["entity_key", "ordinal", "type", "ref", "note", "repository", "commit_sha", "captured_at", "identity", "metadata"],
  wiki_groundings: [
    "entity_key", "ordinal", "node_id", "fingerprint", "body_hash", "code_hash", "file", "commit_sha", "verified_at", "reason",
    "state", "resolved_node", "health", "resolution",
  ],
  wiki_diagnostics: [
    "scope", "code", "severity", "message", "file", "entity_id", "path", "start_offset", "end_offset",
    "start_line", "end_line", "remediation",
  ],
  wiki_fts: ["entity_key", "title", "summary", "body", "aliases", "meta"],
};

const REQUIRED_INDEXES = [
  "wiki_diagnostics_scope",
  "wiki_entities_file",
  "wiki_entities_id",
  "wiki_entities_status",
  "wiki_entities_title",
  "wiki_entity_topics_topic",
  "wiki_groundings_node",
  "wiki_relations_target",
] as const;

type StoredTextField = readonly [name: string, maxBytes: number, nullable?: boolean];
type StoredIntegerField = readonly [name: string, nullable?: boolean];

const INDEX_TEXT_FIELDS: Readonly<Record<string, readonly StoredTextField[]>> = {
  wiki_meta: [["key", 256], ["value", 4_096]],
  wiki_files: [
    ["path", 4_096], ["content_hash", 64], ["parse_status", 32], ["indexed_at", 256],
  ],
  wiki_entities: [
    ["entity_key", 4_128], ["id", 256], ["file", 4_096], ["type", 256], ["title", 4_096],
    ["summary", 65_536, true], ["body", 8 * 1024 * 1024], ["status", 32],
    ["file_content_hash", 64], ["entity_content_hash", 64],
    ["provenance", 65_536, true], ["metadata", 65_536, true],
  ],
  wiki_relations: [
    ["source_key", 4_128], ["type", 256], ["target_id", 256],
    ["note", 65_536, true], ["metadata", 65_536, true],
  ],
  wiki_entity_topics: [["entity_key", 4_128], ["topic_entity_id", 256]],
  wiki_sources: [
    ["entity_key", 4_128], ["type", 256], ["ref", 4_096, true], ["note", 65_536, true],
    ["repository", 4_096, true], ["commit_sha", 256, true], ["captured_at", 256, true],
    ["identity", 8_192], ["metadata", 65_536, true],
  ],
  wiki_groundings: [
    ["entity_key", 4_128], ["node_id", 4_096], ["fingerprint", WIKI_CORPUS_LIMITS.maxFileBytes], ["body_hash", 256, true],
    ["code_hash", 256, true], ["file", 4_096, true], ["commit_sha", 256, true], ["verified_at", 256, true],
    ["reason", 65_536, true], ["state", 32, true], ["resolved_node", 4_096, true],
    ["health", 32, true], ["resolution", 65_536, true],
  ],
  wiki_diagnostics: [
    ["scope", 32], ["code", 256], ["severity", 32], ["message", 65_536], ["file", 4_096, true],
    ["entity_id", 256, true], ["path", 4_096, true], ["remediation", 65_536, true],
  ],
  wiki_fts: [
    ["entity_key", 4_128], ["title", 4_096, true], ["summary", 65_536, true],
    ["body", 8 * 1024 * 1024, true], ["aliases", 65_536, true], ["meta", 65_536, true],
  ],
};

const INDEX_INTEGER_FIELDS: Readonly<Record<string, readonly StoredIntegerField[]>> = {
  wiki_files: [["entity_count"], ["text_length"]],
  wiki_entities: [
    ["shadowed"], ["revision"], ["metadata_start"], ["metadata_end"], ["heading_start"],
    ["heading_end"], ["body_start"], ["body_end"], ["start_line"], ["end_line"], ["heading_depth"],
  ],
  wiki_relations: [["ordinal"], ["target_resolved"]],
  wiki_entity_topics: [["ordinal"]],
  wiki_sources: [["ordinal"]],
  wiki_groundings: [["ordinal"]],
  wiki_diagnostics: [
    ["start_offset", true], ["end_offset", true], ["start_line", true], ["end_line", true],
  ],
};

/** Full v3 structural and row-safety validation before any projection runs. */
function validateIndexStructure(db: SqliteDatabase): string | null {
  try {
    const quick = db.prepare(`PRAGMA quick_check(100)`).all() as Array<Record<string, unknown>>;
    if (quick.length !== 1 || String(quick[0]?.["quick_check"] ?? "") !== "ok") {
      return "The wiki index failed SQLite integrity validation.";
    }

    const oversizedSchema = db.prepare(
      `SELECT 1 FROM sqlite_master
       WHERE (typeof(name) <> 'text' OR length(CAST(name AS BLOB)) > 4096
          OR (sql IS NOT NULL AND (typeof(sql) <> 'text' OR length(CAST(sql AS BLOB)) > 1048576)))
       LIMIT 1`,
    ).get();
    if (oversizedSchema) return "The wiki index contains oversized schema metadata.";

    const declaredTables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name LIMIT 100`,
    ).all() as { name: string }[];
    const names = new Set(declaredTables.map((row) => row.name));
    if (WIKI_TABLES.some((table) => !names.has(table))) return "The wiki index is missing a required schema-v3 table.";
    for (const [table, expected] of Object.entries(EXPECTED_TABLE_COLUMNS)) {
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
      if (columns.length !== expected.length || columns.some((column, index) => column !== expected[index])) {
        return `The wiki index table ${table} does not match schema v3.`;
      }
    }
    const indexes = new Set((db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 100`,
    ).all() as { name: string }[]).map((row) => row.name));
    if (REQUIRED_INDEXES.some((name) => !indexes.has(name))) return "The wiki index is missing a required schema-v3 index.";
    if (Object.entries(INDEX_TEXT_FIELDS).some(([table, fields]) => (
      hasUnsafeStoredText(db, table, fields)
    ))) return "The wiki index contains an oversized or mistyped persisted text value.";
    if (Object.entries(INDEX_INTEGER_FIELDS).some(([table, fields]) => (
      hasUnsafeStoredInteger(db, table, fields)
    ))) return "The wiki index contains a mistyped persisted integer value.";

    const metaRows = db.prepare(`SELECT key, value FROM wiki_meta ORDER BY key LIMIT 100`).all() as Array<{ key: string; value: string }>;
    const meta = new Map(metaRows.map((row) => [row.key, row.value]));
    const expectedMeta = Object.values(WIKI_META_KEYS).sort(compareString);
    if (metaRows.length !== expectedMeta.length
      || metaRows.map((row) => row.key).sort(compareString).some((key, index) => key !== expectedMeta[index])) {
      return "The wiki index metadata keys do not match schema v3.";
    }
    if (meta.get(WIKI_META_KEYS.schemaVersion) !== String(WIKI_SCHEMA_VERSION)
      || !isContentHash(meta.get(WIKI_META_KEYS.indexedRevision) ?? "")
      || Number.isNaN(Date.parse(meta.get(WIKI_META_KEYS.builtAt) ?? ""))
      || !["rebuild", "refresh"].includes(meta.get(WIKI_META_KEYS.buildKind) ?? "")) {
      return "The wiki index metadata values are invalid.";
    }
    const expectedFileCount = strictStoredCount(meta.get(WIKI_META_KEYS.fileCount));
    const expectedEntityCount = strictStoredCount(meta.get(WIKI_META_KEYS.entityCount));
    if (expectedFileCount === null
      || expectedFileCount > WIKI_CORPUS_LIMITS.maxMarkdownFiles
      || expectedEntityCount === null) return "The wiki index metadata counts are invalid.";

    let fileRowCount = 0;
    const fileRows = db.prepare(
      `SELECT path, content_hash, parse_status, entity_count, text_length, indexed_at
       FROM wiki_files ORDER BY path LIMIT ${WIKI_CORPUS_LIMITS.maxMarkdownFiles + 1}`,
    ).iterate() as IterableIterator<Record<string, unknown>>;
    for (const row of fileRows) {
      fileRowCount += 1;
      if (fileRowCount > WIKI_CORPUS_LIMITS.maxMarkdownFiles) {
        return "The wiki index file inventory exceeds its safety bound.";
      }
      if (!isSafeRepoPath(row["path"]) || !isContentHash(String(row["content_hash"] ?? ""))
        || !["ok", "diagnostics"].includes(String(row["parse_status"] ?? ""))
        || !isStoredInteger(row["entity_count"], 0) || !isStoredInteger(row["text_length"], 0)
        || Number.isNaN(Date.parse(String(row["indexed_at"] ?? "")))) {
        return "The wiki index contains an unsafe file row.";
      }
    }
    if (fileRowCount !== expectedFileCount) return "The wiki index file inventory is invalid.";

    let entityRowCount = 0;
    let activeEntityCount = 0;
    const entityRows = db.prepare(
      `SELECT id, file, type, title, summary, body, status, revision, file_content_hash, entity_content_hash,
              provenance, metadata, metadata_start, metadata_end, heading_start, heading_end, body_start, body_end,
              start_line, end_line, heading_depth, shadowed
         FROM wiki_entities ORDER BY entity_key LIMIT 100001`,
    ).iterate() as IterableIterator<Record<string, unknown>>;
    for (const row of entityRows) {
      entityRowCount += 1;
      if (entityRowCount > 100_000) return "The wiki index entity inventory exceeds its safety bound.";
      if (Number(row["shadowed"]) === 0) activeEntityCount += 1;
      if (!isEntityId(row["id"]) || !isSafeRepoPath(row["file"])
        || !isBoundedString(row["type"], 256, 1) || !isBoundedString(row["title"], 4096, 1)
        || (row["summary"] !== null && !isBoundedString(row["summary"], 65_536))
        || !isBoundedString(row["body"], 8 * 1024 * 1024)
        || !["in_flight", "promoted", "deprecated", "archived"].includes(String(row["status"] ?? ""))
        || !isStoredInteger(row["revision"], 1) || !isContentHash(String(row["file_content_hash"] ?? ""))
        || !isContentHash(String(row["entity_content_hash"] ?? ""))
        || !validProvenanceJson(row["provenance"]) || !validBoundedJson(row["metadata"])
        || !validEntityRanges(row)) {
        return "The wiki index contains an unsafe entity row.";
      }
    }
    if (activeEntityCount !== expectedEntityCount) return "The wiki index entity inventory is invalid.";

    let relationRowCount = 0;
    const relationRows = db.prepare(
      `SELECT type, target_id, note, metadata FROM wiki_relations ORDER BY source_key, ordinal LIMIT 100001`,
    ).iterate() as IterableIterator<Record<string, unknown>>;
    for (const row of relationRows) {
      relationRowCount += 1;
      if (relationRowCount > 100_000) return "The wiki index relation inventory exceeds its safety bound.";
      if (!isBoundedString(row["type"], 256, 1) || !isEntityId(row["target_id"])
        || (row["note"] !== null && !isBoundedString(row["note"], 65_536)) || !validBoundedJson(row["metadata"])) {
        return "The wiki index contains an unsafe relation row.";
      }
    }
    let topicRowCount = 0;
    const topicRows = db.prepare(
      `SELECT topic_entity_id FROM wiki_entity_topics ORDER BY entity_key, ordinal LIMIT 100001`,
    ).iterate() as IterableIterator<Record<string, unknown>>;
    for (const row of topicRows) {
      topicRowCount += 1;
      if (topicRowCount > 100_000) return "The wiki index topic inventory exceeds its safety bound.";
      if (!isEntityId(row["topic_entity_id"])) return "The wiki index contains an unsafe topic row.";
    }

    let sourceRowCount = 0;
    const sourceRows = db.prepare(
      `SELECT type, ref, note, repository, commit_sha, captured_at, identity, metadata
         FROM wiki_sources ORDER BY entity_key, ordinal LIMIT 100001`,
    ).iterate() as IterableIterator<Record<string, unknown>>;
    for (const row of sourceRows) {
      sourceRowCount += 1;
      if (sourceRowCount > 100_000) return "The wiki index source inventory exceeds its safety bound.";
      if (!isBoundedString(row["type"], 256, 1) || !isBoundedNullableString(row["ref"], 4096)
        || !isBoundedNullableString(row["note"], 65_536) || !isBoundedNullableString(row["repository"], 4096)
        || !isBoundedNullableString(row["commit_sha"], 256) || !isBoundedNullableString(row["captured_at"], 256)
        || !isBoundedString(row["identity"], 8192, 1) || !validBoundedJson(row["metadata"])
        || (row["type"] === "file" && row["ref"] !== null && !isSafeRepoPath(row["ref"]))) {
        return "The wiki index contains an unsafe source row.";
      }
    }

    let groundingRowCount = 0;
    const groundingRows = db.prepare(
      `SELECT node_id, fingerprint, body_hash, code_hash, file, commit_sha, verified_at, reason, state, resolved_node, health, resolution
         FROM wiki_groundings ORDER BY entity_key, ordinal LIMIT 100001`,
    ).iterate() as IterableIterator<Record<string, unknown>>;
    for (const row of groundingRows) {
      groundingRowCount += 1;
      if (groundingRowCount > 100_000) return "The wiki index grounding inventory exceeds its safety bound.";
      if (!isBoundedString(row["node_id"], 4096, 1)
        || !isBoundedString(row["fingerprint"], WIKI_CORPUS_LIMITS.maxFileBytes, 1)
        || !isBoundedNullableString(row["body_hash"], 256) || !isBoundedNullableString(row["code_hash"], 256)
        || (row["file"] !== null && !isSafeRepoPath(row["file"]))
        || !isBoundedNullableString(row["commit_sha"], 256) || !isBoundedNullableString(row["verified_at"], 256)
        || !isBoundedNullableString(row["reason"], 65_536) || !isBoundedNullableString(row["resolved_node"], 4096)
        || !validBoundedJson(row["resolution"])) {
        return "The wiki index contains an unsafe grounding row.";
      }
      if (row["state"] !== null && !["fresh", "stale", "missing", "unresolved", "ungrounded"].includes(String(row["state"]))) {
        return "The wiki index contains an invalid grounding state.";
      }
      if (row["health"] !== null && !["fresh", "changed", "missing", "ambiguous", "unverified"].includes(String(row["health"]))) {
        return "The wiki index contains an invalid grounding health.";
      }
    }

    let diagnosticRowCount = 0;
    const diagnosticRows = db.prepare(
      `SELECT code, severity, message, file, entity_id, path, start_offset, end_offset,
              start_line, end_line, remediation
         FROM wiki_diagnostics
        ORDER BY scope, code, file, entity_id, path, start_offset, message LIMIT 100001`,
    ).iterate() as IterableIterator<Record<string, unknown>>;
    for (const row of diagnosticRows) {
      diagnosticRowCount += 1;
      if (diagnosticRowCount > 100_000) return "The wiki index diagnostic inventory exceeds its safety bound.";
      if (!isWikiDiagnosticCode(row["code"])
        || !["error", "warning", "info"].includes(String(row["severity"] ?? ""))
        || !isBoundedString(row["message"], 65_536, 1)
        || (row["file"] !== null && !isSafeRepoPath(row["file"]))
        || (row["entity_id"] !== null && !isEntityId(row["entity_id"]))
        || !isBoundedNullableDiagnosticPath(row["path"])
        || !isBoundedNullableString(row["remediation"], 65_536)
        || !isNullableStoredInteger(row["start_offset"], 0)
        || !isNullableStoredInteger(row["end_offset"], 0)
        || !isNullableStoredInteger(row["start_line"], 1)
        || !isNullableStoredInteger(row["end_line"], 1)
        || !validOptionalRange(row["start_offset"], row["end_offset"])
        || !validOptionalRange(row["start_line"], row["end_line"])) {
        return "The wiki index contains an unsafe diagnostic row.";
      }
    }
    return null;
  } catch {
    return "The wiki index schema or rows could not be validated safely.";
  }
}

function hasUnsafeStoredText(
  db: SqliteDatabase,
  table: string,
  fields: readonly StoredTextField[],
): boolean {
  if (!/^[a-z_]+$/u.test(table)
    || fields.some(([field]) => !/^[a-z_]+$/u.test(field))) {
    throw new Error("Unsafe internal Wiki schema identifier.");
  }
  const checks = fields.map(([field, maxBytes, nullable]) => nullable
    ? `(${field} IS NOT NULL AND (typeof(${field}) <> 'text' OR length(CAST(${field} AS BLOB)) > ${maxBytes}))`
    : `(typeof(${field}) <> 'text' OR length(CAST(${field} AS BLOB)) > ${maxBytes})`);
  return db.prepare(`SELECT 1 FROM ${table} WHERE ${checks.join(" OR ")} LIMIT 1`).get() !== undefined;
}

function hasUnsafeStoredInteger(
  db: SqliteDatabase,
  table: string,
  fields: readonly StoredIntegerField[],
): boolean {
  if (!/^[a-z_]+$/u.test(table)
    || fields.some(([field]) => !/^[a-z_]+$/u.test(field))) {
    throw new Error("Unsafe internal Wiki schema identifier.");
  }
  const checks = fields.map(([field, nullable]) => nullable
    ? `(${field} IS NOT NULL AND typeof(${field}) <> 'integer')`
    : `(typeof(${field}) <> 'integer')`);
  return db.prepare(`SELECT 1 FROM ${table} WHERE ${checks.join(" OR ")} LIMIT 1`).get() !== undefined;
}

function strictStoredCount(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 && count <= 100_000 ? count : null;
}

function isStoredInteger(value: unknown, minimum: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isNullableStoredInteger(value: unknown, minimum: number): boolean {
  return value === null || isStoredInteger(value, minimum);
}

function validOptionalRange(start: unknown, end: unknown): boolean {
  return start === null || end === null || Number(start) <= Number(end);
}

function isBoundedString(value: unknown, maxBytes: number, minBytes = 0): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") >= minBytes
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !value.includes("\0");
}

function isBoundedNullableString(value: unknown, maxBytes: number): boolean {
  return value === null || isBoundedString(value, maxBytes);
}

function isBoundedNullableDiagnosticPath(value: unknown): boolean {
  return value === null || (
    isBoundedString(value, 4096)
    && !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isSafeRepoPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function validEntityRanges(row: Record<string, unknown>): boolean {
  const fields = ["metadata_start", "metadata_end", "heading_start", "heading_end", "body_start", "body_end"];
  if (fields.some((field) => !isStoredInteger(row[field], 0))) return false;
  if (!isStoredInteger(row["start_line"], 1) || !isStoredInteger(row["end_line"], 1)
    || !isStoredInteger(row["heading_depth"], 0) || Number(row["heading_depth"]) > 6) return false;
  return Number(row["metadata_start"]) <= Number(row["metadata_end"])
    && Number(row["heading_start"]) <= Number(row["heading_end"])
    && Number(row["body_start"]) <= Number(row["body_end"]);
}

function validBoundedJson(value: unknown): boolean {
  if (value === null) return true;
  if (!isBoundedString(value, 65_536)) return false;
  try {
    return validJsonValue(JSON.parse(value), 0, { nodes: 0 });
  } catch {
    return false;
  }
}

function validProvenanceJson(value: unknown): boolean {
  if (value === null) return true;
  if (!isBoundedString(value, 65_536)) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isPlainRecord(parsed)) return false;
    const allowed = new Set([
      "createdBy",
      "createdAt",
      "lastModifiedBy",
      "lastModifiedAt",
      "agentSessionId",
    ]);
    if (Object.keys(parsed).some((key) => !allowed.has(key))) return false;
    if (!validProvenanceActor(parsed["createdBy"])) return false;
    if (parsed["lastModifiedBy"] !== undefined && !validProvenanceActor(parsed["lastModifiedBy"])) return false;
    if (!validOptionalIsoTimestamp(parsed["createdAt"]) || !validOptionalIsoTimestamp(parsed["lastModifiedAt"])) return false;
    return parsed["agentSessionId"] === undefined || isBoundedString(parsed["agentSessionId"], 4096, 1);
  } catch {
    return false;
  }
}

function validProvenanceActor(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2
    && keys.includes("kind")
    && keys.includes("id")
    && ["human", "agent", "system"].includes(String(value["kind"] ?? ""))
    && isBoundedString(value["id"], 4096, 1);
}

function validOptionalIsoTimestamp(value: unknown): boolean {
  return value === undefined || (
    isBoundedString(value, 256, 1)
    && !Number.isNaN(Date.parse(value))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validJsonValue(value: unknown, depth: number, budget: { nodes: number }): boolean {
  budget.nodes += 1;
  if (budget.nodes > 2048 || depth > 12) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return isBoundedString(value, 16_384);
  if (Array.isArray(value)) return value.length <= 256 && value.every((item) => validJsonValue(item, depth + 1, budget));
  if (typeof value !== "object") return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 256 && entries.every(([key, item]) => (
    isBoundedString(key, 256, 1) && validJsonValue(item, depth + 1, budget)
  ));
}

function readMeta(db: SqliteDatabase, key: string): string | null {
  try {
    const row = db.prepare(`SELECT value FROM wiki_meta WHERE key = ? LIMIT 1`).get(key) as { value?: unknown } | undefined;
    return typeof row?.value === "string" ? row.value : null;
  } catch {
    return null;
  }
}

function readDiagnostics(db: SqliteDatabase, limit: number, entityId?: string): WikiDiagnostic[] {
  const where = entityId === undefined ? "" : "WHERE entity_id = ?";
  const params = entityId === undefined ? [] : [entityId];
  const rows = db.prepare(
    `SELECT code, severity, message, file, entity_id, path, start_offset, end_offset, start_line, end_line, remediation
       FROM wiki_diagnostics ${where}
      ORDER BY severity, code, file, entity_id, path, start_offset, message LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>;
  return projectDiagnosticRows(rows);
}

function readFilteredDiagnostics(
  db: SqliteDatabase,
  limit: number,
  request: Pick<ContractDiagnosticRequest, "entityIds" | "paths">,
): WikiDiagnostic[] {
  const { where, params } = diagnosticFilterSql(request);
  const rows = db.prepare(
    `SELECT d.code, d.severity, d.message, d.file, d.entity_id, d.path,
            d.start_offset, d.end_offset, d.start_line, d.end_line, d.remediation
       FROM wiki_diagnostics d ${where}
      ORDER BY d.severity, d.code, d.file, d.entity_id, d.path, d.start_offset, d.message LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>;
  return projectDiagnosticRows(rows);
}

function diagnosticFilterSql(
  request: Pick<ContractDiagnosticRequest, "entityIds" | "paths">,
): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (request.entityIds !== undefined) {
    if (request.entityIds.length === 0) clauses.push("0");
    else {
      clauses.push(`d.entity_id IN (${placeholders(request.entityIds.length)})`);
      params.push(...request.entityIds);
    }
  }
  if (request.paths !== undefined) {
    if (request.paths.length === 0) clauses.push("0");
    else {
      // Match the mock/frozen boundary: an explicit diagnostic path wins;
      // otherwise use the canonical entity location, then the diagnostic file.
      clauses.push(`COALESCE(
        d.path,
        (SELECT e.file
           FROM wiki_entities e
          WHERE e.id = d.entity_id AND e.shadowed = 0
          ORDER BY e.entity_key
          LIMIT 1),
        d.file
      ) IN (${placeholders(request.paths.length)})`);
      params.push(...request.paths);
    }
  }
  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  return { where, params };
}

function projectDiagnosticRows(rows: readonly Record<string, unknown>[]): WikiDiagnostic[] {
  return rows.map((row) => safeDiagnostic({
    code: String(row["code"]) as WikiDiagnostic["code"],
    severity: String(row["severity"]) as WikiDiagnostic["severity"],
    message: String(row["message"]),
    ...(row["file"] === null ? {} : { file: String(row["file"]) }),
    ...(row["entity_id"] === null ? {} : { entityId: String(row["entity_id"]) }),
    ...(row["path"] === null ? {} : { path: String(row["path"]) }),
    ...(row["remediation"] === null ? {} : { remediation: String(row["remediation"]) }),
    ...(row["start_offset"] === null && row["end_offset"] === null && row["start_line"] === null && row["end_line"] === null
      ? {}
      : { location: {
          ...(row["file"] === null ? {} : { file: String(row["file"]) }),
          ...(row["start_offset"] === null ? {} : { startOffset: Number(row["start_offset"]) }),
          ...(row["end_offset"] === null ? {} : { endOffset: Number(row["end_offset"]) }),
          ...(row["start_line"] === null ? {} : { startLine: Number(row["start_line"]) }),
          ...(row["end_line"] === null ? {} : { endLine: Number(row["end_line"]) }),
        } }),
  }));
}

function safeDiagnostic(entry: WikiDiagnostic): WikiDiagnostic {
  const sanitize = (value: string): string => {
    const bounded = value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 65_536);
    return containsLocalPath(bounded)
      ? "Wiki diagnostic detail was withheld because it contained a local path."
      : bounded;
  };
  const projected: WikiDiagnostic = {
    ...entry,
    message: sanitize(entry.message),
    ...(entry.remediation === undefined ? {} : {
      remediation: sanitize(entry.remediation),
    }),
  };
  if (projected.file !== undefined
    && (isAbsolute(projected.file) || projected.file.includes("\\") || projected.file.split("/").includes(".."))) {
    delete projected.file;
  }
  return projected;
}

function containsLocalPath(value: string): boolean {
  if (/\bfile:(?:\/\/)?(?:\/|[A-Za-z]:[\\/]|\\\\)/iu.test(value)) return true;
  const withoutUrls = value.replace(/\bhttps?:\/\/[^\s"'`]+/giu, "");
  return /(?:^|[^A-Za-z0-9/])\/(?!\/)/u.test(withoutUrls)
    || /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/u.test(withoutUrls)
    || /(?:^|[^\\])\\\\[^\\]/u.test(withoutUrls);
}

function status(
  stateValue: ContractWikiIndexState,
  observedAt: string,
  schemaVersion: number | null,
  indexedRevision: string | null,
  indexedAt: string | null,
  diagnostics: readonly WikiDiagnostic[],
): ContractWikiIndexStatus {
  return { state: stateValue, observedAt, schemaVersion, indexedRevision, indexedAt, diagnostics: diagnostics.slice(0, 100) };
}

function revalidateObservedStatus(
  indexPath: string,
  expected: BoundIndex,
  observed: ContractWikiIndexStatus,
): ContractWikiIndexStatus {
  if (pathStillNamesBoundIndex(indexPath, expected)) return observed;
  return status(
    "degraded",
    observed.observedAt,
    observed.schemaVersion,
    observed.indexedRevision,
    observed.indexedAt,
    [diagnostic("WIKI_INDEX_REBUILD_REQUIRED", "The wiki index changed during inspection; retry the read.")],
  );
}

function pathStillNamesBoundIndex(indexPath: string, expected: BoundIndex): boolean {
  if (inspectIndexSidecars(indexPath).state !== "clear") return false;
  let current: BoundIndex | null = null;
  try {
    current = bindIndex(indexPath);
    return current.identity === expected.identity && current.digest === expected.digest;
  } catch {
    return false;
  } finally {
    current?.close();
  }
}

function aggregateHealth(groundings: readonly ContractGrounding[]): GroundingHealth {
  if (groundings.length === 0) return "unverified";
  const health = groundings.map((grounding) => grounding.resolution?.["health"])
    .filter((value): value is GroundingHealth => (
      typeof value === "string" && ["fresh", "changed", "missing", "ambiguous", "unverified"].includes(value)
    ));
  return health.sort((left, right) => groundingPrecedence(left) - groundingPrecedence(right))[0] ?? "unverified";
}

function groundingPrecedence(value: GroundingHealth): number {
  return ({ missing: 0, ambiguous: 1, changed: 2, unverified: 3, fresh: 4 } as const)[value];
}

function compareSearchHits(left: ContractSearchHit, right: ContractSearchHit): number {
  // Every all-terms hit before any some-terms hit; those by coverage (#235).
  const tier = Number(left.match === "some_terms") - Number(right.match === "some_terms");
  if (tier !== 0) return tier;
  const coverage = (right.score ?? 0) - (left.score ?? 0);
  if (coverage !== 0) return coverage;
  const field = MATCH_FIELD_RANK[left.matchedFields[0]!] - MATCH_FIELD_RANK[right.matchedFields[0]!];
  if (field !== 0) return field;
  const lifecycle = (LIFECYCLE_RANK[left.entity.lifecycleState] ?? 3) - (LIFECYCLE_RANK[right.entity.lifecycleState] ?? 3);
  if (lifecycle !== 0) return lifecycle;
  const health = healthRank(left.entity.groundingHealth) - healthRank(right.entity.groundingHealth);
  if (health !== 0) return health;
  const relevance = (left.relevance ?? 0) - (right.relevance ?? 0);
  return relevance !== 0 ? relevance : compareEntitySummary(left.entity, right.entity);
}

function compareEntitySummary(left: ContractEntitySummary, right: ContractEntitySummary): number {
  return left.title === right.title ? compareString(left.id, right.id) : compareString(left.title, right.title);
}

function compareRelations(left: ContractRelation, right: ContractRelation): number {
  return compareString(left.type, right.type)
    || compareString(left.target.title ?? "", right.target.title ?? "")
    || compareString(left.target.id, right.target.id)
    || compareString(left.source.id, right.source.id);
}

function compareRelationHits(left: ContractRelationHit, right: ContractRelationHit): number {
  return compareString(left.relation.type, right.relation.type)
    || compareString(left.entity?.title ?? "", right.entity?.title ?? "")
    || compareString(left.entity?.id ?? "", right.entity?.id ?? "")
    || compareString(left.direction, right.direction)
    || compareRelations(left.relation, right.relation);
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseObject<T>(value: string | null): T | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Probe recovery namespaces without opening SQLite or mutating a sidecar.
 *
 * WAL and rollback-journal payloads are authoritative recovery state, so a
 * non-empty regular file is active. A regular SHM file alone has no database
 * pages, but its namespace still has to be a readable, non-symlink regular
 * file. Every error other than ENOENT is unavailable and fails closed.
 */
function inspectIndexSidecars(
  indexPath: string,
  beforeStat?: (path: string) => void,
): ContractSidecarProbe {
  const active: string[] = [];
  const unavailable: string[] = [];
  for (const suffix of ["-journal", "-wal", "-shm"] as const) {
    const path = `${indexPath}${suffix}`;
    const safePath = `wiki.db${suffix}`;
    try {
      beforeStat?.(path);
      const stats = lstatSync(path);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        unavailable.push(safePath);
        continue;
      }
      try {
        accessSync(path, constants.R_OK);
      } catch {
        unavailable.push(safePath);
        continue;
      }
      if (suffix !== "-shm" && stats.size > 0) active.push(safePath);
    } catch (error) {
      if (!isMissing(error)) unavailable.push(safePath);
    }
  }
  if (unavailable.length > 0) {
    return { state: "unavailable", paths: [...unavailable, ...active].sort(compareString) };
  }
  return active.length > 0
    ? { state: "active", paths: active.sort(compareString) }
    : { state: "clear", paths: [] };
}

function sameIdentity(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return fileIdentity(left) === fileIdentity(right);
}

function fileIdentity(value: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return JSON.stringify([value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs]);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function emptyPage<T>(): ContractPage<T> {
  return { items: [], nextCursor: null, estimatedTokens: 0, truncated: false };
}
