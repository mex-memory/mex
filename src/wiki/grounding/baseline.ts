/**
 * The Wiki's accessor for cached historical grounding source (D1).
 *
 * The accepted change baseline is the `bodyHash` committed in Markdown. This
 * module is a subject-shaped accessor onto `FingerprintStore` in disposable
 * `graph.db`, not another canonical store.
 *
 * The cached source and hash describe an explicitly captured grounding so a
 * reviewer can see the old side of a diff. Rebuilding or deleting a disposable
 * index cannot recreate lost historical source, and current code must never be
 * substituted for it. Resolution compares the committed Markdown baseline;
 * absent old source simply leaves finer comment/layout/fact review unavailable.
 * Derived Wiki health can be rebuilt from Markdown without accepting new code.
 */

import { FingerprintStore } from "../../graph/fingerprint-store.js";
import type { GroundingBaseline, GroundingSubject } from "../../graph/grounding.js";
import type { SqliteDatabase } from "../../graph/db/sqlite.js";
import type { EntityId } from "../model/ids.js";
import type { WikiGrounding } from "../model/grounding.js";

/** The baseline subject for a wiki entity. */
export function entitySubject(id: EntityId | string): GroundingSubject {
  return { kind: "entity", id: String(id) };
}

/**
 * Read and write baselines for wiki entities.
 *
 * Kept as a thin named wrapper rather than passing `FingerprintStore` around,
 * so the entity-kind subject is constructed in one place. A caller that builds
 * `{kind: "scaffold", id: someEntityId}` by hand writes a row nothing will ever
 * read again, and nothing would fail.
 */
export class WikiBaselineStore {
  private readonly store: FingerprintStore;

  constructor(db: SqliteDatabase) {
    this.store = new FingerprintStore(db);
  }

  get(entityId: EntityId | string, nodeId: string): GroundingBaseline | null {
    return this.store.getBaseline(entitySubject(entityId), nodeId);
  }

  list(entityId: EntityId | string): GroundingBaseline[] {
    return this.store.listBaselines(entitySubject(entityId));
  }

  /**
   * Record what a node looked like at grounding time.
   *
   * `source` is the old side of a future diff. Callers that do not have the
   * body text pass an empty string rather than omitting the row: a baseline
   * with no captured source still carries the hash and the fingerprint, and a
   * missing row would look like "never grounded".
   */
  capture(
    entityId: EntityId | string,
    grounding: WikiGrounding,
    source: string,
    bodyHash: string,
  ): void {
    this.store.saveBaseline({
      subject: entitySubject(entityId),
      nodeId: grounding.node,
      source,
      bodyHash,
      fingerprint: grounding.fingerprint,
    });
  }

  delete(entityId: EntityId | string, nodeId: string): void {
    this.store.deleteBaseline(entitySubject(entityId), nodeId);
  }
}
