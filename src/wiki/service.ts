/**
 * §7.2's `WikiEngine` — the programmatic surface a consumer binds to.
 *
 * > CLI commands and the Hub must call this service rather than implementing
 * > independent parsing or SQL.  — §7.2
 *
 * ## What this is, and what it deliberately is not
 *
 * It is a **thin async adapter over `service/`**, and every method here is one
 * call into a function that already exists. P9 drew that line and wrote down
 * why: everything underneath is `node:sqlite` and `readFileSync`, so the
 * synchronous functions are the honest shape of the work, and an `async`
 * surface at that layer would be promises wrapped around nothing. §7.2 asks for
 * promises at *this* layer, so this is where they go — in one adapter, once.
 *
 * It is **not** a place where a return shape gets adjusted to fit the
 * interface. Where mex's answer and §7.2's signature disagree, the disagreement
 * is recorded rather than smoothed over; there are three, all documented on the
 * methods concerned (`validate`, `related`, and the migration pair).
 *
 * ## Why every method returns diagnostics
 *
 * §7.2 writes `list(): Promise<WikiEntitySummary[]>`. Taken literally that
 * throws away the diagnostics half of `ServiceResult`, and a wiki answer is
 * routinely both an answer and a complaint: a `list` that succeeds may still
 * report a duplicate id, and a `get` on a scaffold with no index has to be able
 * to say *why* it returned nothing rather than looking like an empty wiki. So
 * the return type is `ServiceResult<T>` throughout — same data, with the
 * diagnostics still attached — and `ok` stays derived from the diagnostics by
 * one definition rather than three.
 *
 * This is the one place the interface was widened rather than met exactly, and
 * it is widened in the direction that loses nothing: a caller that wants
 * §7.2's literal shape reads `.data`.
 *
 * ## Statelessness
 *
 * The engine holds configuration, never a connection. Every call opens the
 * index, answers, and closes — which is what makes two engines over one
 * scaffold, or an engine used across a rebuild, behave the way a caller
 * expects. A long-lived handle would be faster and would also mean a read
 * could serve rows from an index that had been replaced underneath it, since
 * publishing is an atomic rename onto the path this reopens each time.
 */

import { resolve } from "node:path";
import type { WikiDiagnostic } from "./model/diagnostic.js";
import type { EntityTypeRegistry } from "./model/entity.js";
import type { GroundingGraph } from "./grounding/adapter.js";
import type { Neighborhood } from "./query/session.js";
import type { ValidateOptions } from "./validation/validate.js";
import {
  hasReadableIndex,
  wikiBacklinks,
  wikiGet,
  wikiGraph,
  wikiGroundingStatus,
  wikiList,
  wikiNeighborhood,
  wikiSearch,
  type GetData,
  type GraphData,
  type GroundingStatusData,
  type ListData,
  type SearchData,
  type ServiceResult,
  type WikiFilterOptions,
  type WikiServiceOptions,
} from "./service/read.js";
import {
  migrationPlanDigest,
  wikiApplyOperation,
  wikiMigrate,
  wikiPlanOperation,
  wikiRebuildIndex,
  wikiRefreshIndex,
  wikiRegenerateViews,
  type ApplyData,
  type MigrateData,
  type PlanData,
  type RebuildData,
  type RefreshData,
  type RegenerateData,
  type WikiWriteOptions,
} from "./service/write.js";
import { wikiValidate, type ValidateData } from "./service/validate.js";
import { diagnostic } from "./model/diagnostic.js";
import type { RelationEdge } from "./query/rank.js";
import type { WikiPatchPlan } from "./operations/plan.js";
import type { WikiMaintenanceContext } from "./index/maintenance.js";

/** How to reach one scaffold, and what the engine may use while it is there. */
export interface WikiEngineOptions {
  /** Absolute path to the scaffold root — the `.mex` directory. */
  scaffoldRoot: string;
  /** Defaults to `<scaffoldRoot>/wiki.db`. */
  indexPath?: string;
  /** `wiki.exclude` globs. */
  exclude?: readonly string[];
  /** `wiki.readOnly` globs. Enforced at plan time, which is the whole surface. */
  readOnly?: readonly string[];
  registry?: EntityTypeRegistry;
  /**
   * The live code graph.
   *
   * Optional, and its absence is a supported state rather than a degraded one:
   * §23.8 requires that basic wiki reads never need the graph. What it changes
   * is the two things that genuinely cannot be answered without it — minting a
   * grounding, which refuses rather than guessing, and grounding health, which
   * reads null rather than `unverified`.
   */
  graph?: GroundingGraph | null;
}

/**
 * A migration plan, as §7.2's two-phase shape requires.
 *
 * Carries the report a caller reviews and a digest of the work it describes.
 * `applyMigration` re-plans and compares digests, so holding a plan across a
 * change to the scaffold is refused rather than silently applying different
 * work than the one that was reviewed.
 */
export interface MigrationPlan {
  report: MigrateData["report"];
  rendered: string;
  blocked: boolean;
  /** Pins the decided work. See `migrationPlanDigest` for what is and is not in it. */
  digest: string;
}

export interface MigrationApplyResult extends MigrateData {
  /** False when the plan was refused because the scaffold moved under it. */
  applied: boolean;
}

/**
 * The §7.2 service contract.
 *
 * Declared as an interface as well as implemented, because §7.2 is a contract
 * and a contract with exactly one implementation and no declaration is just a
 * class. A second implementation — a remote engine, a test double — binds to
 * this.
 */
export interface WikiEngine {
  rebuildIndex(context?: WikiMaintenanceContext): Promise<ServiceResult<RebuildData>>;
  refreshFiles(paths: readonly string[], context?: WikiMaintenanceContext): Promise<ServiceResult<RefreshData>>;

  list(query?: WikiFilterOptions): Promise<ServiceResult<ListData>>;
  get(id: string, options?: { includeBody?: boolean }): Promise<ServiceResult<GetData>>;
  search(text: string, query?: WikiFilterOptions): Promise<ServiceResult<SearchData>>;
  related(id: string, options?: WikiFilterOptions & { includeBacklinks?: boolean }): Promise<ServiceResult<Neighborhood | null>>;
  backlinks(id: string, options?: WikiFilterOptions): Promise<ServiceResult<{ backlinks: RelationEdge[]; truncated: boolean }>>;

  validate(options?: Partial<ValidateOptions>): Promise<ServiceResult<ValidateData>>;
  planOperation(operation: unknown): Promise<ServiceResult<PlanData>>;
  applyOperation(
    operation: unknown,
    options?: {
      apply?: boolean;
      plan?: WikiPatchPlan;
      expectedPreviewRevision?: string;
    },
  ): Promise<ServiceResult<ApplyData>>;

  planMigration(): Promise<ServiceResult<MigrationPlan>>;
  applyMigration(plan: MigrationPlan): Promise<ServiceResult<MigrationApplyResult>>;
}

/**
 * Everything §7.2 does not name but a Hub needs, kept beside it rather than in
 * a second facade.
 *
 * §17 requires the engine to answer twelve surfaces, and a Hub that had to
 * import `service/read.js` for half of them would be reaching past the contract
 * §7.2 tells it to use. These are the same thin wrappers as the rest.
 */
export interface WikiEngineExtras {
  /** Bounded slice of the relation graph, honest about being a sample. */
  graph(query?: WikiFilterOptions): Promise<ServiceResult<GraphData>>;
  /** Per-entity grounding health — the review-queue surface. */
  groundingStatus(options?: WikiFilterOptions & { id?: string }): Promise<ServiceResult<GroundingStatusData>>;
  /** Rewrite generated sections that have drifted. Derived state, not an operation. */
  regenerateViews(options?: { dryRun?: boolean }): Promise<ServiceResult<RegenerateData>>;
  /** Whether an index exists and can be opened at all. */
  hasIndex(): Promise<boolean>;
}

class WikiEngineImpl implements WikiEngine, WikiEngineExtras {
  constructor(private readonly options: WikiEngineOptions) {}

  private get read(): WikiServiceOptions {
    return {
      scaffoldRoot: resolve(this.options.scaffoldRoot),
      ...(this.options.indexPath === undefined ? {} : { indexPath: this.options.indexPath }),
    };
  }

  private get write(): WikiWriteOptions {
    return {
      ...this.read,
      ...(this.options.exclude === undefined ? {} : { exclude: this.options.exclude }),
      ...(this.options.readOnly === undefined ? {} : { readOnly: this.options.readOnly }),
      ...(this.options.registry === undefined ? {} : { registry: this.options.registry }),
      ...(this.options.graph === undefined ? {} : { graph: this.options.graph }),
    };
  }

  async rebuildIndex(context?: WikiMaintenanceContext): Promise<ServiceResult<RebuildData>> {
    return wikiRebuildIndex({ ...this.write, ...(context === undefined ? {} : { maintenance: context }) });
  }

  async refreshFiles(paths: readonly string[], context?: WikiMaintenanceContext): Promise<ServiceResult<RefreshData>> {
    return wikiRefreshIndex({
      ...this.write,
      changed: paths,
      ...(context === undefined ? {} : { maintenance: context }),
    });
  }

  async list(query: WikiFilterOptions = {}): Promise<ServiceResult<ListData>> {
    return wikiList({ ...this.read, ...query });
  }

  async get(id: string, options: { includeBody?: boolean } = {}): Promise<ServiceResult<GetData>> {
    return wikiGet({ ...this.read, id, ...options });
  }

  async search(text: string, query: WikiFilterOptions = {}): Promise<ServiceResult<SearchData>> {
    return wikiSearch({ ...this.read, ...query, text });
  }

  /**
   * §7.2 names this `related(id, options): Promise<EntityNeighborhood>`.
   *
   * It can return null, and the signature here says so. An id that is not in
   * the index is an ordinary outcome — an entity was deleted, an id was
   * mistyped, the index is behind the files — and the diagnostic beside the
   * null says which. A non-nullable signature would have to throw for that,
   * and §14's whole posture is that a wiki answer is diagnostics rather than
   * exceptions.
   */
  async related(
    id: string,
    options: WikiFilterOptions & { includeBacklinks?: boolean } = {},
  ): Promise<ServiceResult<Neighborhood | null>> {
    return wikiNeighborhood({ ...this.read, ...options, id });
  }

  async backlinks(
    id: string,
    options: WikiFilterOptions = {},
  ): Promise<ServiceResult<{ backlinks: RelationEdge[]; truncated: boolean }>> {
    return wikiBacklinks({ ...this.read, ...options, id });
  }

  /**
   * §7.2 names this `validate(): Promise<WikiDiagnostic[]>`.
   *
   * The diagnostics are there, in `.diagnostics`; the data half (counts,
   * truncation) is kept, so the signature is widened rather than the facts
   * dropped. Code links are `mex check`'s, not validate's.
   */
  async validate(options: Partial<ValidateOptions> = {}): Promise<ServiceResult<ValidateData>> {
    return wikiValidate({
      scaffoldRoot: resolve(this.options.scaffoldRoot),
      ...(this.options.exclude === undefined ? {} : { exclude: this.options.exclude }),
      ...(this.options.registry === undefined ? {} : { registry: this.options.registry }),
      ...options,
    } as ValidateOptions);
  }

  async planOperation(operation: unknown): Promise<ServiceResult<PlanData>> {
    return wikiPlanOperation(operation, this.write);
  }

  /**
   * Plans, and writes only with explicit authority.
   *
   * `apply: true` is that authority and its absence is a plan rather than an
   * error — §5.4's posture, inherited from the service unchanged. An agent that
   * forgets the flag gets a diff, not a write.
   */
  async applyOperation(
    operation: unknown,
    options: {
      apply?: boolean;
      plan?: WikiPatchPlan;
      expectedPreviewRevision?: string;
    } = {},
  ): Promise<ServiceResult<ApplyData>> {
    return wikiApplyOperation(operation, { ...this.write, ...options });
  }

  async planMigration(): Promise<ServiceResult<MigrationPlan>> {
    const result = wikiMigrate({ ...this.write, dryRun: true });
    return {
      data: {
        report: result.data.report,
        rendered: result.data.rendered,
        blocked: result.data.blocked,
        digest: migrationPlanDigest(result.data.report),
      },
      diagnostics: result.diagnostics,
    };
  }

  /**
   * Apply a plan the caller has reviewed — after checking it is still the plan.
   *
   * mex's migration re-plans rather than replaying a stored one, for the same
   * reason `applyOperation` re-derives instead of carrying offsets across the
   * revalidation boundary: a plan built against bytes that have since changed
   * describes work nobody agreed to. So the digest is compared first, and a
   * scaffold that moved is a refusal naming that, not a different migration
   * quietly performed under the old plan's name.
   */
  async applyMigration(plan: MigrationPlan): Promise<ServiceResult<MigrationApplyResult>> {
    const current = wikiMigrate({ ...this.write, dryRun: true });
    const currentDigest = migrationPlanDigest(current.data.report);
    if (currentDigest !== plan.digest) {
      return {
        data: { ...current.data, applied: false },
        diagnostics: [
          ...current.diagnostics,
          // `CONTENT_HASH_CONFLICT` rather than a new code. It is the registry's
          // name for "a precondition over content no longer holds, so re-read
          // and retry", which is exactly this at scaffold scale rather than at
          // entity scale. A `MIGRATION_PLAN_STALE` would put a fifty-second
          // code in a published vocabulary to say the same thing in a narrower
          // voice, and the coverage test would then want an emitter for it.
          diagnostic(
            "CONTENT_HASH_CONFLICT",
            "The scaffold changed since this migration plan was produced, so applying it would perform work that was never reviewed.",
            { remediation: "Run planMigration() again and review the new plan before applying it." },
          ),
        ],
      };
    }
    const result = wikiMigrate({ ...this.write, dryRun: false });
    return { data: { ...result.data, applied: true }, diagnostics: result.diagnostics };
  }

  async graph(query: WikiFilterOptions = {}): Promise<ServiceResult<GraphData>> {
    return wikiGraph({ ...this.read, ...query });
  }

  async groundingStatus(
    options: WikiFilterOptions & { id?: string } = {},
  ): Promise<ServiceResult<GroundingStatusData>> {
    return wikiGroundingStatus({ ...this.read, ...options });
  }

  async regenerateViews(options: { dryRun?: boolean } = {}): Promise<ServiceResult<RegenerateData>> {
    return wikiRegenerateViews({ ...this.write, ...options });
  }

  async hasIndex(): Promise<boolean> {
    return hasReadableIndex(this.read);
  }
}

/**
 * Build an engine over one scaffold.
 *
 * A factory rather than an exported class: the class is an implementation
 * detail and `WikiEngine` is the contract, so a consumer that binds to the
 * return type cannot accidentally depend on the shape of the object behind it.
 */
export function createWikiEngine(options: WikiEngineOptions): WikiEngine & WikiEngineExtras {
  return new WikiEngineImpl(options);
}

export type { ServiceResult, WikiDiagnostic };
