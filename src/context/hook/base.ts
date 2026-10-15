/**
 * Base-side locations of the linked code.
 *
 * Diff hunks count lines of the file as it was at HEAD, but the graph (and so
 * the index) is rebuilt as the code changes, which moves every location. So
 * the first event for a given HEAD records where each entity's linked code was
 * (`.mex/local/context-base.json`) and later events compare diff hunks against
 * that record instead of the moving graph. A new commit starts a new record.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeTextAtomic } from "../local-state.js";
import type { LiveLocation, LiveStateResolver } from "../packet.js";
import type { ContextEntity } from "../types.js";

const BASE_SCHEMA_VERSION = 1;
const MAX_BASE_BYTES = 16 * 1024 * 1024;

export const basePathOf = (localDir: string): string => join(localDir, "context-base.json");

export interface BaseSnapshot {
  schemaVersion: typeof BASE_SCHEMA_VERSION;
  head: string;
  locations: Record<string, LiveLocation[]>;
  /** Hash of each entity's prose as of this record, to tell prose edited later from prose already there. */
  prose?: Record<string, string>;
}

/** A short hash of an entity's title and body: what "the prose was edited" is measured on. */
export function proseHash(entity: Pick<ContextEntity, "title" | "body">): string {
  return createHash("sha1").update(`${entity.title}\n${entity.body}`).digest("hex").slice(0, 12);
}

export function loadBase(localDir: string): BaseSnapshot | null {
  const path = basePathOf(localDir);
  try {
    if (statSync(path).size > MAX_BASE_BYTES) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<BaseSnapshot>;
    if (value.schemaVersion !== BASE_SCHEMA_VERSION || typeof value.head !== "string" || typeof value.locations !== "object" || value.locations === null) {
      return null;
    }
    return value as BaseSnapshot;
  } catch {
    return null;
  }
}

/**
 * Base-side locations for every entity with a code link.
 *
 * With a known HEAD the record is kept for as long as HEAD stays the same and
 * is (re)written from the current graph when it does not match. Without one
 * (not a Git checkout) there is no base to be right about; the current
 * locations are used and nothing is written.
 */
export function baseLocations(
  localDir: string,
  head: string | null,
  entities: readonly ContextEntity[],
  live: LiveStateResolver,
): Record<string, LiveLocation[]> {
  const current = (): Record<string, LiveLocation[]> => {
    const locations: Record<string, LiveLocation[]> = {};
    for (const entity of entities) {
      if (entity.groundings.length === 0) continue;
      locations[entity.id] = live(entity).locations;
    }
    return locations;
  };
  if (head === null) return current();
  const recorded = loadBase(localDir);
  if (recorded !== null && recorded.head === head) {
    // The prose a session starts from: recorded for entities an older record (or a later addition) has none for.
    const unseen = entities.filter((e) => recorded.prose?.[e.id] === undefined);
    if (unseen.length > 0) {
      try {
        const prose = { ...recorded.prose, ...Object.fromEntries(unseen.map((e) => [e.id, proseHash(e)])) };
        writeTextAtomic(localDir, basePathOf(localDir), `${JSON.stringify({ ...recorded, prose })}\n`);
        recorded.prose = prose;
      } catch {
        // The next event tries again.
      }
    }
    // An entity added after the record was taken has no older side than now.
    const missing = entities.filter((e) => e.groundings.length > 0 && recorded.locations[e.id] === undefined);
    if (missing.length === 0) return recorded.locations;
    const now = current();
    const merged = { ...recorded.locations };
    for (const entity of missing) merged[entity.id] = now[entity.id] ?? [];
    return merged;
  }
  const fresh = current();
  try {
    const snapshot: BaseSnapshot = {
      schemaVersion: BASE_SCHEMA_VERSION,
      head,
      locations: fresh,
      prose: Object.fromEntries(entities.map((entity) => [entity.id, proseHash(entity)])),
    };
    writeTextAtomic(localDir, basePathOf(localDir), `${JSON.stringify(snapshot)}\n`);
  } catch {
    // The record is an optimisation of correctness, not a requirement: the next event tries again.
  }
  return fresh;
}

/** Record the base for this HEAD if there is none yet (the prompt event calls this early in a session). */
export function ensureBase(localDir: string, head: string | null, entities: readonly ContextEntity[], live: LiveStateResolver): void {
  if (head === null) return;
  const recorded = loadBase(localDir);
  if (recorded !== null && recorded.head === head && entities.every((e) => recorded.prose?.[e.id] !== undefined)) return;
  baseLocations(localDir, head, entities, live);
}
