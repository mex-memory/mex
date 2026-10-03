/**
 * One-shot read helpers.
 *
 * A session is the efficient way to ask several questions; these are for the
 * callers that ask one. They open, read and close, and they return the same
 * typed failure a session would — never a throw, and never a rebuild.
 */

import type { WikiDiagnostic } from "../model/diagnostic.js";
import type { EntitySummary } from "./rank.js";
import { withWikiQuery, type ListOptions, type Neighborhood, type Page, type QueryResult, type RelatedOptions, type SearchOptions, type SearchPage } from "./session.js";
import type { MatchField } from "./rank.js";
import type { ForCodeOptions, GroundedEntity } from "./for-code.js";

/** One entity by id. `ENTITY_NOT_FOUND` when the index has no such entity. */
export function getEntity(indexPath: string, id: string): QueryResult<EntitySummary> {
  return flatten(withWikiQuery(indexPath, (session) => session.get(id)));
}

/** One entity's body text. */
export function getEntityBody(indexPath: string, id: string): QueryResult<string> {
  return flatten(withWikiQuery(indexPath, (session) => session.body(id)));
}

export function listEntities(indexPath: string, options: ListOptions = {}): QueryResult<Page<EntitySummary>> {
  return withWikiQuery(indexPath, (session) => session.list(options));
}

export function searchEntities(
  indexPath: string,
  text: string,
  options: SearchOptions = {},
): QueryResult<SearchPage> {
  return withWikiQuery(indexPath, (session) => session.search(text, options));
}

export function relatedEntities(
  indexPath: string,
  id: string,
  options: RelatedOptions = {},
): QueryResult<Neighborhood> {
  return flatten(withWikiQuery(indexPath, (session) => session.related(id, options)));
}

export function indexDiagnostics(indexPath: string, options: { file?: string; limit?: number } = {}): QueryResult<Page<WikiDiagnostic>> {
  return withWikiQuery(indexPath, (session) => session.diagnostics(options));
}

/**
 * Entities grounded to any of these code nodes.
 *
 * The reverse join, for a caller that has a set of node ids in hand — typically
 * straight out of `mex graph scope`.
 */
export function entitiesGroundedIn(
  indexPath: string,
  nodeIds: readonly string[],
  options: ForCodeOptions = {},
): QueryResult<Page<GroundedEntity>> {
  return withWikiQuery(indexPath, (session) => session.forCode(nodeIds, options));
}

/** Collapse "opened, and the query failed" into one failure. */
function flatten<T>(outer: QueryResult<QueryResult<T>>): QueryResult<T> {
  if (!outer.ok) return outer;
  return outer.value;
}
