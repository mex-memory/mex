import type { MachineReviewCard, MachineReviewQueue } from "@mex/hub-contracts/machine";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { assertNoSecrets, stripHidden } from "../../knowledge/gates.js";
import { openRecordReadOnly, recordLocation } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";
import { snapshotReview, type ReviewGroup } from "../../review/queue.js";
import type { HomeData } from "./home.js";
import { PROJECT_ID, registeredCheckout } from "./knowledge-snapshot.js";
import { activeCheckouts, readStore } from "./read.js";
import { conflictNote, CONFLICT_CHANGED, MAX_CONFLICT_NOTES, reviewNote } from "./review-notes.js";
import { reviewLimits, reviewPoint } from "./review-snapshot.js";
import { HubRequestError } from "./security.js";

const querySchema = z.object({
  repo: z.string().regex(PROJECT_ID).optional(),
  cursor: z.string().min(1).max(384).optional(),
  limit: z.string().regex(/^[1-9][0-9]{0,2}$/u).transform(Number).pipe(z.number().max(100)).optional(),
});
const cursorSchema = z.object({
  generation: z.string(), repo: z.string().regex(PROJECT_ID).nullable(), offset: z.number().int().positive(),
}).strict();
const PAGE_BYTES = 256 << 10;

export const invalidReview = (detail: string) => new HubRequestError(400, "INVALID_REQUEST", "Invalid Review request", detail);
export const reviewMissing = () => new HubRequestError(404, "INVALID_REQUEST", "Review card unavailable", "This card is no longer waiting.");
export const reviewUnavailable = () => new HubRequestError(503, "REVIEW_UNAVAILABLE", "Review couldn’t be read", "Try again in a moment.");

export function readReviewPage(data: HomeData, location: LocationOptions, query: Record<string, string>): MachineReviewQueue {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) throw invalidReview("Choose a registered repo and a valid page size.");
  const { repo, cursor, limit = 50 } = parsed.data;
  if (repo && !readStore(openRecordReadOnly, location, (reader) => reader?.project(repo))) throw reviewMissing();
  const { snapshot, generation, updatingSince } = data.getReview();
  let offset = 0;
  if (cursor) {
    let point: z.infer<typeof cursorSchema>;
    try { point = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); }
    catch { throw invalidReview("The page cursor is invalid."); }
    if (point.generation !== generation) throw new HubRequestError(409, "REVIEW_CHANGED", "Review changed", "Start again at the first page.");
    if (point.repo !== (repo ?? null)) throw invalidReview("The page cursor belongs to another repo.");
    offset = point.offset;
  }

  const byRepo: MachineReviewQueue["byRepo"] = Object.create(null);
  const partial: NonNullable<MachineReviewQueue["partial"]> = [];
  if (snapshot?.review.partial) partial.push({ note: snapshot.review.partial });
  let oldest: string | null = null;
  for (const [id, { review }] of snapshot?.projects ?? []) {
    byRepo[id] = review.cards.size;
    if (repo && repo !== id) continue;
    if (review.oldest && (!oldest || review.oldest < oldest)) oldest = review.oldest;
    if (review.partial) partial.push({ repoId: id, note: review.partial });
  }
  const all = snapshot?.review.cards ?? [];
  const scoped = repo ? all.filter(({ row }) => row.repoId === repo) : all;
  if (offset && offset >= scoped.length) throw invalidReview("Start again at the first page.");
  const cards = [];
  let next = offset, bytes = 0;
  for (const { row, bytes: length } of scoped.slice(offset, offset + limit)) {
    if (cards.length && bytes + length > PAGE_BYTES) break;
    bytes += length;
    cards.push(row);
    next++;
  }
  return {
    cards, total: scoped.length, byRepo, oldest, updatingSince, partial: partial.length ? partial : undefined,
    nextCursor: next < scoped.length
      ? Buffer.from(JSON.stringify({ generation, repo: repo ?? null, offset: next })).toString("base64url") : null,
  };
}

export function parseReviewKey(key: string) {
  const [repoId, cardId, ...extra] = key.split(":");
  if (extra.length || !PROJECT_ID.test(repoId) || !/^rv_(?:[a-f0-9]{24}|conflict_[a-f0-9]{32})$/u.test(cardId ?? "")) {
    throw invalidReview("Choose a valid Review card.");
  }
  return { repoId, cardId };
}

type ReviewNote = NonNullable<MachineReviewCard["contradiction"]>["current"][number];
export interface ReviewDetail {
  card: MachineReviewCard;
  group: ReviewGroup;
  checkout: string;
  retires: ReviewNote[];
}

export async function readReviewCard(
  data: HomeData, location: LocationOptions, key: string, now: number, env?: NodeJS.ProcessEnv,
): Promise<ReviewDetail> {
  const { repoId, cardId } = parseReviewKey(key);
  let { snapshot, ready } = data.getReview();
  if (!snapshot && ready) {
    await ready;
    ({ snapshot } = data.getReview());
  }
  const point = snapshot?.projects.get(repoId)?.review.cards.get(cardId);
  if (!point) throw reviewMissing();
  await setImmediate();
  const { home } = recordLocation({ ...location, create: false });
  const { checkout } = point;
  return readStore(openRecordReadOnly, location, (reader) => {
    if (!reader?.project(repoId) || !registeredCheckout(reader, repoId, checkout)) throw reviewMissing();
    const active = new Set(activeCheckouts(reader, repoId, now));
    if (!active.has(checkout)) throw reviewMissing();
    const group = snapshotReview(reader, repoId, home, checkout, now, reviewLimits).find(({ id }) => id === cardId);
    if (!group) throw reviewMissing();
    const target = { ...location, home, repoId, checkout, env };
    const current = new Map<string, ReviewNote>();
    const retires = new Map<string, ReviewNote>();
    let useBlocked: string | undefined;
    if (group.conflict) {
      if (group.conflict.conflicts.length > MAX_CONFLICT_NOTES) useBlocked = "This proposal affects more notes than Review can show. Run mex review in this checkout.";
      for (const other of group.conflict.conflicts.slice(0, MAX_CONFLICT_NOTES)) {
        const { note, matches } = conflictNote(reader, target, other, now);
        current.set(note.key, note);
        if (note.audience === "onlyYou") retires.set(note.key, note);
        if (!matches) useBlocked ??= CONFLICT_CHANGED;
      }
      if (group.conflict.replaces) {
        const { note, revision } = reviewNote(reader, target, group.conflict.replaces, "onlyYou", now);
        if (revision) retires.set(note.key, note);
        else useBlocked ??= CONFLICT_CHANGED;
      }
    }
    assertNoSecrets(group.entry);
    const sourcePaths = new Set(group.members.map(({ item }) => item.source.checkout).filter((path) => active.has(path)));
    const paths = [...point.row.sources.checkouts.filter((path) => sourcePaths.delete(path)), ...sourcePaths];
    const { row } = reviewPoint(repoId, group, checkout, paths.length ? paths : [checkout], active,
      current.size ? { current: [...current.values()] } : undefined);
    if (useBlocked) row.disabled = { ...row.disabled, use: useBlocked };
    return { card: { ...row, text: stripHidden(group.entry.text).trim() }, group, checkout, retires: [...retires.values()] };
  });
}
