/**
 * The read half of the service surface — §16's tools as plain typed functions.
 *
 * Nothing here imports `process`, `console`, `commander` or `chalk`, and that
 * is load-bearing rather than tidy. §15.2 forbids ANSI in JSON output; a rule
 * that says "remember not to colour the JSON" is a rule someone eventually
 * forgets, whereas a layer with no colour library in scope cannot emit a colour
 * at all. The CLI adapter, which does import `chalk`, sits on the other side of
 * this seam and renders only for humans.
 *
 * Synchronous, because everything underneath is `node:sqlite` and
 * `readFileSync`. An `async` surface here would be promises wrapped around
 * nothing, and P10 can add §7.2's `Promise` shape in one adapter.
 *
 * **A read never rebuilds** (§15.2, and P3 built the whole open path for it). A
 * missing, corrupt or version-mismatched index comes back as a typed diagnostic
 * with a remediation naming the command that fixes it — never a throw, and
 * never a silent five-second rebuild in the middle of a query.
 */

import { resolve } from "node:path";
import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import { compareGroundingHealth, type GroundingHealth } from "../model/grounding.js";
import { defaultIndexPath } from "../index/rebuild.js";
import { openWikiIndex } from "../index/open.js";
import { resolveBounds, type BoundsInput } from "../query/budget.js";
import { WikiQuerySession, withWikiQuery, type Neighborhood, type SearchMatch } from "../query/session.js";
import type { EntitySummary, MatchField, RelationEdge } from "../query/rank.js";

/**
 * What every service function returns.
 *
 * Data and diagnostics travel together rather than as a success/failure union,
 * because a wiki answer is routinely both: a `list` that succeeds may still
 * report a duplicate id, and a caller that had to choose one or the other would
 * drop half of what it was told. The envelope derives `ok` from the
 * diagnostics, so there is exactly one definition of failure.
 */
export interface ServiceResult<T> {
  data: T;
  diagnostics: WikiDiagnostic[];
}

/** Where the wiki is, and what may be read from it. */
export interface WikiServiceOptions {
  /** Absolute path to the scaffold root — the `.mex` directory. */
  scaffoldRoot: string;
  /** Defaults to `<scaffoldRoot>/wiki.db`. */
  indexPath?: string;
}

/** Filters §15.1 names, in the one place they are defined. */
export interface WikiFilterOptions extends BoundsInput {
  type?: string;
  topicId?: string;
  status?: string;
  health?: string;
  includeArchived?: boolean;
  file?: string;
}

export function indexPathFor(options: WikiServiceOptions): string {
  return options.indexPath ?? defaultIndexPath(resolve(options.scaffoldRoot));
}

/** A bounded list, honest about having been cut short. Truncation is data, never a diagnostic. */
export interface ListData {
  entities: EntitySummary[];
  truncated: boolean;
  /** The bounds actually applied, after clamping, so a caller can see what it got. */
  limit: number;
}

/**
 * Run `body` against an open index, or return the typed reason it could not.
 *
 * The one place a missing index becomes a diagnostic, so every read command
 * says the same thing and exits the same way.
 */
function read<T>(options: WikiServiceOptions, empty: T, body: (session: WikiQuerySession) => ServiceResult<T>): ServiceResult<T> {
  const result = withWikiQuery(indexPathFor(options), body);
  if (!result.ok) return { data: empty, diagnostics: [result.diagnostic] };
  return result.value;
}

/** Does this scaffold have an index at all? Distinct from "has an unusable one". */
export function hasReadableIndex(options: WikiServiceOptions): boolean {
  const opened = openWikiIndex(indexPathFor(options));
  if (!opened.ok) return false;
  opened.index.close();
  return true;
}

function statusOf(entity: EntitySummary): string {
  return String(entity.status);
}

/**
 * Post-filters the index does not apply itself.
 *
 * `status` and `health` are filtered here rather than in SQL because the read
 * layer's ordering rules are computed over the rows it returns — §10.4's "stale
 * lowers rank but never hides" is a property of the ranked list, and filtering
 * it away in the query would make the rank meaningless for the rows that remain.
 * The cost is that a filter narrows a bounded page rather than the whole table,
 * which is why `truncated` still reports the bound.
 */
function applyFilters(entities: readonly EntitySummary[], options: WikiFilterOptions): EntitySummary[] {
  return entities.filter((entity) => {
    if (options.status !== undefined && statusOf(entity) !== options.status) return false;
    if (options.health !== undefined && (entity.health ?? "unverified") !== options.health) return false;
    return true;
  });
}

/** §16 `wiki_list` — every entity matching the filters, bounded. */
export function wikiList(options: WikiServiceOptions & WikiFilterOptions): ServiceResult<ListData> {
  const bounds = resolveBounds(options);
  return read<ListData>(options, { entities: [], truncated: false, limit: bounds.limit }, (session) => {
    const page = session.list({
      ...(options.type === undefined ? {} : { type: options.type }),
      ...(options.topicId === undefined ? {} : { topicId: options.topicId }),
      ...(options.file === undefined ? {} : { file: options.file }),
      ...(options.includeArchived === undefined ? {} : { includeArchived: options.includeArchived }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    return {
      data: { entities: applyFilters(page.items, options), truncated: page.truncated, limit: bounds.limit },
      diagnostics: [],
    };
  });
}

/** One entity, with its body when asked for. */
export interface GetData {
  entity: EntitySummary | null;
  /** The entity's own Markdown body, when `includeBody` was set. */
  body: string | null;
}

/**
 * §16 `wiki_get` — one entity by id.
 *
 * The body is opt-in because §16 requires bounded answers that "omit full
 * unrelated documents", and an entity body is the largest thing this surface
 * returns. `wiki show` asks for it; a tool call listing candidates does not.
 */
export function wikiGet(
  options: WikiServiceOptions & { id: string; includeBody?: boolean },
): ServiceResult<GetData> {
  const empty: GetData = { entity: null, body: null };
  return read<GetData>(options, empty, (session) => {
    const found = session.get(options.id);
    if (!found.ok) return { data: empty, diagnostics: [found.diagnostic] };
    if (options.includeBody !== true) return { data: { entity: found.value, body: null }, diagnostics: [] };
    const body = session.body(options.id);
    return body.ok
      ? { data: { entity: found.value, body: body.value }, diagnostics: [] }
      : { data: { entity: found.value, body: null }, diagnostics: [body.diagnostic] };
  });
}

export interface SearchHit {
  entity: EntitySummary;
  /** Which field matched. §10.4 fixes the precedence: id, then title, then summary, then body. */
  field: MatchField;
  /** Whether the hit contains every query term or only some of them (#235). */
  match: SearchMatch;
  /** For a `some_terms` hit: the query terms it matched. */
  matchedTerms?: string[];
}

export interface SearchData {
  hits: SearchHit[];
  truncated: boolean;
  /**
   * The best tier present: `all_terms` when some hit contains every term
   * that carries meaning (broader hits may follow it, each labelled
   * `some_terms`); `some_terms` when none did and every hit is the broader
   * match; `none` when nothing matched either way.
   */
  match: SearchMatch | "none";
  /** Terms searched, after stop words and question words were dropped. */
  terms: string[];
  /** Words dropped from the query as carrying no meaning. */
  ignoredTerms: string[];
  /** Terms nothing in the wiki matched at all, even by stem. */
  unmatchedTerms: string[];
}

const EMPTY_SEARCH: SearchData = {
  hits: [], truncated: false, match: "none", terms: [], ignoredTerms: [], unmatchedTerms: [],
};

/**
 * §16 `wiki_search` — the three-tier FTS query, in §10.4's categorical order.
 *
 * A question is not a keyword list, so a query whose terms no single entity
 * contains falls back to entities matching some of them, labelled per hit and
 * by a notice (#235). An empty answer says so, with where to look next, rather
 * than reading as "there is no knowledge about this".
 */
export function wikiSearch(
  options: WikiServiceOptions & WikiFilterOptions & { text: string },
): ServiceResult<SearchData> {
  return read<SearchData>(options, EMPTY_SEARCH, (session) => {
    const page = session.search(options.text, {
      ...(options.includeArchived === undefined ? {} : { includeArchived: options.includeArchived }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    const kept = page.items.filter((hit) => applyFilters([hit.entity], options).length === 1);
    const match = kept.length === 0 ? "none" : page.match;
    const data: SearchData = {
      hits: kept,
      truncated: page.truncated,
      match,
      terms: page.terms,
      ignoredTerms: page.ignoredTerms,
      unmatchedTerms: page.unmatchedTerms,
    };
    const unchecked = session.uncheckedGroundings(kept.map((hit) => hit.entity.id));
    return {
      data,
      diagnostics: [
        ...searchNotices(data),
        ...(unchecked === 0 ? [] : [diagnostic(
          "WIKI_HEALTH_UNCHECKED",
          `${unchecked} grounding${unchecked === 1 ? "" : "s"} behind these hits ${unchecked === 1 ? "has" : "have"} not been checked against the current code, so an unflagged hit may still be stale.`,
        )]),
      ],
    };
  });
}

/** The two notices a search can carry. Info, so neither changes the exit code. */
function searchNotices(data: SearchData): WikiDiagnostic[] {
  const unmatched = data.unmatchedTerms.length === 0
    ? ""
    : ` Nothing in the wiki mentions: ${data.unmatchedTerms.join(", ")}.`;
  if (data.match === "some_terms") {
    return [diagnostic(
      "WIKI_QUERY_PARTIAL_MATCH",
      `No entity contains every term of the query; these are entities matching some of: ${data.terms.join(", ")}.${unmatched}`,
    )];
  }
  if (data.match === "none" && data.terms.length > 0) {
    // Every term found somewhere, but never enough of them in one entity.
    const apart = data.unmatchedTerms.length === 0 && data.terms.length > 1
      ? " Each term appears in the wiki, but no entity matches enough of them together."
      : "";
    return [diagnostic("WIKI_QUERY_NO_MATCH", `No wiki entity matches the query.${unmatched}${apart}`)];
  }
  return [];
}

/** §16 `wiki_neighborhood` — the bounded traversal, within one token budget. */
export function wikiNeighborhood(
  options: WikiServiceOptions & WikiFilterOptions & { id: string; includeBacklinks?: boolean },
): ServiceResult<Neighborhood | null> {
  return read<Neighborhood | null>(options, null, (session) => {
    const found = session.related(options.id, {
      ...(options.includeBacklinks === undefined ? {} : { includeBacklinks: options.includeBacklinks }),
      ...(options.includeArchived === undefined ? {} : { includeArchived: options.includeArchived }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.depth === undefined ? {} : { depth: options.depth }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    });
    return found.ok
      ? { data: found.value, diagnostics: [] }
      : { data: null, diagnostics: [found.diagnostic] };
  });
}

/**
 * §7.2's `backlinks(id)` shape: a flat list, not a neighborhood.
 *
 * Depth 0, because a traversal is not what was asked for and a caller that
 * wanted one would have called `related`. P10 inherits this signature, which is
 * why it is the §7.2 shape rather than the `Neighborhood` the index returns.
 */
export function wikiBacklinks(
  options: WikiServiceOptions & WikiFilterOptions & { id: string },
): ServiceResult<{ backlinks: RelationEdge[]; truncated: boolean }> {
  const result = wikiNeighborhood({ ...options, depth: 0, includeBacklinks: true });
  const value = result.data;
  return {
    data: value === null
      ? { backlinks: [], truncated: false }
      : { backlinks: value.backlinks, truncated: value.truncated },
    diagnostics: result.diagnostics,
  };
}

/** One entity's grounding health, as §5.7 separates it from lifecycle. */
export interface GroundingStatus {
  entityId: string;
  title: string;
  status: string;
  /**
   * Worst health across the entity's groundings, or **null when nothing looked**.
   *
   * Null is not `unverified` (handoff §41.4). `unverified` is a verdict — a
   * resolver ran and could not tell; null means no resolver ran at all, which
   * is what a scaffold with no code graph reports. Collapsing them would tell a
   * user their knowledge had been checked when it had not.
   */
  health: GroundingHealth | null;
  /** How many groundings the entity declares. Zero is why health can be null. */
  groundingCount: number;
}

export interface GroundingStatusData {
  entities: GroundingStatus[];
  truncated: boolean;
  /** True when no grounding in the result carries a verdict — the no-graph case. */
  unresolved: boolean;
}

/**
 * §16 `wiki_grounding_status` — is this knowledge still true of the code?
 *
 * Aggregation uses the model's `compareGroundingHealth`, not `healthRank`.
 * Both orders are correct and they answer different questions (handoff §40.2):
 * ranking decides how far a finding pushes an entity down a list, aggregation
 * decides which finding represents the entity. This is the second question.
 */
export function wikiGroundingStatus(
  options: WikiServiceOptions & WikiFilterOptions & { id?: string },
): ServiceResult<GroundingStatusData> {
  const empty: GroundingStatusData = { entities: [], truncated: false, unresolved: true };
  return read<GroundingStatusData>(options, empty, (session) => {
    if (options.id !== undefined) {
      const found = session.get(options.id);
      if (!found.ok) return { data: empty, diagnostics: [found.diagnostic] };
      const one = statusFor(session, found.value);
      return {
        data: { entities: [one], truncated: false, unresolved: one.health === null },
        diagnostics: [],
      };
    }
    const page = session.list({
      ...(options.type === undefined ? {} : { type: options.type }),
      ...(options.includeArchived === undefined ? {} : { includeArchived: options.includeArchived }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    const entities = applyFilters(page.items, options).map((entity) => statusFor(session, entity));
    return {
      data: {
        entities,
        truncated: page.truncated,
        unresolved: entities.every((entry) => entry.health === null),
      },
      diagnostics: [],
    };
  });
}

function statusFor(session: WikiQuerySession, entity: EntitySummary): GroundingStatus {
  const groundings = session.groundingsFor(entity.id);
  const health = groundings
    .map((entry) => entry.health)
    .filter((value): value is GroundingHealth => value !== null)
    .sort(compareGroundingHealth)[0] ?? null;
  return {
    entityId: entity.id,
    title: entity.title,
    status: statusOf(entity),
    health,
    groundingCount: groundings.length,
  };
}

/** A bounded slice of the relation graph: the nodes, their edges, and whether it is all of them. */
export interface GraphData {
  nodes: EntitySummary[];
  edges: Array<{ from: string; type: string; to: string; resolved: boolean }>;
  /**
   * True when this is a **sample** rather than the whole graph.
   *
   * §15.1 asks for a `wiki graph` command; §10.4 and P3's source scan forbid a
   * query that can load the whole wiki, and a whole-graph export is that query
   * by definition. Rather than take an exemption, this composes two already
   * bounded read-layer calls and says plainly when the answer is partial — so
   * there is one bounds discipline across all ten commands, no new SQL, and
   * nothing for a future convenience to walk through. The cost is that a user
   * on a large scaffold gets a slice and has to narrow with the filters; the
   * command says so rather than implying completeness.
   */
  truncated: boolean;
}

/** `wiki graph` — bounded, filtered, and honest when it is a sample. */
export function wikiGraph(options: WikiServiceOptions & WikiFilterOptions): ServiceResult<GraphData> {
  const listed = wikiList(options);
  if (listed.diagnostics.length > 0 && listed.data.entities.length === 0) {
    return { data: { nodes: [], edges: [], truncated: false }, diagnostics: listed.diagnostics };
  }

  const nodes = listed.data.entities;
  const present = new Set(nodes.map((entity) => entity.id));
  const edges: GraphData["edges"] = [];
  let truncated = listed.data.truncated;

  for (const node of nodes) {
    const neighborhood = wikiNeighborhood({ ...options, id: node.id, depth: 0, includeBacklinks: false });
    const value = neighborhood.data;
    if (value === null) continue;
    if (value.truncated) truncated = true;
    for (const edge of value.relations) {
      edges.push({ from: node.id, type: edge.type, to: edge.targetId, resolved: edge.resolved });
      // An edge whose far end is outside this slice is what makes the answer a
      // sample rather than a subgraph, and the caller is told.
      if (edge.resolved && !present.has(edge.targetId)) truncated = true;
    }
  }

  edges.sort((left, right) =>
    left.from === right.from
      ? left.type === right.type
        ? left.to < right.to ? -1 : left.to > right.to ? 1 : 0
        : left.type < right.type ? -1 : 1
      : left.from < right.from ? -1 : 1,
  );

  return { data: { nodes, edges, truncated }, diagnostics: listed.diagnostics };
}

/** The typed refusal a read gives when there is no index. Exported so a caller can match on it. */
export function noIndexDiagnostic(options: WikiServiceOptions): WikiDiagnostic {
  return diagnostic("WIKI_INDEX_MISSING", `No wiki index at ${indexPathFor(options)}.`, {
    file: indexPathFor(options),
  });
}
