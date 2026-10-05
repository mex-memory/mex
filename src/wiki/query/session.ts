/**
 * The read layer: get, list, search, related — over the disposable index.
 *
 * Two rules shape every function here.
 *
 * **A read never rebuilds.** Opening returns a typed diagnostic for a missing,
 * corrupt or version-mismatched index, and this module cannot even import the
 * rebuild path — the layering lint forbids it. A read that quietly rebuilds
 * turns a 10 ms query into a 5 s one at an unpredictable moment and hides that
 * the index was broken.
 *
 * **Every list is bounded, and unbounded is inexpressible.** Bounds are
 * resolved by `resolveBounds`, whose return type has no "all" case, and every
 * statement below carries a `LIMIT`. A test scans this directory's SQL and
 * fails on a `SELECT` from `wiki_entities` without one, so the invariant is not
 * left to reviewer attention.
 */

import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import { compareGroundingHealth, type GroundingHealth } from "../model/grounding.js";
import { queryEntitiesGroundedIn, type ForCodeOptions, type GroundedEntity } from "./for-code.js";
import { openWikiIndex, type WikiIndexHandle } from "../index/open.js";
import type { SqliteDatabase } from "../../graph/db/sqlite.js";
import {
  compareEdges,
  compareEntities,
  compareHits,
  healthRank,
  isVisible,
  type EntitySummary,
  type MatchField,
  type RankedHit,
  type RelationEdge,
  type VisibilityOptions,
} from "./rank.js";
import { estimateTokens, fitWithinBudget, resolveBounds, type Bounds, type BoundsInput } from "./budget.js";
import { findSomeTermsMatches, planWikiSearch, type EntityScope } from "./search-plan.js";

export type QueryResult<T> = { ok: true; value: T } | { ok: false; diagnostic: WikiDiagnostic };

/** A bounded result set, honest about having been cut short. */
export interface Page<T> {
  items: T[];
  /** True when a bound stopped the list before the data ran out. */
  truncated: boolean;
}

interface EntityRow {
  entity_key: string;
  id: string;
  type: string;
  title: string;
  summary: string | null;
  status: string;
  file: string;
  revision: number;
  start_line: number;
  end_line: number;
}

const ENTITY_COLUMNS = `e.entity_key, e.id, e.type, e.title, e.summary, e.status, e.file, e.revision, e.start_line, e.end_line`;

export interface ListOptions extends VisibilityOptions, BoundsInput {
  type?: string;
  /** Only entities that are members of this topic. */
  topicId?: string;
  file?: string;
}

export interface SearchOptions extends VisibilityOptions, BoundsInput {}

/**
 * How much of a query a hit matched (#235).
 *
 * `all_terms` contains every term that carries meaning; `some_terms` is the
 * broader match returned only when nothing contained them all.
 */
export type SearchMatch = "all_terms" | "some_terms";

export interface SearchPageHit {
  entity: EntitySummary;
  field: MatchField;
  match: SearchMatch;
  /** For a `some_terms` hit: the query terms it matched, in query order. */
  matchedTerms?: string[];
}

/** A search page, and what the query was taken to mean. */
export interface SearchPage extends Page<SearchPageHit> {
  /** The tier the hits came from, or `none` when neither found anything. */
  match: SearchMatch | "none";
  /** Terms searched, after stop words were dropped. */
  terms: string[];
  /** Stop words dropped from the query. */
  ignoredTerms: string[];
  /** Terms no visible entity matched at all, even by stem. */
  unmatchedTerms: string[];
}

/** Per-term bound for the broader tier; the same ceiling `list` reads to. */
const SOME_TERMS_PER_TERM_LIMIT = 2000;

export interface RelatedOptions extends VisibilityOptions, BoundsInput {
  /** Include incoming edges as well as outgoing ones. Default true. */
  includeBacklinks?: boolean;
}

export interface Neighborhood {
  origin: EntitySummary;
  /** Outgoing edges, ordered by (type, target title, id). */
  relations: RelationEdge[];
  /** Incoming edges, in the same order. */
  backlinks: RelationEdge[];
  /** Everything reachable within the depth bound, excluding the origin. */
  reached: EntitySummary[];
  truncated: boolean;
  /** What the traversal is estimated to cost, in the graph's own vocabulary. */
  estimatedTokens: number;
}

/**
 * An open, read-only view of one index.
 *
 * Held open across several queries because opening is the expensive part and
 * `get` has a 10 ms target. Callers close it; `withWikiQuery` does that for
 * them.
 */
export class WikiQuerySession {
  constructor(private readonly handle: WikiIndexHandle) {}

  private get db(): SqliteDatabase {
    return this.handle.db;
  }

  close(): void {
    this.handle.close();
  }

  /** One entity by id, or `ENTITY_NOT_FOUND`. */
  get(id: string): QueryResult<EntitySummary> {
    const row = this.db
      .prepare(`SELECT ${ENTITY_COLUMNS} FROM wiki_entities e WHERE e.id = ? AND e.shadowed = 0 LIMIT 1`)
      .get(id) as EntityRow | undefined;

    if (row === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic("ENTITY_NOT_FOUND", `No entity with id ${id} is in the index.`, { entityId: id }),
      };
    }
    return { ok: true, value: this.decorate([row])[0]! };
  }

  /** The entity's own body text, read separately because it is large. */
  body(id: string): QueryResult<string> {
    const row = this.db
      .prepare(`SELECT e.body AS body FROM wiki_entities e WHERE e.id = ? AND e.shadowed = 0 LIMIT 1`)
      .get(id) as { body: string } | undefined;
    if (row === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic("ENTITY_NOT_FOUND", `No entity with id ${id} is in the index.`, { entityId: id }),
      };
    }
    return { ok: true, value: row.body };
  }

  /**
   * Entities matching a filter, ordered by title then id.
   *
   * Archived entities are excluded unless asked for; `in_flight` are included,
   * because they are part of active context. The limit is applied in SQL as
   * well as in the budget pass, so a caller cannot page the whole wiki into
   * memory even by mistake.
   */
  list(options: ListOptions = {}): Page<EntitySummary> {
    const bounds = resolveBounds(options);
    const clauses: string[] = ["e.shadowed = 0"];
    const params: unknown[] = [];

    if (options.type !== undefined) {
      clauses.push("e.type = ?");
      params.push(options.type);
    }
    if (options.file !== undefined) {
      clauses.push("e.file = ?");
      params.push(options.file);
    }
    if (options.topicId !== undefined) {
      clauses.push("EXISTS (SELECT 1 FROM wiki_entity_topics t WHERE t.entity_key = e.entity_key AND t.topic_entity_id = ?)");
      params.push(options.topicId);
    }

    // Over-read by one bound's worth so the visibility filter cannot silently
    // shrink a full page into a short one without the caller being told.
    const ceiling = Math.min(bounds.limit * 4, 2000);
    const rows = this.db
      .prepare(
        `SELECT ${ENTITY_COLUMNS} FROM wiki_entities e WHERE ${clauses.join(" AND ")} ORDER BY e.title, e.id LIMIT ?`,
      )
      .all(...params, ceiling) as EntityRow[];

    const visible = this.decorate(rows)
      .filter((entity) => isVisible(entity.status, options))
      .sort(compareEntities);

    const fitted = fitWithinBudget(visible, bounds);
    return { items: fitted.items, truncated: fitted.truncated || rows.length >= ceiling };
  }

  /**
   * Lexical search, with §10.4's precedence.
   *
   * An exact id beats everything, then a title match, then summary, then body.
   * The tiers are separate FTS queries rather than a scoring function because
   * the required order is categorical: no number of body matches may outrank
   * one title match, and a relevance score always eventually lets it.
   *
   * Stop words are dropped first, and when no entity contains every remaining
   * term the broader `some_terms` tier answers instead, labelled as such
   * (`search-plan.ts`). That tier has no categorical claim to keep, so it is
   * ordered by how much of the query each entity covers.
   */
  search(text: string, options: SearchOptions = {}): SearchPage {
    const bounds = resolveBounds(options);
    const trimmed = text.trim();
    const plan = planWikiSearch(trimmed);
    const page = (items: SearchPageHit[], truncated: boolean, match: SearchPage["match"], unmatchedTerms: string[] = []): SearchPage => ({
      items, truncated, match, terms: plan.terms, ignoredTerms: plan.ignoredTerms, unmatchedTerms,
    });
    if (trimmed === "") return page([], false, "none");

    const hits: RankedHit[] = [];
    const seen = new Set<string>();

    const add = (rows: (EntityRow & { relevance?: number })[], field: MatchField): void => {
      for (const [index, entity] of this.decorate(rows).entries()) {
        if (seen.has(entity.id)) continue;
        if (!isVisible(entity.status, options)) continue;
        seen.add(entity.id);
        const relevance = rows[index]!.relevance;
        hits.push(relevance === undefined ? { entity, field } : { entity, field, relevance: Number(relevance) });
      }
    };

    const exact = this.db
      .prepare(`SELECT ${ENTITY_COLUMNS} FROM wiki_entities e WHERE e.id = ? AND e.shadowed = 0 LIMIT 1`)
      .all(trimmed) as EntityRow[];
    add(exact, "id");

    const expression = plan.allTermsExpression;
    if (expression !== null) {
      for (const [columns, field] of [
        ["title", "title"],
        ["summary", "summary"],
        ["body aliases meta", "body"],
      ] as const) {
        const rows = this.db
          .prepare(
            `SELECT ${ENTITY_COLUMNS}, round(bm25(wiki_fts), 6) AS relevance
               FROM wiki_fts f JOIN wiki_entities e ON e.entity_key = f.entity_key
              WHERE wiki_fts MATCH ? AND e.shadowed = 0 ORDER BY relevance, e.title, e.id LIMIT ?`,
          )
          .all(`{${columns}} : (${expression})`, bounds.limit * 4) as (EntityRow & { relevance: number })[];
        add(rows, field);
      }
    }

    hits.sort(compareHits);
    const strict: SearchPageHit[] = hits.map((hit) => ({ entity: hit.entity, field: hit.field, match: "all_terms" }));
    // More every-term hits than a page holds leave no room for broader ones,
    // and the page is already truncated.
    if (plan.terms.length === 0 || strict.length > bounds.limit) {
      const fitted = fitWithinBudget(strict, bounds);
      return page(fitted.items, fitted.truncated, strict.length > 0 ? "all_terms" : "none");
    }

    // The rest of the page is the broader match, after every every-term hit
    // and labelled per hit. Not only when the strict tier is empty: a term in
    // most of the wiki (the project's own name) can make the strict tier
    // return the entities that mention it while missing the one that answers.
    const broader = findSomeTermsMatches(this.db, plan.terms, visibilityScope(options), SOME_TERMS_PER_TERM_LIMIT);
    const kept = broader.matches.slice(0, bounds.limit * 4);
    const byKey = new Map(kept.map((match) => [match.entityKey, match]));
    const rows = kept.length === 0 ? [] : this.db
      .prepare(
        `SELECT ${ENTITY_COLUMNS} FROM wiki_entities e
          WHERE e.entity_key IN (${kept.map(() => "?").join(", ")}) AND e.shadowed = 0 LIMIT ?`,
      )
      .all(...kept.map((match) => match.entityKey), kept.length) as EntityRow[];
    const some = this.decorate(rows)
      .map((entity, index) => ({ entity, match: byKey.get(rows[index]!.entity_key)! }))
      .filter((hit) => !seen.has(hit.entity.id) && isVisible(hit.entity.status, options))
      .map((hit) => ({
        entity: hit.entity, field: hit.match.field, score: hit.match.score, matchedTerms: hit.match.matchedTerms,
        relevance: hit.match.relevance,
      }))
      .sort((left, right) => right.score - left.score || compareHits(left, right))
      .map((hit): SearchPageHit => ({
        entity: hit.entity, field: hit.field, match: "some_terms", matchedTerms: hit.matchedTerms,
      }));
    const fitted = fitWithinBudget([...strict, ...some], bounds);
    return page(
      fitted.items,
      fitted.truncated || broader.truncated || broader.matches.length > kept.length,
      strict.length > 0 ? "all_terms" : some.length > 0 ? "some_terms" : "none",
      broader.unmatchedTerms,
    );
  }

  /**
   * An entity's neighbourhood, bounded by depth, count and estimated tokens.
   *
   * All three bounds, not whichever is convenient: depth alone lets one
   * hub entity pull in half the wiki, and a count alone lets a handful of very
   * long entities blow the response budget.
   */
  related(id: string, options: RelatedOptions = {}): QueryResult<Neighborhood> {
    const bounds = resolveBounds(options);
    const origin = this.get(id);
    if (!origin.ok) return origin;

    const relations = this.edgesFrom(origin.value.id, bounds);
    const backlinks = options.includeBacklinks === false ? [] : this.edgesTo(origin.value.id, bounds);

    const reached: EntitySummary[] = [];
    const visited = new Set<string>([origin.value.id]);
    let frontier = [origin.value.id];
    let truncated = false;

    for (let depth = 0; depth < bounds.depth && !truncated; depth += 1) {
      const next: string[] = [];
      for (const current of frontier) {
        const edges = [...this.edgesFrom(current, bounds), ...(options.includeBacklinks === false ? [] : this.edgesTo(current, bounds))];
        for (const edge of edges) {
          if (edge.target === null || visited.has(edge.target.id)) continue;
          if (!isVisible(edge.target.status, options)) continue;
          visited.add(edge.target.id);
          if (reached.length >= bounds.limit) {
            truncated = true;
            break;
          }
          reached.push(edge.target);
          next.push(edge.target.id);
        }
        if (truncated) break;
      }
      if (next.length === 0) break;
      frontier = next;
    }

    reached.sort(compareEntities);
    const fitted = fitWithinBudget(reached, bounds);

    return {
      ok: true,
      value: {
        origin: origin.value,
        relations: relations.sort(compareEdges),
        backlinks: backlinks.sort(compareEdges),
        reached: fitted.items,
        truncated: truncated || fitted.truncated,
        estimatedTokens: estimateNeighborhoodTokens(origin.value, relations, backlinks, fitted.items),
      },
    };
  }

  /**
   * The groundings one entity declares, in the order Markdown declares them.
   *
   * `EntitySummary.health` already carries the *worst* of these, aggregated
   * with the model's precedence. This is the finer answer `wiki_grounding_status`
   * needs: how many references an entity makes, and what became of each — which
   * is a different question from how far a stale one pushes it down a list.
   *
   * `shadowed = 0`, like every other query by id (finding 31): the loser of a
   * duplicate-id contest is a row `wiki validate` must see and a reader must not.
   */
  groundingsFor(id: string, options: BoundsInput = {}): { nodeId: string; health: GroundingHealth | null; state: string | null }[] {
    const bounds = resolveBounds(options);
    const rows = this.db
      .prepare(
        `SELECT g.node_id, g.health, g.state
           FROM wiki_groundings g
           JOIN wiki_entities e ON e.entity_key = g.entity_key
          WHERE e.id = ? AND e.shadowed = 0
          ORDER BY g.ordinal LIMIT ?`,
      )
      .all(id, bounds.edgeLimit) as { node_id: string; health: string | null; state: string | null }[];
    return rows.map((row) => ({
      nodeId: row.node_id,
      health: row.health === null ? null : (row.health as GroundingHealth),
      state: row.state,
    }));
  }

  /**
   * The sources one entity cites, in the order Markdown declares them.
   *
   * §8.6's evidence, which §17's evidence panel shows beside the groundings.
   * Read separately from `EntitySummary` for the same reason the body is: an
   * entity can cite many sources and a list of forty entities does not want
   * them all. `shadowed = 0`, like every other query by id.
   */
  sourcesFor(
    id: string,
    options: BoundsInput = {},
  ): { type: string; ref: string | null; note: string | null; capturedAt: string | null }[] {
    const bounds = resolveBounds(options);
    const rows = this.db
      .prepare(
        `SELECT s.type, s.ref, s.note, s.captured_at
           FROM wiki_sources s
           JOIN wiki_entities e ON e.entity_key = s.entity_key
          WHERE e.id = ? AND e.shadowed = 0
          ORDER BY s.ordinal LIMIT ?`,
      )
      .all(id, bounds.edgeLimit) as { type: string; ref: string | null; note: string | null; captured_at: string | null }[];
    return rows.map((row) => ({ type: row.type, ref: row.ref, note: row.note, capturedAt: row.captured_at }));
  }

  /** Every diagnostic the index holds, bounded and deterministically ordered. */
  diagnostics(options: BoundsInput & { file?: string } = {}): Page<WikiDiagnostic> {
    const bounds = resolveBounds(options);
    const where = options.file === undefined ? "" : "WHERE file = ?";
    const params = options.file === undefined ? [] : [options.file];
    const rows = this.db
      .prepare(
        `SELECT code, severity, message, file, entity_id, path, start_offset, end_offset, start_line, end_line, remediation
           FROM wiki_diagnostics ${where}
          ORDER BY severity, code, file, entity_id, path, start_offset, message LIMIT ?`,
      )
      .all(...params, bounds.limit) as Record<string, unknown>[];

    const items = rows.map((row) => {
      const entry: WikiDiagnostic = {
        code: row["code"] as WikiDiagnostic["code"],
        severity: row["severity"] as WikiDiagnostic["severity"],
        message: String(row["message"]),
      };
      if (row["file"] !== null) entry.file = String(row["file"]);
      if (row["entity_id"] !== null) entry.entityId = String(row["entity_id"]);
      if (row["path"] !== null) entry.path = String(row["path"]);
      if (row["remediation"] !== null) entry.remediation = String(row["remediation"]);
      return entry;
    });
    return { items, truncated: items.length >= bounds.limit };
  }

  private edgesFrom(id: string, bounds: Bounds): RelationEdge[] {
    const rows = this.db
      .prepare(
        `SELECT r.type AS type, r.target_id AS target_id, r.target_resolved AS resolved
           FROM wiki_relations r JOIN wiki_entities e ON e.entity_key = r.source_key
          WHERE e.id = ? AND e.shadowed = 0 ORDER BY r.type, r.target_id LIMIT ?`,
      )
      .all(id, bounds.edgeLimit) as { type: string; target_id: string; resolved: number }[];
    return this.toEdges(rows.map((row) => ({ type: row.type, targetId: row.target_id, resolved: row.resolved === 1 })));
  }

  private edgesTo(id: string, bounds: Bounds): RelationEdge[] {
    const rows = this.db
      .prepare(
        `SELECT r.type AS type, e.id AS source_id
           FROM wiki_relations r JOIN wiki_entities e ON e.entity_key = r.source_key
          WHERE r.target_id = ? AND e.shadowed = 0 ORDER BY r.type, e.id LIMIT ?`,
      )
      .all(id, bounds.edgeLimit) as { type: string; source_id: string }[];
    return this.toEdges(rows.map((row) => ({ type: row.type, targetId: row.source_id, resolved: true })));
  }

  private toEdges(raw: readonly { type: string; targetId: string; resolved: boolean }[]): RelationEdge[] {
    if (raw.length === 0) return [];
    const ids = [...new Set(raw.map((edge) => edge.targetId))];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT ${ENTITY_COLUMNS} FROM wiki_entities e WHERE e.id IN (${placeholders}) AND e.shadowed = 0 LIMIT ?`,
      )
      .all(...ids, ids.length) as EntityRow[];
    const byId = new Map(this.decorate(rows).map((entity) => [entity.id, entity]));

    return raw.map((edge) => ({
      type: edge.type,
      targetId: edge.targetId,
      target: byId.get(edge.targetId) ?? null,
      resolved: edge.resolved && byId.has(edge.targetId),
    }));
  }

  /**
   * Entities grounded to any of these code nodes — the code→knowledge join.
   *
   * The whole implementation is in `for-code.ts`; this is the session-shaped
   * door onto it, so a caller already holding an open index does not have to
   * open a second one.
   */
  forCode(nodeIds: readonly string[], options: ForCodeOptions = {}): Page<GroundedEntity> {
    return queryEntitiesGroundedIn(this.db, nodeIds, options);
  }

  /**
   * Attach the worst grounding health to each row.
   *
   * Worst, not first: an entity with one fresh grounding and one missing one is
   * not fresh, and reporting it as fresh is exactly the kind of quiet wrong
   * answer this phase exists to prevent.
   *
   * **"Worst" is the model's precedence, not this layer's `HEALTH_RANK`.** The
   * two orders genuinely disagree — the model calls `ambiguous` worse than
   * `changed`, the ranking penalizes `changed` more — because they answer
   * different questions: which finding should represent this entity, and how
   * far a finding should push it down a result list. Aggregating with the
   * ranking order answers the first question with the second's answer, which
   * nothing caught while the column was always NULL.
   */
  private decorate(rows: readonly EntityRow[]): EntitySummary[] {
    if (rows.length === 0) return [];
    const keys = rows.map((row) => row.entity_key);
    const placeholders = keys.map(() => "?").join(", ");
    const healths = this.db
      .prepare(
        `SELECT entity_key, health FROM wiki_groundings
          WHERE entity_key IN (${placeholders}) AND health IS NOT NULL LIMIT ?`,
      )
      .all(...keys, keys.length * 64) as { entity_key: string; health: string }[];

    const worst = new Map<string, GroundingHealth>();
    for (const row of healths) {
      const candidate = row.health as GroundingHealth;
      const current = worst.get(row.entity_key);
      if (current === undefined || compareGroundingHealth(candidate, current) < 0) {
        worst.set(row.entity_key, candidate);
      }
    }

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      summary: row.summary,
      status: row.status,
      file: row.file,
      revision: Number(row.revision),
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      health: worst.get(row.entity_key) ?? null,
    }));
  }
}

/**
 * Escape a user query into an FTS5 MATCH expression.
 *
 * Every term is quoted and the terms are ANDed. Passing user text into MATCH
 * unescaped makes `NEAR`, `*` and an unbalanced quote into syntax errors at
 * best, and into a query the user did not write at worst. Stop words are
 * dropped first (#235); see `planWikiSearch`.
 */
export function toMatchExpression(text: string): string | null {
  return planWikiSearch(text).allTermsExpression;
}

/** The visibility rule `isVisible` applies, as SQL, so the broader tier's frequencies count only what can be returned. */
function visibilityScope(options: VisibilityOptions): EntityScope {
  const clauses = ["e.shadowed = 0"];
  const params: string[] = [];
  if (options.statuses !== undefined) {
    if (options.statuses.length === 0) clauses.push("0");
    else {
      clauses.push(`e.status IN (${options.statuses.map(() => "?").join(", ")})`);
      params.push(...options.statuses);
    }
  } else {
    if (options.includeArchived !== true) clauses.push("e.status <> 'archived'");
    if (options.includeInFlight === false) clauses.push("e.status <> 'in_flight'");
  }
  return { sql: clauses.join(" AND "), params };
}

/** Neighbourhood cost, in the graph's own estimator (§4.7). */
export function estimateNeighborhoodTokens(
  origin: EntitySummary,
  relations: readonly RelationEdge[],
  backlinks: readonly RelationEdge[],
  reached: readonly EntitySummary[],
): number {
  return estimateTokens({ origin, relations, backlinks, reached });
}

/** Open a read-only session, or explain why not. */
export function openWikiQuery(indexPath: string): QueryResult<WikiQuerySession> {
  const opened = openWikiIndex(indexPath);
  if (!opened.ok) return { ok: false, diagnostic: opened.diagnostic };
  return { ok: true, value: new WikiQuerySession(opened.index) };
}

/** Run `body` against a session, closing it afterwards. */
export function withWikiQuery<T>(indexPath: string, body: (session: WikiQuerySession) => T): QueryResult<T> {
  const opened = openWikiQuery(indexPath);
  if (!opened.ok) return opened;
  try {
    return { ok: true, value: body(opened.value) };
  } finally {
    opened.value.close();
  }
}
