/**
 * §10.4's ordering rules, as pure functions over row projections.
 *
 * Pure on purpose. Ordering is the part of a retrieval system that is easiest
 * to get subtly wrong and hardest to notice: nothing throws, results still come
 * back, and the wrong one is merely second. Keeping the rules out of SQL means
 * each can be asserted directly, including the two that are about what must
 * *not* happen — a stale entity must not disappear, and nothing may be ordered
 * by rowid.
 */

import type { GroundingHealth } from "../model/grounding.js";
import type { WikiLifecycleState } from "../model/entity.js";

/** One entity, as the query layer hands it out. */
export interface EntitySummary {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  status: WikiLifecycleState | string;
  file: string;
  revision: number;
  startLine: number;
  endLine: number;
  /**
   * Worst health across the entity's groundings, or null when it declares none
   * or nothing has resolved them yet.
   *
   * P3 stores what Markdown declares and resolves nothing, so in this phase it
   * is null in practice. The ranking rule is implemented and tested anyway,
   * because "stale lowers rank but never hides" is a §10.4 requirement and
   * retrofitting a ranking rule after the data arrives is how it gets missed.
   */
  health: GroundingHealth | null;
}

/** Which field a search hit came from. Lower is better; §10.4 fixes the order. */
export type MatchField = "id" | "title" | "summary" | "body";

export const MATCH_FIELD_RANK: Record<MatchField, number> = { id: 0, title: 1, summary: 2, body: 3 };

/**
 * Lifecycle preference for a default active-context query.
 *
 * `promoted` first, then `in_flight`, then `deprecated`. `archived` is excluded
 * by a filter rather than ranked last — see {@link isVisible}.
 */
export const LIFECYCLE_RANK: Record<string, number> = {
  promoted: 0,
  in_flight: 1,
  deprecated: 2,
  archived: 3,
};

/**
 * Ranking penalty for grounding health.
 *
 * **It lowers rank and never hides.** A stale entity that vanishes from results
 * is worse than one that shows up marked stale: the user cannot tell "stale"
 * from "does not exist", and the second sends them off to write a duplicate of
 * something that already exists. So this is a tiebreaker, never a filter, and
 * no code path turns it into one.
 */
export const HEALTH_RANK: Record<string, number> = {
  fresh: 0,
  unverified: 1,
  ambiguous: 2,
  changed: 3,
  missing: 4,
};

export function healthRank(health: GroundingHealth | null): number {
  return health === null ? HEALTH_RANK["unverified"]! : (HEALTH_RANK[health] ?? HEALTH_RANK["unverified"]!);
}

export interface VisibilityOptions {
  /** Include archived entities. Off by default (§10.4). */
  includeArchived?: boolean;
  /**
   * Include `in_flight` entities. On by default — they are part of active
   * context. A caller that wants only settled knowledge passes false; review
   * surfaces pass true explicitly and get them regardless of the default.
   */
  includeInFlight?: boolean;
  /** Restrict to these lifecycle states, ignoring the two flags above. */
  statuses?: readonly string[];
}

/** Whether an entity is visible under the caller's options. */
export function isVisible(status: string, options: VisibilityOptions = {}): boolean {
  if (options.statuses !== undefined) return options.statuses.includes(status);
  if (status === "archived") return options.includeArchived === true;
  if (status === "in_flight") return options.includeInFlight !== false;
  return true;
}

/** A hit, before ordering. */
export interface RankedHit {
  entity: EntitySummary;
  field: MatchField;
  /**
   * FTS5 `bm25()` within the matched field, rounded; lower is more relevant.
   * Absent for a hit that is not a full-text match, such as an exact id.
   */
  relevance?: number;
}

/**
 * The total order for search results.
 *
 * Total, and every tier is content: exact id, then which field matched, then
 * lifecycle, then health, then title, then id. Nothing falls through to
 * insertion order, so two indexes holding the same rows return the same list.
 */
export function compareHits(left: RankedHit, right: RankedHit): number {
  const byField = MATCH_FIELD_RANK[left.field] - MATCH_FIELD_RANK[right.field];
  if (byField !== 0) return byField;

  const byLifecycle = lifecycleRank(left.entity.status) - lifecycleRank(right.entity.status);
  if (byLifecycle !== 0) return byLifecycle;

  const byHealth = healthRank(left.entity.health) - healthRank(right.entity.health);
  if (byHealth !== 0) return byHealth;

  const byRelevance = (left.relevance ?? 0) - (right.relevance ?? 0);
  if (byRelevance !== 0) return byRelevance;

  return compareEntities(left.entity, right.entity);
}

function lifecycleRank(status: string): number {
  return LIFECYCLE_RANK[status] ?? LIFECYCLE_RANK["deprecated"]!;
}

/** Title, then id. Used wherever there is no match field to order by. */
export function compareEntities(left: EntitySummary, right: EntitySummary): number {
  if (left.title !== right.title) return left.title < right.title ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** A relation or backlink, as handed out. */
export interface RelationEdge {
  type: string;
  /** The entity at the other end, when it exists in the index. */
  target: EntitySummary | null;
  /** The declared id, which is all there is when the target is missing. */
  targetId: string;
  resolved: boolean;
}

/**
 * §10.4: relations and backlinks order by (type, target title, id).
 *
 * A dangling target has no title, so it sorts by its id under an empty title —
 * which puts unresolved references first within their type, where they are
 * visible. They are never dropped: a reference that disappears because it is
 * broken is a broken reference nobody will fix.
 */
export function compareEdges(left: RelationEdge, right: RelationEdge): number {
  if (left.type !== right.type) return left.type < right.type ? -1 : 1;
  const leftTitle = left.target?.title ?? "";
  const rightTitle = right.target?.title ?? "";
  if (leftTitle !== rightTitle) return leftTitle < rightTitle ? -1 : 1;
  return left.targetId < right.targetId ? -1 : left.targetId > right.targetId ? 1 : 0;
}
