/**
 * The end-of-session review: which entities a session touched, which of them
 * someone vouched for, and which stay flagged.
 *
 * The rule, which is a product decision and must hold: MEX may refresh the
 * graph after a session changed code, but it re-records (regrounds) **only**
 * entities whose prose was edited in the session or that were confirmed with
 * `mex context confirm`. Every other touched entity stays flagged "changed,
 * re-check". Being shown a fact, or reading the code, is never a confirmation:
 * a complete-set claim ("the CORS middleware sets exactly these headers") is
 * touched by an edit that adds a header, and re-recording it would silently
 * bless a claim that is now wrong.
 *
 * Pure of side effects except {@link recordReview}, which writes the flags.
 */

import { createHash } from "node:crypto";
import { baseLocations, loadBase, proseHash } from "./hook/base.js";
import { diffAgainstHead, readHead, type FileDiff } from "./hook/diff.js";
import { findTouched, facts } from "./hook/events.js";
import { loadFlags, mutateFlags, type FlagBasis, type FlagEntry } from "./flags.js";
import type { GraphReader } from "./graph-reader.js";
import { liveStateFrom } from "./packet.js";
import type { ContextRoot } from "./root.js";
import { loadConfirmed } from "./session.js";
import type { ContextEntity, ContextIndex } from "./types.js";

export interface ReviewEntry {
  entity: ContextEntity;
  /** Why it counts as touched, in a few words. */
  why: string;
  /** First touched line at HEAD, for ordering. */
  first: number;
  /** True when the working tree touches it now; false for one only still flagged from earlier. */
  touchedNow: boolean;
  /** What vouches for it, or null when nothing does. */
  basis: FlagBasis | null;
  /** The confirmation's note, if any. */
  note?: string;
  /** Digest of the uncommitted change to the entity's code, to recognise the same change again. */
  digest: string;
}

export interface Review {
  head: string | null;
  /** Everything touched or still flagged, vouched for or not. */
  entries: ReviewEntry[];
  /** Vouched for: the settle worker re-records these. */
  eligible: ReviewEntry[];
  /** Not vouched for: they stay flagged. */
  flagged: ReviewEntry[];
}

/** A short digest of the change to an entity's code files. */
export function codeDigest(entity: Pick<ContextEntity, "code">, diffs: ReadonlyMap<string, FileDiff>): string {
  const parts = entity.code.map((file) => `${file}:${diffs.get(file)?.signature ?? "-"}`).sort();
  return createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 12);
}

/**
 * Digest of everything the session changed in the given entities' code and of
 * what vouches for each; the settle worker skips a run when neither has moved,
 * so a confirmation after an earlier run still gets its entity re-recorded.
 */
export function reviewDigest(review: Review): string {
  return createHash("sha1").update(review.entries.map((e) => `${e.entity.id}:${e.digest}:${e.basis ?? "-"}`).sort().join("\n")).digest("hex").slice(0, 16);
}

export interface ReviewInput {
  root: ContextRoot;
  index: ContextIndex;
  reader: GraphReader | null;
  sessionId: string | null;
}

/**
 * Compute the review from the working tree. Returns null when git cannot say
 * what changed (not a repository): nothing is touched then, and nothing is asked.
 */
export function reviewSession(input: ReviewInput): Review | null {
  const { root, index } = input;
  const head = readHead(root.projectRoot);
  const candidates = facts(index).filter((entity) => entity.groundings.length > 0 && entity.code.length > 0);
  const flags = loadFlags(root.localDir);
  if (candidates.length === 0) return { head, entries: [], eligible: [], flagged: [] };

  const linkedFiles = [...new Set(candidates.flatMap((entity) => entity.code))];
  const diffs = diffAgainstHead(root.projectRoot, linkedFiles);
  if (diffs === null) return null;

  const live = liveStateFrom(input.reader, candidates);
  const base = baseLocations(root.localDir, head, candidates, live);
  const touched = findTouched(candidates, [...diffs.keys()], diffs, base);

  const byId = new Map(candidates.map((entity) => [entity.id, entity]));
  const recorded = loadBase(root.localDir);
  const proseBase = recorded !== null && recorded.head === head ? recorded.prose ?? {} : {};
  const confirmed = loadConfirmed(root.localDir, input.sessionId);

  const consider = new Map<string, { entity: ContextEntity; why: string; first: number; touchedNow: boolean }>();
  for (const item of touched) consider.set(item.entity.id, { entity: item.entity, why: item.why, first: item.first, touchedNow: true });
  // Entities flagged by an earlier session stay in view until someone vouches for them.
  for (const [id, entry] of Object.entries(flags.entities)) {
    const entity = byId.get(id);
    if (entity !== undefined && !consider.has(id)) consider.set(id, { entity, why: entry.why, first: Number.MAX_SAFE_INTEGER, touchedNow: false });
  }

  const entries: ReviewEntry[] = [];
  for (const { entity, why, first, touchedNow } of consider.values()) {
    const digest = codeDigest(entity, diffs);
    // The same uncommitted change was already re-recorded: nothing new to vouch for.
    if (flags.reconciled[entity.id] === digest && flags.entities[entity.id] === undefined) continue;
    const wasEdited = proseBase[entity.id] !== undefined && proseBase[entity.id] !== proseHash(entity);
    const confirmation = confirmed[entity.id] ?? (flags.entities[entity.id]?.status === "eligible" && flags.entities[entity.id]?.basis === "confirmed"
      ? { at: flags.entities[entity.id]!.updatedAt, ...(flags.entities[entity.id]!.note === undefined ? {} : { note: flags.entities[entity.id]!.note! }) }
      : undefined);
    const basis: FlagBasis | null = wasEdited ? "edited" : confirmation !== undefined ? "confirmed" : null;
    entries.push({
      entity,
      why,
      first,
      touchedNow,
      basis,
      ...(basis === "confirmed" && confirmation?.note !== undefined ? { note: confirmation.note } : {}),
      digest,
    });
  }
  entries.sort((a, b) => a.first - b.first || (a.entity.id < b.entity.id ? -1 : 1));
  return { head, entries, eligible: entries.filter((e) => e.basis !== null), flagged: entries.filter((e) => e.basis === null) };
}

/** Write the review into the flags: eligible entries become eligible, the rest stay flagged. */
export function recordReview(localDir: string, review: Review, now: Date = new Date()): void {
  if (review.entries.length === 0) return;
  const at = now.toISOString();
  mutateFlags(localDir, (flags) => {
    for (const entry of review.entries) {
      const existing: FlagEntry | undefined = flags.entities[entry.entity.id];
      flags.entities[entry.entity.id] = {
        title: entry.entity.title,
        file: entry.entity.file,
        line: entry.entity.line,
        why: entry.why,
        status: entry.basis === null ? "flagged" : "eligible",
        ...(entry.basis === null ? {} : { basis: entry.basis }),
        ...(entry.note === undefined ? {} : { note: entry.note }),
        since: existing?.since ?? at,
        updatedAt: at,
        ...(existing?.error === undefined || entry.basis === null ? {} : { error: existing.error }),
      };
    }
  });
}

/** What a sync run starts from: when it started and the prose of every entity awaiting review. */
export interface SessionReviewSnapshot {
  since: string;
  prose: Record<string, string>;
}

export function sessionReviewSnapshot(localDir: string, index: ContextIndex, now: Date = new Date()): SessionReviewSnapshot {
  const flags = loadFlags(localDir);
  const byId = new Map(index.entities.map((entity) => [entity.id, entity]));
  const prose: Record<string, string> = {};
  for (const id of new Set([...Object.keys(flags.entities), ...Object.keys(flags.review)])) {
    const entity = byId.get(id);
    if (entity !== undefined) prose[id] = proseHash(entity);
  }
  return { since: now.toISOString(), prose };
}

/**
 * Clear what has had its review. A re-recorded entity's mark goes when its
 * prose differs from the prose it was re-recorded with, or the entity is gone.
 * With a snapshot (a sync run), an entity also counts as reviewed when its
 * prose changed since the run started or it was confirmed after the start; a
 * flagged entity then leaves the flags too. An unchanged, unconfirmed entity
 * stays. A confirmation clears a mark itself (`mex context confirm`).
 * Returns the ids cleared.
 */
export function clearSessionReviews(localDir: string, index: ContextIndex, snapshot?: SessionReviewSnapshot): string[] {
  const flags = loadFlags(localDir);
  if (Object.keys(flags.review).length === 0 && Object.keys(flags.entities).length === 0) return [];
  const byId = new Map(index.entities.map((entity) => [entity.id, entity]));
  const revisedSinceStart = (id: string): boolean => {
    const entity = byId.get(id);
    return snapshot !== undefined && entity !== undefined && snapshot.prose[id] !== undefined && proseHash(entity) !== snapshot.prose[id];
  };
  const marks = Object.entries(flags.review).filter(([id, mark]) => {
    const entity = byId.get(id);
    return entity === undefined || proseHash(entity) !== mark.prose || revisedSinceStart(id);
  }).map(([id]) => id);
  const entities = snapshot === undefined ? [] : Object.entries(flags.entities).filter(([id, entry]) =>
    revisedSinceStart(id) || (entry.basis === "confirmed" && entry.updatedAt >= snapshot.since)).map(([id]) => id);
  if (marks.length === 0 && entities.length === 0) return [];
  mutateFlags(localDir, (stored) => {
    for (const id of marks) delete stored.review[id];
    for (const id of entities) {
      delete stored.entities[id];
      delete stored.review[id];
    }
  });
  return [...new Set([...marks, ...entities])];
}
